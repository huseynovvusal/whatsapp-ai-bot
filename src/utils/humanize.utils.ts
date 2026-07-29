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
}): boolean {
  // In a one-to-one chat there is never anything to disambiguate.
  if (!options.isGroup) return false
  // The thread has moved on: quoting is genuinely helpful now.
  if (options.messagesSince >= 2) return true
  // Answering a direct mention immediately needs no quote.
  return false
}

/**
 * Split a reply into the two or three short messages a person would actually
 * send, rather than one tidy paragraph.
 *
 * Conservative on purpose: only splits when there are clear sentence boundaries
 * and the whole thing is long enough to be worth breaking up. Anything with a
 * list, code or a link is left alone — those read worse in pieces.
 */
export function splitIntoBursts(text: string, maxParts: number = 3): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  // Leave structured content intact.
  if (/https?:\/\/|```|^\s*[-*\d]\.?\s/m.test(trimmed)) return [trimmed]
  if (trimmed.length < 80) return [trimmed]

  const sentences = trimmed.match(/[^.!?]+[.!?]*\s*/g)?.map((s) => s.trim()).filter(Boolean)
  if (!sentences || sentences.length < 2) return [trimmed]

  // Group sentences into at most `maxParts` roughly even chunks.
  const parts: string[] = []
  const perPart = Math.ceil(sentences.length / Math.min(maxParts, sentences.length))
  for (let i = 0; i < sentences.length; i += perPart) {
    const part = sentences.slice(i, i + perPart).join(" ").trim()
    if (part) parts.push(part)
  }

  // A trailing fragment of one or two words belongs with the previous message.
  if (parts.length > 1 && countWords(parts[parts.length - 1]) <= 2) {
    const tail = parts.pop() as string
    parts[parts.length - 1] = `${parts[parts.length - 1]} ${tail}`.trim()
  }

  return parts.length ? parts : [trimmed]
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
