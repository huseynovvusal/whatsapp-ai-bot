import { MessageInfo, whatsappService } from "@/services/whatsapp.service"
import { cleanPhoneNumber as cleanPhoneFromJid } from "@/utils/phone.utils"
import { parseMentions } from "@/utils/mention.utils"
import { memoryService } from "@/services/memory.service"
import { llmService } from "@/services/llm.service"
import { rateLimiter } from "@/services/ratelimit.service"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { databaseService } from "@/services/database.service"
import { AdminUtils } from "@/utils/admin.utils"
import { ragService } from "@/services/rag.service"
import { personaService, PERSONA_LABELS } from "@/services/persona.service"
import { sanitiseEmoji } from "@/utils/emoji.utils"
import { trimToLength } from "@/utils/text.utils"
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
   * Decide whether the bot may reply to this message, before anything is sent.
   *
   * Every "should we speak" rule lives here so that no outbound side effect —
   * not a reply, not a typing indicator, not even an emoji reaction — can happen
   * in a chat the operator has switched off. Previously the 👀 reaction was sent
   * before the private-chat check, so disabling private replies still produced a
   * visible reaction.
   */
  private decideResponse(info: MessageInfo): {
    respond: boolean
    mode: "direct" | "contextual"
    reason: string
  } {
    const no = (reason: string) => ({ respond: false, mode: "direct" as const, reason })

    if (info.isGroup) {
      // Being mentioned or replied to is always an explicit invitation.
      if (info.isMentioned || info.isReplyToBot) {
        return { respond: true, mode: "direct", reason: "mentioned or replied to" }
      }
      // Companion mode is proactive by nature: it decides for itself whether a
      // message is worth joining, regardless of the group-response setting.
      if (personaService.isProactive(info.from)) {
        return { respond: true, mode: "contextual", reason: "companion mode" }
      }
      if (runtimeConfig.get("respondToGroupMessages") !== true) {
        return no("group responses are limited to mentions")
      }
      return runtimeConfig.get("contextualGroupResponses") === true
        ? { respond: true, mode: "contextual", reason: "contextual group mode" }
        : { respond: true, mode: "direct", reason: "respond-to-all group mode" }
    }

    if (runtimeConfig.get("enablePrivateChat") === false) {
      return no("private chat responses are disabled")
    }
    return { respond: true, mode: "direct", reason: "private chat" }
  }

  /** Rate-limit gate. Admins are exempt. Returns null when allowed. */
  private rateLimitMessage(info: MessageInfo): string | null {
    if (AdminUtils.isAdmin(info.sender)) return null
    if (rateLimiter.canMakeRequest(info.sender)) return null
    const waitTime = rateLimiter.getTimeUntilReset(info.sender)
    const maxRequests =
      Number(runtimeConfig.get("rateLimitMaxRequests")) || config.RATE_LIMIT_MAX_REQUESTS
    return `⏱️ Slow down! You can only message me ${maxRequests} times in the configured time window. Try again in ${waitTime} seconds.`
  }

  /**
   * React to the incoming message, if reactions are switched on.
   * Never throws — a failed reaction must not stop the actual reply.
   */
  private async react(info: MessageInfo, emoji?: string): Promise<void> {
    if (runtimeConfig.get("emojiReactions") === false) return
    // Validated here as well as at the parse site: this is the last point before
    // the value reaches WhatsApp, so no caller can send an invalid reaction.
    const safe = sanitiseEmoji(emoji)
    if (!safe) {
      if (emoji) logger.debug(`Discarded invalid reaction: ${JSON.stringify(emoji)}`)
      return
    }
    try {
      await whatsappService.sendReaction(info.from, info.quotedMessage?.key, safe)
    } catch (err) {
      logger.debug("Reaction failed", err)
    }
  }

  /**
   * Emoji for acknowledging a message the bot is about to answer.
   *
   * Assistant mode keeps the neutral 👀. Companion mode picks something that fits
   * the message, using a keyword pass rather than an LLM call — this runs on the
   * direct-reply path, where there is no decision call to piggyback on, so an
   * extra request here would be paid on every mention.
   */
  private pickAcknowledgementEmoji(info: MessageInfo): string {
    if (!personaService.isProactive(info.from)) return "👀"

    const text = info.text.toLowerCase()
    const rules: Array<[RegExp, string]> = [
      [/\b(thank|thanks|thx|appreciate)\b/, "🙏"],
      [/\b(congrat|well done|nice one|awesome|amazing)\b/, "🎉"],
      [/\b(happy birthday|birthday)\b/, "🎂"],
      [/\b(sorry|apolog)\b/, "🫶"],
      [/\b(help|urgent|asap|problem|issue|broken|error|bug)\b/, "🫡"],
      [/\b(love|great|awesome|perfect|brilliant)\b/, "❤️"],
      [/\b(sad|unfortunately|bad news|failed)\b/, "😔"],
      [/\b(haha|lol|lmao|funny|😂|🤣)\b/, "😂"],
      [/\?\s*$/, "🤔"],
    ]
    for (const [pattern, emoji] of rules) {
      if (pattern.test(text)) return emoji
    }
    return "👀"
  }

  /**
   * Enforce the reply-length ceiling. Returns the text unchanged when there is
   * no limit or it already fits.
   */
  private shapeReply(text: string, maxChars: number): string {
    if (!maxChars || maxChars <= 0) return text
    const shaped = trimToLength(text, maxChars)
    if (shaped.length < text.trim().length) {
      logger.debug(`Trimmed reply from ${text.trim().length} to ${shaped.length} chars`)
    }
    return shaped
  }

  /** Send text, preferring a native reply so threading is preserved. */
  private async reply(info: MessageInfo, text: string, mentionedJids?: string[]): Promise<void> {
    if (info.quotedMessage) {
      await whatsappService.sendReply(info.from, text, info.quotedMessage, mentionedJids)
    } else {
      await whatsappService.sendMessage(info.from, text, mentionedJids)
    }
  }

  /**
   * Handle incoming WhatsApp message
   */
  public async handle(info: MessageInfo): Promise<void> {
    // Tracks whether we ever committed to replying, so the error handler below
    // stays silent in chats where the bot is not supposed to speak.
    let committedToReply = false

    try {
      const isAdminCommand = info.text.startsWith("!")

      if (!isAdminCommand) {
        if (runtimeConfig.get("botEnabled") !== true) {
          logger.debug(`Bot is disabled, ignoring message from ${info.sender}`)
          return
        }
        if (!this.checkAccessControl(info)) {
          logger.info(`Access denied for ${info.sender} in chat ${info.from}`)
          return
        }
      }

      if (isAdminCommand) {
        await this.handleAdminCommand(info)
        return
      }

      // Always remember the message for context, even if we stay quiet.
      await memoryService.addMessage(info.from, info.sender, info.text, info.senderName)

      const decision = this.decideResponse(info)
      if (!decision.respond) {
        logger.debug(`Staying quiet in ${info.from}: ${decision.reason}`)
        return
      }

      // Contextual mode decides for itself whether to speak, and stays silent
      // (no reaction, no rate-limit notice) when it decides not to.
      if (decision.mode === "contextual") {
        await this.handleContextualResponse(info)
        return
      }

      // From here on the bot has committed to replying in this chat.
      committedToReply = true

      const limitMessage = this.rateLimitMessage(info)
      if (limitMessage) {
        await this.reply(info, limitMessage)
        return
      }

      // Acknowledge explicit invitations with a reaction.
      if (info.isMentioned || info.isReplyToBot) {
        await this.react(info, this.pickAcknowledgementEmoji(info))
      }

      await this.handleAIResponse(info)
    } catch (error) {
      logger.error("Error in message handler:", error)
      if (!committedToReply) return
      try {
        await whatsappService.sendMessage(
          info.from,
          "❌ Sorry, something went wrong. Please try again."
        )
      } catch (sendErr) {
        logger.error("Failed to deliver the error notice", sendErr)
      }
    }
  }

  /**
   * Contextual group mode: ask the LLM whether it is worth chiming in, and only
   * then send anything.
   */
  private async handleContextualResponse(info: MessageInfo): Promise<void> {
    // The cooldown is checked before the decision call, not after: that call is
    // what costs money, so gating it here is what keeps a busy group affordable.
    // It therefore also pauses reactions for the cooldown window — intentional,
    // since a bot that reacts to every message is as noisy as one that replies
    // to every message.
    const last = this.lastContextualReplyAt.get(info.from) || 0
    const now = Date.now()
    if (now - last < this.contextualCooldownMs) return

    try {
      const context = await this.buildContext(info)
      const decision = await llmService.askForReactiveReply(
        info.text,
        context,
        memoryService.getSystemPrompt(info.from)
      )

      // The same call chose an emoji, so acknowledging costs no extra request.
      // Reacting without replying is the quiet, human way to respond — and it is
      // the whole point of allowing a reaction when shouldReply is false.
      if (decision.reaction) await this.react(info, decision.reaction)

      if (!decision.shouldReply) return

      // Silent rate-limit: an unprompted interjection should not nag.
      if (!AdminUtils.isAdmin(info.sender) && !rateLimiter.canMakeRequest(info.sender)) return

      const participants = memoryService.getParticipants(info.from)
      const shaped = this.shapeReply(decision.reply || "", personaService.getMaxReplyChars(info.from))
      const { text: finalReply, mentionedJids } = parseMentions(shaped, participants)
      if (!finalReply.trim()) return

      await this.reply(info, finalReply, mentionedJids)
      await memoryService.addMessage(info.from, "Bot", finalReply, "Bot")
      this.lastContextualReplyAt.set(info.from, now)
    } catch (err) {
      logger.warn("Contextual decision failed", err)
    }
  }

  /**
   * Assemble everything the LLM should see for this chat:
   * group metadata, recalled long-term memories, and recent conversation.
   */
  private async buildContext(info: MessageInfo): Promise<string> {
    const sections: string[] = []
    const participants = memoryService.getParticipants(info.from)

    // Group metadata + who the bot may tag
    if (info.isGroup) {
      try {
        const g = await whatsappService.getGroupInfo(info.from)
        if (g) {
          const participantList =
            participants.length > 0
              ? participants.map((p) => `- ${p.name} (${p.phone})`).join("\n")
              : "No participants tracked yet"

          sections.push(`Group Metadata:
SUBJECT: ${g.subject || "(no subject)"}
OWNER: ${cleanPhoneFromJid(g.owner || "")}
TOTAL PARTICIPANTS: ${g.participantCount || 0}

Known Participants (from conversation):
${participantList}

Instructions: You can mention people by using @Name format (e.g., @John). When you mention someone, make sure to use their exact name as shown in the participant list above.`)
        }
      } catch {
        // Group metadata is optional context; carry on without it.
      }
    }

    // Long-term memory: semantically relevant history beyond the recent window.
    try {
      const memories = await ragService.retrieve(info.text, info.from)
      if (memories.length) {
        sections.push(ragService.formatMemories(memories))
        logger.info(
          `Recalled ${memories.length} memory chunk(s) (best match ${memories[0].score.toFixed(2)})`
        )
      }
    } catch (err) {
      logger.warn("Memory recall failed, continuing without it", err)
    }

    sections.push(memoryService.getContext(info.from))
    return sections.join("\n\n")
  }

  /**
   * Handle AI response
   */
  private async handleAIResponse(info: MessageInfo): Promise<void> {
    const systemPrompt = memoryService.getSystemPrompt(info.from)
    const participants = memoryService.getParticipants(info.from)
    const context = await this.buildContext(info)

    // Remove bot mention from text
    const botName = (runtimeConfig.get("botName") as string) || config.BOT_NAME
    const cleanText = info.text.replace(new RegExp(botName, "gi"), "").trim()

    logger.info(`Processing AI request from ${info.senderName || info.sender}`)

    // Send typing indicator
    await whatsappService.sendPresenceUpdate('composing', info.from)

    // Companion gets a small token budget so the model cannot produce an essay;
    // the prompt asks for brevity, this makes it structurally hard to ignore.
    const maxChars = personaService.getMaxReplyChars(info.from)
    const response = await llmService.askLLM(cleanText, context, systemPrompt, {
      maxTokens: maxChars > 0 ? Math.max(64, Math.ceil(maxChars / 3)) : undefined,
    })

    // Stop typing indicator
    await whatsappService.sendPresenceUpdate('paused', info.from)

    // Last resort if the model still overruns: trim on a sentence boundary so
    // the message reads as finished rather than cut off.
    const shaped = this.shapeReply(response, maxChars)

    // Parse mentions in the response
    const { text: finalText, mentionedJids } = parseMentions(shaped, participants)

    // Add bot response to memory
    await memoryService.addMessage(info.from, "Bot", finalText, "Bot")

    await this.reply(info, finalText, mentionedJids)

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
        // Updates the prompt for whichever persona this chat is using, and
        // applies from the next message.
        memoryService.setSystemPrompt(args, info.from)
        await whatsappService.sendMessage(
          info.from,
          `✅ ${PERSONA_LABELS[personaService.getPersonaForChat(info.from)]} prompt updated:\n"${args}"`
        )
        break

      case "!mode": {
        const requested = (args || "").trim().toLowerCase()
        if (requested !== "assistant" && requested !== "companion") {
          const active = personaService.getPersonaForChat(info.from)
          await whatsappService.sendMessage(
            info.from,
            `🎭 Mode here: *${PERSONA_LABELS[active]}*\n\n` +
              "!mode assistant — concise and task-focused\n" +
              "!mode companion — conversational, joins in when it fits"
          )
          return
        }
        personaService.setPersonaForChat(info.from, requested)
        await whatsappService.sendMessage(
          info.from,
          `✅ Mode for this chat set to *${PERSONA_LABELS[requested]}*`
        )
        break
      }

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

        // Report the value actually in force, not the env default it ignored.
        const windowMs = Number(runtimeConfig.get("memoryWindowMs") ?? config.MEMORY_WINDOW_MS)
        const memoryWindowLabel =
          windowMs > 0 ? `${Math.round(windowMs / 60000)} minutes` : "unlimited (never expires)"
        const activePersona = personaService.getPersonaForChat(info.from)
        const personaIsOverride = databaseService.getChatPersona(info.from) !== null

        const statusText = `
🤖 *Bot Status*

📊 Memory: ${totalMessages} messages across ${conversationCount} conversations
⏰ Window: ${memoryWindowLabel}
🧠 LLM: ${currentProvider} (${currentModel})
🎭 Mode here: ${PERSONA_LABELS[activePersona]}${personaIsOverride ? " (chat override)" : " (default)"}
👥 Admins: ${config.ADMIN_NUMBERS.length}

System Prompt:
"${memoryService.getSystemPrompt(info.from)}"
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
