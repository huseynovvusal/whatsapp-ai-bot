import { countWords } from "@/utils/text.utils"

/**
 * Delivery mechanics that make a message read as typed rather than generated.
 *
 * The prompts were never the loudest tell. These were:
 *  - every reply quoted the message it answered (people rarely quote in chat)
 *  - the "typing" indicator lasted exactly as long as the API call, whether the
 *    reply was three words or three sentences
 *  - every reply arrived as one tidy message
 */

/** Words per minute a fastish phone typist manages. */
const TYPING_WPM = 45
/** Never hold the indicator longer than this, however long the reply. */
const MAX_TYPING_MS = 7_000
/** Even a one-word reply takes a moment. */
const MIN_TYPING_MS = 700
/** Pause before the indicator appears at all — reading the message. */
const READ_MS_PER_WORD = 90
const MAX_READ_MS = 3_000

/** ±20% so the timing never looks metronomic. */
function jitter(ms: number, random: () => number = Math.random): number {
  return Math.round(ms * (0.8 + random() * 0.4))
}

/** How long to appear to be reading before starting to type. */
export function readDelayMs(incomingText: string, random: () => number = Math.random): number {
  const words = countWords(incomingText)
  return jitter(Math.min(MAX_READ_MS, 250 + words * READ_MS_PER_WORD), random)
}

/** How long to hold the typing indicator for a reply of this length. */
export function typingDelayMs(replyText: string, random: () => number = Math.random): number {
  const words = countWords(replyText)
  const raw = (words / TYPING_WPM) * 60_000
  return jitter(Math.min(MAX_TYPING_MS, Math.max(MIN_TYPING_MS, raw)), random)
}

/**
 * Should this reply quote the message it answers?
 *
 * People quote to disambiguate — when the conversation has moved on and it would
 * otherwise be unclear what they are responding to. Quoting every time is a bot
 * tell, and it was previously unconditional because `quotedMessage` is always
 * populated.
 */
export function shouldQuote(options: {
  isGroup: boolean
  /** Messages that arrived after the one being answered. */
  messagesSince: number
  /** True when the bot was directly addressed. */
  wasAddressed: boolean
  /**
   * True when the bot picked one particular message out of several to answer —
   * the model named it, or the message is not the most recent one in the chat.
   * This is exactly the case where a person taps "reply" on WhatsApp.
   */
  answeringSpecificMessage?: boolean
}): boolean {
  // In a one-to-one chat there is never anything to disambiguate.
  if (!options.isGroup) return false
  // Answering one message out of several: quote it, the way a person would.
  if (options.answeringSpecificMessage) return true
  // The thread has moved on, so it is no longer obvious what this answers.
  if (options.messagesSince >= 1) return true
  // Answering a direct mention immediately needs no quote.
  return false
}

/**
 * Length below which a reply is always sent as one message. Most chat messages
 * are shorter than this, so most replies are never split — which is the point.
 */
const BURST_MIN_CHARS = 190
/** Each part of a split reply has to be worth being its own message. */
const BURST_MIN_PART_CHARS = 60

/**
 * Split a reply into the messages a person would actually send.
 *
 * Almost always: one. The previous version split anything over 80 characters
 * into up to three parts, so nearly every reply arrived as a burst of three —
 * which reads as *more* mechanical than a single message, not less, because it
 * happened every single time regardless of what was being said.
 *
 * Now a reply is only broken up when it is genuinely long *and* has a real
 * boundary to break on, and never into more than two messages. Anything with a
 * list, code or a link is left intact — those read worse in pieces.
 */
export function splitIntoBursts(text: string, maxParts: number = 2): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  // Leave structured content intact.
  if (/https?:\/\/|```|^\s*[-*\d]\.?\s/m.test(trimmed)) return [trimmed]
  if (trimmed.length < BURST_MIN_CHARS || maxParts < 2) return [trimmed]

  const sentences = trimmed.match(/[^.!?]+[.!?]*\s*/g)?.map((s) => s.trim()).filter(Boolean)
  // Two sentences are a thought and its qualifier; people send those together.
  // Three or more is where a natural "…and also" break actually exists.
  if (!sentences || sentences.length < 3) return [trimmed]

  // Break at the sentence boundary nearest the middle, so both halves are
  // substantial rather than one long message and a stray fragment.
  const target = trimmed.length / 2
  let bestIndex = -1
  let bestDistance = Infinity
  let consumed = 0
  for (let i = 0; i < sentences.length - 1; i++) {
    consumed += sentences[i].length + 1
    const distance = Math.abs(consumed - target)
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = i
    }
  }
  if (bestIndex < 0) return [trimmed]

  const head = sentences.slice(0, bestIndex + 1).join(" ").trim()
  const tail = sentences.slice(bestIndex + 1).join(" ").trim()

  // A split that produces a scrap is worse than no split at all.
  if (head.length < BURST_MIN_PART_CHARS || tail.length < BURST_MIN_PART_CHARS) return [trimmed]
  if (countWords(tail) <= 3) return [trimmed]

  return [head, tail]
}

/** Pause between two bursts — long enough to read as separate typing. */
export function burstGapMs(nextPart: string, random: () => number = Math.random): number {
  return typingDelayMs(nextPart, random)
}

/**
 * A short note on local time and how long the chat has been quiet.
 *
 * Cheap, and it lets the bot notice that it is 3am or that nobody has spoken
 * since yesterday — things a person is always aware of and a bot never is.
 */
export function describeTiming(lastMessageAt: number | null, now: Date = new Date()): string {
  const hour = now.getHours()
  const partOfDay =
    hour < 5 ? "the middle of the night" :
    hour < 12 ? "morning" :
    hour < 18 ? "afternoon" :
    hour < 22 ? "evening" : "late evening"

  const clock = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  const lines = [`It is ${clock} (${partOfDay}) where the bot is.`]

  if (lastMessageAt) {
    const gapMs = now.getTime() - lastMessageAt
    const minutes = Math.round(gapMs / 60000)
    if (minutes >= 60 * 24) {
      lines.push(`The chat has been quiet for about ${Math.round(minutes / (60 * 24))} day(s).`)
    } else if (minutes >= 60) {
      lines.push(`The chat has been quiet for about ${Math.round(minutes / 60)} hour(s).`)
    } else if (minutes >= 10) {
      lines.push(`The chat has been quiet for about ${minutes} minutes.`)
    }
  }

  return lines.join(" ")
}

/**
 * Discourage the model from opening the same way every time.
 * Repeating sentence shapes is one of the clearest bot rhythms.
 */
export function avoidRepeatOpeners(recentReplies: string[]): string {
  const openers = recentReplies
    .map((reply) => reply.trim().split(/\s+/).slice(0, 3).join(" "))
    .filter(Boolean)
  if (!openers.length) return ""
  const unique = Array.from(new Set(openers)).slice(0, 5)
  return `You recently opened messages with: ${unique.map((o) => `"${o}…"`).join(", ")}. Start this one differently.`
}
