import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"
import { databaseService } from "@/services/database.service"

const logger = createLogger(config.LOG_LEVEL, "UserProfileService")

export interface UserProfile {
  phoneNumber: string
  name?: string
  pushName?: string // WhatsApp push name
  lastSeen: number
}

export class UserProfileService {
  // Map phoneNumber -> UserProfile
  private profiles: Map<string, UserProfile> = new Map()

  /**
   * Update or create user profile
   */
  public updateProfile(phoneNumber: string, name?: string, pushName?: string): void {
    const existing = this.profiles.get(phoneNumber)
    const now = Date.now()
    const profile: UserProfile = {
      phoneNumber,
      name: name || existing?.name,
      pushName: pushName || existing?.pushName,
      lastSeen: now,
    }
    this.profiles.set(phoneNumber, profile)

    // Save to database
    try {
      databaseService.upsertUser({
        phoneNumber,
        displayName: profile.name,
        pushName: profile.pushName,
        lastSeen: now,
        firstSeen: existing?.lastSeen || now,
        messageCount: 0
      })
    } catch (err) {
      logger.error("Failed to save user profile to database", err)
    }

    logger.debug(`Profile updated for ${phoneNumber}: ${profile.name || profile.pushName || "unknown"}`)
  }

  /**
   * Get user profile by phone number
   */
  public getProfile(phoneNumber: string): UserProfile | undefined {
    return this.profiles.get(phoneNumber)
  }

  /**
   * Get display name for user (prioritize name, then pushName, then phone)
   */
  public getDisplayName(phoneNumber: string): string {
    const profile = this.profiles.get(phoneNumber)
    if (!profile) return phoneNumber
    return profile.name || profile.pushName || phoneNumber
  }

  /**
   * Get all profiles
   */
  public getAllProfiles(): UserProfile[] {
    return Array.from(this.profiles.values())
  }

  /**
   * Clear all profiles
   */
  public clear(): void {
    this.profiles.clear()
    logger.info("All user profiles cleared")
  }

  /**
   * Prune profiles not seen in the last 7 days
   */
  public pruneOldProfiles(): void {
    const now = Date.now()
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    let prunedCount = 0

    for (const [phoneNumber, profile] of this.profiles.entries()) {
      if (now - profile.lastSeen > sevenDays) {
        this.profiles.delete(phoneNumber)
        prunedCount++
      }
    }

    if (prunedCount > 0) {
      logger.info(`Pruned ${prunedCount} old user profiles`)
    }
  }

  /**
   * Start automatic pruning
   */
  public startPruning(): void {
    // Prune every 24 hours
    setInterval(() => {
      this.pruneOldProfiles()
    }, 24 * 60 * 60 * 1000)
  }
}

// Singleton instance
export const userProfileService = new UserProfileService()
userProfileService.startPruning()
