# TG Claude - Telegram Bridge for Claude Code

## What This Is
Node.js bot that turns Mac into remote Claude Code terminal via Telegram. Not an API wrapper - runs real CLI with full tool access.

## Architecture
```
User (Telegram) -> Bot (Node.js) -> Claude Code CLI -> tools -> response -> User
```

## Key Files
- `worker/` - Claude Code session management, message processing
- `approval-hook.mjs` - PreToolUse hook, sends approval buttons to Telegram
- `stop-hook.mjs` - Stop hook, notifies on session end
- `notify-hook.mjs` - Notification hook
- `mode.mjs` - Mode management (auto/confirm)
- `bot-system-prompt.md` - System prompt injected into every Claude session
- `config.json` - Bot token, allowed users, settings (NEVER commit)
- `launcher.sh` - Process manager

## Rules
- **Telegram HTML formatting only** - no Markdown. Use `<b>`, `<code>`, `<pre>` tags
- **No Markdown tables** - Telegram doesn't render them
- **Concise responses** - phone screen, not desktop
- **bot-system-prompt.md** is the system prompt for Telegram sessions - edit there, not here
- **config.json** contains secrets - always in .gitignore
- **test.txt** in root is test artifact, can be deleted

## Stack
- Node.js 20+ (ESM, .mjs)
- grammY (Telegram bot framework)
- Claude Code CLI (spawned as child process)
- No database - sessions in memory, config in JSON
