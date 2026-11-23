# ShellGPT Installation, Configuration & Troubleshooting Guide

## 1. Installation

```bash
# Verify Node.js (v22.23+ or v24+ recommended) and Python 3.10+
node -v
python3 --version

# Install the `shellgpt` executable into ~/.local/bin/shellgpt
bash scripts/install.sh

# Run build & system diagnostics
npm run build
./bin/shellgpt doctor
```

## 2. Configuring Execution Modes

### Mode A — Custom API Controller (Asemprotic / OpenAI / Anthropic / Gemini / OpenRouter)
ShellGPT never assumes or fabricates a default endpoint for Asemprotic. To configure Asemprotic or another custom API controller:

```bash
export ASEMPROTIC_BASE_URL="https://your-asemprotic-endpoint.example.com/v1"
export ASEMPROTIC_API_KEY="your-api-key"
export ASEMPROTIC_MODEL="your-model-id"
export ASEMPROTIC_API_FORMAT="openai" # openai | anthropic | gemini | custom

./bin/shellgpt provider test asemprotic
```

Or register a custom provider via CLI:
```bash
./bin/shellgpt provider add my-gateway https://api.example.com/v1 openai gpt-4.1
./bin/shellgpt provider use my-gateway
```

### Mode B — Google Antigravity Primary Brain
When no primary API key is set, ShellGPT automatically selects Google Antigravity (`agy` v1.5.14) if installed and authenticated:
```bash
agy models
./bin/shellgpt agent use antigravity
```
*Note on container sandboxes*: If `~/.gemini/antigravity-cli` is mounted read-only inside an isolated sandbox, `AntigravityAdapter` automatically creates a writable fallback home in `/tmp/shellgpt-agy-home` so CLI commands do not crash, and advises running in your host terminal for full account session access.

### Mode C — OpenAI Codex Primary Brain
To pin OpenAI Codex as the primary coding brain (with Antigravity available as a delegated subagent):
```bash
codex login
./bin/shellgpt agent use codex
```
*Note on container sandboxes*: If `/home/codespace/.local/bin/codex` is a symlink into `/home/codespace/.codex/...` which is unmounted in a restricted sandbox, `shellgpt doctor` detects the symlink via `lstat` and reports the exact symlink target honestly.

### Mode D — Local Model Recovery
If no cloud API or authenticated CLI agent is available, start a local server (Ollama on `:11434`, LM Studio on `:1234`, llama.cpp on `:8080`, or vLLM on `:8000`):
```bash
export OLLAMA_HOST="http://127.0.0.1:11434"
./bin/shellgpt agent use local
```

## 3. REA Reverse-Engineering MCP Troubleshooting

Verify REA (`rea-agents` v6.10.1) health and discovered tools:
```bash
./bin/shellgpt rea status
./bin/shellgpt rea doctor
./bin/shellgpt rea engines
./bin/shellgpt rea tools
./bin/shellgpt rea analyze
```
If optional native analysis engines (such as Ghidra at `/opt/ghidra/ghidra_12.2_PUBLIC`, Rizin, or ADB) are not installed, `./bin/shellgpt rea engines` reports which engines are available (such as built-in JavaScript/Babel AST and Python/SQLite inspection) and how to configure optional binaries.
