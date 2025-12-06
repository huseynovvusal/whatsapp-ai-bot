import { MessageInfo, whatsappService } from "@/services/whatsapp.service"
import { memoryService } from "@/services/memory.service"
import { llmService } from "@/services/llm.service"
import { rateLimiter } from "@/services/ratelimit.service"
import { AdminUtils } from "@/utils/admin.utils"
import { createLogger } from "@/lib/logger"
import { config } from "@/config/env"

const logger = createLogger(config.LOG_LEVEL, "MessageHandler")

export class MessageHandler {
  /**
   * Handle incoming WhatsApp message
   */
  public async handle(info: MessageInfo): Promise<void> {
    try {
      // Check if it's an admin command
      if (info.text.startsWith("!")) {
        await this.handleAdminCommand(info)
        return
      }

      // Always add message to memory for context
      memoryService.addMessage(info.sender, info.text)

      // In groups: only respond if mentioned OR replied to bot
      if (info.isGroup) {
        if (info.isMentioned || info.isReplyToBot) {
          // Check rate limit for group users (not for admins)
          if (!AdminUtils.isAdmin(info.sender)) {
            if (!rateLimiter.canMakeRequest(info.sender)) {
              const waitTime = rateLimiter.getTimeUntilReset(info.sender)
              const rateLimitMsg = `⏱️ Slow down! You can only mention me ${config.RATE_LIMIT_MAX_REQUESTS} times per minute. Try again in ${waitTime} seconds.`

              // Reply to user's message with rate limit warning
              if (info.quotedMessage) {
                await whatsappService.sendReply(info.from, rateLimitMsg, info.quotedMessage)
              } else {
                await whatsappService.sendMessage(info.from, rateLimitMsg)
              }
              return
            }
          }

          await this.handleAIResponse(info)
        }
        // Otherwise, just store in memory and don't respond
        return
      }

      // In private chats: always respond (no rate limit for private chats)
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
    const context = memoryService.getContext()
    const systemPrompt = memoryService.getSystemPrompt()

    // Remove bot mention from text
    const cleanText = info.text.replace(new RegExp(config.BOT_NAME, "gi"), "").trim()

    logger.info(`Processing AI request from ${info.sender}`)

    // Send typing indicator (optional)
    // await whatsappService.sendPresenceUpdate('composing', info.from)

    // Get AI response
    const response = await llmService.askLLM(cleanText, context, systemPrompt)

    // Add bot response to memory
    memoryService.addMessage("Bot", response)

    // Send response - use reply if original message is available
    if (info.quotedMessage) {
      await whatsappService.sendReply(info.from, response, info.quotedMessage)
    } else {
      await whatsappService.sendMessage(info.from, response)
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
        memoryService.clear()
        await whatsappService.sendMessage(info.from, "✅ Memory cleared successfully.")
        break

      case "!system":
        if (!args) {
          await whatsappService.sendMessage(info.from, "❌ Usage: !system <new system prompt>")
          return
        }
        memoryService.setSystemPrompt(args)
        await whatsappService.sendMessage(info.from, `✅ System prompt updated:\n"${args}"`)
        break

      case "!status":
        const messages = memoryService.getAllMessages()
        const statusText = `
🤖 *Bot Status*

📊 Memory: ${messages.length} messages
⏰ Window: ${config.MEMORY_WINDOW_MS / 1000 / 60} minutes
🧠 LLM: ${config.LLM_PROVIDER} (${config.LLM_PROVIDER === "openai" ? config.OPENAI_MODEL : config.GEMINI_MODEL})
👥 Admins: ${config.ADMIN_NUMBERS.length}

System Prompt:
"${memoryService.getSystemPrompt()}"
        `.trim()
        await whatsappService.sendMessage(info.from, statusText)
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
