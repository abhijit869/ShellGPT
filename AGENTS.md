# ShellGPT Project Rules (AGENTS.md)

## Overview
ShellGPT is a production-grade, multi-agent, extensible AI coding CLI in TypeScript featuring:
- Central orchestrator with 4 execution modes (Mode A: Custom API Controller, Mode B: Antigravity Primary Brain, Mode C: Codex Primary Brain, Mode D: Local Model Recovery).
- Bidirectional delegation between Google Antigravity (`agy` / Python SDK sidecar) and OpenAI Codex (`codex`).
- Native MCP client with first-class REA (`rea-agents`) reverse-engineering integration.
- Universal Provider Gateway supporting Asemprotic, OpenAI-compatible, Anthropic, Gemini, OpenRouter, Ollama, LM Studio, vLLM, and llama.cpp.
- Persistent SQLite session memory, permission and security policy engine, skills, hooks, plugins, and interactive Terminal UI.

## Engineering Standards
1. **Strict Type Safety**: Maintain clean TypeScript types and runtime validation with Zod.
2. **Honest Diagnostics**: Never simulate AI responses, fabricate model endpoints, or claim unauthenticated runtimes succeeded.
3. **Security & Permissions**: Respect the active permission mode (`read-only`, `ask`, `workspace-write`, `trusted-automation`, `sandbox`). Redact secrets from logs and sanitize untrusted content.
4. **Preserve User Files**: Keep `server.py`, `gateway.py`, `claude-with.sh`, `gateway-start.sh`, `start.sh`, and existing Python tests functional.
5. **Verification Required**: Validate changes with automated tests before reporting completion.
