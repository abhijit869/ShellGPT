#!/usr/bin/env bash
set -euo pipefail
bridge_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$bridge_dir/.env" ]]; then
    set -a
    source "$bridge_dir/.env"
    set +a
fi
provider="${1:-codex}"
if [[ $# -gt 0 ]]; then shift; fi
case "$provider" in
    codex|codex/*|antigravity|antigravity/*|anthropic|anthropic/*) ;;
    *) echo 'Use codex, antigravity, anthropic, or provider/model-id.' >&2; exit 2 ;;
esac
: "${SHELLGPT_API_KEY:?Set SHELLGPT_API_KEY in .env}"
export ANTHROPIC_BASE_URL="http://127.0.0.1:${GATEWAY_PORT:-8001}"
export ANTHROPIC_AUTH_TOKEN="$SHELLGPT_API_KEY"
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
export ANTHROPIC_MODEL="$provider"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$provider"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$provider"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$provider"
export CLAUDE_CODE_SUBAGENT_MODEL="$provider"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1
export DISABLE_PROMPT_CACHING=1
export ENABLE_TOOL_SEARCH=false
exec claude --model "$provider" "$@"
