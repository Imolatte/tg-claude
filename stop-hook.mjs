#!/usr/bin/env node

/**
 * Claude Code Stop Hook — sends a done notification to Telegram.
 * Fires when Claude finishes a turn (only for terminal sessions, not bot).
 */

import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Clean up pending approval marker — session is done
try { unlinkSync("/tmp/claude-tg-pending-approval"); } catch {}

// Skip if this is a bot-initiated session (bot handles its own messaging)
if (process.env.CLAUDE_SOURCE === "telegram") process.exit(0);

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf-8"));
const BOT_TOKEN = config.botToken;
const CHAT_ID = config.chatId;

// Rate-limit: don't spam if Claude is doing many quick turns
const LAST_NOTIFIED_FILE = "/tmp/claude-stop-notified-ts";
const MIN_INTERVAL_MS = 5000;

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function main() {
  let input;
  try {
    const raw = readFileSync("/dev/stdin", "utf-8");
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  // Only notify if Claude actually did work (not just a quick no-op)
  const stopReason = input.stop_reason || input.stop_hook_active;
  if (!stopReason) process.exit(0);

  // Rate limit
  try {
    const last = parseInt(readFileSync(LAST_NOTIFIED_FILE, "utf-8"), 10);
    if (Date.now() - last < MIN_INTERVAL_MS) process.exit(0);
  } catch {}
  writeFileSync(LAST_NOTIFIED_FILE, String(Date.now()));

  // Extract last assistant text from transcript
  const messages = input.messages || [];
  let lastText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      const content = Array.isArray(m.content) ? m.content : [];
      for (const block of content) {
        if (block.type === "text" && block.text?.trim()) {
          lastText = block.text.trim();
          break;
        }
      }
      if (lastText) break;
    }
  }

  // Trim to reasonable length
  const preview = lastText.length > 600
    ? lastText.slice(0, 600) + "…"
    : lastText;

  if (!preview) process.exit(0);

  // Skip trivial Q/A (short reply + no error keywords) to reduce TG spam
  const errorKeywords = /error|failed|не удалось|ошибка|crash|traceback|exception/i;
  const hasError = errorKeywords.test(preview);
  if (preview.length < 400 && !hasError) process.exit(0);

  const icon = hasError ? "⚠️" : "✅";
  const label = hasError ? "Issue" : "Done";
  const text = `${icon} <b>${label}</b>\n\n${esc(preview)}`;

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_notification: true,
    }),
  }).catch(() => {});
}

main().catch(() => process.exit(0));
