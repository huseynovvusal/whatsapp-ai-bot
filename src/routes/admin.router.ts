import express, { Request, Response } from "express"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { llmService } from "@/services/llm.service"
import { databaseService } from "@/services/database.service"
import { createLogger } from "@/lib/logger"
import { memoryService } from "@/services/memory.service"
import { whatsappService } from "@/services/whatsapp.service"
import { AuthMiddleware } from "@/middleware/auth.middleware"
import { ragService } from "@/services/rag.service"
import {
  personaService,
  PERSONA_LABELS,
  DEFAULT_ASSISTANT_PROMPT,
  DEFAULT_COMPANION_PROMPT,
} from "@/services/persona.service"
import { embeddingService } from "@/services/embedding.service"
import { AdminUtils } from "@/utils/admin.utils"
import { cleanPhoneNumber } from "@/utils/phone.utils"
import { config } from "@/config/env"

const router = express.Router()
const logger = createLogger(config.LOG_LEVEL, "AdminRouter")

// Public routes - no authentication required
router.post("/login", AuthMiddleware.login)
router.get("/auth-status", AuthMiddleware.checkAuth)

// Login page
router.get("/login", (_req: Request, res: Response) => {
  res.render("login")
})

// Protected routes - require authentication
router.use(AuthMiddleware.requireAuth)

router.post("/logout", AuthMiddleware.logout)

router.get("/", (_req: Request, res: Response) => {
  const cfg = runtimeConfig.getAll()
  const stats = databaseService.getStats()
  res.render("admin", { runtime: cfg, stats })
})

// API to return runtime config as JSON (useful for client)
router.get("/api", (_req: Request, res: Response) => {
  res.json(runtimeConfig.getAll())
})

// Return active conversations and message counts (includes all groups bot is in)
router.get("/api/conversations", async (_req: Request, res: Response) => {
  try {
    const all = memoryService.getAllMessages() as { [key: string]: any[] }
    const conversationMap = new Map<string, { id: string; count: number; name?: string }>()

    // Start from persisted conversations so the list survives a restart —
    // in-memory state alone would show nothing until new messages arrive.
    try {
      for (const conversation of databaseService.getAllConversations()) {
        conversationMap.set(conversation.chatId, {
          id: conversation.chatId,
          count: conversation.messageCount || 0,
          name: conversation.chatName || undefined,
        })
      }
    } catch (err) {
      logger.warn("Failed to load stored conversations", err)
    }

    // Then overlay live in-memory counts, which are what "clear memory" acts on
    for (const chatId of Object.keys(all || {})) {
      const count = (all[chatId] || []).length
      let name: string | undefined

      try {
        if (chatId.endsWith("@g.us")) {
          // For groups, fetch group name from WhatsApp
          name = await whatsappService.getGroupName(chatId)
        } else {
          // For contacts, try to get name from memory participants first
          const participants = memoryService.getParticipants(chatId)
          if (participants.length > 0) {
            // Get the non-Bot participant name
            const contact = participants.find((p) => p.name !== "Bot")
            if (contact) {
              name = contact.name
            }
          }

          // If still no name, try fetching from WhatsApp
          if (!name) {
            name = await whatsappService.getContactName(chatId)
          }
        }
      } catch (err) {
        // ignore
      }

      // Keep the stored name when WhatsApp could not resolve one.
      const existing = conversationMap.get(chatId)
      conversationMap.set(chatId, { id: chatId, count, name: name || existing?.name })
    }

    // Then, fetch ALL groups bot is in and add missing ones
    try {
      const allGroups = await whatsappService.getAllGroups()
      for (const group of allGroups) {
        if (!conversationMap.has(group.id)) {
          // Group exists but no messages in memory yet
          conversationMap.set(group.id, {
            id: group.id,
            count: 0,
            name: group.name,
          })
        }
      }
    } catch (err) {
      logger.warn("Failed to fetch all groups", err)
    }

    const list = Array.from(conversationMap.values())
    res.json({ conversations: list })
  } catch (err) {
    logger.error("Failed to get conversations", err)
    res.status(500).json({ error: "Failed to get conversations" })
  }
})

// Get database statistics
router.get("/api/stats", (_req: Request, res: Response) => {
  try {
    const stats = databaseService.getStats()
    const userStats = databaseService.getUserStats()
    const todayStats = databaseService.getTodayStats()

    res.json({
      ...stats,
      activeUsers: userStats.active,
      totalUsers: userStats.total,
      today: todayStats || { totalMessages: 0, apiCalls: 0, tokensUsed: 0 }
    })
  } catch (err) {
    logger.error("Failed to get stats", err)
    res.status(500).json({ error: "Failed to get stats" })
  }
})

// Get analytics data.
// Returns everything the Analytics tab renders, scoped to a single time window so
// every chart, stat and table on the page agrees with the others.
router.get("/api/analytics", (req: Request, res: Response) => {
  try {
    const requestedDays = Number(req.query.days)
    const days = [7, 30, 90].includes(requestedDays) ? requestedDays : 7

    const dayMs = 24 * 60 * 60 * 1000
    const now = Date.now()
    // Start at midnight `days - 1` days ago so a "7 days" range covers 7 calendar days
    // including today, which is what the day-by-day series shows.
    const start = new Date(now - (days - 1) * dayMs)
    start.setHours(0, 0, 0, 0)
    const since = start.getTime()
    // Equal-length preceding window, used for the stat-tile deltas.
    const prevSince = since - days * dayMs

    const toDate = (ms: number) => new Date(ms).toISOString().split("T")[0]
    const rows = databaseService.getAnalytics(toDate(since), toDate(now))
    const byDate = new Map(rows.map((r) => [r.date, r]))

    // Emit one point per day (zero-filled) so gaps in activity read as gaps
    // rather than silently collapsing the x-axis.
    const series = Array.from({ length: days }, (_, i) => {
      const date = toDate(since + i * dayMs)
      const row = byDate.get(date)
      return {
        date,
        totalMessages: row?.totalMessages || 0,
        apiCalls: row?.apiCalls || 0,
        tokensUsed: row?.tokensUsed || 0,
      }
    })

    const totals = databaseService.getRangeTotals(since, now)
    const previous = databaseService.getRangeTotals(prevSince, since - 1)

    res.json({
      days,
      range: { since, until: now },
      series,
      totals: {
        ...totals,
        apiCalls: series.reduce((sum, d) => sum + d.apiCalls, 0),
        tokensUsed: series.reduce((sum, d) => sum + d.tokensUsed, 0),
      },
      previous,
      topUsers: databaseService.getTopUsers(since, 8),
      topChats: databaseService.getTopConversations(since, 8),
      hourly: databaseService.getHourlyActivity(since),
      // Retained for backwards compatibility with any existing consumer.
      analytics: rows,
    })
  } catch (err) {
    logger.error("Failed to get analytics", err)
    res.status(500).json({ error: "Failed to get analytics" })
  }
})

// Search messages
router.get("/api/search", (req: Request, res: Response) => {
  try {
    const query = String(req.query.q || "")
    const limit = Number(req.query.limit) || 100

    if (!query) {
      return res.status(400).json({ error: "Query parameter 'q' is required" })
    }

    const messages = databaseService.searchMessages(query, limit)
    res.json({ messages, count: messages.length })
  } catch (err) {
    logger.error("Failed to search messages", err)
    res.status(500).json({ error: "Failed to search messages" })
  }
})

router.post("/clear", (req: Request, res: Response) => {
  const { chatId } = req.body || {}
  try {
    if (!chatId || chatId === "all") {
      memoryService.clear()
    } else {
      memoryService.clear(chatId)
    }
    return res.json({ success: true })
  } catch (err) {
    logger.error("Failed to clear memory via admin UI", err)
    return res.status(500).json({ success: false })
  }
})

router.post("/save", (req: Request, res: Response) => {
  const body = req.body || {}

  try {
    // Update runtime config keys if present
    if ("enablePrivateChat" in body)
      runtimeConfig.set("enablePrivateChat", Boolean(body.enablePrivateChat))
    if ("rateLimitMaxRequests" in body)
      runtimeConfig.set("rateLimitMaxRequests", Number(body.rateLimitMaxRequests))
    if ("rateLimitWindowMs" in body)
      runtimeConfig.set("rateLimitWindowMs", Number(body.rateLimitWindowMs))
    if ("botName" in body) runtimeConfig.set("botName", String(body.botName))
    if ("adminNumbers" in body)
      runtimeConfig.set(
        "adminNumbers",
        String(body.adminNumbers)
          .split(",")
          .map((s) => s.trim())
      )
    // Apply the system prompt through memoryService so it takes effect immediately
    // (memoryService.setSystemPrompt also persists it to runtime config).
    if ("systemPrompt" in body) memoryService.setSystemPrompt(String(body.systemPrompt))

    // Personality modes: each has its own prompt, so switching a chat's mode
    // swaps the whole voice without editing any text.
    if ("defaultPersona" in body && (body.defaultPersona === "assistant" || body.defaultPersona === "companion"))
      runtimeConfig.set("defaultPersona", body.defaultPersona)
    if ("assistantPrompt" in body) personaService.setPrompt("assistant", String(body.assistantPrompt))
    if ("companionPrompt" in body) personaService.setPrompt("companion", String(body.companionPrompt))
    if ("emojiReactions" in body) runtimeConfig.set("emojiReactions", Boolean(body.emojiReactions))
    if ("geminiApiKey" in body) runtimeConfig.set("geminiApiKey", String(body.geminiApiKey))
    if ("llmProvider" in body) runtimeConfig.set("llmProvider", String(body.llmProvider) as any)
    if ("openaiApiKey" in body) runtimeConfig.set("openaiApiKey", String(body.openaiApiKey))
    if ("openaiModel" in body) runtimeConfig.set("openaiModel", String(body.openaiModel))
    if ("openaiBaseUrl" in body) runtimeConfig.set("openaiBaseUrl", String(body.openaiBaseUrl))
    if ("respondToGroupMessages" in body)
      runtimeConfig.set("respondToGroupMessages", Boolean(body.respondToGroupMessages))
    if ("contextualGroupResponses" in body)
      runtimeConfig.set("contextualGroupResponses", Boolean(body.contextualGroupResponses))
    if ("accessControlMode" in body)
      runtimeConfig.set("accessControlMode", String(body.accessControlMode) as "disabled" | "whitelist" | "blacklist")

    // Memory limits. 0 is meaningful ("unlimited"), so these are clamped rather
    // than passed through `||`, which would turn 0 back into a default.
    const nonNegative = (value: unknown, fallback: number): number => {
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
    }
    if ("memoryMessageLimit" in body)
      runtimeConfig.set("memoryMessageLimit", nonNegative(body.memoryMessageLimit, 50))
    if ("memoryWindowMs" in body)
      runtimeConfig.set("memoryWindowMs", nonNegative(body.memoryWindowMs, 0))

    // Retrieval settings
    if ("ragEnabled" in body) runtimeConfig.set("ragEnabled", Boolean(body.ragEnabled))
    if ("ragCrossChat" in body) runtimeConfig.set("ragCrossChat", Boolean(body.ragCrossChat))
    if ("ragTopK" in body)
      runtimeConfig.set("ragTopK", Math.max(1, Math.min(20, nonNegative(body.ragTopK, 4))))
    if ("ragMinScore" in body)
      runtimeConfig.set("ragMinScore", Math.max(0, Math.min(1, nonNegative(body.ragMinScore, 0.3))))
    if ("embeddingModel" in body)
      runtimeConfig.set("embeddingModel", String(body.embeddingModel || "").trim())
    // If credentials or provider changed, reload the LLM and embedding clients
    if (
      "geminiApiKey" in body ||
      "openaiApiKey" in body ||
      "llmProvider" in body ||
      "openaiModel" in body ||
      "openaiBaseUrl" in body ||
      "embeddingModel" in body
    ) {
      try {
        llmService.reloadCredentials()
      } catch (err) {
        logger.warn("LLM reload failed", err)
      }
      try {
        embeddingService.reload()
      } catch (err) {
        logger.warn("Embedding reload failed", err)
      }
    }

    logger.info("Runtime configuration updated via admin UI")
    return res.json({ success: true })
  } catch (err) {
    logger.error("Error saving runtime config", err)
    return res.status(500).json({ success: false, error: "Failed to save runtime config" })
  }
})

// Bot Control API endpoint
router.post("/api/bot/toggle", (req: Request, res: Response) => {
  try {
    const { enabled } = req.body
    runtimeConfig.set("botEnabled", Boolean(enabled))
    logger.info(`Bot ${enabled ? 'enabled' : 'disabled'} via admin panel`)
    res.json({ success: true, enabled: Boolean(enabled) })
  } catch (err) {
    logger.error("Failed to toggle bot status", err)
    res.status(500).json({ error: "Failed to toggle bot status" })
  }
})

router.get("/api/bot/status", (_req: Request, res: Response) => {
  try {
    const enabled = runtimeConfig.get("botEnabled") as boolean || false
    res.json({ enabled })
  } catch (err) {
    logger.error("Failed to get bot status", err)
    res.status(500).json({ error: "Failed to get bot status" })
  }
})

// ============= PERSONALITY MODES =============

router.get("/api/personas", (_req: Request, res: Response) => {
  try {
    res.json({
      defaultPersona: personaService.getDefaultPersona(),
      labels: PERSONA_LABELS,
      prompts: {
        assistant: personaService.getPrompt("assistant"),
        companion: personaService.getPrompt("companion"),
      },
      defaults: {
        assistant: DEFAULT_ASSISTANT_PROMPT,
        companion: DEFAULT_COMPANION_PROMPT,
      },
      overrides: databaseService.getChatPersonaOverrides(),
    })
  } catch (err) {
    logger.error("Failed to get personas", err)
    res.status(500).json({ error: "Failed to get personas" })
  }
})

// Set (or clear, with persona: null) a single chat's mode.
router.post("/api/chats/:chatId/persona", (req: Request, res: Response) => {
  try {
    const chatId = decodeURIComponent(String(req.params.chatId))
    const requested = req.body?.persona
    if (requested === null || requested === "" || requested === "default") {
      personaService.setPersonaForChat(chatId, null)
      return res.json({ success: true, persona: null })
    }
    if (requested !== "assistant" && requested !== "companion") {
      return res.status(400).json({ error: "persona must be 'assistant', 'companion' or null" })
    }
    personaService.setPersonaForChat(chatId, requested)
    res.json({ success: true, persona: requested })
  } catch (err) {
    logger.error("Failed to set chat persona", err)
    res.status(500).json({ error: "Failed to set chat persona" })
  }
})

// ============= KNOWLEDGE BASE (RAG) =============

router.get("/api/knowledge/status", (_req: Request, res: Response) => {
  try {
    res.json({ ...ragService.getStatus(), stats: databaseService.getKnowledgeStats() })
  } catch (err) {
    logger.error("Failed to get knowledge status", err)
    res.status(500).json({ error: "Failed to get knowledge status" })
  }
})

// Index any messages that have arrived since the last run.
router.post("/api/knowledge/index", async (_req: Request, res: Response) => {
  try {
    const result = await ragService.indexNewMessages({ force: true })
    res.json({ success: !result.skipped, ...result })
  } catch (err) {
    logger.error("Indexing failed", err)
    res.status(500).json({ error: "Indexing failed" })
  }
})

// Rebuild from scratch — needed after changing embedding model or chunking.
router.post("/api/knowledge/reindex", async (req: Request, res: Response) => {
  try {
    const chatId = req.body?.chatId ? String(req.body.chatId) : undefined
    const result = await ragService.reindexAll(chatId)
    res.json({ success: true, ...result })
  } catch (err) {
    logger.error("Reindex failed", err)
    res.status(500).json({ error: "Reindex failed" })
  }
})

router.delete("/api/knowledge", (req: Request, res: Response) => {
  try {
    const chatId = req.query.chatId ? String(req.query.chatId) : undefined
    const removed = databaseService.clearKnowledge(chatId)
    res.json({ success: true, removed })
  } catch (err) {
    logger.error("Failed to clear knowledge base", err)
    res.status(500).json({ error: "Failed to clear knowledge base" })
  }
})

// Try a retrieval query without sending a WhatsApp message — lets an operator
// see exactly what the bot would recall for a given question.
router.get("/api/knowledge/search", async (req: Request, res: Response) => {
  try {
    const query = String(req.query.q || "").trim()
    if (!query) return res.status(400).json({ error: "Query parameter 'q' is required" })
    const chatId = req.query.chatId ? String(req.query.chatId) : ""
    const results = await ragService.retrieve(query, chatId, {
      limit: Number(req.query.limit) || 8,
      minScore: req.query.minScore !== undefined ? Number(req.query.minScore) : 0,
    })
    res.json({ query, results })
  } catch (err) {
    logger.error("Knowledge search failed", err)
    res.status(500).json({ error: "Knowledge search failed" })
  }
})

// ============= PEOPLE / IDENTITY =============

// The bot's own account.
router.get("/api/me", (_req: Request, res: Response) => {
  try {
    res.json(whatsappService.getOwnIdentity())
  } catch (err) {
    logger.error("Failed to get own identity", err)
    res.status(500).json({ error: "Failed to get own identity" })
  }
})

// Everyone the bot knows about, with activity figures.
router.get("/api/users", (_req: Request, res: Response) => {
  try {
    res.json({ users: databaseService.getUserDirectory() })
  } catch (err) {
    logger.error("Failed to list users", err)
    res.status(500).json({ error: "Failed to list users" })
  }
})

// Full detail for one person, including which chats they appear in.
router.get("/api/users/:phone", (req: Request, res: Response) => {
  try {
    // Accept the number in either shape ("+99412..." or "99412...") — historical
    // rows may predate normalisation.
    const raw = decodeURIComponent(String(req.params.phone))
    const normalised = cleanPhoneNumber(raw)
    let phone = normalised
    let user = databaseService.getUser(phone)
    let activity = databaseService.getUserActivity(phone)
    if (!user && !activity.chats.length && raw !== normalised) {
      phone = raw
      user = databaseService.getUser(phone)
      activity = databaseService.getUserActivity(phone)
    }
    if (!user && !activity.chats.length) {
      return res.status(404).json({ error: "User not found" })
    }
    res.json({
      profile: {
        phoneNumber: phone,
        displayName: user?.displayName || null,
        pushName: user?.pushName || null,
        firstSeen: user?.firstSeen || activity.firstMessage,
        lastSeen: user?.lastSeen || activity.lastMessage,
        isAdmin: AdminUtils.isAdmin(phone),
      },
      activity,
      recentMessages: databaseService.getMessagesBySender(phone, 20),
    })
  } catch (err) {
    logger.error("Failed to get user detail", err)
    res.status(500).json({ error: "Failed to get user detail" })
  }
})

// Participants of a chat. For groups this comes from WhatsApp (so it includes
// people who have not spoken yet, plus admin roles); everyone is then enriched
// with what the database knows about them.
router.get("/api/chats/:chatId/participants", async (req: Request, res: Response) => {
  try {
    const chatId = decodeURIComponent(String(req.params.chatId))
    const isGroup = chatId.endsWith("@g.us")

    let participants: Array<{ phone: string; name?: string; isAdmin: boolean }> = []
    if (isGroup) {
      const fromWhatsApp = await whatsappService.getGroupParticipants(chatId)
      participants = fromWhatsApp.map((p) => ({
        phone: p.phone,
        name: p.name,
        isAdmin: p.isAdmin,
      }))
    }

    // Fall back to (or supplement with) senders seen in this chat.
    const seen = databaseService.getChatParticipants(chatId)
    for (const person of seen) {
      if (!participants.find((p) => p.phone === person.sender)) {
        participants.push({ phone: person.sender, name: person.senderName, isAdmin: false })
      }
    }

    const enriched = participants.map((p) => {
      const user = databaseService.getUser(p.phone)
      const stats = seen.find((s) => s.sender === p.phone)
      return {
        phone: p.phone,
        name: p.name || user?.displayName || user?.pushName || stats?.senderName || null,
        pushName: user?.pushName || null,
        isGroupAdmin: p.isAdmin,
        isBotAdmin: AdminUtils.isAdmin(p.phone),
        messageCount: stats?.count || 0,
        lastMessageAt: stats?.lastMessageAt || null,
      }
    })

    let groupInfo = null
    if (isGroup) {
      const meta = await whatsappService.getGroupInfo(chatId)
      if (meta) {
        groupInfo = {
          subject: meta.subject || null,
          owner: cleanPhoneNumber(meta.owner || ""),
          participantCount: meta.participantCount || enriched.length,
        }
      }
    }

    res.json({ chatId, isGroup, groupInfo, participants: enriched })
  } catch (err) {
    logger.error("Failed to get chat participants", err)
    res.status(500).json({ error: "Failed to get chat participants" })
  }
})

// Access Control API endpoints
router.get("/api/whitelist", (_req: Request, res: Response) => {
  try {
    const whitelist = databaseService.getWhitelist()
    res.json({ whitelist })
  } catch (err) {
    logger.error("Failed to get whitelist", err)
    res.status(500).json({ error: "Failed to get whitelist" })
  }
})

router.post("/api/whitelist", (req: Request, res: Response) => {
  try {
    const { identifier, type, name } = req.body
    if (!identifier || !type) {
      return res.status(400).json({ error: "identifier and type are required" })
    }
    databaseService.addToWhitelist(identifier, type, name, "admin")
    res.json({ success: true })
  } catch (err) {
    logger.error("Failed to add to whitelist", err)
    res.status(500).json({ error: "Failed to add to whitelist" })
  }
})

router.delete("/api/whitelist/:identifier", (req: Request, res: Response) => {
  try {
    const identifier = String(req.params.identifier)
    databaseService.removeFromWhitelist(decodeURIComponent(identifier))
    res.json({ success: true })
  } catch (err) {
    logger.error("Failed to remove from whitelist", err)
    res.status(500).json({ error: "Failed to remove from whitelist" })
  }
})

router.get("/api/blacklist", (_req: Request, res: Response) => {
  try {
    const blacklist = databaseService.getBlacklist()
    res.json({ blacklist })
  } catch (err) {
    logger.error("Failed to get blacklist", err)
    res.status(500).json({ error: "Failed to get blacklist" })
  }
})

router.post("/api/blacklist", (req: Request, res: Response) => {
  try {
    const { identifier, type, name, reason } = req.body
    if (!identifier || !type) {
      return res.status(400).json({ error: "identifier and type are required" })
    }
    databaseService.addToBlacklist(identifier, type, name, reason, "admin")
    res.json({ success: true })
  } catch (err) {
    logger.error("Failed to add to blacklist", err)
    res.status(500).json({ error: "Failed to add to blacklist" })
  }
})

router.delete("/api/blacklist/:identifier", (req: Request, res: Response) => {
  try {
    const identifier = String(req.params.identifier)
    databaseService.removeFromBlacklist(decodeURIComponent(identifier))
    res.json({ success: true })
  } catch (err) {
    logger.error("Failed to remove from blacklist", err)
    res.status(500).json({ error: "Failed to remove from blacklist" })
  }
})

export default router
