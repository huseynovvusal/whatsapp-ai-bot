import { Request, Response, NextFunction } from "express"
import bcrypt from "bcryptjs"
import crypto from "crypto"
import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"

const logger = createLogger(config.LOG_LEVEL, "AuthMiddleware")

// Extend Express Request to include session
declare module "express-session" {
  interface SessionData {
    isAuthenticated: boolean
    username: string
    csrfToken?: string
  }
}

// Simple in-memory user store (you can extend this to use database)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin"
const USING_DEFAULT_PASSWORD = !process.env.ADMIN_PASSWORD_HASH
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync("admin123", 10)

// A publicly reachable panel with the documented default password is an open
// door. Refuse to start in production rather than run silently insecure.
if (USING_DEFAULT_PASSWORD) {
  const message =
    "ADMIN_PASSWORD_HASH is not set — the admin panel is using the default password 'admin123'. " +
    'Generate one with: node -e "console.log(require(\'bcryptjs\').hashSync(\'your-password\', 10))"'
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${message} Refusing to start in production.`)
  }
  logger.warn(`⚠️  ${message}`)
}

/**
 * Failed-login throttling, per source address.
 *
 * The login route is the one unauthenticated endpoint on the panel, and bcrypt
 * comparison is cheap enough to brute-force at network speed without this.
 */
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000
const failedLogins: Map<string, { count: number; firstAttempt: number }> = new Map()

function clientKey(req: Request): string {
  return req.ip || req.socket?.remoteAddress || "unknown"
}

/** Remaining lockout in seconds, or 0 when the caller may try again. */
function lockoutRemaining(key: string): number {
  const entry = failedLogins.get(key)
  if (!entry) return 0
  const elapsed = Date.now() - entry.firstAttempt
  if (elapsed > LOCKOUT_MS) {
    failedLogins.delete(key)
    return 0
  }
  if (entry.count < MAX_FAILED_ATTEMPTS) return 0
  return Math.ceil((LOCKOUT_MS - elapsed) / 1000)
}

function recordFailure(key: string): void {
  const entry = failedLogins.get(key)
  if (!entry || Date.now() - entry.firstAttempt > LOCKOUT_MS) {
    failedLogins.set(key, { count: 1, firstAttempt: Date.now() })
    return
  }
  entry.count++
}

// Drop expired entries so the map cannot grow without bound.
setInterval(
  () => {
    const now = Date.now()
    for (const [key, entry] of failedLogins.entries()) {
      if (now - entry.firstAttempt > LOCKOUT_MS) failedLogins.delete(key)
    }
  },
  5 * 60 * 1000
).unref?.()

/**
 * CSRF protection for state-changing admin requests.
 *
 * Authentication is a session cookie, which the browser attaches to any request
 * a third-party page makes — so without this, a page the admin merely visits
 * could POST to this panel on their behalf (disable the bot, rewrite prompts,
 * clear memory). The token is minted per session and must be echoed in a header,
 * which cross-origin JavaScript cannot read or set.
 */
export function issueCsrfToken(req: Request): string {
  if (!req.session) return ""
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex")
  }
  return req.session.csrfToken
}

export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  // Safe methods do not change state and are exempt.
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next()
  }

  const expected = req.session?.csrfToken
  const provided = req.get("x-csrf-token") || (req.body && req.body._csrf)

  if (!expected || !provided) {
    logger.warn(`Blocked ${req.method} ${req.path}: CSRF token missing`)
    res.status(403).json({ error: "CSRF token missing or invalid. Reload the page and retry." })
    return
  }

  const a = Buffer.from(String(expected))
  const b = Buffer.from(String(provided))
  // Constant-time compare so the token cannot be guessed byte by byte.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    logger.warn(`Blocked ${req.method} ${req.path}: CSRF token mismatch`)
    res.status(403).json({ error: "CSRF token missing or invalid. Reload the page and retry." })
    return
  }

  next()
}

export class AuthMiddleware {
  /**
   * Check if user is authenticated
   */
  public static requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (req.session && req.session.isAuthenticated) {
      next()
    } else {
      res.status(401).json({ error: "Unauthorized. Please login first." })
    }
  }

  /**
   * Login handler
   */
  public static async login(req: Request, res: Response): Promise<void> {
    const { username, password } = req.body
    const key = clientKey(req)

    const lockedFor = lockoutRemaining(key)
    if (lockedFor > 0) {
      logger.warn(`Login blocked for ${key}: too many failed attempts`)
      res.status(429).json({
        error: `Too many failed attempts. Try again in ${Math.ceil(lockedFor / 60)} minute(s).`,
      })
      return
    }

    if (!username || !password) {
      res.status(400).json({ error: "Username and password are required" })
      return
    }

    try {
      // Both checks always run: short-circuiting on the username would let an
      // attacker distinguish "wrong user" from "wrong password" by timing.
      const isValidUsername = username === ADMIN_USERNAME
      const isValidPassword = await bcrypt.compare(password, ADMIN_PASSWORD_HASH)

      if (isValidUsername && isValidPassword) {
        failedLogins.delete(key)
        if (req.session) {
          // Prevent session fixation: a pre-login cookie must not become an
          // authenticated one.
          req.session.regenerate((err) => {
            if (err) {
              logger.error("Session regeneration failed", err)
              res.status(500).json({ error: "Internal server error" })
              return
            }
            req.session.isAuthenticated = true
            req.session.username = username
            // Regeneration cleared any previous token; mint one for this session.
            issueCsrfToken(req)
            logger.info(`Admin logged in: ${username}`)
            res.json({ success: true, message: "Login successful" })
          })
          return
        }
        logger.info(`Admin logged in: ${username}`)
        res.json({ success: true, message: "Login successful" })
      } else {
        recordFailure(key)
        logger.warn(`Failed login attempt for username: ${username} from ${key}`)
        res.status(401).json({ error: "Invalid username or password" })
      }
    } catch (error) {
      logger.error("Login error:", error)
      res.status(500).json({ error: "Internal server error" })
    }
  }

  /**
   * Logout handler
   */
  public static logout(req: Request, res: Response): void {
    if (req.session) {
      const username = req.session.username
      req.session.destroy((err) => {
        if (err) {
          logger.error("Logout error:", err)
          res.status(500).json({ error: "Failed to logout" })
        } else {
          logger.info(`Admin logged out: ${username}`)
          res.json({ success: true, message: "Logout successful" })
        }
      })
    } else {
      res.json({ success: true, message: "Already logged out" })
    }
  }

  /**
   * Check auth status
   */
  public static checkAuth(req: Request, res: Response): void {
    if (req.session && req.session.isAuthenticated) {
      res.json({
        isAuthenticated: true,
        username: req.session.username
      })
    } else {
      res.json({ isAuthenticated: false })
    }
  }
}
