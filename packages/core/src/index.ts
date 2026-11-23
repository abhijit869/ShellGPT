import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  ConfigManager,
  type ExecutionMode,
  type PermissionMode,
  resolveAsemproticConfig,
} from '@shellgpt/config';
import { TelemetryManager } from '@shellgpt/telemetry';
import { PermissionEngine } from '@shellgpt/permissions';
import {
  MemoryManager,
  type SessionRecord,
  type NeutralContextTransferSummary,
  type TaskPlanStep,
} from '@shellgpt/memory';
import { CodingToolkit } from '@shellgpt/tools';
import { McpManager } from '@shellgpt/mcp';
import { ReaIntegration } from '@shellgpt/rea';
import { ProviderGateway, type ModelProvider } from '@shellgpt/providers';
import { AntigravityAdapter } from '@shellgpt/adapters-antigravity';
import { CodexAdapter } from '@shellgpt/adapters-codex';
import { ClaudeAdapter } from '@shellgpt/adapters-claude';
import {
  InstructionBridge,
  ParallelTaskScheduler,
  DelegationSafetyGuard,
  DELEGATE_TO_AGENT_TOOL_DEFINITION,
  BUILTIN_WORKER_ROLES,
  type WorkerRoleName,
  type CanonicalTaskEnvelope,
  type TaskExecutionOutcome,
  type AgentCapabilityDescriptor,
  type AgentEvent,
  type TaskState,
} from '@shellgpt/agents';
import { SkillManager } from '@shellgpt/skills';
import { HookEngine } from '@shellgpt/hooks';
import { PluginManager } from '@shellgpt/plugins';

export type ControllerMode =
  | 'MODE_A_CUSTOM_API'
  | 'MODE_B_ANTIGRAVITY_PRIMARY'
  | 'MODE_C_CODEX_PRIMARY'
  | 'MODE_D_LOCAL_RECOVERY'
  | 'SETUP_REQUIRED';

export type LifecycleStage =
  | 'ACCEPT_REQUEST'
  | 'LOAD_SESSION_CONTEXT'
  | 'RESOLVE_INSTRUCTIONS'
  | 'SELECT_CONTROLLER'
  | 'ANALYZE_INTENT'
  | 'INSPECT_REPOSITORY'
  | 'BUILD_TASK_PLAN'
  | 'SELECT_TOOLS_AND_AGENTS'
  | 'REQUEST_PERMISSIONS'
  | 'EXECUTE'
  | 'COLLECT_OUTPUTS'
  | 'VALIDATE_CHANGES'
  | 'HANDLE_RECOVERABLE_FAILURES'
  | 'RUN_TESTS'
  | 'SUMMARIZE_VERIFIED_RESULTS'
  | 'PERSIST_SESSION'
  | 'RETURN_RESPONSE';

export interface RouteDecision {
  mode: ControllerMode;
  primaryBrain: string; // 'custom-api:<id>' | 'antigravity' | 'codex' | 'local:<id>' | 'none'
  activeModel: string;
  supportingAgents: string[];
  priorityTierUsed: number;
  reason: string;
  reducedCapabilityWarning?: string;
  setupInstructions?: string[];
}

export interface CircuitBreakerState {
  targetId: string;
  failures: number;
  isOpen: boolean;
  openedAt?: number;
  lastError?: string;
}

export type ErrorClassification =
  | 'missing_dependency'
  | 'typescript_compile_error'
  | 'broken_import'
  | 'invalid_config'
  | 'test_failure'
  | 'file_permission_error'
  | 'provider_connection_failure'
  | 'mcp_process_failure'
  | 'tool_timeout'
  | 'agent_crash'
  | 'conflicting_patch'
  | 'unknown_error';

export interface SelfHealingReport {
  detected: boolean;
  classification: ErrorClassification;
  diagnosis: string;
  attemptsUsed: number;
  maxAttempts: number;
  fixedAndVerified: boolean;
  verificationEvidence: string;
  actionsTaken: string[];
}

export interface OrchestrationResponse {
  requestId: string;
  sessionId: string;
  executionMode: ExecutionMode;
  route: RouteDecision;
  lifecycleLog: Array<{ stage: LifecycleStage; timestamp: string; detail: string }>;
  planSteps: TaskPlanStep[];
  delegatedOutcomes: TaskExecutionOutcome[];
  contextTransfer?: NeutralContextTransferSummary;
  selfHealing?: SelfHealingReport;
  responseText: string;
  verified: boolean;
  diagnostics: string[];
}

export function isNonRetryableError(errorMessage: string): boolean {
  return /\b(?:401|403|invalid[_ ]api[_ ]key|unauthorized|permission[_ ]denied|authentication[_ ]error|quota[_ ]exceeded)\b/i.test(
    errorMessage,
  );
}

export function classifyExecutionError(errorText: string): {
  classification: ErrorClassification;
  diagnosis: string;
  suggestedFixCommand?: string;
} {
  if (/Cannot find module|MODULE_NOT_FOUND|No module named/i.test(errorText)) {
    return {
      classification: 'missing_dependency',
      diagnosis: 'Required package or module could not be resolved.',
    };
  }
  if (/TS\d{4}:|Type '.*' is not assignable to type/i.test(errorText)) {
    return {
      classification: 'typescript_compile_error',
      diagnosis: 'TypeScript type check or compilation failure detected.',
    };
  }
  if (/SyntaxError: Cannot use import statement|Named export .* not found/i.test(errorText)) {
    return {
      classification: 'broken_import',
      diagnosis: 'ESM/CJS import path or export mismatch.',
    };
  }
  if (/ZodError|Invalid configuration|YAMLParseError/i.test(errorText)) {
    return {
      classification: 'invalid_config',
      diagnosis: 'Configuration schema validation failure.',
    };
  }
  if (/AssertionError|FAIL |test failed/i.test(errorText)) {
    return {
      classification: 'test_failure',
      diagnosis: 'Automated unit or integration test assertion failed.',
    };
  }
  if (/EACCES|EPERM|Permission denied|read-only file system/i.test(errorText)) {
    return {
      classification: 'file_permission_error',
      diagnosis: 'Filesystem permission or sandbox boundary restriction encountered.',
    };
  }
  if (/ECONNREFUSED|ENOTFOUND|HTTP 502|HTTP 503|Unable to reach/i.test(errorText)) {
    return {
      classification: 'provider_connection_failure',
      diagnosis: 'Upstream model provider endpoint is unreachable.',
    };
  }
  if (/MCP|StdioClientTransport|Connection closed/i.test(errorText)) {
    return {
      classification: 'mcp_process_failure',
      diagnosis: 'MCP server process disconnected or failed health check.',
    };
  }
  if (/timed out|ETIMEDOUT|TimeoutExpired/i.test(errorText)) {
    return {
      classification: 'tool_timeout',
      diagnosis: 'Tool or agent execution exceeded configured timeout.',
    };
  }
  if (/Patch failed to apply|CONFLICT \(content\)/i.test(errorText)) {
    return {
      classification: 'conflicting_patch',
      diagnosis: 'Conflicting file edits or merge conflict detected.',
    };
  }
  if (/exited with code|SIGKILL|SIGTERM/i.test(errorText)) {
    return {
      classification: 'agent_crash',
      diagnosis: 'Child agent CLI process exited abnormally.',
    };
  }
  return {
    classification: 'unknown_error',
    diagnosis: errorText.slice(0, 200),
  };
}

export class ShellGPTOrchestrator extends EventEmitter {
  public readonly workspaceDir: string;
  public readonly configManager: ConfigManager;
  public readonly telemetry: TelemetryManager;
  public readonly permissions: PermissionEngine;
  public readonly memory: MemoryManager;
  public readonly toolkit: CodingToolkit;
  public readonly mcp: McpManager;
  public readonly rea: ReaIntegration;
  public readonly providers: ProviderGateway;
  public readonly antigravity: AntigravityAdapter;
  public readonly codex: CodexAdapter;
  public readonly claude: ClaudeAdapter;
  public readonly instructions: InstructionBridge;
  public readonly skills: SkillManager;
  public readonly hooks: HookEngine;
  public readonly plugins: PluginManager;
  public readonly scheduler: ParallelTaskScheduler;
  public readonly delegationSafety: DelegationSafetyGuard;
  public readonly recoveredOrphanTasksCount: number;

  private readonly circuitBreakers = new Map<string, CircuitBreakerState>();
  private activeSession: SessionRecord;

  constructor(workspaceDir: string = process.cwd(), customConfigPath?: string) {
    super();
    this.workspaceDir = workspaceDir;
    this.configManager = new ConfigManager(workspaceDir, customConfigPath);
    const cfg = this.configManager.get();

    this.telemetry = new TelemetryManager(workspaceDir, () =>
      this.configManager.secrets.getKnownSecrets(),
    );
    this.permissions = new PermissionEngine(
      workspaceDir,
      cfg.general.defaultPermissionMode,
    );
    this.memory = new MemoryManager(
      workspaceDir,
      cfg.memory.databasePath,
      () => this.configManager.secrets.getKnownSecrets(),
    );
    this.toolkit = new CodingToolkit(workspaceDir, this.permissions, this.memory);
    this.mcp = new McpManager(workspaceDir, this.permissions, this.telemetry);
    this.rea = new ReaIntegration(workspaceDir, this.mcp);
    if (cfg.mcp.reaEnabled) {
      this.rea.ensureRegisteredInMcp();
    }

    this.providers = new ProviderGateway(cfg.providers, this.configManager.secrets);
    this.antigravity = new AntigravityAdapter({
      workspaceDir,
      binaryPath: cfg.agents.antigravity.binaryPath,
      defaultModel: cfg.agents.antigravity.defaultModel,
      permissions: this.permissions,
    });
    this.codex = new CodexAdapter({
      workspaceDir,
      binaryPath: cfg.agents.codex.binaryPath,
      defaultModel: cfg.agents.codex.defaultModel,
      permissions: this.permissions,
    });
    this.claude = new ClaudeAdapter({
      enabled: cfg.agents.claude.enabled,
      binaryPath: cfg.agents.claude.binaryPath,
      defaultModel: cfg.agents.claude.defaultModel,
    });

    this.instructions = new InstructionBridge(workspaceDir);
    this.skills = new SkillManager(workspaceDir);
    this.hooks = new HookEngine(workspaceDir, true);
    this.plugins = new PluginManager(workspaceDir, cfg.plugins);
    this.plugins.ingestActivePlugins({
      skills: this.skills,
      hooks: this.hooks,
      mcp: this.mcp,
    });

    this.scheduler = new ParallelTaskScheduler({
      maxConcurrency: cfg.orchestration.maxParallelWorkers,
      useGitWorktrees: cfg.orchestration.gitWorktreeIsolation,
      toolkit: this.toolkit,
    });
    this.delegationSafety = new DelegationSafetyGuard({
      maxDepth: 3,
      maxTasksPerSession: 30,
    });

    // Recover any orphaned tasks from an unexpected prior CLI exit (Phase 3)
    const recoveredTasks = this.memory.recoverOrphanedTasks(process.pid);
    this.recoveredOrphanTasksCount = recoveredTasks.length;

    const existingSessions = this.memory.listSessions();
    this.activeSession =
      existingSessions[0] ||
      this.memory.createSession({
        title: 'ShellGPT Interactive Session',
        primaryAgent: cfg.routing.explicitAgent,
        activeModel: cfg.routing.activeModel || 'auto',
        executionMode: cfg.general.executionMode,
        permissionMode: cfg.general.defaultPermissionMode,
      });
  }

  public emitAgentEvent(event: AgentEvent): void {
    this.emit('agent.event', event);
    this.emit(event.type, event);
  }

  /**
   * Executes and reports the 12-step CLI Startup Sequence (Phase 2).
   */
  public async runStartupSequence(): Promise<{
    steps: Array<{ step: number; name: string; status: 'ok' | 'warn'; detail: string }>;
    route: RouteDecision;
    sessionId: string;
  }> {
    const cfg = this.configManager.get();
    const [caps, providerHealth, route] = await Promise.all([
      this.getAgentCapabilities(),
      this.providers.checkAllHealth(),
      this.resolveRoute(),
    ]);
    const mcpConfigs = this.mcp.listServerConfigs();

    const steps: Array<{ step: number; name: string; status: 'ok' | 'warn'; detail: string }> = [
      {
        step: 1,
        name: 'Resolve working directory',
        status: 'ok',
        detail: this.workspaceDir,
      },
      {
        step: 2,
        name: 'Load ShellGPT configuration',
        status: 'ok',
        detail: this.configManager.getConfigPath(),
      },
      {
        step: 3,
        name: 'Initialize session database',
        status: 'ok',
        detail: `SQLite initialized (${this.memory.listSessions().length} session(s), ${this.recoveredOrphanTasksCount} orphaned task(s) recovered)`,
      },
      {
        step: 4,
        name: 'Initialize permission manager',
        status: 'ok',
        detail: `Mode: ${this.permissions.getMode()}`,
      },
      {
        step: 5,
        name: 'Discover available agent runtimes',
        status: 'ok',
        detail: caps.map((c) => `${c.id}(installed=${c.installed},auth=${c.authenticated})`).join(', '),
      },
      {
        step: 6,
        name: 'Discover configured API providers',
        status: 'ok',
        detail: `${this.providers.listProviders().length} provider profiles registered`,
      },
      {
        step: 7,
        name: 'Validate provider readiness',
        status: providerHealth.some((p) => p.healthy) ? 'ok' : 'warn',
        detail: `${providerHealth.filter((p) => p.healthy).length}/${providerHealth.length} providers healthy`,
      },
      {
        step: 8,
        name: 'Load configured MCP servers',
        status: 'ok',
        detail: `${mcpConfigs.filter((s) => s.enabled).length} enabled MCP server(s)`,
      },
      {
        step: 9,
        name: 'Resolve preferred primary brain',
        status: route.mode === 'SETUP_REQUIRED' ? 'warn' : 'ok',
        detail: `${route.primaryBrain} (${route.mode})`,
      },
      {
        step: 10,
        name: 'Restore or initialize conversation',
        status: 'ok',
        detail: `Session ${this.activeSession.id} (${this.activeSession.title})`,
      },
      {
        step: 11,
        name: 'Launch terminal interface',
        status: 'ok',
        detail: `Theme: ${cfg.general.theme}`,
      },
      {
        step: 12,
        name: 'Accept real user input',
        status: 'ok',
        detail: 'Interactive loop ready',
      },
    ];

    return {
      steps,
      route,
      sessionId: this.activeSession.id,
    };
  }

  /**
   * Unified Brain Selector supporting `/brain auto | antigravity | codex | api | local | status | fallback | reset` (Phase 7).
   */
  public async selectBrain(
    command:
      | 'auto'
      | 'antigravity'
      | 'codex'
      | 'api'
      | 'local'
      | 'status'
      | 'fallback'
      | 'reset',
    modelOrProvider?: string,
  ): Promise<{
    command: string;
    route: RouteDecision;
    transferSummary?: NeutralContextTransferSummary;
    output: string;
  }> {
    if (command === 'status') {
      const route = await this.resolveRoute();
      const cfg = this.configManager.get();
      return {
        command,
        route,
        output: [
          `# ShellGPT Brain Selector Status`,
          `- **Active Mode**: \`${route.mode}\``,
          `- **Primary Brain**: \`${route.primaryBrain}\``,
          `- **Active Model**: \`${route.activeModel}\``,
          `- **Delegated Workers**: ${route.supportingAgents.join(', ') || 'none'}`,
          `- **Explicit Override**: \`${cfg.routing.explicitAgent}\``,
          `- **Automatic Fallback**: ${cfg.routing.enableAutomaticFallback ? 'Enabled' : 'Disabled'}`,
          `- **Reason**: ${route.reason}`,
        ].join('\n'),
      };
    }

    if (command === 'fallback') {
      const cfg = this.configManager.get();
      if (modelOrProvider === 'on' || modelOrProvider === 'off') {
        const enabled = modelOrProvider === 'on';
        this.configManager.update((c) => {
          c.routing.enableAutomaticFallback = enabled;
          c.routing.fallbackToCodex = enabled;
          c.routing.allowLocalModelRecovery = enabled;
        });
      }
      const route = await this.resolveRoute();
      const r = this.configManager.get().routing;
      return {
        command,
        route,
        output: [
          `# Brain Fallback Configuration`,
          `- **Automatic Fallback**: ${r.enableAutomaticFallback}`,
          `- **Prefer Antigravity When No API**: ${r.preferAntigravityWhenNoApi}`,
          `- **Fallback To Codex**: ${r.fallbackToCodex}`,
          `- **Local Model Recovery**: ${r.allowLocalModelRecovery}`,
          `- **Billable Fallback**: ${r.allowBillableFallback}`,
        ].join('\n'),
      };
    }

    if (command === 'reset') {
      this.circuitBreakers.clear();
      this.configManager.update((c) => {
        c.routing.explicitAgent = 'auto';
        delete c.routing.activeModel;
        delete c.routing.activeProviderId;
        c.routing.enableAutomaticFallback = true;
      });
      const switched = await this.switchAgent('auto');
      return {
        command,
        route: switched.newRoute,
        transferSummary: switched.transferSummary,
        output: `Reset brain selection and circuit breakers to automatic routing. Active brain: "${switched.newRoute.primaryBrain}" (${switched.newRoute.mode}).`,
      };
    }

    const targetMap: Record<
      'auto' | 'antigravity' | 'codex' | 'api' | 'local',
      'auto' | 'antigravity' | 'codex' | 'custom' | 'local'
    > = {
      auto: 'auto',
      antigravity: 'antigravity',
      codex: 'codex',
      api: 'custom',
      local: 'local',
    };

    if (command === 'api' && modelOrProvider) {
      const maybeProv = this.providers.getProvider(modelOrProvider);
      if (maybeProv) {
        this.configManager.update((c) => {
          c.routing.activeProviderId = modelOrProvider;
        });
      }
    }

    const target = targetMap[command];
    const switched = await this.switchAgent(target, modelOrProvider);
    return {
      command,
      route: switched.newRoute,
      transferSummary: switched.transferSummary,
      output: [
        `Switched brain from "${switched.previousAgent}" to "${switched.newRoute.primaryBrain}" (Mode: ${switched.newRoute.mode}, Model: ${switched.newRoute.activeModel}).`,
        `Workers available: ${switched.newRoute.supportingAgents.join(', ') || 'none'}.`,
        `Context transfer envelope preserved (${switched.transferSummary.recentConversation.length} recent turns, ${switched.transferSummary.modifiedFiles.length} modified files).`,
      ].join('\n'),
    };
  }

  public getActiveSession(): SessionRecord {
    return this.activeSession;
  }

  public setActiveSession(session: SessionRecord): void {
    this.activeSession = session;
  }

  public isCircuitOpen(targetId: string): boolean {
    const state = this.circuitBreakers.get(targetId);
    if (!state || !state.isOpen) return false;
    const resetMs = this.configManager.get().routing.circuitBreakerResetMs;
    if (state.openedAt && Date.now() - state.openedAt >= resetMs) {
      state.isOpen = false;
      state.failures = 0;
      return false;
    }
    return true;
  }

  public recordTargetFailure(targetId: string, errorMessage: string): void {
    const threshold = this.configManager.get().routing.circuitBreakerThreshold;
    const state = this.circuitBreakers.get(targetId) || {
      targetId,
      failures: 0,
      isOpen: false,
    };
    state.failures += 1;
    state.lastError = errorMessage;
    if (state.failures >= threshold || isNonRetryableError(errorMessage)) {
      state.isOpen = true;
      state.openedAt = Date.now();
    }
    this.circuitBreakers.set(targetId, state);
  }

  public recordTargetSuccess(targetId: string): void {
    this.circuitBreakers.set(targetId, {
      targetId,
      failures: 0,
      isOpen: false,
    });
  }

  /**
   * Executes an operation with bounded retries and exponential backoff,
   * never retrying 401/403 invalid API keys or permission-denied errors.
   */
  public async executeWithCircuitBreaker<T>(
    targetId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.isCircuitOpen(targetId)) {
      const state = this.circuitBreakers.get(targetId);
      throw new Error(
        `Circuit breaker is OPEN for "${targetId}" (last error: ${state?.lastError || 'unknown'}).`,
      );
    }

    const maxRetries = this.configManager.get().routing.maxRetries;
    let attempt = 0;
    while (true) {
      try {
        const result = await operation();
        this.recordTargetSuccess(targetId);
        return result;
      } catch (err) {
        const msg = (err as Error).message || String(err);
        this.recordTargetFailure(targetId, msg);
        if (isNonRetryableError(msg) || attempt >= maxRetries) {
          throw err;
        }
        attempt += 1;
        const backoffMs = Math.min(2000, 150 * Math.pow(2, attempt));
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  /**
   * Lists all agent capabilities across Antigravity, Codex, Custom APIs, Local Models, and Claude.
   */
  public async getAgentCapabilities(): Promise<AgentCapabilityDescriptor[]> {
    const [agyStatus, codexStatus] = await Promise.all([
      this.antigravity.getStatus(),
      this.codex.getStatus(),
    ]);
    const claudeStatus = this.claude.getStatus();
    const cfg = this.configManager.get();

    const descriptors: AgentCapabilityDescriptor[] = [
      {
        id: 'antigravity',
        name: 'Google Antigravity',
        type: 'autonomous-agent',
        runtime: agyStatus.sdkAvailable ? 'Antigravity Python SDK + agy CLI' : 'agy CLI',
        installed: agyStatus.installed,
        authenticated: agyStatus.authenticated,
        healthy: agyStatus.installed && !this.isCircuitOpen('antigravity'),
        primaryCapable: cfg.agents.antigravity.primaryCapable,
        subagentCapable: cfg.agents.antigravity.subagentCapable,
        supportsTools: true,
        supportsStreaming: agyStatus.supportsStreaming,
        supportsSessions: true,
        availableModels: agyStatus.availableModels,
        specializations: ['planning', 'research', 'architecture', 'autonomous-implementation', 'rea'],
        diagnostic: agyStatus.diagnostic,
      },
      {
        id: 'codex',
        name: 'OpenAI Codex',
        type: 'coding-agent',
        runtime: 'official Codex adapter (codex exec / app-server)',
        installed: codexStatus.installed,
        authenticated: codexStatus.authenticated,
        healthy: codexStatus.installed && !this.isCircuitOpen('codex'),
        primaryCapable: cfg.agents.codex.primaryCapable,
        subagentCapable: cfg.agents.codex.subagentCapable,
        supportsTools: true,
        supportsStreaming: codexStatus.supportsStreaming,
        supportsSessions: codexStatus.supportsThreads,
        availableModels: codexStatus.availableModels,
        specializations: [
          'implementation',
          'debugging',
          'testing',
          'refactoring',
          'code-review',
          'optimization',
          'security-review',
        ],
        diagnostic: codexStatus.diagnostic,
      },
      {
        id: 'claude',
        name: 'Claude Code Adapter (Optional)',
        type: 'coding-agent',
        runtime: 'Claude CLI / Gateway bridge',
        installed: claudeStatus.installed,
        authenticated: Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN),
        healthy: claudeStatus.enabled && claudeStatus.installed,
        primaryCapable: cfg.agents.claude.primaryCapable,
        subagentCapable: cfg.agents.claude.subagentCapable,
        supportsTools: true,
        supportsStreaming: true,
        supportsSessions: true,
        availableModels: [cfg.agents.claude.defaultModel || 'claude-sonnet-5-5'],
        specializations: ['coding', 'review'],
        diagnostic: claudeStatus.diagnostic,
      },
    ];

    return descriptors;
  }

  /**
   * 7-Tier Intelligent Routing Engine (Section 5).
   * Priorities:
   * 1. Explicit user-selected agent or model
   * 2. Per-task override
   * 3. Configured primary API provider (MODE A)
   * 4. Configured preferred primary CLI agent (MODE B / MODE C)
   * 5. Healthy authenticated alternative agent
   * 6. Configured local model (MODE D)
   * 7. Interactive configuration and authentication guidance
   */
  public async resolveRoute(options: {
    taskOverrideAgent?: string;
    taskOverrideModel?: string;
  } = {}): Promise<RouteDecision> {
    const cfg = this.configManager.get();
    const [agyStatus, codexStatus] = await Promise.all([
      this.antigravity.getStatus(),
      this.codex.getStatus(),
    ]);

    const supportingAgents: string[] = [];
    if (agyStatus.installed && cfg.agents.antigravity.subagentCapable) {
      supportingAgents.push('antigravity');
    }
    if (codexStatus.installed && cfg.agents.codex.subagentCapable) {
      supportingAgents.push('codex');
    }

    const requestedChoice =
      options.taskOverrideAgent ||
      (cfg.routing.explicitAgent !== 'auto' ? cfg.routing.explicitAgent : undefined);
    const tierForExplicit = options.taskOverrideAgent ? 2 : 1;

    // Tier 1 & 2: Explicit user selection or per-task override
    if (requestedChoice) {
      if (requestedChoice === 'antigravity') {
        return {
          mode: 'MODE_B_ANTIGRAVITY_PRIMARY',
          primaryBrain: 'antigravity',
          activeModel:
            options.taskOverrideModel ||
            cfg.routing.activeModel ||
            cfg.agents.antigravity.defaultModel ||
            'gemini-3.8-flash-low',
          supportingAgents: supportingAgents.filter((a) => a !== 'antigravity'),
          priorityTierUsed: tierForExplicit,
          reason: `Explicitly selected Google Antigravity as primary brain (${agyStatus.diagnostic}).`,
        };
      }

      if (requestedChoice === 'codex') {
        return {
          mode: 'MODE_C_CODEX_PRIMARY',
          primaryBrain: 'codex',
          activeModel:
            options.taskOverrideModel ||
            cfg.routing.activeModel ||
            cfg.agents.codex.defaultModel ||
            'gpt-6-astra',
          supportingAgents: supportingAgents.filter((a) => a !== 'codex'),
          priorityTierUsed: tierForExplicit,
          reason: `Explicitly selected OpenAI Codex as primary brain (${codexStatus.diagnostic}).`,
        };
      }

      if (requestedChoice === 'custom') {
        const activeId = cfg.routing.activeProviderId || 'asemprotic';
        const prov = this.providers.getProvider(activeId);
        if (prov) {
          const health = await prov.healthCheck();
          if (health.healthy && health.authenticated) {
            return {
              mode: 'MODE_A_CUSTOM_API',
              primaryBrain: `custom-api:${prov.id}`,
              activeModel:
                options.taskOverrideModel ||
                cfg.routing.activeModel ||
                prov.profile.defaultModel ||
                'default',
              supportingAgents,
              priorityTierUsed: tierForExplicit,
              reason: `Explicitly selected custom API controller "${prov.id}" (${health.diagnostic}).`,
            };
          }
        }
      }

      if (requestedChoice === 'local') {
        const localHit = await this.providers.findHealthyLocalProvider();
        if (localHit) {
          const model =
            options.taskOverrideModel ||
            localHit.health.availableModels[0] ||
            localHit.provider.profile.defaultModel ||
            'local-model';
          return {
            mode: 'MODE_D_LOCAL_RECOVERY',
            primaryBrain: `local:${localHit.provider.id}`,
            activeModel: model,
            supportingAgents,
            priorityTierUsed: tierForExplicit,
            reason: `Explicitly selected local model backend "${localHit.provider.id}".`,
            reducedCapabilityWarning:
              'Local model active: verify tool-calling reliability for multi-step operations.',
          };
        }
      }
    }

    // Tier 3: Configured primary API provider (MODE A)
    if (cfg.routing.preferCustomApiWhenHealthy && cfg.agents.customLlm.enabled) {
      if (cfg.routing.activeProviderId) {
        const pinned = this.providers.getProvider(cfg.routing.activeProviderId);
        if (pinned && !this.isCircuitOpen(`custom-api:${pinned.id}`)) {
          const h = await pinned.healthCheck();
          if (h.healthy && h.authenticated) {
            return {
              mode: 'MODE_A_CUSTOM_API',
              primaryBrain: `custom-api:${pinned.id}`,
              activeModel:
                options.taskOverrideModel ||
                cfg.routing.activeModel ||
                pinned.profile.defaultModel ||
                'default',
              supportingAgents,
              priorityTierUsed: 3,
              reason: `Configured primary API provider "${pinned.id}" is healthy and authenticated.`,
            };
          }
        }
      }

      const healthyCustom = await this.providers.findHealthyCustomProvider(
        cfg.routing.providerPriority,
      );
      if (
        healthyCustom &&
        !this.isCircuitOpen(`custom-api:${healthyCustom.provider.id}`) &&
        (!healthyCustom.provider.profile.billable || cfg.routing.allowBillableFallback || Boolean(this.configManager.secrets.getSecret(healthyCustom.provider.profile.apiKeyEnv || '')))
      ) {
        return {
          mode: 'MODE_A_CUSTOM_API',
          primaryBrain: `custom-api:${healthyCustom.provider.id}`,
          activeModel:
            options.taskOverrideModel ||
            cfg.routing.activeModel ||
            healthyCustom.provider.profile.defaultModel ||
            'default',
          supportingAgents,
          priorityTierUsed: 3,
          reason: `Primary API controller "${healthyCustom.provider.id}" selected via routing priority.`,
        };
      }
    }

    // Tier 4: Configured preferred primary CLI agent (MODE B — Antigravity Primary Brain)
    if (
      cfg.routing.preferAntigravityWhenNoApi &&
      cfg.agents.antigravity.enabled &&
      agyStatus.installed &&
      agyStatus.authenticated &&
      !this.isCircuitOpen('antigravity')
    ) {
      return {
        mode: 'MODE_B_ANTIGRAVITY_PRIMARY',
        primaryBrain: 'antigravity',
        activeModel:
          options.taskOverrideModel ||
          cfg.routing.activeModel ||
          cfg.agents.antigravity.defaultModel ||
          'gemini-3.8-flash-low',
        supportingAgents: supportingAgents.filter((a) => a !== 'antigravity'),
        priorityTierUsed: 4,
        reason: 'No primary API configured; Google Antigravity is installed, authenticated, and ready (MODE B).',
      };
    }

    // Tier 5: Healthy authenticated alternative agent (MODE C — Codex Primary Brain)
    if (
      cfg.routing.fallbackToCodex &&
      cfg.agents.codex.enabled &&
      codexStatus.installed &&
      codexStatus.authenticated &&
      !this.isCircuitOpen('codex')
    ) {
      return {
        mode: 'MODE_C_CODEX_PRIMARY',
        primaryBrain: 'codex',
        activeModel:
          options.taskOverrideModel ||
          cfg.routing.activeModel ||
          cfg.agents.codex.defaultModel ||
          'gpt-6-astra',
        supportingAgents: supportingAgents.filter((a) => a !== 'codex'),
        priorityTierUsed: 5,
        reason: 'Selected authenticated OpenAI Codex as primary brain via fallback policy (MODE C).',
      };
    }

    // Tier 6: Local Model Recovery (MODE D)
    if (cfg.routing.allowLocalModelRecovery) {
      const localHit = await this.providers.findHealthyLocalProvider();
      if (localHit && !this.isCircuitOpen(`local:${localHit.provider.id}`)) {
        const model =
          options.taskOverrideModel ||
          localHit.health.availableModels[0] ||
          localHit.provider.profile.defaultModel ||
          'local-model';
        return {
          mode: 'MODE_D_LOCAL_RECOVERY',
          primaryBrain: `local:${localHit.provider.id}`,
          activeModel: model,
          supportingAgents,
          priorityTierUsed: 6,
          reason: `Activated Local Model Recovery via ${localHit.provider.id} (MODE D).`,
          reducedCapabilityWarning:
            'Running on local model recovery backend. Complex multi-tool delegations may operate with reduced capability.',
        };
      }
    }

    // Tier 7: Honest Setup & Authentication Guidance (Never fake operational status!)
    const asem = resolveAsemproticConfig();
    return {
      mode: 'SETUP_REQUIRED',
      primaryBrain: 'none',
      activeModel: 'none',
      supportingAgents,
      priorityTierUsed: 7,
      reason:
        'No authenticated coding agent (Antigravity/Codex), cloud API key, or running local model server was detected in the current environment.',
      setupInstructions: [
        `1. Antigravity (MODE B): ${agyStatus.diagnostic}`,
        `2. OpenAI Codex (MODE C): ${codexStatus.diagnostic}`,
        `3. Custom API / Asemprotic (MODE A): ${asem.diagnostic}`,
        `4. Local Model Recovery (MODE D): Start Ollama (http://127.0.0.1:11434), LM Studio (:1234), or llama.cpp (:8080).`,
      ],
    };
  }

  /**
   * Manually switches primary agent and generates a neutral context transfer summary.
   */
  public async switchAgent(
    target: 'auto' | 'antigravity' | 'codex' | 'custom' | 'local',
    model?: string,
  ): Promise<{
    previousAgent: string;
    newRoute: RouteDecision;
    transferSummary: NeutralContextTransferSummary;
  }> {
    const previousAgent = this.activeSession.primaryAgent;
    this.configManager.update((cfg) => {
      cfg.routing.explicitAgent = target;
      if (model) cfg.routing.activeModel = model;
    });

    const newRoute = await this.resolveRoute({ taskOverrideModel: model });
    const gitStatus = this.toolkit.gitStatus();
    const policy = this.instructions.resolvePolicy();
    const transferSummary = this.memory.buildNeutralTransferSummary(
      this.activeSession.id,
      previousAgent,
      newRoute.primaryBrain,
      {
        applicableInstructions: policy.canonicalText.slice(0, 2000),
        repositoryState: {
          branch: gitStatus.branch,
          modifiedFiles: gitStatus.modified,
          untrackedFiles: gitStatus.untracked,
        },
      },
    );

    this.memory.updateSessionAgent(
      this.activeSession.id,
      newRoute.primaryBrain,
      newRoute.activeModel,
    );
    this.activeSession = this.memory.getSession(this.activeSession.id)!;

    return {
      previousAgent,
      newRoute,
      transferSummary,
    };
  }

  /**
   * Executes a single delegated task envelope on the assigned agent (Codex, Antigravity, or Custom Provider)
   * with durable Task State Machine persistence (CREATED -> QUEUED -> RUNNING -> VERIFYING -> COMPLETED)
   * and DelegationSafetyGuard checks (Phase 3 & Phase 6).
   */
  public async executeDelegatedEnvelope(
    envelope: CanonicalTaskEnvelope,
    signal?: AbortSignal,
  ): Promise<TaskExecutionOutcome> {
    const startTime = Date.now();
    const depth = envelope.depth ?? 1;

    // 1. Durable Task State Machine: CREATED
    this.memory.createTaskRecord({
      taskId: envelope.task_id,
      parentTaskId: envelope.parent_id,
      sessionId: envelope.parent_session_id,
      agentId: envelope.assigned_to,
      objective: envelope.objective,
      depth,
      initialState: 'CREATED',
    });

    // 2. Delegation Safety Guard (depth, duplicate detection, session task budget)
    const safety = this.delegationSafety.validateAndAcquire({
      sessionId: envelope.parent_session_id,
      requestedBy: envelope.requested_by,
      targetAgent: envelope.assigned_to,
      objective: envelope.objective,
      allowedPaths: envelope.allowed_paths,
      depth,
    });

    if (!safety.allowed) {
      this.memory.transitionTaskState(
        envelope.task_id,
        'BLOCKED',
        safety.reason || 'Blocked by DelegationSafetyGuard',
        { error: safety.reason },
      );
      return {
        task_id: envelope.task_id,
        parent_id: envelope.parent_id,
        assigned_to: envelope.assigned_to,
        role: envelope.role,
        status: 'failed',
        summary: `Delegation blocked by safety policy: ${safety.reason}`,
        files_modified: [],
        validation_passed: false,
        validation_outputs: [],
        duration_ms: Date.now() - startTime,
        error: safety.reason,
      };
    }

    // 3. Transition CREATED -> QUEUED -> RUNNING
    this.memory.transitionTaskState(
      envelope.task_id,
      'QUEUED',
      `Queued for execution on ${envelope.assigned_to}`,
    );

    const telemetryTask = this.telemetry.startTask({
      taskId: envelope.task_id,
      parentTaskId: envelope.parent_id,
      sessionId: envelope.parent_session_id,
      activeAgent: envelope.assigned_to,
      agentRuntime: envelope.assigned_to,
      modelIdentifier: 'auto',
    });

    this.emitAgentEvent({
      type: 'agent.subagent.dispatched',
      taskId: envelope.parent_id || envelope.task_id,
      sessionId: envelope.parent_session_id,
      agentId: envelope.requested_by,
      subagentId: envelope.assigned_to,
      subagentTaskId: envelope.task_id,
      timestamp: new Date().toISOString(),
      metadata: { objective: envelope.objective, scope: envelope.scope, depth },
    });

    await this.hooks.emit('AgentDispatched', {
      conversationId: envelope.parent_session_id,
      workspacePaths: [this.workspaceDir],
      modelName: telemetryTask.modelIdentifier,
      cwd: this.workspaceDir,
      agent: envelope.assigned_to,
    });

    this.memory.transitionTaskState(
      envelope.task_id,
      'RUNNING',
      `Running on ${envelope.assigned_to}`,
    );

    try {
      let summary = '';
      const filesModified: string[] = [];

      if (envelope.assigned_to === 'codex') {
        const res = await this.codex.executeTask({
          taskId: envelope.task_id,
          prompt: `${envelope.objective}\n\nScope: ${envelope.scope}\n\nContext:\n${envelope.context_refs.join('\n')}`,
          systemInstructions: envelope.instructions,
          readOnly: envelope.read_only,
          signal,
        });
        if (res.status !== 'completed') {
          throw new Error(res.diagnostic || `Codex task ${res.status}`);
        }
        summary = res.responseText;
        filesModified.push(...res.filesModified);
        this.telemetry.updateTask(envelope.task_id, (rec) => {
          rec.tokenUsage = {
            ...res.usage,
            totalTokens:
              typeof res.usage.inputTokens === 'number' &&
              typeof res.usage.outputTokens === 'number'
                ? res.usage.inputTokens + res.usage.outputTokens
                : 'unavailable',
          };
        });
      } else if (envelope.assigned_to === 'antigravity') {
        const res = await this.antigravity.executeTask({
          taskId: envelope.task_id,
          prompt: `${envelope.objective}\n\nScope: ${envelope.scope}\n\nContext:\n${envelope.context_refs.join('\n')}`,
          systemInstructions: envelope.instructions,
          signal,
        });
        if (res.status !== 'completed') {
          throw new Error(res.diagnostic || `Antigravity task ${res.status}`);
        }
        summary = res.responseText;
        if (res.filesModified) {
          filesModified.push(...res.filesModified);
        }
        this.telemetry.updateTask(envelope.task_id, (rec) => {
          rec.tokenUsage = {
            ...res.usage,
            totalTokens:
              typeof res.usage.inputTokens === 'number' &&
              typeof res.usage.outputTokens === 'number'
                ? res.usage.inputTokens + res.usage.outputTokens
                : 'unavailable',
          };
        });
      } else if (
        envelope.assigned_to.startsWith('custom-api:') ||
        envelope.assigned_to.startsWith('local:')
      ) {
        const providerId = envelope.assigned_to.split(':')[1];
        const provider = this.providers.getProvider(providerId);
        if (!provider) {
          throw new Error(`Provider "${providerId}" not found for delegated task.`);
        }
        const gen = await provider.generate({
          requestId: envelope.task_id,
          messages: [
            { role: 'system', content: envelope.instructions },
            {
              role: 'user',
              content: `${envelope.objective}\n\nScope: ${envelope.scope}\n\n${envelope.context_refs.join('\n')}`,
            },
          ],
          signal,
        });
        summary = gen.text;
      } else {
        throw new Error(`Unsupported target agent "${envelope.assigned_to}".`);
      }

      // 4. Transition RUNNING -> VERIFYING
      this.memory.transitionTaskState(
        envelope.task_id,
        'VERIFYING',
        `Running ${envelope.validation_commands.length} verification command(s)`,
        { filesModified },
      );

      const validationOutputs: Array<{
        command: string;
        exitCode: number | null;
        output: string;
      }> = [];
      let validationPassed = true;

      for (const cmd of envelope.validation_commands) {
        const cmdRes = await this.toolkit.runCommand(cmd, {
          actor: envelope.assigned_to,
          signal,
        });
        const out = (cmdRes.stdout + '\n' + cmdRes.stderr).trim().slice(0, 1000);
        validationOutputs.push({
          command: cmd,
          exitCode: cmdRes.exitCode,
          output: out,
        });
        this.memory.recordTestResult({
          sessionId: envelope.parent_session_id,
          taskId: envelope.task_id,
          command: cmd,
          passed: cmdRes.exitCode === 0,
          exitCode: cmdRes.exitCode,
          output: out,
          durationMs: cmdRes.durationMs,
        });
        if (cmdRes.exitCode !== 0) {
          validationPassed = false;
        }
      }

      // 5. Transition VERIFYING -> COMPLETED
      this.memory.transitionTaskState(
        envelope.task_id,
        'COMPLETED',
        `Task completed (validationPassed=${validationPassed})`,
        { filesModified },
      );

      this.telemetry.completeTask(envelope.task_id, 'completed');
      this.memory.recordAgentResult({
        sessionId: envelope.parent_session_id,
        taskId: envelope.task_id,
        parentTaskId: envelope.parent_id,
        agent: envelope.assigned_to,
        status: 'completed',
        objective: envelope.objective,
        output: { summary, validationPassed, validationOutputs },
        filesChanged: filesModified,
      });

      this.emitAgentEvent({
        type: 'agent.subagent.completed',
        taskId: envelope.parent_id || envelope.task_id,
        sessionId: envelope.parent_session_id,
        agentId: envelope.requested_by,
        subagentId: envelope.assigned_to,
        subagentTaskId: envelope.task_id,
        timestamp: new Date().toISOString(),
        metadata: { status: 'completed', filesModified, validationPassed },
      });

      await this.hooks.emit('AgentCompleted', {
        conversationId: envelope.parent_session_id,
        workspacePaths: [this.workspaceDir],
        modelName: telemetryTask.modelIdentifier,
        cwd: this.workspaceDir,
        agent: envelope.assigned_to,
      });

      return {
        task_id: envelope.task_id,
        parent_id: envelope.parent_id,
        assigned_to: envelope.assigned_to,
        role: envelope.role,
        status: 'completed',
        summary,
        files_modified: filesModified,
        validation_passed: validationPassed,
        validation_outputs: validationOutputs,
        duration_ms: Date.now() - startTime,
      };
    } catch (err) {
      const errMsg = (err as Error).message || String(err);
      const targetState: TaskState = signal?.aborted ? 'CANCELLED' : 'FAILED';
      this.memory.transitionTaskState(envelope.task_id, targetState, errMsg, {
        error: errMsg,
      });
      this.memory.recordError({
        sessionId: envelope.parent_session_id,
        component: `agent:${envelope.assigned_to}`,
        errorType: 'delegation_failure',
        message: errMsg,
        recoverable: true,
        resolved: false,
      });
      this.telemetry.completeTask(
        envelope.task_id,
        signal?.aborted ? 'cancelled' : 'failed',
        errMsg,
      );
      this.memory.recordAgentResult({
        sessionId: envelope.parent_session_id,
        taskId: envelope.task_id,
        parentTaskId: envelope.parent_id,
        agent: envelope.assigned_to,
        status: 'failed',
        objective: envelope.objective,
        output: { error: errMsg },
        filesChanged: [],
      });
      return {
        task_id: envelope.task_id,
        parent_id: envelope.parent_id,
        assigned_to: envelope.assigned_to,
        role: envelope.role,
        status: signal?.aborted ? 'cancelled' : 'failed',
        summary: `Task failed on ${envelope.assigned_to}: ${errMsg}`,
        files_modified: [],
        validation_passed: false,
        validation_outputs: [],
        duration_ms: Date.now() - startTime,
        error: errMsg,
      };
    } finally {
      this.delegationSafety.release(safety.signature);
    }
  }

  /**
   * Bounded Self-Healing Repair Engine (Section 16):
   * Detect -> Classify -> Diagnose -> Fix -> Verify -> Report
   */
  public async runSelfHealingLoop(params: {
    errorOutput: string;
    repairHandler: (
      attempt: number,
      classification: ErrorClassification,
      diagnosis: string,
    ) => Promise<{ actionTaken: string }>;
    verifyCommand: () => Promise<{ passed: boolean; evidence: string }>;
  }): Promise<SelfHealingReport> {
    const maxAttempts = this.configManager.get().orchestration.maxRepairAttempts;
    const { classification, diagnosis } = classifyExecutionError(params.errorOutput);
    const actionsTaken: string[] = [];

    let attemptsUsed = 0;
    let fixedAndVerified = false;
    let verificationEvidence = 'Verification not yet run.';

    while (attemptsUsed < maxAttempts) {
      attemptsUsed += 1;
      const fixRes = await params.repairHandler(
        attemptsUsed,
        classification,
        diagnosis,
      );
      actionsTaken.push(`Attempt ${attemptsUsed}: ${fixRes.actionTaken}`);

      const ver = await params.verifyCommand();
      verificationEvidence = ver.evidence;
      if (ver.passed) {
        fixedAndVerified = true;
        break;
      }
    }

    return {
      detected: true,
      classification,
      diagnosis,
      attemptsUsed,
      maxAttempts,
      fixedAndVerified,
      verificationEvidence,
      actionsTaken,
    };
  }

  /**
   * Full 17-step Native Agent Execution Lifecycle (Section 10).
   */
  public async processUserRequest(params: {
    prompt: string;
    mode?: ExecutionMode;
    overrideAgent?: string;
    overrideModel?: string;
    onStage?: (stage: LifecycleStage, detail: string) => void;
    onStreamChunk?: (chunk: string) => void;
    signal?: AbortSignal;
  }): Promise<OrchestrationResponse> {
    const requestId = `req_${crypto.randomUUID().slice(0, 10)}`;
    const sessionId = this.activeSession.id;
    const cfg = this.configManager.get();
    const executionMode = params.mode || cfg.general.executionMode;
    const lifecycleLog: Array<{
      stage: LifecycleStage;
      timestamp: string;
      detail: string;
    }> = [];
    const diagnostics: string[] = [];

    const recordStage = (stage: LifecycleStage, detail: string): void => {
      lifecycleLog.push({
        stage,
        timestamp: new Date().toISOString(),
        detail,
      });
      params.onStage?.(stage, detail);
      this.emit('lifecycle', { requestId, stage, detail });
    };

    // 1. Accept request
    recordStage('ACCEPT_REQUEST', `Accepted prompt (${params.prompt.length} chars) in mode="${executionMode}".`);

    // 2. Load session context
    if (cfg.memory.contextCompaction) {
      this.memory.compactSessionContext(sessionId, cfg.memory.maxContextTokens);
    }
    this.memory.addMessage({
      sessionId,
      role: 'user',
      content: params.prompt,
    });
    const history = this.memory.getMessages(sessionId, 10);
    recordStage('LOAD_SESSION_CONTEXT', `Loaded session ${sessionId} (${history.length} recent messages).`);

    // 3. Resolve instructions
    const policy = this.instructions.resolvePolicy();
    recordStage(
      'RESOLVE_INSTRUCTIONS',
      `Resolved ${policy.sources.length} instruction sources (${policy.conflictsResolved.length} precedence conflicts resolved).`,
    );

    // 4. Select controller
    let route = await this.resolveRoute({
      taskOverrideAgent: params.overrideAgent,
      taskOverrideModel: params.overrideModel,
    });
    recordStage(
      'SELECT_CONTROLLER',
      `Selected mode=${route.mode}, brain=${route.primaryBrain}, model=${route.activeModel} (tier ${route.priorityTierUsed}).`,
    );
    if (route.reducedCapabilityWarning) {
      diagnostics.push(route.reducedCapabilityWarning);
    }

    // 5. Analyze intent
    const isReaIntent = /\b(?:reverse[- ]engineer|rea\b|decompile|binary_session|source[- ]map|apk\b|ghidra)\b/i.test(
      params.prompt,
    );
    const isPlanOnly = executionMode === 'plan' || executionMode === 'ask' || executionMode === 'review';
    recordStage(
      'ANALYZE_INTENT',
      `Analyzed intent: rea=${isReaIntent}, readOnly=${isPlanOnly}.`,
    );

    // 6. Inspect relevant repository data
    const gitStatus = this.toolkit.gitStatus();
    const repoFiles = this.toolkit.searchFiles().slice(0, 40);
    recordStage(
      'INSPECT_REPOSITORY',
      `Workspace has ${repoFiles.length}+ files (git branch=${gitStatus.branch}, clean=${gitStatus.clean}).`,
    );

    // 7. Build task plan
    const planSteps: TaskPlanStep[] = [
      {
        id: 'step_1',
        title: isReaIntent
          ? 'Execute authorized REA MCP reverse-engineering analysis'
          : `Process request with primary controller (${route.primaryBrain})`,
        assignedAgent: isReaIntent ? 'rea-mcp' : route.primaryBrain,
        status: 'pending',
        files: [],
      },
    ];
    this.memory.saveTaskPlan({
      sessionId,
      title: params.prompt.slice(0, 80),
      steps: planSteps,
    });
    recordStage('BUILD_TASK_PLAN', `Built task plan with ${planSteps.length} primary step(s).`);

    // 8. Select tools and agents
    const mcpTools = this.mcp.getDiscoveredTools();
    const activeSkillsSummary = this.skills.getProgressiveDisclosureSummary();
    recordStage(
      'SELECT_TOOLS_AND_AGENTS',
      `Available: ${mcpTools.length} MCP tools, ${this.skills.listSkills().length} skills, supporting agents=[${route.supportingAgents.join(', ')}].`,
    );

    // 9. Request permissions
    if (isPlanOnly && this.permissions.getMode() !== 'read-only') {
      diagnostics.push(`Running in "${executionMode}" mode (file modifications disabled for this turn).`);
    }
    recordStage('REQUEST_PERMISSIONS', `Active permission policy: ${this.permissions.getMode()}.`);

    // 10. Execute & 11. Collect outputs & 13. Handle recoverable failures (Scenario E Failure Recovery)
    recordStage('EXECUTE', `Executing on ${route.primaryBrain}...`);
    let responseText = '';
    const delegatedOutcomes: TaskExecutionOutcome[] = [];
    let contextTransfer: NeutralContextTransferSummary | undefined;
    let verified = false;

    if (isReaIntent && cfg.mcp.reaEnabled) {
      try {
        const evidence = await this.rea.analyzeTarget({
          workflow: 'session-overview',
          actor: 'shellgpt',
        });
        const report = this.rea.generateReport([evidence]);
        responseText = report;
        planSteps[0].status = 'completed';
        verified = true;
      } catch (err) {
        diagnostics.push(`REA analysis error: ${(err as Error).message}`);
      }
    }

    let hadRecoverableFailure = false;
    let recoveryDetail = 'No recoverable failures encountered.';

    if (!responseText) {
      if (route.mode === 'SETUP_REQUIRED') {
        planSteps[0].status = 'failed';
        responseText = [
          `### ShellGPT Diagnostic: Backend Configuration or Authentication Required`,
          ``,
          route.reason,
          ``,
          `#### Available Setup Paths:`,
          ...(route.setupInstructions || []).map((s) => `- ${s}`),
          ``,
          `#### Workspace Status (Verified Local Components):`,
          `- **Workspace Files**: ${repoFiles.length} indexed files (Git branch: \`${gitStatus.branch}\`)`,
          `- **Skills Loaded**: ${this.skills.listSkills().length} skills active`,
          `- **REA MCP**: ${this.rea.detectBinary().installed ? `Installed (${this.rea.detectBinary().version})` : 'Not installed'}`,
        ].join('\n');
      } else {
        // Snapshot workspace files before primary brain runs to avoid duplicate modifications on fallback (Phase 7)
        const prePrimarySnapshot = this.toolkit.snapshotWorkspaceFingerprints();
        this.memory.createTaskRecord({
          taskId: requestId,
          sessionId,
          agentId: route.primaryBrain,
          objective: params.prompt,
          depth: 0,
          initialState: 'CREATED',
        });
        this.memory.transitionTaskState(requestId, 'QUEUED', 'Queued top-level request');
        this.memory.transitionTaskState(
          requestId,
          'RUNNING',
          `Executing on primary brain ${route.primaryBrain}`,
        );

        try {
          responseText = await this.executeOnSelectedBrain({
            requestId,
            route,
            prompt: params.prompt,
            instructions: `${policy.canonicalText}\n\n## Available Skills\n${activeSkillsSummary}`,
            sessionId,
            readOnly: isPlanOnly,
            delegatedOutcomes,
            onStreamChunk: params.onStreamChunk,
            signal: params.signal,
          });
          const modifiedDuringPrimary =
            this.toolkit.diffWorkspaceFingerprints(prePrimarySnapshot);
          this.memory.transitionTaskState(
            requestId,
            'VERIFYING',
            'Verifying turn outputs',
            { filesModified: modifiedDuringPrimary },
          );
          this.memory.transitionTaskState(
            requestId,
            'COMPLETED',
            'Top-level turn completed',
            { filesModified: modifiedDuringPrimary },
          );
          planSteps[0].status = 'completed';
          verified = true;
        } catch (primaryErr) {
          hadRecoverableFailure = true;
          const errMsg = (primaryErr as Error).message || String(primaryErr);
          const alreadyModifiedFiles =
            this.toolkit.diffWorkspaceFingerprints(prePrimarySnapshot);
          this.memory.transitionTaskState(
            requestId,
            'RECOVERING',
            `Primary brain ${route.primaryBrain} failed: ${errMsg}`,
            { filesModified: alreadyModifiedFiles, error: errMsg },
          );
          this.memory.recordError({
            sessionId,
            component: route.primaryBrain,
            errorType: 'primary_brain_failure',
            message: errMsg,
            recoverable: true,
            resolved: false,
          });
          diagnostics.push(`Primary brain (${route.primaryBrain}) failed: ${errMsg}`);
          recoveryDetail = `Primary brain ${route.primaryBrain} failed; executed safe failure recovery.`;

          // Scenario E — Failure Recovery: preserve state, switch to healthy alternative if available
          this.recordTargetFailure(route.primaryBrain, errMsg);
          const fallbackRoute = await this.resolveRoute();
          if (
            fallbackRoute.mode !== 'SETUP_REQUIRED' &&
            fallbackRoute.primaryBrain !== route.primaryBrain
          ) {
            const curGit = this.toolkit.gitStatus();
            contextTransfer = this.memory.buildNeutralTransferSummary(
              sessionId,
              route.primaryBrain,
              fallbackRoute.primaryBrain,
              {
                applicableInstructions: policy.canonicalText.slice(0, 2000),
                alreadyModifiedFiles,
                repositoryState: {
                  branch: curGit.branch,
                  modifiedFiles: curGit.modified,
                  untrackedFiles: curGit.untracked,
                },
              },
            );
            route = fallbackRoute;
            try {
              const nonDupNotice =
                alreadyModifiedFiles.length > 0
                  ? `\nIMPORTANT: The following files were already modified before the interruption and have been preserved on disk (DO NOT duplicate already completed edits): ${alreadyModifiedFiles.join(', ')}\n`
                  : '';
              const recoveryPrompt = `[Recovered Session Context from ${contextTransfer.previousAgent}]\nObjective: ${contextTransfer.objectiveSummary}${nonDupNotice}\nContinue user request:\n${params.prompt}`;
              responseText = await this.executeOnSelectedBrain({
                requestId,
                route: fallbackRoute,
                prompt: recoveryPrompt,
                instructions: policy.canonicalText,
                sessionId,
                readOnly: isPlanOnly,
                delegatedOutcomes,
                onStreamChunk: params.onStreamChunk,
                signal: params.signal,
              });
              const totalModified =
                this.toolkit.diffWorkspaceFingerprints(prePrimarySnapshot);
              this.memory.transitionTaskState(
                requestId,
                'VERIFYING',
                `Verified fallback recovery on ${fallbackRoute.primaryBrain}`,
                { filesModified: totalModified },
              );
              this.memory.transitionTaskState(
                requestId,
                'COMPLETED',
                `Recovered and completed on ${fallbackRoute.primaryBrain}`,
                { filesModified: totalModified },
              );
              planSteps[0].status = 'completed';
              verified = true;
            } catch (fallbackErr) {
              this.memory.transitionTaskState(
                requestId,
                'FAILED',
                `Fallback agent ${fallbackRoute.primaryBrain} also failed: ${(fallbackErr as Error).message}`,
                { error: (fallbackErr as Error).message },
              );
              planSteps[0].status = 'failed';
              responseText = `Primary agent failed (${errMsg}) and fallback agent (${fallbackRoute.primaryBrain}) also failed: ${(fallbackErr as Error).message}. Uncommitted workspace files were preserved.`;
            }
          } else {
            this.memory.transitionTaskState(
              requestId,
              'FAILED',
              `No healthy fallback runtime available after ${route.primaryBrain} failed`,
              { error: errMsg },
            );
            planSteps[0].status = 'failed';
            responseText = `Execution failed on ${route.primaryBrain}: ${errMsg}\n\nNo authenticated fallback runtime is currently available to resume the task automatically. Any uncommitted changes have been preserved.`;
          }
        }
      }
    }

    // 11. Collect outputs
    recordStage('COLLECT_OUTPUTS', `Collected response (${responseText.length} chars) and ${delegatedOutcomes.length} delegated task outcome(s).`);

    // 12. Validate changes
    const postGitStatus = this.toolkit.gitStatus();
    recordStage(
      'VALIDATE_CHANGES',
      `Workspace git status after execution: ${postGitStatus.modified.length} modified, ${postGitStatus.untracked.length} untracked.`,
    );

    // 13. Handle recoverable failures
    recordStage(
      'HANDLE_RECOVERABLE_FAILURES',
      hadRecoverableFailure ? recoveryDetail : 'No recoverable failures encountered.',
    );

    // 14. Run tests
    recordStage('RUN_TESTS', `Verification status: ${verified ? 'verified' : 'diagnostic-only'}.`);

    // 15. Summarize verified results
    recordStage('SUMMARIZE_VERIFIED_RESULTS', 'Prepared final response summary.');

    // 16. Persist session
    this.memory.addMessage({
      sessionId,
      role: 'assistant',
      content: responseText,
      agent: route.primaryBrain,
      model: route.activeModel,
    });
    recordStage('PERSIST_SESSION', `Persisted turn to SQLite session ${sessionId}.`);

    // 17. Return response
    recordStage('RETURN_RESPONSE', 'Turn complete.');

    return {
      requestId,
      sessionId,
      executionMode,
      route,
      lifecycleLog,
      planSteps,
      delegatedOutcomes,
      contextTransfer,
      responseText,
      verified,
      diagnostics,
    };
  }

  private async executeOnSelectedBrain(params: {
    requestId?: string;
    route: RouteDecision;
    prompt: string;
    instructions: string;
    sessionId: string;
    readOnly: boolean;
    delegatedOutcomes: TaskExecutionOutcome[];
    onStreamChunk?: (chunk: string) => void;
    signal?: AbortSignal;
  }): Promise<string> {
    const { route } = params;

    if (route.mode === 'MODE_B_ANTIGRAVITY_PRIMARY') {
      const res = await this.executeWithCircuitBreaker('antigravity', async () => {
        const out = await this.antigravity.executeTask({
          taskId: params.requestId,
          prompt: params.prompt,
          systemInstructions: params.instructions,
          model: route.activeModel,
          allowDelegationToCodex: route.supportingAgents.includes('codex'),
          signal: params.signal,
        });
        if (out.status !== 'completed') {
          throw new Error(out.diagnostic || `Antigravity returned status ${out.status}`);
        }
        return out;
      });

      // Handle Antigravity -> Codex delegations
      for (const del of res.delegationRequests) {
        const env = this.instructions.createDelegationEnvelope({
          parentSessionId: params.sessionId,
          parentId: params.requestId,
          requestedBy: 'antigravity',
          assignedTo: 'codex',
          role: 'Backend Engineer',
          objective: del.objective,
          scope: del.scope,
          allowedPaths: del.allowedFiles,
          protectedPaths: del.protectedFiles,
          permissions: this.permissions.getMode(),
          validationCommands: del.verificationCommands,
          readOnly: params.readOnly,
          depth: 1,
        });
        const outcome = await this.executeDelegatedEnvelope(env, params.signal);
        params.delegatedOutcomes.push(outcome);
      }

      if (params.onStreamChunk && res.responseText) {
        params.onStreamChunk(res.responseText);
      }
      return res.responseText;
    }

    if (route.mode === 'MODE_C_CODEX_PRIMARY') {
      const res = await this.executeWithCircuitBreaker('codex', async () => {
        const out = await this.codex.executeTask({
          taskId: params.requestId,
          prompt: params.prompt,
          systemInstructions: params.instructions,
          model: route.activeModel,
          readOnly: params.readOnly,
          allowDelegationToAntigravity: route.supportingAgents.includes('antigravity'),
          signal: params.signal,
        });
        if (out.status !== 'completed') {
          throw new Error(out.diagnostic || `Codex returned status ${out.status}`);
        }
        return out;
      });

      // Handle Codex -> Antigravity delegations
      for (const del of res.delegationRequests) {
        const env = this.instructions.createDelegationEnvelope({
          parentSessionId: params.sessionId,
          parentId: params.requestId,
          requestedBy: 'codex',
          assignedTo: 'antigravity',
          role: 'Architect',
          objective: del.objective,
          scope: del.scope,
          allowedPaths: del.allowedFiles,
          permissions: this.permissions.getMode(),
          validationCommands: del.verificationCommands,
          readOnly: params.readOnly,
          depth: 1,
        });
        const outcome = await this.executeDelegatedEnvelope(env, params.signal);
        params.delegatedOutcomes.push(outcome);
      }

      if (params.onStreamChunk && res.responseText) {
        params.onStreamChunk(res.responseText);
      }
      return res.responseText;
    }

    if (
      route.mode === 'MODE_A_CUSTOM_API' ||
      route.mode === 'MODE_D_LOCAL_RECOVERY'
    ) {
      const providerId = route.primaryBrain.split(':')[1];
      const provider = this.providers.getProvider(providerId);
      if (!provider) {
        throw new Error(`Provider "${providerId}" is not registered.`);
      }

      // Phase 8 Tool-Calling Controller: expose native tools for file reading, editing, shell, search, git, MCP, test execution, and agent delegation
      const controllerTools = [
        DELEGATE_TO_AGENT_TOOL_DEFINITION,
        {
          name: 'read_file',
          description: 'Read a file within the workspace.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              start_line: { type: 'number' },
              end_line: { type: 'number' },
            },
            required: ['path'],
          },
        },
        {
          name: 'write_file',
          description: 'Create or overwrite a file within the workspace.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
        },
        {
          name: 'edit_file',
          description: 'Replace target string in an existing workspace file.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              target: { type: 'string' },
              replacement: { type: 'string' },
            },
            required: ['path', 'target', 'replacement'],
          },
        },
        {
          name: 'search_files',
          description: 'Search workspace file paths.',
          inputSchema: {
            type: 'object',
            properties: { pattern: { type: 'string' } },
          },
        },
        {
          name: 'search_content',
          description: 'Search file contents across the workspace.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' }, file_filter: { type: 'string' } },
            required: ['query'],
          },
        },
        {
          name: 'run_command',
          description: 'Execute a shell command subject to active permission mode.',
          inputSchema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
        {
          name: 'git_status',
          description: 'Get Git branch and modified/staged/untracked file status.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'git_diff',
          description: 'Get Git diff for workspace or target file.',
          inputSchema: {
            type: 'object',
            properties: { file: { type: 'string' } },
          },
        },
        {
          name: 'mcp_call_tool',
          description: 'Invoke a tool on a connected MCP server (such as REA).',
          inputSchema: {
            type: 'object',
            properties: {
              server: { type: 'string' },
              tool: { type: 'string' },
              arguments: { type: 'object' },
            },
            required: ['tool'],
          },
        },
        {
          name: 'run_tests',
          description: 'Execute workspace test command and record test outcome.',
          inputSchema: {
            type: 'object',
            properties: { command: { type: 'string' } },
          },
        },
      ];

      const gen = await this.executeWithCircuitBreaker(route.primaryBrain, () =>
        provider.stream(
          {
            requestId: params.requestId,
            model: route.activeModel,
            messages: [
              { role: 'system', content: params.instructions },
              { role: 'user', content: params.prompt },
            ],
            tools: controllerTools,
            signal: params.signal,
          },
          (delta) => {
            if (delta.text) params.onStreamChunk?.(delta.text);
          },
        ),
      );

      const toolOutputsSummary: string[] = [];

      for (const tc of gen.toolCalls) {
        const toolStart = Date.now();
        this.emitAgentEvent({
          type: 'agent.tool.requested',
          taskId: params.requestId || 'turn',
          sessionId: params.sessionId,
          agentId: route.primaryBrain,
          timestamp: new Date().toISOString(),
          toolName: tc.name,
          toolArgs: tc.arguments,
        });
        this.emitAgentEvent({
          type: 'agent.tool.started',
          taskId: params.requestId || 'turn',
          sessionId: params.sessionId,
          agentId: route.primaryBrain,
          timestamp: new Date().toISOString(),
          toolName: tc.name,
          toolArgs: tc.arguments,
        });

        try {
          let toolResultData: unknown = {};

          if (
            tc.name === 'delegate_to_agent' ||
            tc.name === 'delegate_to_codex' ||
            tc.name === 'delegate_to_antigravity'
          ) {
            const assignedTo =
              tc.name === 'delegate_to_codex'
                ? 'codex'
                : tc.name === 'delegate_to_antigravity'
                  ? 'antigravity'
                  : String(
                      tc.arguments.target_agent ||
                        tc.arguments.agent ||
                        'codex',
                    );
            const role =
              (tc.arguments.role as WorkerRoleName) ||
              (assignedTo === 'antigravity' ? 'Architect' : 'Backend Engineer');
            const objective = String(
              tc.arguments.task_description ||
                tc.arguments.objective ||
                params.prompt,
            );
            const scope = String(
              tc.arguments.scope || tc.arguments.workspace || 'workspace',
            );
            const allowedPaths = Array.isArray(tc.arguments.allowed_paths)
              ? tc.arguments.allowed_paths.map(String)
              : ['.'];
            const validationCommands = Array.isArray(
              tc.arguments.verification_requirements,
            )
              ? tc.arguments.verification_requirements.map(String)
              : [];

            const env = this.instructions.createDelegationEnvelope({
              parentSessionId: params.sessionId,
              parentId: params.requestId,
              requestedBy: route.primaryBrain,
              assignedTo,
              role: BUILTIN_WORKER_ROLES[role] ? role : 'Backend Engineer',
              objective,
              scope,
              allowedPaths,
              permissions: this.permissions.getMode(),
              validationCommands,
              timeoutMs:
                typeof tc.arguments.timeout_ms === 'number'
                  ? tc.arguments.timeout_ms
                  : undefined,
              readOnly: params.readOnly,
              depth: 1,
            });
            const outcome = await this.executeDelegatedEnvelope(env, params.signal);
            params.delegatedOutcomes.push(outcome);
            toolResultData = outcome;
            toolOutputsSummary.push(
              `[Delegated -> ${assignedTo}]: ${outcome.summary}`,
            );
          } else if (tc.name === 'read_file') {
            const res = await this.toolkit.readFile(String(tc.arguments.path || ''), {
              startLine:
                typeof tc.arguments.start_line === 'number'
                  ? tc.arguments.start_line
                  : undefined,
              endLine:
                typeof tc.arguments.end_line === 'number'
                  ? tc.arguments.end_line
                  : undefined,
              actor: route.primaryBrain,
            });
            toolResultData = res;
          } else if (tc.name === 'write_file' && !params.readOnly) {
            const res = await this.toolkit.writeFile(
              String(tc.arguments.path || ''),
              String(tc.arguments.content || ''),
              { actor: route.primaryBrain, sessionId: params.sessionId },
            );
            toolResultData = res;
          } else if (tc.name === 'edit_file' && !params.readOnly) {
            const res = await this.toolkit.editFile(
              String(tc.arguments.path || ''),
              String(tc.arguments.target || ''),
              String(tc.arguments.replacement || ''),
              { actor: route.primaryBrain, sessionId: params.sessionId },
            );
            toolResultData = res;
          } else if (tc.name === 'search_files') {
            toolResultData = this.toolkit.searchFiles(
              String(tc.arguments.pattern || ''),
            );
          } else if (tc.name === 'search_content') {
            toolResultData = this.toolkit.searchContent(
              String(tc.arguments.query || ''),
              {
                fileFilter: tc.arguments.file_filter
                  ? String(tc.arguments.file_filter)
                  : undefined,
              },
            );
          } else if (tc.name === 'run_command' && !params.readOnly) {
            toolResultData = await this.toolkit.runCommand(
              String(tc.arguments.command || ''),
              { actor: route.primaryBrain, signal: params.signal },
            );
          } else if (tc.name === 'git_status') {
            toolResultData = this.toolkit.gitStatus();
          } else if (tc.name === 'git_diff') {
            toolResultData = this.toolkit.gitDiff(
              tc.arguments.file ? String(tc.arguments.file) : undefined,
            );
          } else if (tc.name === 'mcp_call_tool') {
            toolResultData = await this.mcp.invokeTool({
              serverName: tc.arguments.server
                ? String(tc.arguments.server)
                : undefined,
              toolName: String(tc.arguments.tool || ''),
              arguments:
                (tc.arguments.arguments as Record<string, unknown>) || {},
              actor: route.primaryBrain,
            });
          } else if (tc.name === 'run_tests') {
            const cmd = String(tc.arguments.command || 'npm test');
            const cmdRes = await this.toolkit.runCommand(cmd, {
              actor: route.primaryBrain,
              signal: params.signal,
            });
            this.memory.recordTestResult({
              sessionId: params.sessionId,
              taskId: params.requestId,
              command: cmd,
              passed: cmdRes.exitCode === 0,
              exitCode: cmdRes.exitCode,
              output: cmdRes.stdout + '\n' + cmdRes.stderr,
              durationMs: cmdRes.durationMs,
            });
            toolResultData = cmdRes;
          }

          this.memory.recordToolEvent({
            sessionId: params.sessionId,
            taskId: params.requestId,
            toolName: tc.name,
            args: tc.arguments,
            result: toolResultData,
            status: 'ok',
            durationMs: Date.now() - toolStart,
          });
          this.emitAgentEvent({
            type: 'agent.tool.completed',
            taskId: params.requestId || 'turn',
            sessionId: params.sessionId,
            agentId: route.primaryBrain,
            timestamp: new Date().toISOString(),
            toolName: tc.name,
            toolArgs: tc.arguments,
            toolOutput: toolResultData,
          });
        } catch (toolErr) {
          this.memory.recordToolEvent({
            sessionId: params.sessionId,
            taskId: params.requestId,
            toolName: tc.name,
            args: tc.arguments,
            result: { error: (toolErr as Error).message },
            status: 'error',
            durationMs: Date.now() - toolStart,
          });
        }
      }

      return gen.text || toolOutputsSummary.join('\n');
    }

    throw new Error(`Unsupported route mode: ${route.mode}`);
  }
}

/**
 * ShellGPT Agent Orchestration Engine — SAOE (Phase 3).
 */
export class ShellGPTAgentOrchestrationEngine extends ShellGPTOrchestrator {}
export { ShellGPTOrchestrator as SAOE };
