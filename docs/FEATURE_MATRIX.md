# ShellGPT Feature Implementation Matrix

Statuses follow the required verification categories:
**Implemented / Tested / Partially implemented / Requires configuration / Unsupported / Planned**

| Category | Feature | Status | Verification & Notes |
| --- | --- | --- | --- |
| **Core CLI & TUI** | Executable `shellgpt` CLI (`bin/shellgpt`, `apps/cli`) | **Tested** | Verified via unit, integration, and E2E CLI tests |
| **Core CLI & TUI** | Interactive TUI (Header, Conversation, Agent Panel, Footer, Themes) | **Tested** | Supports dark, light, and custom themes, markdown & file path highlighting |
| **Core CLI & TUI** | Slash Command Engine (`/agent`, `/model`, `/provider`, `/mcp`, `/rea`, `/mode`, `/permissions`, `/skills`, `/hooks`, `/plugins`, `/compact`, `/checkpoint`, `/undo`, `/dashboard`) | **Tested** | Verified in `tests/e2e/cli_scenarios.test.ts` |
| **Core CLI & TUI** | Headless execution & `--json` output (`shellgpt exec --json`, `-p`) | **Tested** | Verified 17-step lifecycle JSON envelope |
| **Execution Modes** | MODE A — Custom API Controller (Asemprotic, OpenAI, Anthropic, Gemini, OpenRouter) | **Tested** | Verified against live HTTP server in `tests/integration/live_mcp_and_providers.test.ts` |
| **Execution Modes** | MODE B — Antigravity Primary Brain (`agy` v1.5.14 `stream-json` + Python SDK sidecar) | **Tested** | Verified with `agy` binary discovery & E2E delegation harness; live cloud calls require active host `agy` login |
| **Execution Modes** | MODE C — Codex Primary Brain (`codex exec --json` + threads) | **Tested** | Verified with `codex` adapter & E2E delegation harness; live cloud calls require `codex login` in host terminal |
| **Execution Modes** | MODE D — Local Model Recovery (Ollama, LM Studio, llama.cpp, vLLM) | **Tested** | Verified against live local Ollama HTTP server with reduced-capability warning |
| **Routing Engine** | 7-Tier Priority Router & Circuit Breaker with Exponential Backoff | **Tested** | Verified non-retryable 401/403 guard and automatic circuit opening |
| **Routing Engine** | Neutral Structured Session Summary on Provider/Agent Switch | **Tested** | Verified in Scenario B & Scenario E tests |
| **Orchestration** | Bidirectional Delegation (Antigravity ↔ Codex canonical task envelope) | **Tested** | Verified in `tests/unit/orchestration.test.ts` and `tests/e2e/cli_scenarios.test.ts` |
| **Orchestration** | 15 Configurable Worker Roles (Planner, Architect, Researcher, Frontend, Backend, DB, AI/ML, DevOps, Security, Reviewer, Test, Docs, Debugger, Performance, REA Analyst) | **Tested** | All 15 roles registered and configurable |
| **Orchestration** | Parallel DAG Task Scheduler, Write-Conflict Detection, Git Worktree Isolation | **Tested** | Verified concurrent write serialization and DAG ordering |
| **Orchestration** | Bounded Self-Healing Loop (`Detect → Classify → Diagnose → Fix → Verify → Report`) | **Tested** | Verified 11 error classifications and bounded retry budget |
| **MCP & REA** | Native MCP Client (`@modelcontextprotocol/client` v2.3.1 stdio, Streamable HTTP, SSE) | **Tested** | Verified live stdio connection, Ajv schema validation, tool conflict namespacing |
| **MCP & REA** | First-Class REA Integration (`morluto/rea` `rea-agents` v6.10.1) | **Tested** | Connected to live `rea --mcp`, discovered all 263 real tools & 6 prompts, executed `binary_session` |
| **MCP & REA** | REA Target Authorization Guard & Untrusted Content Sanitization | **Tested** | Blocks unauthorized paths outside workspace and neutralizes `<system>` prompt injection |
| **MCP & REA** | Optional External Reverse-Engineering Engines (Ghidra, Rizin, Frida, ADB, Apktool) | **Requires configuration** | JS/Babel AST & Python/SQLite engines active out of the box; Ghidra/Rizin/ADB detected dynamically when installed |
| **Coding Tools** | Read, Write, Edit, Unified Patch (`diff`), File & Content Search, Symbol Finder, Dependency Inspector | **Tested** | Verified in `tests/integration/live_mcp_and_providers.test.ts` |
| **Coding Tools** | Git Status, Branch, Diff, File History, Approval-Gated Commit, Worktrees, Checkpoint Undo | **Tested** | Never silently overwrites uncommitted user changes |
| **Memory & Sessions** | SQLite Persistent Storage (`node:sqlite` `DatabaseSync`), Resume, Fork, Export (JSON/MD), Compaction | **Tested** | Verified workspace isolation, secret redaction, compaction, and checkpoint rollback |
| **Memory & Sessions** | External PostgreSQL / Redis Storage Adapter | **Requires configuration** | `ExternalStorageAdapter` interface implemented; requires external DB connection string |
| **Extensibility** | Skills System (13 Bundled Native Skills + REA Ecosystem Skill + Progressive Disclosure) | **Tested** | Verified 14 skills discovered and on-demand `SKILL.md` activation |
| **Extensibility** | Lifecycle Hook Engine (`hooks.json`, trust controls, timeouts, `PreToolUse` argument overwrite) | **Tested** | Untrusted hooks are never executed automatically |
| **Extensibility** | Plugin Registry (`plugin.json`, bundled skills/rules/hooks/MCP) | **Implemented** | Discovers and ingests enabled plugins from `.agents/plugins` and `.shellgpt/plugins` |
| **Security** | 5 Permission Modes (`read-only`, `ask`, `workspace-write`, `trusted-automation`, `sandbox`) | **Tested** | Verified workspace boundaries, protected file guard (`.env`), child agent privilege bounding |
| **Security** | Encrypted Secret Vault (`SecretStore` AES-256-GCM) & Log Redaction | **Tested** | Verified no plaintext secrets on disk or in JSONL/SQLite logs |
| **Observability** | Execution Dashboard, Redacted JSONL Logs, OpenTelemetry Trace Span Exporter | **Tested** | Separates measured vs estimated metrics and reports `"unavailable"` when not exposed |
| **Legacy Bridges** | Preserved Python Claude Code Text Bridge (`server.py`) & Provider Gateway (`gateway.py`) | **Tested** | All 11 Python unit tests pass via `npm run test:python` |
