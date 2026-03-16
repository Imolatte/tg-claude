#!/usr/bin/env node

/**
 * Switch output channel mode.
 *
 * Usage:
 *   node mode.mjs terminal   — everything in terminal (default)
 *   node mode.mjs hybrid     — approvals/questions → TG, responses → terminal
 *   node mode.mjs telegram   — everything → TG
 *   node mode.mjs            — show current mode
 */

import { readFileSync, writeFileSync } from "fs";

const MODE_FILE = "/tmp/claude-output-channel";
const VALID_MODES = ["terminal", "hybrid", "telegram"];

function getMode() {
  try { return readFileSync(MODE_FILE, "utf-8").trim(); }
  catch { return "terminal"; }
}

const arg = process.argv[2]?.trim().toLowerCase();

if (!arg) {
  console.log(`Current mode: ${getMode()}`);
  process.exit(0);
}

if (!VALID_MODES.includes(arg)) {
  console.error(`Invalid mode: ${arg}. Use: ${VALID_MODES.join(", ")}`);
  process.exit(1);
}

writeFileSync(MODE_FILE, arg);
console.log(`Mode: ${arg}`);
