import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { databaseService } from "@/services/database.service"

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
 * Resolves which personality applies to a chat, and the prompt that goes with it.
 *
 * A chat may carry its own override (set from the Conversations tab); otherwise
 * the global default applies. Prompts are stored per persona, so switching a chat
 * between modes swaps the whole voice without editing any text.
 */
export class PersonaService {
  /** Global default, used by any chat without an explicit override. */
  public getDefaultPersona(): Persona {
    const value = runtimeConfig.get("defaultPersona") as Persona | undefined
    return value && PERSONAS.includes(value) ? value : "assistant"
  }

  /** The persona in force for a chat: its override, else the global default. */
  public getPersonaForChat(chatId?: string): Persona {
    if (chatId) {
      try {
        const override = databaseService.getChatPersona(chatId)
        if (override && PERSONAS.includes(override)) return override
      } catch (err) {
        logger.warn(`Failed to read persona override for ${chatId}`, err)
      }
    }
    return this.getDefaultPersona()
  }

  /** Set (or with `null`, clear) a chat's override. */
  public setPersonaForChat(chatId: string, persona: Persona | null): void {
    if (persona === null) {
      databaseService.clearChatPersona(chatId)
      logger.info(`Persona override cleared for ${chatId}`)
      return
    }
    databaseService.setChatPersona(chatId, persona)
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

  /** The prompt a given chat should be answered with. */
  public getPromptForChat(chatId?: string): string {
    return this.getPrompt(this.getPersonaForChat(chatId))
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
