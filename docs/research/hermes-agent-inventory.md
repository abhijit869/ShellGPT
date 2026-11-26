# hermes-agent inventory

Pinned commit: `b4bacb9569727b0fb9b92685a25690fa50ccc5ea`. Checkout: `/tmp/shellgpt-v3-research/hermes-agent` (write bits removed).

Every tracked file and directory, Git mode and object ID is recorded in [hermes-agent-tracked-tree.tsv](hermes-agent-tracked-tree.tsv). 27552 tracked files. Enumeration does not mean every file was read. Exact examined paths and line ranges are in [upstream-commits.json](upstream-commits.json). No upstream programs, hooks, installers or tests were executed.

| Top-level path | Tracked files |
|---|---:|
| `.coderabbit.yaml` | 1 |
| `.dockerignore` | 1 |
| `.env.example` | 1 |
| `.envrc` | 1 |
| `.gitattributes` | 1 |
| `.github` | 73 |
| `.gitignore` | 1 |
| `.hadolint.yaml` | 1 |
| `.mailmap` | 1 |
| `.npmrc` | 1 |
| `.nvmrc` | 1 |
| `.prettierignore` | 1 |
| `.prettierrc` | 1 |
| `.python-version` | 1 |
| `AGENTS.md` | 1 |
| `CONTRIBUTING.es.md` | 1 |
| `CONTRIBUTING.md` | 1 |
| `Dockerfile` | 1 |
| `LICENSE` | 1 |
| `README.es.md` | 1 |
| `README.md` | 1 |
| `README.ur-pk.md` | 1 |
| `README.zh-CN.md` | 1 |
| `SECURITY.es.md` | 1 |
| `SECURITY.md` | 1 |
| `SOUL.md` | 1 |
| `acp_adapter` | 22 |
| `activate` | 1 |
| `activate.fish` | 1 |
| `activate.ps1` | 1 |
| `agent` | 478 |
| `apps` | 5186 |
| `assets` | 10 |
| `batch_runner.py` | 1 |
| `cli-config.yaml.example` | 1 |
| `cli.py` | 1 |
| `contributors` | 3191 |
| `cron` | 64 |
| `docker` | 26 |
| `docker-compose.windows.yml` | 1 |
| `docker-compose.yml` | 1 |
| `eslint.config.shared.mjs` | 1 |
| `evals` | 343 |
| `flake.lock` | 1 |
| `flake.nix` | 1 |
| `gateway` | 422 |
| `hermes` | 1 |
| `hermes_agent` | 6 |
| `hermes_bootstrap.py` | 1 |
| `hermes_cli` | 909 |
| `hermes_constants.py` | 1 |
| `hermes_constants_scratch.py` | 1 |
| `hermes_constants_scratch_detach.py` | 1 |
| `hermes_constants_scratch_stuck.py` | 1 |
| `hermes_dir_acl.py` | 1 |
| `hermes_logging.py` | 1 |
| `hermes_platform` | 16 |
| `hermes_scope.py` | 1 |
| `hermes_startup_watchdog.py` | 1 |
| `hermes_state.py` | 1 |
| `hermes_state_common.py` | 1 |
| `hermes_state_loop_guard.py` | 1 |
| `hermes_state_registry.py` | 1 |
| `hermes_time.py` | 1 |
| `hermes_yaml.py` | 1 |
| `justfile` | 1 |
| `lefthook.yml` | 1 |
| `lineage_adoption.py` | 1 |
| `locales` | 35 |
| `model_tools.py` | 1 |
| `nix` | 26 |
| `optional-mcps` | 66 |
| `optional-skills` | 819 |
| `package.json` | 1 |
| `persistence` | 169 |
| `persistence_assembly.py` | 1 |
| `plugin-catalog` | 2581 |
| `plugins` | 553 |
| `pm` | 63 |
| `pnpm-lock.yaml` | 1 |
| `pnpm-workspace.yaml` | 1 |
| `process_identity.py` | 1 |
| `providers` | 4 |
| `pyproject.toml` | 1 |
| `registration_lifecycle.py` | 1 |
| `ruff.toml` | 1 |
| `run_agent.py` | 1 |
| `scripts` | 350 |
| `session_keys.py` | 1 |
| `session_rescue.py` | 1 |
| `session_retention.py` | 1 |
| `session_rules` | 18 |
| `setup-hermes.ps1` | 1 |
| `setup-hermes.sh` | 1 |
| `setup.py` | 1 |
| `skills` | 308 |
| `sqlite_support.py` | 1 |
| `storage_errors.py` | 1 |
| `storage_limits.py` | 1 |
| `storage_user_copy.py` | 1 |
| `tests` | 9407 |
| `tests-js` | 56 |
| `tools` | 405 |
| `toolset_distributions.py` | 1 |
| `toolsets.py` | 1 |
| `trajectory_compressor.py` | 1 |
| `tui_gateway` | 131 |
| `ui-tui` | 667 |
| `utils` | 4 |
| `uv.lock` | 1 |
| `web` | 284 |
| `website` | 781 |

## Architecture and configuration findings

`run_agent.py` exposes AIAgent; the conversation loop is now in `agent/conversation_loop.py` and turn helpers. `hermes_cli/runtime_provider.py` resolves runtime credentials/routes. `tools/registry.py` declares tool metadata. `persistence/` defines storage contracts. `providers/` discovers bundled, user and pip plugins. `cron/scheduler.py` runs scheduled jobs; `gateway/run.py` owns messaging lifecycle. `ui-tui/` is a separate TypeScript/React interface. `acp_adapter/entry.py` reserves stdout for ACP JSON-RPC and logs to stderr; it offers a supported integration boundary without copying the internal loop.

| Format | Scope/schema | Resolution |
|---|---|---|
| `$HERMES_HOME/config.yaml` | Profile YAML; model, tools, memory, terminal, MCP, gateway sections | Defaults then profile configuration; managed scope can pin keys |
| `$HERMES_HOME/.env` | Profile credentials/environment | Profile-scoped secret resolution; do not import into general memory |
| `SOUL.md`, `AGENTS.md` | Identity/project instruction Markdown | Prompt assembly, distinct from settings |
| `skills/**/SKILL.md` | YAML frontmatter + Markdown | Skill discovery and enabled toolset policy |
| `plugins/**/plugin.yaml` | YAML manifest | Bundled/user/installed plugin discovery; user provider plugins can shadow bundled |
| `mcp_servers` in config YAML | Server definitions | Runtime environment substitution; not automatically trusted by ShellGPT |
| `state.db`, persistence backend | Sessions/messages/indexes | Separate store ownership; never share mutable task databases |
| `cron/` state | Scheduled tasks and locking | Optional; explicit user authorization required |
| `cli-config.yaml.example`, package manifests, lockfiles | Samples/dependencies | Not user config precedence layers |

Source inspection is selective and line-limited as recorded in the manifest. Tests, skills, agent prompt assembly, terminal backends and workflow scripts are fully enumerated by path but have not all been read or executed. Python requirements and TUI package dependencies were sampled, not installed or license-cleared. ACP behavior beyond the inspected entry/server declarations requires protocol tests before an adapter is marked working.

Consulted [architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture) and [configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration); their live version can differ from the pinned repository.
