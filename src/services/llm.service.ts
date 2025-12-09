import { GoogleGenerativeAI } from "@google/generative-ai"
import { config } from "@/config/env"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { createLogger } from "@/lib/logger"

const logger = createLogger(config.LOG_LEVEL, "LLMService")

export class LLMService {
  private genAI: GoogleGenerativeAI
  private model: any

  constructor() {
    if (config.LLM_PROVIDER !== "gemini") {
      throw new Error("LLM_PROVIDER must be set to 'gemini' in .env")
    }

    if (!config.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is required when using Gemini")
    }

    // Initialize Gemini using runtime config if present
    const apiKey = (runtimeConfig.get("geminiApiKey") as string) || config.GEMINI_API_KEY
    if (!apiKey) throw new Error("GEMINI_API_KEY is required when using Gemini")
    this.genAI = new GoogleGenerativeAI(apiKey)
    this.model = this.genAI.getGenerativeModel({
      model: config.GEMINI_MODEL || "gemini-1.5-flash",
    })

    logger.info(`LLM initialized with Gemini model: ${config.GEMINI_MODEL}`)
  }

  /**
   * Reload credentials and reinitialize LLM client
   */
  public reloadCredentials(): void {
    const apiKey = (runtimeConfig.get("geminiApiKey") as string) || config.GEMINI_API_KEY
    if (!apiKey) throw new Error("GEMINI_API_KEY is required when using Gemini")
    this.genAI = new GoogleGenerativeAI(apiKey)
    this.model = this.genAI.getGenerativeModel({
      model: config.GEMINI_MODEL || "gemini-1.5-flash",
    })
    logger.info("LLM credentials reloaded")
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

      // Generate response
      const result = await this.model.generateContent(fullPrompt)
      const response = await result.response
      const answer = response.text()

      logger.info("LLM response received successfully")
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

      const result = await this.model.generateContent(prompt)
      const response = await result.response
      const text = response.text().trim()

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
      const result = await this.model.generateContent(userText)
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
