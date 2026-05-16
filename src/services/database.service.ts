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

    logger.info("Database tables initialized")
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

  public updateAnalytics(date: string, updates: Partial<DbAnalytics>): void {
    const stmt = this.db.prepare(`
      INSERT INTO analytics (date, totalMessages, totalUsers, totalConversations, apiCalls, tokensUsed)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        totalMessages = totalMessages + ?,
        totalUsers = COALESCE(excluded.totalUsers, totalUsers),
        totalConversations = COALESCE(excluded.totalConversations, totalConversations),
        apiCalls = apiCalls + ?,
        tokensUsed = tokensUsed + ?
    `)
    stmt.run(
      date,
      updates.totalMessages || 0,
      updates.totalUsers || 0,
      updates.totalConversations || 0,
      updates.apiCalls || 0,
      updates.tokensUsed || 0,
      updates.totalMessages || 0,
      updates.apiCalls || 0,
      updates.tokensUsed || 0
    )
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
