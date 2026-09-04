import { runtimeConfig } from "@/services/runtimeConfig.service"
import { personaService } from "@/services/persona.service"
import { styleService } from "@/services/style.service"
import { whatsappService } from "@/services/whatsapp.service"
import { userProfileService } from "@/services/userProfile.service"
import { databaseService } from "@/services/database.service"
import { cleanPhoneNumber as cleanPhoneFromJid } from "@/utils/phone.utils"
import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"

const logger = createLogger(config.LOG_LEVEL, "MemoryService")

export interface Message {
  sender: string // phone number
  senderName: string // display name
  text: string
  timestamp: number
}

export interface Conversation {
  id: string
  messages: Message[]
}

export class MemoryService {
  // Map chatId -> messages
  private conversations: Map<string, Message[]> = new Map()
  private systemPrompt: string

  constructor() {
    // Load system prompt from runtime config if set, otherwise use env value
    this.systemPrompt = (runtimeConfig.get("systemPrompt") as string) || config.SYSTEM_PROMPT
    this.startPruning()
  }

  /**
   * Messages kept per chat. Read from runtime config on every use so the admin
   * UI takes effect immediately. 0 means unlimited.
   */
  private getMessageLimit(): number {
    const configured = runtimeConfig.get("memoryMessageLimit")
    const value = configured === undefined ? config.MEMORY_MESSAGE_LIMIT : Number(configured)
    return Number.isFinite(value) && value >= 0 ? value : config.MEMORY_MESSAGE_LIMIT
  }

  /**
   * How long a message stays in short-term memory. 0 means it never expires —
   * long-range recall is then handled by retrieval (see rag.service.ts) rather
   * than by keeping everything in the prompt.
   */
  private getRetentionMs(): number {
    const configured = runtimeConfig.get("memoryWindowMs")
    const value = configured === undefined ? config.MEMORY_WINDOW_MS : Number(configured)
    return Number.isFinite(value) && value >= 0 ? value : config.MEMORY_WINDOW_MS
  }

  /**
   * Add a new message to memory
   */
  /**
   * Add a new message scoped to a chat (chatId should be the group JID or private JID)
   */
  public async addMessage(chatId: string, sender: string, text: string, senderName?: string): Promise<void> {
    const displaySender = cleanPhoneFromJid(sender)

    // Get or use display name
    const displayName = senderName || userProfileService.getDisplayName(displaySender)

    const message: Message = {
      sender: displaySender,
      senderName: displayName,
      text,
      timestamp: Date.now()
    }
    const messages = this.conversations.get(chatId) || []
    messages.push(message)

    // Keep only the last `messageLimit` messages in memory (0 = unlimited)
    const messageLimit = this.getMessageLimit()
    if (messageLimit > 0 && messages.length > messageLimit) {
      messages.splice(0, messages.length - messageLimit)
      logger.debug(`Pruned old messages for ${chatId} to keep last ${messageLimit}`)
    }

    this.conversations.set(chatId, messages)

    // Save to database
    try {
      await databaseService.saveMessage({
        chatId,
        sender: displaySender,
        senderName: displayName,
        text,
        messageType: "text",
        timestamp: message.timestamp
      })

      // Update analytics
      const today = new Date().toISOString().split("T")[0]
      await databaseService.updateAnalytics(today, { totalMessages: 1 })
    } catch (err) {
      logger.error("Failed to save message to database", err)
    }

    // If chat is group, attempt to read group name for better logging
    let displayChat = chatId
    if (chatId && chatId.endsWith("@g.us")) {
      try {
        const name = await whatsappService.getGroupName(chatId)
        if (name) displayChat = `${name} (${chatId})`
      } catch (err) {
        // ignore
      }
    }
    logger.info(`Message added to memory for ${displayChat} from ${displayName} (${displaySender})`)
  }

  /**
   * Get context string from recent messages
   */
  public getContext(chatId: string): string {
    this.pruneOldMessages()

    const messages = this.conversations.get(chatId) || []
    if (messages.length === 0) return "No recent messages in context."

    const contextMessages = messages.map((msg) => `${msg.senderName}: ${msg.text}`).join("\n")
    return `Recent conversation:\n${contextMessages}`
  }

  /**
   * When the oldest message still in short-term memory was sent, or null when
   * the chat has none.
   *
   * This is the boundary between "already in the prompt verbatim" and "would
   * have to be recalled". Retrieval uses it to avoid paying for text the prompt
   * is carrying anyway — see `ragService.retrieve`.
   */
  public getOldestTimestamp(chatId: string): number | undefined {
    this.pruneOldMessages()
    const messages = this.conversations.get(chatId)
    return messages && messages.length ? messages[0].timestamp : undefined
  }

  /**
   * Get list of participants from messages in this chat (for context)
   */
  public getParticipants(chatId: string): Array<{ name: string; phone: string }> {
    const messages = this.conversations.get(chatId) || []
    const participantMap = new Map<string, string>() // phone -> name

    for (const msg of messages) {
      participantMap.set(msg.sender, msg.senderName)
    }

    return Array.from(participantMap.entries()).map(([phone, name]) => ({ phone, name }))
  }

  /**
   * Get all messages (for admin purposes)
   */
  /**
   * Get all messages for a chat, or return a map of all conversations if chatId omitted
   */
  public getAllMessages(chatId?: string): Message[] | { [key: string]: Message[] } {
    this.pruneOldMessages()
    if (chatId) return [...(this.conversations.get(chatId) || [])]

    const result: { [key: string]: Message[] } = {}
    for (const [k, v] of this.conversations.entries()) result[k] = [...v]
    return result
  }

  /**
   * Clear all messages from memory
   */
  public clear(chatId?: string): void {
    // The style profile is derived from this chat's messages, so it must not
    // outlive them.
    styleService.invalidate(chatId)

    if (chatId) {
      const old = this.conversations.get(chatId) || []
      this.conversations.delete(chatId)
      logger.info(`Memory cleared for ${chatId}. Removed ${old.length} messages.`)
      return
    }
    // Clear all
    let total = 0
    for (const v of this.conversations.values()) total += v.length
    this.conversations.clear()
    logger.info(`Memory cleared (all conversations). Removed ${total} messages.`)
  }

  /**
   * Update the system prompt for the personality mode a chat is using (or for
   * the global default persona when no chat is given). Persisted immediately, so
   * the change applies to the very next LLM call.
   */
  public setSystemPrompt(prompt: string, chatId?: string): void {
    this.systemPrompt = prompt
    personaService.setPrompt(personaService.getPersonaForChat(chatId), prompt)
  }

  /**
   * The system prompt for a chat, resolved through its personality mode.
   * Read fresh on every call so admin-UI edits take effect without a restart.
   */
  public async getSystemPrompt(chatId?: string): Promise<string> {
    return personaService.getPromptForChat(chatId)
  }

  /**
   * Remove messages older than `retentionMs`
   */
  private pruneOldMessages(): void {
    const retentionMs = this.getRetentionMs()
    // 0 = messages never expire; retrieval handles long-range recall instead.
    if (retentionMs <= 0) return

    const now = Date.now()
    for (const [chatId, messages] of this.conversations.entries()) {
      const active = messages.filter((msg) => now - msg.timestamp <= retentionMs)
      const prunedCount = messages.length - active.length
      if (prunedCount > 0) logger.debug(`Pruned ${prunedCount} messages for ${chatId}`)
      if (active.length === 0) this.conversations.delete(chatId)
      else this.conversations.set(chatId, active)
    }
  }

  /**
   * Start automatic pruning every 5 minutes
   */
  private startPruning(): void {
    setInterval(
      () => {
        this.pruneOldMessages()
      },
      5 * 60 * 1000
    ) // 5 minutes
  }
}

// Singleton. Limits are read from runtime config on each use, so they can be
// changed from the admin UI without a restart.
export const memoryService = new MemoryService()
