import OpenAI, { toFile } from "openai"
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

export class OpenAILLMProvider implements LLMProvider {
  private openai: OpenAI
  private model: string

  constructor(apiKey: string, baseURL?: string, model: string = "gpt-4o-mini") {
    this.openai = new OpenAI({ apiKey, baseURL })
    this.model = model
  }

  async askLLM(
    userText: string,
    context: string,
    systemPrompt: string,
    options: { maxTokens?: number } = {}
  ): Promise<{ answer: string; tokensUsed: number }> {
    const res = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `${context}\n\n${userText}` },
      ],
      temperature: 0.6,
      max_tokens: options.maxTokens || 1024,
    })
    return {
      answer: res.choices?.[0]?.message?.content || "",
      tokensUsed: res.usage?.total_tokens || 0,
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

    const res = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: preamble },
        { role: "user", content: task },
      ],
      temperature: 0.3,
      max_tokens: DECISION_MAX_TOKENS,
    })

    const text = (res.choices?.[0]?.message?.content || "").trim()
    const tokensUsed = res.usage?.total_tokens || 0

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
    const res = await this.openai.chat.completions.create({
      model: this.model,
      messages: [{ role: "user", content: userText }],
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    })
    return {
      answer: res.choices?.[0]?.message?.content || "",
      tokensUsed: res.usage?.total_tokens || 0,
    }
  }

  async transcribeAudio(
    audioBuffer: Buffer,
    mimeType: string = "audio/ogg"
  ): Promise<{ text: string; tokensUsed: number }> {
    const extension = mimeType.includes("mp3")
      ? "mp3"
      : mimeType.includes("mp4") || mimeType.includes("m4a")
        ? "m4a"
        : mimeType.includes("wav")
          ? "wav"
          : "ogg"

    const res = await this.openai.audio.transcriptions.create({
      file: await toFile(audioBuffer, `voice.${extension}`, { type: mimeType }),
      model: "whisper-1",
    })
    return {
      text: (res.text || "").trim(),
      tokensUsed: 0,
    }
  }

  async analyzeImage(
    imageBuffer: Buffer,
    prompt: string,
    mimeType: string = "image/jpeg"
  ): Promise<{ answer: string; tokensUsed: number }> {
    const base64Image = imageBuffer.toString("base64")
    const visionModel = this.model.includes("vision") || this.model.includes("4o") ? this.model : "gpt-4o"

    const res = await this.openai.chat.completions.create({
      model: visionModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64Image}` },
            },
          ],
        },
      ],
      max_tokens: 500,
    })
    return {
      answer: res.choices?.[0]?.message?.content || "",
      tokensUsed: res.usage?.total_tokens || 0,
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

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private openai: OpenAI
  private model: string

  constructor(apiKey: string, baseURL?: string, model: string = "text-embedding-3-small") {
    this.openai = new OpenAI({ apiKey, baseURL })
    this.model = model
  }

  getModelId(): string {
    return `openai:${this.model}`
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts.length) return []
    const res = await this.openai.embeddings.create({ model: this.model, input: texts })
    const out: number[][] = new Array(texts.length)
    for (const item of res.data) out[item.index] = normalise(item.embedding as number[])
    return out
  }
}
