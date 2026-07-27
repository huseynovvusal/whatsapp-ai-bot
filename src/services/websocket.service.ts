import { WebSocketServer, WebSocket } from "ws"
import { Server } from "http"
import QRCode from "qrcode"

export type LogLevel = "info" | "warn" | "error" | "success" | "debug"

export interface LogMessage {
  level: LogLevel
  message: string
  timestamp: number
  source?: string
}

export interface QRCodeData {
  qr: string // Base64 encoded QR code image
  timestamp: number
}

export interface ConnectionStatus {
  connected: boolean
  phoneNumber?: string
  timestamp: number
}

export class WebSocketService {
  private static instance: WebSocketService
  private wss: WebSocketServer | null = null
  private clients: Set<WebSocket> = new Set()
  private lastQRCode: string | null = null
  private lastConnectionStatus: ConnectionStatus = { connected: false, timestamp: Date.now() }

  private constructor() {}

  public static getInstance(): WebSocketService {
    if (!WebSocketService.instance) {
      WebSocketService.instance = new WebSocketService()
    }
    return WebSocketService.instance
  }

  public initialize(server: Server): void {
    this.wss = new WebSocketServer({
      server,
      path: "/ws"
    })

    this.wss.on("connection", (ws: WebSocket) => {
      this.clients.add(ws)
      this.log("info", "Admin connected to WebSocket", "WebSocket")

      // Send last connection status to new client
      ws.send(JSON.stringify({
        type: "connection",
        data: this.lastConnectionStatus
      }))

      // Send last QR code if available and not connected
      if (this.lastQRCode && !this.lastConnectionStatus.connected) {
        ws.send(JSON.stringify({
          type: "qr",
          data: {
            qr: this.lastQRCode,
            timestamp: Date.now()
          }
        }))
      }

      ws.on("close", () => {
        this.clients.delete(ws)
        this.log("info", "Admin disconnected from WebSocket", "WebSocket")
      })

      ws.on("error", (error) => {
        console.error("WebSocket error:", error)
        this.clients.delete(ws)
      })
    })

    this.log("success", "WebSocket server initialized on /ws", "WebSocket")
  }

  /**
   * Stream a log entry to connected admin clients only (no console output).
   * Used by the winston transport bridge so all application logs appear in the
   * admin Logs tab without duplicating console output.
   */
  public pushLog(level: LogLevel, message: string, source?: string): void {
    if (this.clients.size === 0) return
    this.broadcast({
      type: "log",
      data: { level, message, timestamp: Date.now(), source } as LogMessage,
    })
  }

  public log(level: LogLevel, message: string, source?: string): void {
    const logMessage: LogMessage = {
      level,
      message,
      timestamp: Date.now(),
      source
    }

    // Send to all connected WebSocket clients
    this.broadcast({
      type: "log",
      data: logMessage
    })

    // Also log to console with color
    const colors = {
      info: "\x1b[36m",    // Cyan
      warn: "\x1b[33m",    // Yellow
      error: "\x1b[31m",   // Red
      success: "\x1b[32m", // Green
      debug: "\x1b[90m"    // Gray
    }
    const reset = "\x1b[0m"
    const sourcePrefix = source ? `[${source}] ` : ""
    console.log(`${colors[level]}[${level.toUpperCase()}] ${sourcePrefix}${message}${reset}`)
  }

  public async sendQRCode(qr: string): Promise<void> {
    try {
      // Generate base64 QR code image
      const qrImage = await QRCode.toDataURL(qr, {
        width: 400,
        margin: 2,
        color: {
          dark: "#000000",
          light: "#FFFFFF"
        }
      })

      // Store last QR code
      this.lastQRCode = qrImage

      const qrData: QRCodeData = {
        qr: qrImage,
        timestamp: Date.now()
      }

      this.broadcast({
        type: "qr",
        data: qrData
      })

      this.log("info", "QR code generated and sent to admin panel", "WhatsApp")
    } catch (error) {
      this.log("error", `Failed to generate QR code: ${error}`, "WhatsApp")
    }
  }

  public sendConnectionStatus(connected: boolean = false, phoneNumber?: string): void {
    const status: ConnectionStatus = {
      connected,
      phoneNumber,
      timestamp: Date.now()
    }

    // Store last connection status
    this.lastConnectionStatus = status

    // Clear QR code when connected
    if (connected) {
      this.lastQRCode = null
    }

    this.broadcast({
      type: "connection",
      data: status
    })

    if (connected && phoneNumber) {
      this.log("success", `WhatsApp connected: ${phoneNumber}`, "WhatsApp")
    } else if (!connected) {
      this.log("warn", "WhatsApp disconnected", "WhatsApp")
    }
  }

  private broadcast(message: Record<string, unknown>): void {
    const payload = JSON.stringify(message)

    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload)
      }
    })
  }

  public getClientCount(): number {
    return this.clients.size
  }

  public close(): void {
    this.clients.forEach((client) => {
      client.close()
    })
    this.clients.clear()

    if (this.wss) {
      this.wss.close()
    }
  }
}

export const wsService = WebSocketService.getInstance()
