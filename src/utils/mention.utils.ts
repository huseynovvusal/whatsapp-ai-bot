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
