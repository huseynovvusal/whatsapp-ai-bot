import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"
import { runtimeConfig } from "@/services/runtimeConfig.service"
import { databaseService } from "@/services/database.service"

const logger = createLogger(config.LOG_LEVEL, "BudgetService")

/**
 * Spending guardrails.
 *
 * The bot is driven by whoever is in the chat, so without a ceiling a busy group
 * (or a loop) can run up an unbounded provider bill. Budgets are expressed in
 * tokens rather than currency: token counts are what the providers actually
 * report, so they cannot drift out of date the way a hardcoded price list does.
 * An optional price-per-million converts them to an estimated cost for display.
 */
export interface BudgetStatus {
  enabled: boolean
  dailyTokenLimit: number
  monthlyTokenLimit: number
  tokensToday: number
  tokensThisMonth: number
  callsToday: number
  /** Which limit, if any, is currently exceeded. */
  exceeded: "daily" | "monthly" | null
  /** 0-1, the higher of the two utilisations. */
  utilisation: number
  estimatedCostToday: number | null
  estimatedCostThisMonth: number | null
  currency: string
}

export class BudgetService {
  /** Cached so the hot path does not hit SQLite on every single message. */
  private cache: { status: BudgetStatus; at: number } | null = null
  private readonly cacheTtlMs = 30 * 1000

  public isEnabled(): boolean {
    return runtimeConfig.get("budgetEnabled") === true
  }

  private limit(key: "dailyTokenLimit" | "monthlyTokenLimit"): number {
    const value = Number(runtimeConfig.get(key))
    return Number.isFinite(value) && value > 0 ? value : 0
  }

  /** Current usage against the configured ceilings. */
  public async getStatus(force = false): Promise<BudgetStatus> {
    if (!force && this.cache && Date.now() - this.cache.at < this.cacheTtlMs) {
      return this.cache.status
    }

    const dailyTokenLimit = this.limit("dailyTokenLimit")
    const monthlyTokenLimit = this.limit("monthlyTokenLimit")

    const today = new Date().toISOString().split("T")[0]
    const monthStart = `${today.slice(0, 7)}-01`

    let tokensToday = 0
    let callsToday = 0
    let tokensThisMonth = 0
    try {
      const todayRow = await databaseService.getTodayStats()
      tokensToday = todayRow?.tokensUsed || 0
      callsToday = todayRow?.apiCalls || 0
      for (const row of await databaseService.getAnalytics(monthStart, today)) {
        tokensThisMonth += row.tokensUsed || 0
      }
    } catch (err) {
      // Never let a bookkeeping failure block replies — fail open.
      logger.warn("Could not read usage for budget check", err)
    }

    const dailyUse = dailyTokenLimit > 0 ? tokensToday / dailyTokenLimit : 0
    const monthlyUse = monthlyTokenLimit > 0 ? tokensThisMonth / monthlyTokenLimit : 0

    let exceeded: BudgetStatus["exceeded"] = null
    if (this.isEnabled()) {
      if (dailyTokenLimit > 0 && tokensToday >= dailyTokenLimit) exceeded = "daily"
      else if (monthlyTokenLimit > 0 && tokensThisMonth >= monthlyTokenLimit) exceeded = "monthly"
    }

    const pricePerMillion = Number(runtimeConfig.get("costPerMillionTokens")) || 0
    const toCost = (tokens: number) =>
      pricePerMillion > 0 ? Number(((tokens / 1_000_000) * pricePerMillion).toFixed(4)) : null

    const status: BudgetStatus = {
      enabled: this.isEnabled(),
      dailyTokenLimit,
      monthlyTokenLimit,
      tokensToday,
      tokensThisMonth,
      callsToday,
      exceeded,
      utilisation: Math.min(1, Math.max(dailyUse, monthlyUse)),
      estimatedCostToday: toCost(tokensToday),
      estimatedCostThisMonth: toCost(tokensThisMonth),
      currency: String(runtimeConfig.get("costCurrency") || "USD"),
    }

    this.cache = { status, at: Date.now() }
    return status
  }

  /**
   * Whether an LLM call may proceed. Returns a user-facing reason when not.
   *
   * Deliberately fails open: if usage cannot be read, the bot keeps working
   * rather than going silent over a bookkeeping problem.
   */
  public async check(): Promise<{ allowed: boolean; reason?: string }> {
    if (!this.isEnabled()) return { allowed: true }

    const status = await this.getStatus()
    if (!status.exceeded) return { allowed: true }

    const scope = status.exceeded === "daily" ? "daily" : "monthly"
    logger.warn(
      `Budget exceeded (${scope}): ${status.exceeded === "daily" ? status.tokensToday : status.tokensThisMonth} tokens`
    )
    return {
      allowed: false,
      reason:
        scope === "daily"
          ? "💤 I've hit my daily usage limit. I'll be back tomorrow."
          : "💤 I've hit my monthly usage limit. An admin can raise it in the dashboard.",
    }
  }

  /** Called after usage is recorded so the next check sees fresh numbers. */
  public invalidate(): void {
    this.cache = null
  }
}

export const budgetService = new BudgetService()
