#!/usr/bin/env node

/**
 * Telegram → Claude bridge (direct, no Cloudflare)
 * Owner-only remote terminal with session management, voice, quick actions
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { execSync, execFile, execFileSync } from "child_process";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { createServer } from "net";

// Single-instance lock via TCP port — only one process can hold it
const LOCK_PORT = 47291;
const lockServer = createServer();
await new Promise((resolve, reject) => {
  lockServer.listen(LOCK_PORT, "127.0.0.1", resolve);
  lockServer.on("error", () => {
    console.error(`[lock] Another instance is already running on port ${LOCK_PORT}. Exiting.`);
    process.exit(0);
  });
});

const HOME = homedir();
import { runClaude, killActiveChild } from "./executor.mjs";
import { transcribeVoice, getVoiceLang, setVoiceLang } from "./voice.mjs";
import {
  listSessions, setActiveSession, clearActiveSession, getActiveSession,
  renameSession, getSessionName, deleteSession, getModel, setModel,
  getCustomCwd, setCustomCwd,
  addTokens, getTokens, resetTokens, getScopeTokens, resetScopeTokens,
  getWorkingDir,
  getTokenRotationLimit, setTokenRotationLimit, isSetupDone, markSetupDone,
  getOs, setOs,
  getAllowedUsers, addAllowedUser, removeAllowedUser,

} from "./sessions.mjs";
import { t, getLang, setLang, loadLang, availableLangs } from "./locale.mjs";

loadLang();

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "..", "config.json"), "utf-8"));
const BOT_TOKEN = config.botToken;
const OWNER_CHAT_ID = config.chatId;
const POLL_TIMEOUT = 30;
// Token rotation limit is stored in state.json (configurable via setup wizard)

const PID_FILE = "/tmp/claude-tg-worker.pid";
const MODE_FILE = "/tmp/claude-output-channel";
const VALID_MODES = { terminal: "Terminal", hybrid: "Hybrid (approval → TG)", telegram: "Telegram" };
let offset = 0;
let running = true;
let botUsername = null; // filled on init

function getOutputMode() {
  try { return readFileSync(MODE_FILE, "utf-8").trim(); }
  catch { return "terminal"; }
}
function setOutputMode(mode) {
  writeFileSync(MODE_FILE, mode);
}

// ── Task queue ──────────────────────────────────────────────────────

let pendingSessionName = null;
let planMode = false; // false = build (default), true = plan only
const pendingGroupNaming = new Map(); // chatId → { prompt, meta } — waiting for session name in group
const pendingNewNaming = new Set(); // chatId — waiting for session name after "New session" button
const cronJobs = []; // [{label, fireAt, timer}]
const pendingDMText = {}; // chatId → { prompt, timer } — buffer text to combine with following forward
const pendingPhotos = {}; // chatId → { paths: [], caption, timer, meta } — buffer photos arriving together

// Per-chat queues: each chat has independent busy flag + queue
const chatQueues = new Map(); // chatId → { busy: bool, queue: [{prompt, meta}] }

// Pending rotation decisions: waiting for user to confirm new session or compress
const pendingRotations = new Map(); // chatId → { oldSessionId, oldProjectDir, sessionKey, summary }

// Recent files: track last 10 files modified via Write/Edit
const recentFiles = []; // [{path, tool, ts}]
function trackRecentFile(path, tool) {
  const idx = recentFiles.findIndex(f => f.path === path);
  if (idx >= 0) recentFiles.splice(idx, 1);
  recentFiles.unshift({ path, tool, ts: Date.now() });
  if (recentFiles.length > 10) recentFiles.pop();
}

// Diff pagination state
const diffPages = {}; // chatId → { pages: string[], idx: number }

async function sendDiffPage(chatId) {
  const state = diffPages[chatId];
  if (!state) return;
  const { pages, idx } = state;
  const total = pages.length;
  const nav = total > 1 ? [
    { text: "⬅️ Prev", callback_data: "diff:prev" },
    { text: `${idx + 1}/${total}`, callback_data: "diff:noop" },
    { text: "➡️ Next", callback_data: "diff:next" },
  ] : [];
  await tg("sendMessage", {
    chat_id: chatId,
    text: `\`\`\`diff\n${pages[idx]}\n\`\`\``,
    parse_mode: "Markdown",
    reply_markup: total > 1 ? { inline_keyboard: [nav] } : undefined,
  });
}

function getChatQueue(chatId) {
  if (!chatQueues.has(chatId)) chatQueues.set(chatId, { busy: false, queue: [] });
  return chatQueues.get(chatId);
}

async function enqueue(chatId, prompt, meta = {}) {
  const state = getChatQueue(chatId);
  if (!state.busy) {
    state.busy = true;
    try {
      await sendToClaude(chatId, prompt, meta);
    } catch (err) {
      console.error(`❌ sendToClaude error [${chatId}]:`, err.message, err.stack);
      tg("sendMessage", { chat_id: chatId, text: t("error.generic", { msg: err.message }) }).catch(() => {});
    } finally {
      state.busy = false;
      processQueue(chatId);
    }
    return;
  }

  // Already busy — queue silently (no notification spam)
  state.queue.push({ prompt, meta });
}

async function processQueue(chatId) {
  const state = getChatQueue(chatId);
  if (state.busy || state.queue.length === 0) return;
  const { prompt, meta = {} } = state.queue.shift();
  state.busy = true;
  try {
    await sendToClaude(chatId, prompt, meta);
  } finally {
    state.busy = false;
    processQueue(chatId);
  }
}

// ── Telegram helpers ────────────────────────────────────────────────

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function splitMessage(text, limit = 4000) {
  const chunks = [];
  let rest = text;

  while (rest.length > 0) {
    if (rest.length <= limit) {
      chunks.push(rest);
      break;
    }

    // Find best split point: last newline before limit
    let splitAt = rest.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.5) splitAt = limit;

    let chunk = rest.slice(0, splitAt);

    // Track unclosed <pre> tags — close at chunk boundary, reopen in next
    const preOpens = (chunk.match(/<pre>/gi) || []).length;
    const preCloses = (chunk.match(/<\/pre>/gi) || []).length;
    const unclosedPre = preOpens > preCloses;

    if (unclosedPre) {
      chunk = chunk + "</code></pre>";
    }

    chunks.push(chunk);
    rest = rest.slice(splitAt).replace(/^\n/, "");
    if (unclosedPre && rest.length > 0) {
      rest = "<pre><code>" + rest;
    }
  }

  return chunks;
}

function stripSystemTags(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

// Fix bare & that would break Telegram HTML parser (skip already-escaped ones)
function fixAmpersands(text) {
  return text.replace(/&(?!(?:amp|lt|gt|quot|apos);)/g, "&amp;");
}

/**
 * Convert Markdown to Telegram HTML.
 * Handles: fenced code blocks, inline code, bold, italic, strikethrough, headers, blockquotes, links.
 * Leaves already-valid HTML tags untouched.
 */
function mdToTgHtml(text) {
  // Protect existing HTML tags from escaping
  const htmlPlaceholders = [];
  let s = text.replace(/<(\/?)(?:b|i|u|s|code|pre|a|blockquote)(?: [^>]*)?>|<br\s*\/?>|&(?:amp|lt|gt|quot|apos);/gi, (m) => {
    htmlPlaceholders.push(m);
    return `\x00HTML${htmlPlaceholders.length - 1}\x00`;
  });

  // Escape HTML special chars in remaining text
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Fenced code blocks: ```lang\ncode\n```
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const cls = lang ? ` class="language-${lang}"` : "";
    return `<pre><code${cls}>${code.replace(/\x00HTML(\d+)\x00/g, (__, i) => esc(htmlPlaceholders[+i]))}</code></pre>`;
  });

  // Inline code: `code`
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // Bold: **text** or __text__
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic: *text* or _text_ (but not inside words with underscores)
  s = s.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<i>$1</i>");
  s = s.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~
  s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Headers: # Header → bold
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Blockquotes: > text (consecutive lines merged)
  s = s.replace(/^(?:&gt;|>) (.+)$/gm, "<blockquote>$1</blockquote>");
  // Merge adjacent blockquotes
  s = s.replace(/<\/blockquote>\n<blockquote>/g, "\n");

  // Links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore protected HTML
  s = s.replace(/\x00HTML(\d+)\x00/g, (_, i) => htmlPlaceholders[+i]);

  return s;
}

async function sendMsg(chatId, text) {
  const chunks = splitMessage(mdToTgHtml(stripSystemTags(text)));
  let sent = 0;
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const res = await tg("sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: "HTML",
    });
    if (!res.ok) {
      // Strip HTML tags for fallback so they don't show as raw text
      const plain = chunk.replace(/<[^>]*>/g, "");
      await tg("sendMessage", { chat_id: chatId, text: plain });
    }
    sent++;
  }
  return sent;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatK(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function tokenProgressBar(used, limit) {
  const pct = Math.min(used / limit, 1);
  const filled = Math.round(pct * 8);
  return `${"█".repeat(filled)}${"░".repeat(8 - filled)} ${formatK(used)}/${formatK(limit)}`;
}


// ── File download from Telegram ─────────────────────────────────────

const TMP_DIR = join(dirname(fileURLToPath(import.meta.url)), "tmp");
mkdirSync(TMP_DIR, { recursive: true });

async function downloadTgFile(fileId, ext) {
  const res = await tg("getFile", { file_id: fileId });
  if (!res.ok) return null;
  const filePath = res.result.file_path;
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const fileRes = await fetch(url);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  const localExt = ext || extname(filePath) || ".bin";
  const localPath = join(TMP_DIR, `${fileId}${localExt}`);
  writeFileSync(localPath, buffer);
  return localPath;
}

// ── Commands ────────────────────────────────────────────────────────

const PAGE_SIZE = 7;

function buildSessionList(chatId = "default", page = 0) {
  const { items: sessions, total } = listSessions(PAGE_SIZE, page * PAGE_SIZE);
  const { activeSessionId } = getActiveSession(chatId);

  if (total === 0) return { text: t("sessions.empty"), buttons: [] };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  let text = t("sessions.title");
  if (totalPages > 1) text += `<i>Страница ${page + 1}/${totalPages}</i>\n`;
  const buttons = [];

  for (const s of sessions) {
    const isActive = s.sessionId === activeSessionId;
    const marker = isActive ? "▶️ " : "  ";
    const ago = formatAgo(s.modifiedAt);
    const name = s.displayName || s.lastMessage.slice(0, 40);
    const proj = s.projectName.split("/").pop();
    text += `${marker}<b>${esc(name)}</b>  <i>${proj} · ${ago}</i>\n`;

    const shortId = s.sessionId.slice(0, 8);
    const btnLabel = s.displayName || s.lastMessage.slice(0, 25);
    buttons.push([
      { text: `${isActive ? "▶️ " : ""}${btnLabel}`, callback_data: `ses:${shortId}` },
      { text: "🗑", callback_data: `del:${shortId}` },
    ]);
  }

  const nav = [];
  if (page > 0) nav.push({ text: "← Назад", callback_data: `ses:pg:${page - 1}` });
  if ((page + 1) < totalPages) nav.push({ text: "Вперёд →", callback_data: `ses:pg:${page + 1}` });
  if (nav.length > 0) buttons.push(nav);

  buttons.push([{ text: t("sessions.new_btn"), callback_data: "ses:new" }]);
  if (activeSessionId) {
    buttons.push([{ text: t("sessions.detach_btn"), callback_data: "ses:detach" }]);
  }

  return { text, buttons };
}

async function showSessions(chatId) {
  const { text, buttons } = buildSessionList(chatId);
  await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(buttons.length && { reply_markup: { inline_keyboard: buttons } }),
  });
}

async function editSessionList(chatId, messageId) {
  const { text, buttons } = buildSessionList(chatId);
  await tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    ...(buttons.length && { reply_markup: { inline_keyboard: buttons } }),
  });
}

function formatAgo(date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("time.now");
  if (mins < 60) return t("time.min", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("time.hour", { n: hours });
  const days = Math.floor(hours / 24);
  return t("time.day", { n: days });
}

async function sendSetupStep0(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: t("setup.os_prompt"),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: t("setup.os_mac"), callback_data: "setup:os:mac" }],
        [{ text: t("setup.os_linux"), callback_data: "setup:os:linux" }],
      ],
    },
  });
}

async function sendSetupStep1(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: t("setup.mode_prompt"),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: t("setup.mode_terminal"), callback_data: "setup:mode:terminal" }],
        [{ text: t("setup.mode_hybrid"), callback_data: "setup:mode:hybrid" }],
        [{ text: t("setup.mode_telegram"), callback_data: "setup:mode:telegram" }],
      ],
    },
  });
}


async function sendSetupStep3(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: t("setup.tokens_prompt"),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "50k", callback_data: "setup:tokens:50000" },
          { text: "100k", callback_data: "setup:tokens:100000" },
          { text: "200k", callback_data: "setup:tokens:200000" },
          { text: "300k", callback_data: "setup:tokens:300000" },
        ],
        [{ text: t("setup.tokens_unlimited"), callback_data: "setup:tokens:0" }],
      ],
    },
  });
}

async function showWelcome(chatId, userLangCode) {
  // Auto-detect language on first run (if not set in state.json)
  let langAlreadySet = false;
  try {
    const s = JSON.parse(readFileSync(join(__dirname, "state.json"), "utf-8"));
    langAlreadySet = !!s.lang;
  } catch {}

  let detectedLang = null;
  if (!langAlreadySet && userLangCode) {
    const code = userLangCode.split("-")[0].toLowerCase();
    if (availableLangs().includes(code)) {
      setLang(code);
      detectedLang = code;
    }
  }

  const parts = [
    t("welcome.title"),
    ``,
    t("welcome.subtitle"),
    ``,
    t("welcome.sessions"),
    t("welcome.control"),
    t("welcome.quick"),
    ``,
    t("welcome.attachments"),
    ``,
    t("welcome.modes"),
    ``,
    t("welcome.tip"),
  ];
  if (detectedLang) parts.push(``, t("welcome.lang_set", { lang: detectedLang }));

  await tg("sendMessage", {
    chat_id: chatId,
    text: parts.join("\n"),
    parse_mode: "HTML",
  });

  // Run setup wizard on first launch
  if (!isSetupDone()) {
    await sendSetupStep0(chatId);
  }
}

async function showHelp(chatId) {
  const { activeSessionId } = getActiveSession(chatId);
  const { items: sessions } = listSessions(10);
  const current = sessions.find((s) => s.sessionId === activeSessionId);

  let status;
  if (current) {
    const title = current.displayName || current.projectName;
    status = `▶️ <b>${esc(title)}</b>\n<code>${esc(current.lastMessage)}</code>`;
  } else {
    status = t("sessions.new_status");
  }

  const model = getModel();
  const cwd = getCustomCwd() || t("help.auto");
  const mode = getOutputMode();

  await tg("sendMessage", {
    chat_id: chatId,
    text:
      t("help.header") +
      `${status}\n` +
      `📡 ${VALID_MODES[mode] || mode} · 🧠 ${model} · 📂 <code>${esc(cwd)}</code>\n\n` +
      t("help.sessions") +
      t("help.control") +
      t("help.quick") +
      (getOs() === "mac" ? t("help.mac") : "") +
      t("help.footer"),
    parse_mode: "HTML",
      });
}

// ── Git helpers ─────────────────────────────────────────────────────

function getGitCwd(chatId = "default") {
  const state = getActiveSession(chatId);
  return getCustomCwd() || state.activeCwd || `${HOME}/develop`;
}

function gitExec(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", timeout: 15000, maxBuffer: 50 * 1024 }).trim();
  } catch (err) {
    return err.stderr?.trim() || err.message;
  }
}

// Safe version — args passed as array, no shell interpolation
function gitExecSafe(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 15000, maxBuffer: 50 * 1024 }).trim();
  } catch (err) {
    return err.stderr?.trim() || err.message;
  }
}

function isGitRepo(cwd) {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, encoding: "utf-8", timeout: 5000 });
    return true;
  } catch { return false; }
}

async function showGitPanel(chatId) {
  const cwd = getGitCwd();
  if (!isGitRepo(cwd)) {
    await tg("sendMessage", { chat_id: chatId, text: t("error.not_git", { cwd: esc(cwd) }), parse_mode: "HTML" });
    return;
  }

  const branch = gitExec("git branch --show-current", cwd) || "detached";
  const status = gitExec("git status --short", cwd);
  const ahead = gitExec("git rev-list --count @{u}..HEAD 2>/dev/null || echo 0", cwd);
  const behind = gitExec("git rev-list --count HEAD..@{u} 2>/dev/null || echo 0", cwd);

  let text = `🔀 <b>Git: ${esc(branch)}</b>  <code>${esc(cwd.split("/").slice(-2).join("/"))}</code>\n`;

  if (ahead !== "0" || behind !== "0") {
    text += `↑${ahead} ↓${behind}\n`;
  }

  if (status) {
    const lines = status.split("\n");
    const shown = lines.slice(0, 15).map((l) => `<code>${esc(l)}</code>`).join("\n");
    text += `\n${shown}`;
    if (lines.length > 15) text += `\n` + t("git.more_files", { n: lines.length - 15 });
  } else {
    text += "\n" + t("git.clean");
  }

  const buttons = [
    [
      { text: "📋 Status", callback_data: "git:status" },
      { text: "📝 Diff", callback_data: "git:diff" },
      { text: "📜 Log", callback_data: "git:log" },
    ],
    [
      { text: "📦 Stage all", callback_data: "git:stage" },
      { text: "💾 Commit", callback_data: "git:commit" },
      { text: "🚀 Push", callback_data: "git:push" },
    ],
    [
      { text: "⬇️ Pull", callback_data: "git:pull" },
      { text: "🔄 Refresh", callback_data: "git:refresh" },
    ],
  ];

  await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });
}

// Owner-only bot — always "default" scope

// ── Callback buttons ────────────────────────────────────────────────

async function handleCallback(cb) {
  if (String(cb.from.id) !== OWNER_CHAT_ID) return;

  const data = cb.data;
  const chatId = String(cb.message?.chat?.id || OWNER_CHAT_ID);

  if (data === "ses:new") {
    clearActiveSession(chatId);
    resetTokens();
    pendingNewNaming.add(chatId);
    await tg("answerCallbackQuery", { callback_query_id: cb.id });
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: t("sessions.new_created"),
      parse_mode: "HTML",
    });
    await tg("sendMessage", { chat_id: chatId, text: t("sessions.ask_name"), parse_mode: "HTML" });
    return;
  }

  if (data.startsWith("ses:pg:")) {
    const page = parseInt(data.split(":")[2]) || 0;
    const { text, buttons } = buildSessionList(chatId, page);
    await tg("answerCallbackQuery", { callback_query_id: cb.id });
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    });
    return;
  }

  if (data === "ses:detach") {
    clearActiveSession(chatId);
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: t("sessions.detach_btn") });
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: t("sessions.detached"),
    });
    return;
  }

  if (data.startsWith("del:")) {
    const shortId = data.split(":")[1];
    const { items: sessions } = listSessions(10);
    const match = sessions.find((s) => s.sessionId.startsWith(shortId));
    if (match) {
      deleteSession(match.sessionId, match.projectDir);
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: t("sessions.deleted") });
      // Refresh session list in-place
      await editSessionList(chatId, cb.message.message_id);
    }
    return;
  }


  // ── Mode selection ──
  if (data.startsWith("mode:")) {
    const mode = data.split(":")[1];
    setOutputMode(mode);
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `✅ ${VALID_MODES[mode]}` });
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: t("cmd.mode_set", { mode: esc(VALID_MODES[mode]) }),
      parse_mode: "HTML",
    });
    return;
  }

  // ── Model selection ──
  if (data.startsWith("model:")) {
    const model = data.split(":")[1];
    setModel(model);
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `✅ ${model}` });
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: t("cmd.model_set", { model: esc(model) }),
      parse_mode: "HTML",
    });
    return;
  }

  // ── Voice language selection ──
  if (data.startsWith("lang:")) {
    const lang = data.split(":")[1];
    setVoiceLang(lang);
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `✅ ${lang}` });
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: t("cmd.lang_set", { lang: esc(lang) }),
      parse_mode: "HTML",
    });
    return;
  }

  // ── Bot language selection ──
  if (data.startsWith("botlang:")) {
    const lang = data.split(":")[1];
    setLang(lang);
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `✅ ${lang}` });
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: t("cmd.botlang_set", { lang: esc(lang) }),
      parse_mode: "HTML",
    });
    return;
  }

  // ── Setup wizard ──
  if (data.startsWith("setup:")) {
    const [, step, value] = data.split(":");
    if (step === "os") {
      setOs(value);
      const label = value === "mac" ? t("setup.os_mac") : t("setup.os_linux");
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `✅ ${label}` });
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: cb.message.message_id,
        text: `✅ ${label}`,
        parse_mode: "HTML",
      });
      await sendSetupStep1(chatId);
      return;
    }
    if (step === "mode") {
      setOutputMode(value);
      const label = VALID_MODES[value] || value;
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `✅ ${label}` });
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: cb.message.message_id,
        text: t("cmd.mode_set", { mode: esc(label) }),
        parse_mode: "HTML",
      });
      markSetupDone();
      await tg("sendMessage", {
        chat_id: chatId,
        text: t("setup.done"),
        parse_mode: "HTML",
      });
      return;
    }
  }

  // ── Operation approval (from approval-hook.mjs) ──
  if (data.startsWith("op:")) {
    const parts = data.split(":");
    const opId = parts[1];
    const decision = parts[2]; // "allow" or "deny"

    // Write result file for the approval hook to pick up
    const resultFile = join("/tmp", `claude-approval-${opId}.result`);
    writeFileSync(resultFile, JSON.stringify({ decision }));

    const emoji = decision === "allow" ? "✅" : "❌";
    const status = decision === "allow" ? t("approval.approved") : t("approval.denied");

    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `${emoji} ${status}` });

    // Update the original message to show decision
    const origText = cb.message?.text || "";
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: `${origText}\n\n${emoji} <b>${status}</b>`,
      parse_mode: "HTML",
    });
    return;
  }

  // ── Auto-sleep prompt ──
  if (data.startsWith("sleep:")) {
    const op = data.split(":")[1];
    sleepPromptSentAt = null;
    if (op === "yes") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: t("sleep.goodnight") });
      await tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: t("sleep.going") });
      setTimeout(doSleep, 1500);
    } else {
      lastTelegramActivityAt = Date.now(); // reset idle timer so we don't ask again for another 30 min
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: t("sleep.continue") });
      await tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: t("sleep.continuing") });
    }
    return;
  }

  // ── Mac control ──
  if (data.startsWith("mac:")) {
    const op = data.split(":")[1];
    if (op === "cancel") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "❌" });
      await tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: t("mac.cancelled") });
      return;
    }
    if (op === "shutdown") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "⏻" });
      await tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: t("mac.shutting_down") });
      execSync("sudo shutdown -h now 2>/dev/null; osascript -e 'tell app \"System Events\" to shut down'");
      return;
    }
    if (op === "reboot") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "🔄" });
      await tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: t("mac.rebooting") });
      execSync("sudo shutdown -r now 2>/dev/null; osascript -e 'tell app \"System Events\" to restart'");
      return;
    }
    return;
  }

  // ── Undo operations ──
  if (data.startsWith("undo:")) {
    const op = data.split(":")[1];
    const cwd = getGitCwd();

    if (op === "cancel") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "❌" });
      await tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: t("git.undo_cancelled") });
      return;
    }

    if (op === "soft") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "⏪ Soft reset..." });
      const out = gitExec("git reset --soft HEAD~1", cwd);
      const status = gitExec("git status --short", cwd);
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: cb.message.message_id,
        text: t("git.undo_soft", { status: esc(status.slice(0, 2000)) }),
        parse_mode: "HTML",
      });
      return;
    }

    if (op === "hard") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "💥 Hard reset..." });
      const out = gitExec("git reset --hard HEAD~1", cwd);
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: cb.message.message_id,
        text: t("git.undo_hard", { out: esc(out.slice(0, 2000)) }),
        parse_mode: "HTML",
      });
      return;
    }

    return;
  }

  // ── Plan/Build mode ──
  if (data.startsWith("planmode:")) {
    const mode = data.split(":")[1];
    planMode = mode === "plan";
    const emoji = planMode ? "📐" : "🔨";
    const label = planMode ? "Plan" : "Build";
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `${emoji} ${label}` });
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: t("cmd.plan_mode", { emoji, label }),
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: `${planMode ? "▶️ " : ""}📐 Plan`, callback_data: "planmode:plan" },
          { text: `${!planMode ? "▶️ " : ""}🔨 Build`, callback_data: "planmode:build" },
        ]],
      },
    });
    return;
  }

  // ── Git operations ──
  if (data.startsWith("git:")) {
    const op = data.split(":")[1];
    const cwd = getGitCwd();

    if (!isGitRepo(cwd)) {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "❌" });
      return;
    }

    if (op === "refresh") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "🔄" });
      // Re-render the git panel in place
      const branch = gitExec("git branch --show-current", cwd) || "detached";
      const status = gitExec("git status --short", cwd);
      const ahead = gitExec("git rev-list --count @{u}..HEAD 2>/dev/null || echo 0", cwd);
      const behind = gitExec("git rev-list --count HEAD..@{u} 2>/dev/null || echo 0", cwd);

      let text = `🔀 <b>Git: ${esc(branch)}</b>  <code>${esc(cwd.split("/").slice(-2).join("/"))}</code>\n`;
      if (ahead !== "0" || behind !== "0") text += `↑${ahead} ↓${behind}\n`;
      if (status) {
        const lines = status.split("\n");
        const shown = lines.slice(0, 15).map((l) => `<code>${esc(l)}</code>`).join("\n");
        text += `\n${shown}`;
        if (lines.length > 15) text += `\n` + t("git.more_files", { n: lines.length - 15 });
      } else {
        text += "\n" + t("git.clean");
      }

      const buttons = [
        [
          { text: "📋 Status", callback_data: "git:status" },
          { text: "📝 Diff", callback_data: "git:diff" },
          { text: "📜 Log", callback_data: "git:log" },
        ],
        [
          { text: "📦 Stage all", callback_data: "git:stage" },
          { text: "💾 Commit", callback_data: "git:commit" },
          { text: "🚀 Push", callback_data: "git:push" },
        ],
        [
          { text: "⬇️ Pull", callback_data: "git:pull" },
          { text: "🔄 Refresh", callback_data: "git:refresh" },
        ],
      ];

      await tg("editMessageText", {
        chat_id: chatId,
        message_id: cb.message.message_id,
        text,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons },
      });
      return;
    }

    if (op === "status") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "📋" });
      const out = gitExec("git status", cwd);
      await sendMsg(chatId, `\`\`\`\n${out.slice(0, 3800)}\n\`\`\``);
      return;
    }

    if (op === "diff") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "📝" });
      const staged = gitExec("git diff --cached --stat", cwd);
      const unstaged = gitExec("git diff --stat", cwd);
      const diffText = gitExec("git diff --cached -p 2>/dev/null; git diff -p 2>/dev/null", cwd);
      let text = "";
      if (staged) text += `*Staged:*\n\`\`\`\n${staged}\n\`\`\`\n`;
      if (unstaged) text += `*Unstaged:*\n\`\`\`\n${unstaged}\n\`\`\`\n`;
      if (!staged && !unstaged) text = t("git.no_changes");
      else if (diffText) text += `\n\`\`\`diff\n${diffText.slice(0, 3500)}\n\`\`\``;
      await sendMsg(chatId, text);
      return;
    }

    if (op === "log") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "📜" });
      const out = gitExec('git log --oneline -15 --decorate', cwd);
      await sendMsg(chatId, `\`\`\`\n${out.slice(0, 3800)}\n\`\`\``);
      return;
    }

    if (op === "stage") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "📦 Staged" });
      gitExec("git add -A", cwd);
      await tg("sendMessage", { chat_id: chatId, text: t("git.staged_all") });
      return;
    }

    if (op === "commit") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "💾" });
      const staged = gitExec("git diff --cached --stat", cwd);
      if (!staged) {
        await tg("sendMessage", { chat_id: chatId, text: t("error.no_staging") });
        return;
      }
      // Ask Claude to generate a commit message
      await tg("sendMessage", { chat_id: chatId, text: t("status.generating_commit") });
      const diff = gitExec("git diff --cached", cwd);
      const commitPrompt = `Look at this staged git diff and write a single concise commit message (1-2 lines). Reply ONLY with the commit message, nothing else.\n\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\``;
      await enqueue(chatId, commitPrompt);
      return;
    }

    if (op === "push") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "🚀" });
      // Show confirmation
      await tg("sendMessage", {
        chat_id: chatId,
        text: t("git.push_confirm"),
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Push", callback_data: "git:push-confirm" },
            { text: t("approval.cancel_btn"), callback_data: "git:push-cancel" },
          ]],
        },
      });
      return;
    }

    if (op === "push-confirm") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "🚀 Pushing..." });
      const out = gitExec("git push 2>&1", cwd);
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: cb.message.message_id,
        text: t("git.push_result", { out: esc(out.slice(0, 3800)) }),
        parse_mode: "HTML",
      });
      return;
    }

    if (op === "push-cancel") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "❌" });
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: cb.message.message_id,
        text: t("git.push_cancelled"),
      });
      return;
    }

    if (op === "pull") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "⬇️ Pulling..." });
      const out = gitExec("git pull 2>&1", cwd);
      await tg("sendMessage", {
        chat_id: chatId,
        text: t("git.pull_result", { out: esc(out.slice(0, 3800)) }),
        parse_mode: "HTML",
      });
      return;
    }

    return;
  }

  if (data.startsWith("ses:")) {
    const shortId = data.split(":")[1];
    const { items: sessions } = listSessions(10);
    const match = sessions.find((s) => s.sessionId.startsWith(shortId));

    if (match) {
      const matchCwd = getWorkingDir(match.projectDir);
      setActiveSession(match.sessionId, match.projectDir, matchCwd, chatId);
      const title = match.displayName || match.projectName;
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `▶️ ${title}` });
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: cb.message.message_id,
        text: t("sessions.attached", { title: esc(title), msg: esc(match.lastMessage) }),
        parse_mode: "HTML",
      });
    } else {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: t("sessions.not_found") });
    }
    return;
  }

  // /recent file download button — owner only, path must be under HOME
  if (data.startsWith("dl:")) {
    if (String(cb.from?.id) !== OWNER_CHAT_ID) {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "⛔️" });
      return;
    }
    const filePath = data.slice(3);
    // Prevent path traversal — only allow files under HOME
    const resolvedPath = join("/", filePath); // normalize
    if (!resolvedPath.startsWith(HOME + "/") && !resolvedPath.startsWith(HOME)) {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "⛔️ Invalid path" });
      return;
    }
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "📥" });
    if (!existsSync(filePath)) {
      await tg("sendMessage", { chat_id: chatId, text: t("error.file_not_found", { path: filePath }) });
      return;
    }
    try {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("document", new Blob([readFileSync(filePath)]), filePath.split("/").pop());
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: "POST", body: form });
    } catch (err) {
      await tg("sendMessage", { chat_id: chatId, text: `❌ ${err.message}` });
    }
    return;
  }

  // /diff pagination
  if (data.startsWith("diff:")) {
    const op = data.split(":")[1];
    if (op === "noop") { await tg("answerCallbackQuery", { callback_query_id: cb.id }); return; }
    const state = diffPages[chatId];
    if (!state) { await tg("answerCallbackQuery", { callback_query_id: cb.id }); return; }
    if (op === "next" && state.idx < state.pages.length - 1) state.idx++;
    if (op === "prev" && state.idx > 0) state.idx--;
    await tg("answerCallbackQuery", { callback_query_id: cb.id });
    await sendDiffPage(chatId);
    return;
  }

  // Token rotation decision
  if (data.startsWith("rotation:")) {
    const op = data.split(":")[1];

    if (op === "new") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "⏳" });
      await tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: t("rotation.summarizing") });
      const pending = pendingRotations.get(chatId);
      try {
        const summaryResult = await runClaude(t("rotation.summarize"), () => {}, chatId);
        const summary = summaryResult.output || t("cmd.no_data");
        const oldSessionId = pending?.oldSessionId;
        const oldProjectDir = pending?.oldProjectDir;
        const sessionKey = pending?.sessionKey;
        clearActiveSession(chatId);
        if (sessionKey) resetScopeTokens(sessionKey);
        pendingRotations.delete(chatId);
        // Start new session with context
        await enqueue(chatId, t("rotation.continue", { summary }));
        // Ask about deleting old session
        if (oldSessionId && oldProjectDir) {
          await tg("sendMessage", {
            chat_id: chatId,
            text: t("rotation.ask_delete"),
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[
                { text: t("rotation.btn_delete"), callback_data: `rotation:delete:${oldSessionId}:${oldProjectDir}` },
                { text: t("rotation.btn_keep"), callback_data: "rotation:keep" },
              ]],
            },
          });
        }
      } catch (err) {
        console.error("Session rotation error:", err.message);
        clearActiveSession(chatId);
        if (pending?.sessionKey) resetScopeTokens(pending.sessionKey);
        pendingRotations.delete(chatId);
        await tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: t("error.generic", { msg: err.message }) });
      }
      return;
    }

    if (op === "compress") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "⏳" });
      await tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: t("rotation.compressing") });
      const pending = pendingRotations.get(chatId);
      await doCompressSession(chatId, pending?.sessionKey, cb.message.message_id);
      pendingRotations.delete(chatId);
      return;
    }

    if (op === "delete") {
      const parts = data.split(":");
      const sesId = parts[2];
      const projDir = parts.slice(3).join(":");
      deleteSession(sesId, projDir);
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: t("sessions.deleted") });
      await tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: t("rotation.deleted_old") });
      return;
    }

    if (op === "keep") {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "✅" });
      await tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: t("rotation.kept_old") });
      return;
    }

    return;
  }
}

// ── Context handoff: write .claude-context.md, start fresh session ──

async function doContextHandoff(chatId, sessionKey) {
  try {
    const cwd = getGitCwd(chatId);
    const contextFile = join(cwd, ".claude-context.md");

    await tg("sendMessage", { chat_id: chatId, text: t("rotation.handoff_saving"), disable_notification: true });

    // Ask Claude to write a structured context file before we close the session
    await runClaude(
      `Write a comprehensive context file to \`${contextFile}\`. Include:
- Current goal / task being worked on
- What has been accomplished so far (key changes, decisions made)
- Current state of the codebase
- What still needs to be done (next steps)
- Any important constraints or notes

Be thorough — a new Claude session will read this file to continue the work seamlessly.`,
      () => {},
      chatId,
    );

    // Verify Claude actually wrote the file before clearing the session
    if (!existsSync(contextFile)) {
      await tg("sendMessage", { chat_id: chatId, text: "⚠️ Context file was not created — session kept to avoid data loss." });
      return;
    }

    clearActiveSession(chatId);
    if (sessionKey) resetScopeTokens(sessionKey);

    // Start new session that immediately reads the context file (preserve group meta)
    await enqueue(chatId, `Read \`${contextFile}\` and continue the work from where we left off.`, { isGroup: true, isOwner: true });
    await tg("sendMessage", { chat_id: chatId, text: t("rotation.handoff_done", { file: contextFile }), parse_mode: "HTML", disable_notification: true });
  } catch (err) {
    console.error("Context handoff error:", err.message);
    await tg("sendMessage", { chat_id: chatId, text: t("error.generic", { msg: err.message }) });
  }
}

// ── Compress session (compact context, keep working) ────────────────

async function doCompressSession(chatId, sessionKey, editMsgId = null) {
  try {
    const summaryResult = await runClaude(t("rotation.summarize"), () => {}, chatId);
    const summary = summaryResult.output || t("cmd.no_data");
    clearActiveSession(chatId);
    if (sessionKey) resetScopeTokens(sessionKey);
    // Start new session seamlessly with context
    await enqueue(chatId, t("rotation.continue", { summary }));
    if (editMsgId) {
      await tg("editMessageText", { chat_id: chatId, message_id: editMsgId, text: t("rotation.compressed") }).catch(() => {});
    } else {
      await tg("sendMessage", { chat_id: chatId, text: t("rotation.compressed"), disable_notification: true });
    }
  } catch (err) {
    console.error("Compress session error:", err.message);
    if (editMsgId) {
      await tg("editMessageText", { chat_id: chatId, message_id: editMsgId, text: t("error.generic", { msg: err.message }) }).catch(() => {});
    }
  }
}

// ── Send prompt to Claude ───────────────────────────────────────────

const TOOL_UPDATE_INTERVAL = 2000; // update tool progress every 2s

async function sendToClaude(chatId, prompt, meta = {}) {
  const { isOwner = true, isGroup = false, initiatorUserId = "" } = meta;

  // Write request meta for approval-hook (group approval routing)
  try {
    writeFileSync("/tmp/claude-request-meta.json", JSON.stringify({
      isOwner, isGroup, initiatorUserId, groupChatId: isGroup ? chatId : null,
    }));
  } catch {}



  // Immediate typing indicator — user sees activity before Claude even starts
  tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

  const startTime = Date.now();
  let lastUpdateTime = 0;
  let lastActivityTime = startTime;
  let toolLines = [];
  let isWritingResponse = false;
  let streamMsgId = null;
  let mcpSent = false;

  async function createOrUpdateStreamMsg(rawText) {
    const text = stripSystemTags(String(rawText || ""));
    if (!text) return;
    try {
      if (!streamMsgId) {
        const res = await tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_notification: true });
        streamMsgId = res?.result?.message_id || null;
        lastUpdateTime = Date.now();
        console.log(`📡 stream msg created id=${streamMsgId}`);
      } else {
        lastUpdateTime = Date.now();
        tg("editMessageText", { chat_id: chatId, message_id: streamMsgId, text, parse_mode: "HTML" }).catch(() => {});
      }
    } catch (err) {
      console.error("createOrUpdateStreamMsg error:", err?.message);
    }
  }

  // typing indicator only, no "Thinking..." message

  const statusInterval = setInterval(() => {
    tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  }, 4000);

  const onEvent = (event) => {
    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "tool_use") {
          lastActivityTime = Date.now();
          const input = block.input || {};

          if (block.name?.includes("send_telegram") || block.name?.includes("send_file_telegram")) {
            mcpSent = true;
            continue;
          }

          let detail = "";
          if (block.name === "Read") detail = input.file_path || "";
          else if (block.name === "Bash") detail = (input.command || "").slice(0, 60);
          else if (block.name === "Grep") detail = input.pattern || "";
          else if (block.name === "Edit" || block.name === "Write") {
            detail = input.file_path || "";
            if (detail) trackRecentFile(detail, block.name);
          }
          else if (block.name === "Agent") detail = input.description || "";
          else detail = Object.values(input).join(" ").slice(0, 40);

          const toolLine = `🔧 ${esc(block.name)}${detail ? ": " + esc(detail) : ""}`;
          toolLines.push(toolLine);
          if (toolLines.length > 6) toolLines = toolLines.slice(-6);
          console.log(toolLine);

          const now = Date.now();
          if (now - lastUpdateTime > TOOL_UPDATE_INTERVAL) {
            buildAndUpdateStreamMsg();
          }
        } else if (block.type === "text" && block.text?.trim()) {
          isWritingResponse = true;
          lastActivityTime = Date.now();
          if (toolLines.length > 0) buildAndUpdateStreamMsg();
        }
      }
    }
  };

  function buildAndUpdateStreamMsg() {
    if (isGroup) return;
    if (toolLines.length > 0) createOrUpdateStreamMsg(toolLines.join("\n\n"));
  }

  const sessionIdBeforeRun = getActiveSession(chatId).activeSessionId;
  const result = await runClaude(prompt, onEvent, chatId);
  clearInterval(statusInterval);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Auto-save session for continuity — but only if user didn't manually switch session while Claude was running
  if (result.sessionId) {
    const currentSession = getActiveSession(chatId).activeSessionId;
    const sessionChangedByUser = currentSession !== sessionIdBeforeRun && currentSession !== result.sessionId;
    if (!sessionChangedByUser) {
      const projDir = result.projectDir || getActiveSession(chatId).activeProjectDir || "";
      const savedCwd = result.cwd || getActiveSession(chatId).activeCwd;
      setActiveSession(result.sessionId, projDir, savedCwd, chatId);
      if (pendingSessionName) {
        renameSession(result.sessionId, pendingSessionName);
        console.log(`📎 Session: ${result.sessionId.slice(0, 8)}… "${pendingSessionName}" cwd=${savedCwd}`);
        pendingSessionName = null;
      } else {
        console.log(`📎 Session: ${result.sessionId.slice(0, 8)}… cwd=${savedCwd}`);
      }
    }
  }

  // Track tokens
  const sessionKey = result.sessionId || null;
  let tokenInfo = "";
  let shouldWarnTokens = false;
  let ctx = 0;
  if (result.usage) {
    const inp = result.usage.input_tokens || 0;
    const cacheRead = result.usage.cache_read_input_tokens || 0;
    ctx = inp + cacheRead; // real context: new tokens + previously cached (not cache_creation which is overhead)
    const out = result.usage.output_tokens || 0;
    addTokens(inp, out, sessionKey);
    const CONTEXT_LIMIT = 1_000_000;
    const pctLeft = Math.max(0, Math.round((1 - ctx / CONTEXT_LIMIT) * 100));
    const contextWarning = pctLeft <= 20 ? ` · Context left until auto-compact: ${pctLeft}%` : "";
    tokenInfo = `\n\n<i>↓${formatK(inp)} ↑${formatK(out)} · ${elapsed}s${contextWarning}</i>`;
    shouldWarnTokens = pctLeft <= 5;
  } else {
    tokenInfo = `\n\n<i>${elapsed}s</i>`;
  }

  console.log(`${result.success ? "✅" : "❌"} done in ${elapsed}s exit=${result.exitCode} output=${result.output?.slice(0,200)}`);

  if (result.success && result.output === "(empty response)") {
    const hadActivity = toolLines.length > 0;
    if (streamMsgId) {
      buildAndUpdateStreamMsg();
    }
    if (hadActivity) {
      await tg("sendMessage", { chat_id: chatId, text: `✅ Готово${tokenInfo}`, parse_mode: "HTML", disable_notification: true });
    }
    return;
  }

  // Finalize stream message with last known state, or delete if nothing to show
  if (streamMsgId) {
    buildAndUpdateStreamMsg();
  }

  if (!result.success) {
    try {
      if (existsSync("/tmp/claude-intentional-sleep")) { unlinkSync("/tmp/claude-intentional-sleep"); return; }
    } catch {}
    if (result.exitCode === -1) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: `⏱ <b>Timeout</b> — Claude не ответил за 5 минут, процесс завершён.\n\nПопробуй ещё раз или <code>/new</code> для новой сессии.`,
        parse_mode: "HTML",
      });
    } else {
      await tg("sendMessage", {
        chat_id: chatId,
        text: `❌ <b>Error</b> (exit ${result.exitCode})\n\n<code>${esc(result.output.slice(0, 3000))}</code>`,
        parse_mode: "HTML",
      });
    }
    return;
  }

  if (!mcpSent) {
    const sent = await sendMsg(chatId, result.output + tokenInfo);
    if (sent === 0) {
      // Output was empty after stripping — silent completion, notify user
      await tg("sendMessage", { chat_id: chatId, text: `✅ Готово${tokenInfo}`, parse_mode: "HTML", disable_notification: true });
    }
  }

  // Warn when approaching context limit (190k+ out of 200k)
  if (shouldWarnTokens) {
    console.log(`⚠️ Token warning: ${formatK(ctx)}/200k`);
    await tg("sendMessage", {
      chat_id: chatId,
      text: t("tokens.warn_limit", { used: formatK(ctx) }),
      parse_mode: "HTML",
      disable_notification: false,
    });
  }
}

// ── Message handler ─────────────────────────────────────────────────

function isGroupChat(msg) {
  return msg.chat.type === "group" || msg.chat.type === "supergroup";
}

function isBotMentioned(msg) {
  if (!botUsername) return false;
  const text = msg.text || msg.caption || "";
  if (text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) return true;
  // Reply to bot's message
  if (msg.reply_to_message?.from?.username?.toLowerCase() === botUsername.toLowerCase()) return true;
  return false;
}

function isAuthorized(msg) {
  const senderId = String(msg.from?.id || "");
  if (senderId === OWNER_CHAT_ID) return true;
  return getAllowedUsers().includes(senderId);
}

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);

  if (isGroupChat(msg)) {
    // In groups: only authorized users, only when mentioned or replying to bot
    // Exception: owner management commands work without mention
    if (!isAuthorized(msg)) return;
    const rawText = (msg.text || "").trim();
    const isOwner = String(msg.from?.id) === OWNER_CHAT_ID;
    const isOwnerCmd = isOwner &&
      (rawText.startsWith("/allow") || rawText.startsWith("/revoke") || rawText === "/allowed");
    // Everyone (including owner) must @mention or reply to bot in groups
    if (!isOwnerCmd && !isBotMentioned(msg)) return;
    // In groups: block slash commands for non-owners
    if (rawText.startsWith("/") && !isOwnerCmd) return;
  } else {
    // In DM: owner only
    if (chatId !== OWNER_CHAT_ID) return;
  }

  // Build request meta for approval-hook and display mode
  const requestMeta = {
    isOwner: String(msg.from?.id) === OWNER_CHAT_ID,
    isGroup: isGroupChat(msg),
    initiatorUserId: String(msg.from?.id || ""),
  };

  // Track Telegram activity for auto-sleep (owner messages only)
  if (String(msg.from?.id) === OWNER_CHAT_ID) lastTelegramActivityAt = Date.now();

  console.log(`📩 text=${(msg.text||msg.caption||"").slice(0,50)} fwd=${!!(msg.forward_origin||msg.forward_from)} hasDoc=${!!msg.document} hasPhoto=${!!msg.photo}`);

  // Forwarded message — combine with pending text if available
  if (msg.forward_origin || msg.forward_from || msg.forward_from_chat || msg.forward_sender_name) {
    const from = msg.forward_from?.first_name
      || msg.forward_from_chat?.title
      || msg.forward_sender_name
      || msg.forward_origin?.sender_user?.first_name
      || msg.forward_origin?.chat?.title
      || t("fwd.unknown");

    let content = "";
    if (msg.text) {
      content = msg.text;
    } else if (msg.document) {
      // Download and embed document from forwarded message
      const doc = msg.document;
      const ext = doc.file_name ? extname(doc.file_name) : ".bin";
      const localPath = await downloadTgFile(doc.file_id, ext);
      if (localPath) {
        const textExts = [".txt", ".md", ".json", ".yml", ".yaml", ".env", ".sh", ".pem", ".key", ".pub", ".conf", ".config", ".toml", ".xml", ".csv", ".log", ""];
        const isTextFile = textExts.includes(ext.toLowerCase()) || !ext;
        if (isTextFile) {
          try {
            const fileContent = readFileSync(localPath, "utf-8");
            content = t("fwd.file_inline", { name: doc.file_name || "file", content: fileContent });
            try { unlinkSync(localPath); } catch {}
          } catch {
            content = t("fwd.file_saved", { path: localPath });
          }
        } else {
          content = t("fwd.file_saved", { path: localPath });
          setTimeout(() => { try { unlinkSync(localPath); } catch {} }, 300000);
        }
      } else {
        content = t("fwd.file_download_failed", { name: doc.file_name });
      }
      if (msg.caption) content += `\n${msg.caption}`;
    } else if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1];
      const localPath = await downloadTgFile(photo.file_id, ".jpg");
      content = localPath ? t("fwd.photo_saved", { path: localPath }) : t("fwd.photo_failed");
      if (msg.caption) content += `\n${msg.caption}`;
      if (localPath) setTimeout(() => { try { unlinkSync(localPath); } catch {} }, 300000);
    } else if (msg.caption) {
      content = t("fwd.media_caption", { caption: msg.caption });
    } else {
      content = t("fwd.media_no_text");
    }

    const fwdBlock = t("fwd.from", { from, content });

    // If user sent a text comment just before this forward — combine them
    if (pendingDMText[chatId]) {
      clearTimeout(pendingDMText[chatId].timer);
      const userComment = pendingDMText[chatId].prompt;
      delete pendingDMText[chatId];
      await enqueue(chatId, `${fwdBlock}\n\n${userComment}`, requestMeta);
    } else {
      await enqueue(chatId, fwdBlock, requestMeta);
    }
    return;
  }

  // Photo — buffer multiple photos (media group) into a single prompt
  if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1]; // largest size
    const caption = msg.caption || "";
    try {
      const localPath = await downloadTgFile(photo.file_id, ".jpg");
      if (!localPath) {
        await tg("sendMessage", { chat_id: chatId, text: t("error.photo_download") });
        return;
      }
      const existing = pendingPhotos[chatId];
      if (existing) {
        clearTimeout(existing.timer);
        existing.paths.push(localPath);
        if (caption) existing.caption = caption;
      } else {
        pendingPhotos[chatId] = { paths: [localPath], caption, meta: requestMeta };
      }
      const state = pendingPhotos[chatId];
      state.timer = setTimeout(() => {
        const { paths, caption: cap, meta } = pendingPhotos[chatId];
        delete pendingPhotos[chatId];
        const imageList = paths.map(p => p).join(", ");
        const prompt = paths.length === 1
          ? t("fwd.look_at_image", { path: paths[0], caption: cap || t("fwd.describe_photo") })
          : `Look at these ${paths.length} images: ${imageList}\n\n${cap || t("fwd.describe_photo")}`;
        enqueue(chatId, prompt, meta);
        setTimeout(() => { paths.forEach(p => { try { unlinkSync(p); } catch {} }); }, 120000);
      }, 1500);
    } catch (err) {
      console.error("Photo error:", err.message);
      await tg("sendMessage", { chat_id: chatId, text: t("error.generic", { msg: err.message }) });
    }
    return;
  }

  // Document (file)
  if (msg.document) {
    const doc = msg.document;
    const caption = msg.caption || "";
    try {
      const ext = doc.file_name ? extname(doc.file_name) : ".bin";
      const localPath = await downloadTgFile(doc.file_id, ext);
      if (!localPath) {
        await tg("sendMessage", { chat_id: chatId, text: t("error.file_download") });
        return;
      }
      // For text-like files: embed content directly so Claude doesn't need file access
      const textExts = [".txt", ".md", ".json", ".yml", ".yaml", ".env", ".sh", ".pem", ".key", ".pub", ".conf", ".config", ".toml", ".xml", ".csv", ".log", ""];
      const isTextFile = textExts.includes(ext.toLowerCase()) || !ext;
      let enqueueMsg;
      if (isTextFile) {
        try {
          const content = readFileSync(localPath, "utf-8");
          enqueueMsg = `${t("fwd.file_inline", { name: doc.file_name || "file", content })}\n\n${caption}`.trim();
          try { unlinkSync(localPath); } catch {}
        } catch {
          enqueueMsg = `${t("fwd.file_at", { path: localPath, name: doc.file_name || "file" })}\n\n${caption}`.trim();
          setTimeout(() => { try { unlinkSync(localPath); } catch {} }, 300000);
        }
      } else {
        enqueueMsg = `${t("fwd.file_at", { path: localPath, name: doc.file_name || "file" })}\n\n${caption}`.trim();
        setTimeout(() => { try { unlinkSync(localPath); } catch {} }, 300000);
      }
      await enqueue(chatId, enqueueMsg, requestMeta);
    } catch (err) {
      console.error("Document error:", err.message);
      await tg("sendMessage", { chat_id: chatId, text: t("error.generic", { msg: err.message }) });
    }
    return;
  }

  // Voice message
  if (msg.voice) {
    const recRes = await tg("sendMessage", { chat_id: chatId, text: t("status.recognizing"), disable_notification: true });
    const recMsgId = recRes?.result?.message_id;
    try {
      const text = await transcribeVoice(msg.voice.file_id, BOT_TOKEN);
      if (recMsgId) await tg("deleteMessage", { chat_id: chatId, message_id: recMsgId });
      if (!text) {
        await tg("sendMessage", { chat_id: chatId, text: t("error.voice_recognize") });
        return;
      }
      console.log(`🎤 → ${text}`);
      await enqueue(chatId, text, requestMeta);
    } catch (err) {
      if (recMsgId) await tg("deleteMessage", { chat_id: chatId, message_id: recMsgId });
      console.error("Voice error:", err.message);
      await tg("sendMessage", { chat_id: chatId, text: t("error.voice_error", { msg: err.message }) });
    }
    return;
  }

  let text = msg.text;
  if (!text) return;

  // Strip @botname from text (commands and regular messages in groups)
  if (botUsername) {
    text = text.replace(new RegExp(`@${botUsername}\\b`, "gi"), "").trim();
  }

  // Commands
  if (text === "/start") { await showWelcome(chatId, msg.from?.language_code); return; }
  if (text === "/help") { await showHelp(chatId); return; }
  if (text === "/setup") {
    await tg("sendMessage", { chat_id: chatId, text: t("setup.cmd"), parse_mode: "HTML" });
    await sendSetupStep0(chatId);
    return;
  }
  if (text === "/sessions" || text === "📂 sessions") { await showSessions(chatId); return; }
  // ── Allowed users management (owner only) ──
  if (text.startsWith("/allow") || text.startsWith("/revoke") || text === "/allowed") {
    if (chatId !== OWNER_CHAT_ID && String(msg.from?.id) !== OWNER_CHAT_ID) {
      await tg("sendMessage", { chat_id: chatId, text: "❌ Owner only." });
      return;
    }
    if (text === "/allowed") {
      const users = getAllowedUsers();
      await tg("sendMessage", {
        chat_id: chatId,
        text: users.length ? `👥 Allowed users:\n${users.map((u) => `• <code>${u}</code>`).join("\n")}` : "👥 No allowed users.",
        parse_mode: "HTML",
      });
      return;
    }
    if (text.startsWith("/allow")) {
      const arg = text.slice(6).trim().replace(/^@/, "");
      const replyUserId = String(msg.reply_to_message?.from?.id || "");
      const userId = arg || replyUserId;
      if (!userId) { await tg("sendMessage", { chat_id: chatId, text: "Usage: /allow <user_id> or reply to a user's message" }); return; }
      const displayName = arg ? userId : (msg.reply_to_message?.from?.first_name || userId);
      addAllowedUser(userId);
      await tg("sendMessage", { chat_id: chatId, text: `✅ <b>${esc(displayName)}</b> (<code>${esc(userId)}</code>) allowed.`, parse_mode: "HTML" });
      return;
    }
    if (text.startsWith("/revoke")) {
      const arg = text.slice(7).trim().replace(/^@/, "");
      const replyUserId = String(msg.reply_to_message?.from?.id || "");
      const userId = arg || replyUserId;
      if (!userId) { await tg("sendMessage", { chat_id: chatId, text: "Usage: /revoke <user_id> or reply to a user's message" }); return; }
      const displayName = arg ? userId : (msg.reply_to_message?.from?.first_name || userId);
      removeAllowedUser(userId);
      await tg("sendMessage", { chat_id: chatId, text: `✅ <b>${esc(displayName)}</b> (<code>${esc(userId)}</code>) removed.`, parse_mode: "HTML" });
      return;
    }
  }

  if (text === "/stop") {
    if (killActiveChild(chatId)) {
      getChatQueue(chatId).busy = false;
      await tg("sendMessage", { chat_id: chatId, text: t("cmd.stopped") });
    } else {
      await tg("sendMessage", { chat_id: chatId, text: t("cmd.nothing_running") });
    }
    return;
  }
  if (text === "/detach") {
    clearActiveSession(chatId);
    await tg("sendMessage", { chat_id: chatId, text: t("sessions.detached") });
    return;
  }
  if (text.startsWith("/new")) {
    const name = text.slice(4).trim();
    clearActiveSession(chatId);
    resetTokens();
    if (name) {
      pendingSessionName = name;
      await tg("sendMessage", { chat_id: chatId, text: t("sessions.new_named", { name: esc(name) }), parse_mode: "HTML" });
    } else {
      await tg("sendMessage", { chat_id: chatId, text: t("sessions.new_prompt") });
    }
    return;
  }
  if (text.startsWith("/name")) {
    const name = text.slice(5).trim();
    const { activeSessionId } = getActiveSession(chatId);
    if (!activeSessionId) {
      await tg("sendMessage", { chat_id: chatId, text: t("sessions.no_active") });
      return;
    }
    if (!name) {
      await tg("sendMessage", { chat_id: chatId, text: t("sessions.name_usage") });
      return;
    }
    renameSession(activeSessionId, name);
    await tg("sendMessage", { chat_id: chatId, text: t("sessions.renamed", { name: esc(name) }), parse_mode: "HTML" });
    return;
  }



  if (text.startsWith("/mode")) {
    const arg = text.slice(5).trim().toLowerCase();
    if (!arg) {
      const current = getOutputMode();
      await tg("sendMessage", {
        chat_id: chatId,
        text: t("cmd.mode_current", { mode: esc(VALID_MODES[current] || current) }),
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: `${current === "terminal" ? "▶️ " : ""}Terminal`, callback_data: "mode:terminal" },
            { text: `${current === "hybrid" ? "▶️ " : ""}Hybrid`, callback_data: "mode:hybrid" },
            { text: `${current === "telegram" ? "▶️ " : ""}Telegram`, callback_data: "mode:telegram" },
          ]],
        },
      });
      return;
    }
    if (VALID_MODES[arg]) {
      setOutputMode(arg);
      await tg("sendMessage", { chat_id: chatId, text: t("cmd.mode_set", { mode: esc(VALID_MODES[arg]) }), parse_mode: "HTML"});
    } else {
      await tg("sendMessage", { chat_id: chatId, text: t("error.invalid_modes") });
    }
    return;
  }
  if (text === "/status") {
    const { input, output } = getTokens();
    const { activeSessionId, activeCwd } = getActiveSession(chatId);
    const scopeTotal = getScopeTokens(activeSessionId);
    const sessionName = activeSessionId
      ? (getSessionName(activeSessionId) || activeSessionId.slice(0, 8) + "…")
      : t("status.no_session");
    const cwd = getCustomCwd() || activeCwd || HOME;
    const mode = getOutputMode();
    const model = getModel();
    const CONTEXT_LIMIT = 200_000;
    const bar = tokenProgressBar(scopeTotal, CONTEXT_LIMIT);
    await tg("sendMessage", {
      chat_id: chatId,
      text: t("status.cmd", {
        model, mode,
        cwd: esc(cwd.replace(HOME, "~")),
        session: esc(sessionName),
        bar,
        input: formatK(input),
        output: formatK(output),
      }),
      parse_mode: "HTML",
    });
    return;
  }
  if (text.startsWith("/cd")) {
    const dir = text.slice(3).trim().replace(/^~/, "${HOME}");
    if (!dir) {
      const current = getCustomCwd() || t("help.auto_session");
      await tg("sendMessage", { chat_id: chatId, text: t("cmd.cd_current", { cwd: esc(current) }), parse_mode: "HTML"});
      return;
    }
    if (dir === "-" || dir === "reset") {
      setCustomCwd(null);
      await tg("sendMessage", { chat_id: chatId, text: t("cmd.cd_reset") });
      return;
    }
    setCustomCwd(dir);
    await tg("sendMessage", { chat_id: chatId, text: t("cmd.cd_set", { dir: esc(dir) }), parse_mode: "HTML"});
    return;
  }
  if (text.startsWith("/model")) {
    const arg = text.slice(6).trim().toLowerCase();
    if (!arg) {
      const current = getModel();
      await tg("sendMessage", {
        chat_id: chatId,
        text: t("cmd.model_current", { model: esc(current) }),
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: `${current === "sonnet" ? "▶️ " : ""}Sonnet`, callback_data: "model:sonnet" },
            { text: `${current === "opus" ? "▶️ " : ""}Opus`, callback_data: "model:opus" },
            { text: `${current === "haiku" ? "▶️ " : ""}Haiku`, callback_data: "model:haiku" },
          ]],
        },
      });
      return;
    }
    if (setModel(arg)) {
      await tg("sendMessage", { chat_id: chatId, text: t("cmd.model_set", { model: esc(arg) }), parse_mode: "HTML"});
    } else {
      await tg("sendMessage", { chat_id: chatId, text: t("error.invalid_models") });
    }
    return;
  }
  if (text === "/sleep" || text === "/lock" || text === "/shutdown" || text === "/reboot") {
    if (getOs() !== "mac") {
      await tg("sendMessage", { chat_id: chatId, text: "❌ macOS only." });
      return;
    }
  }

  if (text === "/sleep") {
    await tg("sendMessage", { chat_id: chatId, text: t("sleep.going") });
    setTimeout(() => { try { execSync("pmset sleepnow"); } catch {} }, 1000);
    return;
  }
  if (text === "/lock") {
    execSync("/System/Library/CoreServices/Menu\\ Extras/User.menu/Contents/Resources/CGSession -suspend");
    await tg("sendMessage", { chat_id: chatId, text: t("cmd.locked") });
    return;
  }
  if (text === "/shutdown" || text === "/reboot") {
    const action = text.slice(1);
    const emoji = action === "shutdown" ? "⏻" : "🔄";
    await tg("sendMessage", {
      chat_id: chatId,
      text: t("cmd.confirm_action", { emoji, action: action === "shutdown" ? t("mac.action_shutdown") : t("mac.action_reboot") }),
      reply_markup: {
        inline_keyboard: [[
          { text: t("approval.yes_btn"), callback_data: `mac:${action}` },
          { text: t("approval.cancel_btn"), callback_data: "mac:cancel" },
        ]],
      },
    });
    return;
  }
  if (text === "/undo") {
    const cwd = getGitCwd();
    if (!isGitRepo(cwd)) {
      await tg("sendMessage", { chat_id: chatId, text: t("git.undo_impossible") });
      return;
    }
    // Check if there are commits to undo
    const log = gitExec("git log --oneline -1", cwd);
    if (!log) {
      await tg("sendMessage", { chat_id: chatId, text: t("error.no_commits") });
      return;
    }
    // Show what will be undone, ask confirmation
    const diff = gitExec("git diff HEAD~1 --stat", cwd);
    await tg("sendMessage", {
      chat_id: chatId,
      text: t("git.undo_confirm", { log: esc(log), diff: esc(diff.slice(0, 2000)) }),
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: t("git.undo_soft_btn"), callback_data: "undo:soft" },
          { text: t("git.undo_hard_btn"), callback_data: "undo:hard" },
        ], [
          { text: t("approval.cancel_btn"), callback_data: "undo:cancel" },
        ]],
      },
    });
    return;
  }
  if (text.startsWith("/screenshot")) {
    const url = text.slice(11).trim();
    if (!url) {
      await tg("sendMessage", { chat_id: chatId, text: t("cmd.screenshot_usage") });
      return;
    }
    await tg("sendMessage", { chat_id: chatId, text: t("status.screenshotting"), disable_notification: true });
    try {
      const screenshotPath = join(TMP_DIR, `screenshot-${Date.now()}.png`);
      // Use puppeteer via npx or installed
      // Pass URL and path as process args via execFile — no shell, no injection risk
      await new Promise((res, rej) => execFile(
        process.execPath,
        [join(__dirname, "screenshot.mjs"), url, screenshotPath],
        { timeout: 30000, cwd: __dirname },
        (err) => err ? rej(err) : res()
      ));
      // Send photo to Telegram
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("photo", new Blob([readFileSync(screenshotPath)], { type: "image/png" }), "screenshot.png");
      form.append("caption", url);
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: "POST", body: form });
      try { unlinkSync(screenshotPath); } catch {}
    } catch (err) {
      await tg("sendMessage", { chat_id: chatId, text: t("error.screenshot", { msg: err.message.slice(0, 200) }) });
    }
    return;
  }
  if (text === "/compact") {
    const { activeSessionId } = getActiveSession(chatId);
    if (!activeSessionId) {
      await tg("sendMessage", { chat_id: chatId, text: t("sessions.no_active") });
      return;
    }
    const msg = await tg("sendMessage", { chat_id: chatId, text: t("rotation.compressing"), disable_notification: true });
    const { sessionKey } = (() => {
      // retrieve current sessionKey from state
      const s = getActiveSession(chatId);
      return { sessionKey: s.activeSessionId };
    })();
    await doCompressSession(chatId, sessionKey, msg.result?.message_id);
    return;
  }

  if (text === "/plan") {
    planMode = !planMode;
    const emoji = planMode ? "📐" : "🔨";
    const label = planMode ? "Plan" : "Build";
    await tg("sendMessage", {
      chat_id: chatId,
      text: t("cmd.plan_mode", { emoji, label }),
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: `${planMode ? "▶️ " : ""}📐 Plan`, callback_data: "planmode:plan" },
          { text: `${!planMode ? "▶️ " : ""}🔨 Build`, callback_data: "planmode:build" },
        ]],
      },
    });
    return;
  }
  if (text === "/git" || text.startsWith("/git ")) {
    const arg = text.slice(4).trim();
    if (!arg) {
      await showGitPanel(chatId);
    } else {
      // Direct git command: /git log --oneline -5
      const cwd = getGitCwd();
      if (!isGitRepo(cwd)) {
        await tg("sendMessage", { chat_id: chatId, text: t("error.not_git", { cwd: esc(cwd) }), parse_mode: "HTML" });
        return;
      }
      const out = gitExecSafe(arg.split(/\s+/), cwd);
      await sendMsg(chatId, `\`\`\`\n${out.slice(0, 3800)}\n\`\`\``);
    }
    return;
  }
  // ── Direct shell — owner DM only ──
  if (text.startsWith("/sh ")) {
    if (String(msg.from?.id) !== OWNER_CHAT_ID) {
      await tg("sendMessage", { chat_id: chatId, text: "⛔️ /sh is owner-only." });
      return;
    }
    const cmd = text.slice(4);
    const cwd = getGitCwd();
    try {
      const out = execSync(cmd, { cwd, encoding: "utf-8", timeout: 30000, maxBuffer: 100 * 1024 }).trim();
      await sendMsg(chatId, `\`\`\`\n${out.slice(0, 3800) || t("cmd.empty")}\n\`\`\``);
    } catch (err) {
      const errOut = (err.stdout || "") + (err.stderr || "") || err.message;
      await sendMsg(chatId, `\`\`\`\n${errOut.slice(0, 3800)}\n\`\`\``);
    }
    return;
  }

  // ── System monitor ──
  if (text === "/battery") {
    const info = getBatteryInfo();
    if (!info) {
      await tg("sendMessage", { chat_id: chatId, text: "❌ Не удалось получить данные о батарее." });
    } else {
      const emoji = info.status === "charging" ? "⚡️" : info.percent <= 10 ? "🪫" : info.percent <= 20 ? "🔋" : "🔋";
      const bar = "█".repeat(Math.round(info.percent / 10)) + "░".repeat(10 - Math.round(info.percent / 10));
      const statusText = info.status === "charging" ? "заряжается" : info.status === "charged" ? "заряжен" : `осталось ~${info.remaining}`;
      await tg("sendMessage", {
        chat_id: chatId,
        text: `${emoji} <b>${info.percent}%</b>  <code>${bar}</code>\n${statusText}`,
        parse_mode: "HTML",
      });
    }
    return;
  }

  if (text === "/sys") {
    const info = [];
    try { info.push("🖥 " + execSync("sysctl -n machdep.cpu.brand_string", { encoding: "utf-8" }).trim()); } catch {}
    try {
      const load = execSync("sysctl -n vm.loadavg", { encoding: "utf-8" }).trim();
      info.push("📊 Load: " + load);
    } catch {}
    try {
      const mem = execSync("vm_stat | head -5", { encoding: "utf-8" }).trim();
      const pages = {};
      for (const line of mem.split("\n")) {
        const m = line.match(/Pages\s+(\w+):\s+(\d+)/);
        if (m) pages[m[1]] = parseInt(m[2]) * 16384 / 1024 / 1024 / 1024;
      }
      const used = (pages.active || 0) + (pages.wired || 0);
      const free = pages.free || 0;
      info.push(`🧠 RAM: ${used.toFixed(1)}G used / ${(used + free).toFixed(1)}G`);
    } catch {}
    try {
      const disk = execSync("df -h / | tail -1", { encoding: "utf-8" }).trim().split(/\s+/);
      info.push(`💾 Disk: ${disk[2]} used / ${disk[1]} (${disk[4]})`);
    } catch {}
    try {
      const batt = execSync("pmset -g batt", { encoding: "utf-8" });
      const m = batt.match(/(\d+)%;\s*(\w+)/);
      if (m) info.push(`🔋 ${m[1]}% (${m[2]})`);
    } catch {}
    try {
      const net = execSync("networksetup -getairportnetwork en0 2>/dev/null || echo 'N/A'", { encoding: "utf-8" }).trim();
      info.push("📶 " + net.replace("Current Wi-Fi Network: ", "Wi-Fi: "));
    } catch {}
    try {
      const ip = execSync("curl -s --max-time 3 ifconfig.me || echo 'N/A'", { encoding: "utf-8" }).trim();
      info.push("🌐 IP: " + ip);
    } catch {}
    try {
      const uptime = execSync("uptime | sed 's/.*up /⏱ Up: /' | sed 's/,.*//'", { encoding: "utf-8" }).trim();
      info.push(uptime);
    } catch {}
    await tg("sendMessage", { chat_id: chatId, text: info.join("\n") || t("cmd.no_data") });
    return;
  }

  // ── Clipboard ──
  if (text === "/clip" || text === "/clip get") {
    try {
      const clip = execSync("pbpaste", { encoding: "utf-8", maxBuffer: 10 * 1024 });
      await sendMsg(chatId, clip.slice(0, 4000) || t("cmd.empty"));
    } catch (err) {
      await tg("sendMessage", { chat_id: chatId, text: `❌ ${err.message}` });
    }
    return;
  }
  if (text.startsWith("/clip ")) {
    const content = text.slice(6);
    try {
      execSync("pbcopy", { input: content, encoding: "utf-8" });
      await tg("sendMessage", { chat_id: chatId, text: t("cmd.clipboard_copied", { len: content.length }) });
    } catch (err) {
      await tg("sendMessage", { chat_id: chatId, text: `❌ ${err.message}` });
    }
    return;
  }

  // ── Download file ──
  if (text.startsWith("/dl ")) {
    const filePath = text.slice(4).trim().replace(/^~/, "${HOME}");
    if (!existsSync(filePath)) {
      await tg("sendMessage", { chat_id: chatId, text: t("error.file_not_found", { path: filePath }) });
      return;
    }
    try {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("document", new Blob([readFileSync(filePath)]), filePath.split("/").pop());
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: "POST", body: form });
    } catch (err) {
      await tg("sendMessage", { chat_id: chatId, text: `❌ ${err.message}` });
    }
    return;
  }

  // ── Cron / reminders ──
  if (text.startsWith("/cron")) {
    const arg = text.slice(5).trim();
    if (!arg || arg === "list") {
      if (cronJobs.length === 0) {
        await tg("sendMessage", { chat_id: chatId, text: t("cron.empty") });
      } else {
        const list = cronJobs.map((j, i) => `${i + 1}. ⏰ ${j.label} (${new Date(j.fireAt).toLocaleTimeString("ru")})`).join("\n");
        await tg("sendMessage", { chat_id: chatId, text: t("cron.list", { list }) });
      }
      return;
    }
    if (arg.startsWith("del ")) {
      const idx = parseInt(arg.slice(4)) - 1;
      if (cronJobs[idx]) {
        clearTimeout(cronJobs[idx].timer);
        const label = cronJobs[idx].label;
        cronJobs.splice(idx, 1);
        await tg("sendMessage", { chat_id: chatId, text: t("cron.deleted", { label }) });
      } else {
        await tg("sendMessage", { chat_id: chatId, text: t("cron.not_found") });
      }
      return;
    }
    // Parse: /cron 2h проверь деплой  OR  /cron 30m напомни
    const cronMatch = arg.match(/^(\d+)\s*(m|min|м|h|hr|ч|s|sec|с)\s+(.+)$/i);
    if (!cronMatch) {
      await tg("sendMessage", { chat_id: chatId, text: t("cron.usage") });
      return;
    }
    const amount = parseInt(cronMatch[1]);
    const unit = cronMatch[2].toLowerCase();
    const label = cronMatch[3];
    const multiplier = "smсsec".includes(unit) ? 1000 : "mminм".includes(unit) ? 60000 : 3600000;
    const delayMs = amount * multiplier;
    const fireAt = Date.now() + delayMs;
    const timer = setTimeout(async () => {
      await tg("sendMessage", { chat_id: chatId, text: t("cron.reminder", { label }) });
      const idx = cronJobs.findIndex(j => j.fireAt === fireAt && j.label === label);
      if (idx >= 0) cronJobs.splice(idx, 1);
    }, delayMs);
    cronJobs.push({ label, fireAt, timer });
    const timeStr = amount + ({ s: "с", sec: "с", с: "с", m: "м", min: "м", м: "м", h: "ч", hr: "ч", ч: "ч" }[unit] || unit);
    await tg("sendMessage", { chat_id: chatId, text: t("cron.set", { time: timeStr, label }) });
    return;
  }

  if (text.startsWith("/lang")) {
    const arg = text.slice(5).trim().toLowerCase();
    const current = getVoiceLang();
    if (!arg) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: t("cmd.lang_current", { lang: esc(current) }),
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: `${current === "ru" ? "▶️ " : ""}RU`, callback_data: "lang:ru" },
            { text: `${current === "en" ? "▶️ " : ""}EN`, callback_data: "lang:en" },
            { text: `${current === "auto" ? "▶️ " : ""}Auto`, callback_data: "lang:auto" },
          ]],
        },
      });
      return;
    }
    setVoiceLang(arg);
    await tg("sendMessage", { chat_id: chatId, text: t("cmd.lang_set", { lang: esc(arg) }), parse_mode: "HTML" });
    return;
  }
  if (text.startsWith("/botlang")) {
    const arg = text.slice(8).trim().toLowerCase();
    if (!arg) {
      const current = getLang();
      const langs = availableLangs();
      await tg("sendMessage", {
        chat_id: chatId,
        text: t("cmd.botlang_current", { lang: esc(current) }),
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [langs.map(l => ({
            text: `${current === l ? "▶️ " : ""}${l.toUpperCase()}`,
            callback_data: `botlang:${l}`,
          }))],
        },
      });
      return;
    }
    if (setLang(arg)) {
      await tg("sendMessage", { chat_id: chatId, text: t("cmd.botlang_set", { lang: esc(arg) }), parse_mode: "HTML" });
    } else {
      await tg("sendMessage", { chat_id: chatId, text: t("error.generic", { msg: `Unknown language: ${arg}` }) });
    }
    return;
  }
  if (text === "/recent") {
    if (recentFiles.length === 0) {
      await tg("sendMessage", { chat_id: chatId, text: "📂 No recent files." });
      return;
    }
    const buttons = recentFiles.map(f => [{
      text: `${f.tool === "Write" ? "📝" : "✏️"} ${f.path.split("/").pop()}`,
      callback_data: `dl:${f.path.slice(0, 200)}`,
    }]);
    await tg("sendMessage", {
      chat_id: chatId,
      text: `📂 <b>Recent files:</b>\n\n${recentFiles.map((f, i) => `${i + 1}. <code>${esc(f.path)}</code>`).join("\n")}`,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    });
    return;
  }

  if (text === "/diff" || text.startsWith("/diff ")) {
    const arg = text.slice(5).trim();
    const cwd = getGitCwd();
    if (!isGitRepo(cwd)) {
      await tg("sendMessage", { chat_id: chatId, text: t("error.not_git", { cwd: esc(cwd) }), parse_mode: "HTML" });
      return;
    }
    const gitArg = arg || "HEAD";
    const raw = gitExecSafe(["diff", ...gitArg.split(/\s+/)], cwd) || gitExec("git diff --cached", cwd) || "";
    if (!raw.trim()) {
      await tg("sendMessage", { chat_id: chatId, text: "✅ No diff." });
      return;
    }
    const PAGE = 3500;
    const pages = [];
    for (let i = 0; i < raw.length; i += PAGE) pages.push(raw.slice(i, i + PAGE));
    diffPages[chatId] = { pages, idx: 0 };
    await sendDiffPage(chatId);
    return;
  }

  if (text.startsWith("/")) return;

  // Regular message → Claude
  let finalPrompt = text;
  // If replying to a message, prepend the quoted text as context
  const replyText = msg.reply_to_message?.text || msg.reply_to_message?.caption;
  if (replyText) {
    finalPrompt = `> ${replyText.replace(/\n/g, "\n> ")}\n\n${finalPrompt}`;
  }
  if (planMode) finalPrompt = t("plan.prefix", { prompt: finalPrompt });

  // DM: if waiting for session name after "New session" button
  if (pendingNewNaming.has(chatId)) {
    pendingNewNaming.delete(chatId);
    pendingSessionName = finalPrompt.trim();
    await tg("sendMessage", {
      chat_id: chatId,
      text: t("sessions.new_named", { name: esc(pendingSessionName) }),
      parse_mode: "HTML",
    });
    return;
  }

  // Group: if waiting for session name, use this message as the name
  if (pendingGroupNaming.has(chatId)) {
    const pending = pendingGroupNaming.get(chatId);
    pendingGroupNaming.delete(chatId);
    pendingSessionName = finalPrompt.trim();
    await tg("sendMessage", {
      chat_id: chatId,
      text: t("sessions.group_named", { name: esc(pendingSessionName) }),
      parse_mode: "HTML",
    });
    // Now enqueue the original prompt that triggered the naming
    await enqueue(chatId, pending.prompt, pending.meta);
    return;
  }

  // Group: first message with no active session → ask for session name
  if (isGroupChat(msg)) {
    const { activeSessionId } = getActiveSession(chatId);
    if (!activeSessionId) {
      pendingGroupNaming.set(chatId, { prompt: finalPrompt, meta: requestMeta });
      await tg("sendMessage", {
        chat_id: chatId,
        text: t("sessions.group_ask_name"),
        parse_mode: "HTML",
      });
      return;
    }
  }

  // Aggregate messages arriving within 1.5s (combine instead of replace)
  const existing = pendingDMText[chatId];
  if (existing) {
    clearTimeout(existing.timer);
    finalPrompt = existing.prompt + "\n\n" + finalPrompt;
  }
  const timer = setTimeout(() => {
    delete pendingDMText[chatId];
    enqueue(chatId, finalPrompt, requestMeta);
  }, 1500);
  pendingDMText[chatId] = { prompt: finalPrompt, timer };
  return;
}

// ── Polling ─────────────────────────────────────────────────────────

async function poll() {
  while (running) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT}&allowed_updates=["message","callback_query"]`
      );
      const data = await res.json();

      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          if (update.callback_query) {
            // Callbacks must be handled immediately (approval buttons)
            await handleCallback(update.callback_query);
          } else if (update.message) {
            // Fire-and-forget so polling continues during Claude execution
            handleMessage(update.message).catch((err) =>
              console.error("Message handler error:", err.message)
            );
          }
        }
      }
    } catch (err) {
      console.error("Poll error:", err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function init() {
  while (true) {
    try {
      await tg("deleteWebhook", {});
      const me = await tg("getMe", {});
      if (me.ok) botUsername = me.result.username;
      writeFileSync(PID_FILE, String(process.pid));
      console.log(`🤖 Bot started @${botUsername} (voice + quick actions + markdown)`);
      return;
    } catch (err) {
      console.error("Init failed, retrying in 5s:", err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function cleanupPid() {
  try { unlinkSync(PID_FILE); } catch {}
}

let sleepPromptSentAt = null; // when we sent the sleep question
let lastTelegramActivityAt = null; // timestamp of last owner message via Telegram

const SLEEP_IDLE_MS = 30 * 60 * 1000; // 30 min idle since last Telegram activity → ask

function doSleep() {
  try { execSync("pmset sleepnow"); } catch {}
}

// Get real system idle time (keyboard/mouse/trackpad) on macOS via HIDIdleTime
// Returns milliseconds since last input, or -1 if unavailable
function getSystemIdleMs() {
  try {
    const out = execSync("ioreg -c IOHIDSystem | grep HIDIdleTime", { encoding: "utf-8", timeout: 3000 });
    const match = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    if (match) return parseInt(match[1], 10) / 1_000_000; // nanoseconds → ms
  } catch {}
  return -1;
}

// ── Battery monitoring ───────────────────────────────────────────────

function getBatteryInfo() {
  try {
    const out = execSync("pmset -g batt", { encoding: "utf-8" });
    const match = out.match(/(\d+)%;\s*([\w ]+);\s*([\d:]+|0:00) remaining/);
    if (!match) return null;
    const percent = parseInt(match[1], 10);
    const status = match[2].trim(); // "discharging", "charging", "charged"
    const remaining = match[3];
    return { percent, status, remaining };
  } catch { return null; }
}

const batteryAlertsSent = new Set(); // tracks which thresholds already notified

function startBatteryWatcher() {
  if (getOs() !== "mac") return;

  setInterval(() => {
    const info = getBatteryInfo();
    if (!info || info.status !== "discharging") {
      // Reset alerts when charging
      batteryAlertsSent.clear();
      return;
    }

    for (const threshold of [20, 10]) {
      if (info.percent <= threshold && !batteryAlertsSent.has(threshold)) {
        batteryAlertsSent.add(threshold);
        const emoji = threshold <= 10 ? "🪫" : "🔋";
        tg("sendMessage", {
          chat_id: OWNER_CHAT_ID,
          text: `${emoji} <b>Батарея ${info.percent}%</b> — осталось ~${info.remaining}`,
          parse_mode: "HTML",
        }).catch(() => {});
      }
    }
  }, 2 * 60 * 1000); // check every 2 min
}

function startAutoSleepWatcher() {
  if (getOs() !== "mac") return; // only macOS has HIDIdleTime + pmset

  const INTERVAL_MS = 5 * 60 * 1000;
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastTick;
    lastTick = now;

    // If elapsed >> interval, Mac was sleeping — skip to avoid false prompt
    if (elapsed > INTERVAL_MS * 1.5) {
      sleepPromptSentAt = null;
      return;
    }

    // If we already sent the prompt — cancel if user touched keyboard/mouse
    if (sleepPromptSentAt !== null) {
      const idle = getSystemIdleMs();
      if (idle >= 0 && idle < SLEEP_IDLE_MS) {
        sleepPromptSentAt = null;
      }
      return;
    }

    // Only ask if last activity was via Telegram (not working directly at Mac)
    if (!lastTelegramActivityAt) return;
    if (now - lastTelegramActivityAt < SLEEP_IDLE_MS) return;

    // Also check real system idle — keyboard, mouse, trackpad
    const idleMs = getSystemIdleMs();
    if (idleMs < 0 || idleMs < SLEEP_IDLE_MS) return;

    sleepPromptSentAt = now;
    tg("sendMessage", {
      chat_id: OWNER_CHAT_ID,
      text: t("sleep.ask"),
      reply_markup: {
        inline_keyboard: [[
          { text: t("sleep.yes_btn"), callback_data: "sleep:yes" },
          { text: t("sleep.no_btn"), callback_data: "sleep:no" },
        ]],
      },
    }).catch(() => { sleepPromptSentAt = null; });
  }, INTERVAL_MS);
}

// ── Pending approval reminder ───────────────────────────────────────
// If a dangerous op is waiting for approval in the terminal for >3 min,
// send a reminder to Telegram (the actual approval stays in terminal).

const PENDING_APPROVAL_FILE = "/tmp/claude-tg-pending-approval";
const APPROVAL_REMINDER_MS = 3 * 60 * 1000; // 3 min

function startApprovalWatcher() {
  setInterval(() => {
    try {
      if (!existsSync(PENDING_APPROVAL_FILE)) return;
      const data = JSON.parse(readFileSync(PENDING_APPROVAL_FILE, "utf-8"));
      const age = Date.now() - data.ts;
      if (age < APPROVAL_REMINDER_MS) return;
      // Send reminder and delete marker
      unlinkSync(PENDING_APPROVAL_FILE);
      const mins = Math.round(age / 60000);
      tg("sendMessage", {
        chat_id: OWNER_CHAT_ID,
        text: t("approval.pending_terminal", { min: mins, tool: esc(data.toolName), detail: esc(data.detail) }),
        parse_mode: "HTML",
      }).catch(() => {});
    } catch {}
  }, 30_000); // check every 30s
}

init().then(() => {
  poll();
  startAutoSleepWatcher();
  startBatteryWatcher();
  startApprovalWatcher();
});

process.on("SIGINT", () => { running = false; cleanupPid(); process.exit(0); });
process.on("SIGTERM", () => { running = false; cleanupPid(); process.exit(0); });
process.on("exit", cleanupPid);
