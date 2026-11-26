import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ShellGPTOrchestrator } from '../../packages/core/src/index.ts';
import { PermissionEngine } from '../../packages/permissions/src/index.ts';
import { MemoryManager } from '../../packages/memory/src/index.ts';
import { CodingToolkit } from '../../packages/tools/src/index.ts';
import { ParallelTaskScheduler } from '../../packages/agents/src/index.ts';
import { AntigravityAdapter } from '../../packages/adapters-antigravity/src/index.ts';
import { CodexAdapter } from '../../packages/adapters-codex/src/index.ts';
import { ClaudeConfigCompatibilityEngine } from '../../packages/claude-compat/src/index.ts';
import { ModelRouter, type ModelCandidate } from '../../packages/router/src/index.ts';

describe('Cross-Module Integration and Boundary Verification', () => {
  test('Core <-> Agents <-> Memory: Delegation lifecycle with SQLite state machine transitions', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-m2m-'));
    try {
      const orchestrator = new ShellGPTOrchestrator(tmpDir);
      const session = orchestrator.getActiveSession();
      assert.ok(session.id, 'Session should have a valid ID');

      const envelope = orchestrator.instructions.createDelegationEnvelope({
        parentSessionId: session.id,
        requestedBy: 'antigravity',
        assignedTo: 'codex',
        role: 'Test Engineer',
        objective: 'Generate deterministic math test fixture',
        scope: 'tests',
        allowedPaths: ['tests'],
        permissions: 'workspace-write',
        validationCommands: [],
      });

      // Execute envelope through central SAOE
      const outcome = await orchestrator.executeDelegatedEnvelope(envelope);
      assert.ok(outcome.task_id === envelope.task_id);

      // Verify SQLite persistence in MemoryManager
      const record = orchestrator.memory.getTaskRecord(envelope.task_id);
      assert.ok(record, 'Task record must exist in SQLite');
      assert.equal(record.agentId, 'codex');
      assert.equal(record.sessionId, session.id);

      // Verify state transitions were captured
      const transitions = orchestrator.memory.getTaskTransitions(envelope.task_id);
      assert.ok(transitions.length >= 2, 'Should have multiple state transitions recorded');
      assert.equal(transitions[0].fromState, 'NONE');
      assert.equal(transitions[0].toState, 'CREATED');
      assert.equal(transitions[1].fromState, 'CREATED');
      assert.equal(transitions[1].toState, 'QUEUED');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Agents (ParallelTaskScheduler) <-> Memory <-> Core: Dependency skip propagation to SQLite', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-m2m-dag-'));
    try {
      const perms = new PermissionEngine(tmpDir, 'workspace-write');
      const memory = new MemoryManager(tmpDir);
      const session = memory.createSession({
        title: 'DAG Skip Test',
        primaryAgent: 'antigravity',
        activeModel: 'gemini-3.8-flash-low',
        executionMode: 'MODE_B_ANTIGRAVITY_PRIMARY',
        permissionMode: 'workspace-write',
      });

      const taskA_id = 'task_parent_fail';
      const taskB_id = 'task_child_skip';

      memory.createTaskRecord({
        taskId: taskA_id,
        sessionId: session.id,
        agentId: 'codex',
        objective: 'Failing parent task',
        initialState: 'CREATED',
      });

      memory.createTaskRecord({
        taskId: taskB_id,
        sessionId: session.id,
        agentId: 'codex',
        objective: 'Child task that depends on parent',
        initialState: 'CREATED',
      });

      const scheduler = new ParallelTaskScheduler({
        maxConcurrency: 2,
        useGitWorktrees: false,
        onTaskSkipped: (task, reason) => {
          memory.transitionTaskState(task.task_id, 'CANCELLED', reason);
        },
      });

      const envelopes = [
        {
          task_id: taskA_id,
          parent_session_id: session.id,
          requested_by: 'antigravity',
          assigned_to: 'codex',
          objective: 'Parent task that fails',
          scope: 'all',
          instructions: '',
          context_refs: [],
          allowed_paths: ['fileA.txt'],
          protected_paths: [],
          available_tools: [],
          expected_outputs: [],
          permissions: 'workspace-write' as const,
          deadline: new Date(Date.now() + 60000).toISOString(),
          validation_commands: [],
          cancellation_token: 'cancel_1',
          read_only: false,
          dependencies: [],
        },
        {
          task_id: taskB_id,
          parent_session_id: session.id,
          requested_by: 'antigravity',
          assigned_to: 'codex',
          objective: 'Child task dependent on A',
          scope: 'all',
          instructions: '',
          context_refs: [],
          allowed_paths: ['fileB.txt'],
          protected_paths: [],
          available_tools: [],
          expected_outputs: [],
          permissions: 'workspace-write' as const,
          deadline: new Date(Date.now() + 60000).toISOString(),
          validation_commands: [],
          cancellation_token: 'cancel_2',
          read_only: false,
          dependencies: [taskA_id],
        },
      ];

      const outcome = await scheduler.executeDag(envelopes, async (t) => {
        if (t.task_id === taskA_id) {
          throw new Error('Forced failure in parent task A');
        }
        return {
          task_id: t.task_id,
          assigned_to: t.assigned_to,
          status: 'completed',
          summary: 'Completed',
          files_modified: [],
          validation_passed: true,
          validation_outputs: [],
          duration_ms: 10,
        };
      });

      assert.equal(outcome.outcomes.length, 2);
      const childOutcome = outcome.outcomes.find((o) => o.task_id === taskB_id);
      assert.ok(childOutcome);
      assert.equal(childOutcome.status, 'cancelled');

      // Verify that child task in SQLite Memory transitioned to CANCELLED via onTaskSkipped
      const childRecord = memory.getTaskRecord(taskB_id);
      assert.ok(childRecord);
      assert.equal(childRecord.state, 'CANCELLED');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Core <-> Tools <-> Memory: Verification pipeline records all steps across modes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-m2m-pipe-'));
    try {
      const perms = new PermissionEngine(tmpDir, 'trusted-automation');
      const memory = new MemoryManager(tmpDir);
      const session = memory.createSession({
        title: 'Pipeline Verification Test',
        primaryAgent: 'antigravity',
        activeModel: 'auto',
        executionMode: 'MODE_B_ANTIGRAVITY_PRIMARY',
        permissionMode: 'trusted-automation',
      });
      const toolkit = new CodingToolkit(tmpDir, perms, memory);

      // Run verification pipeline with multiple configured steps
      const res = await toolkit.runVerificationPipeline({
        sessionId: session.id,
        taskId: 'task_verify_steps',
        lintCommand: "node -e 'process.exit(0)'",
        testCommand: "node -e 'process.exit(0)'",
        buildCommand: "node -e 'process.exit(0)'",
      });

      assert.equal(res.verified, true);
      assert.equal(res.steps.length, 4);

      // Verify that steps were persisted in SQLite test_results table
      const tests = memory.getTestResults(session.id);
      assert.equal(tests.length, 3, 'Should record lint, test, and build in test_results');
      assert.ok(tests.every((t) => t.passed));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Adapters <-> Permissions: readOnly enforcement on Antigravity and Codex', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-m2m-adapters-'));
    try {
      const perms = new PermissionEngine(tmpDir, 'workspace-write');
      const agy = new AntigravityAdapter({ workspaceDir: tmpDir, permissions: perms });
      const codex = new CodexAdapter({ workspaceDir: tmpDir, permissions: perms });

      // When readOnly is passed, child permissions derived for Antigravity must be plan mode
      const childPermsAgy = perms.deriveChildAgentPermissions('read-only');
      assert.equal(childPermsAgy.antigravityMode, 'plan');
      assert.equal(childPermsAgy.antigravityToolPermission, 'strict');

      // For Codex, sandbox must be read-only
      const childPermsCodex = perms.deriveChildAgentPermissions('read-only');
      assert.equal(childPermsCodex.codexSandbox, 'read-only');

      // Verify status inspection
      const agyStatus = await agy.getStatus();
      assert.ok(typeof agyStatus.installed === 'boolean');
      const codexStatus = await codex.getStatus();
      assert.ok(typeof codexStatus.installed === 'boolean');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Router <-> ClaudeCompat: Pure model routing and compatibility settings interop', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-m2m-router-'));
    try {
      // 1. Test ModelRouter ranking and filtering
      const router = new ModelRouter();
      const candidates: ModelCandidate[] = [
        {
          providerId: 'provider-cheap',
          model: 'fast-model-1',
          enabled: true,
          healthy: true,
          authenticated: true,
          authorized: true,
          local: false,
          priority: 50,
          capabilities: ['code', 'stream'],
          costPerMillion: 0.5,
          latencyMs: 120,
        },
        {
          providerId: 'provider-premium',
          model: 'smart-model-2',
          enabled: true,
          healthy: true,
          authenticated: true,
          authorized: true,
          local: false,
          priority: 10,
          capabilities: ['code', 'stream', 'tools'],
          costPerMillion: 5.0,
          latencyMs: 300,
        },
      ];

      // Route by priority
      const byPriority = router.select(candidates, { strategy: 'priority' });
      assert.equal(byPriority.selected?.providerId, 'provider-premium');

      // Route by cost
      const byCost = router.select(candidates, { strategy: 'cost' });
      assert.equal(byCost.selected?.providerId, 'provider-cheap');

      // 2. Test ClaudeConfigCompatibilityEngine resolution
      const engine = new ClaudeConfigCompatibilityEngine(tmpDir);
      const res = engine.resolve({ mode: 'native' });
      assert.equal(res.mode, 'native');
      assert.ok(Array.isArray(res.entries));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
