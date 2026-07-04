#!/usr/bin/env bash
# Idempotent bootstrap: clean checkout -> working environment.
# Safe to re-run at any time.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v uv >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "installing uv via homebrew..."
    brew install uv
  else
    echo "installing uv via official installer..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi
fi

if ! command -v ffmpeg >/dev/null 2>&1 && command -v brew >/dev/null 2>&1; then
  echo "installing ffmpeg via homebrew..."
  brew install ffmpeg
fi

echo "syncing python environment (pinned via uv.lock)..."
uv sync

echo
uv run transcriber doctor
