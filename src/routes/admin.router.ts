import express, { Request, Response } from "express"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { llmService } from "@/services/llm.service"
import { createLogger } from "@/lib/logger"
import { memoryService } from "@/services/memory.service"
import { whatsappService } from "@/services/whatsapp.service"
import { config } from "@/config/env"

const router = express.Router()
const logger = createLogger(config.LOG_LEVEL, "AdminRouter")

router.get("/", (_req: Request, res: Response) => {
  const cfg = runtimeConfig.getAll()
  res.render("admin", { runtime: cfg })
})

// API to return runtime config as JSON (useful for client)
router.get("/api", (_req: Request, res: Response) => {
  res.json(runtimeConfig.getAll())
})

// Return active conversations and message counts
router.get("/api/conversations", async (_req: Request, res: Response) => {
  const all = memoryService.getAllMessages() as { [key: string]: any[] }
  const keys = Object.keys(all || {})
  // Fetch group names for groups to enhance admin UI
  const list = await Promise.all(
    keys.map(async (k) => {
      const count = (all[k] || []).length
      let name: string | undefined
      try {
        if (k.endsWith("@g.us")) name = await whatsappService.getGroupName(k)
      } catch (err) {
        // ignore
      }
      return { id: k, count, name }
    })
  )
  res.json({ conversations: list })
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
    if ("systemPrompt" in body) runtimeConfig.set("systemPrompt", String(body.systemPrompt))
    if ("geminiApiKey" in body) runtimeConfig.set("geminiApiKey", String(body.geminiApiKey))
    if ("respondToGroupMessages" in body)
      runtimeConfig.set("respondToGroupMessages", Boolean(body.respondToGroupMessages))
    // If API key updated, reload LLM credentials
    if ("geminiApiKey" in body) {
      try {
        llmService.reloadCredentials()
      } catch (err) {
        logger.warn("LLM reload failed", err)
      }
    }

    logger.info("Runtime configuration updated via admin UI")
    return res.json({ success: true })
  } catch (err) {
    logger.error("Error saving runtime config", err)
    return res.status(500).json({ success: false, error: "Failed to save runtime config" })
  }
})

export default router
