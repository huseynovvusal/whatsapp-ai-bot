import { config } from "@/config/env"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { createLogger } from "@/lib/logger"
import { EmbeddingProvider } from "@/services/providers/interfaces"
import { OpenAIEmbeddingProvider } from "@/services/providers/openai"
import { GeminiEmbeddingProvider } from "@/services/providers/gemini"
import { AzureOpenAIEmbeddingProvider } from "@/services/providers/azure-openai"

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
  private provider: "openai" | "gemini" | "azure" = "gemini"
  private adapter?: EmbeddingProvider
  private configured = false

  constructor() {
    this.reload()
  }

  /** Re-read provider/credentials. Safe to call at any time. */
  public reload(): void {
    this.configured = false
    try {
      const provider = (runtimeConfig.get("llmProvider") as "openai" | "gemini" | "azure") || config.LLM_PROVIDER || "gemini"
      this.provider = provider

      const configuredModel = runtimeConfig.get("embeddingModel") as string | undefined

      if (provider === "openai") {
        const apiKey = (runtimeConfig.get("openaiApiKey") as string) || process.env.OPENAI_API_KEY
        const baseURL = (runtimeConfig.get("openaiBaseUrl") as string) || process.env.OPENAI_BASE_URL
        if (!apiKey) return
        const model = configuredModel || DEFAULT_MODELS.openai
        this.adapter = new OpenAIEmbeddingProvider(apiKey, baseURL || undefined, model)
      } else if (provider === "azure") {
        const apiKey = (runtimeConfig.get("azureOpenaiApiKey") as string) || config.AZURE_OPENAI_API_KEY
        const endpoint = (runtimeConfig.get("azureOpenaiEndpoint") as string) || config.AZURE_OPENAI_ENDPOINT
        const deployment = (runtimeConfig.get("azureOpenaiEmbeddingDeployment") as string) || config.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || (runtimeConfig.get("azureOpenaiDeployment") as string) || config.AZURE_OPENAI_DEPLOYMENT
        const apiVersion = (runtimeConfig.get("azureOpenaiApiVersion") as string) || config.AZURE_OPENAI_API_VERSION

        if (!apiKey || !endpoint || !deployment) return
        this.adapter = new AzureOpenAIEmbeddingProvider(apiKey, endpoint, deployment, apiVersion)
      } else {
        const apiKey = (runtimeConfig.get("geminiApiKey") as string) || config.GEMINI_API_KEY
        if (!apiKey) return
        const model = configuredModel || DEFAULT_MODELS.gemini
        this.adapter = new GeminiEmbeddingProvider(apiKey, model)
      }

      this.configured = true
      logger.info(`Embeddings ready: ${this.provider} / ${this.adapter?.getModelId()}`)
    } catch (err) {
      logger.warn("Embedding service could not be initialised", err)
    }
  }

  public isConfigured(): boolean {
    return this.configured
  }

  public getModelId(): string {
    return this.adapter?.getModelId() || `${this.provider}:unknown`
  }

  /**
   * Embed a batch of texts. Order of results matches the order of the input.
   *
   * OpenAI accepts a native batch; Gemini is called per item with bounded
   * concurrency, which keeps indexing quick without opening hundreds of sockets.
   */
  public async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.configured || !this.adapter) throw new Error("Embedding provider is not configured")
    return this.adapter.embedBatch(texts)
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
