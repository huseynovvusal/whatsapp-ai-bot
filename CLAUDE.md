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
- `!system <prompt>` - Update system prompt (persisted to runtime config)
- `!private on|off` - Enable/disable private chat responses

## Admin Web UI

Available at `http://localhost:3000/admin/login` when bot is running. Mounted via `src/routes/admin.router.ts`.

**Features**:
- **Authentication**: Login with `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` (bcrypt)
- **Dashboard**: Real-time stats (messages, users, conversations, today's activity)
- **Settings Tab**: Configure bot name, admin numbers, rate limits, LLM provider/keys, system prompt
- **Conversations Tab**: View recent conversations and search messages
- **Analytics Tab**: Usage statistics (coming soon)
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
