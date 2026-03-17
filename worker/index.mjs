#!/usr/bin/env node

/**
 * Telegram → Claude bridge (direct, no Cloudflare)
 * Owner-only remote terminal with session management, voice, quick actions
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { execSync, execFile } from "child_process";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

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
const cronJobs = []; // [{label, fireAt, timer}]
const pendingDMText = {}; // chatId → { prompt, timer } — buffer text to combine with following forward

// Per-chat queues: each chat has independent busy flag + queue
const chatQueues = new Map(); // chatId → { busy: bool, queue: [{prompt}] }

// Message aggregation: buffer messages arriving within 1.5s
const pendingMsgBuffer = new Map(); // chatId → { texts: [], timer }

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

async function enqueue(chatId, prompt) {
  const state = getChatQueue(chatId);
  if (!state.busy) {
    state.busy = true;
    try {
      await sendToClaude(chatId, prompt);
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
  state.queue.push({ prompt });
}

async function processQueue(chatId) {
  const state = getChatQueue(chatId);
  if (state.busy || state.queue.length === 0) return;
  const { prompt } = state.queue.shift();
  state.busy = true;
  try {
    await sendToClaude(chatId, prompt);
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

function splitMarkdown(text, limit = 4000) {
  const chunks = [];
  let rest = text;
  let inCodeBlock = false;
  let codeBlockLang = "";

  while (rest.length > 0) {
    if (rest.length <= limit) {
      chunks.push(rest);
      break;
    }

    // Find best split point: last newline before limit
    let splitAt = rest.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.5) splitAt = limit; // no good newline, hard cut

    let chunk = rest.slice(0, splitAt);

    // Track open code blocks in this chunk
    const fenceMatches = [...chunk.matchAll(/^```/gm)];
    const openFences = fenceMatches.length % 2 !== 0;

    if (openFences) {
      // Close the code block at end of chunk, reopen in next
      const lastFenceIdx = chunk.lastIndexOf("\n```");
      const lang = lastFenceIdx >= 0 ? "" : codeBlockLang;
      chunk = chunk + "\n```";
      codeBlockLang = lang;
      inCodeBlock = true;
    } else {
      inCodeBlock = false;
      codeBlockLang = "";
    }

    chunks.push(chunk);
    rest = rest.slice(splitAt).replace(/^\n/, "");
    if (inCodeBlock && rest.length > 0) {
      rest = "```" + (codeBlockLang || "") + "\n" + rest;
    }
  }

  return chunks;
}

async function sendMsg(chatId, text) {
  const chunks = splitMarkdown(text);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const res = await tg("sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: "Markdown",
    });
    if (!res.ok) {
      await tg("sendMessage", { chat_id: chatId, text: chunk });
    }
  }
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

function buildSessionList() {
  const sessions = listSessions(7);
  const { activeSessionId } = getActiveSession();

  if (sessions.length === 0) return { text: t("sessions.empty"), buttons: [] };

  let text = t("sessions.title");
  const buttons = [];

  for (const s of sessions) {
    const marker = s.isActive ? "▶️ " : "  ";
    const ago = formatAgo(s.modifiedAt);
    const name = s.displayName || s.lastMessage.slice(0, 40);
    const proj = s.projectName.split("/").pop();
    text += `${marker}<b>${esc(name)}</b>  <i>${proj} · ${ago}</i>\n`;

    const shortId = s.sessionId.slice(0, 8);
    const btnLabel = s.displayName || s.lastMessage.slice(0, 25);
    buttons.push([
      { text: `${s.isActive ? "▶️ " : ""}${btnLabel}`, callback_data: `ses:${shortId}` },
      { text: "🗑", callback_data: `del:${shortId}` },
    ]);
  }

  buttons.push([{ text: t("sessions.new_btn"), callback_data: "ses:new" }]);
  if (activeSessionId) {
    buttons.push([{ text: t("sessions.detach_btn"), callback_data: "ses:detach" }]);
  }

  return { text, buttons };
}

async function showSessions(chatId) {
  const { text, buttons } = buildSessionList();
  await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(buttons.length && { reply_markup: { inline_keyboard: buttons } }),
  });
}

async function editSessionList(chatId, messageId) {
  const { text, buttons } = buildSessionList();
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

async function sendSetupStep2(chatId) {
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
  const { activeSessionId } = getActiveSession();
  const sessions = listSessions(10);
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

function getGitCwd() {
  const state = getActiveSession();
  return getCustomCwd() || state.activeCwd || `${HOME}/develop`;
}

function gitExec(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", timeout: 15000, maxBuffer: 50 * 1024 }).trim();
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
    clearActiveSession("default");
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: t("sessions.new_btn") });
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: t("sessions.new_created"),
      parse_mode: "HTML",
    });
    return;
  }

  if (data === "ses:detach") {
    clearActiveSession("default");
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
    const sessions = listSessions(10);
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
      await sendSetupStep2(chatId);
      return;
    }
    if (step === "tokens") {
      const limit = parseInt(value, 10);
      setTokenRotationLimit(limit); // 0 = no rotation
      markSetupDone();
      const limitLabel = limit === 0 ? t("setup.tokens_unlimited") : `${Math.round(limit / 1000)}k`;
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `✅ ${limitLabel}` });
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: cb.message.message_id,
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
    const sessions = listSessions(10);
    const match = sessions.find((s) => s.sessionId.startsWith(shortId));

    if (match) {
      const matchCwd = getWorkingDir(match.projectDir);
      setActiveSession(match.sessionId, match.projectDir, matchCwd, "default");
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

  // /recent file download button
  if (data.startsWith("dl:")) {
    const filePath = data.slice(3);
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
}

// ── Send prompt to Claude ───────────────────────────────────────────

const TOOL_UPDATE_INTERVAL = 2000; // update tool progress every 2s

async function sendToClaude(chatId, prompt) {
  // Immediate typing indicator — user sees activity before Claude even starts
  tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

  const startTime = Date.now();
  let lastUpdateTime = 0;
  let lastActivityTime = startTime;
  let toolLines = [];
  let isWritingResponse = false;
  let streamMsgId = null;

  async function createOrUpdateStreamMsg(text) {
    if (!streamMsgId) {
      const res = await tg("sendMessage", { chat_id: chatId, text, disable_notification: true });
      streamMsgId = res?.result?.message_id || null;
    } else {
      lastUpdateTime = Date.now();
      tg("editMessageText", { chat_id: chatId, message_id: streamMsgId, text }).catch(() => {});
    }
  }

  let thinkingShown = false;

  // Show "Thinking..." after 1s, then refresh typing indicator every 4s
  setTimeout(() => {
    if (!thinkingShown && !isWritingResponse) {
      thinkingShown = true;
      createOrUpdateStreamMsg(t("status.thinking"));
    }
  }, 1000);

  const statusInterval = setInterval(() => {
    tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  }, 4000);

  const onEvent = (event) => {
    // Tool result — mark success/error on last tool line
    if (event.type === "result" && event.subtype === "tool_result") {
      // not available in stream-json, skip
    }

    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "tool_use") {
          isWritingResponse = false;
          lastActivityTime = Date.now();
          const input = block.input || {};
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

          const toolLine = `🔧 ${block.name}${detail ? ": " + detail : ""}`;
          toolLines.push(toolLine);
          if (toolLines.length > 6) toolLines = toolLines.slice(-6);
          console.log(toolLine);

          const now = Date.now();
          if (true && now - lastUpdateTime > TOOL_UPDATE_INTERVAL) {
            createOrUpdateStreamMsg(toolLines.join("\n"));
          }
        } else if (block.type === "text" && block.text && !isWritingResponse) {
          isWritingResponse = true;
          lastActivityTime = Date.now();
          if (true && toolLines.length > 0) {
            createOrUpdateStreamMsg(`${toolLines.join("\n")}\n\n${t("status.writing")}`);
          }
        }
      }
    }
  };

  const result = await runClaude(prompt, onEvent);
  clearInterval(statusInterval);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Auto-save session for continuity
  if (result.sessionId) {
    const projDir = result.projectDir || getActiveSession().activeProjectDir || "";
    const savedCwd = result.cwd || getActiveSession().activeCwd;
    setActiveSession(result.sessionId, projDir, savedCwd);
    if (pendingSessionName) {
      renameSession(result.sessionId, pendingSessionName);
      console.log(`📎 Session: ${result.sessionId.slice(0, 8)}… "${pendingSessionName}" cwd=${savedCwd}`);
      pendingSessionName = null;
    } else {
      console.log(`📎 Session: ${result.sessionId.slice(0, 8)}… cwd=${savedCwd}`);
    }
  }

  // Track tokens
  const sessionKey = result.sessionId || null;
  let tokenInfo = "";
  let shouldRotate = false;
  if (result.usage) {
    const inp = result.usage.input_tokens || 0;
    const out = result.usage.output_tokens || 0;
    addTokens(inp, out, sessionKey);
    const scopeTotal = getScopeTokens(sessionKey);
    const rotLimit = getTokenRotationLimit();
    const bar = rotLimit > 0 ? tokenProgressBar(scopeTotal, rotLimit) : `${formatK(scopeTotal)}`;
    tokenInfo = `\n\n_↓${formatK(inp)} ↑${formatK(out)} · ${elapsed}s · ${bar}_`;
    if (rotLimit > 0 && scopeTotal >= rotLimit) shouldRotate = true;
  } else {
    tokenInfo = `\n\n_${elapsed}s_`;
  }

  console.log(`${result.success ? "✅" : "❌"} done in ${elapsed}s exit=${result.exitCode} output=${result.output?.slice(0,200)}`);

  if (result.success && result.output === "(empty response)") {
    if (streamMsgId && toolLines.length > 0) {
      tg("editMessageText", { chat_id: chatId, message_id: streamMsgId, text: toolLines.join("\n") }).catch(() => {});
    } else if (streamMsgId) {
      await tg("deleteMessage", { chat_id: chatId, message_id: streamMsgId }).catch(() => {});
    }
    return;
  }

  if (streamMsgId) {
    if (toolLines.length > 0) {
      tg("editMessageText", { chat_id: chatId, message_id: streamMsgId, text: toolLines.join("\n") }).catch(() => {});
    } else {
      await tg("deleteMessage", { chat_id: chatId, message_id: streamMsgId }).catch(() => {});
    }
  }

  if (!result.success) {
    // Distinct error notification — stands out from normal responses
    await tg("sendMessage", {
      chat_id: chatId,
      text: `❌ <b>Error</b> (exit ${result.exitCode})\n\n<code>${esc(result.output.slice(0, 3000))}</code>`,
      parse_mode: "HTML",
    });
    return;
  }

  await sendMsg(chatId, result.output + tokenInfo);

  // Auto-rotate session when token limit reached
  if (shouldRotate) {
    console.log("🔄 Token limit reached, rotating session...");
    tg("sendMessage", { chat_id: chatId, text: t("rotation.limit", { limit: formatK(getTokenRotationLimit()) }), disable_notification: true }).catch(() => {});
    try {
      const summaryResult = await runClaude(
        t("rotation.summarize"),
        () => {}
      );
      const summary = summaryResult.output || t("cmd.no_data");
      clearActiveSession();
      resetScopeTokens(sessionKey);
      await enqueue(chatId, t("rotation.continue", { summary }));
    } catch (err) {
      console.error("Session rotation error:", err.message);
      clearActiveSession();
      resetScopeTokens(sessionKey);
    }
  }
}

// ── Message handler ─────────────────────────────────────────────────

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);

  // Owner-only bot
  if (chatId !== OWNER_CHAT_ID) return;

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
      await enqueue(chatId, `${fwdBlock}\n\n${userComment}`);
    } else {
      await enqueue(chatId, fwdBlock);
    }
    return;
  }

  // Photo
  if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1]; // largest size
    const caption = msg.caption || t("fwd.describe_photo");
    try {
      const localPath = await downloadTgFile(photo.file_id, ".jpg");
      if (!localPath) {
        await tg("sendMessage", { chat_id: chatId, text: t("error.photo_download") });
        return;
      }
      await enqueue(chatId, t("fwd.look_at_image", { path: localPath, caption }));
      setTimeout(() => { try { unlinkSync(localPath); } catch {} }, 120000);
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
      await enqueue(chatId, enqueueMsg);
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
      await enqueue(chatId, text);
    } catch (err) {
      if (recMsgId) await tg("deleteMessage", { chat_id: chatId, message_id: recMsgId });
      console.error("Voice error:", err.message);
      await tg("sendMessage", { chat_id: chatId, text: t("error.voice_error", { msg: err.message }) });
    }
    return;
  }

  let text = msg.text;
  if (!text) return;

  // Strip @botname from commands in groups (e.g. /sessions@andrey_claudeAi_bot → /sessions)
  if (botUsername && text.startsWith("/")) {
    text = text.replace(new RegExp(`@${botUsername}\\b`, "i"), "");
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
  if (text === "/stop") {
    if (killActiveChild()) {
      getChatQueue(chatId).busy = false;
      await tg("sendMessage", { chat_id: chatId, text: t("cmd.stopped") });
    } else {
      await tg("sendMessage", { chat_id: chatId, text: t("cmd.nothing_running") });
    }
    return;
  }
  if (text === "/detach") {
    clearActiveSession("default");
    await tg("sendMessage", { chat_id: chatId, text: t("sessions.detached") });
    return;
  }
  if (text.startsWith("/new")) {
    const name = text.slice(4).trim();
    clearActiveSession("default");
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
    const { activeSessionId } = getActiveSession("default");
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
    const { activeSessionId } = getActiveSession();
    const scopeTotal = getScopeTokens(activeSessionId);
    const sessionName = activeSessionId
      ? (getSessionName(activeSessionId) || activeSessionId.slice(0, 8) + "…")
      : t("status.no_session");
    const cwd = getCustomCwd() || getActiveSession().activeCwd || HOME;
    const mode = getOutputMode();
    const model = getModel();
    const rotLimit = getTokenRotationLimit();
    const bar = rotLimit > 0 ? tokenProgressBar(scopeTotal, rotLimit) : `${formatK(scopeTotal)} (∞)`;
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
      execSync(
        `node -e "
          const puppeteer = require('puppeteer');
          (async () => {
            const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 800 });
            await page.goto('${url.replace(/'/g, "\\'")}', { waitUntil: 'networkidle2', timeout: 15000 });
            await page.screenshot({ path: '${screenshotPath}', fullPage: false });
            await browser.close();
          })();
        "`,
        { timeout: 30000, cwd: __dirname }
      );
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
      const out = gitExec(`git ${arg}`, cwd);
      await sendMsg(chatId, `\`\`\`\n${out.slice(0, 3800)}\n\`\`\``);
    }
    return;
  }
  // ── Direct shell ──
  if (text.startsWith("/sh ")) {
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
    const raw = gitExec(`git diff ${gitArg}`, cwd) || gitExec("git diff --cached", cwd) || "";
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
  if (planMode) finalPrompt = t("plan.prefix", { prompt: finalPrompt });

  // Aggregate messages arriving within 1.5s (combine instead of replace)
  const existing = pendingDMText[chatId];
  if (existing) {
    clearTimeout(existing.timer);
    finalPrompt = existing.prompt + "\n\n" + finalPrompt;
  }
  const timer = setTimeout(() => {
    delete pendingDMText[chatId];
    enqueue(chatId, finalPrompt);
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
      // Kill ALL previous instances (not just PID file)
      try {
        const myPid = String(process.pid);
        const pids = execSync("pgrep -f 'node index.mjs'", { encoding: "utf-8" }).trim().split("\n").filter(p => p && p !== myPid);
        if (pids.length) {
          execSync(`kill -9 ${pids.join(" ")} 2>/dev/null || true`);
          console.log(`☠️ Killed ${pids.length} previous instance(s)`);
        }
      } catch {}

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

const SLEEP_IDLE_MS = 30 * 60 * 1000;    // 30 min idle → ask
const SLEEP_CONFIRM_MS = 10 * 60 * 1000; // 10 min no answer → sleep

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

    // If we already sent the prompt, check if 10 min passed without response
    if (sleepPromptSentAt !== null) {
      // If user touched keyboard/mouse since we asked — cancel silently
      const idle = getSystemIdleMs();
      if (idle >= 0 && idle < SLEEP_IDLE_MS) {
        sleepPromptSentAt = null;
        return;
      }
      if (now - sleepPromptSentAt >= SLEEP_CONFIRM_MS) {
        sleepPromptSentAt = null;
        tg("sendMessage", { chat_id: OWNER_CHAT_ID, text: t("sleep.no_response") })
          .finally(doSleep);
      }
      return;
    }

    // Check real system idle — keyboard, mouse, trackpad
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

init().then(() => {
  poll();
  startAutoSleepWatcher();
});

process.on("SIGINT", () => { running = false; cleanupPid(); process.exit(0); });
process.on("SIGTERM", () => { running = false; cleanupPid(); process.exit(0); });
process.on("exit", cleanupPid);
