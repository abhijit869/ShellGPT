import { runtimeEnvironment } from '@shellgpt/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

export type HookEventName =
  | 'SessionStart'
  | 'UserPromptReceived'
  | 'PreInvocation'
  | 'PostInvocation'
  | 'BeforeToolExecution'
  | 'PreToolUse'
  | 'AfterToolExecution'
  | 'PostToolUse'
  | 'BeforeFileEdit'
  | 'AfterFileEdit'
  | 'PermissionRequest'
  | 'AgentDispatched'
  | 'AgentCompleted'
  | 'VerificationCompleted'
  | 'SessionStopped'
  | 'Stop';

export interface HookHandlerSpec {
  type?: 'command';
  command: string;
  timeout?: number; // seconds, default 30
  trusted?: boolean;
}

export interface HookMatcherGroup {
  matcher?: string;
  hooks: HookHandlerSpec[];
}

export interface NamedHookConfig {
  enabled?: boolean;
  trusted?: boolean;
  [event: string]: unknown;
}

export interface HookExecutionPayload {
  conversationId: string;
  workspacePaths: string[];
  modelName: string;
  hookEventName: HookEventName;
  cwd: string;
  lastUserInput?: string;
  toolCall?: {
    id: string;
    name: string;
    args: Record<string, unknown>;
  };
  stepIdx?: number;
  error?: string;
  agent?: string;
}

export interface HookExecutionResult {
  hookName: string;
  event: HookEventName;
  decision?: 'allow' | 'deny' | 'ask' | 'force_ask' | 'continue';
  reason?: string;
  overwrite?: Record<string, unknown>;
  injectSteps?: Array<Record<string, unknown>>;
  terminationBehavior?: '' | 'terminate' | 'force_continue';
  timedOut?: boolean;
  error?: string;
}

export class HookEngine {
  private readonly workspaceDir: string;
  private readonly hooks = new Map<string, { config: NamedHookConfig; baseDir: string }>();
  private requireExplicitTrust = true;
  private readonly trustedHookNames = new Set<string>();

  constructor(workspaceDir: string = process.cwd(), requireExplicitTrust = true) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.requireExplicitTrust = requireExplicitTrust;
    this.loadConfigs();
  }

  public loadConfigs(): void {
    this.hooks.clear();
    const candidates = [
      path.join(this.workspaceDir, '.agents', 'hooks.json'),
      path.join(this.workspaceDir, '.shellgpt', 'hooks.json'),
    ];

    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
          string,
          NamedHookConfig
        >;
        for (const [name, cfg] of Object.entries(raw)) {
          this.hooks.set(name, { config: cfg, baseDir: path.dirname(file) });
          if (cfg.trusted === true) {
            this.trustedHookNames.add(name);
          }
        }
      } catch {
        // Ignore invalid hooks.json
      }
    }
  }

  public registerHook(
    name: string,
    config: NamedHookConfig,
    options: { trusted?: boolean; baseDir?: string } = {},
  ): void {
    this.hooks.set(name, {
      config,
      baseDir: options.baseDir || this.workspaceDir,
    });
    if (options.trusted || config.trusted) {
      this.trustedHookNames.add(name);
    }
  }

  public trustHook(name: string): void {
    this.trustedHookNames.add(name);
  }

  public setHookEnabled(name: string, enabled: boolean): boolean {
    const entry = this.hooks.get(name);
    if (!entry) return false;
    entry.config.enabled = enabled;
    return true;
  }

  public listHooks(): Array<{ name: string; enabled: boolean; trusted: boolean; events: string[] }> {
    const list: Array<{ name: string; enabled: boolean; trusted: boolean; events: string[] }> = [];
    for (const [name, { config }] of this.hooks.entries()) {
      const events = Object.keys(config).filter(
        (k) => k !== 'enabled' && k !== 'trusted',
      );
      list.push({
        name,
        enabled: config.enabled !== false,
        trusted: this.trustedHookNames.has(name),
        events,
      });
    }
    return list;
  }

  private matchesTool(matcher: string | undefined, toolName: string | undefined): boolean {
    if (!matcher || matcher === '*') return true;
    if (!toolName) return false;
    try {
      const rx = new RegExp(`^(?:${matcher})$`, 'i');
      return rx.test(toolName);
    } catch {
      return matcher === toolName;
    }
  }

  public async emit(
    event: HookEventName,
    payload: Omit<HookExecutionPayload, 'hookEventName'>,
  ): Promise<HookExecutionResult[]> {
    const results: HookExecutionResult[] = [];
    const aliasEvents: HookEventName[] = [event];
    if (event === 'BeforeToolExecution') aliasEvents.push('PreToolUse');
    if (event === 'PreToolUse') aliasEvents.push('BeforeToolExecution');
    if (event === 'AfterToolExecution') aliasEvents.push('PostToolUse');
    if (event === 'PostToolUse') aliasEvents.push('AfterToolExecution');
    if (event === 'UserPromptReceived') aliasEvents.push('PreInvocation');
    if (event === 'SessionStopped') aliasEvents.push('Stop');

    for (const [hookName, { config, baseDir }] of this.hooks.entries()) {
      if (config.enabled === false) continue;

      if (this.requireExplicitTrust && !this.trustedHookNames.has(hookName)) {
        results.push({
          hookName,
          event,
          error: `Skipped untrusted hook "${hookName}". Trust it explicitly before execution.`,
        });
        continue;
      }

      for (const evName of aliasEvents) {
        const rawEntries = config[evName];
        if (!Array.isArray(rawEntries)) continue;

        for (const item of rawEntries) {
          if (item && typeof item === 'object' && 'hooks' in item) {
            const group = item as HookMatcherGroup;
            if (!this.matchesTool(group.matcher, payload.toolCall?.name)) continue;
            for (const handler of group.hooks || []) {
              results.push(
                await this.runCommandHandler(hookName, event, handler, baseDir, {
                  ...payload,
                  hookEventName: event,
                }),
              );
            }
          } else if (item && typeof item === 'object' && 'command' in item) {
            const handler = item as HookHandlerSpec;
            results.push(
              await this.runCommandHandler(hookName, event, handler, baseDir, {
                ...payload,
                hookEventName: event,
              }),
            );
          }
        }
      }
    }

    return results;
  }

  private async runCommandHandler(
    hookName: string,
    event: HookEventName,
    handler: HookHandlerSpec,
    baseDir: string,
    payload: HookExecutionPayload,
  ): Promise<HookExecutionResult> {
    const timeoutMs = (handler.timeout ?? 30) * 1000;
    const shellBin = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const shellArgs =
      process.platform === 'win32'
        ? ['/d', '/s', '/c', handler.command]
        : ['-c', handler.command];

    return new Promise<HookExecutionResult>((resolve) => {
      const child = spawn(shellBin, shellArgs, {
        cwd: baseDir,
        env: runtimeEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      // Hooks that do not consume stdin may exit before the payload is flushed.
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') stderr += `Hook stdin error: ${error.message}`;
      });
      child.stdin.write(JSON.stringify(payload) + '\n');
      child.stdin.end();

      child.on('close', () => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({
            hookName,
            event,
            timedOut: true,
            error: `Hook "${hookName}" timed out after ${handler.timeout ?? 30}s`,
          });
          return;
        }
        try {
          const parsed = stdout.trim()
            ? (JSON.parse(stdout.trim()) as Record<string, unknown>)
            : {};
          resolve({
            hookName,
            event,
            decision: parsed.decision as HookExecutionResult['decision'],
            reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
            overwrite:
              parsed.overwrite && typeof parsed.overwrite === 'object'
                ? (parsed.overwrite as Record<string, unknown>)
                : undefined,
            injectSteps: Array.isArray(parsed.injectSteps)
              ? (parsed.injectSteps as Array<Record<string, unknown>>)
              : undefined,
            terminationBehavior:
              typeof parsed.terminationBehavior === 'string'
                ? (parsed.terminationBehavior as HookExecutionResult['terminationBehavior'])
                : undefined,
          });
        } catch {
          resolve({
            hookName,
            event,
            error: stderr.trim() || 'Hook returned non-JSON output',
          });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          hookName,
          event,
          error: err.message,
        });
      });
    });
  }
}
