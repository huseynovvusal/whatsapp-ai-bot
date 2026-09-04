import { GoogleGenerativeAI } from "@google/generative-ai"
import { LLMProvider, EmbeddingProvider } from "./interfaces"
import { sanitiseEmoji } from "@/utils/emoji.utils"

const DECISION_MAX_TOKENS = 300
const DECISION_INSTRUCTIONS = `You are following this group chat. Decide how to respond to the message (or messages) below, the way someone in the group would.

SPEAK UP when any of these is true:
- Someone asked a question you can actually answer, even if they did not ask you.
- Something was said that you have a genuine reaction or opinion about.
- You are already part of this thread — you said something recently and they are still on it.
- The chat has been quiet and someone opened a topic worth picking up.

STAY QUIET when:
- Two other people are mid-exchange and a third voice would interrupt.
- You would only be agreeing, acknowledging, or restating what was said. React with an emoji instead.
- You have nothing to add beyond politeness.

If several messages are shown, they are numbered. Set "replyTo" to the number of the one you are actually answering — that becomes a WhatsApp reply to that exact message. Leave it out when you are responding to the conversation as a whole.

Return a single-line JSON object and nothing else:
{ "shouldReply": true|false, "reply": "<short reply, only if shouldReply is true>", "reaction": "<a single emoji, or empty string for none>", "replyTo": <message number, or omit> }`

export class GeminiLLMProvider implements LLMProvider {
  private genAI: GoogleGenerativeAI
  private geminiModel: any

  constructor(apiKey: string, model: string = "gemini-1.5-flash") {
    this.genAI = new GoogleGenerativeAI(apiKey)
    this.geminiModel = this.genAI.getGenerativeModel({ model })
  }

  async askLLM(
    userText: string,
    context: string,
    systemPrompt: string,
    options: { maxTokens?: number } = {}
  ): Promise<{ answer: string; tokensUsed: number }> {
    const fullPrompt = `${systemPrompt}

${context}

User: ${userText}
Assistant:`
    const result = await this.geminiModel.generateContent({
      contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
      generationConfig: { maxOutputTokens: options.maxTokens || 1024 },
    })
    const response = await result.response
    return {
      answer: response.text(),
      tokensUsed: response.usageMetadata?.totalTokenCount || 0,
    }
  }

  async askForReactiveReply(
    userText: string,
    context: string,
    systemPrompt: string
  ): Promise<{
    shouldReply: boolean
    reply?: string
    reaction?: string
    replyTo?: number
    tokensUsed: number
  }> {
    const preamble = `${systemPrompt}

${DECISION_INSTRUCTIONS}

${context}`
    const task = `${userText}\n`

    const result = await this.geminiModel.generateContent({
      contents: [{ role: "user", parts: [{ text: `${preamble}\n\n${task}` }] }],
      generationConfig: { maxOutputTokens: DECISION_MAX_TOKENS, temperature: 0.3 },
    })
    const response = await result.response
    const text = response.text().trim()
    const tokensUsed = response.usageMetadata?.totalTokenCount || 0

    const toDecision = (parsed: Record<string, unknown>) => {
      const replyTo = Number(parsed.replyTo)
      return {
        shouldReply: Boolean(parsed.shouldReply),
        reply: typeof parsed.reply === "string" ? parsed.reply : undefined,
        reaction: sanitiseEmoji(parsed.reaction),
        replyTo: Number.isInteger(replyTo) && replyTo > 0 ? replyTo : undefined,
        tokensUsed,
      }
    }

    try {
      return toDecision(JSON.parse(text))
    } catch (err) {
      const match = text.match(/\{[\s\S]*\}/)
      if (match && match[0]) {
        try {
          return toDecision(JSON.parse(match[0]))
        } catch (e) {}
      }
    }

    return { shouldReply: false, tokensUsed }
  }

  async ask(
    userText: string,
    options: { maxTokens?: number } = {}
  ): Promise<{ answer: string; tokensUsed: number }> {
    const result = await this.geminiModel.generateContent(
      options.maxTokens
        ? {
            contents: [{ role: "user", parts: [{ text: userText }] }],
            generationConfig: { maxOutputTokens: options.maxTokens },
          }
        : userText
    )
    const response = await result.response
    return {
      answer: response.text(),
      tokensUsed: response.usageMetadata?.totalTokenCount || 0,
    }
  }

  async transcribeAudio(
    audioBuffer: Buffer,
    mimeType: string = "audio/ogg"
  ): Promise<{ text: string; tokensUsed: number }> {
    const result = await this.geminiModel.generateContent([
      {
        inlineData: { data: audioBuffer.toString("base64"), mimeType },
      },
      "Transcribe this audio exactly. Reply with only the transcription, no commentary. " +
        "If there is no intelligible speech, reply with an empty string.",
    ])
    const response = await result.response
    return {
      text: (response.text() || "").trim(),
      tokensUsed: response.usageMetadata?.totalTokenCount || 0,
    }
  }

  async analyzeImage(
    imageBuffer: Buffer,
    prompt: string,
    mimeType: string = "image/jpeg"
  ): Promise<{ answer: string; tokensUsed: number }> {
    const imagePart = {
      inlineData: {
        data: imageBuffer.toString("base64"),
        mimeType,
      },
    }
    const result = await this.geminiModel.generateContent([prompt, imagePart])
    const response = await result.response
    return {
      answer: response.text(),
      tokensUsed: response.usageMetadata?.totalTokenCount || 0,
    }
  }
}

function normalise(vector: number[]): number[] {
  let sumSquares = 0
  for (let i = 0; i < vector.length; i++) sumSquares += vector[i] * vector[i]
  const magnitude = Math.sqrt(sumSquares)
  if (!magnitude || !Number.isFinite(magnitude)) return vector
  const out = new Array(vector.length)
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / magnitude
  return out
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private genAI: GoogleGenerativeAI
  private model: string

  constructor(apiKey: string, model: string = "text-embedding-004") {
    this.genAI = new GoogleGenerativeAI(apiKey)
    this.model = model
  }

  getModelId(): string {
    return `gemini:${this.model}`
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts.length) return []
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
}
