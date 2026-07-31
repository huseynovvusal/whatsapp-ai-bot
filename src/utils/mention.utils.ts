/**
 * Utilities for mentioning/tagging users in WhatsApp messages
 */

/**
 * Format a phone number for WhatsApp mention
 * @param phone - Phone number (e.g., "+1234567890" or "1234567890")
 * @returns JID format (e.g., "1234567890@s.whatsapp.net")
 */
export function formatPhoneToJid(phone: string): string {
  // Remove + and spaces
  const cleaned = phone.replace(/[\s+]/g, "")
  return `${cleaned}@s.whatsapp.net`
}

/**
 * Create a mention tag for a user
 * @param name - Display name
 * @param phone - Phone number
 * @returns Formatted mention (e.g., "@John")
 */
export function createMention(name: string, phone: string): {
  text: string
  mentionedJid: string
} {
  return {
    text: `@${name}`,
    mentionedJid: formatPhoneToJid(phone),
  }
}

/** Escape a user-supplied string so it can be used inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Does this message address the bot by name?
 *
 * Only used when the optional plain-text trigger is switched on. Matched on a
 * word boundary and with an optional leading "@", so a bot called "Nova" is
 * addressed by "@Nova" or "Nova, what do you think" but not by "innovation".
 * The name is escaped because it comes from operator configuration and may
 * legitimately contain "+" or "." — unescaped, it used to be a regex injection.
 */
export function matchesBotName(text: string, botName: string): boolean {
  const name = botName.trim().replace(/^@/, "")
  if (!name) return false
  try {
    // `\b` is only meaningful when the name ends in a word character; a name
    // like "c++" ends in punctuation, where a trailing `\b` can never match.
    const trailing = /[\p{L}\p{N}_]$/u.test(name) ? "\\b" : ""
    return new RegExp(`(^|[^\\p{L}\\p{N}])@?${escapeRegExp(name)}${trailing}`, "iu").test(text)
  } catch {
    return text.toLowerCase().includes(name.toLowerCase())
  }
}

/** Remove the way the bot was addressed, so the model sees the request itself. */
export function stripBotName(text: string, botName: string): string {
  const name = botName.trim().replace(/^@/, "")
  if (!name) return text.trim()
  try {
    const trailing = /[\p{L}\p{N}_]$/u.test(name) ? "\\b" : ""
    return text
      .replace(new RegExp(`@?${escapeRegExp(name)}${trailing}`, "giu"), " ")
      .replace(/\s{2,}/g, " ")
      .trim()
  } catch {
    return text.trim()
  }
}

/**
 * Extract phone numbers mentioned in text (e.g., "Hey @+1234567890")
 * @param text - Message text
 * @returns Array of phone numbers found
 */
export function extractPhoneMentions(text: string): string[] {
  const phoneRegex = /@\+?(\d+)/g
  const matches = text.matchAll(phoneRegex)
  const phones: string[] = []

  for (const match of matches) {
    phones.push(match[1])
  }

  return phones
}

/**
 * Parse AI response for @Name mentions and convert to WhatsApp format
 * @param text - AI response text
 * @param participants - List of participants with names and phones
 * @returns Object with formatted text and mentionedJids array
 */
export function parseMentions(
  text: string,
  participants: Array<{ name: string; phone: string }>
): {
  text: string
  mentionedJids: string[]
} {
  const mentionedJids: string[] = []
  let formattedText = text

  // Match @Name patterns (word characters, allowing spaces in names)
  const mentionPattern = /@([\w\s]+?)(?=\s|$|[.,!?;:])/g
  const matches = Array.from(text.matchAll(mentionPattern))

  for (const match of matches) {
    const mentionedName = match[1].trim()

    // Find participant by name (case-insensitive partial match)
    const participant = participants.find((p) =>
      p.name.toLowerCase().includes(mentionedName.toLowerCase())
    )

    if (participant) {
      const jid = formatPhoneToJid(participant.phone)
      if (!mentionedJids.includes(jid)) {
        mentionedJids.push(jid)
      }
    }
  }

  return {
    text: formattedText,
    mentionedJids,
  }
}
