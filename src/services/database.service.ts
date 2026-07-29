import { Prisma } from "@prisma/client"
import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"
import { prisma } from "@/lib/prisma"

const logger = createLogger(config.LOG_LEVEL, "DatabaseService")

/**
 * Data access for the bot, backed by PostgreSQL via Prisma.
 *
 * Two conventions worth knowing:
 *
 * - **Timestamps cross the boundary as plain numbers.** They are stored as
 *   BigInt because epoch milliseconds overflow a 32-bit int, but every method
 *   here converts to `number` on the way out and back on the way in. Callers —
 *   and `JSON.stringify`, which throws on BigInt — never see a BigInt.
 * - **Vectors are handled with raw SQL.** Prisma has no vector type, so
 *   `knowledge_chunks.vector` is written and searched through `$queryRaw` using
 *   pgvector's `<=>` cosine-distance operator. That pushes similarity search
 *   into the database instead of scanning every row in JavaScript.
 */

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

/** Epoch millis fit comfortably inside Number.MAX_SAFE_INTEGER. */
const toNumber = (value: bigint | number | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value)

/** pgvector accepts its literal form as a string: "[0.1,0.2,...]". */
const toVectorLiteral = (vector: number[]): string => `[${vector.join(",")}]`

type MessageRow = {
  id: number
  chatId: string
  sender: string
  senderName: string
  text: string
  messageType: string
  mediaUrl: string | null
  timestamp: bigint
  createdAt: Date
}

function mapMessage(row: MessageRow): DbMessage {
  return {
    id: row.id,
    chatId: row.chatId,
    sender: row.sender,
    senderName: row.senderName,
    text: row.text,
    messageType: row.messageType as DbMessage["messageType"],
    mediaUrl: row.mediaUrl || undefined,
    timestamp: toNumber(row.timestamp),
    createdAt: row.createdAt?.toISOString(),
  }
}

export class DatabaseService {
  // ============= MESSAGE OPERATIONS =============

  public async saveMessage(message: DbMessage): Promise<number> {
    const created = await prisma.message.create({
      data: {
        chatId: message.chatId,
        sender: message.sender,
        senderName: message.senderName,
        text: message.text,
        messageType: message.messageType || "text",
        mediaUrl: message.mediaUrl || null,
        timestamp: BigInt(message.timestamp),
      },
      select: { id: true },
    })
    return created.id
  }

  public async getMessages(chatId: string, limit: number = 50): Promise<DbMessage[]> {
    const rows = await prisma.message.findMany({
      where: { chatId },
      orderBy: { timestamp: "desc" },
      take: limit,
    })
    return rows.map(mapMessage)
  }

  public async getRecentMessages(chatId: string, windowMs: number): Promise<DbMessage[]> {
    const rows = await prisma.message.findMany({
      where: { chatId, timestamp: { gt: BigInt(Date.now() - windowMs) } },
      orderBy: { timestamp: "asc" },
    })
    return rows.map(mapMessage)
  }

  public async deleteMessagesByChat(chatId: string): Promise<number> {
    const result = await prisma.message.deleteMany({ where: { chatId } })
    return result.count
  }

  public async deleteAllMessages(): Promise<number> {
    const result = await prisma.message.deleteMany({})
    return result.count
  }

  public async searchMessages(query: string, limit: number = 100): Promise<DbMessage[]> {
    const rows = await prisma.message.findMany({
      // Case-insensitive substring search; Postgres can do this natively, which
      // SQLite's LIKE could not without extra collation setup.
      where: { text: { contains: query, mode: "insensitive" } },
      orderBy: { timestamp: "desc" },
      take: limit,
    })
    return rows.map(mapMessage)
  }

  public async getMessagesBySender(phoneNumber: string, limit: number = 20): Promise<DbMessage[]> {
    const rows = await prisma.message.findMany({
      where: { sender: phoneNumber },
      orderBy: { timestamp: "desc" },
      take: limit,
    })
    return rows.map(mapMessage)
  }

  // ============= USER OPERATIONS =============

  public async upsertUser(user: Omit<DbUser, "id" | "createdAt" | "updatedAt">): Promise<void> {
    await prisma.user.upsert({
      where: { phoneNumber: user.phoneNumber },
      create: {
        phoneNumber: user.phoneNumber,
        displayName: user.displayName || null,
        pushName: user.pushName || null,
        lastSeen: BigInt(user.lastSeen),
        firstSeen: BigInt(user.firstSeen),
        messageCount: user.messageCount || 0,
      },
      update: {
        // COALESCE semantics: a missing name must not erase a known one.
        ...(user.displayName ? { displayName: user.displayName } : {}),
        ...(user.pushName ? { pushName: user.pushName } : {}),
        lastSeen: BigInt(user.lastSeen),
        messageCount: { increment: 1 },
      },
    })
  }

  public async getUser(phoneNumber: string): Promise<DbUser | undefined> {
    const row = await prisma.user.findUnique({ where: { phoneNumber } })
    if (!row) return undefined
    return {
      id: row.id,
      phoneNumber: row.phoneNumber,
      displayName: row.displayName || undefined,
      pushName: row.pushName || undefined,
      lastSeen: toNumber(row.lastSeen),
      firstSeen: toNumber(row.firstSeen),
      messageCount: row.messageCount,
      createdAt: row.createdAt?.toISOString(),
      updatedAt: row.updatedAt?.toISOString(),
    }
  }

  public async getAllUsers(): Promise<DbUser[]> {
    const rows = await prisma.user.findMany({ orderBy: { lastSeen: "desc" } })
    return rows.map((row) => ({
      id: row.id,
      phoneNumber: row.phoneNumber,
      displayName: row.displayName || undefined,
      pushName: row.pushName || undefined,
      lastSeen: toNumber(row.lastSeen),
      firstSeen: toNumber(row.firstSeen),
      messageCount: row.messageCount,
    }))
  }

  /**
   * Look up many users at once. Used where a per-row lookup would otherwise be
   * an N+1 query (e.g. enriching a group's participant list).
   */
  public async getUsersByPhones(phoneNumbers: string[]): Promise<Map<string, DbUser>> {
    if (!phoneNumbers.length) return new Map()
    const rows = await prisma.user.findMany({
      where: { phoneNumber: { in: phoneNumbers } },
    })
    return new Map(
      rows.map((row) => [
        row.phoneNumber,
        {
          id: row.id,
          phoneNumber: row.phoneNumber,
          displayName: row.displayName || undefined,
          pushName: row.pushName || undefined,
          lastSeen: toNumber(row.lastSeen),
          firstSeen: toNumber(row.firstSeen),
          messageCount: row.messageCount,
        },
      ])
    )
  }

  public async getUserStats(): Promise<{ total: number; active: number }> {
    const [total, active] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { lastSeen: { gt: BigInt(Date.now() - 24 * 60 * 60 * 1000) } } }),
    ])
    return { total, active }
  }

  /**
   * Everyone the bot knows about, joined with real message activity.
   * `users.messageCount` is maintained by upserts and can drift, so counts come
   * from the messages table.
   */
  public async getUserDirectory(): Promise<
    Array<{
      phoneNumber: string
      displayName: string | null
      pushName: string | null
      firstSeen: number
      lastSeen: number
      messageCount: number
      chatCount: number
    }>
  > {
    const rows = await prisma.$queryRaw<
      Array<{
        phoneNumber: string
        displayName: string | null
        pushName: string | null
        firstSeen: bigint
        lastSeen: bigint
        messageCount: bigint
        chatCount: bigint
      }>
    >`
      SELECT u."phoneNumber", u."displayName", u."pushName", u."firstSeen", u."lastSeen",
             COALESCE(m."messageCount", 0) AS "messageCount",
             COALESCE(m."chatCount", 0) AS "chatCount"
      FROM users u
      LEFT JOIN (
        SELECT sender, COUNT(*) AS "messageCount", COUNT(DISTINCT "chatId") AS "chatCount"
        FROM messages WHERE sender <> 'Bot' GROUP BY sender
      ) m ON m.sender = u."phoneNumber"
      ORDER BY u."lastSeen" DESC
    `
    return rows.map((r) => ({
      phoneNumber: r.phoneNumber,
      displayName: r.displayName,
      pushName: r.pushName,
      firstSeen: toNumber(r.firstSeen),
      lastSeen: toNumber(r.lastSeen),
      messageCount: toNumber(r.messageCount),
      chatCount: toNumber(r.chatCount),
    }))
  }

  /** Which chats a person appears in, and how active they are in each. */
  public async getUserActivity(phoneNumber: string): Promise<{
    totalMessages: number
    firstMessage: number | null
    lastMessage: number | null
    chats: Array<{ chatId: string; chatName: string | null; isGroup: boolean; count: number }>
  }> {
    const totals = await prisma.message.aggregate({
      where: { sender: phoneNumber },
      _count: { _all: true },
      _min: { timestamp: true },
      _max: { timestamp: true },
    })

    const chats = await prisma.$queryRaw<
      Array<{ chatId: string; chatName: string | null; count: bigint }>
    >`
      SELECT m."chatId", c."chatName", COUNT(*) AS count
      FROM messages m
      LEFT JOIN conversations c ON c."chatId" = m."chatId"
      WHERE m.sender = ${phoneNumber}
      GROUP BY m."chatId", c."chatName"
      ORDER BY count DESC
    `

    return {
      totalMessages: totals._count._all,
      firstMessage: totals._min.timestamp ? toNumber(totals._min.timestamp) : null,
      lastMessage: totals._max.timestamp ? toNumber(totals._max.timestamp) : null,
      chats: chats.map((c) => ({
        chatId: c.chatId,
        chatName: c.chatName,
        isGroup: c.chatId.endsWith("@g.us"),
        count: toNumber(c.count),
      })),
    }
  }

  /** Distinct senders seen in a chat, with per-chat activity. */
  public async getChatParticipants(chatId: string): Promise<
    Array<{ sender: string; senderName: string; count: number; lastMessageAt: number }>
  > {
    const rows = await prisma.$queryRaw<
      Array<{ sender: string; senderName: string; count: bigint; lastMessageAt: bigint }>
    >`
      SELECT sender, MAX("senderName") AS "senderName", COUNT(*) AS count,
             MAX(timestamp) AS "lastMessageAt"
      FROM messages
      WHERE "chatId" = ${chatId} AND sender <> 'Bot'
      GROUP BY sender
      ORDER BY count DESC
    `
    return rows.map((r) => ({
      sender: r.sender,
      senderName: r.senderName,
      count: toNumber(r.count),
      lastMessageAt: toNumber(r.lastMessageAt),
    }))
  }

  // ============= CONVERSATION OPERATIONS =============

  public async upsertConversation(
    conv: Omit<DbConversation, "id" | "createdAt" | "updatedAt">
  ): Promise<void> {
    await prisma.conversation.upsert({
      where: { chatId: conv.chatId },
      create: {
        chatId: conv.chatId,
        chatName: conv.chatName || null,
        isGroup: Boolean(conv.isGroup),
        messageCount: conv.messageCount || 0,
        lastMessageAt: BigInt(conv.lastMessageAt),
      },
      update: {
        ...(conv.chatName ? { chatName: conv.chatName } : {}),
        messageCount: { increment: 1 },
        lastMessageAt: BigInt(conv.lastMessageAt),
      },
    })
  }

  public async getConversation(chatId: string): Promise<DbConversation | undefined> {
    const row = await prisma.conversation.findUnique({ where: { chatId } })
    if (!row) return undefined
    return {
      id: row.id,
      chatId: row.chatId,
      chatName: row.chatName || undefined,
      isGroup: row.isGroup,
      messageCount: row.messageCount,
      lastMessageAt: toNumber(row.lastMessageAt),
    }
  }

  public async getAllConversations(): Promise<DbConversation[]> {
    const rows = await prisma.conversation.findMany({ orderBy: { lastMessageAt: "desc" } })
    return rows.map((row) => ({
      id: row.id,
      chatId: row.chatId,
      chatName: row.chatName || undefined,
      isGroup: row.isGroup,
      messageCount: row.messageCount,
      lastMessageAt: toNumber(row.lastMessageAt),
    }))
  }

  // ============= ANALYTICS OPERATIONS =============

  /**
   * Accumulate counters for a date.
   *
   * `totalMessages`/`apiCalls`/`tokensUsed` add to what is there. `totalUsers`
   * and `totalConversations` are snapshots, only written when a value is
   * supplied — passing nothing leaves the stored value alone.
   */
  public async updateAnalytics(date: string, updates: Partial<DbAnalytics>): Promise<void> {
    const messages = updates.totalMessages ?? 0
    const apiCalls = updates.apiCalls ?? 0
    const tokens = updates.tokensUsed ?? 0
    const users = updates.totalUsers ?? null
    const conversations = updates.totalConversations ?? null

    await prisma.$executeRaw`
      INSERT INTO analytics (date, "totalMessages", "totalUsers", "totalConversations", "apiCalls", "tokensUsed")
      VALUES (${date}, ${messages}, COALESCE(${users}::int, 0), COALESCE(${conversations}::int, 0), ${apiCalls}, ${tokens})
      ON CONFLICT (date) DO UPDATE SET
        "totalMessages" = analytics."totalMessages" + ${messages},
        "totalUsers" = COALESCE(${users}::int, analytics."totalUsers"),
        "totalConversations" = COALESCE(${conversations}::int, analytics."totalConversations"),
        "apiCalls" = analytics."apiCalls" + ${apiCalls},
        "tokensUsed" = analytics."tokensUsed" + ${tokens}
    `
  }

  public async getAnalytics(startDate: string, endDate: string): Promise<DbAnalytics[]> {
    const rows = await prisma.analytics.findMany({
      where: { date: { gte: startDate, lte: endDate } },
      orderBy: { date: "desc" },
    })
    return rows.map((row) => ({
      id: row.id,
      date: row.date,
      totalMessages: row.totalMessages,
      totalUsers: row.totalUsers,
      totalConversations: row.totalConversations,
      apiCalls: row.apiCalls,
      tokensUsed: row.tokensUsed,
      createdAt: row.createdAt?.toISOString(),
    }))
  }

  public async getTodayStats(): Promise<DbAnalytics | undefined> {
    const today = new Date().toISOString().split("T")[0]
    const row = await prisma.analytics.findUnique({ where: { date: today } })
    if (!row) return undefined
    return {
      id: row.id,
      date: row.date,
      totalMessages: row.totalMessages,
      totalUsers: row.totalUsers,
      totalConversations: row.totalConversations,
      apiCalls: row.apiCalls,
      tokensUsed: row.tokensUsed,
    }
  }

  /** Most active senders in a window. The bot's own messages are excluded. */
  public async getTopUsers(
    since: number,
    limit: number = 8
  ): Promise<Array<{ sender: string; senderName: string; count: number }>> {
    const rows = await prisma.$queryRaw<
      Array<{ sender: string; senderName: string; count: bigint }>
    >`
      SELECT sender, MAX("senderName") AS "senderName", COUNT(*) AS count
      FROM messages
      WHERE timestamp >= ${BigInt(since)} AND sender <> 'Bot'
      GROUP BY sender
      ORDER BY count DESC
      LIMIT ${limit}
    `
    return rows.map((r) => ({
      sender: r.sender,
      senderName: r.senderName,
      count: toNumber(r.count),
    }))
  }

  public async getTopConversations(
    since: number,
    limit: number = 8
  ): Promise<Array<{ chatId: string; chatName: string | null; isGroup: boolean; count: number }>> {
    const rows = await prisma.$queryRaw<
      Array<{ chatId: string; chatName: string | null; count: bigint }>
    >`
      SELECT m."chatId", MAX(c."chatName") AS "chatName", COUNT(*) AS count
      FROM messages m
      LEFT JOIN conversations c ON c."chatId" = m."chatId"
      WHERE m.timestamp >= ${BigInt(since)}
      GROUP BY m."chatId"
      ORDER BY count DESC
      LIMIT ${limit}
    `
    return rows.map((r) => ({
      chatId: r.chatId,
      chatName: r.chatName,
      isGroup: r.chatId.endsWith("@g.us"),
      count: toNumber(r.count),
    }))
  }

  /**
   * Message volume by hour of day (0-23, server local time). Always returns all
   * 24 buckets so the chart has a stable x-axis.
   */
  public async getHourlyActivity(since: number): Promise<Array<{ hour: number; count: number }>> {
    const rows = await prisma.$queryRaw<Array<{ hour: number; count: bigint }>>`
      SELECT EXTRACT(HOUR FROM to_timestamp(timestamp / 1000.0))::int AS hour, COUNT(*) AS count
      FROM messages
      WHERE timestamp >= ${BigInt(since)}
      GROUP BY hour
    `
    const buckets = new Map(rows.map((r) => [Number(r.hour), toNumber(r.count)]))
    return Array.from({ length: 24 }, (_, hour) => ({ hour, count: buckets.get(hour) || 0 }))
  }

  /** Headline totals for a window, computed from messages so they stay consistent. */
  public async getRangeTotals(
    since: number,
    until: number = Date.now()
  ): Promise<{ messages: number; botMessages: number; activeUsers: number; activeChats: number }> {
    const [row] = await prisma.$queryRaw<
      Array<{
        messages: bigint
        botmessages: bigint
        activeusers: bigint
        activechats: bigint
      }>
    >`
      SELECT COUNT(*) AS messages,
             COUNT(*) FILTER (WHERE sender = 'Bot') AS botMessages,
             COUNT(DISTINCT sender) FILTER (WHERE sender <> 'Bot') AS activeUsers,
             COUNT(DISTINCT "chatId") AS activeChats
      FROM messages
      WHERE timestamp >= ${BigInt(since)} AND timestamp <= ${BigInt(until)}
    `
    return {
      messages: toNumber(row?.messages),
      botMessages: toNumber(row?.botmessages),
      activeUsers: toNumber(row?.activeusers),
      activeChats: toNumber(row?.activechats),
    }
  }

  // ============= ACCESS CONTROL =============

  private async addToList(
    list: "whitelist" | "blacklist",
    identifier: string,
    type: "contact" | "group",
    name?: string,
    reason?: string,
    addedBy?: string
  ): Promise<void> {
    await prisma.accessListEntry.upsert({
      where: { list_identifier: { list, identifier } },
      create: {
        list,
        identifier,
        type,
        name: name || null,
        reason: reason || null,
        addedBy: addedBy || null,
      },
      update: { type, name: name || null, reason: reason || null, addedBy: addedBy || null },
    })
  }

  public async addToWhitelist(
    identifier: string,
    type: "contact" | "group",
    name?: string,
    addedBy?: string
  ): Promise<void> {
    await this.addToList("whitelist", identifier, type, name, undefined, addedBy)
  }

  public async removeFromWhitelist(identifier: string): Promise<void> {
    await prisma.accessListEntry.deleteMany({ where: { list: "whitelist", identifier } })
  }

  public async getWhitelist(): Promise<
    Array<{ identifier: string; type: string; name?: string; createdAt: string }>
  > {
    const rows = await prisma.accessListEntry.findMany({
      where: { list: "whitelist" },
      orderBy: { createdAt: "desc" },
    })
    return rows.map((r) => ({
      identifier: r.identifier,
      type: r.type,
      name: r.name || undefined,
      createdAt: r.createdAt.toISOString(),
    }))
  }

  public async isWhitelisted(identifier: string): Promise<boolean> {
    const count = await prisma.accessListEntry.count({
      where: { list: "whitelist", identifier },
    })
    return count > 0
  }

  public async addToBlacklist(
    identifier: string,
    type: "contact" | "group",
    name?: string,
    reason?: string,
    addedBy?: string
  ): Promise<void> {
    await this.addToList("blacklist", identifier, type, name, reason, addedBy)
  }

  public async removeFromBlacklist(identifier: string): Promise<void> {
    await prisma.accessListEntry.deleteMany({ where: { list: "blacklist", identifier } })
  }

  public async getBlacklist(): Promise<
    Array<{ identifier: string; type: string; name?: string; reason?: string; createdAt: string }>
  > {
    const rows = await prisma.accessListEntry.findMany({
      where: { list: "blacklist" },
      orderBy: { createdAt: "desc" },
    })
    return rows.map((r) => ({
      identifier: r.identifier,
      type: r.type,
      name: r.name || undefined,
      reason: r.reason || undefined,
      createdAt: r.createdAt.toISOString(),
    }))
  }

  public async isBlacklisted(identifier: string): Promise<boolean> {
    const count = await prisma.accessListEntry.count({
      where: { list: "blacklist", identifier },
    })
    return count > 0
  }

  // ============= KNOWLEDGE BASE (RAG) =============

  public async getMessagesAfter(
    chatId: string,
    after: number,
    limit: number = 2000
  ): Promise<DbMessage[]> {
    const rows = await prisma.message.findMany({
      where: { chatId, timestamp: { gt: BigInt(after) } },
      orderBy: { timestamp: "asc" },
      take: limit,
    })
    return rows.map(mapMessage)
  }

  public async getIndexableChatIds(): Promise<string[]> {
    const rows = await prisma.message.findMany({
      distinct: ["chatId"],
      select: { chatId: true },
    })
    return rows.map((r) => r.chatId)
  }

  public async getLastIndexedTimestamp(chatId: string): Promise<number> {
    const row = await prisma.knowledgeState.findUnique({ where: { chatId } })
    return toNumber(row?.lastIndexedTimestamp)
  }

  public async setLastIndexedTimestamp(chatId: string, timestamp: number): Promise<void> {
    await prisma.knowledgeState.upsert({
      where: { chatId },
      create: { chatId, lastIndexedTimestamp: BigInt(timestamp) },
      update: { lastIndexedTimestamp: BigInt(timestamp) },
    })
  }

  /**
   * Insert embedded chunks. Written with raw SQL because the vector column has
   * no Prisma type; one statement per chunk inside a transaction.
   */
  public async insertKnowledgeChunks(
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
  ): Promise<void> {
    if (!chunks.length) return

    await prisma.$transaction(
      chunks.map(
        (chunk) => prisma.$executeRaw`
          INSERT INTO knowledge_chunks
            ("chatId", "chatName", "isGroup", text, "startTimestamp", "endTimestamp",
             "messageCount", model, dim, vector)
          VALUES (
            ${chunk.chatId},
            ${chunk.chatName || null},
            ${chunk.isGroup},
            ${chunk.text},
            ${BigInt(chunk.startTimestamp)},
            ${BigInt(chunk.endTimestamp)},
            ${chunk.messageCount},
            ${chunk.model},
            ${chunk.vector.length},
            ${toVectorLiteral(chunk.vector)}::vector
          )
        `
      )
    )
  }

  /**
   * Nearest chunks to `queryVector`, ranked by pgvector cosine distance.
   *
   * Vectors are stored L2-normalised, so cosine similarity is `1 - distance`,
   * which keeps the score identical in meaning to the previous dot-product
   * implementation — but computed in Postgres rather than by scanning every row
   * in JavaScript. `dim` is filtered so vectors from different embedding models
   * are never compared.
   */
  public async searchKnowledgeChunks(
    queryVector: number[],
    options: { chatId?: string; model: string; limit?: number; minScore?: number } = {
      model: "",
    }
  ): Promise<
    Array<{
      id: number
      chatId: string
      chatName: string | null
      text: string
      startTimestamp: number
      endTimestamp: number
      messageCount: number
      score: number
    }>
  > {
    const limit = options.limit || 5
    const minScore = options.minScore === undefined ? 0 : options.minScore
    // score = 1 - distance, so the score floor becomes a distance ceiling.
    const maxDistance = 1 - minScore
    const literal = toVectorLiteral(queryVector)

    const where = [
      Prisma.sql`model = ${options.model}`,
      Prisma.sql`dim = ${queryVector.length}`,
      Prisma.sql`vector IS NOT NULL`,
    ]
    if (options.chatId) where.push(Prisma.sql`"chatId" = ${options.chatId}`)

    const rows = await prisma.$queryRaw<
      Array<{
        id: number
        chatId: string
        chatName: string | null
        text: string
        startTimestamp: bigint
        endTimestamp: bigint
        messageCount: number
        distance: number
      }>
    >`
      SELECT id, "chatId", "chatName", text, "startTimestamp", "endTimestamp", "messageCount",
             (vector <=> ${literal}::vector) AS distance
      FROM knowledge_chunks
      WHERE ${Prisma.join(where, " AND ")}
        AND (vector <=> ${literal}::vector) <= ${maxDistance}
      ORDER BY distance ASC
      LIMIT ${limit}
    `

    return rows.map((r) => ({
      id: r.id,
      chatId: r.chatId,
      chatName: r.chatName,
      text: r.text,
      startTimestamp: toNumber(r.startTimestamp),
      endTimestamp: toNumber(r.endTimestamp),
      messageCount: r.messageCount,
      score: 1 - Number(r.distance),
    }))
  }

  public async getKnowledgeStats(): Promise<{
    chunks: number
    chats: number
    models: string[]
    oldest: number | null
    newest: number | null
  }> {
    const aggregate = await prisma.knowledgeChunk.aggregate({
      _count: { _all: true },
      _min: { startTimestamp: true },
      _max: { endTimestamp: true },
    })
    const [chats, models] = await Promise.all([
      prisma.knowledgeChunk.findMany({ distinct: ["chatId"], select: { chatId: true } }),
      prisma.knowledgeChunk.findMany({ distinct: ["model"], select: { model: true } }),
    ])
    return {
      chunks: aggregate._count._all,
      chats: chats.length,
      models: models.map((m) => m.model),
      oldest: aggregate._min.startTimestamp ? toNumber(aggregate._min.startTimestamp) : null,
      newest: aggregate._max.endTimestamp ? toNumber(aggregate._max.endTimestamp) : null,
    }
  }

  public async getKnowledgeChunkCount(chatId: string): Promise<number> {
    return prisma.knowledgeChunk.count({ where: { chatId } })
  }

  /** Clear the knowledge base (optionally for one chat) and reset watermarks. */
  public async clearKnowledge(chatId?: string): Promise<number> {
    if (chatId) {
      const [removed] = await prisma.$transaction([
        prisma.knowledgeChunk.deleteMany({ where: { chatId } }),
        prisma.knowledgeState.deleteMany({ where: { chatId } }),
      ])
      return removed.count
    }
    const [removed] = await prisma.$transaction([
      prisma.knowledgeChunk.deleteMany({}),
      prisma.knowledgeState.deleteMany({}),
    ])
    return removed.count
  }

  // ============= PER-CHAT SETTINGS =============

  public async getChatPersona(chatId: string): Promise<"assistant" | "companion" | null> {
    const row = await prisma.chatSetting.findUnique({ where: { chatId } })
    const value = row?.persona
    return value === "assistant" || value === "companion" ? value : null
  }

  public async setChatPersona(chatId: string, persona: "assistant" | "companion"): Promise<void> {
    await prisma.chatSetting.upsert({
      where: { chatId },
      create: { chatId, persona },
      update: { persona },
    })
  }

  public async clearChatPersona(chatId: string): Promise<void> {
    // Null the column rather than deleting the row: the row may also carry a
    // chattiness override, which clearing the persona should not discard.
    await prisma.chatSetting.updateMany({ where: { chatId }, data: { persona: null } })
  }

  public async setChatChattiness(chatId: string, chattiness: string | null): Promise<void> {
    await prisma.chatSetting.upsert({
      where: { chatId },
      create: { chatId, chattiness },
      update: { chattiness },
    })
  }

  public async getChatChattinessOverrides(): Promise<Record<string, string>> {
    const rows = await prisma.chatSetting.findMany({ where: { chattiness: { not: null } } })
    const out: Record<string, string> = {}
    for (const row of rows) if (row.chattiness) out[row.chatId] = row.chattiness
    return out
  }

  public async getChatPersonaOverrides(): Promise<Record<string, string>> {
    const rows = await prisma.chatSetting.findMany({ where: { persona: { not: null } } })
    const out: Record<string, string> = {}
    for (const row of rows) if (row.persona) out[row.chatId] = row.persona
    return out
  }

  // ============= UTILITY =============

  public async getStats(): Promise<{
    totalMessages: number
    totalUsers: number
    totalConversations: number
  }> {
    const [totalMessages, totalUsers, totalConversations] = await Promise.all([
      prisma.message.count(),
      prisma.user.count(),
      prisma.conversation.count(),
    ])
    return { totalMessages, totalUsers, totalConversations }
  }

  public async close(): Promise<void> {
    await prisma.$disconnect()
    logger.info("Database connection closed")
  }
}

export const databaseService = new DatabaseService()
