import Database from "better-sqlite3"
import path from "path"
import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"

const logger = createLogger(config.LOG_LEVEL, "DatabaseService")

export interface DbMessage {
  id?: number
  chatId: string
  sender: string
  senderName: string
  text: string
  messageType: "text" | "image" | "video" | "audio" | "document" | "sticker"
  mediaUrl?: string
  timestamp: number
  createdAt?: string
}

export interface DbUser {
  id?: number
  phoneNumber: string
  displayName?: string
  pushName?: string
  lastSeen: number
  messageCount: number
  firstSeen: number
  createdAt?: string
  updatedAt?: string
}

export interface DbConversation {
  id?: number
  chatId: string
  chatName?: string
  isGroup: boolean
  messageCount: number
  lastMessageAt: number
  createdAt?: string
  updatedAt?: string
}

export interface DbAnalytics {
  id?: number
  date: string
  totalMessages: number
  totalUsers: number
  totalConversations: number
  apiCalls: number
  tokensUsed: number
  createdAt?: string
}

export class DatabaseService {
  private db: Database.Database

  constructor() {
    const dbPath = path.join(__dirname, "../../data/whatsapp-bot.db")

    // Ensure data directory exists
    const fs = require("fs")
    const dataDir = path.dirname(dbPath)
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    this.db = new Database(dbPath)
    this.db.pragma("journal_mode = WAL") // Better performance
    this.initializeTables()
    logger.info(`Database initialized at ${dbPath}`)
  }

  private initializeTables(): void {
    // Messages table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatId TEXT NOT NULL,
        sender TEXT NOT NULL,
        senderName TEXT NOT NULL,
        text TEXT NOT NULL,
        messageType TEXT DEFAULT 'text',
        mediaUrl TEXT,
        timestamp INTEGER NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chatId ON messages(chatId);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    `)

    // Users table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phoneNumber TEXT UNIQUE NOT NULL,
        displayName TEXT,
        pushName TEXT,
        lastSeen INTEGER NOT NULL,
        messageCount INTEGER DEFAULT 0,
        firstSeen INTEGER NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_users_phoneNumber ON users(phoneNumber);
    `)

    // Conversations table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatId TEXT UNIQUE NOT NULL,
        chatName TEXT,
        isGroup INTEGER DEFAULT 0,
        messageCount INTEGER DEFAULT 0,
        lastMessageAt INTEGER NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_chatId ON conversations(chatId);
    `)

    // Analytics table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analytics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT UNIQUE NOT NULL,
        totalMessages INTEGER DEFAULT 0,
        totalUsers INTEGER DEFAULT 0,
        totalConversations INTEGER DEFAULT 0,
        apiCalls INTEGER DEFAULT 0,
        tokensUsed INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_analytics_date ON analytics(date);
    `)

    // Access control tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS whitelist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        identifier TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL,
        name TEXT,
        addedBy TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_whitelist_identifier ON whitelist(identifier);
      CREATE INDEX IF NOT EXISTS idx_whitelist_type ON whitelist(type);
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blacklist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        identifier TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL,
        name TEXT,
        reason TEXT,
        addedBy TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_blacklist_identifier ON blacklist(identifier);
      CREATE INDEX IF NOT EXISTS idx_blacklist_type ON blacklist(type);
    `)

    // Knowledge base (RAG). Chunks of conversation plus their embedding vector.
    // `vector` is a Float32 BLOB, stored already L2-normalised so similarity
    // search is a dot product.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chatId TEXT NOT NULL,
        chatName TEXT,
        isGroup INTEGER DEFAULT 0,
        text TEXT NOT NULL,
        startTimestamp INTEGER NOT NULL,
        endTimestamp INTEGER NOT NULL,
        messageCount INTEGER DEFAULT 0,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_chatId ON knowledge_chunks(chatId);
      CREATE INDEX IF NOT EXISTS idx_knowledge_end ON knowledge_chunks(endTimestamp);
      CREATE INDEX IF NOT EXISTS idx_knowledge_model ON knowledge_chunks(model);
    `)

    // Per-chat indexing watermark, so re-indexing only picks up new messages.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_state (
        chatId TEXT PRIMARY KEY,
        lastIndexedTimestamp INTEGER NOT NULL,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `)

    // Per-chat overrides (currently the personality mode). A chat with no row
    // here simply follows the global default.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_settings (
        chatId TEXT PRIMARY KEY,
        persona TEXT,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `)

    logger.info("Database tables initialized")
  }

  // ============= PER-CHAT SETTINGS =============

  public getChatPersona(chatId: string): "assistant" | "companion" | null {
    const row = this.db
      .prepare("SELECT persona FROM chat_settings WHERE chatId = ?")
      .get(chatId) as { persona: string | null } | undefined
    const value = row?.persona
    return value === "assistant" || value === "companion" ? value : null
  }

  public setChatPersona(chatId: string, persona: "assistant" | "companion"): void {
    this.db
      .prepare(
        `INSERT INTO chat_settings (chatId, persona) VALUES (?, ?)
         ON CONFLICT(chatId) DO UPDATE SET persona = excluded.persona, updatedAt = CURRENT_TIMESTAMP`
      )
      .run(chatId, persona)
  }

  public clearChatPersona(chatId: string): void {
    this.db.prepare("DELETE FROM chat_settings WHERE chatId = ?").run(chatId)
  }

  /** Every chat that has an explicit override, for the admin UI. */
  public getChatPersonaOverrides(): Record<string, string> {
    const rows = this.db
      .prepare("SELECT chatId, persona FROM chat_settings WHERE persona IS NOT NULL")
      .all() as Array<{ chatId: string; persona: string }>
    const out: Record<string, string> = {}
    for (const row of rows) out[row.chatId] = row.persona
    return out
  }

  // ============= KNOWLEDGE BASE (RAG) OPERATIONS =============

  /**
   * Messages in a chat newer than `after`, oldest first — the input to chunking.
   */
  public getMessagesAfter(chatId: string, after: number, limit: number = 2000): DbMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE chatId = ? AND timestamp > ?
      ORDER BY timestamp ASC
      LIMIT ?
    `)
    return stmt.all(chatId, after, limit) as DbMessage[]
  }

  /** Distinct chat IDs that have any stored messages. */
  public getIndexableChatIds(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT chatId FROM messages")
      .all() as Array<{ chatId: string }>
    return rows.map((r) => r.chatId)
  }

  public getLastIndexedTimestamp(chatId: string): number {
    const row = this.db
      .prepare("SELECT lastIndexedTimestamp FROM knowledge_state WHERE chatId = ?")
      .get(chatId) as { lastIndexedTimestamp: number } | undefined
    return row?.lastIndexedTimestamp || 0
  }

  public setLastIndexedTimestamp(chatId: string, timestamp: number): void {
    this.db
      .prepare(
        `INSERT INTO knowledge_state (chatId, lastIndexedTimestamp)
         VALUES (?, ?)
         ON CONFLICT(chatId) DO UPDATE SET
           lastIndexedTimestamp = excluded.lastIndexedTimestamp,
           updatedAt = CURRENT_TIMESTAMP`
      )
      .run(chatId, timestamp)
  }

  public insertKnowledgeChunks(
    chunks: Array<{
      chatId: string
      chatName?: string
      isGroup: boolean
      text: string
      startTimestamp: number
      endTimestamp: number
      messageCount: number
      model: string
      vector: number[]
    }>
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO knowledge_chunks
        (chatId, chatName, isGroup, text, startTimestamp, endTimestamp, messageCount, model, dim, vector)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertAll = this.db.transaction((rows: typeof chunks) => {
      for (const chunk of rows) {
        stmt.run(
          chunk.chatId,
          chunk.chatName || null,
          chunk.isGroup ? 1 : 0,
          chunk.text,
          chunk.startTimestamp,
          chunk.endTimestamp,
          chunk.messageCount,
          chunk.model,
          chunk.vector.length,
          Buffer.from(new Float32Array(chunk.vector).buffer)
        )
      }
    })
    insertAll(chunks)
  }

  /**
   * Nearest chunks to `queryVector` by dot product (vectors are pre-normalised,
   * so this is cosine similarity).
   *
   * This is a linear scan. It stays comfortably fast into the tens of thousands
   * of chunks; past that, swap in a vector index (see the VectorStore note in
   * rag.service.ts). Only chunks from the same embedding model are comparable,
   * so a model change simply yields no matches until re-indexing.
   */
  public searchKnowledgeChunks(
    queryVector: number[],
    options: { chatId?: string; model: string; limit?: number; minScore?: number } = {
      model: "",
    }
  ): Array<{
    id: number
    chatId: string
    chatName: string | null
    text: string
    startTimestamp: number
    endTimestamp: number
    messageCount: number
    score: number
  }> {
    const limit = options.limit || 5
    const minScore = options.minScore === undefined ? 0 : options.minScore

    const where = ["model = ?"]
    const params: unknown[] = [options.model]
    if (options.chatId) {
      where.push("chatId = ?")
      params.push(options.chatId)
    }

    const rows = this.db
      .prepare(
        `SELECT id, chatId, chatName, text, startTimestamp, endTimestamp, messageCount, dim, vector
         FROM knowledge_chunks WHERE ${where.join(" AND ")}`
      )
      .all(...params) as Array<{
      id: number
      chatId: string
      chatName: string | null
      text: string
      startTimestamp: number
      endTimestamp: number
      messageCount: number
      dim: number
      vector: Buffer
    }>

    const scored = []
    for (const row of rows) {
      if (row.dim !== queryVector.length) continue
      const stored = new Float32Array(
        row.vector.buffer,
        row.vector.byteOffset,
        row.vector.byteLength / 4
      )
      let score = 0
      for (let i = 0; i < queryVector.length; i++) score += queryVector[i] * stored[i]
      if (score < minScore) continue
      scored.push({
        id: row.id,
        chatId: row.chatId,
        chatName: row.chatName,
        text: row.text,
        startTimestamp: row.startTimestamp,
        endTimestamp: row.endTimestamp,
        messageCount: row.messageCount,
        score,
      })
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  public getKnowledgeStats(): {
    chunks: number
    chats: number
    models: string[]
    oldest: number | null
    newest: number | null
  } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as chunks,
                COUNT(DISTINCT chatId) as chats,
                MIN(startTimestamp) as oldest,
                MAX(endTimestamp) as newest
         FROM knowledge_chunks`
      )
      .get() as { chunks: number; chats: number; oldest: number | null; newest: number | null }
    const models = (
      this.db.prepare("SELECT DISTINCT model FROM knowledge_chunks").all() as Array<{
        model: string
      }>
    ).map((m) => m.model)
    return { ...row, models }
  }

  public getKnowledgeChunkCount(chatId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM knowledge_chunks WHERE chatId = ?")
      .get(chatId) as { count: number }
    return row.count
  }

  /** Clear the knowledge base (optionally for one chat) and reset watermarks. */
  public clearKnowledge(chatId?: string): number {
    if (chatId) {
      const changes = this.db
        .prepare("DELETE FROM knowledge_chunks WHERE chatId = ?")
        .run(chatId).changes
      this.db.prepare("DELETE FROM knowledge_state WHERE chatId = ?").run(chatId)
      return changes
    }
    const changes = this.db.prepare("DELETE FROM knowledge_chunks").run().changes
    this.db.prepare("DELETE FROM knowledge_state").run()
    return changes
  }

  // ============= MESSAGE OPERATIONS =============

  public saveMessage(message: DbMessage): number {
    const stmt = this.db.prepare(`
      INSERT INTO messages (chatId, sender, senderName, text, messageType, mediaUrl, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const result = stmt.run(
      message.chatId,
      message.sender,
      message.senderName,
      message.text,
      message.messageType || "text",
      message.mediaUrl || null,
      message.timestamp
    )
    return result.lastInsertRowid as number
  }

  public getMessages(chatId: string, limit: number = 50): DbMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE chatId = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `)
    return stmt.all(chatId, limit) as DbMessage[]
  }

  public getRecentMessages(chatId: string, windowMs: number): DbMessage[] {
    const cutoff = Date.now() - windowMs
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE chatId = ? AND timestamp > ?
      ORDER BY timestamp ASC
    `)
    return stmt.all(chatId, cutoff) as DbMessage[]
  }

  public deleteMessagesByChat(chatId: string): number {
    const stmt = this.db.prepare("DELETE FROM messages WHERE chatId = ?")
    const result = stmt.run(chatId)
    return result.changes
  }

  public deleteAllMessages(): number {
    const stmt = this.db.prepare("DELETE FROM messages")
    const result = stmt.run()
    return result.changes
  }

  public searchMessages(query: string, limit: number = 100): DbMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE text LIKE ?
      ORDER BY timestamp DESC
      LIMIT ?
    `)
    return stmt.all(`%${query}%`, limit) as DbMessage[]
  }

  // ============= USER OPERATIONS =============

  public upsertUser(user: Omit<DbUser, "id" | "createdAt" | "updatedAt">): void {
    const stmt = this.db.prepare(`
      INSERT INTO users (phoneNumber, displayName, pushName, lastSeen, messageCount, firstSeen)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(phoneNumber) DO UPDATE SET
        displayName = COALESCE(excluded.displayName, displayName),
        pushName = COALESCE(excluded.pushName, pushName),
        lastSeen = excluded.lastSeen,
        messageCount = messageCount + 1,
        updatedAt = CURRENT_TIMESTAMP
    `)
    stmt.run(
      user.phoneNumber,
      user.displayName || null,
      user.pushName || null,
      user.lastSeen,
      user.messageCount || 0,
      user.firstSeen
    )
  }

  public getUser(phoneNumber: string): DbUser | undefined {
    const stmt = this.db.prepare("SELECT * FROM users WHERE phoneNumber = ?")
    return stmt.get(phoneNumber) as DbUser | undefined
  }

  public getAllUsers(): DbUser[] {
    const stmt = this.db.prepare("SELECT * FROM users ORDER BY lastSeen DESC")
    return stmt.all() as DbUser[]
  }

  /**
   * Everyone the bot knows about, joined with their real message activity.
   * `users.messageCount` is maintained by upserts and can drift, so counts here
   * come from the messages table.
   */
  public getUserDirectory(): Array<{
    phoneNumber: string
    displayName: string | null
    pushName: string | null
    firstSeen: number
    lastSeen: number
    messageCount: number
    chatCount: number
  }> {
    const stmt = this.db.prepare(`
      SELECT u.phoneNumber as phoneNumber,
             u.displayName as displayName,
             u.pushName as pushName,
             u.firstSeen as firstSeen,
             u.lastSeen as lastSeen,
             COALESCE(m.messageCount, 0) as messageCount,
             COALESCE(m.chatCount, 0) as chatCount
      FROM users u
      LEFT JOIN (
        SELECT sender, COUNT(*) as messageCount, COUNT(DISTINCT chatId) as chatCount
        FROM messages WHERE sender != 'Bot' GROUP BY sender
      ) m ON m.sender = u.phoneNumber
      ORDER BY u.lastSeen DESC
    `)
    return stmt.all() as Array<{
      phoneNumber: string
      displayName: string | null
      pushName: string | null
      firstSeen: number
      lastSeen: number
      messageCount: number
      chatCount: number
    }>
  }

  /** Which chats a person appears in, and how active they are in each. */
  public getUserActivity(phoneNumber: string): {
    totalMessages: number
    firstMessage: number | null
    lastMessage: number | null
    chats: Array<{ chatId: string; chatName: string | null; isGroup: boolean; count: number }>
  } {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) as totalMessages, MIN(timestamp) as firstMessage, MAX(timestamp) as lastMessage
         FROM messages WHERE sender = ?`
      )
      .get(phoneNumber) as {
      totalMessages: number
      firstMessage: number | null
      lastMessage: number | null
    }

    const chats = this.db
      .prepare(
        `SELECT m.chatId as chatId, c.chatName as chatName, COUNT(*) as count
         FROM messages m
         LEFT JOIN conversations c ON c.chatId = m.chatId
         WHERE m.sender = ?
         GROUP BY m.chatId
         ORDER BY count DESC`
      )
      .all(phoneNumber) as Array<{ chatId: string; chatName: string | null; count: number }>

    return {
      ...totals,
      chats: chats.map((c) => ({ ...c, isGroup: c.chatId.endsWith("@g.us") })),
    }
  }

  /** Distinct senders seen in a chat, with per-chat activity. */
  public getChatParticipants(chatId: string): Array<{
    sender: string
    senderName: string
    count: number
    lastMessageAt: number
  }> {
    const stmt = this.db.prepare(`
      SELECT sender, senderName, COUNT(*) as count, MAX(timestamp) as lastMessageAt
      FROM messages
      WHERE chatId = ? AND sender != 'Bot'
      GROUP BY sender
      ORDER BY count DESC
    `)
    return stmt.all(chatId) as Array<{
      sender: string
      senderName: string
      count: number
      lastMessageAt: number
    }>
  }

  public getMessagesBySender(phoneNumber: string, limit: number = 20): DbMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages WHERE sender = ? ORDER BY timestamp DESC LIMIT ?
    `)
    return stmt.all(phoneNumber, limit) as DbMessage[]
  }

  public getUserStats(): { total: number; active: number } {
    const total = this.db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number }
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
    const active = this.db.prepare("SELECT COUNT(*) as count FROM users WHERE lastSeen > ?").get(oneDayAgo) as { count: number }
    return { total: total.count, active: active.count }
  }

  // ============= CONVERSATION OPERATIONS =============

  public upsertConversation(conv: Omit<DbConversation, "id" | "createdAt" | "updatedAt">): void {
    const stmt = this.db.prepare(`
      INSERT INTO conversations (chatId, chatName, isGroup, messageCount, lastMessageAt)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chatId) DO UPDATE SET
        chatName = COALESCE(excluded.chatName, chatName),
        messageCount = messageCount + 1,
        lastMessageAt = excluded.lastMessageAt,
        updatedAt = CURRENT_TIMESTAMP
    `)
    stmt.run(
      conv.chatId,
      conv.chatName || null,
      conv.isGroup ? 1 : 0,
      conv.messageCount || 0,
      conv.lastMessageAt
    )
  }

  public getConversation(chatId: string): DbConversation | undefined {
    const stmt = this.db.prepare("SELECT * FROM conversations WHERE chatId = ?")
    return stmt.get(chatId) as DbConversation | undefined
  }

  public getAllConversations(): DbConversation[] {
    const stmt = this.db.prepare("SELECT * FROM conversations ORDER BY lastMessageAt DESC")
    return stmt.all() as DbConversation[]
  }

  // ============= ANALYTICS OPERATIONS =============

  /**
   * Accumulate counters for a date.
   *
   * `totalMessages`/`apiCalls`/`tokensUsed` add to what is there. `totalUsers`
   * and `totalConversations` are snapshots, so they are only overwritten when a
   * value is actually supplied — passing NULL leaves the stored value alone.
   * (The previous version used `COALESCE(excluded.x, x)` against a value that had
   * already been defaulted to 0, so COALESCE never saw NULL and every incoming
   * message reset both columns to zero.)
   */
  public updateAnalytics(date: string, updates: Partial<DbAnalytics>): void {
    const stmt = this.db.prepare(`
      INSERT INTO analytics (date, totalMessages, totalUsers, totalConversations, apiCalls, tokensUsed)
      VALUES (
        @date,
        COALESCE(@messages, 0),
        COALESCE(@users, 0),
        COALESCE(@conversations, 0),
        COALESCE(@apiCalls, 0),
        COALESCE(@tokens, 0)
      )
      ON CONFLICT(date) DO UPDATE SET
        totalMessages = totalMessages + COALESCE(@messages, 0),
        totalUsers = CASE WHEN @users IS NULL THEN totalUsers ELSE @users END,
        totalConversations =
          CASE WHEN @conversations IS NULL THEN totalConversations ELSE @conversations END,
        apiCalls = apiCalls + COALESCE(@apiCalls, 0),
        tokensUsed = tokensUsed + COALESCE(@tokens, 0)
    `)
    stmt.run({
      date,
      messages: updates.totalMessages ?? null,
      users: updates.totalUsers ?? null,
      conversations: updates.totalConversations ?? null,
      apiCalls: updates.apiCalls ?? null,
      tokens: updates.tokensUsed ?? null,
    })
  }

  public getAnalytics(startDate: string, endDate: string): DbAnalytics[] {
    const stmt = this.db.prepare(`
      SELECT * FROM analytics
      WHERE date BETWEEN ? AND ?
      ORDER BY date DESC
    `)
    return stmt.all(startDate, endDate) as DbAnalytics[]
  }

  public getTodayStats(): DbAnalytics | undefined {
    const today = new Date().toISOString().split("T")[0]
    const stmt = this.db.prepare("SELECT * FROM analytics WHERE date = ?")
    return stmt.get(today) as DbAnalytics | undefined
  }

  /**
   * Most active senders within a time window. The bot's own messages are excluded
   * so the ranking reflects real people.
   */
  public getTopUsers(
    since: number,
    limit: number = 8
  ): Array<{ sender: string; senderName: string; count: number }> {
    const stmt = this.db.prepare(`
      SELECT sender, senderName, COUNT(*) as count
      FROM messages
      WHERE timestamp >= ? AND sender != 'Bot'
      GROUP BY sender
      ORDER BY count DESC
      LIMIT ?
    `)
    return stmt.all(since, limit) as Array<{
      sender: string
      senderName: string
      count: number
    }>
  }

  /**
   * Busiest chats within a time window, resolved to a display name where known.
   */
  public getTopConversations(
    since: number,
    limit: number = 8
  ): Array<{ chatId: string; chatName: string | null; isGroup: boolean; count: number }> {
    const stmt = this.db.prepare(`
      SELECT m.chatId as chatId, c.chatName as chatName, COUNT(*) as count
      FROM messages m
      LEFT JOIN conversations c ON c.chatId = m.chatId
      WHERE m.timestamp >= ?
      GROUP BY m.chatId
      ORDER BY count DESC
      LIMIT ?
    `)
    const rows = stmt.all(since, limit) as Array<{
      chatId: string
      chatName: string | null
      count: number
    }>
    return rows.map((r) => ({ ...r, isGroup: r.chatId.endsWith("@g.us") }))
  }

  /**
   * Message volume by hour of day (0-23, server local time). Always returns all
   * 24 buckets so the chart has a stable x-axis even for sparse data.
   */
  public getHourlyActivity(since: number): Array<{ hour: number; count: number }> {
    const stmt = this.db.prepare(`
      SELECT CAST(strftime('%H', timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) as hour,
             COUNT(*) as count
      FROM messages
      WHERE timestamp >= ?
      GROUP BY hour
    `)
    const rows = stmt.all(since) as Array<{ hour: number; count: number }>
    const buckets = new Map(rows.map((r) => [r.hour, r.count]))
    return Array.from({ length: 24 }, (_, hour) => ({ hour, count: buckets.get(hour) || 0 }))
  }

  /**
   * Headline totals for a window, computed from the messages table so they always
   * agree with the per-chat and per-user breakdowns.
   */
  public getRangeTotals(
    since: number,
    until: number = Date.now()
  ): { messages: number; botMessages: number; activeUsers: number; activeChats: number } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) as messages,
           SUM(CASE WHEN sender = 'Bot' THEN 1 ELSE 0 END) as botMessages,
           COUNT(DISTINCT CASE WHEN sender != 'Bot' THEN sender END) as activeUsers,
           COUNT(DISTINCT chatId) as activeChats
         FROM messages
         WHERE timestamp >= ? AND timestamp <= ?`
      )
      .get(since, until) as {
      messages: number | null
      botMessages: number | null
      activeUsers: number | null
      activeChats: number | null
    }
    return {
      messages: row.messages || 0,
      botMessages: row.botMessages || 0,
      activeUsers: row.activeUsers || 0,
      activeChats: row.activeChats || 0,
    }
  }

  // ============= ACCESS CONTROL OPERATIONS =============

  public addToWhitelist(identifier: string, type: "contact" | "group", name?: string, addedBy?: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO whitelist (identifier, type, name, addedBy)
      VALUES (?, ?, ?, ?)
    `)
    stmt.run(identifier, type, name, addedBy)
  }

  public removeFromWhitelist(identifier: string): void {
    const stmt = this.db.prepare("DELETE FROM whitelist WHERE identifier = ?")
    stmt.run(identifier)
  }

  public getWhitelist(): Array<{ identifier: string; type: string; name?: string; createdAt: string }> {
    const stmt = this.db.prepare("SELECT identifier, type, name, createdAt FROM whitelist ORDER BY createdAt DESC")
    return stmt.all() as Array<{ identifier: string; type: string; name?: string; createdAt: string }>
  }

  public isWhitelisted(identifier: string): boolean {
    const stmt = this.db.prepare("SELECT COUNT(*) as count FROM whitelist WHERE identifier = ?")
    const result = stmt.get(identifier) as { count: number }
    return result.count > 0
  }

  public addToBlacklist(identifier: string, type: "contact" | "group", name?: string, reason?: string, addedBy?: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO blacklist (identifier, type, name, reason, addedBy)
      VALUES (?, ?, ?, ?, ?)
    `)
    stmt.run(identifier, type, name, reason, addedBy)
  }

  public removeFromBlacklist(identifier: string): void {
    const stmt = this.db.prepare("DELETE FROM blacklist WHERE identifier = ?")
    stmt.run(identifier)
  }

  public getBlacklist(): Array<{ identifier: string; type: string; name?: string; reason?: string; createdAt: string }> {
    const stmt = this.db.prepare("SELECT identifier, type, name, reason, createdAt FROM blacklist ORDER BY createdAt DESC")
    return stmt.all() as Array<{ identifier: string; type: string; name?: string; reason?: string; createdAt: string }>
  }

  public isBlacklisted(identifier: string): boolean {
    const stmt = this.db.prepare("SELECT COUNT(*) as count FROM blacklist WHERE identifier = ?")
    const result = stmt.get(identifier) as { count: number }
    return result.count > 0
  }

  // ============= UTILITY OPERATIONS =============

  /**
   * Raw database handle, for maintenance tooling only (e.g. the fixtures script in
   * `scripts/seed.ts`). Application code should use the typed methods above so that
   * schema knowledge stays in this service.
   */
  public getRawDb(): Database.Database {
    return this.db
  }

  public close(): void {
    this.db.close()
    logger.info("Database connection closed")
  }

  public backup(backupPath: string): void {
    this.db.backup(backupPath)
    logger.info(`Database backed up to ${backupPath}`)
  }

  public getStats(): {
    totalMessages: number
    totalUsers: number
    totalConversations: number
  } {
    const messages = this.db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number }
    const users = this.db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number }
    const conversations = this.db.prepare("SELECT COUNT(*) as count FROM conversations").get() as { count: number }

    return {
      totalMessages: messages.count,
      totalUsers: users.count,
      totalConversations: conversations.count,
    }
  }
}

// Singleton instance
export const databaseService = new DatabaseService()

// Graceful shutdown
process.on("exit", () => {
  databaseService.close()
})
