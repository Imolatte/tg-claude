import { spawn, execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { getActiveSession, getModel, getCustomCwd, clearActiveSession, getLatestSessionForProject, isSessionPinned, getSessionName, getLastUserMessageForSession } from "./sessions.mjs";

/**
 * Check if there's a newer session for this chat's project.
 * Returns { currentName, newerSessionId, newerName } or null.
 */
export function checkNewerSession(chatId = "default") {
  if (isSessionPinned(chatId)) return null;
  const { activeSessionId, activeProjectDir, activeCwd } = getActiveSession(chatId);
  const cwd = getCustomCwd() || activeCwd;
  const projectDir = activeProjectDir || (cwd ? cwd.replace(/\//g, "-") : null);
  if (!projectDir) return null;

  const latestId = getLatestSessionForProject(projectDir);
  if (!latestId || latestId === activeSessionId) return null;

  return {
    currentSessionId: activeSessionId,
    currentName: (activeSessionId && (getSessionName(activeSessionId) || getLastUserMessageForSession(activeSessionId, projectDir))) || "(нет сессии)",
    newerSessionId: latestId,
    newerName: getSessionName(latestId) || getLastUserMessageForSession(latestId, projectDir),
    projectDir,
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
let _configTimeout = 300000; // 5 min default
let _ownerChatId = null;
try {
  const cfg = JSON.parse(readFileSync(join(__dirname, "..", "config.json"), "utf-8"));
  if (cfg.claudeTimeoutMs) _configTimeout = cfg.claudeTimeoutMs;
  if (cfg.chatId) _ownerChatId = String(cfg.chatId);
} catch {}
const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT || String(_configTimeout), 10);
const DEFAULT_CWD = process.env.DEFAULT_CWD || homedir();

// Find claude binary via PATH
function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try { return execSync("which claude", { encoding: "utf-8" }).trim(); } catch {}
  return "claude";
}
const CLAUDE_BIN = findClaude();

const SYSTEM_PROMPT_FILE = join(__dirname, "..", "bot-system-prompt.md");
const MCP_TELEGRAM_PATH = join(__dirname, "mcp-telegram.mjs");
const MCP_CONFIG_FILE = join(__dirname, "..", "mcp-config.json");

// Ensure mcp-config.json has absolute path to MCP server
try {
  const mcpConfig = { mcpServers: { telegram: { command: "node", args: [MCP_TELEGRAM_PATH] } } };
  writeFileSync(MCP_CONFIG_FILE, JSON.stringify(mcpConfig, null, 2));
} catch {}

const activeChildren = new Map(); // chatId → child process

export function killActiveChild(chatId = "default") {
  const child = activeChildren.get(chatId);
  if (child) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    try { child.kill("SIGKILL"); } catch {}
    activeChildren.delete(chatId);
    return true;
  }
  return false;
}

function spawnClaude(prompt, onEvent, { sessionId: resumeId, cwd, chatId = "default" } = {}) {
  return new Promise((resolve) => {
    const model = getModel();

    let systemPrompt;
    try { systemPrompt = readFileSync(SYSTEM_PROMPT_FILE, "utf-8").trim(); } catch {}

    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--model", model,
      "--mcp-config", MCP_CONFIG_FILE,
      "--disable-slash-commands",
    ];

    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    if (resumeId) args.push("--resume", resumeId);
    args.push(prompt);

    const child = spawn(CLAUDE_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CLAUDE_TIMEOUT,
      detached: true,
      ...(cwd && { cwd }),
      env: { ...process.env, CLAUDE_SOURCE: "telegram", CLAUDECODE: "" },
    });

    activeChildren.set(chatId, child);

    let resultText = "";
    let sessionId = null;
    let projectDir = null;
    let eventCwd = null;
    let usage = null;
    let costUsd = 0;
    let stderr = "";
    let buffer = "";

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          if (event.type === "system") {
            if (event.session_id) sessionId = event.session_id;
            if (event.cwd) {
              eventCwd = event.cwd;
              projectDir = event.cwd.replace(/\//g, "-");
            }
          }

          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text") resultText = block.text;
            }
          }

          if (event.type === "result") {
            if (event.result && typeof event.result === "string") resultText = event.result;
            if (event.session_id) sessionId = event.session_id;
            if (event.usage) usage = event.usage;
            if (event.total_cost_usd) costUsd = event.total_cost_usd;
          }

          if (onEvent) onEvent(event);
        } catch {}
      }
    });

    child.stderr.on("data", (d) => { stderr += d; });

    child.on("error", (err) => {
      activeChildren.delete(chatId);
      resolve({ success: false, output: err.message, exitCode: -1 });
    });

    child.on("close", (code) => {
      activeChildren.delete(chatId);

      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === "result") {
            if (event.result && typeof event.result === "string") resultText = event.result;
            if (event.session_id) sessionId = event.session_id;
            if (event.usage) usage = event.usage;
            if (event.total_cost_usd) costUsd = event.total_cost_usd;
          }
          if (event.type === "system" && event.session_id) sessionId = event.session_id;
          if (onEvent) onEvent(event);
        } catch {}
      }

      if (!projectDir && cwd) projectDir = cwd.replace(/\//g, "-");

      const output = code !== 0
        ? (stderr.trim() || resultText.trim() || `Exit code ${code}`)
        : (resultText.trim() || "(empty response)");

      resolve({ success: code === 0, output, sessionId, projectDir, cwd: eventCwd, usage, costUsd, exitCode: code });
    });

    setTimeout(() => {
      activeChildren.delete(chatId);
      try { child.kill(); } catch {}
      resolve({ success: false, output: "Timeout", exitCode: -1 });
    }, CLAUDE_TIMEOUT);
  });
}

/**
 * Run Claude. If --resume fails, retry without it (stale session).
 */
export async function runClaude(prompt, onEvent, chatId = "default") {
  let { activeSessionId, activeProjectDir, activeCwd } = getActiveSession(chatId);

  // No session fallback to owner DM — each chat gets its own isolated session

  const cwd = getCustomCwd() || activeCwd || DEFAULT_CWD;

  console.log(`🚀 runClaude chat=${chatId} session=${activeSessionId?.slice(0,8) || "none"} cwd=${cwd} prompt=${prompt.slice(0,60)}`);
  const result = await spawnClaude(prompt, onEvent, { sessionId: activeSessionId, cwd, chatId });
  console.log(`🏁 runClaude done exit=${result.exitCode} success=${result.success}`);

  // If resume failed — retry as new session
  if (!result.success && activeSessionId && result.exitCode === 1) {
    console.log("⚠️ Resume failed, retrying as new session…");
    clearActiveSession(chatId);
    return spawnClaude(prompt, onEvent, { cwd, chatId });
  }

  return result;
}
