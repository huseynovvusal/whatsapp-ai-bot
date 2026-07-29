import express, { Request, Response } from "express"
import session from "express-session"
import { createServer } from "http"
import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"
import { whatsappService } from "@/services/whatsapp.service"
import { messageHandler } from "@/handlers/message.handler"
import { wsService } from "@/services/websocket.service"
import { ragService } from "@/services/rag.service"
import { personaService } from "@/services/persona.service"
import { connectDatabase, disconnectDatabase } from "@/lib/prisma"

const logger = createLogger(config.LOG_LEVEL, "Main")

async function main() {
  try {
    logger.info("🚀 Starting WhatsApp Group AI Bot...")

    // Fail fast on a bad DATABASE_URL rather than on the first message.
    await connectDatabase()
    // Personality overrides are read synchronously on the hot path, so the
    // cache is warmed before any message can arrive.
    await personaService.load()

    // Start Express server + Views
    const app = express()
    app.set("view engine", "ejs")
    app.set("views", "./views")
    app.use("/static", express.static("public"))
    app.use(express.json())
    app.use(express.urlencoded({ extended: true }))

    // A predictable session secret lets anyone forge an admin cookie, so the
    // default is refused in production rather than used silently.
    if (!process.env.SESSION_SECRET) {
      const msg = "SESSION_SECRET is not set — admin sessions can be forged."
      if (process.env.NODE_ENV === "production") {
        throw new Error(`${msg} Refusing to start in production.`)
      }
      logger.warn(`⚠️  ${msg} Set it before deploying.`)
    }

    // Session middleware for authentication
    app.use(
      session({
        secret: process.env.SESSION_SECRET || "whatsapp-bot-secret-change-in-production",
        resave: false,
        saveUninitialized: false,
        cookie: {
          maxAge: 24 * 60 * 60 * 1000, // 24 hours
          httpOnly: true,
          secure: process.env.NODE_ENV === "production", // HTTPS only in production
        },
      })
    )

    app.get("/health", (_req: Request, res: Response) => {
      res.json({
        status: "healthy",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      })
    })

    // Create HTTP server and initialize WebSocket
    const server = createServer(app)
    wsService.initialize(server)

    server.listen(config.PORT, () => {
      logger.info(`✅ Server running on port ${config.PORT}`)
      wsService.log("success", `Server started on port ${config.PORT}`, "System")
    })

    // Admin UI router - load only when available
    try {
      const adminRouter = (await import("./routes/admin.router")).default
      app.use("/", adminRouter)
      logger.info("✅ Admin UI mounted at /")
    } catch (err) {
      logger.warn("Admin UI router not loaded", err)
    }

    // Keep the knowledge base current in the background so the bot can recall
    // older conversations (see src/services/rag.service.ts)
    ragService.startBackgroundIndexing()

    // Set up message handler
    whatsappService.onMessage(async (info) => {
      await messageHandler.handle(info)
    })

    // Connect to WhatsApp
    await whatsappService.connect()

    logger.info("✅ Bot is ready and listening for messages!")
  } catch (error) {
    logger.error("❌ Fatal error starting bot:", error)
    process.exit(1)
  }
}

// Handle graceful shutdown
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}. Shutting down gracefully...`)
  try {
    await disconnectDatabase()
  } catch (err) {
    logger.warn("Error closing the database connection", err)
  }
  process.exit(0)
}

process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))

// Start the bot
main()
