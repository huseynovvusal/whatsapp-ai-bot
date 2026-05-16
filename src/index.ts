import express, { Request, Response } from "express"
import session from "express-session"
import { createServer } from "http"
import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"
import { whatsappService } from "@/services/whatsapp.service"
import { messageHandler } from "@/handlers/message.handler"
import { wsService } from "@/services/websocket.service"

const logger = createLogger(config.LOG_LEVEL, "Main")

async function main() {
  try {
    logger.info("🚀 Starting WhatsApp Group AI Bot...")

    // Start Express server + Views
    const app = express()
    app.set("view engine", "ejs")
    app.set("views", "./views")
    app.use("/static", express.static("public"))
    app.use(express.json())
    app.use(express.urlencoded({ extended: true }))

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
process.on("SIGINT", () => {
  logger.info("Received SIGINT. Shutting down gracefully...")
  process.exit(0)
})

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM. Shutting down gracefully...")
  process.exit(0)
})

// Start the bot
main()
