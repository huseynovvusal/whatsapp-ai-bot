import { runtimeConfig } from "@/services/runtimeConfig.service"
import { whatsappService } from "@/services/whatsapp.service"
import { cleanPhoneNumber as cleanPhoneFromJid } from "@/utils/phone.utils"
import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"

const logger = createLogger(config.LOG_LEVEL, "MemoryService")

export interface Message {
  sender: string
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

  private messageLimit: number
  private retentionMs: number

  constructor(messageLimit = 10, retentionMs = 60 * 60 * 1000) {
    // Default: last 10 messages, 1 hour retention
    this.messageLimit = messageLimit
    this.retentionMs = retentionMs
    // Load system prompt from runtime config if set, otherwise use env value
    this.systemPrompt = (runtimeConfig.get("systemPrompt") as string) || config.SYSTEM_PROMPT
    this.startPruning()
  }

  /**
   * Add a new message to memory
   */
  /**
   * Add a new message scoped to a chat (chatId should be the group JID or private JID)
   */
  public async addMessage(chatId: string, sender: string, text: string): Promise<void> {
    const displaySender = cleanPhoneFromJid(sender)
    const message: Message = { sender: displaySender, text, timestamp: Date.now() }
    const messages = this.conversations.get(chatId) || []
    messages.push(message)

    // Keep only last `messageLimit` messages
    if (messages.length > this.messageLimit) {
      messages.splice(0, messages.length - this.messageLimit)
      logger.debug(`Pruned old messages for ${chatId} to keep last ${this.messageLimit}`)
    }

    this.conversations.set(chatId, messages)
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
    logger.info(`Message added to memory for ${displayChat} from ${displaySender}`)
  }

  /**
   * Get context string from recent messages
   */
  public getContext(chatId: string): string {
    this.pruneOldMessages()

    const messages = this.conversations.get(chatId) || []
    if (messages.length === 0) return "No recent messages in context."

    const contextMessages = messages.map((msg) => `${msg.sender}: ${msg.text}`).join("\n")
    return `Recent conversation:\n${contextMessages}`
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
   * Update system prompt
   */
  public setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt
    logger.info("System prompt updated")
  }

  /**
   * Get current system prompt
   */
  public getSystemPrompt(): string {
    return this.systemPrompt
  }

  /**
   * Remove messages older than `retentionMs`
   */
  private pruneOldMessages(): void {
    const now = Date.now()
    for (const [chatId, messages] of this.conversations.entries()) {
      const active = messages.filter((msg) => now - msg.timestamp <= this.retentionMs)
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

// Singleton instance with defaults: 10 messages, 1 hour retention
export const memoryService = new MemoryService()
