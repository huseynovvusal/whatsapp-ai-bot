import { GoogleGenerativeAI } from "@google/generative-ai"
import OpenAI, { toFile } from "openai"
import { config } from "@/config/env"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { databaseService } from "@/services/database.service"
import { createLogger } from "@/lib/logger"
import { budgetService } from "@/services/budget.service"
import { sanitiseEmoji } from "@/utils/emoji.utils"

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

/** The part of a Gemini result this service actually reads. */
interface GeminiResult {
  response: Promise<{
    text(): string
    usageMetadata?: { totalTokenCount?: number }
  }>
}

export class LLMService {
  private provider: "openai" | "gemini" = "gemini"
  // Gemini
  private genAI?: GoogleGenerativeAI
  private geminiModel?: any
  // OpenAI
  private openai?: OpenAI
  private openaiModel?: string

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
    // Determine provider from runtime config or env
    const provider = (runtimeConfig.get("llmProvider") as any) || config.LLM_PROVIDER || "gemini"
    this.provider = provider

    if (provider === "openai") {
      const apiKey = (runtimeConfig.get("openaiApiKey") as string) || process.env.OPENAI_API_KEY
      const baseURL = (runtimeConfig.get("openaiBaseUrl") as string) || process.env.OPENAI_BASE_URL
      const model =
        (runtimeConfig.get("openaiModel") as string) || process.env.OPENAI_MODEL || "gpt-4o-mini"
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required when LLM provider is OpenAI")
      }
      this.openai = new OpenAI({ apiKey, baseURL })
      this.openaiModel = model
      this.genAI = undefined
      this.geminiModel = undefined
      logger.info(
        `LLM initialized with OpenAI model: ${model}${baseURL ? ` (base: ${baseURL})` : ""}`
      )
      return
    }

    // Default to Gemini
    const apiKey = (runtimeConfig.get("geminiApiKey") as string) || config.GEMINI_API_KEY
    if (!apiKey) throw new Error("GEMINI_API_KEY is required when using Gemini")
    this.genAI = new GoogleGenerativeAI(apiKey)
    this.geminiModel = this.genAI.getGenerativeModel({
      model: config.GEMINI_MODEL || "gemini-1.5-flash",
    })
    this.openai = undefined
    logger.info(`LLM initialized with Gemini model: ${config.GEMINI_MODEL}`)
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

      // Construct the full prompt with system prompt and context
      const fullPrompt = `${systemPrompt}

${context}

User: ${userText}
Assistant:`

      if (this.provider === "openai" && this.openai && this.openaiModel) {
        const res = await this.withRetry("OpenAI completion", () =>
          this.openai!.chat.completions.create({
            model: this.openaiModel!,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: `${context}\n\n${userText}` },
            ],
            temperature: 0.6,
            // A tight cap is the enforcement behind the prompt's length rule:
            // Companion passes a small budget so the model cannot ramble.
            max_tokens: options.maxTokens || 1024,
          })
        )
        const answer = res.choices?.[0]?.message?.content || ""
        recordUsage(res.usage?.total_tokens || 0)
        logger.info("LLM response received successfully (OpenAI)")
        return answer
      }

      // Gemini path
      if (!this.geminiModel) throw new Error("Gemini model not initialized")
      const result = await this.withRetry<GeminiResult>("Gemini completion", () =>
        this.geminiModel.generateContent({
          contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
          generationConfig: { maxOutputTokens: options.maxTokens || 1024 },
        })
      )
      const response = await result.response
      const answer = response.text()
      recordUsage(response.usageMetadata?.totalTokenCount || 0)
      logger.info("LLM response received successfully (Gemini)")
      return answer
    } catch (error) {
      // withRetry already logged and classified; keep its user-facing message.
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
  ): Promise<{ shouldReply: boolean; reply?: string; reaction?: string }> {
    try {
      // The same call also picks an emoji, so reacting costs no extra request.
      // Reacting without replying is a normal, low-noise way to acknowledge a
      // message — so `reaction` is meaningful even when shouldReply is false.
      const prompt = `${systemPrompt}

${context}

Decide how to respond to the message below in this group chat. Reply only when you genuinely add something; staying quiet is usually right. A quick emoji reaction is a good middle ground when a message deserves acknowledgement but not a reply.

Return a single-line JSON object and nothing else:
{ "shouldReply": true|false, "reply": "<short reply, only if shouldReply is true>", "reaction": "<a single emoji, or empty string for none>" }

Message: ${userText}
`

      let text = ""
      if (this.provider === "openai" && this.openai && this.openaiModel) {
        const res = await this.openai.chat.completions.create({
          model: this.openaiModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
        })
        text = (res.choices?.[0]?.message?.content || "").trim()
        recordUsage(res.usage?.total_tokens || 0)
      } else {
        if (!this.geminiModel) throw new Error("Gemini model not initialized")
        const result = await this.geminiModel.generateContent(prompt)
        const response = await result.response
        text = response.text().trim()
        recordUsage(response.usageMetadata?.totalTokenCount || 0)
      }

      const toDecision = (parsed: Record<string, unknown>) => ({
        shouldReply: Boolean(parsed.shouldReply),
        reply: typeof parsed.reply === "string" ? parsed.reply : undefined,
        reaction: sanitiseEmoji(parsed.reaction),
      })

      // Try to parse JSON directly
      try {
        return toDecision(JSON.parse(text))
      } catch (err) {
        // Models often wrap the object in prose or a code fence; pull it out.
        const match = text.match(/\{[\s\S]*\}/)
        if (match && match[0]) {
          try {
            return toDecision(JSON.parse(match[0]))
          } catch (e) {
            // fallthrough
          }
        }
      }

      // default to no
      return { shouldReply: false }
    } catch (error) {
      logger.warn("LLM reactive reply decision failed", error)
      return { shouldReply: false }
    }
  }

  /**
   * Simple ask without context (for quick queries)
   */
  public async ask(userText: string): Promise<string> {
    try {
      if (this.provider === "openai" && this.openai && this.openaiModel) {
        const res = await this.openai.chat.completions.create({
          model: this.openaiModel,
          messages: [{ role: "user", content: userText }],
        })
        recordUsage(res.usage?.total_tokens || 0)
        return res.choices?.[0]?.message?.content || ""
      }
      if (!this.geminiModel) throw new Error("Gemini model not initialized")
      const result = await this.geminiModel.generateContent(userText)
      const response = await result.response
      recordUsage(response.usageMetadata?.totalTokenCount || 0)
      return response.text()
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

      if (this.provider === "openai" && this.openai) {
        // Whisper picks the format from the filename, so give it a sane extension.
        const extension = mimeType.includes("mp3")
          ? "mp3"
          : mimeType.includes("mp4") || mimeType.includes("m4a")
            ? "m4a"
            : mimeType.includes("wav")
              ? "wav"
              : "ogg"
        const res = await this.withRetry("Whisper transcription", async () =>
          this.openai!.audio.transcriptions.create({
            file: await toFile(audioBuffer, `voice.${extension}`, { type: mimeType }),
            model: "whisper-1",
          })
        )
        // Whisper is billed by audio length, not tokens, so only the call counts.
        recordUsage(0)
        logger.info("Audio transcribed successfully (Whisper)")
        return (res.text || "").trim()
      }

      if (!this.geminiModel) throw new Error("Gemini model not initialized")
      const result = await this.withRetry<GeminiResult>("Gemini transcription", () =>
        this.geminiModel.generateContent([
          {
            inlineData: { data: audioBuffer.toString("base64"), mimeType },
          },
          "Transcribe this audio exactly. Reply with only the transcription, no commentary. " +
            "If there is no intelligible speech, reply with an empty string.",
        ])
      )
      const response = await result.response
      const text = response.text()
      recordUsage(response.usageMetadata?.totalTokenCount || 0)
      logger.info("Audio transcribed successfully (Gemini)")
      return (text || "").trim()
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

      if (this.provider === "openai" && this.openai && this.openaiModel) {
        // Use GPT-4 Vision (need gpt-4-vision-preview or gpt-4o)
        const base64Image = imageBuffer.toString("base64")
        const res = await this.withRetry("OpenAI vision", () =>
          this.openai!.chat.completions.create({
          // Fall back to a known-vision model when the configured one is text-only.
          model:
            this.openaiModel!.includes("vision") || this.openaiModel!.includes("4o")
              ? this.openaiModel!
              : "gpt-4o",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${mimeType};base64,${base64Image}`
                  }
                }
              ]
            }
          ],
            max_tokens: 500,
          })
        )
        const answer = res.choices?.[0]?.message?.content || ""
        recordUsage(res.usage?.total_tokens || 0)
        logger.info("Image analyzed successfully (OpenAI Vision)")
        return answer
      }

      // Gemini Vision
      if (!this.geminiModel) throw new Error("Gemini model not initialized")

      // Convert buffer to Gemini format
      const imagePart = {
        inlineData: {
          data: imageBuffer.toString("base64"),
          mimeType
        }
      }

      const result = await this.withRetry<GeminiResult>("Gemini vision", () =>
        this.geminiModel.generateContent([prompt, imagePart])
      )
      const response = await result.response
      const answer = response.text()
      recordUsage(response.usageMetadata?.totalTokenCount || 0)
      logger.info("Image analyzed successfully (Gemini Vision)")
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
