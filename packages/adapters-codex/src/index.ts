import { runtimeEnvironment } from '@shellgpt/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import type { PermissionEngine } from '@shellgpt/permissions';
import type {
  AgentRuntime,
  AgentCapabilities,
  AgentSession,
  AgentTask,
  AgentEvent,
  AgentResult,
  AgentError,
  TaskArtifact,
} from '@shellgpt/agents';

export interface CodexTaskParameters {
    taskId?: string;
    threadId?: string;
    prompt: string;
    systemInstructions?: string;
    model?: string;
    readOnly?: boolean;
    allowDelegationToAntigravity?: boolean;
    onStreamEvent?: (event: { type: string; raw: unknown }) => void;
    signal?: AbortSignal;

}

export interface CodexDelegationRequest {
  targetAgent: 'antigravity' | string;
  objective: string;
  scope: string;
  allowedFiles: string[];
  verificationCommands: string[];
}

export interface CodexExecutionResult {
  taskId: string;
  threadId?: string;
  sessionRef?: string;
  status: 'completed' | 'failed' | 'cancelled';
  model: string;
  summary?: string;
  responseText: string;
  structuredOutput?: Record<string, unknown>;
  delegationRequests: CodexDelegationRequest[];
  toolEvents: Array<{ name: string; args: Record<string, unknown> }>;
  filesModified: string[];
  commandsExecuted?: string[];
  testOutcomes?: Array<{
    command: string;
    passed: boolean;
    exitCode: number | null;
    output: string;
  }>;
  errors?: string[];
  remainingIssues?: string[];
  artifacts?: TaskArtifact[];
  usage: {
    inputTokens: number | 'unavailable';
    outputTokens: number | 'unavailable';
    measurementType: 'measured' | 'unavailable';
  };
  diagnostic?: string;
}

export interface CodexStatus {
  installed: boolean;
  symlinkPresent: boolean;
  binaryPath?: string;
  symlinkTarget?: string;
  version?: string;
  authenticated: boolean;
  availableModels: string[];
  supportsThreads: boolean;
  supportsStreaming: boolean;
  diagnostic: string;
}

function captureWorkspaceSnapshot(rootDir: string): Map<string, string> {
  const snap = new Map<string, string>();
  const skipDirs = new Set(['.git', 'node_modules', '__pycache__', '.shellgpt', 'dist']);

  const walk = (dir: string, depth = 0): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skipDirs.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(rootDir, full).replace(/\\/g, '/');
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.isFile()) {
        try {
          const stat = fs.statSync(full);
          if (stat.size <= 512 * 1024) {
            const hash = crypto
              .createHash('sha256')
              .update(fs.readFileSync(full))
              .digest('hex');
            snap.set(rel, hash);
          } else {
            snap.set(rel, `${stat.size}:${stat.mtimeMs}`);
          }
        } catch {
          // Ignore
        }
      }
    }
  };
  walk(rootDir);
  return snap;
}

function diffWorkspaceSnapshots(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const changed: string[] = [];
  for (const [rel, hash] of after.entries()) {
    if (before.get(rel) !== hash) {
      changed.push(rel);
    }
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) {
      changed.push(rel);
    }
  }
  return changed.sort();
}

const CODEX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          arguments: { type: 'string' },
        },
        required: ['name', 'arguments'],
      },
    },
    delegate_to_antigravity: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          objective: { type: 'string' },
          scope: { type: 'string' },
          allowed_files: { type: 'array', items: { type: 'string' } },
          verification_commands: { type: 'array', items: { type: 'string' } },
        },
        required: ['objective', 'scope', 'allowed_files', 'verification_commands'],
      },
    },
  },
  required: ['text', 'tool_calls'],
};

export class CodexAdapter implements AgentRuntime {
  public readonly agentId = 'codex';
  private readonly workspaceDir: string;
  private readonly binaryHint: string;
  private readonly defaultModel: string;
  private readonly permissions?: PermissionEngine;
  private readonly activeProcesses = new Map<string, ReturnType<typeof spawn>>();
  private readonly threads = new Map<
    string,
    { id: string; model: string; history: Array<{ role: string; content: string }> }
  >();

  constructor(options: {
    workspaceDir?: string;
    binaryPath?: string;
    defaultModel?: string;
    permissions?: PermissionEngine;
  } = {}) {
    this.workspaceDir = path.resolve(options.workspaceDir || process.cwd());
    this.binaryHint = process.env.CODEX_BIN || options.binaryPath || 'codex';
    this.defaultModel =
      process.env.CODEX_MODEL || options.defaultModel || 'gpt-6-astra';
    this.permissions = options.permissions;
  }

  public async initialize(): Promise<void> {
    this.inspectBinary();
  }

  public async checkAvailability(): Promise<{
    available: boolean;
    version?: string;
    binaryPath?: string;
    detail: string;
  }> {
    const status = await this.getStatus();
    return {
      available: status.installed && !status.symlinkPresent,
      version: status.version,
      binaryPath: status.binaryPath,
      detail: status.diagnostic,
    };
  }

  public async checkAuthentication(): Promise<{
    authenticated: boolean;
    method?: string;
    detail: string;
  }> {
    const status = await this.getStatus();
    return {
      authenticated: status.authenticated,
      method: process.env.OPENAI_API_KEY ? 'OPENAI_API_KEY' : 'codex-login',
      detail: status.diagnostic,
    };
  }

  public async getCapabilities(): Promise<AgentCapabilities> {
    const status = await this.getStatus();
    return {
      agentId: this.agentId,
      displayName: 'OpenAI Codex',
      version: status.version,
      available: status.installed,
      authenticated: status.authenticated,
      supportsStreaming: status.supportsStreaming,
      supportsToolCalling: true,
      supportsSessions: status.supportsThreads,
      supportsSubagentDelegation: true,
      supportedModels: status.availableModels,
      specializations: [
        'implementation',
        'debugging',
        'testing',
        'refactoring',
        'code-review',
        'optimization',
        'security-review',
      ],
      diagnostic: status.diagnostic,
    };
  }

  public async createSession(options: {
    sessionId?: string;
    model?: string;
    workspaceDir?: string;
  } = {}): Promise<AgentSession> {
    const threadId = this.startThread(options.model);
    const now = new Date().toISOString();
    return {
      sessionId: options.sessionId || threadId,
      agentId: this.agentId,
      workspaceDir: options.workspaceDir || this.workspaceDir,
      model: options.model || this.defaultModel,
      createdAt: now,
      updatedAt: now,
      externalThreadId: threadId,
    };
  }

  public async resumeSession(sessionId: string): Promise<AgentSession | undefined> {
    if (!this.threads.has(sessionId)) return undefined;
    const thread = this.threads.get(sessionId)!;
    const now = new Date().toISOString();
    return {
      sessionId,
      agentId: this.agentId,
      workspaceDir: this.workspaceDir,
      model: thread.model,
      createdAt: now,
      updatedAt: now,
      externalThreadId: sessionId,
    };
  }

  public async dispose(): Promise<void> {
    for (const taskId of Array.from(this.activeProcesses.keys())) {
      this.cancelTask(taskId);
    }
  }

  public inspectBinary(): {
    executable: boolean;
    symlinkPresent: boolean;
    binaryPath?: string;
    symlinkTarget?: string;
  } {
    const candidates = [
      this.binaryHint,
      '/home/codespace/.local/bin/codex',
      '/usr/local/bin/codex',
    ];

    for (const c of candidates) {
      if (path.isAbsolute(c)) {
        try {
          const lstat = fs.lstatSync(c);
          if (lstat.isSymbolicLink()) {
            const target = fs.readlinkSync(c);
            const existsTarget = fs.existsSync(c);
            return {
              executable: existsTarget,
              symlinkPresent: true,
              binaryPath: c,
              symlinkTarget: target,
            };
          }
          if (lstat.isFile()) {
            return { executable: true, symlinkPresent: false, binaryPath: c };
          }
        } catch {
          continue;
        }
      } else {
        try {
          const found = execFileSync('which', [c], {
            env: runtimeEnvironment(),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
          if (found) {
            return { executable: true, symlinkPresent: false, binaryPath: found };
          }
        } catch {
          continue;
        }
      }
    }
    return { executable: false, symlinkPresent: false };
  }

  public async getStatus(): Promise<CodexStatus> {
    const info = this.inspectBinary();
    if (!info.executable) {
      if (info.symlinkPresent) {
        return {
          installed: true,
          symlinkPresent: true,
          binaryPath: info.binaryPath,
          symlinkTarget: info.symlinkTarget,
          authenticated: false,
          availableModels: [this.defaultModel],
          supportsThreads: true,
          supportsStreaming: true,
          diagnostic: `Codex symlink detected at ${info.binaryPath} -> ${info.symlinkTarget}, but target directory is not mounted in current sandbox. Run in host terminal for live Codex execution.`,
        };
      }
      return {
        installed: false,
        symlinkPresent: false,
        authenticated: false,
        availableModels: [],
        supportsThreads: false,
        supportsStreaming: false,
        diagnostic: 'OpenAI Codex CLI (codex) is not installed.',
      };
    }

    let version = 'unknown';
    try {
      version = execFileSync(info.binaryPath!, ['--version'], {
        env: runtimeEnvironment(),
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // Ignore
    }

    let authenticated = Boolean(process.env.OPENAI_API_KEY);
    try {
      const loginOut = execFileSync(info.binaryPath!, ['login', 'status'], {
        env: runtimeEnvironment(),
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (/logged in|authenticated|active/i.test(loginOut)) {
        authenticated = true;
      }
    } catch {
      const authJson = path.join(os.homedir(), '.codex', 'auth.json');
      if (fs.existsSync(authJson)) authenticated = true;
    }

    return {
      installed: true,
      symlinkPresent: info.symlinkPresent,
      binaryPath: info.binaryPath,
      symlinkTarget: info.symlinkTarget,
      version,
      authenticated,
      availableModels: [this.defaultModel, 'gpt-5-codex', 'o4-mini'],
      supportsThreads: true,
      supportsStreaming: true,
      diagnostic: authenticated
        ? `Codex CLI (${version}) installed and authenticated (default model: ${this.defaultModel}).`
        : `Codex CLI (${version}) installed at ${info.binaryPath}, awaiting authentication (run \`codex login\`).`,
    };
  }

  public startThread(model?: string): string {
    const id = `thread_${crypto.randomUUID().slice(0, 10)}`;
    this.threads.set(id, {
      id,
      model: model || this.defaultModel,
      history: [],
    });
    return id;
  }

  public resumeThread(threadId: string): boolean {
    return this.threads.has(threadId);
  }

  public cancelTask(taskId: string): boolean {
    const proc = this.activeProcesses.get(taskId);
    if (!proc) return false;
    proc.kill('SIGKILL');
    this.activeProcesses.delete(taskId);
    return true;
  }

  /**
   * Executes a task on OpenAI Codex via official `codex exec --json --output-schema ... --output-last-message ...`
   */
  public executeTask(task: AgentTask): Promise<AgentResult>;
  public executeTask(params: CodexTaskParameters): Promise<CodexExecutionResult>;
  public executeTask(params: AgentTask | CodexTaskParameters): Promise<AgentResult | CodexExecutionResult> {
    if ('sessionId' in params) return this.streamTask(params, () => {});
    return this.executeLegacyTask(params);
  }

  private async executeLegacyTask(params: CodexTaskParameters): Promise<CodexExecutionResult> {
    const taskId = params.taskId || `codex_${crypto.randomUUID().slice(0, 8)}`;
    const model = params.model || this.defaultModel;
    const info = this.inspectBinary();

    if (!info.executable || !info.binaryPath) {
      return {
        taskId,
        threadId: params.threadId,
        status: 'failed',
        model,
        responseText: '',
        delegationRequests: [],
        toolEvents: [],
        filesModified: [],
        usage: {
          inputTokens: 'unavailable',
          outputTokens: 'unavailable',
          measurementType: 'unavailable',
        },
        diagnostic: info.symlinkPresent
          ? `Codex binary symlink (${info.binaryPath} -> ${info.symlinkTarget}) is unmounted in current sandbox.`
          : 'Codex CLI binary is not installed.',
      };
    }

    const childPerms = this.permissions
      ? this.permissions.deriveChildAgentPermissions(
          params.readOnly ? 'read-only' : undefined,
        )
      : { codexSandbox: 'read-only' as const };

    const sandboxMode = params.readOnly ? 'read-only' : childPerms.codexSandbox;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-codex-'));
    const schemaPath = path.join(tempDir, 'schema.json');
    const outputPath = path.join(tempDir, 'result.json');
    fs.writeFileSync(schemaPath, JSON.stringify(CODEX_SCHEMA), 'utf8');

    const thread = params.threadId ? this.threads.get(params.threadId) : undefined;
    const historyBlock =
      thread && thread.history.length > 0
        ? `[Thread History]\n${JSON.stringify(thread.history)}`
        : '';

    const fullPrompt = [
      params.systemInstructions ? `[Project Instructions]\n${params.systemInstructions}` : '',
      params.allowDelegationToAntigravity
        ? `[Subagent Delegation Protocol]\nYou may delegate research, architecture planning, or autonomous multi-file analysis to Google Antigravity by populating the "delegate_to_antigravity" array in your JSON response.`
        : '',
      historyBlock,
      params.prompt,
    ]
      .filter(Boolean)
      .join('\n\n');

    const args = [
      'exec',
      '--ignore-user-config',
      '--ephemeral',
      '--sandbox',
      sandboxMode,
      '--skip-git-repo-check',
      '--color',
      'never',
      '--json',
      '-m',
      model,
      '--output-schema',
      schemaPath,
      '--output-last-message',
      outputPath,
      '-',
    ];

    const env = runtimeEnvironment();
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.SHELLGPT_API_KEY;
    delete env.CLAUDECODE;

    // Snapshot actual workspace files BEFORE Codex runs so we verify real disk changes (Phase 5)
    const beforeSnap = captureWorkspaceSnapshot(this.workspaceDir);
    const startTime = Date.now();

    return new Promise<CodexExecutionResult>((resolve) => {
      const child = spawn(info.binaryPath!, args, {
        cwd: this.workspaceDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.activeProcesses.set(taskId, child);

      if (params.signal) {
        params.signal.addEventListener(
          'abort',
          () => {
            child.kill('SIGKILL');
          },
          { once: true },
        );
      }

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdout += text;
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          try {
            const ev = JSON.parse(line) as Record<string, unknown>;
            params.onStreamEvent?.({
              type: String(ev.type || 'event'),
              raw: ev,
            });
          } catch {
            // Ignore partial line
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.stdin.write(fullPrompt);
      child.stdin.end();

      child.on('close', (code) => {
        this.activeProcesses.delete(taskId);
        // Verify actual filesystem changes rather than trusting generated text response (Phase 5)
        const afterSnap = captureWorkspaceSnapshot(this.workspaceDir);
        const verifiedModifiedFiles = diffWorkspaceSnapshots(beforeSnap, afterSnap);

        if (params.signal?.aborted) {
          fs.rmSync(tempDir, { recursive: true, force: true });
          resolve({
            taskId,
            threadId: params.threadId,
            sessionRef: params.threadId || taskId,
            status: 'cancelled',
            model,
            summary: 'Codex task was cancelled.',
            responseText: '',
            delegationRequests: [],
            toolEvents: [],
            filesModified: verifiedModifiedFiles,
            commandsExecuted: [],
            testOutcomes: [],
            errors: ['Task cancelled'],
            remainingIssues: ['Task cancelled before completion'],
            artifacts: [],
            usage: {
              inputTokens: 'unavailable',
              outputTokens: 'unavailable',
              measurementType: 'unavailable',
            },
            diagnostic: 'Codex task was cancelled.',
          });
          return;
        }

        if (code !== 0 || !fs.existsSync(outputPath)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
          const errDiag =
            stderr.trim().slice(0, 400) ||
            `Codex CLI exited with code ${code ?? 1}. Check codex login and model quota.`;
          resolve({
            taskId,
            threadId: params.threadId,
            sessionRef: params.threadId || taskId,
            status: 'failed',
            model,
            summary: errDiag,
            responseText: '',
            delegationRequests: [],
            toolEvents: [],
            filesModified: verifiedModifiedFiles,
            commandsExecuted: [],
            testOutcomes: [],
            errors: [errDiag],
            remainingIssues: [errDiag],
            artifacts: [],
            usage: {
              inputTokens: 'unavailable',
              outputTokens: 'unavailable',
              measurementType: 'unavailable',
            },
            diagnostic: errDiag,
          });
          return;
        }

        let structured: Record<string, unknown> = {};
        try {
          structured = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<
            string,
            unknown
          >;
        } catch {
          structured = { text: fs.readFileSync(outputPath, 'utf8'), tool_calls: [] };
        }
        fs.rmSync(tempDir, { recursive: true, force: true });

        let rawUsage: { input_tokens?: number; output_tokens?: number } = {};
        for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
          try {
            const ev = JSON.parse(line) as Record<string, unknown>;
            if (ev.type === 'turn.completed' && ev.usage) {
              rawUsage = ev.usage as { input_tokens?: number; output_tokens?: number };
            }
          } catch {
            // Ignore
          }
        }

        const responseText =
          typeof structured.text === 'string' ? structured.text : '';

        if (thread) {
          thread.history.push({ role: 'user', content: params.prompt });
          thread.history.push({ role: 'assistant', content: responseText });
        }

        const rawDelegations = Array.isArray(structured.delegate_to_antigravity)
          ? (structured.delegate_to_antigravity as Array<Record<string, unknown>>)
          : [];
        const delegationRequests: CodexDelegationRequest[] = rawDelegations.map((d) => ({
          targetAgent: 'antigravity',
          objective: String(d.objective || ''),
          scope: String(d.scope || ''),
          allowedFiles: Array.isArray(d.allowed_files) ? d.allowed_files.map(String) : [],
          verificationCommands: Array.isArray(d.verification_commands)
            ? d.verification_commands.map(String)
            : [],
        }));

        const rawTools = Array.isArray(structured.tool_calls)
          ? (structured.tool_calls as Array<{ name?: string; arguments?: string }>)
          : [];
        const toolEvents = rawTools.map((tc) => {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = tc.arguments ? JSON.parse(tc.arguments) : {};
          } catch {
            parsedArgs = {};
          }
          return { name: String(tc.name || 'unknown'), args: parsedArgs };
        });

        const commandsExecuted = toolEvents
          .filter((t) => t.name === 'run_command' || t.name === 'shell')
          .map((t) => String(t.args.CommandLine || t.args.command || ''));

        const artifacts: TaskArtifact[] = verifiedModifiedFiles.map((f) => ({
          id: `art_${crypto.randomUUID().slice(0, 8)}`,
          taskId,
          type: 'file',
          path: f,
          summary: `Verified filesystem modification by Codex (${Date.now() - startTime}ms): ${f}`,
          createdAt: new Date().toISOString(),
        }));

        resolve({
          taskId,
          threadId: params.threadId,
          sessionRef: params.threadId || taskId,
          status: 'completed',
          model,
          summary: responseText.slice(0, 300),
          responseText,
          structuredOutput: structured,
          delegationRequests,
          toolEvents,
          filesModified: verifiedModifiedFiles,
          commandsExecuted,
          testOutcomes: [],
          errors: [],
          remainingIssues: [],
          artifacts,
          usage:
            typeof rawUsage.input_tokens === 'number'
              ? {
                  inputTokens: rawUsage.input_tokens,
                  outputTokens: rawUsage.output_tokens ?? 0,
                  measurementType: 'measured',
                }
              : {
                  inputTokens: 'unavailable',
                  outputTokens: 'unavailable',
                  measurementType: 'unavailable',
                },
        });
      });

      child.on('error', (err) => {
        this.activeProcesses.delete(taskId);
        fs.rmSync(tempDir, { recursive: true, force: true });
        resolve({
          taskId,
          threadId: params.threadId,
          sessionRef: params.threadId || taskId,
          status: 'failed',
          model,
          summary: `Failed to spawn Codex CLI: ${err.message}`,
          responseText: '',
          delegationRequests: [],
          toolEvents: [],
          filesModified: [],
          commandsExecuted: [],
          testOutcomes: [],
          errors: [err.message],
          remainingIssues: [err.message],
          artifacts: [],
          usage: {
            inputTokens: 'unavailable',
            outputTokens: 'unavailable',
            measurementType: 'unavailable',
          },
          diagnostic: `Failed to spawn Codex CLI: ${err.message}`,
        });
      });
    });
  }

  /**
   * SAOE standardized `streamTask` implementation emitting normalized `AgentEvent` items.
   */
  public async streamTask(
    task: AgentTask,
    onEvent: (event: AgentEvent) => void,
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const now = () => new Date().toISOString();

    onEvent({
      type: 'agent.started',
      taskId: task.taskId,
      sessionId: task.sessionId,
      agentId: this.agentId,
      timestamp: now(),
    });

    const rawRes = await this.executeLegacyTask({
      taskId: task.taskId,
      threadId: task.sessionId,
      prompt: task.prompt,
      systemInstructions: task.systemInstructions,
      model: task.model,
      readOnly: task.readOnly,
      allowDelegationToAntigravity: task.allowSubagentDelegation ?? true,
      signal: task.signal,
      onStreamEvent: (ev) => {
        onEvent({
          type: 'agent.message.delta',
          taskId: task.taskId,
          sessionId: task.sessionId,
          agentId: this.agentId,
          timestamp: now(),
          metadata: { backendEvent: ev.type, raw: ev.raw },
        });
      },
    });

    for (const tc of rawRes.toolEvents) {
      onEvent({
        type: 'agent.tool.requested',
        taskId: task.taskId,
        sessionId: task.sessionId,
        agentId: this.agentId,
        timestamp: now(),
        toolName: tc.name,
        toolArgs: tc.args,
      });
      onEvent({
        type: 'agent.tool.completed',
        taskId: task.taskId,
        sessionId: task.sessionId,
        agentId: this.agentId,
        timestamp: now(),
        toolName: tc.name,
        toolArgs: tc.args,
      });
    }

    for (const del of rawRes.delegationRequests) {
      onEvent({
        type: 'agent.subagent.dispatched',
        taskId: task.taskId,
        sessionId: task.sessionId,
        agentId: this.agentId,
        timestamp: now(),
        subagentId: del.targetAgent,
        metadata: { objective: del.objective, scope: del.scope },
      });
    }

    const errors: AgentError[] =
      rawRes.status === 'failed'
        ? [
            {
              code: 'CODEX_EXEC_ERROR',
              message: rawRes.diagnostic || 'Codex execution failed',
              category: 'runtime',
              recoverable: true,
              timestamp: now(),
            },
          ]
        : [];

    const result: AgentResult = {
      taskId: rawRes.taskId,
      sessionId: task.sessionId,
      externalSessionRef: rawRes.sessionRef || rawRes.threadId,
      agentId: this.agentId,
      model: rawRes.model,
      state:
        rawRes.status === 'completed'
          ? 'COMPLETED'
          : rawRes.status === 'cancelled'
            ? 'CANCELLED'
            : 'FAILED',
      status: rawRes.status,
      summary: rawRes.summary || rawRes.responseText.slice(0, 300),
      responseText: rawRes.responseText,
      filesModified: rawRes.filesModified,
      commandsExecuted: rawRes.commandsExecuted || [],
      testOutcomes: rawRes.testOutcomes || [],
      errors,
      remainingIssues: rawRes.remainingIssues || errors.map((e) => e.message),
      artifacts: rawRes.artifacts || [],
      toolEvents: rawRes.toolEvents,
      delegationRequests: rawRes.delegationRequests,
      usage: rawRes.usage,
      durationMs: Date.now() - startTime,
      diagnostic: rawRes.diagnostic,
    };

    if (rawRes.status === 'completed') {
      onEvent({
        type: 'agent.task.completed',
        taskId: task.taskId,
        sessionId: task.sessionId,
        agentId: this.agentId,
        timestamp: now(),
        result,
      });
    } else if (rawRes.status === 'cancelled') {
      onEvent({
        type: 'agent.cancelled',
        taskId: task.taskId,
        sessionId: task.sessionId,
        agentId: this.agentId,
        timestamp: now(),
        result,
      });
    } else {
      onEvent({
        type: 'agent.task.failed',
        taskId: task.taskId,
        sessionId: task.sessionId,
        agentId: this.agentId,
        timestamp: now(),
        error: errors[0],
        result,
      });
    }

    return result;
  }
}
