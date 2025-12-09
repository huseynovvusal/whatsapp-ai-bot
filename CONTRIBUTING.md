# Contributing to WhatsApp Group AI Bot

Thanks for your interest in contributing! This guide helps you set up your environment, follow the code style, and submit changes smoothly.

## 🧰 Prerequisites
- Node.js 18+ and npm
- Git
- A WhatsApp test number (recommended) and API keys (Gemini or OpenAI if applicable)

## 🚀 Getting Started
1. Fork the repo and clone your fork
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create your `.env` from the example:
   ```bash
   cp .env.example .env
   ```
   Fill in required values (admin numbers, API keys, etc.).
4. Start the dev server:
   ```bash
   npm run dev
   ```
   Scan the QR code to link your WhatsApp session.

## 📦 Project Scripts
- `npm run dev` — start in watch mode (ts-node + nodemon)
- `npm run build` — compile TypeScript
- `npm run start` — run via ts-node
- `npm run prettier` — format source files

## 🧑‍💻 Code Style & Linting
- TypeScript throughout (`src/**`).
- Keep functions small and purposeful.
- Prefer clear names and JSDoc on public functions.
- Run the formatter before committing:
  ```bash
  npm run prettier
  ```

## 🗂️ Branching & Commits
- Create feature branches from the default branch (e.g., `feat/ui-nested-toggles`, `fix/llm-timeout`).
- Use conventional commit style:
  - `feat:` new functionality
  - `fix:` bug fix
  - `docs:` documentation changes
  - `chore:` tooling/infra
  - `refactor:` code change that doesn’t add features or fix bugs

Examples:
```
feat(admin): add contextual group responses toggle
fix(memory): normalize jid base for mention detection
```

## ✅ Pull Requests
- Keep PRs focused and small (one change set per PR when possible).
- Include:
  - Summary of what changed and why
  - Screenshots/GIFs for UI changes
  - Any follow-up tasks or caveats
- Ensure the bot builds locally:
  ```bash
  npm run build
  ```
- If you add new runtime options, document them in `README.md`.

## 🔒 Security & Privacy
- Never commit secrets. Keep API keys in `.env`.
- Avoid exposing sensitive info in logs.
- Admin endpoints and UI should not be exposed publicly without auth.

## 🧪 Testing (Lightweight)
- Manual testing steps:
  - Group mention `@bot` reply behavior
  - Private chat responses
  - Admin UI save/load
  - Rate limiting edge cases (exceeded, admin bypass)
- If you add logic that’s easy to unit test, include minimal tests (optional in this project).

## 📜 Documentation
- Update `README.md` for user-facing changes.
- Add short notes for new features or toggles.

## 🧭 Release Checklist (for maintainers)
- Build passes
- README updated and screenshots (if relevant)
- Version bump in `package.json` if meaningful feature changes

## 🙌 Thanks!
Your contributions make the project better for everyone. If you’re unsure about anything, open a Draft PR or an issue and we’ll help you shape it.
