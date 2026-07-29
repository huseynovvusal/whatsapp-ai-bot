# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A TypeScript-based WhatsApp bot using Baileys library and Google Gemini/OpenAI for AI-powered responses. The bot connects via QR code, responds to mentions in groups and all messages in private chats, maintains conversation memory, and includes an admin web UI.

## Development Commands

```bash
# Start development server with auto-reload and pretty logs
npm run dev

# Start production mode with ts-node
npm run start

# Build TypeScript to JavaScript
npm run build

# Seed the database with demo data (see "Fixtures / demo data" below)
npm run seed
npm run seed -- --days 30   # shorter window
npm run seed -- --reset     # wipe demo data, then re-seed
npm run seed -- --clean     # wipe demo data and exit

# Format code
npm run prettier

# Lint code
npm run lint

# Lint and auto-fix
npm run lint:fix

# Docker commands
npm run docker:build   # Build Docker image
npm run docker:up      # Start with docker-compose
npm run docker:down    # Stop docker-compose
npm run docker:logs    # View logs
```

## Architecture

### Core Services (Singleton Pattern)

All major services are singleton instances created at module level:

- **whatsappService** (`src/services/whatsapp.service.ts`) - Manages WhatsApp connection via Baileys, handles QR code auth, reconnection logic, message parsing, reply functionality, and mention tagging
- **llmService** (`src/services/llm.service.ts`) - Abstracts AI provider (Gemini/OpenAI/DeepSeek/Kimi), handles chat completions and contextual reply decisions
- **memoryService** (`src/services/memory.service.ts`) - Stores message history per chat (group/private) with sender names, manages retention window and message limits, tracks participants
- **userProfileService** (`src/services/userProfile.service.ts`) - Tracks user profiles (phone numbers + WhatsApp display names) to remember who people are across conversations
- **databaseService** (`src/services/database.service.ts`) - SQLite database for persisting messages, users, conversations, and analytics
- **wsService** (`src/services/websocket.service.ts`) - WebSocket server for real-time logs, QR code display, and connection status streaming to admin panel
- **runtimeConfig** (`src/services/runtimeConfig.service.ts`) - Persists config to `runtime_config.json`, allows runtime changes without restart
- **rateLimiter** (`src/services/ratelimit.service.ts`) - Prevents spam by tracking user request counts per time window
- **messageHandler** (`src/handlers/message.handler.ts`) - Coordinates message processing, admin commands, rate limiting, and AI response generation

### Message Flow

1. Baileys emits `messages.upsert` event → `whatsappService.handleIncomingMessage()`
2. Message parsed for text, mentions, reply context → Extract sender's WhatsApp `pushName` → Update `userProfileService`
3. Creates `MessageInfo` object with sender phone + display name
4. `MessageInfo` passed to `messageHandler.handle()`
5. Handler checks: admin command (`!` prefix) → route to admin logic
6. Otherwise: add to memory with sender name → check if should respond (group mention/reply or private chat)
7. If responding: check rate limit → get context with participant names → call LLM → parse @mentions → send reply with mention tagging

### Key Concepts

**Path Aliases**: The codebase uses `@/*` to alias `src/*` (configured in tsconfig.json and run with `ts-node -r tsconfig-paths/register`)

**Group Behavior**: Bot only responds when mentioned (`@bot`) or replied to in groups, but stores all messages for context. Use `respondToGroupMessages` config to enable responding to all group messages.

**Private Chat**: Responds to all messages by default, controllable via `enablePrivateChat` runtime config

**Native Replies**: Uses WhatsApp's native reply feature (`sendReply()`) to maintain conversation threading

**Phone Number Handling**: All phone numbers are normalized via `cleanPhoneNumber()` utility (`src/utils/phone.utils.ts`) to strip `@s.whatsapp.net` or `@g.us` suffixes

**User Identity Tracking**: Bot automatically captures WhatsApp display names (`pushName`) from incoming messages and stores them in `userProfileService`. Context now shows "John: message" instead of "+1234567890: message"

**Mention/Tagging**: Bot can tag users in responses using `@Name` format. The `parseMentions()` utility (`src/utils/mention.utils.ts`) converts AI-generated @Name mentions to WhatsApp's native mention format with JIDs. Participant list is passed to LLM in context so it knows who it can mention.

**Personality modes** (`src/services/persona.service.ts`): every chat runs as either
**Assistant** (concise, task-focused) or **Companion** (conversational, matches the group's
tone). Each mode owns its own system prompt, so switching a chat swaps the whole voice
without editing text. Resolution order is *chat override → global default*; overrides live
in the `chat_settings` table and are set from the Conversations tab or `!mode`.

Companion is **proactive by construction**: `decideResponse()` routes its group messages to
the contextual path regardless of `respondToGroupMessages`, so it joins in when it has
something to add. It never overrides a safety switch — `botEnabled`, access control and
`enablePrivateChat` all still gate it.

Companion also stays honest by default: its built-in prompt tells it to admit it is a bot
if someone sincerely asks, and never to claim to be a specific real person. Editing the
prompt in the admin UI replaces that, so keep the clause if you want the behaviour.

**Emoji reactions**: Companion's reactions come from the *same* LLM call that decides
whether to reply (`askForReactiveReply` returns `{shouldReply, reply, reaction}`), so they
cost no extra request — and a reaction with `shouldReply: false` is how the bot
acknowledges something without talking. On the direct-mention path there is no decision
call to piggyback on, so a keyword pass picks the emoji rather than paying for a request on
every mention; Assistant keeps a neutral 👀. Values are validated by
`sanitiseEmoji()` (`src/utils/emoji.utils.ts`) both when parsing the model response and
again in `react()` immediately before sending, since models reply "none" or ":)" often
enough that the send site cannot trust its caller.

**Companion modifiers** — three settings that only apply to chats in Companion mode:

- **Adaptive style** (`companionAdaptiveStyle`, on by default). `styleService` profiles how a
  chat actually writes — message length, emoji rate, lowercase habits, chat shorthand,
  non-Latin script — from messages already in SQLite, and renders it as prompt guidance.
  **No LLM call**, so matching a group's voice costs nothing per message; profiles are cached
  10 minutes. The bot's own messages are excluded from the sample so it mirrors the people in
  the chat rather than drifting toward its own prior style. The guidance describes the
  register instead of supplying phrases to copy — a bot parroting exact wording reads as
  mockery, not rapport.
- **Free mode** (`companionFreeMode`, off by default). A register control: allows swearing,
  dark humour and blunt opinions, and removes hedging, disclaimers and moralising. It keeps
  one "read the room" clause, since dropping the banter when someone is genuinely upset is
  what a real friend does. It is a prompt, so it cannot change what the provider itself
  refuses — that happens server-side, above any prompt.
- **Maximum reply length** (`companionMaxChars`, default 350; 0 = no limit). Enforced twice:
  `askLLM` receives a matching `maxTokens` budget (both providers), and anything still over is
  trimmed on a sentence boundary by `trimToLength()`. Assistant mode is never capped.

`personaService.getPromptForChat()` composes these in a deliberate order: base prompt → free
mode → adapted style → length rule. The length rule goes last because it is the hardest
instruction for a model to hold, and recency helps.

**Live traffic only**: `messages.upsert` fires for both new messages (`type: "notify"`)
and history sync (`type: "append"`). Only `notify` is handled — Baileys replays older
messages on connect and after every reconnect, and answering those would make the bot blast
replies into old conversations. Two further guards back this up: recently-seen message IDs
are remembered (bounded at 1000) so a redelivery is not answered twice, and anything more
than 5 minutes old is treated as replay regardless of type.

**Provider resilience**: `llmService.withRetry()` retries rate limits, timeouts and provider
outages up to 3 times with exponential backoff plus jitter. Authentication failures are *not*
retried — they cannot fix themselves, and retrying only delays telling the operator. Failures
become an `LLMError` carrying a user-facing message, so a chat sees "I'm being rate-limited,
try again in a moment" or "my credentials are not working" instead of a blanket
"something went wrong". Reconnects to WhatsApp use exponential backoff too (5s doubling to a
5-minute cap, reset on a successful connection).

**Analytics counters vs snapshots**: in `updateAnalytics`, `totalMessages`/`apiCalls`/
`tokensUsed` accumulate, while `totalUsers`/`totalConversations` are snapshots that are only
written when a value is supplied. Passing them through `COALESCE(excluded.x, x)` against an
already-defaulted 0 meant COALESCE never saw NULL, so every incoming message silently reset
both columns to zero.

**Admin panel security**: the login route throttles failed attempts (5 per address, then a
15-minute lockout) since it is the only unauthenticated endpoint; the session is regenerated
on login to prevent fixation; and the insecure defaults (`admin123`, the fallback session
secret) log a warning in development and **refuse to start in production**.

**Memory, in two layers**: *short-term* memory is the recent conversation replayed into every prompt (`memoryService`), bounded by `memoryMessageLimit` and `memoryWindowMs` — both read from runtime config on every use, and both accept **0 meaning "unlimited"/"never expires"**. *Long-term* memory is retrieval (`ragService`): older conversation is chunked, embedded and searched by meaning, so the bot can recall things from months ago without replaying everything. Prefer raising recall over raising the short-term limits — token cost grows with the window but stays flat with retrieval.

**Outbound guard**: `messageHandler.decideResponse()` is the single place that decides whether the bot may speak. It runs *before* any outbound side effect — reply, typing indicator, or emoji reaction — so a disabled setting produces true silence. Previously the 👀 reaction was sent before the private-chat check, so disabling private replies still produced a visible reaction. The error notice in the `catch` is likewise gated on having committed to replying, so failures never leak into chats the bot should be quiet in.

**System Prompt (applied immediately)**: `runtimeConfig` is the single source of truth for the system prompt. `memoryService.getSystemPrompt()` reads it from runtime config on every call, and `memoryService.setSystemPrompt()` persists it there. Both the admin UI (`/save`) and the `!system` command go through `setSystemPrompt`, so prompt changes take effect on the very next LLM call without a restart.

**Admin Commands**: Defined in `src/handlers/message.handler.ts:205`, validated via `AdminUtils.isAdmin()` checking against `ADMIN_NUMBERS` config

**Session Persistence**: WhatsApp auth stored in `auth_info_baileys/` directory, QR code only needed on first run

## Configuration

Environment variables loaded via `src/config/env.ts` from `.env` file. Runtime overrides stored in `runtime_config.json` at project root.

Key environment variables:
- `GEMINI_API_KEY` or `OPENAI_API_KEY` - Required for AI provider
- `OPENAI_BASE_URL` - Custom API endpoint (for DeepSeek, Kimi, DigitalOcean, etc.)
- `OPENAI_MODEL` - Model name (e.g., `deepseek-chat`, `moonshot-v1-32k`, `gpt-4o-mini`)
- `ADMIN_NUMBERS` - Comma-separated phone numbers (no spaces, no `+`)
- `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` - Admin panel authentication
- `SESSION_SECRET` - Session secret for admin panel (min 32 chars)
- `BOT_NAME` - Mention trigger (default `@bot`)
- `RATE_LIMIT_MAX_REQUESTS` / `RATE_LIMIT_WINDOW_MS` - Rate limiting config
- `MEMORY_WINDOW_MS` - How long to retain messages in memory

### Supported AI Providers

The bot supports multiple OpenAI-compatible providers via custom base URLs:

**Google Gemini** (default):
```bash
LLM_PROVIDER=gemini
GEMINI_API_KEY=your-key
GEMINI_MODEL=gemini-1.5-flash
```

**OpenAI**:
```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=your-key
OPENAI_MODEL=gpt-4o-mini
```

**DeepSeek**:
```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=your-deepseek-key
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-chat
```

**Kimi (Moonshot)**:
```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=your-kimi-key
OPENAI_BASE_URL=https://api.moonshot.cn/v1
OPENAI_MODEL=moonshot-v1-32k
```

## Admin Commands

All commands start with `!` and are processed in `src/handlers/message.handler.ts:handleAdminCommand()`:

- `!help` - List available commands
- `!status` - Show memory stats, LLM config, system prompt
- `!clear [all|chatId]` - Clear memory for current chat, specific chat, or all chats
- `!system <prompt>` - Update the prompt for this chat's personality mode
- `!mode [assistant|companion]` - Show or set this chat's personality mode
- `!private on|off` - Enable/disable private chat responses

## Admin Web UI

Available at `http://localhost:3000/admin/login` when bot is running. Mounted via `src/routes/admin.router.ts`.

**Features**:
- **Authentication**: Login with `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` (bcrypt)
- **Dashboard**: Real-time stats (messages, users, conversations, today's activity)
- **Settings Tab**: Bot name, admin numbers, rate limits, LLM provider/keys, the two
  personality prompts, memory limits and recall settings
- **Conversations Tab**: View recent conversations and search messages
- **Analytics Tab**: Usage statistics, served by `GET /api/analytics?days=7|30|90`
  - A single filter row (7/30/90 days) scopes every stat, chart and table on the tab,
    so all the numbers on screen always describe the same window
  - KPI row: messages, AI calls, tokens used, active people (with deltas vs the
    preceding equal-length window where a baseline exists)
  - Charts: messages per day (line + area), activity by hour (columns), most active
    people and busiest chats (ranked bars)
  - Every chart has a **table view** toggle, so no value is reachable only by hovering
  - Rendering lives in `public/js/analytics.js` — hand-rolled inline SVG with **no
    charting dependency**, so the panel works on an air-gapped host. Charts render on
    first reveal of the tab (they need a measurable width) and re-render on resize.
  - Chart colors are declared once as CSS custom properties (`--chart-*`) in
    `views/admin.ejs`; the series hue is the app's brand indigo, validated for
    contrast and colour-vision safety against the white card surface
- **People Tab**: Identity and directory
  - The bot's own connected account (`GET /api/me`)
  - Everyone the bot has seen, searchable, with message/chat counts (`GET /api/users`)
  - Per-person detail: profile, which chats they appear in, recent messages
    (`GET /api/users/:phone` — tolerates the number with or without a `+` prefix)
  - Chat participants (`GET /api/chats/:chatId/participants`). For groups this comes
    from WhatsApp, so it includes people who have never spoken, plus group-admin roles,
    enriched with what the database knows
- **Memory Tab**: Long-term recall management (see "Long-term memory (RAG)" below)
  - Index status, chunk counts, embedding model in use
  - Index new / Rebuild all / Clear
  - **Test recall**: run a query and see exactly what the bot would remember, with
    similarity scores, without sending a WhatsApp message
- **Logs Tab**: Real-time logs viewer with WebSocket streaming
  - Live log streaming from all services. Every winston log (`logger.*`) is bridged
    to the admin panel via a custom transport in `src/lib/logger.ts`
    (`WebSocketTransport` → `wsService.pushLog()`), so the tab reflects real activity
    instead of only manually-instrumented messages. INFO and above are streamed to
    keep the view readable; DEBUG stays in the console/file logs.
  - Client-side controls: level filter, message search, entry count, download logs
  - QR code display for WhatsApp connection
  - Connection status indicator (connected/disconnected)
  - Auto-scroll toggle and clear logs buttons
  - Color-coded log levels (info, success, warn, error, debug)

All settings changes are persisted to `runtime_config.json` and picked up immediately without restart (where applicable).

### WebSocket Integration

The admin panel connects to `ws://localhost:3000/ws` for real-time updates:
- **Log streaming**: All application logs are broadcasted to connected admin clients
- **QR code display**: QR code appears automatically in the Logs tab when needed
- **Connection status**: Shows WhatsApp connection status and connected phone number
- **Auto-reconnect**: WebSocket automatically reconnects if connection is lost

## Long-term memory (RAG)

`src/services/rag.service.ts` gives the bot recall beyond its recent-message window.

**Pipeline**: stored messages → chunked (break on a 30-minute silence, 12 messages, or
1600 chars) → embedded once via `embeddingService` → stored as an L2-normalised Float32
BLOB in `knowledge_chunks`. At reply time the incoming message is embedded and the
nearest chunks are prepended to the prompt by `messageHandler.buildContext()`.

**Why SQLite and not a vector database**: vectors are normalised on write, so similarity
is a dot product and search is a linear scan over `knowledge_chunks` — no extra service to
deploy, and the bot stays a single self-contained container. Measured at ~1,250 chunks the
full index+search cycle is well under 100ms. If the corpus ever outgrows a linear scan,
the access points are narrow (`insertKnowledgeChunks` / `searchKnowledgeChunks`), so a
dedicated vector store can be swapped in behind them. LangChain is deliberately **not**
used — the whole pipeline is a few hundred lines against the provider SDKs directly.

**Indexing** is incremental, driven by a per-chat watermark in `knowledge_state`, and runs
in the background every 5 minutes (`startBackgroundIndexing`, wired up in `index.ts`).
Chunks record the embedding model that produced them, and search filters on it — so
changing model yields no stale matches rather than silently wrong ones. Use **Rebuild all**
in the Memory tab after a model change.

**Privacy**: recall is scoped to the current chat unless `ragCrossChat` is enabled, which
decides whether something said in one group can surface in another. Off by default.

Retrieval failures are always swallowed — a reply must never fail because recall did.

## Fixtures / demo data

`scripts/seed.ts` (`npm run seed`) populates the SQLite database with realistic demo
traffic so the dashboard — especially the Analytics tab — can be developed and
reviewed without waiting for weeks of real usage.

- Generates messages across 3 demo groups and 3 demo private chats, spread over N days
  with a weekday/weekend rhythm, an hour-of-day curve, and a gentle upward trend
- Uses a **deterministic PRNG**, so repeated runs produce the same reviewable dataset
- Derives the `analytics` rows from the generated messages, so the totals, charts and
  per-chat/per-user breakdowns all agree with each other
- All demo rows are namespaced behind `demo-*` chat IDs and `999000*` phone numbers, so
  `--reset` / `--clean` remove exactly what the script created and never touch real
  conversations

`scripts/` sits outside `rootDir` (`./src`), so it is excluded from `npm run build`;
`ts-node` type-checks it at run time.

## Analytics data model

`databaseService.updateAnalytics()` maintains one row per date. Two things feed it:

- **`totalMessages`** — incremented by `memoryService.addMessage()`
- **`apiCalls` / `tokensUsed`** — incremented by `recordUsage()` in
  `src/services/llm.service.ts` after every completion, vision call and contextual
  reply decision, reading `usage.total_tokens` (OpenAI) or
  `usageMetadata.totalTokenCount` (Gemini). Analytics failures are swallowed so they
  can never break a reply.

Range-scoped breakdowns (`getTopUsers`, `getTopConversations`, `getHourlyActivity`,
`getRangeTotals`) are computed from the `messages` table rather than the daily
aggregates, which keeps them consistent with each other. The bot's own messages are
stored with sender `Bot` and excluded from "most active people".

## Testing

To test the bot:
1. Run `npm run dev`
2. Scan QR code with WhatsApp (Settings → Linked Devices → Link a Device)
3. Send message in private chat or mention `@bot` in group
4. Use `!status` command to verify configuration

## File References

When discussing code locations, use the format `file:line` (e.g., `src/services/whatsapp.service.ts:233` for mention detection logic).

## Docker Deployment

### Quick Start

```bash
# 1. Build image
docker-compose build

# 2. Start container
docker-compose up -d

# 3. View logs
docker-compose logs -f

# 4. Stop container
docker-compose down
```

### Environment Setup

Create `.env` file with required variables (see `.env.example`)

### Volumes

Docker persists data in:
- `./auth_info_baileys` - WhatsApp session
- `./data` - SQLite database
- `./logs` - Application logs

### Production Deployment

1. Set `NODE_ENV=production`
2. Configure strong `SESSION_SECRET`
3. Generate secure `ADMIN_PASSWORD_HASH`
4. Use HTTPS reverse proxy (nginx/Caddy)

## Code Quality

### ESLint

```bash
# Check code
npm run lint

# Auto-fix issues
npm run lint:fix
```

ESLint configured with TypeScript rules in `eslint.config.mjs` (uses ESM `import`, so the `.mjs` extension is required because `package.json` sets `"type": "commonjs"`)

### Prettier

```bash
npm run prettier
```

## Common Tasks

**Adding a new admin command**: Add case in `src/handlers/message.handler.ts:207` switch statement

**Changing LLM provider**: Update `LLM_PROVIDER` in `.env` or set `llmProvider` in admin UI, ensure API key is set

**Adjusting rate limits**: Modify `RATE_LIMIT_*` env vars or update via admin UI

**Adding runtime config**: Add field to `RuntimeConfigSchema` in `src/services/runtimeConfig.service.ts:8`, update defaults in constructor

**Debugging mention issues**: Check if participant list is populated in context (`memoryService.getParticipants()`), verify `parseMentions()` matches names correctly, ensure phone numbers are formatted as JIDs

**Improving user recognition**: User profiles are built from `pushName` in messages. If names aren't appearing, check that Baileys is providing `msg.pushName` in `whatsappService.handleIncomingMessage()`

**Debugging connection issues**: Check `logs/combined.log` and `logs/error.log`, delete `auth_info_baileys/` to force re-authentication

**Database queries**: Use `databaseService` methods for searching messages, getting stats, or analytics
