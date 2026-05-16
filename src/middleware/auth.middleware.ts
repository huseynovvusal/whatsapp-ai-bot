import { Request, Response, NextFunction } from "express"
import bcrypt from "bcryptjs"
import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"

const logger = createLogger(config.LOG_LEVEL, "AuthMiddleware")

// Extend Express Request to include session
declare module "express-session" {
  interface SessionData {
    isAuthenticated: boolean
    username: string
  }
}

// Simple in-memory user store (you can extend this to use database)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin"
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync("admin123", 10)

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

    if (!username || !password) {
      res.status(400).json({ error: "Username and password are required" })
      return
    }

    try {
      // Check credentials
      const isValidUsername = username === ADMIN_USERNAME
      const isValidPassword = await bcrypt.compare(password, ADMIN_PASSWORD_HASH)

      if (isValidUsername && isValidPassword) {
        if (req.session) {
          req.session.isAuthenticated = true
          req.session.username = username
        }
        logger.info(`Admin logged in: ${username}`)
        res.json({ success: true, message: "Login successful" })
      } else {
        logger.warn(`Failed login attempt for username: ${username}`)
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
