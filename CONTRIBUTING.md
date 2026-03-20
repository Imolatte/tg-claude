# Contributing to TG Claude

Thanks for your interest! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/Imolatte/tg-claude.git
cd tg-claude/worker && npm install
cp ../config.example.json ../config.json
# Fill in your bot token, chat ID, and Groq API key
node index.mjs
```

## Project Structure

```
worker/
  index.mjs           Main bot logic (polling, commands, streaming)
  executor.mjs         Spawns Claude Code CLI, parses stream-json events
  sessions.mjs         Session state management
  locale.mjs           i18n strings (EN + RU)
  voice.mjs            Groq Whisper STT + local fallback
  mcp-telegram.mjs     MCP server for Claude → Telegram messaging

approval-hook.mjs      Claude Code PreToolUse hook (approval buttons)
stop-hook.mjs          Claude Code Stop hook (completion notification)
notify-hook.mjs        Legacy notification hook
mode.mjs               CLI tool for switching output modes
```

## How to Contribute

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Test locally with your own bot
5. Submit a PR

## Guidelines

- **Keep it simple** — this is a single-file-heavy project by design
- **No frameworks** — we use vanilla Node.js with zero runtime dependencies (except Puppeteer for screenshots)
- **ESM only** — all files use `.mjs` extension and ES module imports
- **i18n** — if adding user-facing strings, add both `en` and `ru` translations in `locale.mjs`
- **No TypeScript** — the project is intentionally plain JavaScript for simplicity

## Adding a New Command

1. Add the handler in `worker/index.mjs` in the command section
2. Add locale strings to `worker/locale.mjs` (both `en` and `ru`)
3. Update `README.md` command table
4. Test in Telegram

## Adding a New Language

1. Add a new locale object in `worker/locale.mjs` following the existing `en`/`ru` pattern
2. Every key from `en` must be present in the new locale
3. Submit a PR — we welcome translations!

## Reporting Bugs

Use [GitHub Issues](https://github.com/Imolatte/tg-claude/issues) with the bug report template.
