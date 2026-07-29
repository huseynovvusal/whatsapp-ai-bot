# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# base — shared by every stage, so dev and production do not each re-resolve
# dependencies.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS base
WORKDIR /app
# openssl is required by Prisma's query engine; the rest are for node-gyp.
RUN apk add --no-cache openssl python3 make g++
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./

# ---------------------------------------------------------------------------
# deps — full dependency tree, including devDependencies (ts-node, nodemon).
# ---------------------------------------------------------------------------
FROM base AS deps
RUN npm ci
# Generate the Prisma client at build time so the image never needs network
# access on first boot.
RUN npx prisma generate

# ---------------------------------------------------------------------------
# dev — hot reload. Source is bind-mounted by docker compose, so nodemon sees
# edits made on the host and restarts ts-node. Source is deliberately NOT copied
# in: a copy would sit under the mount and make it ambiguous which code is live.
# ---------------------------------------------------------------------------
FROM deps AS dev
ENV NODE_ENV=development
EXPOSE 3000
CMD ["npm", "run", "dev:docker"]

# ---------------------------------------------------------------------------
# builder — compile TypeScript to JavaScript.
# ---------------------------------------------------------------------------
FROM deps AS builder
COPY tsconfig.json ./
COPY src ./src
COPY views ./views
COPY public ./public
RUN npm run build

# ---------------------------------------------------------------------------
# production — runtime only. No compiler, no dev dependencies.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS production
WORKDIR /app
RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy the generated client rather than re-running `prisma generate`, which
# would require the CLI (a devDependency) at runtime.
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/build ./build
COPY --from=builder /app/views ./views
COPY --from=builder /app/public ./public
# Migrations ship with the image so `prisma migrate deploy` can run at startup.
COPY prisma ./prisma
COPY prisma.config.ts ./

RUN mkdir -p /app/logs /app/auth_info_baileys

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "build/index.js"]
