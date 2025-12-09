import { config } from "@/config/env"
import { runtimeConfig } from "@/services/runtimeConfig.service"

export class AdminUtils {
  /**
   * Check if a phone number is an admin
   */
  public static isAdmin(phoneNumber: string): boolean {
    const runtimeAdmins = (runtimeConfig.get("adminNumbers") as string[]) || config.ADMIN_NUMBERS

    // Normalize strings to digits only to support phone numbers and WhatsApp JIDs
    const normalize = (s?: string) => (s || "").toString().replace(/\D/g, "")
    const candidate = normalize(phoneNumber)

    for (const admin of runtimeAdmins) {
      if (!admin) continue
      // If normalized forms equal, it's a match
      if (normalize(admin) === candidate) return true
      // Also allow exact match (for JID styles or other formats)
      if (admin === phoneNumber) return true
    }

    return false
  }

  /**
   * Parse admin command from message text
   */
  public static parseCommand(text: string): { command: string; args: string } | null {
    const trimmed = text.trim()
    if (!trimmed.startsWith("!")) return null

    const parts = trimmed.split(" ")
    const command = parts[0].toLowerCase()
    const args = parts.slice(1).join(" ")

    return { command, args }
  }

  /**
   * Get help text for admin commands
   */
  public static getHelpText(): string {
    return `
🤖 *Admin Commands*

!help - Show this help message
!clear - Clear message memory
!system <text> - Update system prompt
!status - Show bot status and memory info

Only authorized admins can use these commands.
    `.trim()
  }
}
