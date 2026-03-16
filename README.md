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

### Streaming Progress
Real-time updates as Claude works:
```
🔧 Read: /src/auth.ts
🔧 Edit: /src/auth.ts
🔧 Bash: npm test
📝 Writing response...
```
Token usage shown after each response: `↓3.2k ↑17k · 4.5s`

### Session Management
- Auto-resume sessions across messages (`--resume`)
- `/sessions` — inline keyboard to switch/delete sessions
- `/new [name]` — new session; `/name <title>` — rename
- `/detach` — disconnect; `/cd <path>` — change working directory
- Auto-rotation at configurable token limit (summarizes context, starts fresh — set via `/setup`)

### Commands

| Command | Description |
|---------|-------------|
| `/help` | Full command reference |
| `/status` | Mode, model, session, cwd, token progress bar |
| `/setup` | Re-run first-time setup wizard |
| `/sessions` | Session list with connect/delete buttons |
| `/new [name]` | New session |
| `/name <title>` | Rename session |
| `/stop` | Kill running Claude process |
| `/cost` | Token usage |
| `/model` | Switch: sonnet / opus / haiku |
| `/mode` | Output mode: terminal / hybrid / telegram |
| `/botlang` | Bot UI language: en / ru (auto-detected on first start) |
| `/lang` | Voice language: ru / en / auto |
| `/cd <path>` | Working directory |
| `/plan` | Toggle Plan / Build mode |
| `/git` | Git panel (status, diff, log, stage, commit, push, pull) |
| `/undo` | Rollback last commit (soft/hard) |
| `/diff` | Git diff with pagination |
| `/recent` | Recently edited files with one-tap download |
| `/screenshot <url>` | Screenshot via Puppeteer |

### Quick Commands (no Claude, instant)

| Command | Description |
|---------|-------------|
| `/sh <cmd>` | Shell command |
| `/sys` | CPU, RAM, disk, battery, Wi-Fi, IP, uptime |
| `/clip` | Get/set clipboard |
| `/dl <path>` | Download file to Telegram |
| `/cron <Xh/Xm> <text>` | Set reminder |

### Mac Remote Control

| Command | Description |
|---------|-------------|
| `/sleep` | Sleep |
| `/lock` | Lock screen |
| `/shutdown` | Shut down (confirmation) |
| `/reboot` | Restart (confirmation) |

### MCP: Claude → Telegram

Claude can proactively message you using built-in MCP tools:
- `send_telegram(text)` — send text message
- `send_file_telegram(file_path, caption?)` — send file

### Git Panel (`/git`)

Inline buttons: Status, Diff, Log, Stage all, Commit (AI message), Push (with confirmation), Pull, Refresh.

### Output Modes

| Mode | Responses | Approvals | Use case |
|------|-----------|-----------|----------|
| `terminal` | Terminal | Terminal | At desk |
| `hybrid` | Terminal | Telegram | Away, approvals on phone |
| `telegram` | Telegram | Telegram | Fully remote |

Switch: `/mode` in Telegram or `node mode.mjs <mode>` in terminal.

### Approval System

Dangerous operations (git push, rm -rf, DB migrations, deploys, sensitive file edits) require approval via Telegram inline buttons when in hybrid/telegram mode.

**Auto-switch to hybrid:** If you're in `terminal` mode and step away, Claude won't block indefinitely. After 5 minutes without a terminal response to an approval prompt, it automatically switches to `hybrid` mode and forwards the request to Telegram. Use `/mode terminal` to switch back when you return.

### Auto-Sleep

After 30 min of inactivity, asks via Telegram whether to put Mac to sleep. No response for 10 min → sleeps automatically.

### i18n

Bot UI supports **English** and **Russian**. Language is auto-detected from your Telegram profile on first `/start`. Switch anytime with `/botlang`.

### First-time Setup

On first `/start`, a setup wizard asks:
1. **Output mode** — terminal / hybrid / telegram
2. **Token rotation limit** — when to compress context (50k / 100k / 200k / unlimited)

Re-run anytime with `/setup`.

### Activity Indicators

When Claude works in terminal mode, the Telegram bot shows a typing indicator and a one-time "⚙️ Working..." notification so you always know something is happening — even if you're away from the keyboard.

### Token Optimization

`--strict-mcp-config` + `--disable-slash-commands` saves ~15K tokens per request vs default Claude Code.

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

### 4. Claude Code Hooks (optional)

For approval/notification forwarding to Telegram, add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node /full/path/to/tg-claude/approval-hook.mjs", "timeout": 310 }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node /full/path/to/tg-claude/notify-hook.mjs" }]
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
  sessions.mjs         State: active session, model, cwd, token tracking
  voice.mjs            Groq STT with local Whisper fallback
  mcp-telegram.mjs     MCP server: send_telegram + send_file_telegram

approval-hook.mjs      PreToolUse hook → Telegram approval buttons
notify-hook.mjs        Stop hook → Telegram completion notification
mode.mjs               CLI: switch output mode (terminal/hybrid/telegram)
bot-system-prompt.md   System prompt appended to Claude Code
config.json            Credentials (gitignored)
```

## Security

- **Owner-only** — single `chatId`, all others silently ignored
- **No credentials in repo** — `config.json` is gitignored
- **Duplicate protection** — kills previous instances on startup
- **Stale session recovery** — auto-retries without `--resume` on failure
