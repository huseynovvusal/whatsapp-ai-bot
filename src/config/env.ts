import dotenv from "dotenv"
import path from "path"

const NODE_ENV = process.env.NODE_ENV || "development"

// Load .env file from project root
dotenv.config({
  path: path.join(__dirname, "../../.env"),
})

export class Config {
  public NODE_ENV: string
  public PORT: number
  public LOG_LEVEL: string

  // WhatsApp Bot Config
  public BOT_NAME: string
  public ADMIN_NUMBERS: string[]

  // LLM Config
  public LLM_PROVIDER: "openai" | "gemini"
  public OPENAI_API_KEY?: string
  public OPENAI_MODEL?: string
  public GEMINI_API_KEY?: string
  public GEMINI_MODEL?: string

  // Memory Config
  /** Short-term memory retention in ms. 0 disables expiry entirely. */
  public MEMORY_WINDOW_MS: number
  /** Messages kept per chat in short-term memory. 0 means unlimited. */
  public MEMORY_MESSAGE_LIMIT: number
  public SYSTEM_PROMPT: string
  // Private chat control
  public ENABLE_PRIVATE_CHAT: boolean

  // Access Control
  public ACCESS_CONTROL_MODE: "disabled" | "whitelist" | "blacklist"

  // Rate Limiting Config
  public RATE_LIMIT_MAX_REQUESTS: number
  public RATE_LIMIT_WINDOW_MS: number

  constructor() {
    if (!process.env.NODE_ENV || !process.env.PORT || !process.env.LOG_LEVEL) {
      throw new Error("Missing required environment variables")
    }

    this.NODE_ENV = process.env.NODE_ENV
    this.PORT = Number(process.env.PORT)
    this.LOG_LEVEL = process.env.LOG_LEVEL

    // WhatsApp Bot
    this.BOT_NAME = process.env.BOT_NAME || "@bot"
    this.ADMIN_NUMBERS = process.env.ADMIN_NUMBERS?.split(",") || []

    // LLM Config
    this.LLM_PROVIDER = (process.env.LLM_PROVIDER as "openai" | "gemini") || "openai"
    // this.OPENAI_API_KEY = process.env.OPENAI_API_KEY
    // this.OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"
    this.GEMINI_API_KEY = process.env.GEMINI_API_KEY
    this.GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash"

    // Memory
    // `|| default` would turn an explicit 0 ("unlimited") back into the default,
    // so these are parsed so that 0 survives.
    const numberOr = (raw: string | undefined, fallback: number): number => {
      if (raw === undefined || raw.trim() === "") return fallback
      const parsed = Number(raw)
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
    }
    this.MEMORY_WINDOW_MS = numberOr(process.env.MEMORY_WINDOW_MS, 24 * 60 * 60 * 1000)
    this.MEMORY_MESSAGE_LIMIT = numberOr(process.env.MEMORY_MESSAGE_LIMIT, 50)
    this.SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "You are a helpful AI assistant."

    // Rate Limiting
    this.RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 2
    this.RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000 // 1 minute
    // Private chat: enabled by default
    this.ENABLE_PRIVATE_CHAT = process.env.ENABLE_PRIVATE_CHAT !== "false"
    // Access Control: disabled by default
    this.ACCESS_CONTROL_MODE = (process.env.ACCESS_CONTROL_MODE as "disabled" | "whitelist" | "blacklist") || "disabled"

    // Validate LLM credentials
    // if (this.LLM_PROVIDER === "openai" && !this.OPENAI_API_KEY) {
    //   throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER is openai")
    // }
    if (this.LLM_PROVIDER === "gemini" && !this.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is required when LLM_PROVIDER is gemini")
    }
  }
}

export const config = new Config()
