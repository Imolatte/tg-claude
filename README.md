# TG Claude

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-CLI-blueviolet.svg)](https://claude.ai/claude-code)

Personal Telegram bot that turns your Mac into a remote Claude Code terminal. Send messages from your phone — get full Claude Code CLI responses with tool access (Bash, Read, Write, Edit, Grep, etc.).

**Single-user, owner-only.** Not a multi-user service — one bot, one Telegram account, one Mac. Designed for developers who want to control their own machine remotely.

Not an API wrapper. Spawns the real Claude Code CLI process.

```
Phone (Telegram) → Bot (Node.js) → Claude Code CLI → response → Bot → Phone
```

## Quick Start

```bash
git clone https://github.com/Imolatte/tg-claude.git
cd tg-claude && cp config.example.json config.json
# Edit config.json with your bot token and chat ID
cd worker && npm install && node index.mjs
```

## Why

- Work from your phone when away from desk
- Run Claude Code remotely on your Mac
- Get dangerous operation approvals on your phone
- Quick system commands without opening laptop

## Features

### Core
- **Text** → Claude Code with full tool access
- **Voice** → Groq Whisper STT → Claude
- **Photos** → downloaded, passed to Claude for Vision analysis
- **Files** → downloaded with original extension, passed to Claude
- **Forwards** → analyzed by Claude (text before forward auto-combined)

### Display Modes

Two modes for what to show while Claude works:

| Mode | What you see |
|------|--------------|
| `tools` (default) | Which files/commands Claude is using: `🔧 Read: /src/auth.ts` |
| `thoughts` | Claude's streaming reasoning text as it thinks |

Switch with `/display`. Groups always use `thoughts` mode.

### Session Management
- Auto-resume sessions across messages (`--resume`)
- `/sessions` — inline keyboard to switch/delete sessions
- `/new [name]` — new session; `/name <title>` — rename
- `/detach` — disconnect; `/cd <path>` — change working directory
- Auto-rotation at configurable token limit (summarizes context, starts fresh — set via `/setup`)

## Commands

### Main Commands

| Command | Description |
|---------|-------------|
| `/help` | Full command reference |
| `/status` | Mode, model, session, cwd, token progress bar |
| `/setup` | Re-run first-time setup wizard |
| `/stop` | Kill running Claude process |
| `/plan` | Toggle Plan / Build mode |

### Sessions

| Command | Description |
|---------|-------------|
| `/sessions` | Session list with connect/delete buttons |
| `/new [name]` | Start a new session |
| `/name <title>` | Rename current session |
| `/detach` | Disconnect from current session |
| `/cd <path>` | Set working directory (`-` to reset) |

### Display & Output

| Command | Description |
|---------|-------------|
| `/display` | Toggle display mode: `tools` or `thoughts` (inline buttons) |
| `/display tools` | Switch to tools mode directly |
| `/display thoughts` | Switch to thoughts mode directly |
| `/mode` | Output mode: `terminal` / `hybrid` / `telegram` |
| `/model` | Switch model: `sonnet` / `opus` / `haiku` |
| `/botlang` | Bot UI language: `en` / `ru` (auto-detected on first start) |
| `/lang` | Voice recognition language: `ru` / `en` / `auto` |

### Git

| Command | Description |
|---------|-------------|
| `/git` | Git panel — Status, Diff, Log, Stage, Commit (AI message), Push (with confirmation), Pull |
| `/git <args>` | Direct git command, e.g. `/git log --oneline -5` |
| `/undo` | Rollback last commit (soft/hard, with confirmation) |
| `/diff [ref]` | Show git diff with pagination |

### Quick Commands (instant, no Claude)

| Command | Description |
|---------|-------------|
| `/sh <cmd>` | Run shell command |
| `/sys` | CPU, RAM, disk, battery, Wi-Fi, IP, uptime |
| `/clip` | Get clipboard contents |
| `/clip <text>` | Set clipboard |
| `/dl <path>` | Download file to Telegram |
| `/recent` | Recently edited files with one-tap download |
| `/screenshot <url>` | Screenshot via Puppeteer |
| `/cron <Xh/Xm> <text>` | Set a reminder |
| `/cron list` | List active reminders |
| `/cron del <N>` | Delete reminder |

### Mac Remote Control

| Command | Description |
|---------|-------------|
| `/sleep` | Put Mac to sleep |
| `/lock` | Lock screen |
| `/shutdown` | Shut down (confirmation required) |
| `/reboot` | Restart (confirmation required) |

### Group Chat Access Control (owner only)

| Command | Description |
|---------|-------------|
| `/allow <user_id>` | Grant a user access in groups |
| `/revoke <user_id>` | Remove a user's access |
| `/allowed` | List all allowed users |

### MCP: Claude → Telegram

Claude can proactively message you using built-in MCP tools:
- `send_telegram(text)` — send text message
- `send_file_telegram(file_path, caption?)` — send file

## Output Modes

| Mode | Responses | Approvals | Use case |
|------|-----------|-----------|----------|
| `terminal` | Terminal | Terminal | At desk |
| `hybrid` | Terminal | Telegram | Away, approvals on phone |
| `telegram` | Telegram | Telegram | Fully remote |

Switch: `/mode` in Telegram or `node mode.mjs <mode>` in terminal.

## Group Chat Support

Add the bot to any Telegram group. In groups:
- Only the **owner** + users on the **allowed list** can interact with the bot
- Bot only responds when **@mentioned** or when **replying** to its messages
- **Dangerous operations** (git push, rm -rf, DB migrations, etc.) are automatically denied if initiated by a non-owner — the owner gets a DM notification
- Display is always `thoughts` mode (group-friendly)

## Approval System

Dangerous operations require approval via Telegram inline buttons when in hybrid/telegram mode:
- `git push/reset/clean`, `rm -rf`, Docker commands
- DB migrations (`prisma migrate`, `DROP TABLE`)
- Deploys (`vercel --prod`, `npm publish`)
- Sensitive file edits (`.env`, `docker-compose`, `package.json`, CI configs)

## Auto-Sleep

After 30 min of **both** system idle (no keyboard/mouse) **and** no Telegram messages from you, the bot asks whether to put Mac to sleep. If you don't respond — the question is silently dropped, Mac stays on. Triggers only when you've been working via Telegram; ignored if you're active directly at the Mac.

## Notifications

**Telegram sessions** (you write to the bot):
- Typing indicator and live tool/thoughts updates while Claude works
- Final response with token stats when done
- If Claude finishes with no text (tool-only work) — `✅ Готово` notification sent automatically

**Terminal sessions** (you type in the terminal directly):
- `✅ Done` notification with Claude's last response sent to your DM when the session ends (via Stop hook)

## i18n

Bot UI supports **English** and **Russian**. Language is auto-detected from your Telegram profile on first `/start`. Switch anytime with `/botlang`.

## First-time Setup

On first `/start`, a 4-step wizard asks:
1. **OS** — macOS or Linux
2. **Output mode** — terminal / hybrid / telegram
3. **Display mode** — tools or thoughts
4. **Token rotation limit** — when to compress context (50k / 100k / 200k / unlimited)

Re-run anytime with `/setup`.

## Setup

### 1. Prerequisites

- **Node.js** 20+
- **Claude Code CLI** installed and in PATH
- **Telegram Bot** — create via [@BotFather](https://t.me/BotFather)
- **Groq API key** (free): [groq.com](https://groq.com) → API Keys
- Optional: **FFmpeg** (`brew install ffmpeg`) for voice fallback

### 2. Install

```bash
git clone https://github.com/Imolatte/tg-claude.git
cd tg-claude/worker && npm install
```

### 3. Configure

```bash
cp config.example.json config.json
```

Edit `config.json`:
```json
{
  "botToken": "YOUR_BOT_TOKEN",
  "chatId": "YOUR_TELEGRAM_CHAT_ID",
  "groqApiKey": "YOUR_GROQ_API_KEY",
  "timeoutMs": 300000,
  "claudeTimeoutMs": 1800000
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `botToken` | Telegram bot token from @BotFather | required |
| `chatId` | Your Telegram user ID | required |
| `groqApiKey` | Groq API key for voice STT | required |
| `timeoutMs` | Approval request timeout (ms) | 300000 (5 min) |
| `claudeTimeoutMs` | Max time for Claude to run a task (ms) | 1800000 (30 min) |

Get `chatId`: send any message to your bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` — look for `chat.id`.

### 4. Claude Code Hooks

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node /full/path/to/tg-claude/approval-hook.mjs", "timeout": 310 }]
    }],
    "Stop": [{
      "hooks": [{ "type": "command", "command": "node /full/path/to/tg-claude/stop-hook.mjs", "timeout": 10 }]
    }]
  }
}
```

### 5. Start

```bash
cd worker && node index.mjs
```

### 6. Autostart (macOS)

Create `~/Library/LaunchAgents/com.tg-claude.worker.plist` pointing to `node index.mjs` in the worker directory. See `launcher.sh` for reference.

Logs: `/tmp/tg-claude.log`

## Architecture

```
worker/
  index.mjs           Bot core: polling, commands, streaming, task queue
  executor.mjs         Spawns Claude Code CLI, parses stream-json events
  sessions.mjs         State: active session, model, cwd, tokens, display mode
  voice.mjs            Groq STT with local Whisper fallback
  locale.mjs           i18n: EN + RU strings
  mcp-telegram.mjs     MCP server: send_telegram + send_file_telegram

approval-hook.mjs      PreToolUse hook → Telegram approval buttons (group-aware)
stop-hook.mjs          Stop hook → Telegram completion notification
mode.mjs               CLI: switch output mode (terminal/hybrid/telegram)
bot-system-prompt.md   System prompt appended to Claude Code
config.json            Credentials (gitignored)
```

## Security

- **Owner-only** — single `chatId`, all others silently ignored
- **Group access control** — allowlist per user ID
- **Dangerous op blocking** — non-owner group requests denied automatically
- **No credentials in repo** — `config.json` is gitignored
- **Duplicate protection** — kills previous instances on startup
- **Stale session recovery** — auto-retries without `--resume` on failure
