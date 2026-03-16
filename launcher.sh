#!/usr/bin/env bash

# Claude Code Headless Launcher
# Usage:
#   claude-tg "fix the login bug in auth.ts"
#   claude-tg --project /path/to/repo "add tests for user service"
#   claude-tg --resume session_id "continue"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Defaults
PROJECT_DIR="$(pwd)"
RESUME=""
MODEL=""
ALLOWEDTOOLS=""

# Parse flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|-p)
      PROJECT_DIR="$2"
      shift 2
      ;;
    --resume|-r)
      RESUME="--resume $2"
      shift 2
      ;;
    --model|-m)
      MODEL="--model $2"
      shift 2
      ;;
    --allowed-tools)
      ALLOWEDTOOLS="--allowedTools $2"
      shift 2
      ;;
    *)
      break
      ;;
  esac
done

PROMPT="${*:-}"

if [[ -z "$PROMPT" && -z "$RESUME" ]]; then
  echo "Usage: claude-tg [--project <path>] [--model <model>] \"<prompt>\""
  echo "       claude-tg --resume <session_id> \"<prompt>\""
  exit 1
fi

cd "$PROJECT_DIR"

# Launch Claude Code in headless (print) mode
exec claude \
  --print \
  --verbose \
  $MODEL \
  $RESUME \
  $ALLOWEDTOOLS \
  "$PROMPT"
