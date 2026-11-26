# V3 integration plan and first executable milestone

Preservation checkpoint: `9de29d5`. Extend the existing packages; do not replace the Python bridges or move working modules to match a directory diagram.

1. Audit: pin upstream trees, enumerate all tracked paths, record the exact inspected subset, document configuration and licensing boundaries.
2. First integration: independently implement a Claude configuration reader, explicit modes, source provenance, validated non-destructive migration, and CLI diagnostics. Import no account state. Imported executable extensions remain inactive. Add an independently testable model selector and integrate it with the existing provider gateway.
3. Stabilization: reproduce baseline tests, distinguish fixture tests from authenticated execution, add a real TypeScript check, and verify CLI configuration workflows without initializing runtimes or writing session data.
4. Next runtime milestone: use the upstream Hermes ACP entry point (`hermes acp`, `acp_adapter/entry.py`) rather than importing its Python internals. Negotiate capabilities and permissions; own tasks in ShellGPT, keep Hermes session IDs as adapter metadata. Add cancellation, streaming, approval responses and isolated worktrees before enabling coding tasks. No Hermes source is vendored in this milestone.
5. Later: unify command registration, expand supported permission grammar, hooks/plugins and MCP activation approvals, complete credential budgets/cost routing, improve multiline TUI and optional authenticated scheduling/messaging.

The first milestone does not certify the full Part 3 specification. Each compatibility format is classified as applied, importable, inventoried only, or unsupported. Existing Codex/Antigravity adapters are preserved; fixture execution does not establish live authentication. Do not start remote or scheduled work during import.

## Existing repository findings

Native TypeScript packages already cover core orchestration, providers, agents, permissions, tools, SQLite memory, MCP, REA, skills, hooks, plugins and CLI/TUI. Provider selection currently assumes well-known profile IDs, does not implement capability/cost ranking, and can return invented fallback model names. InstructionBridge reads Claude instructions implicitly. ConfigManager only loads the project YAML. CLI constructs the full orchestrator before config commands, which creates session/skill state. The build script executes imports but is not a TypeScript type check. Historical `docs/implementation-status.json` claims are not re-certified by this audit.

## Verification boundaries

Baseline `npm test` fails in three test files under the sandbox; individual orchestration tests pass when run directly. Diagnose process/network sandbox effects before changing behavior. Tests must explicitly identify deterministic local HTTP/process fixtures. Live provider/agent tests require installed runtimes and authorized credentials and must report blocked/skip when unavailable.
