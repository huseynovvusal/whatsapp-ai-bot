import fs from "fs"
import path from "path"
import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"

const logger = createLogger(config.LOG_LEVEL, "RuntimeConfig")

export interface RuntimeConfigSchema {
  botEnabled?: boolean
  enablePrivateChat?: boolean
  rateLimitMaxRequests?: number
  rateLimitWindowMs?: number
  botName?: string
  adminNumbers?: string[]
  systemPrompt?: string
  geminiApiKey?: string
  // LLM provider and OpenAI settings
  llmProvider?: "openai" | "gemini"
  openaiApiKey?: string
  openaiModel?: string
  openaiBaseUrl?: string
  respondToGroupMessages?: boolean
  contextualGroupResponses?: boolean
  accessControlMode?: "disabled" | "whitelist" | "blacklist"
  // Short-term memory. 0 means "no limit" for both of these.
  /** Messages of recent history kept per chat. 0 = unlimited. */
  memoryMessageLimit?: number
  /** How long a message stays in short-term memory, ms. 0 = never expires. */
  memoryWindowMs?: number
  // Retrieval-Augmented Generation (long-term memory)
  ragEnabled?: boolean
  /** How many remembered chunks to pull into context. */
  ragTopK?: number
  /** Similarity floor (0-1); below this a chunk is considered irrelevant. */
  ragMinScore?: number
  /** Allow recall across different chats. Off by default for privacy. */
  ragCrossChat?: boolean
  /** Override the embedding model; blank uses the provider default. */
  embeddingModel?: string
}

export class RuntimeConfigService {
  private filePath: string
  private runtimeConfig: RuntimeConfigSchema

  constructor() {
    this.filePath = path.join(__dirname, "../../runtime_config.json")

    // Default values come from env config
    this.runtimeConfig = {
      botEnabled: false, // Default to OFF
      enablePrivateChat: true,
      rateLimitMaxRequests: config.RATE_LIMIT_MAX_REQUESTS,
      rateLimitWindowMs: config.RATE_LIMIT_WINDOW_MS,
      botName: config.BOT_NAME,
      adminNumbers: config.ADMIN_NUMBERS,
      systemPrompt: config.SYSTEM_PROMPT,
      geminiApiKey: config.GEMINI_API_KEY,
      llmProvider: config.LLM_PROVIDER,
      openaiApiKey: process.env.OPENAI_API_KEY,
      openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
      openaiBaseUrl: process.env.OPENAI_BASE_URL || "",
      respondToGroupMessages: false,
      contextualGroupResponses: false,
      accessControlMode: config.ACCESS_CONTROL_MODE,
      memoryMessageLimit: config.MEMORY_MESSAGE_LIMIT,
      memoryWindowMs: config.MEMORY_WINDOW_MS,
      ragEnabled: true,
      ragTopK: 4,
      ragMinScore: 0.3,
      ragCrossChat: false,
      embeddingModel: "",
    }

    this.loadFromFile()
  }

  private loadFromFile(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8")
        const parsed = JSON.parse(raw)
        this.runtimeConfig = { ...this.runtimeConfig, ...parsed }
        logger.info("Loaded runtime config from file")
      } else {
        logger.info("No runtime config file found, using defaults")
      }
    } catch (err) {
      logger.error("Error reading runtime config file:", err)
    }
  }

  public get<T extends keyof RuntimeConfigSchema>(key: T): RuntimeConfigSchema[T] {
    return (this.runtimeConfig as any)[key]
  }

  public set<T extends keyof RuntimeConfigSchema>(key: T, value: RuntimeConfigSchema[T]): void {
    ;(this.runtimeConfig as any)[key] = value
    this.saveToFile()
  }

  public getAll(): RuntimeConfigSchema {
    return { ...this.runtimeConfig }
  }

  private saveToFile(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.runtimeConfig, null, 2), "utf-8")
      logger.info("Saved runtime config to file")
    } catch (err) {
      logger.error("Error saving runtime config file:", err)
    }
  }
}

export const runtimeConfig = new RuntimeConfigService()
