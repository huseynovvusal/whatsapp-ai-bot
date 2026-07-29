import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { config } from "@/config/env"
import { createLogger } from "@/lib/logger"

const logger = createLogger(config.LOG_LEVEL, "Prisma")

/**
 * Shared Prisma client.
 *
 * Prisma 7 connects through a driver adapter rather than a URL in the schema,
 * so the connection string is read here and the same `pg` pool backs both the
 * generated client and the raw pgvector queries in `database.service.ts`.
 */
const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Point it at PostgreSQL, e.g. " +
      "postgresql://user:pass@localhost:5432/whatsapp_bot " +
      "(docker compose up db starts one for you)."
  )
}

const adapter = new PrismaPg({ connectionString })

export const prisma = new PrismaClient({
  adapter,
  log:
    config.LOG_LEVEL === "debug"
      ? [{ emit: "event", level: "query" }, "warn", "error"]
      : ["warn", "error"],
})

// Query logging is opt-in via LOG_LEVEL=debug — it is far too noisy otherwise.
if (config.LOG_LEVEL === "debug") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prisma as any).$on("query", (event: { query: string; duration: number }) => {
    logger.debug(`${event.duration}ms ${event.query}`)
  })
}

/** Verify connectivity at startup so a bad URL fails loudly, not on first message. */
export async function connectDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`
  const [{ installed }] = await prisma.$queryRaw<Array<{ installed: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed
  `
  if (!installed) {
    logger.warn(
      "The pgvector extension is not installed — long-term memory (RAG) will not work. " +
        "Run: CREATE EXTENSION vector;"
    )
  }
  logger.info("Connected to PostgreSQL")
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect()
}
