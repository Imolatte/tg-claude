#!/usr/bin/env node

/**
 * Claude Code PreToolUse Hook — Dual-Channel Approval
 *
 * CLAUDE_SOURCE=telegram → approval via Telegram inline buttons
 * hybrid mode             → approval via Telegram inline buttons
 * terminal mode           → no decision (Claude Code's built-in prompt handles it)
 * Safe ops                → auto-approve always
 *
 * In terminal mode, also sends typing/working indicators to Telegram
 * so the user knows Claude is active even when away from the desk.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { execSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { t, loadLang, getLang } from "./worker/locale.mjs";

loadLang();

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf-8"));

const BOT_TOKEN = config.botToken;
const CHAT_ID = config.chatId;
const TIMEOUT_MS = parseInt(config.timeoutMs || "0", 10);
const MODE_FILE = "/tmp/claude-output-channel";
const PID_FILE = "/tmp/claude-tg-worker.pid";
const TYPING_TS_FILE = "/tmp/claude-tg-typing-ts";
const WORKING_NOTIFIED_FILE = "/tmp/claude-tg-working-notified";
const REQUEST_META_FILE = "/tmp/claude-request-meta.json";

// Mode: "terminal" | "hybrid" | "telegram"
// CLAUDE_SOURCE=telegram → bot spawned this, always approve via TG
// No CLAUDE_SOURCE → user is in terminal, always use Claude's built-in prompt
function getMode() {
  if (process.env.CLAUDE_SOURCE === "telegram") return "telegram";
  return "terminal";
}

function useTgApproval() {
  const mode = getMode();
  return mode === "hybrid" || mode === "telegram";
}

const AUTO_ALLOW = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason: "Auto-approved (not dangerous)",
  },
});

function makeDecision(approved, reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: approved ? "allow" : "deny",
      permissionDecisionReason: reason,
    },
  });
}

// ── Classification ──────────────────────────────────────────────────

const DANGEROUS_COMMANDS = [
  "git push", "git reset", "git rebase", "git merge", "git checkout --",
  "git clean", "git branch -D", "git branch -d",
  "rm ", "rm -rf", "rm -r", "docker rm", "docker stop", "docker system prune",
  "npx prisma migrate deploy", "npx prisma db push", "npx prisma migrate reset",
  "drop table", "drop database", "truncate",
  "vercel --prod", "npm publish",
];

const SENSITIVE_FILES = [
  /\.env/, /docker-compose/, /Dockerfile/, /\.github\//,
  /prisma\/migrations/, /package\.json$/, /tsconfig.*\.json$/,
  /next\.config/, /vercel\.json/, /\.npmrc/, /\.gitignore$/,
];

function classify(toolName, toolInput) {
  if (toolName === "Bash") {
    const cmd = toolInput.command || "";
    if (DANGEROUS_COMMANDS.some((dc) => cmd.includes(dc))) return "danger";
  }
  if (toolName === "Write" || toolName === "Edit") {
    const path = toolInput.file_path || "";
    if (SENSITIVE_FILES.some((p) => p.test(path))) return "danger";
  }
  return "safe";
}

function getDetail(toolName, toolInput) {
  if (toolName === "Bash") return toolInput.command || "";
  if (toolName === "Write" || toolName === "Edit") return toolInput.file_path || "";
  return JSON.stringify(toolInput).slice(0, 300);
}

// ── Telegram helpers ────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── File-based poll (worker catches callback, writes result) ────────

function resultPath(id) { return join("/tmp", `claude-approval-${id}.result`); }

function pollFile(id, signal) {
  return new Promise((resolve) => {
    const check = () => {
      if (signal.aborted) return resolve(null);
      try {
        const path = resultPath(id);
        if (existsSync(path)) {
          const data = JSON.parse(readFileSync(path, "utf-8"));
          resolve(data.decision);
          return;
        }
      } catch {}
      setTimeout(check, 500);
    };
    check();
  });
}

// ── Direct TG polling (fallback when worker is NOT running) ─────────

function isWorkerRunning() {
  try {
    if (!existsSync(PID_FILE)) return false;
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pollTelegram(opId, signal) {
  let pollOffset = 0;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=-1&timeout=0`
    );
    const data = await res.json();
    if (data.ok && data.result.length > 0) {
      pollOffset = data.result[data.result.length - 1].update_id + 1;
    }
  } catch {}

  while (!signal.aborted) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${pollOffset}&timeout=5&allowed_updates=["callback_query"]`
      );
      const data = await res.json();
      if (data.ok) {
        for (const update of data.result) {
          pollOffset = update.update_id + 1;
          const cb = update.callback_query;
          if (!cb?.data) continue;
          if (cb.data === `op:${opId}:allow` || cb.data === `op:${opId}:deny`) {
            const decision = cb.data.endsWith(":allow") ? "allow" : "deny";
            await tg("answerCallbackQuery", {
              callback_query_id: cb.id,
              text: decision === "allow" ? `✅ ${t("approval.approved")}` : `❌ ${t("approval.denied")}`,
            });
            return decision;
          }
        }
      }
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

// ── Telegram approval ───────────────────────────────────────────────

async function requestTelegramApproval(toolName, detail, description) {
  const opId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const lines = [
    `🔴 <b>${t("approval.dangerous_op")}</b>`,
    ``,
    `<b>${t("approval.what")}</b> ${esc(toolName)}`,
    `<code>${esc(detail.slice(0, 500))}</code>`,
  ];
  if (description) lines.push(``, `<b>${t("approval.why")}</b> <i>${esc(description)}</i>`);
  lines.push(``, `⚠️ <i>${t("approval.irreversible")}</i>`);

  const msgRes = await tg("sendMessage", {
    chat_id: CHAT_ID,
    text: lines.join("\n"),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: t("approval.yes_btn"), callback_data: `op:${opId}:allow` },
        { text: t("approval.no_btn"), callback_data: `op:${opId}:deny` },
      ]],
    },
  });
  const tgMsgId = msgRes?.result?.message_id;
  const origText = lines.join("\n");

  const ac = new AbortController();
  const { signal } = ac;
  const workerRunning = isWorkerRunning();

  const tgPoll = workerRunning
    ? pollFile(opId, signal)
    : pollTelegram(opId, signal);

  const decision = TIMEOUT_MS > 0
    ? await Promise.race([tgPoll, new Promise((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS))])
    : await tgPoll;
  ac.abort();

  try { unlinkSync(resultPath(opId)); } catch {}

  const approved = decision === "allow";
  const emoji = approved ? "✅" : "❌";
  const status = approved ? t("approval.approved") : decision === "deny" ? t("approval.denied") : t("approval.timeout");

  if (tgMsgId) {
    await tg("editMessageText", {
      chat_id: CHAT_ID,
      message_id: tgMsgId,
      text: `${origText}\n\n${emoji} <b>${status}</b>`,
      parse_mode: "HTML",
    });
  }

  return approved;
}

// ── Activity indicators for terminal mode ───────────────────────────

// Send typing action to TG (rate-limited: max once per 8s)
function sendTypingIndicator() {
  try {
    const now = Date.now();
    let last = 0;
    try { last = parseInt(readFileSync(TYPING_TS_FILE, "utf-8"), 10); } catch {}
    if (now - last < 8000) return;
    writeFileSync(TYPING_TS_FILE, String(now));
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, action: "typing" }),
    }).catch(() => {});
  } catch {}
}

// One-time "started working" notification per Claude invocation
function sendWorkingNotification(toolName) {
  try {
    const ppid = String(process.ppid);
    let lastPpid = "";
    try { lastPpid = readFileSync(WORKING_NOTIFIED_FILE, "utf-8").trim(); } catch {}
    if (lastPpid === ppid) return;
    writeFileSync(WORKING_NOTIFIED_FILE, ppid);
    const lang = getLang();
    const msg = lang === "ru"
      ? `⚙️ Работаю... (<code>${esc(toolName)}</code>)`
      : `⚙️ Working... (<code>${esc(toolName)}</code>)`;
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: "HTML", disable_notification: true }),
    }).catch(() => {});
  } catch {}
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync("/dev/stdin", "utf-8"));
  } catch {
    process.stdout.write(AUTO_ALLOW);
    process.exit(0);
  }

  const toolName = input.tool_name || "";
  const toolInput = input.tool_input || {};

  // Clean up pending approval marker — if we're here, previous approval was answered
  try { unlinkSync("/tmp/claude-tg-pending-approval"); } catch {}

  // For terminal Claude: send activity indicators to TG so user knows work is happening
  if (process.env.CLAUDE_SOURCE !== "telegram") {
    sendTypingIndicator();
    sendWorkingNotification(toolName);
  }

  // If about to sleep — write flag so bot knows the interruption is intentional
  if (toolName === "Bash" && (toolInput.command || "").includes("pmset sleepnow")) {
    try { writeFileSync("/tmp/claude-intentional-sleep", "1"); } catch {}
  }

  if (classify(toolName, toolInput) === "safe") {
    process.stdout.write(AUTO_ALLOW);
    process.exit(0);
  }

  // Group request from non-owner: deny dangerous op, notify owner in DM
  if (classify(toolName, toolInput) === "danger") {
    try {
      if (existsSync(REQUEST_META_FILE)) {
        const meta = JSON.parse(readFileSync(REQUEST_META_FILE, "utf-8"));
        if (meta.isGroup && !meta.isOwner) {
          // Notify owner
          const lang = getLang();
          const msg = lang === "ru"
            ? `⚠️ <b>Опасная операция заблокирована</b>\n\nПользователь <code>${esc(meta.initiatorUserId)}</code> попытался выполнить:\n<b>${esc(toolName)}</b>\n<code>${esc(getDetail(toolName, toolInput).slice(0, 300))}</code>\n\n<i>Задача пропущена — только ты можешь одобрять опасные операции.</i>`
            : `⚠️ <b>Dangerous op blocked</b>\n\nUser <code>${esc(meta.initiatorUserId)}</code> tried to run:\n<b>${esc(toolName)}</b>\n<code>${esc(getDetail(toolName, toolInput).slice(0, 300))}</code>\n\n<i>Task skipped — only you can approve dangerous operations.</i>`;
          fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: "HTML" }),
          }).catch(() => {});
          process.stdout.write(makeDecision(false, "Dangerous ops from group require owner approval"));
          process.exit(0);
        }
      }
    } catch {}
  }

  // Terminal mode → Claude Code shows its prompt (1/2/3)
  // If unanswered for 5 min → worker sends TG buttons → user approves from phone
  // → worker writes keystroke to terminal TTY → prompt resolves
  if (!useTgApproval()) {
    const detail = getDetail(toolName, toolInput);
    const opId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Discover terminal TTY for remote approval
    let ttyPath = null;
    try {
      const ttyRaw = execSync(`ps -p ${process.ppid} -o tty= 2>/dev/null`).toString().trim();
      if (ttyRaw && ttyRaw !== "??") ttyPath = `/dev/tty${ttyRaw}`;
    } catch {}

    // Write marker file — worker watches it and sends TG buttons after 5 min
    writeFileSync("/tmp/claude-tg-pending-approval", JSON.stringify({
      toolName, detail: detail.slice(0, 300), ts: Date.now(), opId, ttyPath,
    }));

    // Exit with no decision → terminal prompt shows as usual
    process.exit(0);
  }

  // Telegram/hybrid mode → block and wait for TG buttons (existing flow)
  const detail = getDetail(toolName, toolInput);
  const description = toolInput.description || "";
  const approved = await requestTelegramApproval(toolName, detail, description);

  process.stdout.write(makeDecision(approved, approved ? "Approved via Telegram" : "Denied via Telegram"));
  process.exit(0);
}

main().catch(() => {
  process.stdout.write(AUTO_ALLOW);
  process.exit(0);
});
