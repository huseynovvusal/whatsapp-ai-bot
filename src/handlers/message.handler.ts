import { MessageInfo, whatsappService } from "@/services/whatsapp.service"
import { cleanPhoneNumber as cleanPhoneFromJid } from "@/utils/phone.utils"
import { parseMentions, stripBotName } from "@/utils/mention.utils"
import { memoryService } from "@/services/memory.service"
import { llmService, LLMError } from "@/services/llm.service"
import { rateLimiter } from "@/services/ratelimit.service"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { databaseService } from "@/services/database.service"
import { AdminUtils } from "@/utils/admin.utils"
import { ragService, isWorthRetrieving } from "@/services/rag.service"
import { budgetService } from "@/services/budget.service"
import {
  conversationPacer,
  isChattiness,
  CHATTINESS_LABELS,
  Chattiness,
} from "@/services/pacer.service"
import {
  readDelayMs,
  typingDelayMs,
  shouldQuote,
  splitIntoBursts,
  burstGapMs,
  describeTiming,
  avoidRepeatOpeners,
} from "@/utils/humanize.utils"
import { personaService, PERSONA_LABELS } from "@/services/persona.service"
import { groupMemoryService } from "@/services/groupMemory.service"
import { sanitiseEmoji } from "@/utils/emoji.utils"
import { trimToLength } from "@/utils/text.utils"
import { createLogger } from "@/lib/logger"
import { config } from "@/config/env"

const logger = createLogger(config.LOG_LEVEL, "MessageHandler")

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Cap on how many group members are listed in the prompt.
 *
 * Sized so an ordinary group is listed in full — the cap only bites on the large
 * groups where the list was dominating the prompt.
 */
const MAX_LISTED_MEMBERS = 25

/**
 * Is there anything in this burst a person could actually respond to?
 *
 * Deliberately conservative — the previous round of work was about the bot being
 * too *silent*, so this only skips bursts where every message is an
 * acknowledgement or a bare emoji, and never when the bot was addressed. Anything
 * with a question mark, or any message of real length, goes to the model.
 */
function burstHasSubstance(burst: MessageInfo[]): boolean {
  return burst.some((m) => {
    if (m.isMentioned || m.isReplyToBot) return true
    // Media has content even when the caption is empty.
    if (m.media) return true
    const text = (m.text || "").trim()
    if (text.includes("?")) return true
    return isWorthRetrieving(text)
  })
}

/** How a reply should be delivered, once the decision to reply has been made. */
interface ReplyOptions {
  /** Messages that arrived after the one being answered. */
  movedOn?: number
  /** The message to quote, when it is not the one that triggered the reply. */
  quoteTarget?: MessageInfo
  /** The bot picked one message out of several — quote it, as a person would. */
  answeringSpecificMessage?: boolean
}

export class MessageHandler {
  /**
   * The bot's own recent replies per chat, used to stop it opening every message
   * the same way.
   */
  private recentReplies: Map<string, string[]> = new Map()
  /** When each chat last saw any message, for the "how long has it been" note. */
  private lastMessageAt: Map<string, number> = new Map()
  /**
   * Check access control - returns true if allowed, false if blocked
   */
  private async checkAccessControl(info: MessageInfo): Promise<boolean> {
    const accessMode = (runtimeConfig.get("accessControlMode") as string) || config.ACCESS_CONTROL_MODE

    // Admins always have access
    if (AdminUtils.isAdmin(info.sender)) {
      return true
    }

    // If disabled, allow all
    if (accessMode === "disabled") {
      return true
    }

    // Check whitelist mode
    if (accessMode === "whitelist") {
      return databaseService.isWhitelisted(info.from)
    }

    // Check blacklist mode
    if (accessMode === "blacklist") {
      return !(await databaseService.isBlacklisted(info.from))
    }

    return true
  }

  /**
   * Decide whether the bot may reply to this message, before anything is sent.
   *
   * Every "should we speak" rule lives here so that no outbound side effect —
   * not a reply, not a typing indicator, not even an emoji reaction — can happen
   * in a chat the operator has switched off. Previously the 👀 reaction was sent
   * before the private-chat check, so disabling private replies still produced a
   * visible reaction.
   */
  private decideResponse(info: MessageInfo): {
    respond: boolean
    mode: "direct" | "contextual"
    reason: string
  } {
    const no = (reason: string) => ({ respond: false, mode: "direct" as const, reason })

    if (info.isGroup) {
      // Being mentioned or replied to is always an explicit invitation.
      if (info.isMentioned || info.isReplyToBot) {
        return { respond: true, mode: "direct", reason: "mentioned or replied to" }
      }
      // Companion mode is proactive by nature: it decides for itself whether a
      // message is worth joining, regardless of the group-response setting.
      if (personaService.isProactive(info.from)) {
        return { respond: true, mode: "contextual", reason: "companion mode" }
      }
      if (runtimeConfig.get("respondToGroupMessages") !== true) {
        return no("group responses are limited to mentions")
      }
      return runtimeConfig.get("contextualGroupResponses") === true
        ? { respond: true, mode: "contextual", reason: "contextual group mode" }
        : { respond: true, mode: "direct", reason: "respond-to-all group mode" }
    }

    if (runtimeConfig.get("enablePrivateChat") === false) {
      return no("private chat responses are disabled")
    }
    return { respond: true, mode: "direct", reason: "private chat" }
  }

  /** Rate-limit gate. Admins are exempt. Returns null when allowed. */
  private rateLimitMessage(info: MessageInfo): string | null {
    if (AdminUtils.isAdmin(info.sender)) return null
    if (rateLimiter.canMakeRequest(info.sender)) return null
    const waitTime = rateLimiter.getTimeUntilReset(info.sender)
    const maxRequests =
      Number(runtimeConfig.get("rateLimitMaxRequests")) || config.RATE_LIMIT_MAX_REQUESTS
    return `⏱️ Slow down! You can only message me ${maxRequests} times in the configured time window. Try again in ${waitTime} seconds.`
  }

  /**
   * React to the incoming message, if reactions are switched on.
   * Never throws — a failed reaction must not stop the actual reply.
   */
  private async react(info: MessageInfo, emoji?: string): Promise<void> {
    if (runtimeConfig.get("emojiReactions") === false) return
    // Validated here as well as at the parse site: this is the last point before
    // the value reaches WhatsApp, so no caller can send an invalid reaction.
    const safe = sanitiseEmoji(emoji)
    if (!safe) {
      if (emoji) logger.debug(`Discarded invalid reaction: ${JSON.stringify(emoji)}`)
      return
    }
    try {
      await whatsappService.sendReaction(info.from, info.quotedMessage?.key, safe)
    } catch (err) {
      logger.debug("Reaction failed", err)
    }
  }

  /**
   * Emoji for acknowledging a message the bot is about to answer — Assistant
   * mode only.
   *
   * A read-receipt reaction is a *bot* gesture: it says "request received,
   * working on it". People do not do it. In Companion mode it was the loudest
   * remaining tell — tag it and 👀 appeared instantly, every time, before a word
   * of the reply existed. Companion still reacts, but only when the model
   * decides a message is worth reacting to (see `evaluateBurst`), which is how
   * reactions are actually used.
   */
  private pickAcknowledgementEmoji(info: MessageInfo): string | undefined {
    if (personaService.isProactive(info.from)) return undefined
    return "👀"
  }

  /**
   * A beat between being tagged and starting to type.
   *
   * Companion answers a mention the instant it arrives, which no person does —
   * they notice, finish what they were doing, and come back. The typing
   * indicator then covers the rest of the wait, so this only has to cover
   * "noticing".
   */
  private async pauseBeforeAnswering(info: MessageInfo): Promise<void> {
    if (!personaService.isProactive(info.from)) return
    if (runtimeConfig.get("humanTiming") === false) return
    const delay = 1_500 + Math.random() * 4_000
    logger.debug(`Noticing the mention in ${info.from} for ${Math.round(delay / 1000)}s`)
    await sleep(delay)
  }

  /**
   * Enforce the reply-length ceiling. Returns the text unchanged when there is
   * no limit or it already fits.
   */
  private shapeReply(text: string, maxChars: number): string {
    if (!maxChars || maxChars <= 0) return text
    const shaped = trimToLength(text, maxChars)
    if (shaped.length < text.trim().length) {
      logger.debug(`Trimmed reply from ${text.trim().length} to ${shaped.length} chars`)
    }
    return shaped
  }

  /**
   * Send text. Quotes only when a person would — see shouldQuote().
   *
   * `quotedMessage` is populated for every incoming message, so the old
   * implementation quote-replied to everything, which is one of the most
   * visible bot tells in a group.
   */
  private async reply(
    info: MessageInfo,
    text: string,
    mentionedJids?: string[],
    options: ReplyOptions = {}
  ): Promise<void> {
    // When the model singled out one message in a burst, that message is what
    // gets quoted — not merely the last one to arrive.
    const target = options.quoteTarget?.quotedMessage || info.quotedMessage
    const quote =
      target &&
      shouldQuote({
        isGroup: info.isGroup,
        messagesSince: options.movedOn ?? 0,
        wasAddressed: info.isMentioned || info.isReplyToBot,
        answeringSpecificMessage: options.answeringSpecificMessage,
      })

    if (quote && target) {
      await whatsappService.sendReply(info.from, text, target, mentionedJids)
    } else {
      await whatsappService.sendMessage(info.from, text, mentionedJids)
    }
  }

  /**
   * Deliver a reply the way a person would: a beat to read it, the typing
   * indicator held for as long as the text would actually take to type, and
   * longer replies broken into the two or three messages someone would send.
   *
   * Falls back to a plain single send when human timing is switched off.
   */
  private async sendHumanReply(
    info: MessageInfo,
    text: string,
    mentionedJids: string[],
    options: ReplyOptions = {}
  ): Promise<void> {
    const humanTiming = runtimeConfig.get("humanTiming") !== false
    const remember = (sent: string) => {
      const recent = this.recentReplies.get(info.from) || []
      recent.push(sent)
      this.recentReplies.set(info.from, recent.slice(-5))
    }

    if (!humanTiming) {
      await this.reply(info, text, mentionedJids, options)
      await memoryService.addMessage(info.from, "Bot", text, "Bot")
      conversationPacer.noteMessage(info.from, true)
      remember(text)
      return
    }

    // Read the message before starting to type.
    await sleep(readDelayMs(info.text))

    const parts = splitIntoBursts(text)
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (i > 0) await sleep(burstGapMs(part))

      await whatsappService.sendPresenceUpdate("composing", info.from)
      await sleep(typingDelayMs(part))
      await whatsappService.sendPresenceUpdate("paused", info.from)

      // Only the first part quotes; the rest are follow-ups in the same breath.
      // Mentions ride on the first message so nobody is pinged repeatedly.
      await this.reply(info, part, i === 0 ? mentionedJids : undefined, i === 0 ? options : {})
      await memoryService.addMessage(info.from, "Bot", part, "Bot")
      conversationPacer.noteMessage(info.from, true)
      remember(part)
    }
  }

  /**
   * Handle incoming WhatsApp message
   */
  public async handle(info: MessageInfo): Promise<void> {
    // Tracks whether we ever committed to replying, so the error handler below
    // stays silent in chats where the bot is not supposed to speak.
    let committedToReply = false

    try {
      const isAdminCommand = info.text.startsWith("!")

      if (!isAdminCommand) {
        if (runtimeConfig.get("botEnabled") !== true) {
          logger.debug(`Bot is disabled, ignoring message from ${info.sender}`)
          return
        }
        if (!(await this.checkAccessControl(info))) {
          logger.info(`Access denied for ${info.sender} in chat ${info.from}`)
          return
        }
      }

      if (isAdminCommand) {
        await this.handleAdminCommand(info)
        return
      }

      // Pace tracking must see every message, including ones we stay quiet on —
      // it is what the settle window and participation budget are measured from.
      conversationPacer.noteMessage(info.from, false)
      const previousMessageAt = this.lastMessageAt.get(info.from) ?? null
      this.lastMessageAt.set(info.from, Date.now())
      void previousMessageAt

      // Always remember the message for context, even if we stay quiet.
      // A bare image or voice note has no caption, so record what was sent
      // rather than storing an empty line that reads as a gap in the history.
      const remembered =
        info.text.trim() ||
        (info.media
          ? info.media.kind === "image"
            ? "[sent an image]"
            : info.media.isVoiceNote
              ? "[sent a voice message]"
              : "[sent an audio clip]"
          : info.text)
      await memoryService.addMessage(info.from, info.sender, remembered, info.senderName)

      // Count the message towards the next rewrite of this chat's standing
      // notes. Detached on purpose — the refresh is an LLM call, and answering
      // must never wait on housekeeping.
      void groupMemoryService.noteMessage(info.from)

      const decision = this.decideResponse(info)
      if (!decision.respond) {
        logger.debug(`Staying quiet in ${info.from}: ${decision.reason}`)
        return
      }

      // Contextual mode decides for itself whether to speak, and stays silent
      // (no reaction, no rate-limit notice) when it decides not to.
      if (decision.mode === "contextual") {
        await this.handleContextualResponse(info)
        return
      }

      // From here on the bot has committed to replying in this chat.
      committedToReply = true

      // Spending ceiling is checked before the rate limit so an exhausted budget
      // reports the real reason rather than looking like ordinary throttling.
      const budget = await budgetService.check()
      if (!budget.allowed) {
        await this.reply(info, budget.reason!)
        return
      }

      const limitMessage = this.rateLimitMessage(info)
      if (limitMessage) {
        await this.reply(info, limitMessage)
        return
      }

      // Acknowledge explicit invitations with a reaction — Assistant only; see
      // pickAcknowledgementEmoji for why Companion does not.
      if (info.isMentioned || info.isReplyToBot) {
        const ack = this.pickAcknowledgementEmoji(info)
        if (ack) await this.react(info, ack)
      }

      // Companion takes a moment to notice it was tagged before it starts typing.
      await this.pauseBeforeAnswering(info)

      await this.handleAIResponse(info)
    } catch (error) {
      logger.error("Error in message handler:", error)
      if (!committedToReply) return
      try {
        // A classified provider failure explains itself ("rate-limited",
        // "credentials not working"); anything else falls back to the generic
        // notice. A user who knows to wait 30s is better served than one who
        // only ever sees "something went wrong".
        const notice =
          error instanceof LLMError
            ? error.userMessage
            : "❌ Sorry, something went wrong. Please try again."
        await whatsappService.sendMessage(info.from, notice)
      } catch (sendErr) {
        logger.error("Failed to deliver the error notice", sendErr)
      }
    }
  }

  /**
   * Contextual mode: buffer the message and let the pacer decide when — or
   * whether — the conversation has settled enough to be worth joining.
   *
   * Nothing is evaluated here. A burst of ten rapid messages costs one decision
   * call once the chat goes quiet, not ten calls as it happens.
   */
  private async handleContextualResponse(info: MessageInfo): Promise<void> {
    conversationPacer.enqueue(info.from, info, (burst) => {
      void this.evaluateBurst(burst)
    })
  }

  /**
   * Evaluate a settled burst of conversation and decide whether to speak.
   * `burst` is every message that arrived while the chat was still active.
   */
  private async evaluateBurst(burst: MessageInfo[]): Promise<void> {
    if (!burst.length) return
    // Answer the thread, so the last message is the anchor for replying.
    const info = burst[burst.length - 1]

    try {
      // Re-check the switches: a burst can settle a minute after it started, and
      // the operator may have disabled the bot in the meantime.
      if (runtimeConfig.get("botEnabled") !== true) return
      if (!personaService.isProactive(info.from)) return

      // How much of this chat is already the bot?
      const budgetCheck = conversationPacer.checkBudget(
        info.from,
        personaService.getChattinessForChat(info.from)
      )
      if (!budgetCheck.allowed) {
        logger.debug(`Staying quiet in ${info.from}: ${budgetCheck.reason}`)
        return
      }

      // The decision call costs tokens, so the spend ceiling gates it too.
      if (!(await budgetService.check()).allowed) return

      // Nothing was said that anyone could answer — skip the call entirely.
      // This is the cheapest possible saving: a burst of "ok" / "haha" / "👍"
      // costs a full-context decision call to be told to stay quiet, which is
      // the answer a person could give without reading anything.
      if (!burstHasSubstance(burst)) {
        logger.debug(`Skipping the decision call in ${info.from}: nothing to respond to`)
        return
      }

      const pace = conversationPacer.getPace(info.from)
      const context = await this.buildContext(info, { burst, pace: pace.description })
      const decision = await llmService.askForReactiveReply(
        this.describeBurst(burst),
        context,
        await memoryService.getSystemPrompt(info.from)
      )

      // Which message it chose to answer, if any. 1-based in the prompt.
      const target =
        decision.replyTo && decision.replyTo >= 1 && decision.replyTo <= burst.length
          ? burst[decision.replyTo - 1]
          : undefined

      // The same call chose an emoji, so acknowledging costs no extra request.
      // Reacting without replying is the quiet, human way to respond — and it is
      // the whole point of allowing a reaction when shouldReply is false.
      if (decision.reaction) await this.react(info, decision.reaction)

      if (!decision.shouldReply) return

      // Silent rate-limit: an unprompted interjection should not nag.
      if (!AdminUtils.isAdmin(info.sender) && !rateLimiter.canMakeRequest(info.sender)) return

      const participants = await this.resolveParticipants(info)
      const shaped = this.shapeReply(
        decision.reply || "",
        personaService.getMaxReplyChars(info.from)
      )
      const { text: finalReply, mentionedJids } = parseMentions(shaped, participants)
      if (!finalReply.trim()) return

      // Optionally hold the reply a while longer, like someone who put their
      // phone down and picked it back up.
      await this.maybeDelayReply(info)

      // The moment may have passed while we were deciding. Dropping the reply is
      // only right when it has gone properly stale — the earlier threshold of
      // four messages threw away perfectly good replies in any lively group, and
      // a late-but-quoted answer reads fine, which is what the quote is for.
      const movedOn = conversationPacer.messagesSince(info.from, info.receivedAt || 0)
      if (movedOn >= 8) {
        logger.debug(`Dropping reply in ${info.from}: conversation moved on (${movedOn} messages)`)
        return
      }

      await this.sendHumanReply(info, finalReply, mentionedJids, {
        movedOn,
        quoteTarget: target,
        // Picking one message out of several, or answering something other than
        // the newest message, is exactly when a person taps "reply".
        answeringSpecificMessage: Boolean(target && (burst.length > 1 || movedOn > 0)),
      })
    } catch (err) {
      logger.warn("Contextual decision failed", err)
    }
  }

  /**
   * Render a settled burst as the "message" the decision call reasons about.
   * Numbered, so the model can point at one of them with `replyTo`.
   */
  private describeBurst(burst: MessageInfo[]): string {
    if (burst.length === 1) return `Message 1 — ${burst[0].senderName || burst[0].sender}: ${burst[0].text}`
    return burst
      .map((m, i) => `Message ${i + 1} — ${m.senderName || m.sender}: ${m.text}`)
      .join("\n")
  }

  /**
   * Occasional late reply, when enabled: a person does not always answer the
   * moment they see something.
   */
  private async maybeDelayReply(info: MessageInfo): Promise<void> {
    if (runtimeConfig.get("companionLateReplies") !== true) return
    // Only sometimes — a bot that is always late is as predictable as one that
    // is always instant.
    if (Math.random() > 0.2) return
    const delay = 60_000 + Math.random() * 120_000
    logger.debug(`Replying late in ${info.from} (${Math.round(delay / 1000)}s)`)
    await sleep(delay)
  }

  /**
   * Everyone in this chat, not just everyone who has spoken in it.
   *
   * `memoryService.getParticipants` is derived from stored messages, so in a
   * group the bot only ever knew the handful of people who had said something
   * recently — it could not name or tag anybody else, and asking it who was in
   * the group got a partial answer. The WhatsApp roster is the real membership,
   * so it is the base, and the conversation supplies the names WhatsApp does not
   * carry. In a private chat there is no roster to fetch, so nothing changes.
   */
  private async resolveParticipants(
    info: MessageInfo
  ): Promise<Array<{ name: string; phone: string; isAdmin?: boolean; hasSpoken?: boolean }>> {
    const fromConversation = memoryService.getParticipants(info.from)
    if (!info.isGroup) return fromConversation

    try {
      const roster = await whatsappService.getGroupParticipants(info.from)
      if (!roster.length) return fromConversation

      // Matched on digits alone. Both sides go through `cleanPhoneNumber` today,
      // so the strings line up — but an exact-string match means any future
      // divergence in formatting would list the same person twice, once from the
      // roster marked "not spoken" and once from the conversation. That is both
      // wrong and paid for by the token.
      const digits = (phone: string) => phone.replace(/\D/g, "")
      const spoken = new Map(fromConversation.map((p) => [digits(p.phone), p.name]))
      const merged = roster.map((member) => ({
        // A name learned from a message is the one people actually use.
        name: spoken.get(digits(member.phone)) || member.name || member.phone,
        phone: member.phone,
        isAdmin: member.isAdmin,
        hasSpoken: spoken.has(digits(member.phone)) || member.hasSpoken,
      }))

      // Anyone in the conversation but not in the roster — a former member whose
      // messages are still in context — is kept rather than dropped.
      const inRoster = new Set(roster.map((m) => digits(m.phone)))
      for (const p of fromConversation) {
        if (!inRoster.has(digits(p.phone))) merged.push({ ...p, isAdmin: false, hasSpoken: true })
      }
      return merged
    } catch (err) {
      logger.debug("Could not fetch the group roster; using known speakers only", err)
      return fromConversation
    }
  }

  /**
   * Render the member list for the prompt, largest useful subset first.
   *
   * A complete roster is the right thing to *know* but the wrong thing to send
   * unconditionally: measured on a 100-member group it was 1,267 tokens, 41% of
   * the whole prompt, repeated on every single message. The people who matter
   * for naming and tagging are the ones who talk, so those go in first, then
   * admins, then everyone else until the cap. Whoever is left is reported as a
   * count — the bot still knows how big the room is, it just does not pay to
   * list 60 people who have never spoken.
   */
  private renderMembers(
    participants: Array<{ name: string; phone: string; isAdmin?: boolean; hasSpoken?: boolean }>
  ): string {
    if (!participants.length) return "No participants tracked yet"

    const rank = (p: { isAdmin?: boolean; hasSpoken?: boolean }) =>
      p.hasSpoken ? 0 : p.isAdmin ? 1 : 2
    const ordered = [...participants].sort((a, b) => rank(a) - rank(b))
    const listed = ordered.slice(0, MAX_LISTED_MEMBERS)
    const omitted = ordered.length - listed.length

    const lines = listed.map(
      (p) =>
        `- ${p.name} (${p.phone})` +
        `${p.isAdmin ? " [group admin]" : ""}${p.hasSpoken === false ? " [not spoken here yet]" : ""}`
    )
    if (omitted > 0) {
      lines.push(`- …and ${omitted} more member(s) who have not spoken in this chat`)
    }
    return lines.join("\n")
  }

  /**
   * Assemble everything the LLM should see for this chat.
   *
   * Order is deliberate and is itself a cost optimisation. Providers cache
   * identical prompt *prefixes*, so anything stable must come first and anything
   * that changes every message must come last. Previously the very first line
   * after the system prompt was the wall-clock time, which changes every minute
   * and made the cacheable prefix end there. Now the stable half — who is in the
   * group, what the bot knows about the chat — leads, and the volatile half —
   * the clock, the pace, recalled memories, the conversation itself — follows.
   * Identical content, materially cheaper on a provider that caches prefixes.
   */
  private async buildContext(
    info: MessageInfo,
    options: { burst?: MessageInfo[]; pace?: string } = {}
  ): Promise<string> {
    const stable: string[] = []
    const volatile: string[] = []
    const participants = await this.resolveParticipants(info)

    // ---- stable: changes only when the group or the bot's notes change ----

    if (info.isGroup) {
      try {
        const g = await whatsappService.getGroupInfo(info.from)
        if (g) {
          stable.push(`Group Metadata:
SUBJECT: ${g.subject || "(no subject)"}${g.description ? `\nDESCRIPTION: ${g.description}` : ""}
OWNER: ${cleanPhoneFromJid(g.owner || "")}
TOTAL PARTICIPANTS: ${g.participantCount || 0}

Members:
${this.renderMembers(participants)}

Instructions: You can mention people by using @Name format (e.g., @John). When you mention someone, make sure to use their exact name as shown in the member list above.`)
        }
      } catch {
        // Group metadata is optional context; carry on without it.
      }
    }

    // Standing notes: what the bot already knows about this chat.
    try {
      const notes = await groupMemoryService.getForPrompt(info.from)
      if (notes) stable.push(notes)
    } catch (err) {
      logger.debug("Could not load standing notes", err)
    }

    // ---- volatile: different on essentially every message ----

    // Awareness a person has for free and a bot otherwise lacks: what time it
    // is, how long the chat has been quiet, and how busy it is right now.
    const timing = describeTiming(this.lastMessageAt.get(info.from) ?? null)
    if (timing) volatile.push(timing)
    if (options.pace) volatile.push(options.pace)

    // Stop it opening every message the same way.
    const variety = avoidRepeatOpeners(this.recentReplies.get(info.from) || [])
    if (variety) volatile.push(variety)

    // When answering a settled burst, say so — the reply should address the
    // exchange as a whole, not just the final line.
    if (options.burst && options.burst.length > 1) {
      volatile.push(
        `${options.burst.length} messages arrived together while you were reading. ` +
          "Respond to the exchange as a whole — you can pick up more than one point, " +
          "or reply to whichever part is actually worth answering."
      )
    }

    // Long-term memory: semantically relevant history beyond the recent window.
    try {
      const memories = await ragService.retrieve(info.text, info.from, {
        // Anything still in short-term memory is already printed verbatim in the
        // recent-conversation block below. Recalling it as well paid for the same
        // text twice and showed the model one exchange in two guises — "just
        // said" and "remembered from earlier" — which is worse than not
        // recalling it at all.
        before: memoryService.getOldestTimestamp(info.from),
      })
      if (memories.length) {
        volatile.push(ragService.formatMemories(memories))
        logger.info(
          `Recalled ${memories.length} memory chunk(s) (best match ${memories[0].score.toFixed(2)})`
        )
      }
    } catch (err) {
      logger.warn("Memory recall failed, continuing without it", err)
    }

    volatile.push(memoryService.getContext(info.from))

    const context = [...stable, ...volatile].join("\n\n")
    logger.debug(
      `Context for ${info.from}: ${context.length} chars (${stable.join("").length} stable, ${volatile.join("").length} volatile)`
    )
    return context
  }


  /**
   * Turn attached media into text the rest of the pipeline can use: an image
   * becomes a description, a voice note becomes its transcript.
   *
   * Returns the effective message text. Media is only downloaded here — after
   * the bot has already decided it is going to reply — so unanswered messages
   * cost no bandwidth.
   */
  private async resolveMedia(info: MessageInfo): Promise<string> {
    if (!info.media) return info.text

    const caption = info.text.trim()

    try {
      const buffer = await info.media.download()

      if (info.media.kind === "image") {
        const question = caption || "Describe this image."
        const description = await llmService.analyzeImage(buffer, question, info.media.mimeType)
        logger.info(`Image interpreted (${buffer.length} bytes)`)
        // Both parts are kept: the caption is what was asked, the description is
        // what the picture shows, and the reply usually needs both.
        return caption
          ? `${caption}\n\n[Image attached. What it shows: ${description}]`
          : `[The user sent an image. What it shows: ${description}]\n\nRespond to the image.`
      }

      const transcript = await llmService.transcribeAudio(buffer, info.media.mimeType)
      if (!transcript) {
        logger.info("Audio contained no intelligible speech")
        return caption || "[The user sent a voice message with no intelligible speech.]"
      }
      logger.info(`Voice message transcribed (${transcript.length} chars)`)
      return caption ? `${caption}\n\n[Voice message: "${transcript}"]` : transcript
    } catch (err) {
      // A media failure should degrade to a normal reply, not kill the response.
      logger.warn(`Could not interpret ${info.media.kind} attachment`, err)
      return caption || `[The user sent ${info.media.kind === "image" ? "an image" : "a voice message"} that could not be read.]`
    }
  }

  /**
   * Handle AI response
   */
  private async handleAIResponse(info: MessageInfo): Promise<void> {
    const systemPrompt = await memoryService.getSystemPrompt(info.from)
    const participants = await this.resolveParticipants(info)
    const context = await this.buildContext(info)

    // Images become descriptions and voice notes become transcripts before the
    // text ever reaches the model.
    const effectiveText = await this.resolveMedia(info)

    // Drop the name the bot was addressed by, so the model sees the request
    // rather than the summons. Only relevant when the text trigger is enabled —
    // a native WhatsApp @-mention is not part of the message body at all.
    const botName = (runtimeConfig.get("botName") as string) || config.BOT_NAME
    const cleanText =
      runtimeConfig.get("textMentionTrigger") === true
        ? stripBotName(effectiveText, botName)
        : effectiveText.trim()

    logger.info(`Processing AI request from ${info.senderName || info.sender}`)

    // The typing indicator is deliberately NOT shown here. sendHumanReply holds
    // it for as long as the finished text would actually take to type; showing
    // it during the API call instead made every reply "typed" for the same
    // second or two regardless of length, which is a bot tell in itself.

    // Companion gets a small token budget so the model cannot produce an essay;
    // the prompt asks for brevity, this makes it structurally hard to ignore.
    const maxChars = personaService.getMaxReplyChars(info.from)
    const response = await llmService.askLLM(cleanText, context, systemPrompt, {
      maxTokens: maxChars > 0 ? Math.max(64, Math.ceil(maxChars / 3)) : undefined,
    })

    // Last resort if the model still overruns: trim on a sentence boundary so
    // the message reads as finished rather than cut off.
    const shaped = this.shapeReply(response, maxChars)

    // Parse mentions in the response
    const { text: finalText, mentionedJids } = parseMentions(shaped, participants)

    // sendHumanReply records each part in memory as it is sent.
    await this.sendHumanReply(info, finalText, mentionedJids)

    if (mentionedJids.length > 0) {
      logger.info(`Response included ${mentionedJids.length} mention(s)`)
    }
  }

  /**
   * Handle admin commands
   */
  private async handleAdminCommand(info: MessageInfo): Promise<void> {
    // Check if user is admin
    if (!AdminUtils.isAdmin(info.sender)) {
      await whatsappService.sendMessage(info.from, "🚫 Unauthorized. Admin access required.")
      return
    }

    const parsed = AdminUtils.parseCommand(info.text)
    if (!parsed) return

    const { command, args } = parsed

    logger.info(`Admin command received: ${command} from ${info.sender}`)

    switch (command) {
      case "!help":
        await whatsappService.sendMessage(info.from, AdminUtils.getHelpText())
        break

      case "!clear":
        // If args == 'all', clear all conversations. If args specify a chat id, clear that chat. Otherwise clear the current chat.
        if (args && args.toLowerCase() === "all") {
          memoryService.clear()
          await whatsappService.sendMessage(info.from, "✅ All memory cleared successfully.")
        } else {
          const target = args && args.trim().length ? args.trim() : info.from
          memoryService.clear(target)
          await whatsappService.sendMessage(info.from, `✅ Memory cleared for ${target}`)
        }
        break

      case "!system":
        if (!args) {
          await whatsappService.sendMessage(info.from, "❌ Usage: !system <new system prompt>")
          return
        }
        // Updates the prompt for whichever persona this chat is using, and
        // applies from the next message.
        memoryService.setSystemPrompt(args, info.from)
        await whatsappService.sendMessage(
          info.from,
          `✅ ${PERSONA_LABELS[personaService.getPersonaForChat(info.from)]} prompt updated:\n"${args}"`
        )
        break

      case "!mode": {
        const requested = (args || "").trim().toLowerCase()
        if (requested !== "assistant" && requested !== "companion") {
          const active = personaService.getPersonaForChat(info.from)
          await whatsappService.sendMessage(
            info.from,
            `🎭 Mode here: *${PERSONA_LABELS[active]}*\n\n` +
              "!mode assistant — concise and task-focused\n" +
              "!mode companion — conversational, joins in when it fits"
          )
          return
        }
        await personaService.setPersonaForChat(info.from, requested)
        await whatsappService.sendMessage(
          info.from,
          `✅ Mode for this chat set to *${PERSONA_LABELS[requested]}*`
        )
        break
      }

      case "!chattiness": {
        const requested = (args || "").trim().toLowerCase()
        if (requested === "default") {
          await personaService.setChattinessForChat(info.from, null)
          await whatsappService.sendMessage(info.from, "✅ This chat now follows the global chattiness setting")
          break
        }
        if (!isChattiness(requested)) {
          const current =
            personaService.getChattinessForChat(info.from) ||
            runtimeConfig.get("companionChattiness") ||
            "selective"
          await whatsappService.sendMessage(
            info.from,
            `🗣️ Chattiness here: *${CHATTINESS_LABELS[current as Chattiness]}*\n\n` +
              "!chattiness selective — chimes in occasionally\n" +
              "!chattiness present — noticeably part of the conversation\n" +
              "!chattiness talkative — joins in often\n" +
              "!chattiness default — follow the global setting"
          )
          return
        }
        await personaService.setChattinessForChat(info.from, requested)
        await whatsappService.sendMessage(
          info.from,
          `✅ Chattiness for this chat set to *${CHATTINESS_LABELS[requested]}*`
        )
        break
      }

      case "!notes": {
        const arg = (args || "").trim()

        if (!arg) {
          const notes = await groupMemoryService.get(info.from)
          const state = groupMemoryService.isEnabled() ? "" : "\n\n⚠️ Standing notes are switched off in Settings."
          await whatsappService.sendMessage(
            info.from,
            notes
              ? `🗒️ *What I remember about this chat*\n\n${notes}${state}`
              : `🗒️ Nothing noted about this chat yet.\n\nUse *!notes refresh* to write them from the recent conversation.${state}`
          )
          break
        }

        if (arg.toLowerCase() === "clear") {
          await groupMemoryService.set(info.from, null)
          await whatsappService.sendMessage(info.from, "✅ Notes cleared for this chat.")
          break
        }

        if (arg.toLowerCase() === "refresh") {
          await whatsappService.sendMessage(info.from, "🗒️ Rewriting my notes from the recent conversation…")
          const updated = await groupMemoryService.refresh(info.from)
          await whatsappService.sendMessage(
            info.from,
            updated ? `✅ Notes updated:\n\n${updated}` : "❌ Could not update the notes — check the Logs tab."
          )
          break
        }

        // Anything else is the operator writing the notes by hand.
        await groupMemoryService.set(info.from, arg)
        await whatsappService.sendMessage(info.from, "✅ Notes replaced for this chat.")
        break
      }

      case "!status":
        const allMessages = memoryService.getAllMessages() as {
          [key: string]: { sender: string; text: string; timestamp: number }[]
        }
        // Count conversations and total messages
        const conversationCount = Object.keys(allMessages).length
        let totalMessages = 0
        for (const key in allMessages) totalMessages += (allMessages[key] || []).length

        const currentProvider = (runtimeConfig.get("llmProvider") as any) || config.LLM_PROVIDER
        const currentModel =
          currentProvider === "openai"
            ? (runtimeConfig.get("openaiModel") as string) ||
              process.env.OPENAI_MODEL ||
              "gpt-4o-mini"
            : config.GEMINI_MODEL

        // Report the value actually in force, not the env default it ignored.
        const windowMs = Number(runtimeConfig.get("memoryWindowMs") ?? config.MEMORY_WINDOW_MS)
        const memoryWindowLabel =
          windowMs > 0 ? `${Math.round(windowMs / 60000)} minutes` : "unlimited (never expires)"
        const activePersona = personaService.getPersonaForChat(info.from)
        const personaIsOverride = personaService.hasOverride(info.from)

        const statusText = `
🤖 *Bot Status*

📊 Memory: ${totalMessages} messages across ${conversationCount} conversations
⏰ Window: ${memoryWindowLabel}
🧠 LLM: ${currentProvider} (${currentModel})
🎭 Mode here: ${PERSONA_LABELS[activePersona]}${personaIsOverride ? " (chat override)" : " (default)"}
👥 Admins: ${config.ADMIN_NUMBERS.length}

System Prompt:
"${await memoryService.getSystemPrompt(info.from)}"
        `.trim()
        await whatsappService.sendMessage(info.from, statusText)
        break

      case "!private":
        if (!args) {
          await whatsappService.sendMessage(info.from, "❌ Usage: !private on|off")
          return
        }
        const val = args.toLowerCase() === "on"
        runtimeConfig.set("enablePrivateChat", val)
        await whatsappService.sendMessage(
          info.from,
          `✅ Private chat responses ${val ? "enabled" : "disabled"}`
        )
        break

      default:
        await whatsappService.sendMessage(
          info.from,
          `❌ Unknown command: ${command}\n\nUse !help for available commands.`
        )
    }
  }
}

// Singleton instance
export const messageHandler = new MessageHandler()
