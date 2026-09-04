import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { databaseService } from "@/services/database.service"
import { llmService } from "@/services/llm.service"
import { memoryService } from "@/services/memory.service"

const logger = createLogger(config.LOG_LEVEL, "GroupMemory")

/**
 * Standing notes about a chat — the bot's MEMORY.md.
 *
 * The other two memory layers answer different questions. Short-term memory is
 * "what was just said" and scrolls away. Retrieval (`ragService`) is "find the
 * message where someone mentioned this", and only surfaces when a query happens
 * to match. Neither of them gives the bot the thing a person carries into every
 * conversation without being reminded: who these people are, what they are in
 * the middle of, what the running jokes are, what was already decided.
 *
 * So this keeps one small markdown document per chat, rewritten by the model
 * every so often from the recent conversation, and prepended to every prompt.
 * It is deliberately small and deliberately editable — the operator can open it
 * in the admin UI, correct something wrong, and the bot believes the correction.
 *
 * Cost: one extra completion per refresh, not per message. At the default of 40
 * messages that is negligible next to the replies themselves.
 */

/** Hard ceiling on the document, so it can never crowd out the prompt. */
const MAX_NOTES_CHARS = 2000
/** Messages between rewrites, unless the operator configures otherwise. */
const DEFAULT_REFRESH_EVERY = 40

const UPDATE_INSTRUCTIONS = `You keep a short set of standing notes about a group chat, so you remember it between conversations.

Rewrite the notes below to take account of the recent messages. Return ONLY the updated notes as markdown — no preamble, no explanation, no code fence.

Keep:
- Who the people are: names, what they do, how they relate to each other.
- What is going on: ongoing plans, decisions made, things people are waiting on.
- How this group talks: running jokes, recurring topics, the tone.
- Anything someone stated about themselves that they would expect you to remember.

Rules:
- Facts only. Do not invent anything that was not said.
- Drop things that are finished or no longer true, rather than piling up history.
- No message-by-message log. This is a profile of the chat, not a transcript.
- Keep it under 250 words. Short bullet points under a few "##" headings.
- If the recent messages add nothing worth keeping, return the existing notes unchanged.`

export class GroupMemoryService {
  /** Chats currently being rewritten, so a burst cannot start two refreshes. */
  private refreshing: Set<string> = new Set()

  public isEnabled(): boolean {
    return runtimeConfig.get("groupMemoryEnabled") === true
  }

  private refreshEvery(): number {
    const configured = Number(runtimeConfig.get("groupMemoryRefreshEvery"))
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_REFRESH_EVERY
  }

  /** The notes for a chat, or null when there are none. */
  public async get(chatId: string): Promise<string | null> {
    try {
      const { notes } = await databaseService.getChatNotes(chatId)
      return notes && notes.trim() ? notes : null
    } catch (err) {
      logger.warn("Could not read chat notes", err)
      return null
    }
  }

  /** The notes formatted for the prompt, or "" when there is nothing to add. */
  public async getForPrompt(chatId: string): Promise<string> {
    if (!this.isEnabled()) return ""
    const notes = await this.get(chatId)
    if (!notes) return ""
    return `What you already know about this chat (your standing notes):\n${notes}`
  }

  /** Replace the notes by hand, from the admin UI or an admin command. */
  public async set(chatId: string, notes: string | null): Promise<void> {
    const trimmed = notes?.trim() ? notes.trim().slice(0, MAX_NOTES_CHARS) : null
    await databaseService.setChatNotes(chatId, trimmed)
    logger.info(trimmed ? `Notes updated for ${chatId}` : `Notes cleared for ${chatId}`)
  }

  /**
   * Count a message towards the next refresh and start one if it is due.
   *
   * Called on every stored message and returns immediately — the rewrite itself
   * runs detached, because nothing about answering the current message should
   * wait for it.
   */
  public async noteMessage(chatId: string): Promise<void> {
    if (!this.isEnabled()) return
    try {
      const seen = await databaseService.bumpChatNotesCounter(chatId)
      if (seen < this.refreshEvery()) return
      void this.refresh(chatId)
    } catch (err) {
      logger.debug("Could not count message towards notes refresh", err)
    }
  }

  /**
   * Rewrite a chat's notes from its recent conversation.
   *
   * Never throws: memory upkeep failing must not affect replies. Returns the new
   * notes when it wrote any, so the admin UI can show the result of a manual run.
   */
  public async refresh(chatId: string): Promise<string | null> {
    if (this.refreshing.has(chatId)) {
      logger.debug(`Notes refresh already running for ${chatId}`)
      return null
    }
    this.refreshing.add(chatId)

    try {
      const conversation = memoryService.getContext(chatId)
      if (!conversation || conversation === "No recent messages in context.") {
        logger.debug(`Nothing to summarise for ${chatId}`)
        return null
      }

      const existing = (await this.get(chatId)) || "(no notes yet)"
      const prompt = `${UPDATE_INSTRUCTIONS}

=== CURRENT NOTES ===
${existing}

=== RECENT MESSAGES ===
${conversation}

=== UPDATED NOTES ===`

      // The notes are asked for in under 250 words and truncated at 2,000 chars
      // anyway, so anything beyond this ceiling would be paid for and discarded.
      const updated = await llmService.ask(prompt, { maxTokens: 600 })
      const cleaned = this.clean(updated)
      if (!cleaned) {
        logger.debug(`Notes refresh for ${chatId} produced nothing usable`)
        return null
      }

      await databaseService.setChatNotes(chatId, cleaned)
      logger.info(`Refreshed standing notes for ${chatId} (${cleaned.length} chars)`)
      return cleaned
    } catch (err) {
      logger.warn(`Notes refresh failed for ${chatId}`, err)
      return null
    } finally {
      this.refreshing.delete(chatId)
    }
  }

  /**
   * Strip the wrappers models add despite being told not to, and enforce the
   * size ceiling. Returns "" when nothing usable is left.
   */
  private clean(raw: string): string {
    let text = (raw || "").trim()
    // Fenced block, with or without a language tag.
    const fence = text.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i)
    if (fence) text = fence[1].trim()
    // A lead-in line like "Here are the updated notes:".
    text = text.replace(/^(here (are|is)|updated notes)[^\n]*\n+/i, "").trim()
    if (text.length <= 2) return ""
    return text.slice(0, MAX_NOTES_CHARS)
  }
}

export const groupMemoryService = new GroupMemoryService()
