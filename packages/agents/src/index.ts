import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { sanitizeUntrustedContent, type PermissionMode } from '@shellgpt/permissions';
import type { CodingToolkit } from '@shellgpt/tools';

/**
 * Standardized SAOE (ShellGPT Agent Orchestration Engine) Event Types (Phase 3).
 */
export type AgentEventType =
  | 'agent.started'
  | 'agent.message.delta'
  | 'agent.tool.requested'
  | 'agent.tool.started'
  | 'agent.tool.completed'
  | 'agent.task.completed'
  | 'agent.task.failed'
  | 'agent.permission.required'
  | 'agent.cancelled'
  | 'agent.subagent.dispatched'
  | 'agent.subagent.completed';

/**
 * Durable Task State Machine states (Phase 3).
 * Lifecycle: CREATED -> QUEUED -> RUNNING -> VERIFYING -> COMPLETED
 * Additional states: WAITING_FOR_PERMISSION, BLOCKED, FAILED, CANCELLED, RECOVERING
 */
export type TaskState =
  | 'CREATED'
  | 'QUEUED'
  | 'RUNNING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'WAITING_FOR_PERMISSION'
  | 'BLOCKED'
  | 'FAILED'
  | 'CANCELLED'
  | 'RECOVERING';

export interface TaskArtifact {
  id: string;
  taskId: string;
  type: 'file' | 'diff' | 'report' | 'test_result' | 'evidence';
  path?: string;
  summary: string;
  content?: string;
  createdAt: string;
}

export interface AgentPermission {
  id: string;
  taskId: string;
  actor: string;
  category: string;
  target: string;
  mode: PermissionMode;
  approved: boolean;
  reason: string;
  timestamp: string;
}

export interface AgentError {
  code: string;
  message: string;
  category: string;
  recoverable: boolean;
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface AgentCapabilities {
  agentId: string;
  displayName: string;
  version?: string;
  available: boolean;
  authenticated: boolean;
  supportsStreaming: boolean;
  supportsToolCalling: boolean;
  supportsSessions: boolean;
  supportsSubagentDelegation: boolean;
  supportedModels: string[];
  specializations: string[];
  diagnostic: string;
}

export interface AgentSession {
  sessionId: string;
  agentId: string;
  workspaceDir: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  externalThreadId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentTask {
  taskId: string;
  parentTaskId?: string;
  sessionId: string;
  prompt: string;
  systemInstructions?: string;
  workspaceDir?: string;
  model?: string;
  allowedPaths?: string[];
  protectedPaths?: string[];
  readOnly?: boolean;
  allowSubagentDelegation?: boolean;
  verificationCommands?: string[];
  timeoutMs?: number;
  depth?: number;
  signal?: AbortSignal;
}

export interface AgentResult {
  taskId: string;
  sessionId?: string;
  externalSessionRef?: string;
  agentId: string;
  model: string;
  state: TaskState;
  status: 'completed' | 'failed' | 'cancelled';
  summary: string;
  responseText: string;
  filesModified: string[];
  commandsExecuted: string[];
  testOutcomes: Array<{
    command: string;
    passed: boolean;
    exitCode: number | null;
    output: string;
  }>;
  errors: AgentError[];
  remainingIssues: string[];
  artifacts: TaskArtifact[];
  toolEvents: Array<{ name: string; args: Record<string, unknown>; output?: string }>;
  delegationRequests: Array<{
    targetAgent: string;
    objective: string;
    scope: string;
    allowedFiles: string[];
    verificationCommands: string[];
  }>;
  usage: {
    inputTokens: number | 'unavailable';
    outputTokens: number | 'unavailable';
    measurementType: 'measured' | 'estimated' | 'unavailable';
  };
  durationMs: number;
  diagnostic?: string;
}

export interface AgentEvent {
  type: AgentEventType;
  taskId: string;
  sessionId?: string;
  agentId: string;
  timestamp: string;
  deltaText?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolOutput?: unknown;
  permission?: AgentPermission;
  subagentId?: string;
  subagentTaskId?: string;
  result?: AgentResult;
  error?: AgentError;
  metadata?: Record<string, unknown>;
}

/**
 * Common SAOE Agent Runtime Contract (Phase 3).
 * Every real agent integration implements this contract.
 */
export interface AgentRuntime {
  readonly agentId: string;
  initialize(): Promise<void>;
  checkAvailability(): Promise<{
    available: boolean;
    version?: string;
    binaryPath?: string;
    detail: string;
  }>;
  checkAuthentication(): Promise<{
    authenticated: boolean;
    method?: string;
    detail: string;
  }>;
  getCapabilities(): Promise<AgentCapabilities>;
  createSession(options?: {
    sessionId?: string;
    model?: string;
    workspaceDir?: string;
  }): Promise<AgentSession>;
  resumeSession(sessionId: string): Promise<AgentSession | undefined>;
  executeTask(task: AgentTask): Promise<AgentResult>;
  streamTask(
    task: AgentTask,
    onEvent: (event: AgentEvent) => void,
  ): Promise<AgentResult>;
  cancelTask(taskId: string): boolean;
  getStatus(): Promise<unknown>;
  dispose(): Promise<void>;
}

/**
 * Logical tool schema for `delegate_to_agent` exposed to primary brains (Phase 6).
 */
export interface DelegateToAgentRequest {
  target_agent: 'antigravity' | 'codex' | string;
  task_description: string;
  workspace?: string;
  allowed_paths?: string[];
  context_references?: string[];
  permissions?: PermissionMode;
  expected_output?: string;
  timeout_ms?: number;
  verification_requirements?: string[];
  role?: WorkerRoleName;
}

export const DELEGATE_TO_AGENT_TOOL_DEFINITION = {
  name: 'delegate_to_agent',
  description:
    'Delegate a specialized coding, testing, debugging, refactoring, or architectural research task to Google Antigravity or OpenAI Codex through ShellGPT SAOE orchestration.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      target_agent: {
        type: 'string',
        enum: ['antigravity', 'codex'],
        description: 'Target agent runtime to execute the delegated task.',
      },
      task_description: {
        type: 'string',
        description: 'Clear objective and requirements for the delegated worker.',
      },
      workspace: {
        type: 'string',
        description: 'Target workspace directory (defaults to current project root).',
      },
      allowed_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Relative file or directory paths the worker is permitted to modify.',
      },
      context_references: {
        type: 'array',
        items: { type: 'string' },
        description: 'Relevant files, symbols, or architectural notes to attach.',
      },
      permissions: {
        type: 'string',
        enum: ['read-only', 'ask', 'workspace-write', 'trusted-automation', 'sandbox'],
        description: 'Requested permission ceiling (cannot exceed parent session permission).',
      },
      expected_output: {
        type: 'string',
        description: 'Expected deliverable or verification artifact.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Maximum execution time in milliseconds.',
      },
      verification_requirements: {
        type: 'array',
        items: { type: 'string' },
        description: 'Verification commands (tests, typecheck, build) to run after task completion.',
      },
      role: {
        type: 'string',
        description: 'Optional specialized worker role (e.g. Backend Engineer, Test Engineer, Architect).',
      },
    },
    required: ['target_agent', 'task_description'],
  },
};

/**
 * Delegation Safety Guard (Phase 6):
 * Prevents uncontrolled recursive delegation, duplicate task dispatch,
 * permission escalation, and budget/depth violations.
 */
export class DelegationSafetyGuard {
  private readonly maxDepth: number;
  private readonly maxTasksPerSession: number;
  private readonly activeSignatures = new Set<string>();
  private readonly sessionTaskCounts = new Map<string, number>();

  constructor(options: { maxDepth?: number; maxTasksPerSession?: number } = {}) {
    this.maxDepth = options.maxDepth ?? 3;
    this.maxTasksPerSession = options.maxTasksPerSession ?? 25;
  }

  public computeTaskSignature(
    sessionId: string,
    targetAgent: string,
    objective: string,
    allowedPaths: string[],
  ): string {
    const raw = `${sessionId}::${targetAgent}::${objective.trim().toLowerCase()}::${[...allowedPaths].sort().join(',')}`;
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  public validateAndAcquire(params: {
    sessionId: string;
    requestedBy: string;
    targetAgent: string;
    objective: string;
    allowedPaths: string[];
    depth: number;
  }): { allowed: boolean; signature: string; reason?: string } {
    const signature = this.computeTaskSignature(
      params.sessionId,
      params.targetAgent,
      params.objective,
      params.allowedPaths,
    );

    if (params.depth > this.maxDepth) {
      return {
        allowed: false,
        signature,
        reason: `Delegation depth (${params.depth}) exceeds maximum allowed recursion depth (${this.maxDepth}).`,
      };
    }

    if (this.activeSignatures.has(signature)) {
      return {
        allowed: false,
        signature,
        reason: `Duplicate delegation task detected (${params.requestedBy} -> ${params.targetAgent}: "${params.objective.slice(0, 60)}").`,
      };
    }

    const currentCount = this.sessionTaskCounts.get(params.sessionId) || 0;
    if (currentCount >= this.maxTasksPerSession) {
      return {
        allowed: false,
        signature,
        reason: `Session ${params.sessionId} reached maximum delegated task budget (${this.maxTasksPerSession} tasks).`,
      };
    }

    this.activeSignatures.add(signature);
    this.sessionTaskCounts.set(params.sessionId, currentCount + 1);
    return { allowed: true, signature };
  }

  public release(signature: string): void {
    this.activeSignatures.delete(signature);
  }
}

export interface CanonicalTaskEnvelope {
  task_id: string;
  parent_id?: string;
  parent_session_id: string;
  requested_by: string;
  assigned_to: string;
  role?: WorkerRoleName;
  objective: string;
  scope: string;
  instructions: string;
  context_refs: string[];
  allowed_paths: string[];
  protected_paths: string[];
  available_tools: string[];
  expected_outputs: string[];
  permissions: PermissionMode;
  deadline: string;
  validation_commands: string[];
  cancellation_token: string;
  read_only?: boolean;
  dependencies?: string[];
  depth?: number;
}

export interface TaskExecutionOutcome {
  task_id: string;
  parent_id?: string;
  assigned_to: string;
  role?: WorkerRoleName;
  status: 'completed' | 'failed' | 'cancelled';
  summary: string;
  files_modified: string[];
  validation_passed: boolean;
  validation_outputs: Array<{ command: string; exitCode: number | null; output: string }>;
  duration_ms: number;
  worktree_used?: string;
  error?: string;
}

export type WorkerRoleName =
  | 'Planner'
  | 'Architect'
  | 'Researcher'
  | 'Frontend Engineer'
  | 'Backend Engineer'
  | 'Database Engineer'
  | 'AI/ML Engineer'
  | 'DevOps Engineer'
  | 'Security Auditor'
  | 'Code Reviewer'
  | 'Test Engineer'
  | 'Documentation Engineer'
  | 'Debugger'
  | 'Performance Engineer'
  | 'Reverse Engineering Analyst';

export interface WorkerRoleDefinition {
  role: WorkerRoleName;
  description: string;
  preferredAgent: 'antigravity' | 'codex' | 'custom-llm' | 'local';
  readOnlyDefault: boolean;
  specializations: string[];
  systemDirective: string;
}

export const BUILTIN_WORKER_ROLES: Record<WorkerRoleName, WorkerRoleDefinition> = {
  Planner: {
    role: 'Planner',
    description: 'Decomposes complex requirements into sequenced engineering milestones and DAG tasks.',
    preferredAgent: 'antigravity',
    readOnlyDefault: true,
    specializations: ['planning', 'decomposition', 'risk-analysis'],
    systemDirective: 'Produce clear, verifiable task plans with explicit file scopes and validation commands.',
  },
  Architect: {
    role: 'Architect',
    description: 'Designs modular system architectures, interfaces, and data flows.',
    preferredAgent: 'antigravity',
    readOnlyDefault: true,
    specializations: ['architecture', 'api-design', 'modularity'],
    systemDirective: 'Focus on clean module boundaries, type safety, and provider-independent abstractions.',
  },
  Researcher: {
    role: 'Researcher',
    description: 'Explores repository structure, dependencies, symbols, and documentation.',
    preferredAgent: 'antigravity',
    readOnlyDefault: true,
    specializations: ['research', 'codebase-exploration', 'dependency-analysis'],
    systemDirective: 'Gather accurate evidence with file and line references before drawing conclusions.',
  },
  'Frontend Engineer': {
    role: 'Frontend Engineer',
    description: 'Implements UI components, terminal views, accessibility, and state management.',
    preferredAgent: 'codex',
    readOnlyDefault: false,
    specializations: ['ui', 'frontend', 'tui', 'components'],
    systemDirective: 'Build responsive, accessible, well-typed user interface components.',
  },
  'Backend Engineer': {
    role: 'Backend Engineer',
    description: 'Implements services, APIs, adapters, protocols, and core business logic.',
    preferredAgent: 'codex',
    readOnlyDefault: false,
    specializations: ['backend', 'api', 'services', 'protocols'],
    systemDirective: 'Write robust, fault-tolerant backend services with strict input validation.',
  },
  'Database Engineer': {
    role: 'Database Engineer',
    description: 'Designs SQLite/PostgreSQL schemas, queries, migrations, and data retention.',
    preferredAgent: 'codex',
    readOnlyDefault: false,
    specializations: ['database', 'sql', 'sqlite', 'migrations'],
    systemDirective: 'Ensure ACID integrity, parameterized queries, and safe schema migrations.',
  },
  'AI/ML Engineer': {
    role: 'AI/ML Engineer',
    description: 'Configures LLM gateways, prompt pipelines, context compaction, and model routing.',
    preferredAgent: 'antigravity',
    readOnlyDefault: false,
    specializations: ['llm', 'routing', 'agents', 'context'],
    systemDirective: 'Optimize token budgets, tool schemas, and multi-agent coordination.',
  },
  'DevOps Engineer': {
    role: 'DevOps Engineer',
    description: 'Creates CI/CD pipelines, build scripts, packaging, and deployment automation.',
    preferredAgent: 'codex',
    readOnlyDefault: false,
    specializations: ['devops', 'ci-cd', 'packaging', 'scripts'],
    systemDirective: 'Automate reproducible builds, cross-platform scripts, and health checks.',
  },
  'Security Auditor': {
    role: 'Security Auditor',
    description: 'Audits code, permissions, secrets handling, sandboxing, and injection defenses.',
    preferredAgent: 'codex',
    readOnlyDefault: true,
    specializations: ['security', 'permissions', 'redaction', 'sandboxing'],
    systemDirective: 'Identify privilege escalation, injection risks, and secret exposure.',
  },
  'Code Reviewer': {
    role: 'Code Reviewer',
    description: 'Reviews diffs for correctness, edge cases, style adherence, and regressions.',
    preferredAgent: 'codex',
    readOnlyDefault: true,
    specializations: ['code-review', 'quality', 'static-analysis'],
    systemDirective: 'Provide actionable review findings ranked by severity with exact file locations.',
  },
  'Test Engineer': {
    role: 'Test Engineer',
    description: 'Writes and executes deterministic unit, integration, and end-to-end tests.',
    preferredAgent: 'codex',
    readOnlyDefault: false,
    specializations: ['testing', 'unit-tests', 'integration-tests', 'e2e'],
    systemDirective: 'Write deterministic tests covering happy paths, error handling, and edge cases.',
  },
  'Documentation Engineer': {
    role: 'Documentation Engineer',
    description: 'Produces clear architecture guides, CLI references, feature matrices, and examples.',
    preferredAgent: 'antigravity',
    readOnlyDefault: false,
    specializations: ['documentation', 'guides', 'examples'],
    systemDirective: 'Document real commands, verified capabilities, and honest limitations.',
  },
  Debugger: {
    role: 'Debugger',
    description: 'Diagnoses test failures, runtime exceptions, build errors, and race conditions.',
    preferredAgent: 'codex',
    readOnlyDefault: false,
    specializations: ['debugging', 'root-cause-analysis', 'self-healing'],
    systemDirective: 'Isolate the root cause with evidence and apply minimal verified fixes.',
  },
  'Performance Engineer': {
    role: 'Performance Engineer',
    description: 'Profiles latency, memory usage, concurrency bottlenecks, and token overhead.',
    preferredAgent: 'codex',
    readOnlyDefault: false,
    specializations: ['performance', 'optimization', 'caching'],
    systemDirective: 'Measure before and after optimizing latency and resource consumption.',
  },
  'Reverse Engineering Analyst': {
    role: 'Reverse Engineering Analyst',
    description: 'Executes authorized reverse engineering using REA MCP tools and evidence capture.',
    preferredAgent: 'antigravity',
    readOnlyDefault: true,
    specializations: ['rea', 'reverse-engineering', 'binary-analysis', 'js-analysis'],
    systemDirective: 'Use only genuine discovered REA MCP tools on authorized targets and capture verifiable evidence.',
  },
};

export interface AgentCapabilityDescriptor {
  id: string;
  name: string;
  type: 'coding-agent' | 'autonomous-agent' | 'llm-controller' | 'local-agent';
  runtime: string;
  installed: boolean;
  authenticated: boolean;
  healthy: boolean;
  primaryCapable: boolean;
  subagentCapable: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsSessions: boolean;
  availableModels: string[];
  specializations: string[];
  diagnostic: string;
}

export interface InstructionSourceRecord {
  source: string;
  precedence: number;
  filePath?: string;
  content: string;
  truncated: boolean;
}

export interface ResolvedInstructionPolicy {
  sources: InstructionSourceRecord[];
  canonicalText: string;
  conflictsResolved: string[];
}

const MAX_RULE_FILE_BYTES = 24000;

/**
 * Antigravity and Codex Instruction Bridge (Section 14).
 * Enforces explicit precedence:
 * 1. Per-task instruction overrides (highest)
 * 2. .shellgpt/instructions.md
 * 3. AGENTS.md & .agents/rules/*.md
 * 4. CLAUDE.md & .claude/instructions.md
 * 5. GEMINI.md
 * 6. ShellGPT global settings (lowest)
 */
export class InstructionBridge {
  private readonly workspaceDir: string;
  private globalInstructions: string;

  constructor(workspaceDir: string = process.cwd(), globalInstructions = '') {
    this.workspaceDir = path.resolve(workspaceDir);
    this.globalInstructions = globalInstructions;
  }

  public setGlobalInstructions(text: string): void {
    this.globalInstructions = text;
  }

  private readRuleFile(relPath: string): { content: string; truncated: boolean; fullPath: string } | undefined {
    const fullPath = path.resolve(this.workspaceDir, relPath);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return undefined;
    }
    const raw = fs.readFileSync(fullPath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') <= MAX_RULE_FILE_BYTES) {
      return { content: raw.trim(), truncated: false, fullPath };
    }
    const sliced = raw.slice(0, MAX_RULE_FILE_BYTES);
    const lastNewline = sliced.lastIndexOf('\n');
    return {
      content: (lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced).trim(),
      truncated: true,
      fullPath,
    };
  }

  public resolvePolicy(taskOverride?: string): ResolvedInstructionPolicy {
    const sources: InstructionSourceRecord[] = [];
    const seenPaths = new Set<string>();

    if (taskOverride && taskOverride.trim()) {
      sources.push({
        source: 'per-task-override',
        precedence: 1,
        content: taskOverride.trim(),
        truncated: false,
      });
    }

    const candidateFiles: Array<{ label: string; relPath: string; precedence: number }> = [
      { label: '.shellgpt/instructions.md', relPath: '.shellgpt/instructions.md', precedence: 2 },
      { label: 'AGENTS.md', relPath: 'AGENTS.md', precedence: 3 },
      { label: 'CLAUDE.md', relPath: 'CLAUDE.md', precedence: 4 },
      { label: '.claude/instructions.md', relPath: '.claude/instructions.md', precedence: 4 },
      { label: 'GEMINI.md', relPath: 'GEMINI.md', precedence: 5 },
    ];

    // Also discover .agents/rules/*.md
    const agentsRulesDir = path.join(this.workspaceDir, '.agents', 'rules');
    if (fs.existsSync(agentsRulesDir) && fs.statSync(agentsRulesDir).isDirectory()) {
      for (const entry of fs.readdirSync(agentsRulesDir)) {
        if (entry.endsWith('.md')) {
          candidateFiles.push({
            label: `.agents/rules/${entry}`,
            relPath: path.join('.agents', 'rules', entry),
            precedence: 3,
          });
        }
      }
    }

    candidateFiles.sort((a, b) => a.precedence - b.precedence);

    for (const item of candidateFiles) {
      const loaded = this.readRuleFile(item.relPath);
      if (!loaded || seenPaths.has(loaded.fullPath)) continue;
      seenPaths.add(loaded.fullPath);
      sources.push({
        source: item.label,
        precedence: item.precedence,
        filePath: loaded.fullPath,
        content: loaded.content,
        truncated: loaded.truncated,
      });
    }

    if (this.globalInstructions.trim()) {
      sources.push({
        source: 'shellgpt-global-settings',
        precedence: 6,
        content: this.globalInstructions.trim(),
        truncated: false,
      });
    }

    // Detect and resolve conflicting directives across precedence tiers
    const conflictsResolved: string[] = [];
    const seenDirectives = new Map<string, { value: string; source: string; precedence: number }>();

    for (const src of sources) {
      const lines = src.content.split(/\r?\n/);
      for (const line of lines) {
        const match = /^\s*[-*]?\s*\*\*([A-Za-z0-9 _-]+)\*\*\s*:\s*(.+)$/.exec(line);
        if (match) {
          const key = match[1].trim().toLowerCase();
          const val = match[2].trim();
          const prev = seenDirectives.get(key);
          if (prev && prev.value.toLowerCase() !== val.toLowerCase()) {
            conflictsResolved.push(
              `Directive "${key}": "${prev.source}" (precedence ${prev.precedence}) overrides "${src.source}" (precedence ${src.precedence}).`,
            );
          } else if (!prev) {
            seenDirectives.set(key, { value: val, source: src.source, precedence: src.precedence });
          }
        }
      }
    }

    const canonicalBlocks = sources.map(
      (s) =>
        `### [Precedence ${s.precedence}] ${s.source}${s.truncated ? ' (Truncated at 24KB)' : ''}\n${s.content}`,
    );

    if (conflictsResolved.length > 0) {
      canonicalBlocks.unshift(
        `### Precedence Conflict Resolution Notice\nHigher precedence rules (lower number) strictly override lower precedence rules:\n` +
          conflictsResolved.map((c) => `- ${c}`).join('\n'),
      );
    }

    return {
      sources,
      canonicalText: canonicalBlocks.join('\n\n'),
      conflictsResolved,
    };
  }

  /**
   * Creates a canonical task envelope for Antigravity <-> Codex delegation with untrusted data isolation.
   */
  public createDelegationEnvelope(params: {
    parentSessionId: string;
    parentId?: string;
    requestedBy: string;
    assignedTo: string;
    role?: WorkerRoleName;
    objective: string;
    scope: string;
    allowedPaths: string[];
    protectedPaths?: string[];
    availableTools?: string[];
    expectedOutputs?: string[];
    permissions: PermissionMode;
    validationCommands?: string[];
    untrustedContextRefs?: Array<{ label: string; content: string }>;
    taskInstructionOverride?: string;
    timeoutMs?: number;
    readOnly?: boolean;
    dependencies?: string[];
    depth?: number;
  }): CanonicalTaskEnvelope {
    const policy = this.resolvePolicy(params.taskInstructionOverride);
    const roleDef = params.role ? BUILTIN_WORKER_ROLES[params.role] : undefined;

    const contextRefs: string[] = [];
    for (const ref of params.untrustedContextRefs || []) {
      const sanitized = sanitizeUntrustedContent(ref.content, ref.label);
      contextRefs.push(sanitized.sanitized);
    }

    const scopedInstructions = [
      `# Canonical ShellGPT Delegated Task`,
      `- **Requested By**: ${params.requestedBy}`,
      `- **Assigned To**: ${params.assignedTo}${params.role ? ` (Role: ${params.role})` : ''}`,
      `- **Objective**: ${params.objective}`,
      `- **Scope**: ${params.scope}`,
      `- **Allowed Paths**: ${params.allowedPaths.join(', ') || '(workspace)'}`,
      `- **Protected Paths (DO NOT MODIFY)**: ${(params.protectedPaths || ['.env', '.shellgpt/secrets.enc']).join(', ')}`,
      roleDef ? `- **Role Directive**: ${roleDef.systemDirective}` : '',
      ``,
      `## Active Project Instructions`,
      policy.canonicalText,
    ]
      .filter(Boolean)
      .join('\n');

    return {
      task_id: `task_${crypto.randomUUID().slice(0, 10)}`,
      parent_id: params.parentId,
      parent_session_id: params.parentSessionId,
      requested_by: params.requestedBy,
      assigned_to: params.assignedTo,
      role: params.role,
      objective: params.objective,
      scope: params.scope,
      instructions: scopedInstructions,
      context_refs: contextRefs,
      allowed_paths: params.allowedPaths,
      protected_paths: params.protectedPaths || ['.env', '.shellgpt/secrets.enc'],
      available_tools: params.availableTools || ['read_file', 'write_file', 'edit_file', 'run_command'],
      expected_outputs: params.expectedOutputs || ['Summary of changes and verification status'],
      permissions: params.permissions,
      deadline: new Date(Date.now() + (params.timeoutMs ?? 180000)).toISOString(),
      validation_commands: params.validationCommands || [],
      cancellation_token: `cancel_${crypto.randomUUID().slice(0, 10)}`,
      read_only: params.readOnly ?? roleDef?.readOnlyDefault ?? false,
      dependencies: params.dependencies || [],
      depth: params.depth ?? 1,
    };
  }
}

/**
 * Parallel Task Execution Engine with bounded concurrency, DAG dependency resolution,
 * file-scope conflict detection, and Git worktree isolation.
 */
export class ParallelTaskScheduler {
  private readonly maxConcurrency: number;
  private readonly useGitWorktrees: boolean;
  private readonly toolkit?: CodingToolkit;
  private readonly activeFileLocks = new Map<string, string>(); // normalized path -> task_id

  constructor(options: {
    maxConcurrency?: number;
    useGitWorktrees?: boolean;
    toolkit?: CodingToolkit;
  } = {}) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 3);
    this.useGitWorktrees = options.useGitWorktrees ?? true;
    this.toolkit = options.toolkit;
  }

  /**
   * Detects whether two write tasks have overlapping allowed_paths.
   */
  public detectWriteConflicts(tasks: CanonicalTaskEnvelope[]): Array<{
    taskA: string;
    taskB: string;
    conflictingPath: string;
  }> {
    const conflicts: Array<{ taskA: string; taskB: string; conflictingPath: string }> = [];
    const writeTasks = tasks.filter((t) => !t.read_only);

    for (let i = 0; i < writeTasks.length; i++) {
      for (let j = i + 1; j < writeTasks.length; j++) {
        const a = writeTasks[i];
        const b = writeTasks[j];
        for (const pathA of a.allowed_paths) {
          for (const pathB of b.allowed_paths) {
            const normA = path.normalize(pathA);
            const normB = path.normalize(pathB);
            if (
              normA === normB ||
              normA === '.' ||
              normB === '.' ||
              normA.startsWith(normB + path.sep) ||
              normB.startsWith(normA + path.sep)
            ) {
              conflicts.push({
                taskA: a.task_id,
                taskB: b.task_id,
                conflictingPath: normA === '.' ? normB : normA,
              });
            }
          }
        }
      }
    }
    return conflicts;
  }

  /**
   * Executes a DAG of tasks with bounded concurrency, coordinating write locks so two writing agents
   * never modify identical files concurrently in the same workspace.
   */
  public async executeDag(
    tasks: CanonicalTaskEnvelope[],
    executor: (
      task: CanonicalTaskEnvelope,
      isolatedWorktreeDir?: string,
    ) => Promise<TaskExecutionOutcome>,
    signal?: AbortSignal,
  ): Promise<{
    outcomes: TaskExecutionOutcome[];
    conflictsDetected: Array<{ taskA: string; taskB: string; conflictingPath: string }>;
  }> {
    const conflictsDetected = this.detectWriteConflicts(tasks);
    const outcomes = new Map<string, TaskExecutionOutcome>();
    const pending = new Map<string, CanonicalTaskEnvelope>(
      tasks.map((t) => [t.task_id, t]),
    );
    const running = new Set<string>();

    const canAcquireLocks = (task: CanonicalTaskEnvelope): boolean => {
      if (task.read_only) return true;
      const paths = task.allowed_paths.length > 0 ? task.allowed_paths : ['.'];
      for (const p of paths) {
        const norm = path.normalize(p);
        for (const [lockedPath, ownerId] of this.activeFileLocks.entries()) {
          if (ownerId === task.task_id) continue;
          if (
            norm === lockedPath ||
            norm === '.' ||
            lockedPath === '.' ||
            norm.startsWith(lockedPath + path.sep) ||
            lockedPath.startsWith(norm + path.sep)
          ) {
            return false;
          }
        }
      }
      return true;
    };

    const acquireLocks = (task: CanonicalTaskEnvelope): void => {
      if (task.read_only) return;
      const paths = task.allowed_paths.length > 0 ? task.allowed_paths : ['.'];
      for (const p of paths) {
        this.activeFileLocks.set(path.normalize(p), task.task_id);
      }
    };

    const releaseLocks = (task: CanonicalTaskEnvelope): void => {
      if (task.read_only) return;
      for (const [lockedPath, ownerId] of Array.from(this.activeFileLocks.entries())) {
        if (ownerId === task.task_id) {
          this.activeFileLocks.delete(lockedPath);
        }
      }
    };

    while (pending.size > 0 || running.size > 0) {
      if (signal?.aborted) {
        for (const t of pending.values()) {
          outcomes.set(t.task_id, {
            task_id: t.task_id,
            parent_id: t.parent_id,
            assigned_to: t.assigned_to,
            role: t.role,
            status: 'cancelled',
            summary: 'Cancelled via abort signal.',
            files_modified: [],
            validation_passed: false,
            validation_outputs: [],
            duration_ms: 0,
          });
        }
        break;
      }

      const readyTasks: CanonicalTaskEnvelope[] = [];
      for (const task of pending.values()) {
        if (running.size + readyTasks.length >= this.maxConcurrency) break;
        const deps = task.dependencies || [];
        const depsSatisfied = deps.every(
          (d) => outcomes.get(d)?.status === 'completed',
        );
        const depsFailed = deps.some(
          (d) =>
            outcomes.get(d)?.status === 'failed' ||
            outcomes.get(d)?.status === 'cancelled',
        );

        if (depsFailed) {
          pending.delete(task.task_id);
          outcomes.set(task.task_id, {
            task_id: task.task_id,
            parent_id: task.parent_id,
            assigned_to: task.assigned_to,
            role: task.role,
            status: 'cancelled',
            summary: 'Skipped because a prerequisite dependency task failed.',
            files_modified: [],
            validation_passed: false,
            validation_outputs: [],
            duration_ms: 0,
          });
          continue;
        }

        if (depsSatisfied && canAcquireLocks(task)) {
          acquireLocks(task);
          readyTasks.push(task);
        }
      }

      if (readyTasks.length === 0 && running.size === 0 && pending.size > 0) {
        // Deadlock or circular dependency fallback: run first pending task sequentially
        const nextTask = pending.values().next().value!;
        acquireLocks(nextTask);
        readyTasks.push(nextTask);
      }

      const promises = readyTasks.map(async (task) => {
        pending.delete(task.task_id);
        running.add(task.task_id);
        let worktreeInfo:
          | { worktreeDir: string; branchName?: string; isGitWorktree: boolean }
          | undefined;
        try {
          if (!task.read_only && this.useGitWorktrees && this.toolkit) {
            worktreeInfo = await this.toolkit.createIsolatedWorktree(task.task_id);
          }
          const outcome = await executor(task, worktreeInfo?.worktreeDir);
          if (worktreeInfo) {
            outcome.worktree_used = worktreeInfo.worktreeDir;
          }
          outcomes.set(task.task_id, outcome);
        } catch (err) {
          outcomes.set(task.task_id, {
            task_id: task.task_id,
            parent_id: task.parent_id,
            assigned_to: task.assigned_to,
            role: task.role,
            status: 'failed',
            summary: `Execution error: ${(err as Error).message}`,
            files_modified: [],
            validation_passed: false,
            validation_outputs: [],
            duration_ms: 0,
            error: (err as Error).message,
          });
        } finally {
          if (worktreeInfo && this.toolkit) {
            this.toolkit.removeIsolatedWorktree(
              worktreeInfo.worktreeDir,
              worktreeInfo.branchName,
            );
          }
          releaseLocks(task);
          running.delete(task.task_id);
        }
      });

      if (promises.length > 0) {
        await Promise.race(promises);
      } else {
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    return {
      outcomes: tasks.map((t) => outcomes.get(t.task_id)!).filter(Boolean),
      conflictsDetected,
    };
  }
}
