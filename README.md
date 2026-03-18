# TG Claude

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-CLI-blueviolet.svg)](https://claude.ai/claude-code)

Personal Telegram bot that turns your Mac into a remote Claude Code terminal. Send messages from your phone — get full Claude Code CLI responses with tool access (Bash, Read, Write, Edit, Grep, etc.).

**Single-user, owner-only by default.** Designed for developers who want to control their own machine remotely. Group chats are supported with explicit allow-list control.

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

Control what you see while Claude works:

| Mode | What is shown |
|------|---------------|
| `tools` | Tool calls with file/command details: `🔧 Read: /src/auth.ts` |
| `thoughts` | Claude's text output streamed as it reasons through the task |

Switch anytime with `/display` or set during the setup wizard. Groups always use `thoughts` mode.

**Tools mode example:**
```
🔧 Read: /src/auth.ts
🔧 Edit: /src/auth.ts
🔧 Bash: npm test
📝 Writing response...
```

**Thoughts mode:** shows Claude's running text output streamed live into a single updating message.

### Session Management
- Auto-resume sessions across messages (`--resume`)
- `/sessions` — inline keyboard to switch/delete sessions
- `/new [name]` — new session; `/name <title>` — rename
- `/detach` — disconnect; `/cd <path>` — change working directory
- Auto-rotation at configurable token limit (summarizes context, starts fresh — set via `/setup`)

---

## Commands

### Session Commands

| Command | Description |
|---------|-------------|
| `/sessions` | Session list with connect/delete buttons |
| `/new [name]` | Start a new session (optionally named) |
| `/name <title>` | Rename the current session |
| `/detach` | Disconnect from current session |

### Control Commands

| Command | Description |
|---------|-------------|
| `/help` | Full command reference |
| `/status` | Mode, model, session, cwd, token progress bar |
| `/setup` | Re-run first-time setup wizard |
| `/stop` | Kill running Claude process |
| `/model` | Switch: sonnet / opus / haiku (inline buttons) |
| `/mode` | Output mode: terminal / hybrid / telegram |
| `/display` | Display mode: tools / thoughts |
| `/plan` | Toggle Plan / Build mode |
| `/cd <path>` | Working directory (`-` or `reset` to clear) |
| `/botlang` | Bot UI language: en / ru |
| `/lang` | Voice language: ru / en / auto |

### Quick Commands (no Claude, instant)

| Command | Description |
|---------|-------------|
| `/sh <cmd>` | Shell command without Claude |
| `/sys` | CPU, RAM, disk, battery, Wi-Fi, IP, uptime |
| `/clip` | Get clipboard contents |
| `/clip <text>` | Set clipboard |
| `/dl <path>` | Download file from Mac to Telegram |
| `/cron <Xh/Xm> <text>` | Set a reminder |
| `/screenshot <url>` | Screenshot via Puppeteer |

### Git Commands

| Command | Description |
|---------|-------------|
| `/git` | Git panel with inline buttons |
| `/git <args>` | Direct git command: `/git log --oneline -5` |
| `/undo` | Rollback last commit (soft/hard, with confirmation) |
| `/diff [ref]` | Paginated git diff |
| `/recent` | Recently edited files with one-tap download |

### Mac Remote Control

| Command | Description |
|---------|-------------|
| `/sleep` | Put Mac to sleep |
| `/lock` | Lock screen |
| `/shutdown` | Shut down (with confirmation) |
| `/reboot` | Restart (with confirmation) |

### Group User Management (owner only)

| Command | Description |
|---------|-------------|
| `/allow <user_id>` | Allow a user to send requests in groups |
| `/revoke <user_id>` | Remove a user from the allow list |
| `/allowed` | List all allowed users |

---

## Display Modes

### Tools Mode (default)

Shows which files and commands Claude is using:

```
🔧 Read: /Users/you/project/src/api.ts
🔧 Bash: npm run test -- --watch=false
🔧 Edit: /Users/you/project/src/api.ts
📝 Writing response...
```

Best when you want to see exactly what Claude is doing on your filesystem.

### Thoughts Mode

Streams Claude's text output as it arrives, before the final answer. Useful when:
- You want to follow Claude's reasoning in real time
- The task produces no file/tool activity worth showing
- You're in a group chat (groups always use thoughts mode)

Switch: `/display` → inline buttons, or `/display tools` / `/display thoughts`.

---

## Output Modes

Controls where responses and approvals go:

| Mode | Responses | Approvals | Use case |
|------|-----------|-----------|----------|
| `terminal` | Terminal | Terminal | At desk |
| `hybrid` | Terminal | Telegram | Away, approvals on phone |
| `telegram` | Telegram | Telegram | Fully remote |

Switch: `/mode` in Telegram, or `node mode.mjs <mode>` in terminal.

---

## Group Chat Setup

The bot works in Telegram groups with explicit user authorization.

### Adding the bot to a group

1. Add the bot to your group
2. The bot only responds when **mentioned** (`@botname`) or when someone **replies to the bot's message**
3. Only the **owner** and **allowed users** can trigger Claude

### Authorizing group members

From your DM with the bot (owner only):

```
/allow 123456789      # Allow a user by their Telegram ID
/revoke 123456789     # Remove access
/allowed              # List all allowed users
```

To find a user's ID: ask them to send you their ID via a bot like [@userinfobot](https://t.me/userinfobot).

### Group behavior

- Groups always use **thoughts** display mode (tool details are suppressed)
- **Dangerous operations** (git push, rm -rf, DB migrations, etc.) from group users are **automatically blocked** and the owner receives a DM notification
- The owner can still approve dangerous ops normally via the approval flow

---

## Approval Flow

Dangerous operations require approval when in `hybrid` or `telegram` output mode.

**What triggers approval:**
- `git push`, `git reset`, `git rebase`, `git merge`, `git checkout --`
- `git clean`, `git branch -D`
- `rm -rf`, `rm -r`
- `docker rm`, `docker stop`, `docker system prune`
- Prisma migrations and DB pushes
- `vercel --prod`, `npm publish`
- Edits to `.env`, `Dockerfile`, `docker-compose`, `.github/`, `prisma/migrations`, `package.json`, config files

**Flow in hybrid/telegram mode:**

1. Claude tries to run the dangerous operation
2. Bot sends an inline keyboard to Telegram: `✅ Yes` / `❌ No`
3. You tap — decision is immediately returned to Claude
4. If no response within 5 min: operation is denied automatically

**Group user attempting a dangerous op:**

- Operation is blocked immediately (no approval prompt)
- Owner receives a DM: `⚠️ Dangerous op blocked — User <id> tried to run...`

---

## Setup Wizard

Run `/setup` at any time. Steps:

1. **OS** — macOS or Linux (enables Mac-specific commands)
2. **Output mode** — terminal / hybrid / telegram
3. **Display mode** — tools / thoughts
4. **Token rotation limit** — 50k / 100k / 200k / 300k / unlimited

On first `/start`, the wizard runs automatically.

---

## Architecture

```
worker/
  index.mjs           Bot core: polling, commands, streaming, task queue
  executor.mjs         Spawns Claude Code CLI, parses stream-json events
  sessions.mjs         State: active session, model, cwd, display mode, token tracking
  locale.mjs           i18n strings (en + ru)
  voice.mjs            Groq STT with local Whisper fallback
  mcp-telegram.mjs     MCP server: send_telegram + send_file_telegram

approval-hook.mjs      PreToolUse hook → Telegram approval buttons + group blocking
notify-hook.mjs        Stop hook → Telegram completion notification
mode.mjs               CLI: switch output mode (terminal/hybrid/telegram)
bot-system-prompt.md   System prompt appended to Claude Code
config.json            Credentials (gitignored)
```

### Request flow

```
Telegram message
  → handleMessage (auth check, requestMeta built)
  → enqueue(chatId, prompt, meta)
  → sendToClaude(chatId, prompt, meta)
      → writes /tmp/claude-request-meta.json (for approval-hook)
      → determines displayMode (group → thoughts, DM → from state)
      → runClaude(prompt, onEvent)
          → Claude Code CLI subprocess
          → approval-hook.mjs (PreToolUse) reads meta, blocks group danger ops
      → streams progress (tools or thoughts mode)
      → sends final response
```

### State

All persistent state in `worker/state.json`:
- `activeSessionId`, `activeProjectDir`, `activeCwd`
- `model` (sonnet/opus/haiku)
- `displayMode` (tools/thoughts)
- `allowedUsers` (array of Telegram user IDs)
- `tokens`, `scopeTokens`
- `tokenRotationLimit`
- `os` (mac/linux)
- `lang` (en/ru)
- `setupDone`

---

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

---

## MCP: Claude → Telegram

Claude can proactively message you using built-in MCP tools:
- `send_telegram(text)` — send text message
- `send_file_telegram(file_path, caption?)` — send file

---

## Security

- **Owner-only DMs** — only your `chatId` can use the bot in direct messages
- **Group allow-list** — explicit opt-in per user via `/allow`
- **Dangerous op blocking** — group users cannot trigger dangerous operations; owner is notified
- **No credentials in repo** — `config.json` is gitignored
- **Duplicate protection** — kills previous instances on startup
- **Stale session recovery** — auto-retries without `--resume` on failure

---

## Auto-Sleep

After 30 min of inactivity, asks via Telegram whether to put Mac to sleep. No response for 10 min → sleeps automatically. `/sleep` command also available directly.

## Token Optimization

`--strict-mcp-config` + `--disable-slash-commands` saves ~15K tokens per request vs default Claude Code.

## i18n

Bot UI supports **English** and **Russian**. Language auto-detected from your Telegram profile on first `/start`. Switch anytime with `/botlang`.
