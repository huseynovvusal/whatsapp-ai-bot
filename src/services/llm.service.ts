import { GoogleGenerativeAI } from "@google/generative-ai"
import OpenAI from "openai"
import { config } from "@/config/env"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { databaseService } from "@/services/database.service"
import { createLogger } from "@/lib/logger"
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
  } catch (err) {
    logger.warn("Failed to record LLM usage analytics", err)
  }
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
  public async askLLM(userText: string, context: string, systemPrompt: string): Promise<string> {
    try {
      logger.debug(`Asking LLM with user text: "${userText.substring(0, 50)}..."`)

      // Construct the full prompt with system prompt and context
      const fullPrompt = `${systemPrompt}

${context}

User: ${userText}
Assistant:`

      if (this.provider === "openai" && this.openai && this.openaiModel) {
        const res = await this.openai.chat.completions.create({
          model: this.openaiModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `${context}\n\n${userText}` },
          ],
          temperature: 0.6,
          max_tokens: 1024,
        })
        const answer = res.choices?.[0]?.message?.content || ""
        recordUsage(res.usage?.total_tokens || 0)
        logger.info("LLM response received successfully (OpenAI)")
        return answer
      }

      // Gemini path
      if (!this.geminiModel) throw new Error("Gemini model not initialized")
      const result = await this.geminiModel.generateContent(fullPrompt)
      const response = await result.response
      const answer = response.text()
      recordUsage(response.usageMetadata?.totalTokenCount || 0)
      logger.info("LLM response received successfully (Gemini)")
      return answer
    } catch (error) {
      logger.error("Error calling LLM:", error)
      throw new Error("Failed to get response from AI. Please try again.")
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
   * Analyze an image with vision model
   */
  public async analyzeImage(imageBuffer: Buffer, prompt: string, mimeType: string = "image/jpeg"): Promise<string> {
    try {
      logger.debug("Analyzing image with vision model")

      if (this.provider === "openai" && this.openai && this.openaiModel) {
        // Use GPT-4 Vision (need gpt-4-vision-preview or gpt-4o)
        const base64Image = imageBuffer.toString("base64")
        const res = await this.openai.chat.completions.create({
          model: this.openaiModel.includes("vision") || this.openaiModel.includes("4o") ? this.openaiModel : "gpt-4o",
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
          max_tokens: 500
        })
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

      const result = await this.geminiModel.generateContent([prompt, imagePart])
      const response = await result.response
      const answer = response.text()
      recordUsage(response.usageMetadata?.totalTokenCount || 0)
      logger.info("Image analyzed successfully (Gemini Vision)")
      return answer
    } catch (error) {
      logger.error("Error analyzing image:", error)
      throw new Error("Failed to analyze image. Please try again.")
    }
  }
}

// Singleton instance
export const llmService = new LLMService()
