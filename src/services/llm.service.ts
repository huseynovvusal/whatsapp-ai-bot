import { config } from "@/config/env"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { databaseService } from "@/services/database.service"
import { createLogger } from "@/lib/logger"
import { budgetService } from "@/services/budget.service"

import { LLMProvider } from "@/services/providers/interfaces"
import { OpenAILLMProvider } from "@/services/providers/openai"
import { GeminiLLMProvider } from "@/services/providers/gemini"
import { AzureOpenAILLMProvider } from "@/services/providers/azure-openai"

const logger = createLogger(config.LOG_LEVEL, "LLMService")


/**
 * Record a single LLM API call (and its token usage, when the provider reports it)
 * against today's analytics row. Failures here must never break a reply.
 */
function recordUsage(tokensUsed: number = 0): void {
  try {
    const today = new Date().toISOString().split("T")[0]
    databaseService.updateAnalytics(today, { apiCalls: 1, tokensUsed })
    // So the next budget check sees this call rather than a stale cache.
    budgetService.invalidate()
  } catch (err) {
    logger.warn("Failed to record LLM usage analytics", err)
  }
}

/** Error carrying a user-facing explanation, so chats get something useful. */
export class LLMError extends Error {
  constructor(
    message: string,
    public readonly userMessage: string,
    public readonly retryable: boolean
  ) {
    super(message)
    this.name = "LLMError"
  }
}

/** Classify a provider error so we know whether retrying can help. */
function classifyError(error: unknown): { status?: number; retryable: boolean; user: string } {
  const err = error as { status?: number; code?: string; message?: string }
  const status = typeof err?.status === "number" ? err.status : undefined
  const text = String(err?.message || err?.code || "").toLowerCase()

  const looksRateLimited = status === 429 || text.includes("rate limit") || text.includes("quota")
  const looksOverloaded =
    status === 503 || status === 502 || status === 500 || text.includes("overloaded")
  const looksTimeout =
    text.includes("timeout") || text.includes("etimedout") || text.includes("econnreset") ||
    text.includes("socket hang up") || text.includes("fetch failed")
  const looksAuth = status === 401 || status === 403 || text.includes("api key")

  if (looksRateLimited) {
    return { status, retryable: true, user: "⏳ I'm being rate-limited right now. Try again in a moment." }
  }
  if (looksOverloaded || looksTimeout) {
    return { status, retryable: true, user: "⚠️ The AI service is not responding. Try again shortly." }
  }
  if (looksAuth) {
    // Retrying a bad key just burns time; surface it so the operator fixes it.
    return { status, retryable: false, user: "🔑 My AI credentials are not working. An admin needs to check the API key." }
  }
  return { status, retryable: false, user: "❌ Sorry, something went wrong. Please try again." }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class LLMService {
  private provider: "openai" | "gemini" | "azure" = "gemini"
  private adapter?: LLMProvider

  constructor() {
    this.initialize()
  }

  /**
   * Run a provider call with bounded retries.
   *
   * Rate limits, timeouts and provider outages are transient — retrying with
   * backoff turns most of them into a slightly slow reply instead of a visible
   * failure. Authentication errors are not retried, since they cannot resolve
   * themselves and retrying only delays the real message to the operator.
   */
  private async withRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
    const maxAttempts = 3
    let lastError: unknown

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await run()
      } catch (error) {
        lastError = error
        const { status, retryable, user } = classifyError(error)

        if (!retryable || attempt === maxAttempts) {
          logger.error(
            `${label} failed after ${attempt} attempt(s)${status ? ` (status ${status})` : ""}`,
            error
          )
          throw new LLMError(`${label} failed`, user, retryable)
        }

        // Exponential backoff with jitter, so simultaneous chats do not retry in lockstep.
        const delay = Math.round(500 * Math.pow(2, attempt - 1) * (1 + Math.random() * 0.3))
        logger.warn(
          `${label} attempt ${attempt}/${maxAttempts} failed${status ? ` (status ${status})` : ""}; retrying in ${delay}ms`
        )
        await sleep(delay)
      }
    }

    throw lastError
  }

  /**
   * Reload credentials and reinitialize LLM client
   */
  public reloadCredentials(): void {
    this.initialize()
    logger.info("LLM credentials reloaded")
  }

  private initialize(): void {
    const provider = (runtimeConfig.get("llmProvider") as any) || config.LLM_PROVIDER || "gemini"
    this.provider = provider

    if (provider === "openai") {
      const apiKey = (runtimeConfig.get("openaiApiKey") as string) || process.env.OPENAI_API_KEY
      const baseURL = (runtimeConfig.get("openaiBaseUrl") as string) || process.env.OPENAI_BASE_URL
      const model = (runtimeConfig.get("openaiModel") as string) || process.env.OPENAI_MODEL || "gpt-4o-mini"
      if (!apiKey) throw new Error("OPENAI_API_KEY is required when LLM provider is OpenAI")
      this.adapter = new OpenAILLMProvider(apiKey, baseURL, model)
      logger.info(`LLM initialized with OpenAI model: ${model}${baseURL ? ` (base: ${baseURL})` : ""}`)
      return
    }

    if (provider === "azure") {
      const apiKey = (runtimeConfig.get("azureOpenaiApiKey") as string) || config.AZURE_OPENAI_API_KEY
      const endpoint = (runtimeConfig.get("azureOpenaiEndpoint") as string) || config.AZURE_OPENAI_ENDPOINT
      const deployment = (runtimeConfig.get("azureOpenaiDeployment") as string) || config.AZURE_OPENAI_DEPLOYMENT
      const apiVersion = (runtimeConfig.get("azureOpenaiApiVersion") as string) || config.AZURE_OPENAI_API_VERSION

      if (!apiKey || !endpoint || !deployment) {
        throw new Error("Azure OpenAI configuration is incomplete. Check API key, endpoint, and deployment.")
      }
      this.adapter = new AzureOpenAILLMProvider(apiKey, endpoint, deployment, apiVersion)
      logger.info(`LLM initialized with Azure OpenAI deployment: ${deployment}`)
      return
    }

    // Default to Gemini
    const apiKey = (runtimeConfig.get("geminiApiKey") as string) || config.GEMINI_API_KEY
    if (!apiKey) throw new Error("GEMINI_API_KEY is required when using Gemini")
    const model = config.GEMINI_MODEL || "gemini-1.5-flash"
    this.adapter = new GeminiLLMProvider(apiKey, model)
    logger.info(`LLM initialized with Gemini model: ${model}`)
  }

  /**
   * Ask the LLM with user text and context
   */
  public async askLLM(
    userText: string,
    context: string,
    systemPrompt: string,
    options: { maxTokens?: number } = {}
  ): Promise<string> {
    try {
      logger.debug(`Asking LLM with user text: "${userText.substring(0, 50)}..."`)
      if (!this.adapter) throw new Error("LLM adapter not initialized")

      const { answer, tokensUsed } = await this.withRetry(`${this.provider} completion`, () =>
        this.adapter!.askLLM(userText, context, systemPrompt, options)
      )
      recordUsage(tokensUsed)
      logger.info(`LLM response received successfully (${this.provider})`)
      return answer
    } catch (error) {
      if (error instanceof LLMError) throw error
      logger.error("Error calling LLM:", error)
      throw new LLMError("askLLM failed", classifyError(error).user, false)
    }
  }

  /**
   * Given a group message and context, ask the LLM to decide whether to reply and return a JSON object
   * { shouldReply: boolean, reply?: string }
   */
  public async askForReactiveReply(
    userText: string,
    context: string,
    systemPrompt: string
  ): Promise<{ shouldReply: boolean; reply?: string; reaction?: string; replyTo?: number }> {
    try {
      if (!this.adapter) throw new Error("LLM adapter not initialized")
      const result = await this.adapter.askForReactiveReply(userText, context, systemPrompt)
      recordUsage(result.tokensUsed)
      return {
        shouldReply: result.shouldReply,
        reply: result.reply,
        reaction: result.reaction,
        replyTo: result.replyTo
      }
    } catch (error) {
      logger.warn("LLM reactive reply decision failed", error)
      return { shouldReply: false }
    }
  }

  /**
   * Simple ask without context (for quick queries)
   */
  public async ask(userText: string, options: { maxTokens?: number } = {}): Promise<string> {
    try {
      if (!this.adapter) throw new Error("LLM adapter not initialized")
      const result = await this.adapter.ask(userText, options)
      recordUsage(result.tokensUsed)
      return result.answer
    } catch (error) {
      logger.error("Error in simple LLM ask:", error)
      throw new Error("Failed to get response from AI.")
    }
  }

  /**
   * Transcribe a voice note or audio clip to text.
   *
   * OpenAI uses Whisper; Gemini accepts the audio inline on its normal
   * multimodal endpoint. Both go through the same retry path as everything else.
   */
  public async transcribeAudio(
    audioBuffer: Buffer,
    mimeType: string = "audio/ogg"
  ): Promise<string> {
    try {
      logger.debug(`Transcribing ${audioBuffer.length} bytes of ${mimeType}`)
      if (!this.adapter) throw new Error("LLM adapter not initialized")

      const { text, tokensUsed } = await this.withRetry(`${this.provider} transcription`, () =>
        this.adapter!.transcribeAudio(audioBuffer, mimeType)
      )
      recordUsage(tokensUsed)
      logger.info(`Audio transcribed successfully (${this.provider})`)
      return text
    } catch (error) {
      if (error instanceof LLMError) throw error
      logger.error("Error transcribing audio:", error)
      throw new LLMError("transcribeAudio failed", classifyError(error).user, false)
    }
  }

  /**
   * Analyze an image with vision model
   */
  public async analyzeImage(imageBuffer: Buffer, prompt: string, mimeType: string = "image/jpeg"): Promise<string> {
    try {
      logger.debug("Analyzing image with vision model")
      if (!this.adapter) throw new Error("LLM adapter not initialized")

      const { answer, tokensUsed } = await this.withRetry(`${this.provider} vision`, () =>
        this.adapter!.analyzeImage(imageBuffer, prompt, mimeType)
      )
      recordUsage(tokensUsed)
      logger.info(`Image analyzed successfully (${this.provider} Vision)`)
      return answer
    } catch (error) {
      if (error instanceof LLMError) throw error
      logger.error("Error analyzing image:", error)
      throw new LLMError("analyzeImage failed", classifyError(error).user, false)
    }
  }
}

// Singleton instance
export const llmService = new LLMService()
