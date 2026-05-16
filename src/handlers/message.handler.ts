import { MessageInfo, whatsappService } from "@/services/whatsapp.service"
import { cleanPhoneNumber as cleanPhoneFromJid } from "@/utils/phone.utils"
import { parseMentions } from "@/utils/mention.utils"
import { memoryService } from "@/services/memory.service"
import { llmService } from "@/services/llm.service"
import { rateLimiter } from "@/services/ratelimit.service"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { databaseService } from "@/services/database.service"
import { AdminUtils } from "@/utils/admin.utils"
import { createLogger } from "@/lib/logger"
import { config } from "@/config/env"

const logger = createLogger(config.LOG_LEVEL, "MessageHandler")

export class MessageHandler {
  private lastContextualReplyAt: Map<string, number> = new Map()
  private contextualCooldownMs = 60 * 1000 // one minute cooldown between spontaneous replies per chat
  /**
   * Check access control - returns true if allowed, false if blocked
   */
  private checkAccessControl(info: MessageInfo): boolean {
    const accessMode = (runtimeConfig.get("accessControlMode") as string) || config.ACCESS_CONTROL_MODE

    // Admins always have access
    if (AdminUtils.isAdmin(info.sender)) {
      return true
    }

    // If disabled, allow all
    if (accessMode === "disabled") {
      return true
    }

    // Check whitelist mode
    if (accessMode === "whitelist") {
      return databaseService.isWhitelisted(info.from)
    }

    // Check blacklist mode
    if (accessMode === "blacklist") {
      return !databaseService.isBlacklisted(info.from)
    }

    return true
  }

  /**
   * Handle incoming WhatsApp message
   */
  public async handle(info: MessageInfo): Promise<void> {
    try {
      // Check if bot is enabled (except for admin commands)
      if (!info.text.startsWith("!")) {
        const botEnabled = runtimeConfig.get("botEnabled") as boolean
        if (!botEnabled) {
          logger.debug(`Bot is disabled, ignoring message from ${info.sender}`)
          return
        }
      }

      // Check access control first (except for admin commands)
      if (!info.text.startsWith("!") && !this.checkAccessControl(info)) {
        logger.info(`Access denied for ${info.sender} in chat ${info.from}`)
        return
      }

      // Check if it's an admin command
      if (info.text.startsWith("!")) {
        await this.handleAdminCommand(info)
        return
      }

      // Always add message to memory for context (scoped to chat id)
      await memoryService.addMessage(info.from, info.sender, info.text, info.senderName)

      // React to acknowledge message received (optional - can be configured)
      if (info.isMentioned || info.isReplyToBot) {
        try {
          await whatsappService.sendReaction(info.from, info.quotedMessage?.key, '👀')
        } catch (err) {
          // Ignore reaction errors
        }
      }

      // In groups: only respond if mentioned OR replied to bot
      if (info.isGroup) {
        const respondToGroups = runtimeConfig.get("respondToGroupMessages") as boolean | undefined
        const contextualMode = runtimeConfig.get("contextualGroupResponses") as boolean | undefined

        // If mentioned or a reply to bot — immediate handle
        if (info.isMentioned || info.isReplyToBot) {
          // Check rate limit for group users (not for admins)
          if (!AdminUtils.isAdmin(info.sender)) {
            if (!rateLimiter.canMakeRequest(info.sender)) {
              const waitTime = rateLimiter.getTimeUntilReset(info.sender)
              const maxRequests =
                Number(runtimeConfig.get("rateLimitMaxRequests")) || config.RATE_LIMIT_MAX_REQUESTS
              const rateLimitMsg = `⏱️ Slow down! You can only mention me ${maxRequests} times in the configured time window. Try again in ${waitTime} seconds.`
              if (info.quotedMessage) {
                await whatsappService.sendReply(info.from, rateLimitMsg, info.quotedMessage)
              } else {
                await whatsappService.sendMessage(info.from, rateLimitMsg)
              }
              return
            }
          }
          await this.handleAIResponse(info)
          return
        }

        // If respondToGroups is enabled, decide behavior
        if (respondToGroups) {
          if (contextualMode) {
            // Contextual mode: ask low-cost LLM helper whether to reply.
            const last = this.lastContextualReplyAt.get(info.from) || 0
            const now = Date.now()
            if (now - last < this.contextualCooldownMs) {
              return
            }
            // Build context and ask LLM whether to reply
            const ctx = memoryService.getContext(info.from)
            const sys = memoryService.getSystemPrompt()
            try {
              const decision = await llmService.askForReactiveReply(info.text, ctx, sys)
              if (decision.shouldReply) {
                // Rate-limiting check
                if (!AdminUtils.isAdmin(info.sender)) {
                  if (!rateLimiter.canMakeRequest(info.sender)) return
                }
                const participants = memoryService.getParticipants(info.from)
                const { text: finalReply, mentionedJids } = parseMentions(decision.reply || "", participants)

                if (info.quotedMessage)
                  await whatsappService.sendReply(
                    info.from,
                    finalReply,
                    info.quotedMessage,
                    mentionedJids
                  )
                else await whatsappService.sendMessage(info.from, finalReply, mentionedJids)
                await memoryService.addMessage(info.from, "Bot", finalReply, "Bot")
                this.lastContextualReplyAt.set(info.from, now)
              }
            } catch (err) {
              logger.warn("Contextual decision LLM failed", err)
            }
            return
          } else {
            // Non contextual: reply to all messages (still check rate limit)
            if (!AdminUtils.isAdmin(info.sender)) {
              if (!rateLimiter.canMakeRequest(info.sender)) {
                const waitTime = rateLimiter.getTimeUntilReset(info.sender)
                const maxRequests =
                  Number(runtimeConfig.get("rateLimitMaxRequests")) ||
                  config.RATE_LIMIT_MAX_REQUESTS
                const rateLimitMsg = `⏱️ Slow down! You can only mention me ${maxRequests} times in the configured time window. Try again in ${waitTime} seconds.`
                if (info.quotedMessage) {
                  await whatsappService.sendReply(info.from, rateLimitMsg, info.quotedMessage)
                } else {
                  await whatsappService.sendMessage(info.from, rateLimitMsg)
                }
                return
              }
            }
            await this.handleAIResponse(info)
            return
          }
        }
        // Otherwise, just store in memory and don't respond
        return
      }

      // In private chats: always respond (no rate limit for private chats)
      // In private chats: respond only if enabled in runtime config
      const enablePrivate = runtimeConfig.get("enablePrivateChat")
      if (enablePrivate === false) {
        // Private chat responses are disabled; simply return
        return
      }
      await this.handleAIResponse(info)
    } catch (error) {
      logger.error("Error in message handler:", error)
      await whatsappService.sendMessage(
        info.from,
        "❌ Sorry, something went wrong. Please try again."
      )
    }
  }

  /**
   * Handle AI response
   */
  private async handleAIResponse(info: MessageInfo): Promise<void> {
    // Get context and system prompt
    let context = memoryService.getContext(info.from)
    const systemPrompt = memoryService.getSystemPrompt()

    // Get participants from memory for mention parsing
    const participants = memoryService.getParticipants(info.from)

    // If group, append group metadata and participant list to context
    if (info.isGroup) {
      try {
        const g = await whatsappService.getGroupInfo(info.from)
        if (g) {
          const owner = cleanPhoneFromJid(g.owner || "")
          const subject = g.subject || "(no subject)"
          const participantCount = g.participantCount || 0

          // Build participant list for context
          const participantList = participants.length > 0
            ? participants.map((p) => `- ${p.name} (${p.phone})`).join("\n")
            : "No participants tracked yet"

          const groupMeta = `Group Metadata:
SUBJECT: ${subject}
OWNER: ${owner}
TOTAL PARTICIPANTS: ${participantCount}

Known Participants (from conversation):
${participantList}

Instructions: You can mention people by using @Name format (e.g., @John). When you mention someone, make sure to use their exact name as shown in the participant list above.

`
          context = `${groupMeta}${context}`
        }
      } catch (err) {
        // ignore
      }
    }

    // Remove bot mention from text
    const botName = (runtimeConfig.get("botName") as string) || config.BOT_NAME
    const cleanText = info.text.replace(new RegExp(botName, "gi"), "").trim()

    logger.info(`Processing AI request from ${info.senderName || info.sender}`)

    // Send typing indicator
    await whatsappService.sendPresenceUpdate('composing', info.from)

    // Get AI response
    const response = await llmService.askLLM(cleanText, context, systemPrompt)

    // Stop typing indicator
    await whatsappService.sendPresenceUpdate('paused', info.from)

    // Parse mentions in the response
    const { text: finalText, mentionedJids } = parseMentions(response, participants)

    // Add bot response to memory
    await memoryService.addMessage(info.from, "Bot", finalText, "Bot")

    // Send response - use reply if original message is available
    if (info.quotedMessage) {
      await whatsappService.sendReply(info.from, finalText, info.quotedMessage, mentionedJids)
    } else {
      await whatsappService.sendMessage(info.from, finalText, mentionedJids)
    }

    if (mentionedJids.length > 0) {
      logger.info(`Response included ${mentionedJids.length} mention(s)`)
    }
  }

  /**
   * Handle admin commands
   */
  private async handleAdminCommand(info: MessageInfo): Promise<void> {
    // Check if user is admin
    if (!AdminUtils.isAdmin(info.sender)) {
      await whatsappService.sendMessage(info.from, "🚫 Unauthorized. Admin access required.")
      return
    }

    const parsed = AdminUtils.parseCommand(info.text)
    if (!parsed) return

    const { command, args } = parsed

    logger.info(`Admin command received: ${command} from ${info.sender}`)

    switch (command) {
      case "!help":
        await whatsappService.sendMessage(info.from, AdminUtils.getHelpText())
        break

      case "!clear":
        // If args == 'all', clear all conversations. If args specify a chat id, clear that chat. Otherwise clear the current chat.
        if (args && args.toLowerCase() === "all") {
          memoryService.clear()
          await whatsappService.sendMessage(info.from, "✅ All memory cleared successfully.")
        } else {
          const target = args && args.trim().length ? args.trim() : info.from
          memoryService.clear(target)
          await whatsappService.sendMessage(info.from, `✅ Memory cleared for ${target}`)
        }
        break

      case "!system":
        if (!args) {
          await whatsappService.sendMessage(info.from, "❌ Usage: !system <new system prompt>")
          return
        }
        memoryService.setSystemPrompt(args)
        // Persist to runtime config so it survives restarts
        runtimeConfig.set("systemPrompt", args)
        await whatsappService.sendMessage(info.from, `✅ System prompt updated:\n"${args}"`)
        break

      case "!status":
        const allMessages = memoryService.getAllMessages() as {
          [key: string]: { sender: string; text: string; timestamp: number }[]
        }
        // Count conversations and total messages
        const conversationCount = Object.keys(allMessages).length
        let totalMessages = 0
        for (const key in allMessages) totalMessages += (allMessages[key] || []).length

        const currentProvider = (runtimeConfig.get("llmProvider") as any) || config.LLM_PROVIDER
        const currentModel =
          currentProvider === "openai"
            ? (runtimeConfig.get("openaiModel") as string) ||
              process.env.OPENAI_MODEL ||
              "gpt-4o-mini"
            : config.GEMINI_MODEL

        const statusText = `
🤖 *Bot Status*

📊 Memory: ${totalMessages} messages across ${conversationCount} conversations
⏰ Window: ${config.MEMORY_WINDOW_MS / 1000 / 60} minutes
🧠 LLM: ${currentProvider} (${currentModel})
👥 Admins: ${config.ADMIN_NUMBERS.length}

System Prompt:
"${memoryService.getSystemPrompt()}"
        `.trim()
        await whatsappService.sendMessage(info.from, statusText)
        break

      case "!private":
        if (!args) {
          await whatsappService.sendMessage(info.from, "❌ Usage: !private on|off")
          return
        }
        const val = args.toLowerCase() === "on"
        runtimeConfig.set("enablePrivateChat", val)
        await whatsappService.sendMessage(
          info.from,
          `✅ Private chat responses ${val ? "enabled" : "disabled"}`
        )
        break

      default:
        await whatsappService.sendMessage(
          info.from,
          `❌ Unknown command: ${command}\n\nUse !help for available commands.`
        )
    }
  }
}

// Singleton instance
export const messageHandler = new MessageHandler()
