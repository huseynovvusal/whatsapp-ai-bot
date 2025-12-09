import { config } from "@/config/env"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { createLogger } from "@/lib/logger"

const logger = createLogger(config.LOG_LEVEL, "RateLimiter")

interface UserRequest {
  timestamp: number
}

export class RateLimiter {
  private userRequests: Map<string, UserRequest[]> = new Map()

  /**
   * Check if user has exceeded rate limit
   * @param userId - User identifier (phone number)
   * @returns true if user is within rate limit, false if exceeded
   */
  public canMakeRequest(userId: string): boolean {
    const now = Date.now()
    const windowMs = Number(runtimeConfig.get("rateLimitWindowMs")) || config.RATE_LIMIT_WINDOW_MS
    const maxRequests =
      Number(runtimeConfig.get("rateLimitMaxRequests")) || config.RATE_LIMIT_MAX_REQUESTS

    // Get user's request history
    let requests = this.userRequests.get(userId) || []

    // Remove requests outside the time window
    requests = requests.filter((req) => now - req.timestamp < windowMs)

    // Check if user has exceeded limit
    if (requests.length >= maxRequests) {
      logger.warn(`Rate limit exceeded for user ${userId}`)
      return false
    }

    // Add current request
    requests.push({ timestamp: now })
    this.userRequests.set(userId, requests)

    logger.debug(`User ${userId} has ${requests.length}/${maxRequests} requests in window`)
    return true
  }

  /**
   * Get remaining requests for a user
   */
  public getRemainingRequests(userId: string): number {
    const now = Date.now()
    const windowMs = Number(runtimeConfig.get("rateLimitWindowMs")) || config.RATE_LIMIT_WINDOW_MS
    const maxRequests =
      Number(runtimeConfig.get("rateLimitMaxRequests")) || config.RATE_LIMIT_MAX_REQUESTS

    const requests = this.userRequests.get(userId) || []
    const activeRequests = requests.filter((req) => now - req.timestamp < windowMs)

    return Math.max(0, maxRequests - activeRequests.length)
  }

  /**
   * Get time until next request is allowed (in seconds)
   */
  public getTimeUntilReset(userId: string): number {
    const now = Date.now()
    const windowMs = Number(runtimeConfig.get("rateLimitWindowMs")) || config.RATE_LIMIT_WINDOW_MS

    const requests = this.userRequests.get(userId) || []
    if (requests.length === 0) return 0

    const oldestRequest = requests[0]
    const timeUntilReset = Math.max(0, windowMs - (now - oldestRequest.timestamp))

    return Math.ceil(timeUntilReset / 1000) // Convert to seconds
  }

  /**
   * Clear expired requests periodically to prevent memory leaks
   */
  public startCleanup(): void {
    setInterval(
      () => {
        const now = Date.now()
        const windowMs =
          Number(runtimeConfig.get("rateLimitWindowMs")) || config.RATE_LIMIT_WINDOW_MS

        for (const [userId, requests] of this.userRequests.entries()) {
          const activeRequests = requests.filter((req) => now - req.timestamp < windowMs)

          if (activeRequests.length === 0) {
            this.userRequests.delete(userId)
          } else {
            this.userRequests.set(userId, activeRequests)
          }
        }

        logger.debug(`Rate limiter cleanup: ${this.userRequests.size} users tracked`)
      },
      5 * 60 * 1000
    ) // Cleanup every 5 minutes
  }
}

// Singleton instance
export const rateLimiter = new RateLimiter()

// Start cleanup on initialization
rateLimiter.startCleanup()
