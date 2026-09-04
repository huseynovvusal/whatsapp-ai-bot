import makeWASocket, {
  DisconnectReason,
  fetchLatestWaWebVersion,
  useMultiFileAuthState,
  WASocket,
  proto,
  isJidGroup,
  extractMessageContent,
  downloadMediaMessage,
  WAMessage,
} from "@whiskeysockets/baileys"
import { Boom } from "@hapi/boom"
import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { userProfileService } from "@/services/userProfile.service"
import { databaseService } from "@/services/database.service"
import { cleanPhoneNumber as cleanPhoneFromJid, baseFromJid } from "@/utils/phone.utils"
import { matchesBotName } from "@/utils/mention.utils"
import { wsService } from "@/services/websocket.service"
import path from "path"

const logger = createLogger(config.LOG_LEVEL, "WhatsAppService")

/** How many recent message IDs to remember for duplicate suppression. */
const MAX_TRACKED_MESSAGE_IDS = 1000
/** Messages older than this are treated as replay, never as live traffic. */
const STALE_MESSAGE_MS = 5 * 60 * 1000
/** How long group metadata (subject, roster) is reused before refetching. */
const GROUP_META_TTL_MS = 5 * 60 * 1000

export type MediaKind = "image" | "audio"

export interface MessageInfo {
  from: string
  sender: string
  senderName?: string
  groupName?: string
  text: string
  isGroup: boolean
  isMentioned: boolean
  isReplyToBot: boolean
  messageId: string
  /** When the bot received this message, for "has the chat moved on" checks. */
  receivedAt: number
  quotedMessage?: proto.IWebMessageInfo // Store original message for replying
  /** Set when the message carries media the bot can interpret. */
  media?: {
    kind: MediaKind
    mimeType: string
    /** Voice notes are speech aimed at the chat, unlike a shared music file. */
    isVoiceNote?: boolean
    /** Lazy: media is only fetched if the bot actually decides to respond. */
    download: () => Promise<Buffer>
  }
}

export type MessageHandler = (info: MessageInfo) => Promise<void>

export class WhatsAppService {
  private sock: WASocket | null = null
  private messageHandler: MessageHandler | null = null
  private reconnecting = false
  /** Consecutive failed reconnects, used for exponential backoff. */
  private reconnectAttempts = 0
  /** Recently handled message IDs, for duplicate suppression. */
  private processedMessageIds: Set<string> = new Set()
  /** Insertion order for the above, so the set can be bounded. */
  private processedMessageOrder: string[] = []
  /** Group metadata by JID, with the time it was fetched. */
  private groupMetaCache: Map<string, { meta: any; at: number }> = new Map()

  /**
   * Start WhatsApp connection
   */
  public async connect(): Promise<void> {
    if (this.reconnecting) {
      logger.info("Already reconnecting, skipping duplicate connect call")
      return
    }

    // Announce the attempt before anything slow happens. Fetching the WA Web
    // version and opening the socket take a few seconds, and until now the admin
    // panel showed nothing during that time — which read as "the QR never came".
    wsService.setConnectionState("starting", "Connecting to WhatsApp…")

    const authPath = path.join(__dirname, "../../auth_info_baileys")
    const { state, saveCreds } = await useMultiFileAuthState(authPath)

    wsService.setConnectionState("starting", "Preparing your QR code…")

    const { version, isLatest } = await fetchLatestWaWebVersion()
    logger.info(`Fetched WA Web version: ${version.join('.')}, isLatest: ${isLatest}`)

    this.sock = makeWASocket({
      version,
      auth: state,
    })

    // Save credentials on update
    this.sock.ev.on("creds.update", saveCreds)

    // Handle connection updates
    this.sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        // Send QR code to admin panel via WebSocket
        wsService.sendQRCode(qr).catch((err) => {
          logger.error("Failed to send QR code to WebSocket", err)
        })
        wsService.log("info", "QR Code generated. Scan with WhatsApp to connect.", "WhatsApp")
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut

        const reason = lastDisconnect?.error?.message || "unknown"
        wsService.log("warn", `Connection closed. Reason: ${reason}`, "WhatsApp")
        wsService.sendConnectionStatus(false)

        logger.warn("Connection closed. Reconnecting:", {
          shouldReconnect,
          statusCode,
          reason,
        })

        if (shouldReconnect) {
          if (this.reconnecting) {
            logger.info("Reconnect already scheduled, skipping")
            return
          }
          this.reconnecting = true
          // Exponential backoff, capped. A fixed short delay hammers WhatsApp
          // during an outage and can get the session throttled or banned.
          this.reconnectAttempts++
          const delay = Math.min(
            5000 * Math.pow(2, this.reconnectAttempts - 1),
            5 * 60 * 1000
          )
          wsService.log(
            "info",
            `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`,
            "WhatsApp"
          )
          wsService.setConnectionState(
            "reconnecting",
            `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`
          )
          setTimeout(async () => {
            this.reconnecting = false
            try {
              await this.connect()
            } catch (err) {
              logger.error("Reconnect attempt failed:", err)
              wsService.log("error", `Reconnect attempt failed: ${err}`, "WhatsApp")
            }
          }, delay)
        }
      } else if (connection === "open") {
        this.reconnecting = false
        // A successful connection resets the backoff ladder.
        this.reconnectAttempts = 0
        const phoneNumber = this.sock?.user?.id || undefined
        const displayName = this.sock?.user?.name || phoneNumber

        logger.info("✅ WhatsApp connection established successfully!")
        wsService.log("success", `WhatsApp connected as: ${displayName}`, "WhatsApp")
        wsService.sendConnectionStatus(true, phoneNumber)

        if (this.sock?.user) {
          logger.info(`📱 Connected as: ${displayName}`)
        }
      }
    })

    // Handle incoming messages
    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      // Only "notify" means a message arriving now. "append" is history sync —
      // Baileys replays older messages on connect and after a reconnect, and
      // answering those would make the bot blast replies to old conversations.
      if (type !== "notify") {
        logger.debug(`Ignoring ${messages.length} message(s) of type "${type}" (not live traffic)`)
        return
      }
      for (const msg of messages) {
        await this.handleIncomingMessage(msg)
      }
    })
  }

  /**
   * Group metadata, cached briefly.
   *
   * Every incoming group message asked WhatsApp for the group's subject, and
   * building the prompt asked again for the participant list — two round trips
   * per message to fetch data that changes maybe once a month. WhatsApp
   * rate-limits this call, and being throttled is one of the ways a session gets
   * flagged, so the answer is held for a few minutes.
   */
  private async fetchGroupMetadata(groupJid: string, force = false): Promise<any | undefined> {
    if (!this.sock) return undefined
    const cached = this.groupMetaCache.get(groupJid)
    if (!force && cached && Date.now() - cached.at < GROUP_META_TTL_MS) return cached.meta

    try {
      // @ts-ignore - groupMetadata is present on the socket but loosely typed
      const meta = await (this.sock.groupMetadata?.(groupJid) || Promise.resolve(undefined))
      if (meta) this.groupMetaCache.set(groupJid, { meta, at: Date.now() })
      return meta
    } catch (err) {
      logger.warn("Failed to fetch group metadata", err)
      // A stale answer beats no answer when WhatsApp is throttling us.
      return cached?.meta
    }
  }

  /**
   * Get group metadata (subject/title) for a group JID (e.g. 1203634xxx@g.us)
   */
  public async getGroupName(groupJid: string): Promise<string | undefined> {
    const meta = await this.fetchGroupMetadata(groupJid)
    return meta?.subject || undefined
  }

  /**
   * Get all groups the bot is participating in
   */
  public async getAllGroups(): Promise<Array<{ id: string; name: string; participantCount: number }>> {
    if (!this.sock) return []
    try {
      // @ts-ignore - groupFetchAllParticipating is available in Baileys
      const groups = await this.sock.groupFetchAllParticipating?.()
      if (!groups) return []

      const groupList: Array<{ id: string; name: string; participantCount: number }> = []
      for (const [id, group] of Object.entries(groups as any)) {
        const groupData = group as any
        groupList.push({
          id,
          name: groupData.subject || "(No name)",
          participantCount: groupData.participants?.length || 0,
        })
      }

      return groupList
    } catch (err) {
      logger.warn("Failed to fetch all groups", err)
      return []
    }
  }

  /**
   * Get richer group info: subject + owner + participant count
   */
  public async getGroupInfo(groupJid: string): Promise<
    | {
        subject?: string
        owner?: string
        description?: string
        participantCount?: number
      }
    | undefined
  > {
    const meta = await this.fetchGroupMetadata(groupJid)
    if (!meta) return undefined
    return {
      subject: meta?.subject,
      owner: meta?.owner,
      description: meta?.desc || undefined,
      participantCount: meta?.participants?.length || 0,
    }
  }

  /**
   * The bot's own WhatsApp identity — who we are connected as.
   */
  public getOwnIdentity(): {
    connected: boolean
    jid: string | null
    phone: string | null
    name: string | null
  } {
    const user = this.sock?.user
    if (!user) return { connected: false, jid: null, phone: null, name: null }
    return {
      connected: true,
      jid: user.id || null,
      phone: user.id ? cleanPhoneFromJid(baseFromJid(user.id)) : null,
      name: user.name || null,
    }
  }

  /**
   * Everyone in a group, whether or not they have ever spoken.
   *
   * WhatsApp's group metadata carries no display names, so the previous version
   * returned a list of bare phone numbers and the bot only ever knew the people
   * it had already heard from. Names are filled in from what we do have: the
   * `pushName` captured from past messages, then Baileys' contact store. Anyone
   * still unnamed is returned with the number, which is honest — the roster is
   * complete either way, which is what the prompt and the People tab need.
   */
  public async getGroupParticipants(groupJid: string): Promise<
    Array<{ id: string; phone: string; name?: string; isAdmin: boolean; hasSpoken: boolean }>
  > {
    const meta = await this.fetchGroupMetadata(groupJid)
    if (!meta?.participants) return []

    return Promise.all(
      meta.participants.map(async (p: any) => {
        const phone = cleanPhoneFromJid(p.id)
        const known = userProfileService.getProfile(phone)
        let name = known?.name || known?.pushName
        if (!name) {
          // Only for people we have never heard from; the store lookup is local.
          name = await this.getContactName(p.id)
        }
        return {
          id: p.id,
          phone,
          name: name || undefined,
          isAdmin: p.admin === "admin" || p.admin === "superadmin",
          hasSpoken: Boolean(known),
        }
      })
    )
  }

  /**
   * Fetch contact name from WhatsApp (if available)
   */
  public async getContactName(jid: string): Promise<string | undefined> {
    if (!this.sock) return undefined
    try {
      // Try to get from contact store first (Baileys caches contacts)
      // @ts-ignore - contact store may not be in types
      const contacts = this.sock.store?.contacts
      if (contacts && contacts[jid]) {
        // @ts-ignore
        return contacts[jid]?.name || contacts[jid]?.notify || contacts[jid]?.verifiedName
      }

      // Try onWhatsApp to check if number is registered and get notify name
      // @ts-ignore - Baileys may have contact store
      const result = await this.sock.onWhatsApp?.(jid)
      if (result && result.length > 0) {
        // @ts-ignore - notify property may not be typed correctly
        return result[0]?.notify || undefined
      }

      return undefined
    } catch (err) {
      logger.debug("Failed to fetch contact name", err)
      return undefined
    }
  }

  /**
   * Set message handler callback
   */
  public onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  /**
   * Send presence update (typing, recording, etc.)
   */
  public async sendPresenceUpdate(presence: "unavailable" | "available" | "composing" | "recording" | "paused", to: string): Promise<void> {
    if (!this.sock) {
      throw new Error("WhatsApp is not connected")
    }

    try {
      await this.sock.sendPresenceUpdate(presence, to)
      logger.debug(`Presence update sent: ${presence} to ${to}`)
    } catch (error) {
      logger.error("Error sending presence update:", error)
    }
  }

  /**
   * React to a message with an emoji
   */
  public async sendReaction(to: string, messageKey: any, emoji: string): Promise<void> {
    if (!this.sock) {
      throw new Error("WhatsApp is not connected")
    }

    try {
      const reactionMessage = {
        react: {
          text: emoji,
          key: messageKey
        }
      }
      await this.sock.sendMessage(to, reactionMessage)
      logger.debug(`Reaction sent: ${emoji} to message in ${to}`)
    } catch (error) {
      logger.error("Error sending reaction:", error)
    }
  }

  /**
   * Send message to a chat
   */
  public async sendMessage(to: string, text: string, mentionedJids?: string[]): Promise<void> {
    if (!this.sock) {
      throw new Error("WhatsApp is not connected")
    }

    try {
      const messageOptions: any = { text }

      // Add mentions if provided
      if (mentionedJids && mentionedJids.length > 0) {
        messageOptions.mentions = mentionedJids
      }

      await this.sock.sendMessage(to, messageOptions)
      logger.info(`Message sent to ${to}${mentionedJids ? ` with ${mentionedJids.length} mentions` : ""}`)
    } catch (error) {
      logger.error("Error sending message:", error)
      throw new Error("Failed to send message")
    }
  }

  /**
   * Send message as a reply to another message
   */
  public async sendReply(
    to: string,
    text: string,
    quotedMessage: proto.IWebMessageInfo,
    mentionedJids?: string[]
  ): Promise<void> {
    if (!this.sock) {
      throw new Error("WhatsApp is not connected")
    }

    try {
      const messageOptions: any = { text }

      // Add mentions if provided
      if (mentionedJids && mentionedJids.length > 0) {
        messageOptions.mentions = mentionedJids
      }

      await this.sock.sendMessage(
        to,
        messageOptions,
        { quoted: quotedMessage as any } // Type assertion needed for Baileys compatibility
      )
      logger.info(`Reply sent to ${to}${mentionedJids ? ` with ${mentionedJids.length} mentions` : ""}`)
    } catch (error) {
      logger.error("Error sending reply:", error)
      throw new Error("Failed to send reply")
    }
  }

  /**
   * Handle incoming message
   */
  private async handleIncomingMessage(msg: proto.IWebMessageInfo): Promise<void> {
    try {
      // Ignore messages without key or from status broadcast
      if (!msg.key || !msg.key.remoteJid) return
      if (msg.key.remoteJid === "status@broadcast") return

      // Extract message content
      const messageContent = extractMessageContent(msg.message)
      if (!messageContent) return

      // Media is detected first: an image or voice note may carry no caption at
      // all, and those messages were previously dropped outright.
      const media = this.extractMedia(messageContent, msg)
      const text = this.extractText(messageContent)
      if (!text && !media) return

      // Ignore messages from self
      if (msg.key.fromMe) return

      // Baileys can deliver the same message more than once (reconnects, retries,
      // multi-device fan-out). Without this the bot answers twice.
      const messageId = msg.key.id
      if (messageId) {
        if (this.processedMessageIds.has(messageId)) {
          logger.debug(`Skipping duplicate delivery of message ${messageId}`)
          return
        }
        this.processedMessageIds.add(messageId)
        this.processedMessageOrder.push(messageId)
        if (this.processedMessageOrder.length > MAX_TRACKED_MESSAGE_IDS) {
          const evicted = this.processedMessageOrder.shift()
          if (evicted) this.processedMessageIds.delete(evicted)
        }
      }

      // Belt and braces alongside the "notify" filter: refuse anything noticeably
      // older than now, so a replay can never produce a live-looking reply.
      const sentAt = Number(msg.messageTimestamp) * 1000
      if (sentAt && Date.now() - sentAt > STALE_MESSAGE_MS) {
        logger.debug(
          `Ignoring stale message ${messageId} (${Math.round((Date.now() - sentAt) / 1000)}s old)`
        )
        return
      }

      const from = msg.key.remoteJid
      const isGroup = isJidGroup(from)
      const sender = isGroup ? msg.key.participant || from : from

      // Extract sender name from message (pushName is WhatsApp display name)
      const pushName = msg.pushName || undefined
      const cleanedSenderPhone = cleanPhoneFromJid(sender)

      // Update user profile with push name
      if (pushName) {
        userProfileService.updateProfile(cleanedSenderPhone, undefined, pushName)
      }

      // Check if bot is mentioned in group
      const isMentioned = this.isBotMentioned(text || "", msg)

      // Check if message is a reply to bot's message
      const isReplyToBot = this.isReplyToBot(msg)

      const messageInfo: MessageInfo = {
        from,
        sender: cleanedSenderPhone,
        senderName: userProfileService.getDisplayName(cleanedSenderPhone),
        text: (text || "").trim(),
        isGroup: isGroup || false,
        isMentioned,
        isReplyToBot,
        messageId: msg.key.id || "",
        receivedAt: Date.now(),
        quotedMessage: msg, // Store original message for replying
        media,
      }

      // If this message is in a group, try to fetch the group subject/name for better logging
      if (isGroup) {
        try {
          const name = await this.getGroupName(from)
          if (name) messageInfo.groupName = name

          // Update conversation in database
          await databaseService.upsertConversation({
            chatId: from,
            chatName: name,
            isGroup: true,
            messageCount: 0,
            lastMessageAt: Date.now()
          })
        } catch (err) {
          logger.warn("Failed to fetch group name:", err)
        }
      } else {
        // Update private chat conversation
        try {
          await databaseService.upsertConversation({
            chatId: from,
            chatName: messageInfo.senderName,
            isGroup: false,
            messageCount: 0,
            lastMessageAt: Date.now()
          })
        } catch (err) {
          logger.warn("Failed to update conversation:", err)
        }
      }

      // Log message with group label if present
      if (messageInfo.isGroup) {
        const logMsg = `Message in group '${messageInfo.groupName || "(unknown)"}' from ${messageInfo.senderName || messageInfo.sender}`
        logger.info(
          `📨 ${logMsg} (participant: ${
            (msg.key as any).participant || "-"
          }, chat: ${from}) (Mentioned: ${isMentioned}, Reply: ${isReplyToBot}): ${(text || "").substring(0, 50)}...`
        )
        wsService.log("info", `${logMsg}: ${(text || "").substring(0, 100)}`, "Message")
      } else {
        const logMsg = `Message from ${messageInfo.senderName || messageInfo.sender}`
        logger.info(
          `📨 ${logMsg} (chat: ${from}) (Mentioned: ${isMentioned}, Reply: ${isReplyToBot}): ${(text || "").substring(0, 50)}...`
        )
        wsService.log("info", `${logMsg}: ${(text || "").substring(0, 100)}`, "Message")
      }

      // Call message handler
      if (this.messageHandler) {
        await this.messageHandler(messageInfo)
      }
    } catch (error) {
      logger.error("Error handling incoming message:", error)
    }
  }
  /**
   * Extract text from message content
   */
  private extractText(content: any): string | null {
    if (content.conversation) return content.conversation
    if (content.extendedTextMessage?.text) return content.extendedTextMessage.text
    if (content.imageMessage?.caption) return content.imageMessage.caption
    if (content.videoMessage?.caption) return content.videoMessage.caption
    return null
  }

  /**
   * Detect media the bot can interpret, exposing a lazy download.
   *
   * The download deliberately does not run here: most messages are never
   * answered (unmentioned group chatter, disabled chats), and fetching and
   * decrypting media for every one of them would waste bandwidth and time.
   */
  private extractMedia(content: any, msg: proto.IWebMessageInfo): MessageInfo["media"] {
    const image = content.imageMessage
    const audio = content.audioMessage

    let kind: MediaKind | null = null
    let mimeType = ""
    let isVoiceNote = false

    if (image) {
      kind = "image"
      mimeType = image.mimetype || "image/jpeg"
    } else if (audio) {
      kind = "audio"
      mimeType = audio.mimetype || "audio/ogg"
      isVoiceNote = Boolean(audio.ptt)
    }

    if (!kind) return undefined

    return {
      kind,
      mimeType,
      isVoiceNote,
      download: async (): Promise<Buffer> => {
        // handleIncomingMessage returns early unless msg.key exists, which is
        // the only reason IWebMessageInfo does not satisfy WAMessage here.
        const buffer = await downloadMediaMessage(msg as WAMessage, "buffer", {}, {
          logger: logger as never,
          // Lets Baileys ask WhatsApp to re-upload media that has expired.
          reuploadRequest: this.sock!.updateMediaMessage,
        })
        return buffer as Buffer
      },
    }
  }

  /**
   * Every JID mentioned in a message.
   *
   * Mentions do not only live on `extendedTextMessage`: a photo with a caption
   * that tags someone carries them on `imageMessage.contextInfo`, and the same
   * goes for video and documents. Reading one branch missed those tags.
   */
  private mentionedJidsOf(msg: proto.IWebMessageInfo): string[] {
    const message = msg.message as Record<string, any> | undefined
    if (!message) return []
    const jids = new Set<string>()
    for (const value of Object.values(message)) {
      const mentioned = value?.contextInfo?.mentionedJid
      if (Array.isArray(mentioned)) for (const jid of mentioned) if (jid) jids.add(jid)
    }
    return Array.from(jids)
  }

  /** Every identity WhatsApp may address this bot by: its number and its LID. */
  private ownJids(): string[] {
    const user = this.sock?.user as { id?: string; lid?: string } | undefined
    return [user?.id, user?.lid].filter(Boolean) as string[]
  }

  /**
   * Check whether the bot was addressed.
   *
   * WhatsApp's own @-mention (and replying to one of the bot's messages) is the
   * natural way to get someone's attention, and it is what people actually use.
   * A plain-text trigger — matching the bot's name anywhere in the message — is
   * off by default: it fired on any sentence that happened to contain the word,
   * and it made the bot's name feel like a command prefix rather than a name.
   */
  private isBotMentioned(text: string, msg: proto.IWebMessageInfo): boolean {
    let mentionedInText = false
    if (runtimeConfig.get("textMentionTrigger") === true) {
      const botName = (runtimeConfig.get("botName") as string) || config.BOT_NAME
      mentionedInText = matchesBotName(text, botName)
    }

    const mentionedJids = this.mentionedJidsOf(msg)
    const ownJids = this.ownJids()
    let mentionedByJid = false

    if (ownJids.length && mentionedJids.length) {
      const ownBases = new Set(ownJids.map((jid) => baseFromJid(jid)))
      // Compare on the base JID so a device suffix (":22") never breaks the
      // match. Both the phone-number JID and the LID are checked — accepting
      // *any* @lid mention, as this used to, meant tagging anybody in the group
      // woke the bot up.
      mentionedByJid = mentionedJids.some(
        (jid) => ownJids.includes(jid) || ownBases.has(baseFromJid(jid))
      )

      // Fallback for the case that made the old permissive rule tempting: on
      // some sessions WhatsApp addresses the bot by a linked-identity JID we
      // have no way to resolve, because the socket never told us our own LID.
      // Missing a direct tag is worse than the odd false positive, so when our
      // LID is genuinely unknown an unresolvable @lid still counts — and says so
      // in the log, rather than silently guessing.
      const ownLid = (this.sock?.user as { lid?: string } | undefined)?.lid
      if (!mentionedByJid && !ownLid) {
        const unresolvedLid = mentionedJids.find((jid) => jid.includes("@lid"))
        if (unresolvedLid) {
          logger.warn(
            `Treating @lid mention ${unresolvedLid} as a mention of this bot: WhatsApp did not report our own LID, so it cannot be matched exactly.`
          )
          mentionedByJid = true
        }
      }
    }

    logger.debug(
      `Mention check - Text: ${mentionedInText}, JID: ${mentionedByJid}, Mentioned JIDs: ${JSON.stringify(mentionedJids)}, Own: ${JSON.stringify(ownJids)}`
    )
    return mentionedInText || mentionedByJid
  }

  /**
   * Check if message is a reply to bot's message
   */
  private isReplyToBot(msg: proto.IWebMessageInfo): boolean {
    const quotedMessage = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
    const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant

    if (!quotedMessage) return false

    // Check if the quoted message is from the bot (fromMe)
    const botNumber = this.sock?.user?.id

    // In groups, check if quoted participant is bot
    if (quotedParticipant && botNumber) {
      return quotedParticipant === botNumber
    }

    // Check if it's a reply to bot's own message
    const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId
    if (stanzaId && msg.message?.extendedTextMessage?.contextInfo?.participant === botNumber) {
      return true
    }

    return false
  }

  // old helper removed — phone normalization uses util cleanPhoneFromJid
}

// Singleton instance
export const whatsappService = new WhatsAppService()
