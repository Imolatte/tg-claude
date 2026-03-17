import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const CLAUDE_PROJECTS_DIR = join(HOME, ".claude", "projects");
const STATE_FILE = join(__dirname, "state.json");

// ── State ───────────────────────────────────────────────────────────

const VALID_MODELS = ["sonnet", "opus", "haiku"];

function getState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")); }
  catch { return { activeSessionId: null, activeProjectDir: null, sessionNames: {}, model: "sonnet" }; }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export function getActiveSession() {
  return getState();
}

export function setActiveSession(sessionId, projectDir, cwd) {
  const state = getState();
  state.activeSessionId = sessionId;
  state.activeProjectDir = projectDir;
  if (cwd) state.activeCwd = cwd;
  saveState(state);
}

export function clearActiveSession() {
  const state = getState();
  state.activeSessionId = null;
  state.activeProjectDir = null;
  state.activeCwd = null;
  saveState(state);
}

export function renameSession(sessionId, name) {
  const state = getState();
  if (!state.sessionNames) state.sessionNames = {};
  state.sessionNames[sessionId] = name;
  saveState(state);
}

export function getSessionName(sessionId) {
  const state = getState();
  return state.sessionNames?.[sessionId] || null;
}

export function getModel() {
  return getState().model || "sonnet";
}

export function getCustomCwd() {
  return getState().customCwd || null;
}

export function setCustomCwd(dir) {
  const state = getState();
  state.customCwd = dir || null;
  saveState(state);
}

export function addTokens(input, output, sessionId) {
  const state = getState();
  if (!state.tokens) state.tokens = { input: 0, output: 0 };
  state.tokens.input += input;
  state.tokens.output += output;
  if (!state.scopeTokens) state.scopeTokens = {};
  const key = sessionId || "default";
  if (!state.scopeTokens[key]) state.scopeTokens[key] = 0;
  state.scopeTokens[key] += input + output;
  saveState(state);
}

export function getTokens() {
  const state = getState();
  return state.tokens || { input: 0, output: 0 };
}

export function getScopeTokens(sessionId) {
  const state = getState();
  const key = sessionId || "default";
  return state.scopeTokens?.[key] || 0;
}

export function resetScopeTokens(sessionId) {
  const state = getState();
  if (!state.scopeTokens) state.scopeTokens = {};
  const key = sessionId || "default";
  state.scopeTokens[key] = 0;
  saveState(state);
}

export function resetTokens() {
  const state = getState();
  state.tokens = { input: 0, output: 0 };
  state.scopeTokens = {};
  saveState(state);
}

export function setModel(model) {
  if (!VALID_MODELS.includes(model)) return false;
  const state = getState();
  state.model = model;
  saveState(state);
  return true;
}

export function getTokenRotationLimit() {
  const state = getState();
  return state.tokenRotationLimit || 100000;
}

export function setTokenRotationLimit(limit) {
  const state = getState();
  state.tokenRotationLimit = limit;
  saveState(state);
}

export function getOs() {
  return getState().os || "mac";
}

export function setOs(os) {
  const state = getState();
  state.os = os;
  saveState(state);
}

export function isSetupDone() {
  return !!getState().setupDone;
}

export function markSetupDone() {
  const state = getState();
  state.setupDone = true;
  saveState(state);
}

export function deleteSession(sessionId, projectDir) {
  const state = getState();
  try {
    const filePath = join(CLAUDE_PROJECTS_DIR, projectDir, `${sessionId}.jsonl`);
    unlinkSync(filePath);
  } catch {}
  if (state.sessionNames?.[sessionId]) {
    delete state.sessionNames[sessionId];
  }
  if (state.activeSessionId === sessionId) {
    state.activeSessionId = null;
    state.activeProjectDir = null;
  }
  saveState(state);
}

// ── Scan real Claude Code sessions ──────────────────────────────────

function getLastUserMessage(filePath) {
  try {
    const content = readFileSync(filePath, "utf-8");
    let last = null;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.type !== "user") continue;
        const msg = d.message?.content;
        let text = null;
        if (typeof msg === "string") text = msg;
        else if (Array.isArray(msg)) {
          for (const c of msg) {
            if (c?.type === "text" && c.text) { text = c.text; break; }
          }
        }
        if (text && !text.startsWith("[") && !text.startsWith("<")) last = text;
      } catch {}
    }
    return last ? last.replace(/\n/g, " ").slice(0, 60) : "(empty session)";
  } catch {}
  return "(empty session)";
}

function projectDirToName(dir) {
  const homePrefix = HOME.replace(/\//g, "-").replace(/^-/, "");
  return dir
    .replace(new RegExp(`^-?${homePrefix}-?`), "")
    .replace(/-/g, "/")
    || dir;
}

export function listSessions(limit = 10) {
  const state = getState();
  const sessions = [];

  const SKIP_DIRS = ["telegram-bridge", "telegram/bridge", "tg-claude-worker", "tg-claude/worker"];

  try {
    const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);

    for (const projDir of projectDirs) {
      if (SKIP_DIRS.some((s) => projDir.includes(s))) continue;
      const fullProjDir = join(CLAUDE_PROJECTS_DIR, projDir);
      try {
        const files = readdirSync(fullProjDir).filter((f) => f.endsWith(".jsonl"));
        for (const file of files) {
          const filePath = join(fullProjDir, file);
          const stat = statSync(filePath);
          const sessionId = basename(file, ".jsonl");

          const customName = state.sessionNames?.[sessionId];
          sessions.push({
            sessionId,
            projectDir: projDir,
            projectName: projectDirToName(projDir),
            displayName: customName || null,
            lastMessage: getLastUserMessage(filePath),
            modifiedAt: stat.mtime,
            isActive: sessionId === state.activeSessionId,
          });
        }
      } catch {}
    }
  } catch {}

  sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return sessions.slice(0, limit);
}

// ── Working directory from project dir ──────────────────────────────

export function getWorkingDir(projectDir) {
  return "/" + projectDir.replace(/-/g, "/").replace(/^\//, "");
}
