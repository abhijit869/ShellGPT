# claude-code inventory

Pinned commit: `50cdc7005318f630144c28217d1dada32e6ba762`. Checkout: `/tmp/shellgpt-v3-research/claude-code` (write bits removed).

Every tracked file and directory, Git mode and object ID is recorded in [claude-code-tracked-tree.tsv](claude-code-tracked-tree.tsv). 3382 tracked files. Enumeration does not mean every file was read. Exact examined paths and line ranges are in [upstream-commits.json](upstream-commits.json). No upstream programs, hooks, installers or tests were executed.

| Top-level path | Tracked files |
|---|---:|
| `.claude` | 3 |
| `.claude-plugin` | 1 |
| `.devcontainer` | 3 |
| `.gitattributes` | 1 |
| `.github` | 22 |
| `.gitignore` | 1 |
| `.vscode` | 1 |
| `CHANGELOG.md` | 1 |
| `CLAUDE.md` | 1 |
| `LICENSE.md` | 1 |
| `README.md` | 1 |
| `SECURITY.md` | 1 |
| `Script` | 1 |
| `demo.gif` | 1 |
| `examples` | 41 |
| `feed.xml` | 1 |
| `mods` | 3292 |
| `plugins` | 1 |
| `scripts` | 8 |

## Configuration formats and boundaries

| Filename / format | Scope and schema | Precedence / treatment |
|---|---|---|
| `CLAUDE.md`, `CLAUDE.local.md` | Project Markdown instructions | Additive context; local variant private; nested/ancestor discovery needs separate implementation |
| `AGENTS.md` | ShellGPT project instructions | Existing ShellGPT instruction policy |
| `~/.claude/settings.json` | User JSON object | Below project shared/local/session/managed policy |
| `.claude/settings.json` | Shared JSON settings | Above user |
| `.claude/settings.local.json` | Private project JSON | Above shared, below session/managed |
| `managed-settings.json` | Organization JSON, deployment-dependent location | Highest Claude tier; ShellGPT security remains a ceiling |
| `.claude/rules/**/*.md` | Markdown with optional YAML `paths` | Unconditional versus path-scoped instructions; no execution |
| `.claude/skills/*/SKILL.md` | YAML frontmatter + Markdown | Names/description; invocation/tool/model/context restrictions need explicit translation |
| `.claude/commands/**/*.md` | YAML frontmatter + prompt | Legacy commands; shell interpolation must not execute while loading |
| `.claude/agents/*.md` | YAML frontmatter + system instructions | Agent tool/model/permission/MCP/memory fields need runtime enforcement |
| `.claude/workflows/*.js` | Requested extension path | Not established as a standard by inspected documentation; do not execute |
| `.claude/agent-memory/` | Agent memory Markdown | Explicit selection only; no bulk import |
| `.claude/output-styles/*.md` | Markdown/frontmatter | Prompt/style semantics, not a terminal theme |
| `.mcp.json` | JSON `mcpServers` mapping | Validate transports; preserve variable references; activation needs approval |
| `.worktreeinclude` | Path patterns | Worktree behavior, not instructions; inventoried only |
| `.claude-plugin/plugin.json` | Plugin JSON manifest | Extension-specific component paths; no proprietary mod support |
| `.claude-plugin/marketplace.json` | Marketplace JSON | Repository's catalog points to separate git-subdir sources; those sources unexamined |
| `~/.claude/keybindings.json`, themes | User-specific JSON/data | Recognize; do not assume compatibility with ShellGPT renderer |
| `~/.claude/projects/`, `~/.claude.json` | Private history/account/project state | Not read by default; dedicated selective importer required |

Settings use scalar precedence and additive lists, with documented special cases for model lists and security restrictions. Permission deny must dominate allow; a loader cannot claim enforcement merely by parsing strings. Unknown or unsupported security fields must prevent activation instead of being silently ignored.

Public-source findings: the pinned tree has examples for settings/MDM/hooks/gateways, three project command definitions, a marketplace catalog, GitHub workflows and many mods. No proprietary core implementation was inspected. Commands can contain shell interpolation; importing such text must not run it. Representative examples were read, not all mods or tests.

Documentation consulted: [directory](https://code.claude.com/docs/en/claude-directory), [settings](https://code.claude.com/docs/en/settings), [CLI](https://code.claude.com/docs/en/cli-reference), [hooks](https://code.claude.com/docs/en/hooks), [plugins](https://code.claude.com/docs/en/plugins). Web documents are mutable; retrieval date is recorded in the manifest, not asserted to match the pinned Git tree exactly.
