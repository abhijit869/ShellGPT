import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-zA-Z0-9_-]{16,}\b/g,
  /\bsk-ant-[a-zA-Z0-9_-]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bghp_[0-9A-Za-z]{20,}\b/g,
  /\bgithub_pat_[0-9A-Za-z_]{20,}\b/g,
  /\bxox[baprs]-[0-9A-Za-z-]{16,}\b/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{12,}(["']?)/gi,
];

/**
 * Redacts known secret values and common credential patterns from any string.
 */
export function redactSecrets(input: string, explicitSecrets: string[] = []): string {
  if (!input) return input;
  let output = input;
  for (const secret of explicitSecrets) {
    if (secret && secret.length >= 6) {
      output = output.split(secret).join('[REDACTED_SECRET]');
    }
  }
  for (const regex of SECRET_PATTERNS) {
    output = output.replace(regex, (...args) => {
      if (args.length >= 4 && typeof args[1] === 'string' && args[1].length < 40) {
        return `${args[1]}[REDACTED]`;
      }
      return '[REDACTED_SECRET]';
    });
  }
  return output;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  taskId?: string;
  sessionId?: string;
  agent?: string;
  metadata?: Record<string, unknown>;
}

export interface TokenUsageMetric {
  inputTokens: number | 'unavailable';
  outputTokens: number | 'unavailable';
  totalTokens: number | 'unavailable';
  measurementType: 'measured' | 'estimated' | 'unavailable';
}

export interface CostMetric {
  costUsd: number | 'unavailable';
  measurementType: 'measured' | 'estimated' | 'unavailable';
}

export interface TaskTelemetryRecord {
  taskId: string;
  parentTaskId?: string;
  sessionId?: string;
  activeAgent: string;
  agentRuntime: string;
  modelIdentifier: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  toolCallCount: number;
  retryCount: number;
  tokenUsage: TokenUsageMetric;
  cost: CostMetric;
  apiFailures: number;
  mcpFailures: number;
  testOutcomes: { passed: number; failed: number; skipped: number };
  filesChanged: string[];
  lastError?: string;
}

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes: Record<string, string | number | boolean>;
  status: 'OK' | 'ERROR' | 'UNSET';
}

export class TelemetryManager {
  private readonly logFilePath: string;
  private readonly traceFilePath: string;
  private readonly getSecrets: () => string[];
  private readonly recentLogs: LogEntry[] = [];
  private readonly taskRecords = new Map<string, TaskTelemetryRecord>();
  private readonly spans: TraceSpan[] = [];
  private readonly currentTraceId: string;

  constructor(workspaceDir: string = process.cwd(), getSecrets: () => string[] = () => []) {
    const logDir = path.join(workspaceDir, '.shellgpt', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    this.logFilePath = path.join(logDir, 'shellgpt.jsonl');
    this.traceFilePath = path.join(logDir, 'otel-traces.jsonl');
    this.getSecrets = getSecrets;
    this.currentTraceId = crypto.randomBytes(16).toString('hex');
  }

  public log(
    level: LogLevel,
    component: string,
    message: string,
    extra: Partial<Omit<LogEntry, 'timestamp' | 'level' | 'component' | 'message'>> = {},
  ): LogEntry {
    const secrets = this.getSecrets();
    const redactedMessage = redactSecrets(message, secrets);
    const safeMetadata = extra.metadata
      ? (JSON.parse(redactSecrets(JSON.stringify(extra.metadata), secrets)) as Record<
          string,
          unknown
        >)
      : undefined;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message: redactedMessage,
      taskId: extra.taskId,
      sessionId: extra.sessionId,
      agent: extra.agent,
      metadata: safeMetadata,
    };

    this.recentLogs.push(entry);
    if (this.recentLogs.length > 500) {
      this.recentLogs.shift();
    }

    try {
      fs.appendFileSync(this.logFilePath, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // Ignore write failures in read-only sandboxes
    }
    return entry;
  }

  public startTask(params: {
    taskId: string;
    parentTaskId?: string;
    sessionId?: string;
    activeAgent: string;
    agentRuntime: string;
    modelIdentifier: string;
  }): TaskTelemetryRecord {
    const record: TaskTelemetryRecord = {
      taskId: params.taskId,
      parentTaskId: params.parentTaskId,
      sessionId: params.sessionId,
      activeAgent: params.activeAgent,
      agentRuntime: params.agentRuntime,
      modelIdentifier: params.modelIdentifier,
      startedAt: new Date().toISOString(),
      status: 'running',
      toolCallCount: 0,
      retryCount: 0,
      tokenUsage: {
        inputTokens: 'unavailable',
        outputTokens: 'unavailable',
        totalTokens: 'unavailable',
        measurementType: 'unavailable',
      },
      cost: {
        costUsd: 'unavailable',
        measurementType: 'unavailable',
      },
      apiFailures: 0,
      mcpFailures: 0,
      testOutcomes: { passed: 0, failed: 0, skipped: 0 },
      filesChanged: [],
    };
    this.taskRecords.set(params.taskId, record);
    this.log('info', 'telemetry', `Started task ${params.taskId} on ${params.activeAgent}`, {
      taskId: params.taskId,
      sessionId: params.sessionId,
      agent: params.activeAgent,
    });
    return record;
  }

  public updateTask(
    taskId: string,
    updater: (record: TaskTelemetryRecord) => void,
  ): TaskTelemetryRecord | undefined {
    const rec = this.taskRecords.get(taskId);
    if (!rec) return undefined;
    updater(rec);
    return rec;
  }

  public completeTask(
    taskId: string,
    status: 'completed' | 'failed' | 'cancelled' = 'completed',
    errorMsg?: string,
  ): TaskTelemetryRecord | undefined {
    const rec = this.taskRecords.get(taskId);
    if (!rec) return undefined;
    rec.status = status;
    rec.completedAt = new Date().toISOString();
    rec.durationMs = Math.max(
      0,
      new Date(rec.completedAt).getTime() - new Date(rec.startedAt).getTime(),
    );
    if (errorMsg) {
      rec.lastError = redactSecrets(errorMsg, this.getSecrets());
    }
    this.log('info', 'telemetry', `Task ${taskId} finished with status ${status}`, {
      taskId,
      agent: rec.activeAgent,
      metadata: {
        durationMs: rec.durationMs,
        toolCalls: rec.toolCallCount,
        tokenUsage: rec.tokenUsage,
        cost: rec.cost,
      },
    });
    return rec;
  }

  public recordSpan(
    name: string,
    attributes: Record<string, string | number | boolean>,
    status: 'OK' | 'ERROR' = 'OK',
    parentSpanId?: string,
  ): TraceSpan {
    const nowNano = (BigInt(Date.now()) * 1000000n).toString();
    const span: TraceSpan = {
      traceId: this.currentTraceId,
      spanId: crypto.randomBytes(8).toString('hex'),
      parentSpanId,
      name,
      startTimeUnixNano: nowNano,
      endTimeUnixNano: nowNano,
      attributes,
      status,
    };
    this.spans.push(span);
    try {
      fs.appendFileSync(this.traceFilePath, JSON.stringify(span) + '\n', 'utf8');
    } catch {
      // Ignore write failures
    }
    return span;
  }

  public getTaskRecords(): TaskTelemetryRecord[] {
    return Array.from(this.taskRecords.values());
  }

  public getRecentLogs(limit = 50, componentFilter?: string): LogEntry[] {
    const filtered = componentFilter
      ? this.recentLogs.filter((l) => l.component === componentFilter)
      : this.recentLogs;
    return filtered.slice(-limit);
  }

  public getDashboardSummary(): {
    totalTasks: number;
    activeTasks: number;
    totalToolCalls: number;
    totalApiFailures: number;
    totalMcpFailures: number;
    measuredTokens: number;
    estimatedTokens: number;
    measuredCostUsd: number;
    estimatedCostUsd: number;
    hasUnavailableUsage: boolean;
    tasks: TaskTelemetryRecord[];
  } {
    const tasks = this.getTaskRecords();
    let totalToolCalls = 0;
    let totalApiFailures = 0;
    let totalMcpFailures = 0;
    let measuredTokens = 0;
    let estimatedTokens = 0;
    let measuredCostUsd = 0;
    let estimatedCostUsd = 0;
    let hasUnavailableUsage = false;

    for (const t of tasks) {
      totalToolCalls += t.toolCallCount;
      totalApiFailures += t.apiFailures;
      totalMcpFailures += t.mcpFailures;
      if (
        t.tokenUsage.totalTokens === 'unavailable' ||
        t.tokenUsage.measurementType === 'unavailable'
      ) {
        hasUnavailableUsage = true;
      } else if (t.tokenUsage.measurementType === 'measured') {
        measuredTokens += t.tokenUsage.totalTokens;
      } else {
        estimatedTokens += t.tokenUsage.totalTokens;
      }

      if (t.cost.costUsd === 'unavailable' || t.cost.measurementType === 'unavailable') {
        hasUnavailableUsage = true;
      } else if (t.cost.measurementType === 'measured') {
        measuredCostUsd += t.cost.costUsd;
      } else {
        estimatedCostUsd += t.cost.costUsd;
      }
    }

    return {
      totalTasks: tasks.length,
      activeTasks: tasks.filter((t) => t.status === 'running').length,
      totalToolCalls,
      totalApiFailures,
      totalMcpFailures,
      measuredTokens,
      estimatedTokens,
      measuredCostUsd,
      estimatedCostUsd,
      hasUnavailableUsage,
      tasks,
    };
  }
}
