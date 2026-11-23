# ShellGPT

**Production-grade, multi-agent, extensible AI coding CLI in TypeScript** combining Claude Code-style workflows, Google Antigravity (`agy` CLI & Python SDK sidecar), OpenAI Codex (`codex`), first-class REA (`rea-agents`) reverse-engineering MCP integration, and a Universal Provider Gateway.

---

## Architecture & Autonomous Multi-Agent Runtime (SAOE)

ShellGPT is governed by the **ShellGPT Agent Orchestration Engine (SAOE)**:
- **Central Control Layer**: Uniform `AgentRuntime` lifecycle (`initialize`, `checkAvailability`, `checkAuthentication`, `getCapabilities`, `createSession`, `resumeSession`, `executeTask`, `streamTask`, `cancelTask`, `getStatus`, `dispose`).
- **4 Execution Modes**:
  - **Mode A (Custom API / Asemprotic Gateway)**: Primary controller when configured with automatic fallback without duplicate edits.
  - **Mode B (Antigravity Primary Brain)**: Autonomous Google Antigravity controller delegating coding tasks to Codex.
  - **Mode C (Codex Primary Brain)**: Autonomous OpenAI Codex controller delegating architecture/research to Antigravity.
  - **Mode D (Local Model Recovery)**: Ollama, vLLM, LM Studio, or llama.cpp offline recovery.
- **Bidirectional Agent Delegation (`delegate_to_agent`)**:
  - Antigravity ↔ Codex with `DelegationSafetyGuard` enforcing max recursion depth, duplicate task detection, session budget ceilings, and post-task SHA-256 filesystem fingerprint diff verification.
- **Task State Machine & Crash Recovery**: Durable transitions (`CREATED` → `QUEUED` → `RUNNING` → `VERIFYING` → `COMPLETED`, plus `WAITING_FOR_PERMISSION`, `BLOCKED`, `FAILED`, `CANCELLED`, `RECOVERING`). Safely marks orphaned tasks as `FAILED` on restart without false active claims.
- **First-Class REA Reverse-Engineering MCP**: 263 tools and 6 prompts discovered and invoked via live Stdio MCP client (`rizin`, `cutter`, `gdb`, `frida`, `adb`, `jeb`, `apktool`).
- **5-Tier Security & Permission Policy**: `read-only`, `ask`, `workspace-write`, `trusted-automation`, `sandbox` with secret redaction and path containment.
- **Real Verification Engine**: `runVerificationPipeline` validates git diffs, linting, compilation, and test execution before completing tasks.
- **Machine-Readable Implementation Status**: Tracked at [`docs/implementation-status.json`](docs/implementation-status.json).

---

## Quick Start (ShellGPT TypeScript CLI)

```bash
# 1. Verify installation and all runtimes (Antigravity, Codex, REA MCP, Providers, SQLite, Skills)
./bin/shellgpt version
./bin/shellgpt doctor

# 2. Launch interactive Terminal UI
./bin/shellgpt

# 3. Select Primary Brain or Inspect Brain Status
./bin/shellgpt brain status
./bin/shellgpt brain antigravity
./bin/shellgpt brain codex
./bin/shellgpt brain auto

# 4. Run REA reverse-engineering diagnostics & analysis via live MCP (263 tools)
./bin/shellgpt rea status
./bin/shellgpt rea engines
./bin/shellgpt rea analyze

# 5. Session Management
./bin/shellgpt session new "Auth Module Refactor"
./bin/shellgpt session list
./bin/shellgpt session search "Auth"

# 6. Headless execution with structured JSON lifecycle output
./bin/shellgpt exec "Inspect the repository architecture" --json

# 7. Run full automated verification (TypeScript Unit/Integration/E2E + Python Gateway Tests)
npm run build
npm run test:all
```

### Interactive Terminal Commands (TUI Slash Commands)

| Command | Action |
| --- | --- |
| `/brain <mode>` | Switch brain (`auto`, `antigravity`, `codex`, `api`, `local`, `status`, `fallback`, `reset`) |
| `/agent <mode>` | Switch agent (`antigravity`, `codex`, `auto`) |
| `/rea <subcmd>` | REA integration (`status`, `engines`, `analyze`) |
| `/session <subcmd>` | Session management (`list`, `new <title>`, `rename <id> <title>`, `search <query>`) |
| `/permissions <mode>` | Switch permissions (`read-only`, `ask`, `workspace-write`, `trusted-automation`, `sandbox`) |
| `/doctor` | Run diagnostic self-check on all runtimes, MCP, and providers |
| `/help` | List available slash commands and keybindings |

### Documentation

- **[Implementation Status (Machine-Readable)](docs/implementation-status.json)** — Detailed inventory of all 6 feature categories and runtime environment detection.
- **[Architecture Guide](docs/ARCHITECTURE.md)** — Control layer, 4 execution modes, 7-tier routing engine, canonical task delegation envelope, and instruction precedence bridge.
- **[Feature Implementation Matrix](docs/FEATURE_MATRIX.md)** — Verified status of every subsystem (`Implemented`, `Tested`, `Requires configuration`).
- **[Installation, Configuration & Troubleshooting](docs/TROUBLESHOOTING.md)** — Configuring Asemprotic, OpenAI/Anthropic/Gemini/Local backends, sandbox diagnostics, and REA engines.

---

## Use Codex or Antigravity as Claude Code's model (Preserved Python Gateway)

The provider gateway keeps **Claude Code as the client** and sends model requests
to your logged-in Codex CLI, Antigravity CLI, or the Anthropic API.
It runs separately from the original text bridge described below.

Start the gateway in one terminal:

```bash
bash gateway-start.sh
```

Then choose a backend in another terminal:

```bash
bash claude-with.sh codex
bash claude-with.sh antigravity
bash claude-with.sh anthropic
```

The launchers load the private `.env` configuration and preserve your working
directory for Claude Code. They do not edit your global Claude or Codex settings.
The gateway listens on `127.0.0.1:8001` and requires the generated
`SHELLGPT_API_KEY`. On a new checkout, copy `.env.example` to `.env` and replace
the example bridge key with a random secret.

| Backend | Default model | Authentication |
| --- | --- | --- |
| `codex` | `gpt-6-astra` | Existing `codex login` |
| `antigravity` | `gemini-3.8-flash-low` | Existing `agy` account |
| `anthropic` | `claude-sonnet-5-5` | `ANTHROPIC_API_KEY` in gateway environment / `.env` |

Override `CODEX_MODEL`, `ANTIGRAVITY_MODEL`, or `ANTHROPIC_MODEL` in `.env`.
Use `agy models` to find account-accessible Antigravity models. You can also
choose a model for one invocation:

```bash
bash claude-with.sh codex/gpt-6-astra -p 'Reply with exactly OK.'
bash claude-with.sh antigravity/gemini-4-neon-high -p 'Reply with exactly OK.'
bash claude-with.sh antigravity/claude-sonnet-5-5-low -p 'Reply with exactly OK.'
```

Claude Code may print an `unrecognized_model` diagnostic for gateway aliases;
the aliases are resolved by this gateway. Anthropic access through Antigravity
uses Antigravity's account entitlements; the direct `anthropic` route requires
an Anthropic API key. A Claude subscription login alone does not authenticate
that direct API route.

### Gateway behavior and limits

Codex and Antigravity return structured text and tool requests. The gateway
converts these to Anthropic `tool_use` blocks, and **Claude Code executes the
tools under its own permission settings**. Tool results and conversation history
are included in the next backend prompt. Provider CLI processes run in temporary
directories; Codex uses read-only sandbox mode and Antigravity requests strict
tool permissions. No permission-bypass flags are used. Keep this gateway local
and use it with trusted clients: CLI accounts still belong to the host user.

Each model turn starts a new provider CLI run. This adds latency and prompt
overhead. SSE sends keepalive pings while waiting, then sends buffered text/tool
events. Tool schemas and history are encoded in a prompt, so this is an
experimental adapter rather than native cross-provider tool calling. `max_tokens`
is a best-effort instruction for CLI backends, not an enforced token cap.
Thinking controls, prompt caching, sampling controls, and provider-specific beta
features are not mapped to CLI backends; the launcher disables several Claude
features that require native support. Images and server-defined tools are
rejected. Exact token counting is unavailable for CLI backends. Usage measures
the nested CLI run, and Claude Code's displayed cost estimates are not reliable
for gateway aliases.

The Anthropic route forwards request bodies (with model alias resolution),
Anthropic headers, tool definitions, streaming, and error responses to the
official API. It does not use the nested Claude CLI and cannot recurse into
this gateway. Keep the API key on the gateway process.

References: [Claude Code gateway compatibility](https://code.claude.com/docs/en/llm-gateway-protocol)
and [Antigravity headless output](https://antigravity.google/docs/cli/headless/).
Anthropic [does not officially support routing Claude Code to non-Claude models](https://code.claude.com/docs/en/llm-gateway).

### Verified in this workspace

On 2026-11-22, real Claude Code requests returned `OK` through Codex
(`gpt-6-astra`), Antigravity (`gemini-3.8-flash-low`), and Antigravity's
`claude-sonnet-5-5-low`. Codex and Antigravity/Gemini also completed a two-turn
Read-tool test: Claude Code read a generated test file and the backend returned
its contents. The 11 automated tests passed. Direct Anthropic forwarding remains
untested against the upstream because no `ANTHROPIC_API_KEY` is configured;
its missing-key error path is tested.

## Original mode: expose Claude Code as a text API

Expose Claude Code as a local Anthropic Messages and OpenAI Chat Completions compatible **text API**. Requires Python 3.10+ and the Claude Code CLI; no Python dependencies.

## Start

```bash
claude auth login
claude auth status
python3 server.py
```

For saved configuration, copy `.env.example` to `.env`, set a random
`SHELLGPT_API_KEY`, and run `bash start.sh`. The launcher exports `.env`
before starting the server. Treat `.env` as trusted shell configuration;
it is excluded from git. Authenticate through `claude auth login` or set
one of the upstream credentials shown in `.env.example`.

Claude Code can also use `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` from the server environment. The bridge uses the installed CLI's authentication. Do not set the server's `ANTHROPIC_BASE_URL` to this bridge (that would cause a loop).

## Verify

```bash
npm run test:all
python3 -m unittest discover -s tests -v
./bin/shellgpt doctor
```
