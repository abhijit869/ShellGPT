import * as readline from 'node:readline';
import * as path from 'node:path';
import {
  ShellGPTOrchestrator,
  type RouteDecision,
} from '@shellgpt/core';
import type { ExecutionMode, PermissionMode } from '@shellgpt/config';
import { estimateTokens } from '@shellgpt/memory';

export interface ThemePalette {
  name: 'dark' | 'light' | 'custom';
  border: string;
  headerBg: string;
  accent: string;
  muted: string;
  success: string;
  warning: string;
  error: string;
  code: string;
  path: string;
  reset: string;
}

export const THEMES: Record<'dark' | 'light' | 'custom', ThemePalette> = {
  dark: {
    name: 'dark',
    border: '\x1b[38;5;240m',
    headerBg: '\x1b[1;36m',
    accent: '\x1b[38;5;75m',
    muted: '\x1b[38;5;245m',
    success: '\x1b[38;5;82m',
    warning: '\x1b[38;5;214m',
    error: '\x1b[38;5;196m',
    code: '\x1b[38;5;222m',
    path: '\x1b[4;38;5;117m',
    reset: '\x1b[0m',
  },
  light: {
    name: 'light',
    border: '\x1b[38;5;250m',
    headerBg: '\x1b[1;34m',
    accent: '\x1b[38;5;25m',
    muted: '\x1b[38;5;242m',
    success: '\x1b[38;5;28m',
    warning: '\x1b[38;5;166m',
    error: '\x1b[38;5;160m',
    code: '\x1b[38;5;130m',
    path: '\x1b[4;38;5;24m',
    reset: '\x1b[0m',
  },
  custom: {
    name: 'custom',
    border: '\x1b[38;5;99m',
    headerBg: '\x1b[1;35m',
    accent: '\x1b[38;5;141m',
    muted: '\x1b[38;5;246m',
    success: '\x1b[38;5;48m',
    warning: '\x1b[38;5;220m',
    error: '\x1b[38;5;203m',
    code: '\x1b[38;5;183m',
    path: '\x1b[4;38;5;147m',
    reset: '\x1b[0m',
  },
};

export const SLASH_COMMANDS = [
  '/brain auto',
  '/brain antigravity',
  '/brain codex',
  '/brain api',
  '/brain local',
  '/brain status',
  '/brain fallback',
  '/brain reset',
  '/agent antigravity',
  '/agent codex',
  '/agent auto',
  '/agent custom',
  '/agent local',
  '/agent status',
  '/agent list',
  '/agent route',
  '/model',
  '/provider',
  '/provider test',
  '/provider priority',
  '/provider fallback',
  '/mcp list',
  '/mcp add',
  '/mcp remove',
  '/mcp enable',
  '/mcp disable',
  '/mcp test',
  '/mcp tools',
  '/mcp resources',
  '/mcp logs',
  '/mcp doctor',
  '/rea status',
  '/rea doctor',
  '/rea tools',
  '/rea analyze',
  '/rea report',
  '/rea configure',
  '/rea engines',
  '/mode',
  '/permissions',
  '/skills',
  '/hooks',
  '/plugins',
  '/session list',
  '/session new',
  '/session resume',
  '/session fork',
  '/session rename',
  '/session search',
  '/session export',
  '/session delete',
  '/compact',
  '/checkpoint',
  '/undo',
  '/dashboard',
  '/theme',
  '/help',
  '/exit',
  '/quit',
];

/**
 * Formats markdown, code blocks, and file paths for rich terminal display.
 */
export function renderTerminalMarkdown(text: string, theme: ThemePalette): string {
  const lines = text.split(/\r?\n/);
  let inCodeBlock = false;
  const rendered: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      rendered.push(`${theme.border}${line}${theme.reset}`);
      continue;
    }
    if (inCodeBlock) {
      rendered.push(`  ${theme.code}${line}${theme.reset}`);
      continue;
    }
    if (/^#{1,3}\s+/.test(line)) {
      rendered.push(`${theme.headerBg}${line}${theme.reset}`);
      continue;
    }
    // Highlight file paths
    const withPaths = line.replace(
      /\b((?:\.\/|\/)?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+\.(?:ts|js|py|json|yaml|md|sh))\b/g,
      `${theme.path}$1${theme.reset}`,
    );
    rendered.push(withPaths);
  }

  return rendered.join('\n');
}

export class ShellGPTTerminalUI {
  private readonly orchestrator: ShellGPTOrchestrator;
  private theme: ThemePalette;
  private agentStates: {
    antigravity: 'idle' | 'running' | 'blocked' | 'disabled' | 'unverified';
    codex: 'idle' | 'running' | 'blocked' | 'disabled' | 'unverified';
    customApi: 'connected' | 'disconnected';
    mcpServers: 'active' | 'failed' | 'disconnected';
  } = {
    antigravity: 'unverified',
    codex: 'unverified',
    customApi: 'disconnected',
    mcpServers: 'disconnected',
  };

  constructor(orchestrator: ShellGPTOrchestrator) {
    this.orchestrator = orchestrator;
    const cfgTheme = orchestrator.configManager.get().general.theme;
    this.theme = THEMES[cfgTheme] || THEMES.dark;
  }

  public async renderDashboardFrame(route?: RouteDecision): Promise<string> {
    const activeRoute = route || (await this.orchestrator.resolveRoute());
    const cfg = this.orchestrator.configManager.get();
    const session = this.orchestrator.getActiveSession();
    const messages = this.orchestrator.memory.getMessages(session.id);
    const contextTokens = messages.reduce((sum, m) => sum + m.tokenEstimate, 0) + estimateTokens(session.summary);
    const dash = this.orchestrator.telemetry.getDashboardSummary();
    const mcpStatuses = this.orchestrator.mcp.getAllStatuses();
    const anyMcpFailed = mcpStatuses.some((s) => s.enabled && Boolean(s.lastError));

    this.agentStates.customApi =
      activeRoute.mode === 'MODE_A_CUSTOM_API' ? 'connected' : 'disconnected';
    const connectedMcp = mcpStatuses.filter(s => s.connected).length;
    this.agentStates.mcpServers = anyMcpFailed ? 'failed' : connectedMcp > 0 ? 'active' : 'disconnected';
    if (!cfg.agents.antigravity.enabled) this.agentStates.antigravity = 'disabled';
    if (!cfg.agents.codex.enabled) this.agentStates.codex = 'disabled';

    const t = this.theme;
    const width = Math.max(76, Math.min(110, process.stdout.columns || 90));
    const hr = `${t.border}${'─'.repeat(width)}${t.reset}`;

    const costDisplay =
      dash.measuredCostUsd > 0
        ? `$${dash.measuredCostUsd.toFixed(4)} (measured)`
        : dash.estimatedCostUsd > 0
          ? `~$${dash.estimatedCostUsd.toFixed(4)} (estimated)`
          : 'unavailable';

    const header = [
      hr,
      `${t.headerBg} SHELLGPT — Autonomous AI Coding Environment (v1.0.0) ${t.reset}`,
      ` Workspace: ${t.path}${path.basename(this.orchestrator.workspaceDir) || this.orchestrator.workspaceDir}${t.reset} ${t.muted}|${t.reset} Brain: ${t.accent}${activeRoute.primaryBrain}${t.reset} (${activeRoute.mode}) ${t.muted}|${t.reset} Subagent: ${t.accent}${activeRoute.supportingAgents.join(', ') || 'none'}${t.reset}`,
      ` Provider : ${t.accent}${cfg.routing.enableAutomaticFallback ? 'Auto fallback' : 'Pinned'}${t.reset} (Model: ${t.accent}${activeRoute.activeModel}${t.reset}) ${t.muted}|${t.reset} MCP: ${connectedMcp} connected${anyMcpFailed ? ' (errors)' : ''}`,
      hr,
    ].join('\n');

    const agentPanel = [
      `${t.headerBg} [AGENT & RUNTIME PANEL] ${t.reset}`,
      `  • Antigravity : ${this.formatState(this.agentStates.antigravity)}`,
      `  • OpenAI Codex: ${this.formatState(this.agentStates.codex)}`,
      `  • Custom API  : ${this.formatState(this.agentStates.customApi)}`,
      `  • MCP Servers : ${this.formatState(this.agentStates.mcpServers)} (${mcpStatuses.filter((s) => s.enabled).length} configured)`,
      `  • Active Tasks: ${dash.activeTasks} running / ${dash.totalTasks} total`,
      hr,
    ].join('\n');

    const footer = [
      ` Mode: ${t.accent}${cfg.general.executionMode}${t.reset} ${t.muted}|${t.reset} Permissions: ${t.warning}${this.orchestrator.permissions.getMode()}${t.reset} ${t.muted}|${t.reset} Context: ${contextTokens}/${cfg.memory.maxContextTokens} tok ${t.muted}|${t.reset} Cost: ${costDisplay}`,
      ` ${t.muted}Shortcuts: /help | /agent <name> | /mcp doctor | /rea status | /mode <mode> | Ctrl+C cancel | /exit${t.reset}`,
      hr,
    ].join('\n');

    return `${header}\n${agentPanel}\n${footer}`;
  }

  private formatState(state: string): string {
    const t = this.theme;
    if (state === 'running' || state === 'connected' || state === 'active') {
      return `${t.success}${state}${t.reset}`;
    }
    if (state === 'blocked' || state === 'failed') {
      return `${t.error}${state}${t.reset}`;
    }
    return `${t.muted}${state}${t.reset}`;
  }

  /**
   * Executes an interactive slash command and returns a formatted output string.
   */
  public async handleSlashCommand(rawInput: string): Promise<{
    handled: boolean;
    shouldExit?: boolean;
    output: string;
  }> {
    const trimmed = rawInput.trim();
    if (!trimmed.startsWith('/')) {
      return { handled: false, output: '' };
    }

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const sub = parts[1]?.toLowerCase();
    const arg2 = parts[2];

    if (cmd === '/exit' || cmd === '/quit') {
      return { handled: true, shouldExit: true, output: 'Exiting ShellGPT. Session saved.' };
    }

    if (cmd === '/help') {
      return {
        handled: true,
        output: [
          `# ShellGPT Interactive Slash Commands`,
          `- **/brain auto | antigravity | codex | api | local | status | fallback | reset** — Unified Brain Selector`,
          `- **/agent antigravity | codex | auto | custom | local** — Switch primary brain`,
          `- **/agent status | list | route** — Inspect agent status, capabilities, and active route`,
          `- **/model [model-id]** — View or switch active model`,
          `- **/provider [list | test | priority | fallback]** — Manage Universal Provider Gateway`,
          `- **/mcp list | add | remove | enable | disable | test | tools | resources | logs | doctor** — Manage MCP servers`,
          `- **/rea status | doctor | tools | analyze | report | configure | engines** — REA Reverse Engineering commands`,
          `- **/session [list | new | resume | fork | rename | search | export | delete]** — Manage SQLite conversations`,
          `- **/mode <ask|plan|edit|agent|review|auto>** — Change execution mode`,
          `- **/permissions <read-only|ask|workspace-write|trusted-automation|sandbox>** — Change permission policy`,
          `- **/skills | /hooks | /plugins** — Inspect registered extensibility modules`,
          `- **/compact** — Compact active session context`,
          `- **/checkpoint [label] | /undo [checkpoint-id]** — Create or restore file checkpoint`,
          `- **/dashboard** — Show observability & cost dashboard`,
          `- **/theme <dark|light|custom>** — Switch TUI theme`,
          `- **/exit | /quit** — Save session and exit`,
        ].join('\n'),
      };
    }

    if (cmd === '/brain') {
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
          handled: true,
          output: `Invalid /brain command "${sub}". Choose one of: ${validBrainCmds.join(', ')}`,
        };
      }
      const res = await this.orchestrator.selectBrain(brainSub, arg2);
      return {
        handled: true,
        output: res.output,
      };
    }

    if (cmd === '/session') {
      if (!sub || sub === 'list') {
        const sessions = this.orchestrator.memory.listSessions();
        return {
          handled: true,
          output:
            sessions
              .map(
                (s) =>
                  `- **${s.id}** | ${s.title} | brain=\`${s.primaryAgent}\` | updated=${s.updatedAt}`,
              )
              .join('\n') || 'No sessions found.',
        };
      }
      if (sub === 'new') {
        const title = parts.slice(2).join(' ') || 'New ShellGPT Session';
        const created = this.orchestrator.memory.createSession({ title });
        this.orchestrator.setActiveSession(created);
        return {
          handled: true,
          output: `Created and activated session ${created.id} ("${created.title}").`,
        };
      }
      if (sub === 'resume' && arg2) {
        const sess = this.orchestrator.memory.getSession(arg2);
        if (!sess) return { handled: true, output: `Session "${arg2}" not found.` };
        this.orchestrator.setActiveSession(sess);
        return {
          handled: true,
          output: `Resumed session ${sess.id} ("${sess.title}").`,
        };
      }
      if (sub === 'fork') {
        const targetId = arg2 || this.orchestrator.getActiveSession().id;
        const forked = this.orchestrator.memory.forkSession(targetId, parts.slice(3).join(' ') || undefined);
        if (!forked) return { handled: true, output: `Session "${targetId}" not found.` };
        return {
          handled: true,
          output: `Forked session -> ${forked.id} ("${forked.title}").`,
        };
      }
      if (sub === 'rename' && arg2 && parts[3]) {
        const newTitle = parts.slice(3).join(' ');
        const ok = this.orchestrator.memory.renameSession(arg2, newTitle);
        return {
          handled: true,
          output: ok
            ? `Renamed session ${arg2} to "${newTitle}".`
            : `Session "${arg2}" not found.`,
        };
      }
      if (sub === 'search' && arg2) {
        const query = parts.slice(2).join(' ');
        const hits = this.orchestrator.memory.searchHistory(query);
        return {
          handled: true,
          output:
            hits.length > 0
              ? `Found ${hits.length} message(s) matching "${query}":\n` +
                hits
                  .slice(0, 15)
                  .map(
                    (m) =>
                      `- [${m.sessionId}] (${m.role}): ${m.content.replace(/\s+/g, ' ').slice(0, 140)}`,
                  )
                  .join('\n')
              : `No messages matched "${query}".`,
        };
      }
      if (sub === 'export') {
        const targetId = arg2 || this.orchestrator.getActiveSession().id;
        const fmt = parts[3] || 'md';
        const out =
          fmt === 'json'
            ? this.orchestrator.memory.exportSessionJson(targetId)
            : this.orchestrator.memory.exportSessionMarkdown(targetId);
        return { handled: true, output: out };
      }
      if (sub === 'delete' && arg2) {
        const ok = this.orchestrator.memory.deleteSession(arg2);
        return {
          handled: true,
          output: ok ? `Deleted session ${arg2}.` : `Session "${arg2}" not found.`,
        };
      }
    }

    if (cmd === '/agent') {
      if (
        sub === 'antigravity' ||
        sub === 'codex' ||
        sub === 'auto' ||
        sub === 'custom' ||
        sub === 'local'
      ) {
        const switched = await this.orchestrator.switchAgent(sub, arg2);
        return {
          handled: true,
          output: [
            `Switched primary brain from "${switched.previousAgent}" to "${switched.newRoute.primaryBrain}" (Mode: ${switched.newRoute.mode}, Model: ${switched.newRoute.activeModel}).`,
            `Context transfer summary preserved (${switched.transferSummary.recentConversation.length} recent turns, ${switched.transferSummary.modifiedFiles.length} modified files).`,
          ].join('\n'),
        };
      }

      if (sub === 'route') {
        const route = await this.orchestrator.resolveRoute();
        return {
          handled: true,
          output: JSON.stringify(route, null, 2),
        };
      }

      const caps = await this.orchestrator.getAgentCapabilities();
      return {
        handled: true,
        output: caps
          .map(
            (c) =>
              `- **${c.name}** (\`${c.id}\`): installed=${c.installed}, authenticated=${c.authenticated}, healthy=${c.healthy}\n  Runtime: ${c.runtime}\n  Diagnostic: ${c.diagnostic}`,
          )
          .join('\n'),
      };
    }

    if (cmd === '/model') {
      if (sub) {
        this.orchestrator.configManager.update((cfg) => {
          cfg.routing.activeModel = parts[1];
        });
        return {
          handled: true,
          output: `Active model set to "${parts[1]}".`,
        };
      }
      const route = await this.orchestrator.resolveRoute();
      return {
        handled: true,
        output: `Active model: ${route.activeModel} (Primary brain: ${route.primaryBrain})`,
      };
    }

    if (cmd === '/provider') {
      if (sub === 'test') {
        const healths = await this.orchestrator.providers.checkAllHealth();
        return {
          handled: true,
          output: healths
            .map(
              (h) =>
                `- **${h.providerId}**: healthy=${h.healthy}, auth=${h.authenticated} — ${h.diagnostic}`,
            )
            .join('\n'),
        };
      }
      if (sub === 'priority') {
        const prio = this.orchestrator.configManager.get().routing.providerPriority;
        return {
          handled: true,
          output: `Provider routing priority: ${prio.join(' -> ')}`,
        };
      }
      if (sub === 'fallback') {
        const r = this.orchestrator.configManager.get().routing;
        return {
          handled: true,
          output: `Fallback policy: preferAntigravityWhenNoApi=${r.preferAntigravityWhenNoApi}, fallbackToCodex=${r.fallbackToCodex}, allowLocalModelRecovery=${r.allowLocalModelRecovery}, allowBillableFallback=${r.allowBillableFallback}`,
        };
      }
      const list = this.orchestrator.providers.listProviders();
      return {
        handled: true,
        output: list
          .map(
            (p) =>
              `- **${p.id}** (${p.profile.name}): format=${p.profile.apiFormat}, baseUrl=${p.profile.baseUrl || '(unset)'}, defaultModel=${p.profile.defaultModel || '(unset)'}`,
          )
          .join('\n'),
      };
    }

    if (cmd === '/mcp') {
      if (sub === 'doctor' || sub === 'test') {
        const reports = await this.orchestrator.mcp.runDoctor();
        return {
          handled: true,
          output: reports
            .map(
              (r) =>
                `- **${r.server}**: healthy=${r.healthy}, tools=${r.toolCount} — ${r.detail}`,
            )
            .join('\n'),
        };
      }
      if (sub === 'tools') {
        await this.orchestrator.mcp.runDoctor();
        const tools = this.orchestrator.mcp.getDiscoveredTools();
        return {
          handled: true,
          output: `Discovered ${tools.length} MCP tools:\n` +
            tools.slice(0, 30).map((t) => `- \`${t.qualifiedName}\`: ${t.description || ''}`).join('\n') +
            (tools.length > 30 ? `\n...and ${tools.length - 30} more.` : ''),
        };
      }
      if (sub === 'resources') {
        const res = this.orchestrator.mcp.getDiscoveredResources();
        return {
          handled: true,
          output: `Discovered ${res.length} MCP resources.`,
        };
      }
      if (sub === 'logs') {
        const logs = this.orchestrator.mcp.getLogs(20);
        return {
          handled: true,
          output: logs.map((l) => `[${l.timestamp}] [${l.server}] ${l.message}`).join('\n') || 'No MCP logs.',
        };
      }
      if (sub === 'enable' && arg2) {
        const ok = this.orchestrator.mcp.setServerEnabled(arg2, true);
        return { handled: true, output: ok ? `Enabled MCP server "${arg2}".` : `Server "${arg2}" not found.` };
      }
      if (sub === 'disable' && arg2) {
        const ok = this.orchestrator.mcp.setServerEnabled(arg2, false);
        return { handled: true, output: ok ? `Disabled MCP server "${arg2}".` : `Server "${arg2}" not found.` };
      }
      if (sub === 'remove' && arg2) {
        const ok = this.orchestrator.mcp.removeServer(arg2);
        return { handled: true, output: ok ? `Removed MCP server "${arg2}".` : `Server "${arg2}" not found.` };
      }
      if (sub === 'add' && arg2 && parts[3]) {
        const isUrl = /^https?:\/\//i.test(parts[3]);
        this.orchestrator.mcp.addServer({
          name: arg2,
          transport: isUrl ? 'streamable-http' : 'stdio',
          command: isUrl ? undefined : parts[3],
          args: isUrl ? undefined : parts.slice(4),
          url: isUrl ? parts[3] : undefined,
          enabled: true,
        });
        return { handled: true, output: `Added MCP server "${arg2}".` };
      }
      const statuses = this.orchestrator.mcp.getAllStatuses();
      return {
        handled: true,
        output: statuses
          .map(
            (s) =>
              `- **${s.name}** (${s.transport}): enabled=${s.enabled}, connected=${s.connected}, tools=${s.toolCount}`,
          )
          .join('\n') || 'No MCP servers configured.',
      };
    }

    if (cmd === '/rea') {
      if (sub === 'doctor' || sub === 'status') {
        const doc = await this.orchestrator.rea.runDoctor();
        return {
          handled: true,
          output: [
            `# REA MCP Status`,
            `- **Installed**: ${doc.installed} (${doc.version || 'N/A'})`,
            `- **Binary**: \`${doc.binaryPath || 'N/A'}\``,
            `- **MCP Healthy**: ${doc.mcpHealthy}`,
            `- **Verified Tools**: ${doc.observedTools}`,
            `- **Verified Prompts**: ${doc.observedPrompts}`,
            `- **Request Flow OK**: ${doc.requestFlowOk}`,
            `- **Diagnostic**: ${doc.diagnostic}`,
          ].join('\n'),
        };
      }
      if (sub === 'engines') {
        const engines = this.orchestrator.rea.detectEngines();
        return {
          handled: true,
          output: engines
            .map(
              (e) =>
                `- **${e.name}**: available=${e.available} (${e.pathOrDetail})\n  Capabilities: ${e.capabilities.join(', ')}`,
            )
            .join('\n'),
        };
      }
      if (sub === 'tools') {
        const tools = await this.orchestrator.rea.discoverLiveReaTools();
        return {
          handled: true,
          output: `REA exposes ${tools.length} verified MCP tools:\n` +
            tools.slice(0, 35).map((t) => `- \`${t.name}\`: ${t.description || ''}`).join('\n') +
            (tools.length > 35 ? `\n...and ${tools.length - 35} more.` : ''),
        };
      }
      if (sub === 'analyze' || sub === 'report') {
        const ev = await this.orchestrator.rea.analyzeTarget({
          targetPath: arg2,
          explicitAuthorization: true,
        });
        return {
          handled: true,
          output: this.orchestrator.rea.generateReport([ev]),
        };
      }
      if (sub === 'configure') {
        this.orchestrator.rea.ensureRegisteredInMcp();
        return {
          handled: true,
          output: 'REA MCP server configuration verified and registered in ShellGPT.',
        };
      }
      const doc = await this.orchestrator.rea.runDoctor();
      return { handled: true, output: doc.diagnostic };
    }

    if (cmd === '/mode' && sub) {
      const validModes: ExecutionMode[] = ['ask', 'plan', 'edit', 'agent', 'review', 'auto'];
      if (validModes.includes(sub as ExecutionMode)) {
        this.orchestrator.configManager.update((cfg) => {
          cfg.general.executionMode = sub as ExecutionMode;
        });
        return { handled: true, output: `Execution mode set to "${sub}".` };
      }
      return { handled: true, output: `Invalid mode. Choose one of: ${validModes.join(', ')}` };
    }

    if (cmd === '/permissions' && sub) {
      const validPerms: PermissionMode[] = [
        'read-only',
        'ask',
        'workspace-write',
        'trusted-automation',
        'sandbox',
      ];
      if (validPerms.includes(sub as PermissionMode)) {
        this.orchestrator.permissions.setMode(sub as PermissionMode);
        this.orchestrator.configManager.update((cfg) => {
          cfg.general.defaultPermissionMode = sub as PermissionMode;
        });
        return { handled: true, output: `Permission mode updated to "${sub}".` };
      }
      return { handled: true, output: `Invalid permission mode. Choose: ${validPerms.join(', ')}` };
    }

    if (cmd === '/skills') {
      const skills = this.orchestrator.skills.listSkills();
      return {
        handled: true,
        output: `Loaded ${skills.length} skills:\n` +
          skills.map((s) => `- **${s.name}** (${s.namespace}): ${s.description}`).join('\n'),
      };
    }

    if (cmd === '/hooks') {
      const hooks = this.orchestrator.hooks.listHooks();
      return {
        handled: true,
        output: hooks.length > 0
          ? hooks.map((h) => `- **${h.name}**: enabled=${h.enabled}, trusted=${h.trusted}, events=[${h.events.join(', ')}]`).join('\n')
          : 'No lifecycle hooks registered.',
      };
    }

    if (cmd === '/plugins') {
      const plugins = this.orchestrator.plugins.listPlugins();
      return {
        handled: true,
        output: plugins.length > 0
          ? plugins.map((p) => `- **${p.name}** (${p.id}): enabled=${p.enabled}, skills=${p.skillsCount}`).join('\n')
          : 'No plugins installed.',
      };
    }

    if (cmd === '/compact') {
      const session = this.orchestrator.getActiveSession();
      const res = this.orchestrator.memory.compactSessionContext(session.id, 100, 2);
      return {
        handled: true,
        output: `Context compaction complete: compacted=${res.compacted} (${res.tokensBefore} -> ${res.tokensAfter} tokens).`,
      };
    }

    if (cmd === '/checkpoint') {
      const session = this.orchestrator.getActiveSession();
      const files = this.orchestrator.toolkit.gitStatus().modified;
      const cp = this.orchestrator.memory.createCheckpoint(
        session.id,
        parts.slice(1).join(' ') || 'Manual checkpoint',
        files,
      );
      return {
        handled: true,
        output: `Created checkpoint ${cp.id} (${Object.keys(cp.filesSnapshot).length} files snapshotted).`,
      };
    }

    if (cmd === '/undo') {
      const session = this.orchestrator.getActiveSession();
      const cps = this.orchestrator.memory.listCheckpoints(session.id);
      const targetId = parts[1] || cps[0]?.id;
      if (!targetId) {
        return { handled: true, output: 'No checkpoints found for active session.' };
      }
      const restored = this.orchestrator.memory.restoreCheckpoint(targetId);
      return {
        handled: true,
        output: `Restored checkpoint ${targetId}: ${restored.restoredFiles.length} file(s) restored, ${restored.deletedFiles.length} file(s) removed.`,
      };
    }

    if (cmd === '/dashboard') {
      const summary = this.orchestrator.telemetry.getDashboardSummary();
      return {
        handled: true,
        output: JSON.stringify(summary, null, 2),
      };
    }

    if (cmd === '/theme' && sub) {
      if (sub === 'dark' || sub === 'light' || sub === 'custom') {
        this.theme = THEMES[sub];
        this.orchestrator.configManager.update((cfg) => {
          cfg.general.theme = sub;
        });
        return { handled: true, output: `Switched TUI theme to "${sub}".` };
      }
    }

    return {
      handled: true,
      output: `Unknown slash command "${cmd}". Type /help for available commands.`,
    };
  }

  /**
   * Launches the interactive Terminal UI loop.
   */
  public async startInteractiveLoop(): Promise<void> {
    console.log(await this.renderDashboardFrame());
    console.log(
      `${this.theme.muted}Type a prompt or slash command (e.g., /help, /agent status, /rea status, /exit).${this.theme.reset}`,
    );

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${this.theme.accent}shellgpt>${this.theme.reset} `,
      completer: (line: string) => {
        const hits = SLASH_COMMANDS.filter((c) => c.startsWith(line));
        return [hits.length ? hits : SLASH_COMMANDS, line];
      },
    });

    rl.prompt();

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        rl.prompt();
        continue;
      }

      if (trimmed.startsWith('/')) {
        const res = await this.handleSlashCommand(trimmed);
        console.log(renderTerminalMarkdown(res.output, this.theme));
        if (res.shouldExit) {
          rl.close();
          break;
        }
        rl.prompt();
        continue;
      }

      this.agentStates.antigravity = 'running';
      const turnRes = await this.orchestrator.processUserRequest({
        prompt: trimmed,
        onStage: (stage, detail) => {
          console.log(`${this.theme.muted}  [${stage}] ${detail}${this.theme.reset}`);
        },
      });
      this.agentStates.antigravity = 'idle';

      console.log('\n' + renderTerminalMarkdown(turnRes.responseText, this.theme) + '\n');
      rl.prompt();
    }

    await this.orchestrator.mcp.disconnectAll();
  }
}
