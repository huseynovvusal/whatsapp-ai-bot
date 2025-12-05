import { config } from "@/config/env"

export class AdminUtils {
  /**
   * Check if a phone number is an admin
   */
  public static isAdmin(phoneNumber: string): boolean {
    return config.ADMIN_NUMBERS.includes(phoneNumber)
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
