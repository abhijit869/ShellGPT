# License audit

Scope is the pinned repositories in upstream-commits.json, not a legal opinion or complete dependency clearance.

- Claude Code root LICENSE.md reserves rights and points to commercial terms. Its public repository is not permission to redistribute the proprietary implementation. ShellGPT compatibility code is independently authored from documented formats. No binary inspection, decompilation, copied UI assets or proprietary runtime redistribution.
- Hermes root LICENSE is MIT, copyright Nous Research (2025). A future substantial source adaptation must retain the full notice. This milestone vendors no Hermes code.
- Hermes `plugins/security-guidance/NOTICE` identifies Apache-2.0 material from Anthropic's separate plugin repository. Its LICENSE is Apache-2.0. Do not treat all files beneath Hermes as uniformly MIT.
- Recursive Git inventories enumerate other license/notice paths. Their contents, external package dependency trees, media assets, plugin catalog payloads and submodule targets have not all been audited. Reuse requires file-specific review and dependency/license checks first.
- Runtime subprocess/ACP integration leaves separately installed upstream software under its own distribution terms.

Evidence: [Claude pinned license](https://github.com/anthropics/claude-code/blob/50cdc7005318f630144c28217d1dada32e6ba762/LICENSE.md), [Hermes pinned license](https://github.com/NousResearch/hermes-agent/blob/b4bacb9569727b0fb9b92685a25690fa50ccc5ea/LICENSE), [Hermes third-party notice](https://github.com/NousResearch/hermes-agent/blob/b4bacb9569727b0fb9b92685a25690fa50ccc5ea/plugins/security-guidance/NOTICE).
