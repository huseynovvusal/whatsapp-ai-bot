import makeWASocket, {
  DisconnectReason,
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
import { cleanPhoneNumber as cleanPhoneFromJid } from "@/utils/phone.utils"
import path from "path"
import qrcode from "qrcode-terminal"

const logger = createLogger(config.LOG_LEVEL, "WhatsAppService")

export interface MessageInfo {
  from: string
  sender: string
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

  /**
   * Start WhatsApp connection
   */
  public async connect(): Promise<void> {
    const authPath = path.join(__dirname, "../../auth_info_baileys")
    const { state, saveCreds } = await useMultiFileAuthState(authPath)

    this.sock = makeWASocket({
      auth: state,
    })

    // Save credentials on update
    this.sock.ev.on("creds.update", saveCreds)

    // Handle connection updates
    this.sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        console.log("\n" + "=".repeat(60))
        console.log("📱 SCAN THIS QR CODE WITH YOUR WHATSAPP")
        console.log("=".repeat(60) + "\n")
        qrcode.generate(qr, { small: true })
        console.log("\n" + "=".repeat(60))
        console.log("📲 Open WhatsApp → Settings → Linked Devices → Link a Device")
        console.log("=".repeat(60) + "\n")
        logger.info("QR Code generated. Scan with WhatsApp to connect.")
      }

      if (connection === "close") {
        const shouldReconnect =
          (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut

        logger.warn("Connection closed. Reconnecting:", shouldReconnect)

        if (shouldReconnect) {
          await this.connect()
        }
      } else if (connection === "open") {
        logger.info("✅ WhatsApp connection established successfully!")
        if (this.sock?.user) {
          logger.info(`📱 Connected as: ${this.sock.user.name || this.sock.user.id}`)
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
   * Set message handler callback
   */
  public onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  /**
   * Send message to a chat
   */
  public async sendMessage(to: string, text: string): Promise<void> {
    if (!this.sock) {
      throw new Error("WhatsApp is not connected")
    }

    try {
      await this.sock.sendMessage(to, { text })
      logger.info(`Message sent to ${to}`)
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
    quotedMessage: proto.IWebMessageInfo
  ): Promise<void> {
    if (!this.sock) {
      throw new Error("WhatsApp is not connected")
    }

    try {
      await this.sock.sendMessage(
        to,
        { text },
        { quoted: quotedMessage as any } // Type assertion needed for Baileys compatibility
      )
      logger.info(`Reply sent to ${to}`)
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

      // Check if bot is mentioned in group
      const isMentioned = this.isBotMentioned(text, msg)

      // Check if message is a reply to bot's message
      const isReplyToBot = this.isReplyToBot(msg)

      const cleanedSenderPhone = cleanPhoneFromJid(sender)
      const messageInfo: MessageInfo = {
        from,
        sender: cleanedSenderPhone,
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
        } catch (err) {
          logger.warn("Failed to fetch group name:", err)
        }
      }

      // Log message with group label if present
      if (messageInfo.isGroup) {
        logger.info(
          `📨 Message in group '${messageInfo.groupName || "(unknown)"}' from ${messageInfo.sender} (participant: ${
            (msg.key as any).participant || "-"
          }, chat: ${from}) (Mentioned: ${isMentioned}, Reply: ${isReplyToBot}): ${text.substring(0, 50)}...`
        )
      } else {
        logger.info(
          `📨 Message from ${messageInfo.sender} (chat: ${from}) (Mentioned: ${isMentioned}, Reply: ${isReplyToBot}): ${text.substring(0, 50)}...`
        )
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
    const mentionedByJid = botNumber ? mentionedJids.includes(botNumber) : false

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
