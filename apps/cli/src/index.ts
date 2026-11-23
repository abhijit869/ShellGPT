#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ShellGPTOrchestrator,
  classifyExecutionError,
} from '@shellgpt/core';
import type { ExecutionMode, PermissionMode, ApiFormat } from '@shellgpt/config';
import { BUILTIN_WORKER_ROLES, type WorkerRoleName } from '@shellgpt/agents';
import { ShellGPTTerminalUI, renderTerminalMarkdown, THEMES } from './tui.ts';

export const SHELLGPT_VERSION = '1.0.0';

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

export function getCliHelpText(): string {
  return `ShellGPT v${SHELLGPT_VERSION} — Multi-Agent AI Coding CLI (Antigravity + Codex + REA MCP + Universal Provider Gateway)

USAGE:
  shellgpt [options] [command] [args...]

CORE COMMANDS:
  shellgpt                       Launch interactive Terminal UI (or run prompt with -p)
  shellgpt init                  Initialize .shellgpt/ configuration and workspace instructions
  shellgpt chat                  Start interactive multi-agent terminal chat
  shellgpt ask <prompt>          Ask a read-only question without modifying files
  shellgpt run <prompt>          Execute an autonomous multi-step engineering task
  shellgpt exec <prompt>         Headless execution with optional --json output
  shellgpt version               Show ShellGPT and integrated runtime versions
  shellgpt help                  Display this command reference
  shellgpt doctor                Run comprehensive health diagnostics on all runtimes, providers, and MCP

PROVIDER COMMANDS:
  shellgpt provider list         List all configured LLM providers and endpoints
  shellgpt provider add <id> <baseUrl> [format] [model]
  shellgpt provider remove <id>  Remove a custom provider profile
  shellgpt provider test [id]    Test connectivity and authentication for providers
  shellgpt provider use <id>     Select active primary API provider
  shellgpt model list [provider] List available models
  shellgpt model use <model>     Set active model override

AGENT & BRAIN COMMANDS:
  shellgpt brain <cmd>           Unified brain selector (auto | antigravity | codex | api | local | status | fallback | reset)
  shellgpt agent list            List registered coding agents and worker roles
  shellgpt agent use <agent>     Pin primary brain (antigravity | codex | auto | custom | local)
  shellgpt agent status          Show detailed installation and authentication status
  shellgpt agent run <agent> <prompt>
  shellgpt agent delegate <from> <to> <objective>
  shellgpt agent cancel <taskId> Cancel a running agent task
  shellgpt agent logs            Display recent agent execution logs

MCP & REA COMMANDS:
  shellgpt mcp list              List configured MCP servers
  shellgpt mcp add <name> <commandOrUrl> [args...]
  shellgpt mcp remove <name>     Remove an MCP server
  shellgpt mcp test [name]       Connect and verify MCP server tool discovery
  shellgpt mcp doctor            Run full diagnostics across all configured MCP servers
  shellgpt rea status            Check REA (rea-agents) installation and MCP readiness
  shellgpt rea doctor            Run REA MCP doctor check (tools, prompts, catalog digest)
  shellgpt rea tools             List real discovered REA reverse-engineering tools
  shellgpt rea analyze [target]  Run authorized reverse-engineering analysis via REA MCP
  shellgpt rea report [target]   Generate structured markdown REA evidence report
  shellgpt rea engines           Inspect available reverse-engineering engines (Ghidra, Rizin, Babel, etc.)

SESSION COMMANDS:
  shellgpt session list          List persistent SQLite sessions for this workspace
  shellgpt session new [title]   Create and activate a new persistent session
  shellgpt session resume <id>   Resume an existing session
  shellgpt session fork <id>     Fork an existing session into a new branch
  shellgpt session rename <id> <title>
  shellgpt session search <query>
  shellgpt session export <id> [json|md]
  shellgpt session delete <id>   Delete a session and its associated history

DEVELOPMENT COMMANDS:
  shellgpt plan <prompt>         Inspect repository and generate a structured task plan
  shellgpt edit <file> <target> <replacement>
  shellgpt diff [file]           Show workspace git diff
  shellgpt review [target]       Run read-only code and security review
  shellgpt test [command]        Execute workspace test suite
  shellgpt build [command]       Execute workspace build
  shellgpt fix <error>           Classify and diagnose a build/test error using self-healing engine
  shellgpt undo [checkpointId]   Restore files from the most recent checkpoint

MANAGEMENT COMMANDS:
  shellgpt config                Show validated workspace configuration
  shellgpt skills                List discovered workspace, bundled, and ecosystem skills
  shellgpt plugins               List discovered plugins
  shellgpt hooks                 List registered lifecycle hooks
  shellgpt permissions [mode]    View or update permission mode (read-only|ask|workspace-write|trusted-automation|sandbox)
  shellgpt logs                  View redacted JSONL telemetry logs
  shellgpt usage                 Display observability and cost/token dashboard
  shellgpt update                Check runtime and package update status

GLOBAL OPTIONS:
  -p, --prompt <text>            Run a single prompt non-interactively
  --json                         Format output as structured JSON
  --workspace <dir>              Target workspace directory (defaults to CWD)
  --mode <mode>                  Execution mode override (ask|plan|edit|agent|review|auto)
  --agent <agent>                Agent override (antigravity|codex|auto|custom|local)
  --model <model>                Model override
`;
}

export async function runCli(
  argv: string[],
  options: { workspaceDir?: string; customConfigPath?: string } = {},
): Promise<CliResult> {
  const args = [...argv];
  let workspaceDir = options.workspaceDir || process.cwd();
  let jsonOutput = false;
  let promptFlag: string | undefined;
  let modeOverride: ExecutionMode | undefined;
  let agentOverride: string | undefined;
  let modelOverride: string | undefined;

  // Extract global flags
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') {
      jsonOutput = true;
    } else if (a === '--workspace' && args[i + 1]) {
      workspaceDir = path.resolve(args[++i]);
    } else if ((a === '-p' || a === '--prompt') && args[i + 1]) {
      promptFlag = args[++i];
    } else if (a === '--mode' && args[i + 1]) {
      modeOverride = args[++i] as ExecutionMode;
    } else if (a === '--agent' && args[i + 1]) {
      agentOverride = args[++i];
    } else if (a === '--model' && args[i + 1]) {
      modelOverride = args[++i];
    } else if (a === '-h' || a === '--help') {
      return { exitCode: 0, stdout: getCliHelpText() };
    } else if (a === '-v' || a === '--version') {
      return { exitCode: 0, stdout: `ShellGPT v${SHELLGPT_VERSION}` };
    } else {
      positional.push(a);
    }
  }

  const orchestrator = new ShellGPTOrchestrator(
    workspaceDir,
    options.customConfigPath,
  );
  const tui = new ShellGPTTerminalUI(orchestrator);

  try {
    if (promptFlag) {
      const res = await orchestrator.processUserRequest({
        prompt: promptFlag,
        mode: modeOverride,
        overrideAgent: agentOverride,
        overrideModel: modelOverride,
      });
      await orchestrator.mcp.disconnectAll();
      return {
        exitCode: 0,
        stdout: jsonOutput ? JSON.stringify(res, null, 2) : res.responseText,
      };
    }

    const cmd = positional[0]?.toLowerCase();
    const sub = positional[1]?.toLowerCase();

    if (!cmd || cmd === 'chat') {
      if (!process.stdin.isTTY) {
        const frame = await tui.renderDashboardFrame();
        await orchestrator.mcp.disconnectAll();
        return { exitCode: 0, stdout: frame };
      }
      await tui.startInteractiveLoop();
      return { exitCode: 0, stdout: '' };
    }

    if (cmd === 'help') {
      return { exitCode: 0, stdout: getCliHelpText() };
    }

    if (cmd === 'version') {
      const [agy, codex] = await Promise.all([
        orchestrator.antigravity.getStatus(),
        orchestrator.codex.getStatus(),
      ]);
      const rea = orchestrator.rea.detectBinary();
      const info = {
        shellgpt: SHELLGPT_VERSION,
        node: process.version,
        platform: process.platform,
        antigravity: agy.version || (agy.installed ? 'installed' : 'not-installed'),
        codex: codex.version || (codex.installed ? 'installed (symlink)' : 'not-installed'),
        rea: rea.version || 'not-installed',
      };
      return {
        exitCode: 0,
        stdout: jsonOutput
          ? JSON.stringify(info, null, 2)
          : `ShellGPT v${info.shellgpt} (Node ${info.node} on ${info.platform})\n- Antigravity: ${info.antigravity}\n- OpenAI Codex: ${info.codex}\n- REA MCP: ${info.rea}`,
      };
    }

    if (cmd === 'init') {
      orchestrator.configManager.save();
      const instrPath = path.join(workspaceDir, '.shellgpt', 'instructions.md');
      if (!fs.existsSync(instrPath)) {
        fs.writeFileSync(
          instrPath,
          `# ShellGPT Project Instructions\n\n- Follow workspace safety and verification rules.\n`,
          'utf8',
        );
      }
      return {
        exitCode: 0,
        stdout: `Initialized ShellGPT workspace in ${path.join(workspaceDir, '.shellgpt')}`,
      };
    }

    if (cmd === 'doctor') {
      const [caps, providerHealth, mcpDoctor, reaDoctor, route] = await Promise.all([
        orchestrator.getAgentCapabilities(),
        orchestrator.providers.checkAllHealth(),
        orchestrator.mcp.runDoctor(),
        orchestrator.rea.runDoctor(),
        orchestrator.resolveRoute(),
      ]);

      const report = {
        version: SHELLGPT_VERSION,
        workspace: workspaceDir,
        activeRoute: route,
        agents: caps,
        providers: providerHealth,
        mcpServers: mcpDoctor,
        rea: reaDoctor,
        skillsCount: orchestrator.skills.listSkills().length,
        sessionsCount: orchestrator.memory.listSessions().length,
      };

      if (jsonOutput) {
        return { exitCode: 0, stdout: JSON.stringify(report, null, 2) };
      }

      const lines = [
        `# ShellGPT System Doctor Report`,
        ``,
        `## 1. Active Routing Decision`,
        `- **Mode**: \`${route.mode}\``,
        `- **Primary Brain**: \`${route.primaryBrain}\` (Model: \`${route.activeModel}\`, Tier: ${route.priorityTierUsed})`,
        `- **Supporting Workers**: ${route.supportingAgents.join(', ') || 'none'}`,
        `- **Reason**: ${route.reason}`,
        ``,
        `## 2. Coding Agent Runtimes`,
        ...caps.map(
          (c) =>
            `- **${c.name}** (\`${c.id}\`): installed=${c.installed}, authenticated=${c.authenticated}, healthy=${c.healthy}\n  ${c.diagnostic}`,
        ),
        ``,
        `## 3. Universal Provider Gateway`,
        ...providerHealth.map(
          (p) =>
            `- **${p.providerId}**: healthy=${p.healthy}, authenticated=${p.authenticated} — ${p.diagnostic}`,
        ),
        ``,
        `## 4. MCP Servers & REA Integration`,
        ...mcpDoctor.map(
          (m) => `- **MCP:${m.server}**: healthy=${m.healthy}, tools=${m.toolCount} — ${m.detail}`,
        ),
        `- **REA Doctor**: ${reaDoctor.diagnostic}`,
        ``,
        `## 5. Memory & Extensibility`,
        `- **SQLite Sessions**: ${report.sessionsCount} session(s)`,
        `- **Registered Skills**: ${report.skillsCount} skill(s)`,
      ];
      return { exitCode: 0, stdout: lines.join('\n') };
    }

    if (cmd === 'ask' || cmd === 'run' || cmd === 'exec' || cmd === 'plan') {
      const prompt = positional.slice(1).join(' ');
      if (!prompt) {
        return { exitCode: 1, stdout: '', stderr: `Usage: shellgpt ${cmd} <prompt>` };
      }
      const modeMap: Record<string, ExecutionMode> = {
        ask: 'ask',
        plan: 'plan',
        run: 'agent',
        exec: modeOverride || 'auto',
      };
      const res = await orchestrator.processUserRequest({
        prompt,
        mode: modeMap[cmd],
        overrideAgent: agentOverride,
        overrideModel: modelOverride,
      });
      return {
        exitCode: 0,
        stdout: jsonOutput ? JSON.stringify(res, null, 2) : res.responseText,
      };
    }

    if (cmd === 'provider') {
      if (sub === 'list' || !sub) {
        const list = orchestrator.providers.listProviders().map((p) => p.profile);
        return {
          exitCode: 0,
          stdout: jsonOutput
            ? JSON.stringify(list, null, 2)
            : list
                .map(
                  (p) =>
                    `${p.id.padEnd(12)} | ${p.apiFormat.padEnd(10)} | ${(p.baseUrl || '(unset)').padEnd(38)} | model=${p.defaultModel || '(unset)'}`,
                )
                .join('\n'),
        };
      }
      if (sub === 'add') {
        const [, , id, baseUrl, format = 'openai', defaultModel = 'default', apiKeyEnv] = positional;
        if (!id || !baseUrl) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: [
              'Usage: shellgpt provider add <id> <baseUrl> [format] [defaultModel] [apiKeyEnv]',
              'Guided Wizard Fields:',
              '  1. Provider ID / Type (e.g., asemprotic, my-gateway, openai-compatible)',
              '  2. Endpoint Base URL (e.g., https://api.example.com/v1)',
              '  3. Protocol Format (openai | anthropic | gemini | ollama | custom)',
              '  4. Default Model Identifier',
              '  5. Credential Environment Variable Reference (stored in encrypted SecretStore, never plaintext config)',
            ].join('\n'),
          };
        }
        const keyEnvName =
          apiKeyEnv ||
          (id === 'asemprotic'
            ? 'ASEMPROTIC_API_KEY'
            : `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`);
        orchestrator.configManager.update((cfg) => {
          cfg.providers[id] = {
            id,
            name: id,
            type: id === 'asemprotic' ? 'asemprotic' : 'custom',
            enabled: true,
            baseUrl,
            apiFormat: format as ApiFormat,
            apiKeyEnv: keyEnvName,
            defaultModel,
            contextBudget: 128000,
            temperature: 0.2,
            maxOutputTokens: 4096,
            timeoutMs: 120000,
            streaming: true,
            billable: false,
          };
        });
        return {
          exitCode: 0,
          stdout: `Added provider "${id}" (${format} at ${baseUrl}, model=${defaultModel}, credentialRef=${keyEnvName}).`,
        };
      }
      if (sub === 'remove' && positional[2]) {
        const id = positional[2];
        orchestrator.providers.removeProvider(id);
        orchestrator.configManager.update((cfg) => {
          delete cfg.providers[id];
        });
        return { exitCode: 0, stdout: `Removed provider "${id}".` };
      }
      if (sub === 'test') {
        const targetId = positional[2];
        if (targetId) {
          const p = orchestrator.providers.getProvider(targetId);
          if (!p) return { exitCode: 1, stdout: '', stderr: `Provider "${targetId}" not found.` };
          const h = await p.healthCheck();
          return {
            exitCode: 0,
            stdout: jsonOutput ? JSON.stringify(h, null, 2) : `${h.providerId}: healthy=${h.healthy} — ${h.diagnostic}`,
          };
        }
        const all = await orchestrator.providers.checkAllHealth();
        return {
          exitCode: 0,
          stdout: jsonOutput
            ? JSON.stringify(all, null, 2)
            : all.map((h) => `${h.providerId}: healthy=${h.healthy} — ${h.diagnostic}`).join('\n'),
        };
      }
      if (sub === 'use' && positional[2]) {
        const id = positional[2];
        orchestrator.configManager.update((cfg) => {
          cfg.routing.activeProviderId = id;
          cfg.routing.explicitAgent = 'custom';
        });
        return { exitCode: 0, stdout: `Active provider set to "${id}".` };
      }
    }

    if (cmd === 'model') {
      if (sub === 'use' && positional[2]) {
        const m = positional[2];
        orchestrator.configManager.update((cfg) => {
          cfg.routing.activeModel = m;
        });
        return { exitCode: 0, stdout: `Active model set to "${m}".` };
      }
      const caps = await orchestrator.getAgentCapabilities();
      const models = caps.flatMap((c) => c.availableModels.map((m) => `${c.id}/${m}`));
      return {
        exitCode: 0,
        stdout: jsonOutput ? JSON.stringify(models, null, 2) : models.join('\n'),
      };
    }

    if (cmd === 'brain') {
      const validBrainCmds = [
        'auto',
        'antigravity',
        'codex',
        'api',
        'local',
        'status',
        'fallback',
        'reset',
      ] as const;
      const brainSub = (sub || 'status') as (typeof validBrainCmds)[number];
      if (!validBrainCmds.includes(brainSub)) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `Invalid brain command "${sub}". Usage: shellgpt brain <auto|antigravity|codex|api|local|status|fallback|reset>`,
        };
      }
      const res = await orchestrator.selectBrain(brainSub, positional[2]);
      return {
        exitCode: 0,
        stdout: jsonOutput ? JSON.stringify(res, null, 2) : res.output,
      };
    }

    if (cmd === 'agent') {
      if (sub === 'list' || !sub) {
        const caps = await orchestrator.getAgentCapabilities();
        const roles = Object.values(BUILTIN_WORKER_ROLES);
        if (jsonOutput) {
          return { exitCode: 0, stdout: JSON.stringify({ agents: caps, roles }, null, 2) };
        }
        return {
          exitCode: 0,
          stdout: [
            `# Registered Coding Agents`,
            ...caps.map((c) => `- **${c.id}** (${c.name}): installed=${c.installed}, auth=${c.authenticated} — ${c.diagnostic}`),
            ``,
            `# Configurable Worker Roles (${roles.length})`,
            ...roles.map((r) => `- **${r.role}** (default: ${r.preferredAgent}): ${r.description}`),
          ].join('\n'),
        };
      }
      if (sub === 'status') {
        const caps = await orchestrator.getAgentCapabilities();
        const route = await orchestrator.resolveRoute();
        return {
          exitCode: 0,
          stdout: jsonOutput
            ? JSON.stringify({ route, agents: caps }, null, 2)
            : `Primary Brain: ${route.primaryBrain} (${route.mode})\n` +
              caps.map((c) => `- ${c.id}: ${c.diagnostic}`).join('\n'),
        };
      }
      if (
        sub === 'use' &&
        positional[2] &&
        ['antigravity', 'codex', 'auto', 'custom', 'local'].includes(positional[2])
      ) {
        const target = positional[2] as 'antigravity' | 'codex' | 'auto' | 'custom' | 'local';
        const res = await orchestrator.switchAgent(target);
        return {
          exitCode: 0,
          stdout: `Switched primary agent to "${res.newRoute.primaryBrain}" (${res.newRoute.mode}).`,
        };
      }
      if (sub === 'run' && positional[2] && positional[3]) {
        const targetAgent = positional[2];
        const prompt = positional.slice(3).join(' ');
        const res = await orchestrator.processUserRequest({
          prompt,
          overrideAgent: targetAgent,
        });
        return {
          exitCode: 0,
          stdout: jsonOutput ? JSON.stringify(res, null, 2) : res.responseText,
        };
      }
      if (sub === 'delegate' && positional[2] && positional[3] && positional[4]) {
        const fromAgent = positional[2];
        const toAgent = positional[3];
        const objective = positional.slice(4).join(' ');
        const env = orchestrator.instructions.createDelegationEnvelope({
          parentSessionId: orchestrator.getActiveSession().id,
          requestedBy: fromAgent,
          assignedTo: toAgent,
          role: 'Backend Engineer' as WorkerRoleName,
          objective,
          scope: 'Workspace delegation',
          allowedPaths: ['.'],
          permissions: orchestrator.permissions.getMode(),
        });
        const outcome = await orchestrator.executeDelegatedEnvelope(env);
        return {
          exitCode: 0,
          stdout: jsonOutput
            ? JSON.stringify({ envelope: env, outcome }, null, 2)
            : `Delegated task ${env.task_id} (${fromAgent} -> ${toAgent}): status=${outcome.status}\n${outcome.summary}`,
        };
      }
      if (sub === 'cancel' && positional[2]) {
        const taskId = positional[2];
        const cancelled =
          orchestrator.antigravity.cancelTask(taskId) ||
          orchestrator.codex.cancelTask(taskId);
        return {
          exitCode: 0,
          stdout: cancelled ? `Cancelled task ${taskId}.` : `Task ${taskId} is not active.`,
        };
      }
      if (sub === 'logs') {
        const logs = orchestrator.telemetry.getRecentLogs(50);
        return {
          exitCode: 0,
          stdout: jsonOutput
            ? JSON.stringify(logs, null, 2)
            : logs.map((l) => `[${l.timestamp}] [${l.level}] [${l.component}] ${l.message}`).join('\n'),
        };
      }
    }

    if (cmd === 'mcp') {
      const slashRes = await tui.handleSlashCommand(`/mcp ${positional.slice(1).join(' ')}`);
      return { exitCode: 0, stdout: slashRes.output };
    }

    if (cmd === 'rea') {
      const slashRes = await tui.handleSlashCommand(`/rea ${positional.slice(1).join(' ')}`);
      return { exitCode: 0, stdout: slashRes.output };
    }

    if (cmd === 'session') {
      if (sub === 'list' || !sub) {
        const sessions = orchestrator.memory.listSessions();
        return {
          exitCode: 0,
          stdout: jsonOutput
            ? JSON.stringify(sessions, null, 2)
            : sessions
                .map((s) => `${s.id} | ${s.title} | agent=${s.primaryAgent} | updated=${s.updatedAt}`)
                .join('\n'),
        };
      }
      if (sub === 'new') {
        const title = positional.slice(2).join(' ') || 'New ShellGPT Session';
        const created = orchestrator.memory.createSession({ title });
        orchestrator.setActiveSession(created);
        return {
          exitCode: 0,
          stdout: jsonOutput
            ? JSON.stringify(created, null, 2)
            : `Created session ${created.id} (${created.title}).`,
        };
      }
      if (sub === 'rename' && positional[2] && positional[3]) {
        const newTitle = positional.slice(3).join(' ');
        const ok = orchestrator.memory.renameSession(positional[2], newTitle);
        return {
          exitCode: ok ? 0 : 1,
          stdout: ok ? `Renamed session ${positional[2]} to "${newTitle}".` : '',
          stderr: ok ? undefined : `Session "${positional[2]}" not found.`,
        };
      }
      if (sub === 'search' && positional[2]) {
        const query = positional.slice(2).join(' ');
        const hits = orchestrator.memory.searchHistory(query);
        return {
          exitCode: 0,
          stdout: jsonOutput
            ? JSON.stringify(hits, null, 2)
            : hits.map((m) => `[${m.sessionId}] (${m.role}) ${m.content}`).join('\n') ||
              `No messages matched "${query}".`,
        };
      }
      if (sub === 'resume' && positional[2]) {
        const sess = orchestrator.memory.getSession(positional[2]);
        if (!sess) return { exitCode: 1, stdout: '', stderr: `Session "${positional[2]}" not found.` };
        orchestrator.setActiveSession(sess);
        return { exitCode: 0, stdout: `Resumed session ${sess.id} (${sess.title}).` };
      }
      if (sub === 'fork' && positional[2]) {
        const forked = orchestrator.memory.forkSession(positional[2], positional[3]);
        if (!forked) return { exitCode: 1, stdout: '', stderr: `Session "${positional[2]}" not found.` };
        return {
          exitCode: 0,
          stdout: jsonOutput ? JSON.stringify(forked, null, 2) : `Forked session -> ${forked.id} (${forked.title}).`,
        };
      }
      if (sub === 'export' && positional[2]) {
        const fmt = positional[3] || 'json';
        const out =
          fmt === 'md' || fmt === 'markdown'
            ? orchestrator.memory.exportSessionMarkdown(positional[2])
            : orchestrator.memory.exportSessionJson(positional[2]);
        return { exitCode: 0, stdout: out };
      }
      if (sub === 'delete' && positional[2]) {
        const ok = orchestrator.memory.deleteSession(positional[2]);
        return {
          exitCode: ok ? 0 : 1,
          stdout: ok ? `Deleted session ${positional[2]}.` : '',
          stderr: ok ? undefined : `Session "${positional[2]}" not found.`,
        };
      }
    }

    if (cmd === 'diff') {
      return { exitCode: 0, stdout: orchestrator.toolkit.gitDiff(positional[1]) || '(no diff)' };
    }

    if (cmd === 'edit') {
      const [, file, target, replacement] = positional;
      if (!file || target === undefined || replacement === undefined) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'Usage: shellgpt edit <file> <target> <replacement>',
        };
      }
      orchestrator.permissions.setMode('workspace-write');
      const res = await orchestrator.toolkit.editFile(file, target, replacement, {
        sessionId: orchestrator.getActiveSession().id,
      });
      return {
        exitCode: 0,
        stdout: `Edited ${res.path} (${res.replacements} replacement(s), checkpoint=${res.checkpointId}).\n${res.diffPreview}`,
      };
    }

    if (cmd === 'review') {
      const diffText = orchestrator.toolkit.gitDiff(positional[1]);
      const status = orchestrator.toolkit.gitStatus();
      return {
        exitCode: 0,
        stdout: [
          `# ShellGPT Code & Security Review`,
          `- **Branch**: \`${status.branch}\` (${status.headCommit || 'HEAD'})`,
          `- **Modified Files**: ${status.modified.join(', ') || 'none'}`,
          `- **Diff Bytes**: ${diffText.length}`,
        ].join('\n'),
      };
    }

    if (cmd === 'test') {
      const testCmd = positional.slice(1).join(' ') || 'npm test';
      orchestrator.permissions.setMode('trusted-automation');
      const res = await orchestrator.toolkit.runCommand(testCmd);
      return {
        exitCode: res.exitCode ?? 1,
        stdout: res.stdout,
        stderr: res.stderr,
      };
    }

    if (cmd === 'build') {
      const buildCmd = positional.slice(1).join(' ') || 'npm run build';
      orchestrator.permissions.setMode('trusted-automation');
      const res = await orchestrator.toolkit.runCommand(buildCmd);
      return {
        exitCode: res.exitCode ?? 1,
        stdout: res.stdout,
        stderr: res.stderr,
      };
    }

    if (cmd === 'fix') {
      const errText = positional.slice(1).join(' ') || 'Unknown error';
      const classified = classifyExecutionError(errText);
      return {
        exitCode: 0,
        stdout: jsonOutput
          ? JSON.stringify(classified, null, 2)
          : `Self-Healing Diagnosis:\n- Classification: ${classified.classification}\n- Diagnosis: ${classified.diagnosis}`,
      };
    }

    if (cmd === 'undo') {
      const slashRes = await tui.handleSlashCommand(`/undo ${positional[1] || ''}`);
      return { exitCode: 0, stdout: slashRes.output };
    }

    if (cmd === 'config') {
      return {
        exitCode: 0,
        stdout: JSON.stringify(orchestrator.configManager.get(), null, 2),
      };
    }

    if (cmd === 'skills' || cmd === 'plugins' || cmd === 'hooks' || cmd === 'permissions') {
      const slashRes = await tui.handleSlashCommand(`/${positional.join(' ')}`);
      return { exitCode: 0, stdout: slashRes.output };
    }

    if (cmd === 'logs') {
      const logs = orchestrator.telemetry.getRecentLogs(50);
      return {
        exitCode: 0,
        stdout: jsonOutput
          ? JSON.stringify(logs, null, 2)
          : logs.map((l) => `[${l.timestamp}] [${l.level}] [${l.component}] ${l.message}`).join('\n'),
      };
    }

    if (cmd === 'usage') {
      const summary = orchestrator.telemetry.getDashboardSummary();
      return {
        exitCode: 0,
        stdout: JSON.stringify(summary, null, 2),
      };
    }

    if (cmd === 'update') {
      return {
        exitCode: 0,
        stdout: `ShellGPT v${SHELLGPT_VERSION} is up to date.`,
      };
    }

    return {
      exitCode: 1,
      stdout: '',
      stderr: `Unknown command "${cmd}". Run \`shellgpt help\` for usage.`,
    };
  } finally {
    await orchestrator.mcp.disconnectAll();
  }
}

// Execute when invoked directly as CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2))
    .then((res) => {
      if (res.stdout) {
        const formatted = res.stdout.startsWith('{') || res.stdout.startsWith('[')
          ? res.stdout
          : renderTerminalMarkdown(res.stdout, THEMES.dark);
        process.stdout.write(formatted + '\n');
      }
      if (res.stderr) {
        process.stderr.write(res.stderr + '\n');
      }
      process.exitCode = res.exitCode;
    })
    .catch((err) => {
      process.stderr.write(`Fatal error: ${(err as Error).message}\n`);
      process.exitCode = 1;
    });
}
