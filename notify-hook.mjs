#!/usr/bin/env node

/**
 * Claude Code Stop Hook — Telegram Notification
 *
 * Sends notification when Claude finishes, based on output mode:
 *   terminal  → no TG notification
 *   hybrid    → notify TG that task is done
 *   telegram  → full response to TG
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { t, loadLang } from "./worker/locale.mjs";

loadLang();

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf-8"));

const { botToken, chatId } = config;
const API = `https://api.telegram.org/bot${botToken}`;
const MODE_FILE = "/tmp/claude-output-channel";

function getMode() {
  if (process.env.CLAUDE_SOURCE === "telegram") return "telegram";
  try { return readFileSync(MODE_FILE, "utf-8").trim(); }
  catch { return "terminal"; }
}

async function sendTg(text) {
  await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

async function main() {
  const mode = getMode();
  if (mode === "terminal") process.exit(0);

  let input;
  try {
    input = JSON.parse(readFileSync("/dev/stdin", "utf-8"));
  } catch {
    process.exit(0);
  }

  const stopReason = input.stop_hook_reason || "unknown";
  const transcript = input.transcript_summary || "";

  if (mode === "hybrid") {
    // Just notify that task is done
    await sendTg(`🏁 <b>${t("hook.task_done")}</b>\n<i>${stopReason}</i>`);
  } else {
    // Full output to TG
    const text = [
      `🏁 <b>${t("hook.task_done")}</b>`,
      ``,
      `<b>${t("hook.reason")}</b> ${stopReason}`,
      transcript ? `\n<code>${transcript.slice(0, 3500)}</code>` : "",
    ].filter(Boolean).join("\n");
    await sendTg(text);
  }
}

main().catch(() => process.exit(0));
