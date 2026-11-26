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

export interface AntigravityTaskParameters {
    taskId?: string;
    prompt: string;
    systemInstructions?: string;
    model?: string;
    readOnly?: boolean;
    conversationId?: string;
    continueSession?: boolean;
    additionalDirs?: string[];
    allowDelegationToCodex?: boolean;
    onStreamEvent?: (event: { type: string; text?: string; raw?: unknown }) => void;
    signal?: AbortSignal;
}

export interface AntigravityDelegationRequest {
  targetAgent: 'codex' | string;
  objective: string;
  scope: string;
  allowedFiles: string[];
  protectedFiles: string[];
  verificationCommands: string[];
}

export interface AntigravityExecutionResult {
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled';
  model: string;
  responseText: string;
  structuredOutput?: Record<string, unknown>;
  delegationRequests: AntigravityDelegationRequest[];
  toolEvents: Array<{ name: string; args: Record<string, unknown> }>;
  filesModified?: string[];
  artifacts?: TaskArtifact[];
  usage: {
    inputTokens: number | 'unavailable';
    outputTokens: number | 'unavailable';
    measurementType: 'measured' | 'unavailable';
  };
  conversationId?: string;
  diagnostic?: string;
}

export interface AntigravityStatus {
  installed: boolean;
  binaryPath?: string;
  version?: string;
  sdkAvailable: boolean;
  authenticated: boolean;
  availableModels: string[];
  supportsStreaming: boolean;
  supportsAcp: boolean;
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

const DELEGATION_SCHEMA = {
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
    delegate_to_codex: {
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

export class AntigravityAdapter implements AgentRuntime {
  public readonly agentId = 'antigravity';
  private readonly workspaceDir: string;
  private readonly binaryHint: string;
  private readonly defaultModel: string;
  private readonly permissions?: PermissionEngine;
  private readonly activeProcesses = new Map<string, ReturnType<typeof spawn>>();
  private readonly sessions = new Map<string, AgentSession>();

  constructor(options: {
    workspaceDir?: string;
    binaryPath?: string;
    defaultModel?: string;
    permissions?: PermissionEngine;
  } = {}) {
    this.workspaceDir = path.resolve(options.workspaceDir || process.cwd());
    this.binaryHint =
      process.env.ANTIGRAVITY_BIN || options.binaryPath || 'agy';
    this.defaultModel =
      process.env.ANTIGRAVITY_MODEL ||
      options.defaultModel ||
      'gemini-3.8-flash-low';
    this.permissions = options.permissions;
  }

  public async initialize(): Promise<void> {
    this.prepareExecutionEnv();
  }

  public async checkAvailability(): Promise<{
    available: boolean;
    version?: string;
    binaryPath?: string;
    detail: string;
  }> {
    const status = await this.getStatus();
    return {
      available: status.installed,
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
      method: status.sdkAvailable ? 'agy-cli+python-sdk' : 'agy-cli',
      detail: status.diagnostic,
    };
  }

  public async getCapabilities(): Promise<AgentCapabilities> {
    const status = await this.getStatus();
    return {
      agentId: this.agentId,
      displayName: 'Google Antigravity',
      version: status.version,
      available: status.installed,
      authenticated: status.authenticated,
      supportsStreaming: status.supportsStreaming,
      supportsToolCalling: true,
      supportsSessions: true,
      supportsSubagentDelegation: true,
      supportedModels: status.availableModels,
      specializations: [
        'planning',
        'research',
        'architecture',
        'autonomous-implementation',
        'rea',
      ],
      diagnostic: status.diagnostic,
    };
  }

  public async createSession(options: {
    sessionId?: string;
    model?: string;
    workspaceDir?: string;
  } = {}): Promise<AgentSession> {
    const now = new Date().toISOString();
    const session: AgentSession = {
      sessionId: options.sessionId || `agy_sess_${crypto.randomUUID().slice(0, 10)}`,
      agentId: this.agentId,
      workspaceDir: options.workspaceDir || this.workspaceDir,
      model: options.model || this.defaultModel,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  public async resumeSession(sessionId: string): Promise<AgentSession | undefined> {
    return this.sessions.get(sessionId);
  }

  public async dispose(): Promise<void> {
    for (const taskId of Array.from(this.activeProcesses.keys())) {
      this.cancelTask(taskId);
    }
  }

  /**
   * Prepare a writable HOME directory if ~/.gemini/antigravity-cli is mounted read-only in a sandbox.
   */
  private prepareExecutionEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = runtimeEnvironment();
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.SHELLGPT_API_KEY;
    delete env.CLAUDECODE;

    const defaultCliDir = path.join(os.homedir(), '.gemini', 'antigravity-cli');
    try {
      fs.accessSync(defaultCliDir, fs.constants.W_OK);
      return env;
    } catch {
      const fallbackHome = path.join(os.tmpdir(), 'shellgpt-agy-home');
      const fallbackGemini = path.join(fallbackHome, '.gemini');
      fs.mkdirSync(path.join(fallbackGemini, 'antigravity-cli'), { recursive: true });
      const srcConfig = path.join(os.homedir(), '.gemini', 'config');
      const dstConfig = path.join(fallbackGemini, 'config');
      if (fs.existsSync(srcConfig) && !fs.existsSync(dstConfig)) {
        try {
          fs.cpSync(srcConfig, dstConfig, { recursive: true });
        } catch {
          // Ignore copy errors
        }
      }
      env.HOME = fallbackHome;
      return env;
    }
  }

  public resolveBinaryPath(): string | undefined {
    const candidates = [
      this.binaryHint,
      '/home/codespace/.local/bin/agy',
      '/usr/local/bin/agy',
    ];
    for (const c of candidates) {
      try {
        if (path.isAbsolute(c)) {
          if (fs.existsSync(c)) return c;
        } else {
          const found = execFileSync('which', [c], {
            env: runtimeEnvironment(),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
          if (found) return found;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  public async getStatus(): Promise<AntigravityStatus> {
    const bin = this.resolveBinaryPath();
    if (!bin) {
      return {
        installed: false,
        sdkAvailable: false,
        authenticated: false,
        availableModels: [],
        supportsStreaming: false,
        supportsAcp: false,
        diagnostic: 'Antigravity CLI (agy) is not installed.',
      };
    }

    const env = this.prepareExecutionEnv();
    let version = 'unknown';
    try {
      version = execFileSync(bin, ['--version'], {
        encoding: 'utf8',
        env,
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // Ignore version failure
    }

    let sdkAvailable = false;
    try {
      execFileSync('python3', ['-c', 'import google.antigravity'], {
        env: runtimeEnvironment(),
        stdio: 'ignore',
        timeout: 3000,
      });
      sdkAvailable = true;
    } catch {
      sdkAvailable = false;
    }

    // Check authentication & model list via `agy models`
    let authenticated = false;
    const availableModels: string[] = [this.defaultModel];
    let diagnostic = `Antigravity CLI v${version} installed at ${bin}.`;

    try {
      const modelsOut = execFileSync(bin, ['models'], {
        encoding: 'utf8',
        env,
        timeout: 6000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (modelsOut && !/error|failed|login/i.test(modelsOut)) {
        authenticated = true;
        const parsedModels = modelsOut
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('Available'));
        if (parsedModels.length > 0) {
          availableModels.splice(0, availableModels.length, ...parsedModels);
        }
        diagnostic = `Antigravity CLI v${version} authenticated and ready (${availableModels.length} models).`;
      }
    } catch (err) {
      const msg = (err as Error).message || '';
      if (env.HOME?.startsWith(os.tmpdir())) {
        diagnostic = `Antigravity CLI v${version} installed at ${bin}. Running inside restricted sandbox (read-only ~/.gemini/antigravity-cli); run in host terminal for full account session access.`;
      } else {
        diagnostic = `Antigravity CLI v${version} installed at ${bin}, but not authenticated or unreachable (${msg.split('\n')[0].slice(0, 120)}).`;
      }
    }

    return {
      installed: true,
      binaryPath: bin,
      version,
      sdkAvailable,
      authenticated,
      availableModels,
      supportsStreaming: true,
      supportsAcp: true,
      diagnostic,
    };
  }

  public cancelTask(taskId: string): boolean {
    const proc = this.activeProcesses.get(taskId);
    if (!proc) return false;
    proc.kill('SIGKILL');
    this.activeProcesses.delete(taskId);
    return true;
  }

  /**
   * Executes a task on Google Antigravity using official `agy --input-format stream-json --output-format stream-json`.
   */
  public executeTask(task: AgentTask): Promise<AgentResult>;
  public executeTask(params: AntigravityTaskParameters): Promise<AntigravityExecutionResult>;
  public executeTask(params: AgentTask | AntigravityTaskParameters): Promise<AgentResult | AntigravityExecutionResult> {
    if ('sessionId' in params) return this.streamTask(params, () => {});
    return this.executeLegacyTask(params);
  }

  private async executeLegacyTask(params: AntigravityTaskParameters): Promise<AntigravityExecutionResult> {
    const taskId = params.taskId || `agy_${crypto.randomUUID().slice(0, 8)}`;
    const bin = this.resolveBinaryPath();
    const model = params.model || this.defaultModel;

    if (!bin) {
      return {
        taskId,
        status: 'failed',
        model,
        responseText: '',
        delegationRequests: [],
        toolEvents: [],
        usage: {
          inputTokens: 'unavailable',
          outputTokens: 'unavailable',
          measurementType: 'unavailable',
        },
        diagnostic: 'Antigravity CLI (agy) binary not found.',
      };
    }

    const childPerms = this.permissions
      ? this.permissions.deriveChildAgentPermissions(
          params.readOnly ? 'read-only' : undefined,
        )
      : {
          antigravityMode: 'plan' as const,
          antigravityToolPermission: 'strict' as const,
          useSandboxFlag: true,
        };

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-agy-'));
    const schemaPath = path.join(tempDir, 'schema.json');
    fs.writeFileSync(schemaPath, JSON.stringify(DELEGATION_SCHEMA), 'utf8');

    const args: string[] = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      model,
      '--mode',
      childPerms.antigravityMode,
      '--settings',
      JSON.stringify({ toolPermission: childPerms.antigravityToolPermission }),
      '--disable-slash-commands',
      '--json-schema',
      schemaPath,
    ];

    if (childPerms.useSandboxFlag) {
      args.push('--sandbox');
    }
    if (params.conversationId) {
      args.push('--conversation', params.conversationId);
    } else if (params.continueSession) {
      args.push('--continue');
    }
    for (const dir of params.additionalDirs || []) {
      args.push('--add-dir', dir);
    }

    const fullPrompt = [
      params.systemInstructions ? `[Project Instructions]\n${params.systemInstructions}` : '',
      params.allowDelegationToCodex
        ? `[Subagent Delegation Protocol]\nYou may delegate implementation, debugging, refactoring, or test subtasks to OpenAI Codex by populating the "delegate_to_codex" array in your JSON response.`
        : '',
      params.prompt,
    ]
      .filter(Boolean)
      .join('\n\n');

    const env = this.prepareExecutionEnv();
    const beforeSnap = captureWorkspaceSnapshot(this.workspaceDir);
    const startTime = Date.now();

    return new Promise<AntigravityExecutionResult>((resolve) => {
      const child = spawn(bin, args, {
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
              type: String(ev.event || 'message'),
              raw: ev,
            });
          } catch {
            // Partial line
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      const payload =
        JSON.stringify({ event: 'user', message: { content: fullPrompt } }) + '\n';
      child.stdin.write(payload);
      child.stdin.end();

      child.on('close', (code) => {
        this.activeProcesses.delete(taskId);
        fs.rmSync(tempDir, { recursive: true, force: true });
        const afterSnap = captureWorkspaceSnapshot(this.workspaceDir);
        const verifiedModifiedFiles = diffWorkspaceSnapshots(beforeSnap, afterSnap);

        if (params.signal?.aborted) {
          resolve({
            taskId,
            status: 'cancelled',
            model,
            responseText: '',
            delegationRequests: [],
            toolEvents: [],
            filesModified: verifiedModifiedFiles,
            artifacts: [],
            usage: {
              inputTokens: 'unavailable',
              outputTokens: 'unavailable',
              measurementType: 'unavailable',
            },
            diagnostic: 'Antigravity task was cancelled.',
          });
          return;
        }

        const resultEvents: Array<Record<string, unknown>> = [];
        for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (parsed.event === 'result' && parsed.result) {
              resultEvents.push(parsed.result as Record<string, unknown>);
            }
          } catch {
            // Ignore non-JSON lines
          }
        }

        const lastResult = resultEvents[resultEvents.length - 1];
        if (code !== 0 || !lastResult || lastResult.status !== 'SUCCESS') {
          resolve({
            taskId,
            status: 'failed',
            model,
            responseText: '',
            delegationRequests: [],
            toolEvents: [],
            filesModified: verifiedModifiedFiles,
            artifacts: [],
            usage: {
              inputTokens: 'unavailable',
              outputTokens: 'unavailable',
              measurementType: 'unavailable',
            },
            diagnostic:
              stderr.trim().slice(0, 400) ||
              `Antigravity CLI exited with code ${code ?? 1}. Verify agy authentication and quota.`,
          });
          return;
        }

        let structured = lastResult.structured_output as Record<string, unknown> | undefined;
        if (!structured && typeof lastResult.response === 'string') {
          try {
            structured = JSON.parse(lastResult.response) as Record<string, unknown>;
          } catch {
            structured = { text: lastResult.response, tool_calls: [] };
          }
        }

        const responseText =
          typeof structured?.text === 'string'
            ? structured.text
            : String(lastResult.response || '');

        const rawDelegations = Array.isArray(structured?.delegate_to_codex)
          ? (structured.delegate_to_codex as Array<Record<string, unknown>>)
          : [];
        const delegationRequests: AntigravityDelegationRequest[] = rawDelegations.map((d) => ({
          targetAgent: 'codex',
          objective: String(d.objective || ''),
          scope: String(d.scope || ''),
          allowedFiles: Array.isArray(d.allowed_files) ? d.allowed_files.map(String) : [],
          protectedFiles: ['.env', '.shellgpt/secrets.enc'],
          verificationCommands: Array.isArray(d.verification_commands)
            ? d.verification_commands.map(String)
            : [],
        }));

        const rawTools = Array.isArray(structured?.tool_calls)
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

        const rawUsage = (lastResult.usage || {}) as {
          input_tokens?: number;
          output_tokens?: number;
        };

        const artifacts: TaskArtifact[] = verifiedModifiedFiles.map((f) => ({
          id: `art_${crypto.randomUUID().slice(0, 8)}`,
          taskId,
          type: 'file',
          path: f,
          summary: `Verified file modification by Antigravity (${Date.now() - startTime}ms): ${f}`,
          createdAt: new Date().toISOString(),
        }));

        resolve({
          taskId,
          status: 'completed',
          model,
          responseText,
          structuredOutput: structured,
          delegationRequests,
          toolEvents,
          filesModified: verifiedModifiedFiles,
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
          conversationId: lastResult.conversation_id
            ? String(lastResult.conversation_id)
            : params.conversationId,
        });
      });

      child.on('error', (err) => {
        this.activeProcesses.delete(taskId);
        fs.rmSync(tempDir, { recursive: true, force: true });
        resolve({
          taskId,
          status: 'failed',
          model,
          responseText: '',
          delegationRequests: [],
          toolEvents: [],
          filesModified: [],
          artifacts: [],
          usage: {
            inputTokens: 'unavailable',
            outputTokens: 'unavailable',
            measurementType: 'unavailable',
          },
          diagnostic: `Failed to spawn Antigravity CLI: ${err.message}`,
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
      prompt: task.prompt,
      systemInstructions: task.systemInstructions,
      model: task.model,
      readOnly: task.readOnly,
      conversationId: task.sessionId,
      allowDelegationToCodex: task.allowSubagentDelegation ?? true,
      signal: task.signal,
      onStreamEvent: (ev) => {
        onEvent({
          type: 'agent.message.delta',
          taskId: task.taskId,
          sessionId: task.sessionId,
          agentId: this.agentId,
          timestamp: now(),
          deltaText: ev.text,
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
              code: 'ANTIGRAVITY_EXEC_ERROR',
              message: rawRes.diagnostic || 'Antigravity execution failed',
              category: 'runtime',
              recoverable: true,
              timestamp: now(),
            },
          ]
        : [];

    const result: AgentResult = {
      taskId: rawRes.taskId,
      sessionId: task.sessionId,
      externalSessionRef: rawRes.conversationId,
      agentId: this.agentId,
      model: rawRes.model,
      state:
        rawRes.status === 'completed'
          ? 'COMPLETED'
          : rawRes.status === 'cancelled'
            ? 'CANCELLED'
            : 'FAILED',
      status: rawRes.status,
      summary: rawRes.responseText.slice(0, 300),
      responseText: rawRes.responseText,
      filesModified: rawRes.filesModified || [],
      commandsExecuted: rawRes.toolEvents
        .filter((t) => t.name === 'run_command')
        .map((t) => String(t.args.CommandLine || t.args.command || '')),
      testOutcomes: [],
      errors,
      remainingIssues: errors.map((e) => e.message),
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
