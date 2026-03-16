#!/usr/bin/env node

/**
 * Claude Code PreToolUse Hook — Dual-Channel Approval
 *
 * CLAUDE_SOURCE=telegram → approval via Telegram inline buttons
 * terminal mode          → prompt on /dev/tty with 5-min auto-switch to hybrid
 * hybrid/telegram mode   → approval via Telegram inline buttons
 * Safe ops               → auto-approve always
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, createReadStream, createWriteStream } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { t, loadLang, getLang } from "./worker/locale.mjs";

loadLang();

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf-8"));

const BOT_TOKEN = config.botToken;
const CHAT_ID = config.chatId;
const TIMEOUT_MS = parseInt(config.timeoutMs || "300000", 10);
const TTY_TIMEOUT_MS = 5 * 60 * 1000; // 5 min before auto-switch to TG
const MODE_FILE = "/tmp/claude-output-channel";
const PID_FILE = "/tmp/claude-tg-worker.pid";
const TYPING_TS_FILE = "/tmp/claude-tg-typing-ts";
const WORKING_NOTIFIED_FILE = "/tmp/claude-tg-working-notified";

// Mode: "terminal" | "hybrid" | "telegram"
function getMode() {
  if (process.env.CLAUDE_SOURCE === "telegram") return "telegram";
  try { return readFileSync(MODE_FILE, "utf-8").trim(); }
  catch { return "terminal"; }
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
  "rm -rf", "rm -r", "docker rm", "docker stop", "docker system prune",
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

async function requestTelegramApproval(toolName, detail, description, extraHeader) {
  const opId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const lines = [
    ...(extraHeader ? [extraHeader, ``] : []),
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

  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve(null), TIMEOUT_MS)
  );

  const decision = await Promise.race([tgPoll, timeout]);
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

// Send typing action (rate-limited: max once per 8s)
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
// Tracked by PPID so each new claude process sends it once
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

// ── Terminal approval with auto-switch ──────────────────────────────

function requestTerminalApproval(toolName, detail, description) {
  return new Promise((resolve) => {
    let ttyOut, ttyIn;

    try {
      ttyOut = createWriteStream("/dev/tty");
    } catch {
      return resolve(null); // No tty available
    }

    const mins = Math.round(TTY_TIMEOUT_MS / 60000);
    const lines = [
      ``,
      `🔴  DANGEROUS: ${toolName}`,
      `   ${detail.slice(0, 200)}`,
      ...(description ? [`   Why: ${description}`] : []),
      `   [y/N] (auto → Telegram in ${mins} min): `,
    ];
    ttyOut.write(lines.join("\n"));

    try {
      ttyIn = createReadStream("/dev/tty");
    } catch {
      ttyOut.end();
      return resolve(null);
    }

    let answered = false;
    let data = "";

    const finish = (decision) => {
      if (answered) return;
      answered = true;
      try { ttyIn.destroy(); } catch {}
      try { ttyOut.write("\n"); ttyOut.end(); } catch {}
      resolve(decision);
    };

    ttyIn.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("\n")) {
        const answer = data.trim().toLowerCase();
        finish(answer === "y" || answer === "yes" ? "allow" : "deny");
      }
    });

    ttyIn.on("error", () => finish(null));

    setTimeout(() => finish(null), TTY_TIMEOUT_MS);
  });
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

  // For terminal Claude: send activity indicators to TG so user knows work is happening
  if (process.env.CLAUDE_SOURCE !== "telegram") {
    sendTypingIndicator();
    sendWorkingNotification(toolName);
  }

  if (classify(toolName, toolInput) === "safe") {
    process.stdout.write(AUTO_ALLOW);
    process.exit(0);
  }

  const detail = getDetail(toolName, toolInput);
  const description = toolInput.description || "";

  // Hybrid/Telegram mode → ask via TG directly
  if (useTgApproval()) {
    const approved = await requestTelegramApproval(toolName, detail, description);
    process.stdout.write(makeDecision(approved, approved ? "Approved via Telegram" : "Denied via Telegram"));
    process.exit(0);
  }

  // Terminal mode → show prompt with auto-switch after 5 min
  const terminalDecision = await requestTerminalApproval(toolName, detail, description);

  if (terminalDecision !== null) {
    // User answered in terminal
    process.stdout.write(makeDecision(
      terminalDecision === "allow",
      terminalDecision === "allow" ? "Approved via terminal" : "Denied via terminal"
    ));
    process.exit(0);
  }

  // Timeout — auto-switch to hybrid and forward to Telegram
  try { writeFileSync(MODE_FILE, "hybrid"); } catch {}

  const approved = await requestTelegramApproval(
    toolName, detail, description,
    `⚡️ <b>Auto-switched to hybrid mode</b> (no terminal response for ${Math.round(TTY_TIMEOUT_MS / 60000)} min)\n<i>/mode terminal to switch back</i>`
  );

  process.stdout.write(makeDecision(approved, approved ? "Approved via Telegram (auto-switch)" : "Denied via Telegram (auto-switch)"));
  process.exit(0);
}

main().catch(() => {
  process.stdout.write(AUTO_ALLOW);
  process.exit(0);
});
