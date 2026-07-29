import "dotenv/config"
import { defineConfig, env } from "prisma/config"

/**
 * Prisma 7 moved the connection URL out of schema.prisma and into this file.
 * Runtime connections go through the driver adapter in `src/lib/prisma.ts`;
 * this config is what `prisma migrate` / `prisma db` use.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
})
