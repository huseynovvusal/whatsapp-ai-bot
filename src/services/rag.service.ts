import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { databaseService, DbMessage } from "@/services/database.service"
import { embeddingService } from "@/services/embedding.service"

const logger = createLogger(config.LOG_LEVEL, "RAGService")

/**
 * Retrieval-Augmented Generation over the bot's own conversation history.
 *
 * How it works:
 *  1. Stored messages are grouped into chunks — consecutive messages in a chat,
 *     broken on a long silence or a size cap, so a chunk is roughly "one bit of
 *     conversation" rather than one line out of context.
 *  2. Each chunk is embedded once and stored as a normalised vector (SQLite BLOB).
 *  3. At reply time the incoming question is embedded and the nearest chunks are
 *     pulled back in and handed to the LLM as "things you remember".
 *
 * Storage note: chunks live in SQLite via `databaseService`, and search is a
 * linear dot-product scan. That is deliberate — it keeps the bot a single
 * self-contained container with no vector-database server to run alongside it,
 * and stays fast well beyond the message volume a WhatsApp bot produces. The
 * access points are narrow (insertKnowledgeChunks / searchKnowledgeChunks), so
 * swapping in a dedicated vector store later is a contained change.
 */

/** A chunk breaks when the conversation goes quiet for this long. */
const CHUNK_SILENCE_GAP_MS = 30 * 60 * 1000
/** ...or when it reaches this many messages. */
const CHUNK_MAX_MESSAGES = 12
/** ...or this many characters, whichever comes first. */
const CHUNK_MAX_CHARS = 1600

export interface RetrievedMemory {
  text: string
  chatId: string
  chatName: string | null
  score: number
  startTimestamp: number
  endTimestamp: number
}

export class RAGService {
  private indexing = false
  private lastIndexRun = 0

  public isEnabled(): boolean {
    return runtimeConfig.get("ragEnabled") !== false
  }

  public isIndexing(): boolean {
    return this.indexing
  }

  /** Group a chat's messages into coherent chunks of conversation. */
  private chunkMessages(messages: DbMessage[]): Array<{
    text: string
    startTimestamp: number
    endTimestamp: number
    messageCount: number
  }> {
    const chunks: Array<{
      text: string
      startTimestamp: number
      endTimestamp: number
      messageCount: number
    }> = []

    let current: DbMessage[] = []
    let currentChars = 0

    const flush = () => {
      if (!current.length) return
      const text = current
        .map((m) => `${m.senderName || m.sender}: ${m.text}`)
        .join("\n")
        .trim()
      if (text) {
        chunks.push({
          text,
          startTimestamp: current[0].timestamp,
          endTimestamp: current[current.length - 1].timestamp,
          messageCount: current.length,
        })
      }
      current = []
      currentChars = 0
    }

    for (const message of messages) {
      const text = (message.text || "").trim()
      if (!text) continue

      const previous = current[current.length - 1]
      const gap = previous ? message.timestamp - previous.timestamp : 0
      const wouldOverflow =
        current.length >= CHUNK_MAX_MESSAGES || currentChars + text.length > CHUNK_MAX_CHARS

      if (previous && (gap > CHUNK_SILENCE_GAP_MS || wouldOverflow)) flush()

      current.push(message)
      currentChars += text.length
    }
    flush()

    return chunks
  }

  /**
   * Index any messages that have arrived since the last run.
   * Safe to call often — it is a no-op when there is nothing new, and it never
   * runs two passes concurrently.
   */
  public async indexNewMessages(options: { force?: boolean } = {}): Promise<{
    chunks: number
    chats: number
    skipped: string | null
  }> {
    if (!this.isEnabled() && !options.force) {
      return { chunks: 0, chats: 0, skipped: "RAG is disabled" }
    }
    if (!embeddingService.isConfigured()) {
      return { chunks: 0, chats: 0, skipped: "No embedding provider configured" }
    }
    if (this.indexing) {
      return { chunks: 0, chats: 0, skipped: "Indexing already in progress" }
    }

    this.indexing = true
    let totalChunks = 0
    let touchedChats = 0

    try {
      const model = embeddingService.getModelId()
      const chatIds = databaseService.getIndexableChatIds()

      for (const chatId of chatIds) {
        const watermark = databaseService.getLastIndexedTimestamp(chatId)
        const messages = databaseService.getMessagesAfter(chatId, watermark)
        if (!messages.length) continue

        const chunks = this.chunkMessages(messages)
        if (!chunks.length) {
          databaseService.setLastIndexedTimestamp(
            chatId,
            messages[messages.length - 1].timestamp
          )
          continue
        }

        const conversation = databaseService.getConversation(chatId)
        const vectors = await embeddingService.embedBatch(chunks.map((c) => c.text))

        databaseService.insertKnowledgeChunks(
          chunks.map((chunk, i) => ({
            chatId,
            chatName: conversation?.chatName || undefined,
            isGroup: chatId.endsWith("@g.us"),
            text: chunk.text,
            startTimestamp: chunk.startTimestamp,
            endTimestamp: chunk.endTimestamp,
            messageCount: chunk.messageCount,
            model,
            vector: vectors[i],
          }))
        )

        // Advance the watermark only as far as the last message we actually
        // chunked, so a partially-consumed tail is picked up next run.
        databaseService.setLastIndexedTimestamp(
          chatId,
          chunks[chunks.length - 1].endTimestamp
        )

        totalChunks += chunks.length
        touchedChats++
      }

      this.lastIndexRun = Date.now()
      if (totalChunks > 0) {
        logger.info(`Indexed ${totalChunks} new chunk(s) across ${touchedChats} chat(s)`)
      }
      return { chunks: totalChunks, chats: touchedChats, skipped: null }
    } catch (err) {
      logger.error("Indexing failed", err)
      return { chunks: totalChunks, chats: touchedChats, skipped: String(err) }
    } finally {
      this.indexing = false
    }
  }

  /**
   * Rebuild the whole knowledge base from scratch (after changing embedding
   * model or chunking, where old vectors are no longer comparable).
   */
  public async reindexAll(chatId?: string): Promise<{ chunks: number; chats: number }> {
    databaseService.clearKnowledge(chatId)
    logger.info(`Knowledge base cleared${chatId ? ` for ${chatId}` : ""}, rebuilding…`)
    const result = await this.indexNewMessages({ force: true })
    return { chunks: result.chunks, chats: result.chats }
  }

  /**
   * Find conversation the bot should "remember" for this question.
   *
   * `chatId` scopes results to the current conversation unless cross-chat recall
   * is switched on — a privacy decision, since it decides whether something said
   * in one group can surface in another.
   */
  public async retrieve(
    query: string,
    chatId: string,
    options: { limit?: number; minScore?: number } = {}
  ): Promise<RetrievedMemory[]> {
    if (!this.isEnabled()) return []
    if (!embeddingService.isConfigured()) return []
    if (!query || query.trim().length < 3) return []

    try {
      const crossChat = runtimeConfig.get("ragCrossChat") === true
      const limit = options.limit || Number(runtimeConfig.get("ragTopK")) || 4
      const minScore =
        options.minScore !== undefined
          ? options.minScore
          : Number(runtimeConfig.get("ragMinScore")) || 0.3

      const queryVector = await embeddingService.embed(query)
      const hits = databaseService.searchKnowledgeChunks(queryVector, {
        chatId: crossChat ? undefined : chatId,
        model: embeddingService.getModelId(),
        limit,
        minScore,
      })

      return hits.map((hit) => ({
        text: hit.text,
        chatId: hit.chatId,
        chatName: hit.chatName,
        score: hit.score,
        startTimestamp: hit.startTimestamp,
        endTimestamp: hit.endTimestamp,
      }))
    } catch (err) {
      // Retrieval is an enhancement — never let it break a reply.
      logger.warn("Retrieval failed, continuing without memories", err)
      return []
    }
  }

  /** Render retrieved chunks as a context block for the prompt. */
  public formatMemories(memories: RetrievedMemory[]): string {
    if (!memories.length) return ""
    const blocks = memories.map((memory) => {
      const when = new Date(memory.endTimestamp).toISOString().split("T")[0]
      const where = memory.chatName ? ` in "${memory.chatName}"` : ""
      return `[${when}${where}]\n${memory.text}`
    })
    return (
      "Relevant things from earlier conversations (these are your memories — " +
      "use them only if they help answer, and never quote them verbatim as if " +
      "they were just said):\n\n" +
      blocks.join("\n\n") +
      "\n"
    )
  }

  /** Background indexing loop. */
  public startBackgroundIndexing(): void {
    const intervalMs = 5 * 60 * 1000
    setInterval(() => {
      if (!this.isEnabled() || !embeddingService.isConfigured()) return
      this.indexNewMessages().catch((err) => logger.warn("Background indexing failed", err))
    }, intervalMs)
    logger.info("Background knowledge indexing scheduled (every 5 minutes)")
  }

  public getStatus(): {
    enabled: boolean
    indexing: boolean
    configured: boolean
    model: string | null
    lastIndexRun: number
  } {
    return {
      enabled: this.isEnabled(),
      indexing: this.indexing,
      configured: embeddingService.isConfigured(),
      model: embeddingService.isConfigured() ? embeddingService.getModelId() : null,
      lastIndexRun: this.lastIndexRun,
    }
  }
}

export const ragService = new RAGService()
