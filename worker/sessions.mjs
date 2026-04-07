import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const CLAUDE_PROJECTS_DIR = join(HOME, ".claude", "projects");
const STATE_FILE = join(__dirname, "state.json");

// Project dirs to ignore everywhere (bot's own internal sessions).
const SKIP_DIRS = ["telegram-bridge", "telegram/bridge", "tg-claude-worker", "tg-claude/worker"];
const isSkippedDir = (dir) => SKIP_DIRS.some((s) => dir.includes(s));

// ── State ───────────────────────────────────────────────────────────

const VALID_MODELS = ["sonnet", "opus", "haiku"];

function getState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")); }
  catch { return { activeSessionId: null, activeProjectDir: null, sessionNames: {}, model: "sonnet" }; }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function migrateState(state) {
  // Migrate from flat activeSessionId to per-chat activeSessions
  if (!state.activeSessions) {
    state.activeSessions = {};
    if (state.activeSessionId) {
      state.activeSessions["default"] = {
        sessionId: state.activeSessionId,
        projectDir: state.activeProjectDir || null,
        cwd: state.activeCwd || null,
      };
    }
    delete state.activeSessionId;
    delete state.activeProjectDir;
    delete state.activeCwd;
  }
  return state;
}

export function getActiveSession(chatId = "default") {
  const state = migrateState(getState());
  const s = state.activeSessions?.[chatId] || {};
  return {
    activeSessionId: s.sessionId || null,
    activeProjectDir: s.projectDir || null,
    activeCwd: s.cwd || null,
  };
}

export function setActiveSession(sessionId, projectDir, cwd, chatId = "default") {
  const state = migrateState(getState());
  if (!state.activeSessions) state.activeSessions = {};
  state.activeSessions[chatId] = { sessionId, projectDir: projectDir || null, cwd: cwd || null };
  saveState(state);
}

export function clearActiveSession(chatId = "default") {
  const state = migrateState(getState());
  if (state.activeSessions) delete state.activeSessions[chatId];
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

// ── Allowed users (for group chats) ─────────────────────────────────

export function getAllowedUsers() {
  return getState().allowedUsers || [];
}

export function addAllowedUser(userId) {
  const state = getState();
  if (!state.allowedUsers) state.allowedUsers = [];
  const id = String(userId);
  if (!state.allowedUsers.includes(id)) {
    state.allowedUsers.push(id);
    saveState(state);
  }
}

export function removeAllowedUser(userId) {
  const state = getState();
  if (!state.allowedUsers) return;
  const id = String(userId);
  state.allowedUsers = state.allowedUsers.filter((u) => u !== id);
  saveState(state);
}

// ── Show code diff in tool lines ─────────────────────────────────────

export function getShowDiff() {
  return !!getState().showDiff;
}

export function setShowDiff(enabled) {
  const state = getState();
  state.showDiff = enabled;
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

// Soft delete: mark the session as hidden in bot state. The .jsonl file is
// NOT touched, so `claude --resume` in the terminal still works. Keeps any
// custom name so unhide restores everything.
export function deleteSession(sessionId, projectDir) {
  hideSession(sessionId, projectDir);
}

export function getHiddenSessions() {
  return getState().hiddenSessions || {};
}

export function isSessionHidden(sessionId) {
  const h = getState().hiddenSessions || {};
  return !!h[sessionId];
}

export function hideSession(sessionId, projectDir) {
  const state = getState();
  if (!state.hiddenSessions) state.hiddenSessions = {};
  state.hiddenSessions[sessionId] = {
    hiddenAt: new Date().toISOString(),
    projectDir: projectDir || null,
  };
  saveState(state);
}

export function unhideSession(sessionId) {
  const state = getState();
  if (state.hiddenSessions?.[sessionId]) {
    delete state.hiddenSessions[sessionId];
    saveState(state);
  }
}

// Returns chatIds whose currently-active session is in the given sessionIds list.
export function getChatsWithActiveSession(sessionIds) {
  const set = new Set(sessionIds);
  const state = migrateState(getState());
  const result = [];
  for (const [chatId, s] of Object.entries(state.activeSessions || {})) {
    if (s?.sessionId && set.has(s.sessionId)) result.push(chatId);
  }
  return result;
}

// Bulk-hide all sessions whose .jsonl mtime is older than `days` days.
// Skips sessions that are currently active in any chat. Returns the array
// of sessionIds that were newly hidden.
export function bulkHideOlderThan(days) {
  const cutoff = Date.now() - days * 86400000;
  const state = migrateState(getState());
  if (!state.hiddenSessions) state.hiddenSessions = {};

  const activeIds = new Set();
  for (const s of Object.values(state.activeSessions || {})) {
    if (s?.sessionId) activeIds.add(s.sessionId);
  }

  const hiddenIds = [];
  try {
    const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);
    for (const projDir of projectDirs) {
      if (isSkippedDir(projDir)) continue;
      const fullProjDir = join(CLAUDE_PROJECTS_DIR, projDir);
      let files;
      try { files = readdirSync(fullProjDir).filter((f) => f.endsWith(".jsonl")); }
      catch { continue; }
      for (const file of files) {
        const sessionId = basename(file, ".jsonl");
        if (state.hiddenSessions[sessionId]) continue;
        if (activeIds.has(sessionId)) continue;
        let stat;
        try { stat = statSync(join(fullProjDir, file)); } catch { continue; }
        if (stat.mtime.getTime() < cutoff) {
          state.hiddenSessions[sessionId] = {
            hiddenAt: new Date().toISOString(),
            projectDir: projDir,
          };
          hiddenIds.push(sessionId);
        }
      }
    }
  } catch {}
  saveState(state);
  return hiddenIds;
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

export function listSessions(limit = 10, offset = 0, opts = {}) {
  const { onlyHidden = false, includeHidden = false } = opts;
  const state = getState();
  const hidden = state.hiddenSessions || {};
  const sessions = [];

  try {
    const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);

    for (const projDir of projectDirs) {
      if (isSkippedDir(projDir)) continue;
      const fullProjDir = join(CLAUDE_PROJECTS_DIR, projDir);
      try {
        const files = readdirSync(fullProjDir).filter((f) => f.endsWith(".jsonl"));
        for (const file of files) {
          const filePath = join(fullProjDir, file);
          const stat = statSync(filePath);
          const sessionId = basename(file, ".jsonl");

          const isHidden = !!hidden[sessionId];
          if (onlyHidden) {
            if (!isHidden) continue;
          } else if (!includeHidden && isHidden) {
            continue;
          }

          const customName = state.sessionNames?.[sessionId];
          // Check if this session is active in any chat
          const ms = migrateState(state);
          const isActive = Object.values(ms.activeSessions || {}).some(
            (s) => s.sessionId === sessionId
          );
          sessions.push({
            sessionId,
            projectDir: projDir,
            projectName: projectDirToName(projDir),
            displayName: customName || null,
            lastMessage: getLastUserMessage(filePath),
            modifiedAt: stat.mtime,
            isActive,
          });
        }
      } catch {}
    }
  } catch {}

  sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return { items: sessions.slice(offset, offset + limit), total: sessions.length };
}

// ── Working directory from project dir ──────────────────────────────

export function getWorkingDir(projectDir) {
  return "/" + projectDir.replace(/-/g, "/").replace(/^\//, "");
}
