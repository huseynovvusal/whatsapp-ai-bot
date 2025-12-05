import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"

const logger = createLogger(config.LOG_LEVEL, "MemoryService")

export interface Message {
  sender: string
  text: string
  timestamp: number
}

export class MemoryService {
  private messages: Message[] = []
  private systemPrompt: string

  private messageLimit: number
  private retentionMs: number

  constructor(messageLimit = 10, retentionMs = 60 * 60 * 1000) {
    // Default: last 10 messages, 1 hour retention
    this.messageLimit = messageLimit
    this.retentionMs = retentionMs
    this.systemPrompt = config.SYSTEM_PROMPT
    this.startPruning()
  }

  /**
   * Add a new message to memory
   */
  public addMessage(sender: string, text: string): void {
    const message: Message = {
      sender,
      text,
      timestamp: Date.now(),
    }
    this.messages.push(message)

    // Keep only last `messageLimit` messages
    if (this.messages.length > this.messageLimit) {
      const removed = this.messages.splice(0, this.messages.length - this.messageLimit)
      logger.debug(`Pruned ${removed.length} old messages to keep last ${this.messageLimit}`)
    }

    logger.info(`Message added to memory from ${sender}`)
  }

  /**
   * Get context string from recent messages
   */
  public getContext(): string {
    this.pruneOldMessages()

    if (this.messages.length === 0) {
      return "No recent messages in context."
    }

    const contextMessages = this.messages.map((msg) => `${msg.sender}: ${msg.text}`).join("\n")
    return `Recent conversation:\n${contextMessages}`
  }

  /**
   * Get all messages (for admin purposes)
   */
  public getAllMessages(): Message[] {
    this.pruneOldMessages()
    return [...this.messages]
  }

  /**
   * Clear all messages from memory
   */
  public clear(): void {
    const count = this.messages.length
    this.messages = []
    logger.info(`Memory cleared. Removed ${count} messages.`)
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
    const initialCount = this.messages.length

    this.messages = this.messages.filter((msg) => now - msg.timestamp <= this.retentionMs)

    const prunedCount = initialCount - this.messages.length
    if (prunedCount > 0) {
      logger.debug(`Pruned ${prunedCount} messages older than ${this.retentionMs / 1000}s`)
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
