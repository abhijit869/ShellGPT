import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { redactSecrets } from '@shellgpt/telemetry';

export interface SessionRecord {
  id: string;
  title: string;
  workspaceDir: string;
  primaryAgent: string;
  activeModel: string;
  executionMode: string;
  permissionMode: string;
  parentSessionId?: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  agent?: string;
  model?: string;
  tokenEstimate: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface CheckpointSnapshot {
  id: string;
  sessionId: string;
  label: string;
  gitHead?: string;
  filesSnapshot: Record<string, string | null>; // relative path -> content or null if did not exist
  createdAt: string;
}

export interface TaskPlanStep {
  id: string;
  title: string;
  assignedAgent: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  files: string[];
  verification?: string;
}

export interface TaskPlanRecord {
  id: string;
  sessionId: string;
  title: string;
  steps: TaskPlanStep[];
  status: 'draft' | 'active' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
}

export interface NeutralContextTransferSummary {
  sessionId: string;
  workspaceDir: string;
  previousAgent: string;
  targetAgent: string;
  objectiveSummary: string;
  completedActions: string[];
  pendingTasks: string[];
  modifiedFiles: string[];
  recentConversation: Array<{ role: string; content: string }>;
  unresolvedErrors?: string[];
  applicableInstructions?: string;
  previousDecisions?: string[];
  relevantFilesAndArtifacts?: string[];
  repositoryState?: {
    branch?: string;
    modifiedFiles: string[];
    untrackedFiles: string[];
  };
  compactedAt: string;
}

export type CrossAgentContextEnvelope = NeutralContextTransferSummary;

export type PersistedTaskState =
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

export interface PersistedTaskRecord {
  taskId: string;
  parentTaskId?: string;
  sessionId: string;
  agentId: string;
  objective: string;
  state: PersistedTaskState;
  pid: number;
  depth: number;
  filesModified: string[];
  artifacts: Array<Record<string, unknown>>;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskStateTransitionRecord {
  id: string;
  taskId: string;
  sessionId: string;
  fromState: PersistedTaskState | 'NONE';
  toState: PersistedTaskState;
  reason: string;
  pid: number;
  timestamp: string;
}

export interface PersistedTestResultRecord {
  id: string;
  sessionId: string;
  taskId?: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  output: string;
  durationMs: number;
  createdAt: string;
}

export interface ExternalStorageAdapter {
  name: string;
  saveSession(session: SessionRecord): Promise<void>;
  loadSession(sessionId: string): Promise<SessionRecord | undefined>;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export class MemoryManager {
  private readonly db: DatabaseSync;
  private readonly workspaceDir: string;
  private readonly getSecrets: () => string[];
  private externalAdapter?: ExternalStorageAdapter;

  constructor(
    workspaceDir: string = process.cwd(),
    dbPathRelative = '.shellgpt/shellgpt.db',
    getSecrets: () => string[] = () => [],
  ) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.getSecrets = getSecrets;
    const resolvedDbPath =
      dbPathRelative === ':memory:'
        ? ':memory:'
        : path.resolve(this.workspaceDir, dbPathRelative);
    if (resolvedDbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
    }
    this.db = new DatabaseSync(resolvedDbPath);
    this.initializeSchema();
  }

  public setExternalAdapter(adapter: ExternalStorageAdapter): void {
    this.externalAdapter = adapter;
  }

  private redact(text: string): string {
    return redactSecrets(text, this.getSecrets());
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_dir TEXT NOT NULL,
        primary_agent TEXT NOT NULL,
        active_model TEXT NOT NULL,
        execution_mode TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        parent_session_id TEXT,
        summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        agent TEXT,
        model TEXT,
        token_estimate INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_results (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        parent_task_id TEXT,
        agent TEXT NOT NULL,
        status TEXT NOT NULL,
        objective TEXT NOT NULL,
        output_json TEXT NOT NULL,
        files_changed_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT,
        tool_name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_plans (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        label TEXT NOT NULL,
        git_head TEXT,
        files_snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS permission_decisions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        category TEXT NOT NULL,
        target TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_usage (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens TEXT NOT NULL,
        output_tokens TEXT NOT NULL,
        cost_usd TEXT NOT NULL,
        measurement_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS error_history (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        component TEXT NOT NULL,
        error_type TEXT NOT NULL,
        message TEXT NOT NULL,
        recoverable INTEGER NOT NULL,
        resolved INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_memories (
        id TEXT PRIMARY KEY,
        workspace_dir TEXT NOT NULL,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        parent_task_id TEXT,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        state TEXT NOT NULL,
        pid INTEGER NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        files_modified_json TEXT NOT NULL DEFAULT '[]',
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        error_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_transitions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        reason TEXT NOT NULL,
        pid INTEGER NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS test_results (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT,
        command TEXT NOT NULL,
        passed INTEGER NOT NULL,
        exit_code INTEGER,
        output TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  public createSession(params: {
    title?: string;
    primaryAgent?: string;
    activeModel?: string;
    executionMode?: string;
    permissionMode?: string;
    parentSessionId?: string;
  } = {}): SessionRecord {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: `sess_${crypto.randomUUID().slice(0, 12)}`,
      title: this.redact(params.title || 'New ShellGPT Session'),
      workspaceDir: this.workspaceDir,
      primaryAgent: params.primaryAgent || 'auto',
      activeModel: params.activeModel || 'default',
      executionMode: params.executionMode || 'auto',
      permissionMode: params.permissionMode || 'ask',
      parentSessionId: params.parentSessionId,
      summary: '',
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO sessions (
          id, title, workspace_dir, primary_agent, active_model,
          execution_mode, permission_mode, parent_session_id, summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.title,
        record.workspaceDir,
        record.primaryAgent,
        record.activeModel,
        record.executionMode,
        record.permissionMode,
        record.parentSessionId ?? null,
        record.summary,
        record.createdAt,
        record.updatedAt,
      );

    if (this.externalAdapter) {
      void this.externalAdapter.saveSession(record);
    }
    return record;
  }

  public getSession(sessionId: string, enforceWorkspace = true): SessionRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (enforceWorkspace && row.workspace_dir !== this.workspaceDir) {
      return undefined;
    }
    return {
      id: String(row.id),
      title: String(row.title),
      workspaceDir: String(row.workspace_dir),
      primaryAgent: String(row.primary_agent),
      activeModel: String(row.active_model),
      executionMode: String(row.execution_mode),
      permissionMode: String(row.permission_mode),
      parentSessionId: row.parent_session_id ? String(row.parent_session_id) : undefined,
      summary: String(row.summary || ''),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  public listSessions(includeAllWorkspaces = false): SessionRecord[] {
    const rows = (
      includeAllWorkspaces
        ? this.db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`).all()
        : this.db
            .prepare(`SELECT * FROM sessions WHERE workspace_dir = ? ORDER BY updated_at DESC`)
            .all(this.workspaceDir)
    ) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      workspaceDir: String(row.workspace_dir),
      primaryAgent: String(row.primary_agent),
      activeModel: String(row.active_model),
      executionMode: String(row.execution_mode),
      permissionMode: String(row.permission_mode),
      parentSessionId: row.parent_session_id ? String(row.parent_session_id) : undefined,
      summary: String(row.summary || ''),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  public renameSession(sessionId: string, newTitle: string): boolean {
    const existing = this.getSession(sessionId);
    if (!existing) return false;
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`)
      .run(this.redact(newTitle), now, sessionId);
    return true;
  }

  public updateSessionAgent(sessionId: string, primaryAgent: string, activeModel?: string): void {
    const now = new Date().toISOString();
    if (activeModel) {
      this.db
        .prepare(
          `UPDATE sessions SET primary_agent = ?, active_model = ?, updated_at = ? WHERE id = ?`,
        )
        .run(primaryAgent, activeModel, now, sessionId);
    } else {
      this.db
        .prepare(`UPDATE sessions SET primary_agent = ?, updated_at = ? WHERE id = ?`)
        .run(primaryAgent, now, sessionId);
    }
  }

  public forkSession(sourceSessionId: string, newTitle?: string): SessionRecord | undefined {
    const source = this.getSession(sourceSessionId);
    if (!source) return undefined;

    const forked = this.createSession({
      title: newTitle || `${source.title} (Fork)`,
      primaryAgent: source.primaryAgent,
      activeModel: source.activeModel,
      executionMode: source.executionMode,
      permissionMode: source.permissionMode,
      parentSessionId: source.id,
    });

    if (source.summary) {
      this.db
        .prepare(`UPDATE sessions SET summary = ? WHERE id = ?`)
        .run(source.summary, forked.id);
      forked.summary = source.summary;
    }

    const messages = this.getMessages(sourceSessionId);
    for (const msg of messages) {
      this.addMessage({
        sessionId: forked.id,
        role: msg.role,
        content: msg.content,
        agent: msg.agent,
        model: msg.model,
        metadata: msg.metadata,
      });
    }

    return forked;
  }

  public deleteSession(sessionId: string): boolean {
    const existing = this.getSession(sessionId);
    if (!existing) return false;
    const tables = [
      'messages',
      'agent_results',
      'tool_events',
      'task_plans',
      'checkpoints',
      'permission_decisions',
      'provider_usage',
      'error_history',
      'tasks',
      'task_transitions',
      'test_results',
    ];
    for (const table of tables) {
      this.db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
    }
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    return true;
  }

  public addMessage(params: {
    sessionId: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    agent?: string;
    model?: string;
    metadata?: Record<string, unknown>;
  }): SessionMessage {
    const safeContent = this.redact(params.content);
    const now = new Date().toISOString();
    const msg: SessionMessage = {
      id: `msg_${crypto.randomUUID().slice(0, 12)}`,
      sessionId: params.sessionId,
      role: params.role,
      content: safeContent,
      agent: params.agent,
      model: params.model,
      tokenEstimate: estimateTokens(safeContent),
      metadata: params.metadata,
      createdAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO messages (
          id, session_id, role, content, agent, model, token_estimate, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        msg.sessionId,
        msg.role,
        msg.content,
        msg.agent ?? null,
        msg.model ?? null,
        msg.tokenEstimate,
        msg.metadata ? this.redact(JSON.stringify(msg.metadata)) : null,
        msg.createdAt,
      );

    this.db
      .prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`)
      .run(now, params.sessionId);

    return msg;
  }

  public getMessages(sessionId: string, limit?: number): SessionMessage[] {
    const rows = (
      limit
        ? this.db
            .prepare(
              `SELECT * FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC`,
            )
            .all(sessionId, limit)
        : this.db
            .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC`)
            .all(sessionId)
    ) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      role: row.role as SessionMessage['role'],
      content: String(row.content),
      agent: row.agent ? String(row.agent) : undefined,
      model: row.model ? String(row.model) : undefined,
      tokenEstimate: Number(row.token_estimate || 0),
      metadata: row.metadata_json
        ? (JSON.parse(String(row.metadata_json)) as Record<string, unknown>)
        : undefined,
      createdAt: String(row.created_at),
    }));
  }

  public searchHistory(query: string): SessionMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE s.workspace_dir = ? AND m.content LIKE ?
         ORDER BY m.created_at DESC LIMIT 50`,
      )
      .all(this.workspaceDir, `%${query}%`) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      role: row.role as SessionMessage['role'],
      content: String(row.content),
      agent: row.agent ? String(row.agent) : undefined,
      model: row.model ? String(row.model) : undefined,
      tokenEstimate: Number(row.token_estimate || 0),
      createdAt: String(row.created_at),
    }));
  }

  /**
   * Automatic context compaction when session tokens exceed budget.
   */
  public compactSessionContext(
    sessionId: string,
    maxTokens = 4000,
    keepRecentMessages = 6,
  ): { compacted: boolean; tokensBefore: number; tokensAfter: number; summary: string } {
    const messages = this.getMessages(sessionId);
    const tokensBefore = messages.reduce((acc, m) => acc + m.tokenEstimate, 0);
    const session = this.getSession(sessionId);
    if (!session) {
      return { compacted: false, tokensBefore: 0, tokensAfter: 0, summary: '' };
    }

    if (tokensBefore <= maxTokens || messages.length <= keepRecentMessages) {
      return {
        compacted: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        summary: session.summary,
      };
    }

    const toCompact = messages.slice(0, messages.length - keepRecentMessages);
    const kept = messages.slice(messages.length - keepRecentMessages);

    const summaryLines: string[] = [];
    if (session.summary) {
      summaryLines.push(session.summary);
    }
    for (const msg of toCompact) {
      const snippet = msg.content.replace(/\s+/g, ' ').slice(0, 180);
      summaryLines.push(`[${msg.role}${msg.agent ? `/${msg.agent}` : ''}]: ${snippet}`);
    }
    const newSummary = this.redact(summaryLines.join('\n').slice(-4000));

    for (const msg of toCompact) {
      this.db.prepare(`DELETE FROM messages WHERE id = ?`).run(msg.id);
    }
    this.db
      .prepare(`UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?`)
      .run(newSummary, new Date().toISOString(), sessionId);

    const tokensAfter =
      estimateTokens(newSummary) + kept.reduce((acc, m) => acc + m.tokenEstimate, 0);

    return {
      compacted: true,
      tokensBefore,
      tokensAfter,
      summary: newSummary,
    };
  }

  /**
   * Builds a provider-neutral context summary when switching between Antigravity, Codex, and Custom APIs.
   */
  public buildNeutralTransferSummary(
    sessionId: string,
    previousAgent: string,
    targetAgent: string,
    extra: {
      applicableInstructions?: string;
      repositoryState?: {
        branch?: string;
        modifiedFiles: string[];
        untrackedFiles: string[];
      };
      alreadyModifiedFiles?: string[];
    } = {},
  ): NeutralContextTransferSummary {
    const session = this.getSession(sessionId);
    const messages = this.getMessages(sessionId, 12);
    const results = this.db
      .prepare(`SELECT * FROM agent_results WHERE session_id = ? ORDER BY created_at ASC`)
      .all(sessionId) as Array<Record<string, unknown>>;

    const completedActions: string[] = [];
    const pendingTasks: string[] = [];
    const modifiedFilesSet = new Set<string>(extra.alreadyModifiedFiles || []);

    for (const r of results) {
      const status = String(r.status);
      const obj = String(r.objective);
      if (status === 'completed') {
        completedActions.push(`[${r.agent}] ${obj}`);
      } else {
        pendingTasks.push(`[${r.agent}/${status}] ${obj}`);
      }
      try {
        const files = JSON.parse(String(r.files_changed_json || '[]')) as string[];
        for (const f of files) modifiedFilesSet.add(f);
      } catch {
        // Ignore parse error
      }
    }

    // Also include tasks from durable task state machine
    const taskRows = this.listSessionTasks(sessionId);
    const artifactsList: string[] = [];
    for (const t of taskRows) {
      for (const f of t.filesModified) modifiedFilesSet.add(f);
      for (const a of t.artifacts) {
        if (typeof a.path === 'string') artifactsList.push(a.path);
        else if (typeof a.summary === 'string') artifactsList.push(a.summary);
      }
      if (t.state === 'COMPLETED') {
        const label = `[${t.agentId}] ${t.objective}`;
        if (!completedActions.includes(label)) completedActions.push(label);
      } else if (t.state !== 'CANCELLED') {
        const label = `[${t.agentId}/${t.state}] ${t.objective}`;
        if (!pendingTasks.includes(label)) pendingTasks.push(label);
      }
    }

    const unresolvedErrors = this.getUnresolvedErrors(sessionId).map(
      (e) => `[${e.component}:${e.errorType}] ${e.message}`,
    );

    const userPrompts = messages.filter((m) => m.role === 'user').map((m) => m.content);
    const assistantTurns = messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content.replace(/\s+/g, ' ').slice(0, 160));
    const objectiveSummary =
      session?.summary ||
      (userPrompts.length > 0
        ? `User objectives: ${userPrompts.map((p) => p.slice(0, 160)).join(' | ')}`
        : 'Interactive coding session');

    return {
      sessionId,
      workspaceDir: this.workspaceDir,
      previousAgent,
      targetAgent,
      objectiveSummary,
      completedActions,
      pendingTasks,
      modifiedFiles: Array.from(modifiedFilesSet),
      recentConversation: messages.slice(-6).map((m) => ({
        role: m.role,
        content: m.content.slice(0, 500),
      })),
      unresolvedErrors,
      applicableInstructions: extra.applicableInstructions,
      previousDecisions: assistantTurns.slice(-5),
      relevantFilesAndArtifacts: Array.from(
        new Set([...Array.from(modifiedFilesSet), ...artifactsList]),
      ),
      repositoryState: extra.repositoryState,
      compactedAt: new Date().toISOString(),
    };
  }

  /**
   * Durable Task State Machine persistence (Phase 3).
   */
  public createTaskRecord(params: {
    taskId: string;
    parentTaskId?: string;
    sessionId: string;
    agentId: string;
    objective: string;
    depth?: number;
    initialState?: PersistedTaskState;
    pid?: number;
  }): PersistedTaskRecord {
    const now = new Date().toISOString();
    const state: PersistedTaskState = params.initialState || 'CREATED';
    const pid = params.pid ?? process.pid;
    const rec: PersistedTaskRecord = {
      taskId: params.taskId,
      parentTaskId: params.parentTaskId,
      sessionId: params.sessionId,
      agentId: params.agentId,
      objective: this.redact(params.objective),
      state,
      pid,
      depth: params.depth ?? 0,
      filesModified: [],
      artifacts: [],
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT OR REPLACE INTO tasks (
          task_id, parent_task_id, session_id, agent_id, objective,
          state, pid, depth, files_modified_json, artifacts_json, error_text, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.taskId,
        rec.parentTaskId ?? null,
        rec.sessionId,
        rec.agentId,
        rec.objective,
        rec.state,
        rec.pid,
        rec.depth,
        '[]',
        '[]',
        null,
        rec.createdAt,
        rec.updatedAt,
      );

    this.db
      .prepare(
        `INSERT INTO task_transitions (
          id, task_id, session_id, from_state, to_state, reason, pid, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `tr_${crypto.randomUUID().slice(0, 12)}`,
        rec.taskId,
        rec.sessionId,
        'NONE',
        state,
        'Task initialized',
        pid,
        now,
      );

    return rec;
  }

  public transitionTaskState(
    taskId: string,
    toState: PersistedTaskState,
    reason = '',
    extra: {
      filesModified?: string[];
      artifacts?: Array<Record<string, unknown>>;
      error?: string;
    } = {},
  ): PersistedTaskRecord | undefined {
    const current = this.getTaskRecord(taskId);
    if (!current) return undefined;
    const now = new Date().toISOString();
    const mergedFiles = extra.filesModified
      ? Array.from(new Set([...current.filesModified, ...extra.filesModified]))
      : current.filesModified;
    const mergedArtifacts = extra.artifacts
      ? [...current.artifacts, ...extra.artifacts]
      : current.artifacts;
    const errorText = extra.error ? this.redact(extra.error) : current.error;

    this.db
      .prepare(
        `UPDATE tasks
         SET state = ?, files_modified_json = ?, artifacts_json = ?, error_text = ?, updated_at = ?
         WHERE task_id = ?`,
      )
      .run(
        toState,
        JSON.stringify(mergedFiles),
        this.redact(JSON.stringify(mergedArtifacts)),
        errorText ?? null,
        now,
        taskId,
      );

    this.db
      .prepare(
        `INSERT INTO task_transitions (
          id, task_id, session_id, from_state, to_state, reason, pid, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `tr_${crypto.randomUUID().slice(0, 12)}`,
        taskId,
        current.sessionId,
        current.state,
        toState,
        this.redact(reason || `Transitioned ${current.state} -> ${toState}`),
        process.pid,
        now,
      );

    return this.getTaskRecord(taskId);
  }

  public getTaskRecord(taskId: string): PersistedTaskRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE task_id = ?`)
      .get(taskId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      taskId: String(row.task_id),
      parentTaskId: row.parent_task_id ? String(row.parent_task_id) : undefined,
      sessionId: String(row.session_id),
      agentId: String(row.agent_id),
      objective: String(row.objective),
      state: row.state as PersistedTaskState,
      pid: Number(row.pid),
      depth: Number(row.depth || 0),
      filesModified: JSON.parse(String(row.files_modified_json || '[]')) as string[],
      artifacts: JSON.parse(String(row.artifacts_json || '[]')) as Array<
        Record<string, unknown>
      >,
      error: row.error_text ? String(row.error_text) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  public getTaskTransitions(taskId: string): TaskStateTransitionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_transitions WHERE task_id = ? ORDER BY timestamp ASC`,
      )
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      sessionId: String(r.session_id),
      fromState: r.from_state as TaskStateTransitionRecord['fromState'],
      toState: r.to_state as PersistedTaskState,
      reason: String(r.reason),
      pid: Number(r.pid),
      timestamp: String(r.timestamp),
    }));
  }

  public listSessionTasks(sessionId: string): PersistedTaskRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at ASC`)
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      taskId: String(row.task_id),
      parentTaskId: row.parent_task_id ? String(row.parent_task_id) : undefined,
      sessionId: String(row.session_id),
      agentId: String(row.agent_id),
      objective: String(row.objective),
      state: row.state as PersistedTaskState,
      pid: Number(row.pid),
      depth: Number(row.depth || 0),
      filesModified: JSON.parse(String(row.files_modified_json || '[]')) as string[],
      artifacts: JSON.parse(String(row.artifacts_json || '[]')) as Array<
        Record<string, unknown>
      >,
      error: row.error_text ? String(row.error_text) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  /**
   * Recovers orphaned tasks left in active states by an unexpected CLI exit (Phase 3).
   * Never claims that terminated external processes are still running.
   */
  public recoverOrphanedTasks(currentPid: number = process.pid): PersistedTaskRecord[] {
    const activeStates = [
      'CREATED',
      'QUEUED',
      'RUNNING',
      'VERIFYING',
      'WAITING_FOR_PERMISSION',
    ];
    const placeholders = activeStates.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE state IN (${placeholders})`)
      .all(...activeStates) as Array<Record<string, unknown>>;

    const recovered: PersistedTaskRecord[] = [];
    for (const row of rows) {
      const taskId = String(row.task_id);
      const taskPid = Number(row.pid);
      let isAlive = false;
      if (taskPid === currentPid) {
        isAlive = true;
      } else if (taskPid > 0) {
        try {
          process.kill(taskPid, 0);
          isAlive = true;
        } catch {
          isAlive = false;
        }
      }

      if (!isAlive) {
        this.transitionTaskState(
          taskId,
          'RECOVERING',
          `Detected unexpected exit of previous CLI process (PID ${taskPid}).`,
        );
        const finalRec = this.transitionTaskState(
          taskId,
          'FAILED',
          `External process (PID ${taskPid}) terminated unexpectedly before completion; marked failed for clean recovery.`,
          {
            error: `Process PID ${taskPid} is no longer running.`,
          },
        );
        if (finalRec) recovered.push(finalRec);
      }
    }
    return recovered;
  }

  public recordTestResult(params: {
    sessionId: string;
    taskId?: string;
    command: string;
    passed: boolean;
    exitCode: number | null;
    output: string;
    durationMs: number;
  }): PersistedTestResultRecord {
    const rec: PersistedTestResultRecord = {
      id: `test_${crypto.randomUUID().slice(0, 12)}`,
      sessionId: params.sessionId,
      taskId: params.taskId,
      command: params.command,
      passed: params.passed,
      exitCode: params.exitCode,
      output: this.redact(params.output.slice(0, 4000)),
      durationMs: params.durationMs,
      createdAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO test_results (
          id, session_id, task_id, command, passed, exit_code, output, duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.sessionId,
        rec.taskId ?? null,
        rec.command,
        rec.passed ? 1 : 0,
        rec.exitCode,
        rec.output,
        rec.durationMs,
        rec.createdAt,
      );

    return rec;
  }

  public getTestResults(sessionId: string): PersistedTestResultRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM test_results WHERE session_id = ? ORDER BY created_at DESC`)
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      sessionId: String(r.session_id),
      taskId: r.task_id ? String(r.task_id) : undefined,
      command: String(r.command),
      passed: Number(r.passed) === 1,
      exitCode: r.exit_code !== null ? Number(r.exit_code) : null,
      output: String(r.output),
      durationMs: Number(r.duration_ms),
      createdAt: String(r.created_at),
    }));
  }

  public recordError(params: {
    sessionId: string;
    component: string;
    errorType: string;
    message: string;
    recoverable?: boolean;
    resolved?: boolean;
  }): string {
    const id = `err_${crypto.randomUUID().slice(0, 12)}`;
    this.db
      .prepare(
        `INSERT INTO error_history (
          id, session_id, component, error_type, message, recoverable, resolved, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.sessionId,
        params.component,
        params.errorType,
        this.redact(params.message),
        params.recoverable !== false ? 1 : 0,
        params.resolved ? 1 : 0,
        new Date().toISOString(),
      );
    return id;
  }

  public getUnresolvedErrors(sessionId: string): Array<{
    id: string;
    component: string;
    errorType: string;
    message: string;
    recoverable: boolean;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT * FROM error_history WHERE session_id = ? AND resolved = 0 ORDER BY created_at DESC`,
      )
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      component: String(r.component),
      errorType: String(r.error_type),
      message: String(r.message),
      recoverable: Number(r.recoverable) === 1,
      createdAt: String(r.created_at),
    }));
  }

  public recordAgentResult(params: {
    sessionId: string;
    taskId: string;
    parentTaskId?: string;
    agent: string;
    status: string;
    objective: string;
    output: unknown;
    filesChanged: string[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO agent_results (
          id, session_id, task_id, parent_task_id, agent, status, objective, output_json, files_changed_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `res_${crypto.randomUUID().slice(0, 12)}`,
        params.sessionId,
        params.taskId,
        params.parentTaskId ?? null,
        params.agent,
        params.status,
        this.redact(params.objective),
        this.redact(JSON.stringify(params.output)),
        JSON.stringify(params.filesChanged),
        new Date().toISOString(),
      );
  }

  public recordToolEvent(params: {
    sessionId: string;
    taskId?: string;
    toolName: string;
    args: unknown;
    result: unknown;
    status: 'ok' | 'error';
    durationMs: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tool_events (
          id, session_id, task_id, tool_name, args_json, result_json, status, duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `tev_${crypto.randomUUID().slice(0, 12)}`,
        params.sessionId,
        params.taskId ?? null,
        params.toolName,
        this.redact(JSON.stringify(params.args)),
        this.redact(JSON.stringify(params.result)),
        params.status,
        params.durationMs,
        new Date().toISOString(),
      );
  }

  public saveTaskPlan(params: {
    sessionId: string;
    title: string;
    steps: TaskPlanStep[];
    status?: TaskPlanRecord['status'];
  }): TaskPlanRecord {
    const now = new Date().toISOString();
    const plan: TaskPlanRecord = {
      id: `plan_${crypto.randomUUID().slice(0, 12)}`,
      sessionId: params.sessionId,
      title: this.redact(params.title),
      steps: params.steps,
      status: params.status || 'active',
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO task_plans (id, session_id, title, steps_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.id,
        plan.sessionId,
        plan.title,
        JSON.stringify(plan.steps),
        plan.status,
        plan.createdAt,
        plan.updatedAt,
      );

    return plan;
  }

  public createCheckpoint(
    sessionId: string,
    label: string,
    filePaths: string[],
    gitHead?: string,
  ): CheckpointSnapshot {
    const filesSnapshot: Record<string, string | null> = {};
    for (const filePath of filePaths) {
      const abs = path.resolve(this.workspaceDir, filePath);
      const rel = path.relative(this.workspaceDir, abs);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        filesSnapshot[rel] = fs.readFileSync(abs, 'utf8');
      } else {
        filesSnapshot[rel] = null;
      }
    }

    const cp: CheckpointSnapshot = {
      id: `chk_${crypto.randomUUID().slice(0, 12)}`,
      sessionId,
      label,
      gitHead,
      filesSnapshot,
      createdAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO checkpoints (id, session_id, label, git_head, files_snapshot_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cp.id,
        cp.sessionId,
        cp.label,
        cp.gitHead ?? null,
        JSON.stringify(cp.filesSnapshot),
        cp.createdAt,
      );

    return cp;
  }

  public listCheckpoints(sessionId: string): CheckpointSnapshot[] {
    const rows = this.db
      .prepare(`SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC`)
      .all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      sessionId: String(r.session_id),
      label: String(r.label),
      gitHead: r.git_head ? String(r.git_head) : undefined,
      filesSnapshot: JSON.parse(String(r.files_snapshot_json)) as Record<string, string | null>,
      createdAt: String(r.created_at),
    }));
  }

  public restoreCheckpoint(checkpointId: string): {
    restoredFiles: string[];
    deletedFiles: string[];
  } {
    const row = this.db
      .prepare(`SELECT * FROM checkpoints WHERE id = ?`)
      .get(checkpointId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Checkpoint "${checkpointId}" not found.`);
    }

    const snapshot = JSON.parse(String(row.files_snapshot_json)) as Record<string, string | null>;
    const restoredFiles: string[] = [];
    const deletedFiles: string[] = [];

    for (const [relPath, content] of Object.entries(snapshot)) {
      const abs = path.resolve(this.workspaceDir, relPath);
      if (!abs.startsWith(this.workspaceDir)) continue;
      if (content === null) {
        if (fs.existsSync(abs)) {
          fs.unlinkSync(abs);
          deletedFiles.push(relPath);
        }
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
        restoredFiles.push(relPath);
      }
    }

    return { restoredFiles, deletedFiles };
  }

  public saveProjectMemory(key: string, content: string, tags: string[] = []): void {
    const id = `${this.workspaceDir}::${key}`;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO project_memories (id, workspace_dir, key, content, tags_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.workspaceDir,
        key,
        this.redact(content),
        JSON.stringify(tags),
        new Date().toISOString(),
      );
  }

  public getProjectMemories(): Array<{ key: string; content: string; tags: string[]; updatedAt: string }> {
    const rows = this.db
      .prepare(`SELECT * FROM project_memories WHERE workspace_dir = ? ORDER BY updated_at DESC`)
      .all(this.workspaceDir) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      key: String(r.key),
      content: String(r.content),
      tags: JSON.parse(String(r.tags_json || '[]')) as string[],
      updatedAt: String(r.updated_at),
    }));
  }

  public deleteProjectMemory(key: string): boolean {
    const id = `${this.workspaceDir}::${key}`;
    const res = this.db.prepare(`DELETE FROM project_memories WHERE id = ?`).run(id);
    return Number(res.changes) > 0;
  }

  public exportSessionJson(sessionId: string): string {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found.`);
    const messages = this.getMessages(sessionId);
    const checkpoints = this.listCheckpoints(sessionId);
    return JSON.stringify({ session, messages, checkpoints }, null, 2);
  }

  public exportSessionMarkdown(sessionId: string): string {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found.`);
    const messages = this.getMessages(sessionId);
    const lines: string[] = [
      `# ${session.title}`,
      ``,
      `- **Session ID**: \`${session.id}\``,
      `- **Workspace**: \`${session.workspaceDir}\``,
      `- **Primary Agent**: \`${session.primaryAgent}\``,
      `- **Active Model**: \`${session.activeModel}\``,
      `- **Created**: ${session.createdAt}`,
      ``,
    ];
    if (session.summary) {
      lines.push(`## Compacted Context Summary`, ``, session.summary, ``);
    }
    lines.push(`## Transcript`, ``);
    for (const m of messages) {
      lines.push(`### ${m.role.toUpperCase()}${m.agent ? ` (${m.agent})` : ''} — ${m.createdAt}`);
      lines.push(``);
      lines.push(m.content);
      lines.push(``);
    }
    return lines.join('\n');
  }
}
