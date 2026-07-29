import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { databaseService } from "@/services/database.service"
import { styleService } from "@/services/style.service"

const logger = createLogger(config.LOG_LEVEL, "PersonaService")

export type Persona = "assistant" | "companion"

export const PERSONAS: Persona[] = ["assistant", "companion"]

export const PERSONA_LABELS: Record<Persona, string> = {
  assistant: "Assistant",
  companion: "Companion",
}

/**
 * Task-focused default. Short, clear, useful — the classic bot.
 */
export const DEFAULT_ASSISTANT_PROMPT = `You are a helpful assistant in a WhatsApp chat.

Answer clearly and get to the point. People are reading on a phone, so keep replies short — usually one to three sentences, and use a short list only when it genuinely helps. Prefer plain language over jargon.

If you do not know something, say so rather than guessing. Never invent facts about the people in this chat. When the participant list is available you can address people by name.`

/**
 * Conversational default. The goal is a message that reads as though a person in
 * the group wrote it — while staying honest about what it is when asked.
 */
export const DEFAULT_COMPANION_PROMPT = `You are part of this chat, and you talk like one of the group rather than like a customer-service bot.

TONE: match the register of the people around you. If they are casual and use slang, be casual. If they are calm and brief, be brief. Warm and friendly, never stiff or corporate.

LENGTH: short. One or two sentences is normal here. Long tidy paragraphs read as robotic in a group chat.

DO: react to what was actually said, use people's names naturally, have an opinion, and use the occasional emoji if the group does.

DO NOT: open with "Certainly!" or "As an AI", restate the question before answering, over-explain, or end messages with an offer to help. Do not reply to everything — it is fine to stay quiet.

HONESTY: you should sound like a person, but if someone sincerely asks whether you are a bot or an AI, tell them plainly that you are. Never claim to be a specific real person, and never claim to have done something in the physical world.`

/**
 * Appended in Companion mode when Free mode is on.
 *
 * This is a register control: it stops the model hedging, moralising and
 * sanitising its humour. It cannot change what the provider itself refuses —
 * that happens server-side, above any prompt.
 */
export const FREE_MODE_FRAGMENT = `UNFILTERED: talk the way close friends actually talk to each other.

- Swear naturally if the group does. Do not censor words, star them out, or soften them.
- Dark humour, sarcasm, teasing and banter are all fine. Roast people who are clearly up for it.
- Have real opinions and take sides. Disagree, argue back, call things stupid if you think they are.
- No disclaimers, no hedging, no "as an AI", no moralising, and no unsolicited safety advice.
- Never append a warning or caveat to a joke. A joke explained is a joke ruined.

The one thing a good friend still does: read the room. If someone is genuinely upset or being sincere, drop the bit and be straight with them. Banter only works between people who are both enjoying it.`

/**
 * Length discipline. The clearest tell that a chat message came from a bot is
 * that it is too long and too tidy, so this is stated as the top priority.
 */
export const LENGTH_FRAGMENT = `LENGTH — this matters more than anything else here:

- One or two short sentences. That is the whole message, most of the time.
- Never write paragraphs. No bullet points, no headings, no structuring a chat message like a document.
- Do not restate the question, do not summarise yourself, and do not end with an offer to help.
- If something really needs detail, give the short answer first and let them ask.

A long, well-organised reply is the single most robotic thing you can do in a group chat.`

/**
 * Resolves which personality applies to a chat, and the prompt that goes with it.
 *
 * A chat may carry its own override (set from the Conversations tab); otherwise
 * the global default applies. Prompts are stored per persona, so switching a chat
 * between modes swaps the whole voice without editing any text.
 */
export class PersonaService {
  /**
   * Per-chat overrides, mirrored in memory.
   *
   * `getPersonaForChat` runs on the hot path — for every message, and from
   * synchronous code such as `decideResponse` — so it must not await a query.
   * Overrides change rarely, so the map is loaded once at startup and written
   * through on every change. Reads stay synchronous and free.
   */
  private overrides: Map<string, Persona> = new Map()

  /** Warm the override cache. Called once at startup. */
  public async load(): Promise<void> {
    try {
      const stored = await databaseService.getChatPersonaOverrides()
      this.overrides = new Map(
        Object.entries(stored).filter(([, v]) =>
          PERSONAS.includes(v as Persona)
        ) as Array<[string, Persona]>
      )
      logger.info(`Loaded ${this.overrides.size} per-chat personality override(s)`)
    } catch (err) {
      logger.warn("Could not load personality overrides; using the global default", err)
    }
  }

  /** Global default, used by any chat without an explicit override. */
  public getDefaultPersona(): Persona {
    const value = runtimeConfig.get("defaultPersona") as Persona | undefined
    return value && PERSONAS.includes(value) ? value : "assistant"
  }

  /** The persona in force for a chat: its override, else the global default. */
  public getPersonaForChat(chatId?: string): Persona {
    if (chatId) {
      const override = this.overrides.get(chatId)
      if (override) return override
    }
    return this.getDefaultPersona()
  }

  /** Whether a chat has an explicit override rather than following the default. */
  public hasOverride(chatId: string): boolean {
    return this.overrides.has(chatId)
  }

  /** Set (or with `null`, clear) a chat's override. */
  public async setPersonaForChat(chatId: string, persona: Persona | null): Promise<void> {
    if (persona === null) {
      this.overrides.delete(chatId)
      await databaseService.clearChatPersona(chatId)
      logger.info(`Persona override cleared for ${chatId}`)
      return
    }
    this.overrides.set(chatId, persona)
    await databaseService.setChatPersona(chatId, persona)
    logger.info(`Persona for ${chatId} set to ${persona}`)
  }

  public getPrompt(persona: Persona): string {
    const key = persona === "companion" ? "companionPrompt" : "assistantPrompt"
    const stored = runtimeConfig.get(key) as string | undefined
    if (typeof stored === "string" && stored.trim()) return stored
    return persona === "companion" ? DEFAULT_COMPANION_PROMPT : DEFAULT_ASSISTANT_PROMPT
  }

  public setPrompt(persona: Persona, prompt: string): void {
    runtimeConfig.set(persona === "companion" ? "companionPrompt" : "assistantPrompt", prompt)
    logger.info(`${PERSONA_LABELS[persona]} prompt updated`)
  }

  /** Free mode strips the bot's stylistic primness. Companion only. */
  public isFreeMode(chatId?: string): boolean {
    if (this.getPersonaForChat(chatId) !== "companion") return false
    return runtimeConfig.get("companionFreeMode") === true
  }

  /** Whether Companion should mirror the chat's own writing style. */
  public isAdaptive(chatId?: string): boolean {
    if (this.getPersonaForChat(chatId) !== "companion") return false
    return runtimeConfig.get("companionAdaptiveStyle") !== false
  }

  /** Reply length ceiling in characters for this chat. 0 = no limit. */
  public getMaxReplyChars(chatId?: string): number {
    if (this.getPersonaForChat(chatId) !== "companion") return 0
    const configured = runtimeConfig.get("companionMaxChars")
    const value = configured === undefined ? 350 : Number(configured)
    return Number.isFinite(value) && value >= 0 ? value : 350
  }

  /**
   * The full system prompt for a chat: the persona's base prompt, plus the
   * Companion modifiers that apply.
   *
   * Order matters. The base prompt sets the voice; free mode and the adapted
   * style refine it; the length rule goes last so it is the most recent
   * instruction the model reads — length is the hardest rule to hold.
   */
  public async getPromptForChat(chatId?: string): Promise<string> {
    const persona = this.getPersonaForChat(chatId)
    const sections = [this.getPrompt(persona)]

    if (persona === "companion") {
      if (this.isFreeMode(chatId)) sections.push(FREE_MODE_FRAGMENT)

      if (chatId && this.isAdaptive(chatId)) {
        const style = await styleService.getStyleGuidance(chatId)
        if (style) sections.push(style)
      }

      sections.push(LENGTH_FRAGMENT)
    }

    return sections.join("\n\n")
  }

  /**
   * Companion mode is inherently proactive: it joins group conversation when it
   * has something worth adding, rather than waiting to be tagged. Callers use
   * this instead of reading `contextualGroupResponses` directly.
   */
  public isProactive(chatId?: string): boolean {
    return this.getPersonaForChat(chatId) === "companion"
  }
}

export const personaService = new PersonaService()
