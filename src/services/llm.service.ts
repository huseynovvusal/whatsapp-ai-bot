import { GoogleGenerativeAI } from "@google/generative-ai"
import OpenAI from "openai"
import { config } from "@/config/env"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { createLogger } from "@/lib/logger"

const logger = createLogger(config.LOG_LEVEL, "LLMService")

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
          max_tokens: 256,
        })
        const answer = res.choices?.[0]?.message?.content || ""
        logger.info("LLM response received successfully (OpenAI)")
        return answer
      }

      // Gemini path
      if (!this.geminiModel) throw new Error("Gemini model not initialized")
      const result = await this.geminiModel.generateContent(fullPrompt)
      const response = await result.response
      const answer = response.text()
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
  ): Promise<{ shouldReply: boolean; reply?: string }> {
    try {
      const prompt = `${systemPrompt}

${context}

You are assigned to decide whether the assistant should jump into a group chat given the message below. Only return a single-line JSON object exactly as follows:
{ "shouldReply": true|false, "reply": "<short reply if shouldReply true>" }

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
      } else {
        if (!this.geminiModel) throw new Error("Gemini model not initialized")
        const result = await this.geminiModel.generateContent(prompt)
        const response = await result.response
        text = response.text().trim()
      }

      // Try to parse JSON directly
      try {
        const parsed = JSON.parse(text)
        return { shouldReply: Boolean(parsed.shouldReply), reply: parsed.reply }
      } catch (err) {
        // Try to extract JSON substring using regex
        const match = text.match(/\{[\s\S]*\}/)
        if (match && match[0]) {
          try {
            const parsed2 = JSON.parse(match[0])
            return { shouldReply: Boolean(parsed2.shouldReply), reply: parsed2.reply }
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
        return res.choices?.[0]?.message?.content || ""
      }
      if (!this.geminiModel) throw new Error("Gemini model not initialized")
      const result = await this.geminiModel.generateContent(userText)
      const response = await result.response
      return response.text()
    } catch (error) {
      logger.error("Error in simple LLM ask:", error)
      throw new Error("Failed to get response from AI.")
    }
  }
}

// Singleton instance
export const llmService = new LLMService()
