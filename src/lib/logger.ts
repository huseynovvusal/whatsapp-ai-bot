import winston, { Logger } from "winston"
import Transport from "winston-transport"
import { wsService, type LogLevel } from "@/services/websocket.service"

/**
 * Map a winston log level to the level vocabulary used by the admin Logs tab.
 */
function mapLevel(level: string): LogLevel {
  switch (level) {
    case "error":
      return "error"
    case "warn":
      return "warn"
    case "debug":
    case "verbose":
    case "silly":
      return "debug"
    default:
      return "info"
  }
}

/**
 * Custom winston transport that forwards every application log to the admin
 * dashboard over WebSocket. This makes the Logs tab reflect real activity from
 * all services instead of only a handful of manually-instrumented messages.
 *
 * `pushLog` is a no-op until at least one admin client is connected, so this is
 * safe to use even before the WebSocket server is initialized.
 */
class WebSocketTransport extends Transport {
  log(info: Record<string, unknown>, callback: () => void): void {
    setImmediate(() => this.emit("logged", info))

    try {
      const level = mapLevel(String(info.level))
      const rawMessage = info.message
      const message =
        typeof rawMessage === "string" ? rawMessage : JSON.stringify(rawMessage)
      const source = typeof info.service === "string" ? info.service : undefined
      wsService.pushLog(level, message, source)
    } catch {
      // Never let logging failures break the application.
    }

    callback()
  }
}

// Shared WebSocket transport instance. Only INFO and above are streamed to keep
// the admin Logs tab readable (debug noise stays in the console/file logs).
const webSocketTransport = new WebSocketTransport({ level: "info" })
// Every createLogger() call pipes another logger into this single transport, and
// winston attaches its own listeners each time. The app has more services than
// Node's default cap of 10, which would otherwise emit a spurious
// MaxListenersExceededWarning on startup. 0 disables the cap.
webSocketTransport.setMaxListeners(0)

function createLogger(level: string, serviceName: string): Logger {
  const logger = winston.createLogger({
    level: level,
    defaultMeta: {
      service: serviceName,
    },
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp(),
          winston.format.printf(({ timestamp, level, message, service }) => {
            const source = service ? `[${service}] ` : ""
            return `${timestamp} [${level}]: ${source}${message}`
          })
        ),
      }),
      new winston.transports.File({
        format: winston.format.combine(winston.format.json(), winston.format.timestamp()),
        filename: "logs/combined.log",
      }),
      new winston.transports.File({
        format: winston.format.combine(winston.format.json(), winston.format.timestamp()),
        filename: "logs/error.log",
        level: "error",
      }),
      webSocketTransport,
    ],
  })

  return logger
}

export { createLogger }
