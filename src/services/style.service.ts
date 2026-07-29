import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"
import { databaseService } from "@/services/database.service"
import { countWords } from "@/utils/text.utils"

const logger = createLogger(config.LOG_LEVEL, "StyleService")

/**
 * Builds a picture of how a particular chat writes, so the bot can match it.
 *
 * This is computed statistically from messages already in the database — no LLM
 * call, so adapting to a group's voice costs nothing per message. The result is
 * cached briefly because a chat's register changes over days, not seconds.
 */

/** Messages sampled per chat when profiling. */
const SAMPLE_SIZE = 120
/** How long a computed profile stays fresh. */
const CACHE_TTL_MS = 10 * 60 * 1000
/** Below this many messages a profile is too noisy to be worth using. */
const MIN_MESSAGES = 8

/** Chat shorthand worth mirroring when a group actually uses it. */
const CHAT_SHORTHAND = [
  "lol", "lmao", "haha", "hahaha", "btw", "idk", "tbh", "omg", "ngl", "fr",
  "imo", "brb", "ikr", "smh", "thx", "pls", "plz", "nah", "yeah", "yep",
  "yup", "bruh", "bro", "mate", "dude", "ok", "okay", "wtf", "af", "rn",
]

// Extended_Pictographic covers emoji proper without dragging in punctuation,
// and avoids hand-rolled code-point ranges that are easy to get subtly wrong.
const EMOJI_PATTERN = /\p{Extended_Pictographic}/gu

/**
 * True when the text contains a letter outside basic ASCII — a cheap signal that
 * the chat is (at least partly) not in English. Checked letter-by-letter rather
 * than with a code-point range, so accents, Cyrillic, Arabic and CJK all count
 * while dashes, quotes and other typographic punctuation do not.
 */
function hasNonLatinLetters(text: string): boolean {
  for (const ch of text) {
    if (ch.charCodeAt(0) > 127 && /\p{L}/u.test(ch)) return true
  }
  return false
}

export interface StyleProfile {
  sampleSize: number
  avgWords: number
  emojiPerMessage: number
  lowercaseRate: number
  questionRate: number
  exclamationRate: number
  shorthand: string[]
  nonLatinRate: number
}

interface CacheEntry {
  profile: StyleProfile | null
  computedAt: number
}

export class StyleService {
  private cache: Map<string, CacheEntry> = new Map()

  /** Profile a chat, or null when there is not enough to go on. */
  public getProfile(chatId: string): StyleProfile | null {
    const cached = this.cache.get(chatId)
    if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
      return cached.profile
    }

    let profile: StyleProfile | null = null
    try {
      profile = this.computeProfile(chatId)
    } catch (err) {
      logger.warn(`Failed to profile style for ${chatId}`, err)
    }

    this.cache.set(chatId, { profile, computedAt: Date.now() })
    return profile
  }

  private computeProfile(chatId: string): StyleProfile | null {
    // The bot's own messages are excluded: it should mirror the people in the
    // chat, not drift toward reinforcing its own previous style.
    const messages = databaseService
      .getMessages(chatId, SAMPLE_SIZE)
      .filter((m) => m.sender !== "Bot" && (m.text || "").trim().length > 0)

    if (messages.length < MIN_MESSAGES) return null

    let totalWords = 0
    let emojiCount = 0
    let lowercaseOnly = 0
    let questions = 0
    let exclamations = 0
    let nonLatin = 0
    const shorthandSeen = new Map<string, number>()

    for (const message of messages) {
      const text = message.text
      totalWords += countWords(text)
      emojiCount += (text.match(EMOJI_PATTERN) || []).length

      // "No capitals anywhere" is a strong, easily-mirrored register signal.
      if (text === text.toLowerCase() && /[a-z]/.test(text)) lowercaseOnly++
      if (text.includes("?")) questions++
      if (text.includes("!")) exclamations++
      // Letters outside the basic Latin range suggest another language/script.
      if (hasNonLatinLetters(text.replace(EMOJI_PATTERN, ""))) {
        nonLatin++
      }

      const words = text.toLowerCase().match(/[a-z']+/g) || []
      for (const word of words) {
        if (CHAT_SHORTHAND.includes(word)) {
          shorthandSeen.set(word, (shorthandSeen.get(word) || 0) + 1)
        }
      }
    }

    const count = messages.length
    const shorthand = Array.from(shorthandSeen.entries())
      // Only mirror expressions that are genuinely habitual here.
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([word]) => word)

    return {
      sampleSize: count,
      avgWords: totalWords / count,
      emojiPerMessage: emojiCount / count,
      lowercaseRate: lowercaseOnly / count,
      questionRate: questions / count,
      exclamationRate: exclamations / count,
      shorthand,
      nonLatinRate: nonLatin / count,
    }
  }

  /**
   * Render a profile as prompt guidance. Deliberately describes the register
   * rather than supplying phrases to copy — a bot parroting the group's exact
   * wording reads as mockery, not rapport.
   */
  public describe(profile: StyleProfile | null): string {
    if (!profile) return ""

    const lines: string[] = []

    const words = Math.round(profile.avgWords)
    if (profile.avgWords < 8) {
      lines.push(`- Messages here are short — about ${words} words. Match that; one line is normal.`)
    } else if (profile.avgWords < 20) {
      lines.push(`- Messages here average about ${words} words. Keep to a sentence or two.`)
    } else {
      lines.push(`- People here write longer messages (about ${words} words), but still stay conversational.`)
    }

    if (profile.emojiPerMessage >= 0.6) {
      lines.push("- Emoji are used a lot. Use them naturally too.")
    } else if (profile.emojiPerMessage >= 0.15) {
      lines.push("- Emoji show up occasionally. The odd one fits; do not overdo it.")
    } else {
      lines.push("- This group rarely uses emoji. Mostly skip them.")
    }

    if (profile.lowercaseRate > 0.5) {
      lines.push("- People mostly type in lowercase and punctuate loosely. Do the same — no tidy capitalisation.")
    }

    if (profile.exclamationRate > 0.35) {
      lines.push("- The tone is energetic and exclamatory.")
    }

    if (profile.shorthand.length) {
      lines.push(
        `- Shorthand that is normal here: ${profile.shorthand.join(", ")}. Use it where it fits naturally.`
      )
    }

    if (profile.nonLatinRate > 0.2) {
      lines.push(
        "- People often write in a language other than English, and sometimes mix languages. Always reply in the language of the message you are answering."
      )
    }

    if (!lines.length) return ""

    return `HOW THIS GROUP WRITES (matched from their recent messages — blend in, do not imitate anyone or copy their exact phrases):
${lines.join("\n")}`
  }

  /** Convenience: the guidance block for a chat, or "" when not worth adding. */
  public getStyleGuidance(chatId: string): string {
    return this.describe(this.getProfile(chatId))
  }

  /** Drop cached profiles (used when a chat's memory is cleared). */
  public invalidate(chatId?: string): void {
    if (chatId) this.cache.delete(chatId)
    else this.cache.clear()
  }
}

export const styleService = new StyleService()
