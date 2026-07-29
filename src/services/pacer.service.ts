import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"
import { runtimeConfig } from "@/services/runtimeConfig.service"

const logger = createLogger(config.LOG_LEVEL, "ConversationPacer")

/**
 * Decides *when* Companion mode is allowed to consider speaking.
 *
 * The problem this solves: previously every group message was evaluated
 * independently and immediately — one LLM decision per message, answered on the
 * spot. Nobody participates in a group that way. A person reads a burst of
 * messages, responds to the thread rather than the line, does not interrupt an
 * active exchange between other people, and lets plenty of moments pass.
 *
 * Three mechanisms, which compose:
 *
 *  1. **Settle window.** Messages are buffered and the timer is extended while
 *     people are still talking. Only when the chat goes quiet is the accumulated
 *     burst evaluated, once. This is what produces "five messages went by before
 *     they answered", and it also cuts decision-call cost several-fold, since a
 *     busy burst costs one call instead of one per message.
 *
 *  2. **Participation budget.** A ceiling on the bot's share of a chat. Even
 *     when a reply would be reasonable, it stays quiet if it has been talking
 *     too much lately. This is the main "how chatty is it" dial.
 *
 *  3. **Pace awareness.** The settle window stretches when a chat is busy, and
 *     the current pace is reported to the caller so it can be put in the prompt —
 *     a lively three-way exchange rarely needs a fourth voice.
 *
 * Direct mentions never come through here; being addressed gets a prompt answer.
 */

/** How chatty Companion is allowed to be, as a share of recent messages. */
export const CHATTINESS_LEVELS = {
  selective: 0.1,
  present: 0.2,
  talkative: 0.3,
} as const

export type Chattiness = keyof typeof CHATTINESS_LEVELS

export const CHATTINESS_LABELS: Record<Chattiness, string> = {
  selective: "Selective (~10%)",
  present: "Present (~20%)",
  talkative: "Talkative (~30%)",
}

export function isChattiness(value: unknown): value is Chattiness {
  return typeof value === "string" && value in CHATTINESS_LEVELS
}

/** Settle window bounds. The actual wait scales with how busy the chat is. */
const SETTLE_MIN_MS = 4_000
const SETTLE_MAX_MS = 35_000
/** A burst is force-evaluated once it reaches this age, however busy the chat. */
const MAX_BURST_AGE_MS = 90_000
/** Messages considered when measuring pace and the bot's share. */
const ACTIVITY_WINDOW_MS = 5 * 60 * 1000
const SHARE_WINDOW_MS = 30 * 60 * 1000

interface PendingBurst<T> {
  items: T[]
  timer: NodeJS.Timeout
  firstArrivedAt: number
}

/** One entry per message seen in a chat, used for pace and share maths. */
interface ActivityEntry {
  at: number
  fromBot: boolean
}

export interface ChatPace {
  /** Messages in the recent activity window. */
  recentMessages: number
  /** Distinct human speakers in that window. */
  speakers: number
  /** Messages per minute. */
  rate: number
  /** The bot's share of recent messages, 0-1. */
  botShare: number
  /** A short line describing the pace, for the decision prompt. */
  description: string
}

export class ConversationPacer<T = unknown> {
  private pending: Map<string, PendingBurst<T>> = new Map()
  private activity: Map<string, ActivityEntry[]> = new Map()

  /** Configured ceiling on the bot's share of a chat. */
  public getChattinessTarget(chatId?: string, override?: Chattiness | null): number {
    if (override && isChattiness(override)) return CHATTINESS_LEVELS[override]
    const configured = runtimeConfig.get("companionChattiness")
    return isChattiness(configured) ? CHATTINESS_LEVELS[configured] : CHATTINESS_LEVELS.selective
  }

  /** Record that a message was seen, so pace and share stay current. */
  public noteMessage(chatId: string, fromBot: boolean): void {
    const entries = this.activity.get(chatId) || []
    entries.push({ at: Date.now(), fromBot })
    // Trim to the longest window anything here needs.
    const cutoff = Date.now() - SHARE_WINDOW_MS
    this.activity.set(
      chatId,
      entries.filter((e) => e.at >= cutoff)
    )
  }

  public getPace(chatId: string): ChatPace {
    const now = Date.now()
    const entries = this.activity.get(chatId) || []
    const recent = entries.filter((e) => e.at >= now - ACTIVITY_WINDOW_MS)
    const forShare = entries.filter((e) => e.at >= now - SHARE_WINDOW_MS)

    const humanRecent = recent.filter((e) => !e.fromBot)
    const rate = recent.length / (ACTIVITY_WINDOW_MS / 60000)
    const botShare = forShare.length ? forShare.filter((e) => e.fromBot).length / forShare.length : 0

    // Speaker count is not tracked per person here; the handler passes richer
    // context separately. This is a coarse "is more than one person talking".
    const speakers = humanRecent.length > 1 ? 2 : humanRecent.length

    let description: string
    if (rate >= 6) {
      description = `This chat is busy right now (${Math.round(rate)} messages/min). An active exchange rarely needs another voice.`
    } else if (rate >= 2) {
      description = `This chat is moderately active (${rate.toFixed(1)} messages/min).`
    } else if (recent.length > 0) {
      description = "This chat is quiet right now."
    } else {
      description = "This chat has been silent for a while."
    }

    return { recentMessages: recent.length, speakers, rate, botShare, description }
  }

  /**
   * How long to wait for the conversation to settle.
   * Quiet chats get a short pause; busy ones are given room to run.
   */
  public getSettleMs(chatId: string): number {
    const { rate } = this.getPace(chatId)
    // ~4s when silent, rising to the cap as the chat gets busier.
    const scaled = SETTLE_MIN_MS + rate * 4_000
    return Math.round(Math.min(SETTLE_MAX_MS, Math.max(SETTLE_MIN_MS, scaled)))
  }

  /**
   * Buffer a message and (re)arm the settle timer. `onSettled` is invoked with
   * the whole burst once the chat goes quiet — never once per message.
   */
  public enqueue(chatId: string, item: T, onSettled: (items: T[]) => void): void {
    const existing = this.pending.get(chatId)
    const firstArrivedAt = existing?.firstArrivedAt ?? Date.now()

    if (existing) clearTimeout(existing.timer)
    const items = existing ? [...existing.items, item] : [item]

    // A chat that never pauses would otherwise defer forever, so a burst is
    // forced through once it gets old enough.
    const age = Date.now() - firstArrivedAt
    const wait = Math.max(500, Math.min(this.getSettleMs(chatId), MAX_BURST_AGE_MS - age))

    const timer = setTimeout(() => {
      this.pending.delete(chatId)
      try {
        onSettled(items)
      } catch (err) {
        logger.warn(`Burst handler failed for ${chatId}`, err)
      }
    }, wait)
    // Never hold the process open just for a pending burst.
    timer.unref?.()

    this.pending.set(chatId, { items, timer, firstArrivedAt })
    logger.debug(`Buffered message for ${chatId}; ${items.length} pending, settling in ${wait}ms`)
  }

  /**
   * Whether the bot may speak, given how much of the chat it already is.
   * Returns the reason when it may not, for the debug log.
   */
  public checkBudget(
    chatId: string,
    override?: Chattiness | null
  ): { allowed: boolean; botShare: number; target: number; reason?: string } {
    const target = this.getChattinessTarget(chatId, override)
    const { botShare } = this.getPace(chatId)
    if (botShare >= target) {
      return {
        allowed: false,
        botShare,
        target,
        reason: `bot is ${Math.round(botShare * 100)}% of recent messages, ceiling is ${Math.round(target * 100)}%`,
      }
    }
    return { allowed: true, botShare, target }
  }

  /** How many messages have arrived in a chat since a given moment. */
  public messagesSince(chatId: string, since: number): number {
    return (this.activity.get(chatId) || []).filter((e) => e.at > since && !e.fromBot).length
  }

  /** Drop all state for a chat (used when its memory is cleared). */
  public reset(chatId?: string): void {
    if (chatId) {
      const existing = this.pending.get(chatId)
      if (existing) clearTimeout(existing.timer)
      this.pending.delete(chatId)
      this.activity.delete(chatId)
      return
    }
    for (const burst of this.pending.values()) clearTimeout(burst.timer)
    this.pending.clear()
    this.activity.clear()
  }

  /** Test/introspection helper. */
  public pendingCount(chatId: string): number {
    return this.pending.get(chatId)?.items.length || 0
  }
}

export const conversationPacer = new ConversationPacer<import("@/services/whatsapp.service").MessageInfo>()
