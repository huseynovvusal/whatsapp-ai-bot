import dotenv from "dotenv"
import path from "path"

const NODE_ENV = process.env.NODE_ENV || "development"

console.log(path.join(__dirname, `../.env${NODE_ENV === "development" ? ".development" : ""}`))

dotenv.config({
  quiet: true,
  path: path.join(__dirname, `../../.env${NODE_ENV === "development" ? ".development" : ""}`),
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
  public MEMORY_WINDOW_MS: number
  public SYSTEM_PROMPT: string
  // Private chat control
  public ENABLE_PRIVATE_CHAT: boolean

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
    this.MEMORY_WINDOW_MS = Number(process.env.MEMORY_WINDOW_MS) || 3600000
    this.SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "You are a helpful AI assistant."

    // Rate Limiting
    this.RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 2
    this.RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000 // 1 minute
    // Private chat: enabled by default
    this.ENABLE_PRIVATE_CHAT = process.env.ENABLE_PRIVATE_CHAT !== "false"

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
