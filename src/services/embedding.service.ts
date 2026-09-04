import { GoogleGenerativeAI } from "@google/generative-ai"
import OpenAI from "openai"
import { config } from "@/config/env"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { createLogger } from "@/lib/logger"

const logger = createLogger(config.LOG_LEVEL, "EmbeddingService")

/** Default embedding model per provider. Both are the cheap, fast tier. */
const DEFAULT_MODELS = {
  gemini: "text-embedding-004",
  openai: "text-embedding-3-small",
}

/**
 * Turns text into vectors, using whichever LLM provider is configured.
 *
 * Vectors are L2-normalised here, once, so similarity search downstream is a
 * plain dot product instead of a full cosine calculation on every comparison.
 */
export class EmbeddingService {
  private provider: "openai" | "gemini" = "gemini"
  private model: string = DEFAULT_MODELS.gemini
  private genAI?: GoogleGenerativeAI
  private openai?: OpenAI
  private configured = false

  constructor() {
    this.reload()
  }

  /** Re-read provider/credentials. Safe to call at any time. */
  public reload(): void {
    this.configured = false
    try {
      const provider = (runtimeConfig.get("llmProvider") as "openai" | "gemini") ||
        config.LLM_PROVIDER || "gemini"
      this.provider = provider

      const configuredModel = runtimeConfig.get("embeddingModel") as string | undefined

      if (provider === "openai") {
        const apiKey = (runtimeConfig.get("openaiApiKey") as string) || process.env.OPENAI_API_KEY
        const baseURL = (runtimeConfig.get("openaiBaseUrl") as string) || process.env.OPENAI_BASE_URL
        if (!apiKey) return
        this.openai = new OpenAI({ apiKey, baseURL: baseURL || undefined })
        this.genAI = undefined
        this.model = configuredModel || DEFAULT_MODELS.openai
      } else {
        const apiKey = (runtimeConfig.get("geminiApiKey") as string) || config.GEMINI_API_KEY
        if (!apiKey) return
        this.genAI = new GoogleGenerativeAI(apiKey)
        this.openai = undefined
        this.model = configuredModel || DEFAULT_MODELS.gemini
      }

      this.configured = true
      logger.info(`Embeddings ready: ${this.provider} / ${this.model}`)
    } catch (err) {
      logger.warn("Embedding service could not be initialised", err)
    }
  }

  public isConfigured(): boolean {
    return this.configured
  }

  public getModelId(): string {
    return `${this.provider}:${this.model}`
  }

  /**
   * Embed a batch of texts. Order of results matches the order of the input.
   *
   * OpenAI accepts a native batch; Gemini is called per item with bounded
   * concurrency, which keeps indexing quick without opening hundreds of sockets.
   */
  public async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.configured) throw new Error("Embedding provider is not configured")
    if (!texts.length) return []

    if (this.provider === "openai" && this.openai) {
      const res = await this.openai.embeddings.create({ model: this.model, input: texts })
      // The API may return items out of order; `index` is authoritative.
      const out: number[][] = new Array(texts.length)
      for (const item of res.data) out[item.index] = normalise(item.embedding as number[])
      return out
    }

    if (!this.genAI) throw new Error("Gemini embedding client not initialised")
    const model = this.genAI.getGenerativeModel({ model: this.model })
    const results: number[][] = new Array(texts.length)
    const concurrency = 4

    for (let start = 0; start < texts.length; start += concurrency) {
      const slice = texts.slice(start, start + concurrency)
      await Promise.all(
        slice.map(async (text, offset) => {
          const res = await model.embedContent(text)
          results[start + offset] = normalise(res.embedding.values as number[])
        })
      )
    }
    return results
  }

  public async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text])
    return vector
  }
}

/**
 * Scale a vector to unit length. Downstream similarity is then a dot product.
 * A zero vector is returned unchanged rather than producing NaNs.
 */
export function normalise(vector: number[]): number[] {
  let sumSquares = 0
  for (let i = 0; i < vector.length; i++) sumSquares += vector[i] * vector[i]
  const magnitude = Math.sqrt(sumSquares)
  if (!magnitude || !Number.isFinite(magnitude)) return vector
  const out = new Array(vector.length)
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / magnitude
  return out
}

export const embeddingService = new EmbeddingService()
