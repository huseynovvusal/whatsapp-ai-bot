import makeWASocket, {
  DisconnectReason,
  fetchLatestWaWebVersion,
  useMultiFileAuthState,
  WASocket,
  proto,
  isJidGroup,
  extractMessageContent,
} from "@whiskeysockets/baileys"
import { Boom } from "@hapi/boom"
import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { userProfileService } from "@/services/userProfile.service"
import { databaseService } from "@/services/database.service"
import { cleanPhoneNumber as cleanPhoneFromJid, baseFromJid } from "@/utils/phone.utils"
import { wsService } from "@/services/websocket.service"
import path from "path"

const logger = createLogger(config.LOG_LEVEL, "WhatsAppService")

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
  quotedMessage?: proto.IWebMessageInfo // Store original message for replying
}

export type MessageHandler = (info: MessageInfo) => Promise<void>

export class WhatsAppService {
  private sock: WASocket | null = null
  private messageHandler: MessageHandler | null = null
  private reconnectDelayMs = 5000
  private reconnecting = false

  /**
   * Start WhatsApp connection
   */
  public async connect(): Promise<void> {
    if (this.reconnecting) {
      logger.info("Already reconnecting, skipping duplicate connect call")
      return
    }

    const authPath = path.join(__dirname, "../../auth_info_baileys")
    const { state, saveCreds } = await useMultiFileAuthState(authPath)

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
          wsService.log("info", `Reconnecting in ${this.reconnectDelayMs / 1000} seconds...`, "WhatsApp")
          setTimeout(async () => {
            this.reconnecting = false
            try {
              await this.connect()
            } catch (err) {
              logger.error("Reconnect attempt failed:", err)
              wsService.log("error", `Reconnect attempt failed: ${err}`, "WhatsApp")
            }
          }, this.reconnectDelayMs)
        }
      } else if (connection === "open") {
        this.reconnecting = false
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
    this.sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        await this.handleIncomingMessage(msg)
      }
    })
  }

  /**
   * Get group metadata (subject/title) for a group JID (e.g. 1203634xxx@g.us)
   */
  public async getGroupName(groupJid: string): Promise<string | undefined> {
    if (!this.sock) return undefined
    try {
      // Baileys exposes groupMetadata on the socket in newer versions
      // fall back gracefully if not available
      // @ts-ignore
      const meta = await (this.sock.groupMetadata?.(groupJid) || Promise.resolve(undefined))
      return meta?.subject || undefined
    } catch (err) {
      logger.warn("Failed to fetch group metadata", err)
      return undefined
    }
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
  public async getGroupInfo(
    groupJid: string
  ): Promise<{ subject?: string; owner?: string; participantCount?: number } | undefined> {
    if (!this.sock) return undefined
    try {
      // @ts-ignore
      const meta = await (this.sock.groupMetadata?.(groupJid) || Promise.resolve(undefined))
      if (!meta) return undefined
      return {
        subject: meta?.subject,
        owner: meta?.owner,
        participantCount: meta?.participants?.length || 0,
      }
    } catch (err) {
      logger.warn("Failed to fetch group metadata", err)
      return undefined
    }
  }

  /**
   * Get group participants with their profile information
   */
  public async getGroupParticipants(
    groupJid: string
  ): Promise<Array<{ id: string; phone: string; name?: string; isAdmin: boolean }>> {
    if (!this.sock) return []
    try {
      // @ts-ignore
      const meta = await (this.sock.groupMetadata?.(groupJid) || Promise.resolve(undefined))
      if (!meta || !meta.participants) return []

      const participants = meta.participants.map((p: any) => {
        const phone = cleanPhoneFromJid(p.id)
        return {
          id: p.id,
          phone,
          name: undefined, // WhatsApp doesn't provide names in group metadata
          isAdmin: p.admin === "admin" || p.admin === "superadmin",
        }
      })

      return participants
    } catch (err) {
      logger.warn("Failed to fetch group participants", err)
      return []
    }
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

      // Get text from message
      const text = this.extractText(messageContent)
      if (!text) return

      // Ignore messages from self
      if (msg.key.fromMe) return

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
      const isMentioned = this.isBotMentioned(text, msg)

      // Check if message is a reply to bot's message
      const isReplyToBot = this.isReplyToBot(msg)

      const messageInfo: MessageInfo = {
        from,
        sender: cleanedSenderPhone,
        senderName: userProfileService.getDisplayName(cleanedSenderPhone),
        text: text.trim(),
        isGroup: isGroup || false,
        isMentioned,
        isReplyToBot,
        messageId: msg.key.id || "",
        quotedMessage: msg, // Store original message for replying
      }

      // If this message is in a group, try to fetch the group subject/name for better logging
      if (isGroup) {
        try {
          const name = await this.getGroupName(from)
          if (name) messageInfo.groupName = name

          // Update conversation in database
          databaseService.upsertConversation({
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
          databaseService.upsertConversation({
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
          }, chat: ${from}) (Mentioned: ${isMentioned}, Reply: ${isReplyToBot}): ${text.substring(0, 50)}...`
        )
        wsService.log("info", `${logMsg}: ${text.substring(0, 100)}`, "Message")
      } else {
        const logMsg = `Message from ${messageInfo.senderName || messageInfo.sender}`
        logger.info(
          `📨 ${logMsg} (chat: ${from}) (Mentioned: ${isMentioned}, Reply: ${isReplyToBot}): ${text.substring(0, 50)}...`
        )
        wsService.log("info", `${logMsg}: ${text.substring(0, 100)}`, "Message")
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
   * Check if bot is mentioned in the message
   */
  private isBotMentioned(text: string, msg: proto.IWebMessageInfo): boolean {
    // Check text for @bot mention - use runtime config if available
    const botName = (runtimeConfig.get("botName") as string) || config.BOT_NAME
    const mentionedInText = text.toLowerCase().includes(botName.toLowerCase())

    // Check if bot number is in mentioned JIDs
    const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
    const botNumber = this.sock?.user?.id
    let mentionedByJid = false

    if (botNumber && mentionedJids && mentionedJids.length) {
      // Get bot's base number (994708770718)
      const botBase = baseFromJid(botNumber)

      // Check each mentioned JID
      mentionedByJid = mentionedJids.some((j) => {
        const mentionedBase = baseFromJid(j)

        // Direct match on full JID or base JID
        if (j === botNumber || mentionedBase === botBase) {
          return true
        }

        // Check if mentioned JID contains @lid (Linked Identity Device)
        // WhatsApp uses LID for linked devices, format: 217248673337520:22@lid
        // We need to check if this LID belongs to the bot
        if (j.includes("@lid")) {
          logger.debug(`LID mentioned: ${j}, Bot number: ${botNumber}`)
          // For now, accept ANY @lid mention as a mention of the bot
          // (This is a simplified approach - ideally we'd map LID to main number)
          return true
        }

        return false
      })
    }

    logger.debug(`Mention check - Text: ${mentionedInText}, JID: ${mentionedByJid}, Mentioned JIDs: ${JSON.stringify(mentionedJids)}`)
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
