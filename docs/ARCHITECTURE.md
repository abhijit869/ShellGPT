# ShellGPT Architecture Guide

## High-Level Architecture

```
ShellGPT CLI / Terminal UI (apps/cli)
  │
  ├── Input & Command Parser (CLI subcommands + Interactive Slash Commands)
  ├── Session & Context Manager (packages/memory — SQLite DatabaseSync + Context Compaction)
  ├── ShellGPT Central Orchestrator (packages/core — 17-step State Machine + Self-Healing Loop)
  │     ├── Intelligent 7-Tier Router & Circuit Breaker
  │     ├── Antigravity & Codex Instruction Bridge (packages/agents)
  │     └── Parallel DAG Task Scheduler & Write-Conflict Detector
  ├── Agent & Provider Adapters
  │     ├── Google Antigravity Adapter (packages/adapters-antigravity + services/antigravity-sidecar)
  │     ├── OpenAI Codex Adapter (packages/adapters-codex)
  │     ├── Optional Claude Code Adapter (packages/adapters-claude + gateway.py + server.py)
  │     └── Universal Provider Gateway (packages/providers — Asemprotic, OpenAI, Anthropic, Gemini, OpenRouter, Ollama, LM Studio, llama.cpp, vLLM)
  ├── MCP Client & First-Class REA Integration
  │     ├── Native MCP Client (packages/mcp — @modelcontextprotocol/client stdio / Streamable HTTP / SSE)
  │     └── REA Reverse Engineering (packages/rea — morluto/rea rea-agents v6.10.1, 263 tools)
  ├── Extensibility Engine
  │     ├── Skills System (packages/skills — 13 native skills + REA ecosystem skill + progressive disclosure)
  │     ├── Lifecycle Hook Engine (packages/hooks — trust-gated PreToolUse, PostToolUse, SessionStart, Stop, etc.)
  │     └── Plugin Registry (packages/plugins — plugin.json bundles)
  ├── Security & Permission Engine (packages/permissions — 5 modes, workspace boundaries, secret redaction, untrusted content isolation)
  └── Coding & Git Toolkit (packages/tools — atomic file read/write/edit/patch, symbol search, Git worktrees, checkpoints)
```

## Four Execution Modes

1. **MODE A — Custom API Controller (`MODE_A_CUSTOM_API`)**:
   - Triggered when a valid primary API provider (Asemprotic, OpenAI-compatible, Anthropic, Gemini, OpenRouter) is configured and healthy.
   - The custom API model acts as the primary reasoning controller and delegates coding/research subtasks to Antigravity and Codex worker agents.
2. **MODE B — Antigravity Primary Brain (`MODE_B_ANTIGRAVITY_PRIMARY`)**:
   - Triggered when no primary cloud API is configured and Google Antigravity (`agy` CLI / Python SDK) is installed and authenticated.
   - Antigravity acts as the primary brain and delegates implementation, debugging, refactoring, and testing subtasks to OpenAI Codex via `delegate_to_codex`.
3. **MODE C — Codex Primary Brain (`MODE_C_CODEX_PRIMARY`)**:
   - Triggered when the user selects `/agent codex` (`shellgpt agent use codex`) or when automatic fallback selects Codex.
   - Codex acts as the primary coding agent and delegates research, architecture planning, and multi-file analysis subtasks to Google Antigravity via `delegate_to_antigravity`.
4. **MODE D — Local Model Recovery (`MODE_D_LOCAL_RECOVERY`)**:
   - Triggered when neither cloud APIs nor authenticated CLI agents are available, and a local LLM backend (Ollama, LM Studio, llama.cpp, vLLM) is online.
   - Displays reduced-capability warnings when a local model lacks reliable native tool calling.

## Instruction Precedence & Canonical Task Envelope

The `InstructionBridge` enforces explicit precedence without blindly concatenating conflicting rules:
1. Per-task instruction overrides (Precedence 1 — Highest)
2. `.shellgpt/instructions.md` (Precedence 2)
3. `AGENTS.md` and `.agents/rules/*.md` (Precedence 3)
4. `CLAUDE.md` and `.claude/instructions.md` (Precedence 4)
5. `GEMINI.md` (Precedence 5)
6. ShellGPT global settings (Precedence 6 — Lowest)

Every delegated task uses the canonical envelope:
`task_id, parent_id, parent_session_id, requested_by, assigned_to, role, objective, scope, instructions, context_refs, allowed_paths, protected_paths, available_tools, expected_outputs, permissions, deadline, validation_commands, cancellation_token`.
