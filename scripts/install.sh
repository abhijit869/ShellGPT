#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${SHELLGPT_BIN_DIR:-${HOME}/.local/bin}"

chmod +x "$ROOT_DIR/bin/shellgpt"

if mkdir -p "$TARGET_DIR" 2>/dev/null && ln -sfn "$ROOT_DIR/bin/shellgpt" "$TARGET_DIR/shellgpt" 2>/dev/null; then
  echo "ShellGPT installed to $TARGET_DIR/shellgpt"
else
  echo "Note: $TARGET_DIR is read-only in the current sandbox; using $ROOT_DIR/bin/shellgpt directly."
  echo "Add to PATH: export PATH=\"$ROOT_DIR/bin:\$PATH\""
fi
echo "Run '$ROOT_DIR/bin/shellgpt doctor' to verify your environment."
