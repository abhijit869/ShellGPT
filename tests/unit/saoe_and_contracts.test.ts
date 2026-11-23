import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  DelegationSafetyGuard,
  DELEGATE_TO_AGENT_TOOL_DEFINITION,
  type AgentRuntime,
  type AgentTask,
  type AgentEvent,
} from '@shellgpt/agents';
import { AntigravityAdapter } from '@shellgpt/adapters-antigravity';
import { CodexAdapter } from '@shellgpt/adapters-codex';
import { MemoryManager } from '@shellgpt/memory';
import { PermissionEngine } from '@shellgpt/permissions';
import { CodingToolkit } from '@shellgpt/tools';
import { ShellGPTOrchestrator } from '@shellgpt/core';
import { runCli } from '../../apps/cli/src/index.ts';

describe('SAOE Agent Runtime Contracts, Task State Machine, Safety & Tooling', () => {
  it('verifies AntigravityAdapter and CodexAdapter implement the AgentRuntime contract', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-runtime-test-'));
    try {
      const perms = new PermissionEngine(tmpDir, 'workspace-write');
      const agy: AgentRuntime = new AntigravityAdapter({ workspaceDir: tmpDir, permissions: perms });
      const codex: AgentRuntime = new CodexAdapter({ workspaceDir: tmpDir, permissions: perms });

      assert.equal(agy.agentId, 'antigravity');
      assert.equal(codex.agentId, 'codex');

      await agy.initialize();
      await codex.initialize();

      const agyAvail = await agy.checkAvailability();
      assert.equal(typeof agyAvail.available, 'boolean');
      assert.ok(agyAvail.detail);

      const codexAvail = await codex.checkAvailability();
      assert.equal(typeof codexAvail.available, 'boolean');
      assert.ok(codexAvail.detail);

      const agyCaps = await agy.getCapabilities();
      assert.equal(agyCaps.agentId, 'antigravity');
      assert.equal(agyCaps.supportsToolCalling, true);
      assert.equal(agyCaps.supportsSubagentDelegation, true);
      assert.ok(agyCaps.specializations.includes('architecture'));

      const codexCaps = await codex.getCapabilities();
      assert.equal(codexCaps.agentId, 'codex');
      assert.equal(codexCaps.supportsToolCalling, true);
      assert.equal(codexCaps.supportsSubagentDelegation, true);
      assert.ok(codexCaps.specializations.includes('implementation'));

      const agySess = await agy.createSession({ sessionId: 'sess_agy_test' });
      assert.equal(agySess.sessionId, 'sess_agy_test');
      assert.equal(agySess.agentId, 'antigravity');
      const resumedAgy = await agy.resumeSession('sess_agy_test');
      assert.equal(resumedAgy?.sessionId, 'sess_agy_test');

      const codexSess = await codex.createSession({ sessionId: 'sess_codex_test' });
      assert.equal(codexSess.sessionId, 'sess_codex_test');
      assert.equal(codexSess.agentId, 'codex');

      assert.equal(agy.cancelTask('nonexistent'), false);
      assert.equal(codex.cancelTask('nonexistent'), false);

      await agy.dispose();
      await codex.dispose();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('persists durable Task State Machine transitions and recovers orphaned tasks after unexpected exit', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-tsm-test-'));
    try {
      const mem = new MemoryManager(tmpDir, '.shellgpt/test_tsm.db');
      const sess = mem.createSession({ title: 'TSM Session' });

      // 1. Create task
      const task = mem.createTaskRecord({
        taskId: 't_state_1',
        sessionId: sess.id,
        agentId: 'antigravity',
        objective: 'Test state machine',
        initialState: 'CREATED',
        pid: 99999999, // non-existent PID
      });
      assert.equal(task.state, 'CREATED');

      // 2. Transition CREATED -> QUEUED -> RUNNING -> VERIFYING -> COMPLETED
      const queued = mem.transitionTaskState('t_state_1', 'QUEUED', 'Queued in SAOE');
      assert.equal(queued?.state, 'QUEUED');

      const running = mem.transitionTaskState('t_state_1', 'RUNNING', 'Running worker');
      assert.equal(running?.state, 'RUNNING');

      const verifying = mem.transitionTaskState('t_state_1', 'VERIFYING', 'Running tests', {
        filesModified: ['src/app.ts'],
      });
      assert.equal(verifying?.state, 'VERIFYING');
      assert.deepEqual(verifying?.filesModified, ['src/app.ts']);

      const completed = mem.transitionTaskState('t_state_1', 'COMPLETED', 'Finished successfully');
      assert.equal(completed?.state, 'COMPLETED');

      // Check transition audit trail
      const transitions = mem.getTaskTransitions('t_state_1');
      assert.equal(transitions.length, 5);
      assert.equal(transitions[0].toState, 'CREATED');
      assert.equal(transitions[4].toState, 'COMPLETED');

      // 3. Test orphan recovery: create a task with dead PID in RUNNING state
      mem.createTaskRecord({
        taskId: 't_dead_pid',
        sessionId: sess.id,
        agentId: 'codex',
        objective: 'Orphaned task from crashed CLI',
        initialState: 'RUNNING',
        pid: 99999998,
      });

      const recovered = mem.recoverOrphanedTasks(process.pid);
      assert.ok(recovered.some((r) => r.taskId === 't_dead_pid'));
      const deadTask = mem.getTaskRecord('t_dead_pid');
      assert.equal(deadTask?.state, 'FAILED');
      assert.match(deadTask?.error || '', /no longer running/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('enforces DelegationSafetyGuard: recursion depth, duplicate detection, and session budgets', () => {
    const guard = new DelegationSafetyGuard({ maxDepth: 2, maxTasksPerSession: 4 });

    // 1. Normal task succeeds
    const t1 = guard.validateAndAcquire({
      sessionId: 's1',
      requestedBy: 'antigravity',
      targetAgent: 'codex',
      objective: 'Implement auth',
      allowedPaths: ['src/auth.ts'],
      depth: 1,
    });
    assert.equal(t1.allowed, true);

    // 2. Duplicate active task fails
    const tDuplicate = guard.validateAndAcquire({
      sessionId: 's1',
      requestedBy: 'antigravity',
      targetAgent: 'codex',
      objective: 'Implement auth',
      allowedPaths: ['src/auth.ts'],
      depth: 1,
    });
    assert.equal(tDuplicate.allowed, false);
    assert.match(tDuplicate.reason || '', /Duplicate delegation task/);

    // Release t1
    guard.release(t1.signature);

    // 3. Excessive depth fails
    const tDeep = guard.validateAndAcquire({
      sessionId: 's1',
      requestedBy: 'codex',
      targetAgent: 'antigravity',
      objective: 'Recursive subtask',
      allowedPaths: ['src/deep.ts'],
      depth: 3, // exceeds maxDepth of 2
    });
    assert.equal(tDeep.allowed, false);
    assert.match(tDeep.reason || '', /exceeds maximum allowed recursion depth/);

    // 4. Budget limit
    guard.validateAndAcquire({
      sessionId: 's1',
      requestedBy: 'a',
      targetAgent: 'b',
      objective: 'task 2',
      allowedPaths: ['p2'],
      depth: 1,
    });
    guard.validateAndAcquire({
      sessionId: 's1',
      requestedBy: 'a',
      targetAgent: 'b',
      objective: 'task 3',
      allowedPaths: ['p3'],
      depth: 1,
    });
    guard.validateAndAcquire({
      sessionId: 's1',
      requestedBy: 'a',
      targetAgent: 'b',
      objective: 'task 4',
      allowedPaths: ['p4'],
      depth: 1,
    });
    const tOverBudget = guard.validateAndAcquire({
      sessionId: 's1',
      requestedBy: 'a',
      targetAgent: 'b',
      objective: 'task 5',
      allowedPaths: ['p5'],
      depth: 1,
    });
    assert.equal(tOverBudget.allowed, false);
    assert.match(tOverBudget.reason || '', /maximum delegated task budget/);
  });

  it('tests CodingToolkit extensions: globFiles, listDirectory, inspectFile, gitBranches, gitValidateMerge, and runVerificationPipeline', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-tools-ext-'));
    try {
      const perms = new PermissionEngine(tmpDir, 'workspace-write');
      const mem = new MemoryManager(tmpDir);
      const sess = mem.createSession({ title: 'Ext Test' });
      const toolkit = new CodingToolkit(tmpDir, perms, mem);

      await toolkit.writeFile('src/utils/math.ts', 'export const add = (a: number, b: number) => a + b;\n', {
        sessionId: sess.id,
      });
      await toolkit.writeFile('src/utils/string.ts', 'export const upper = (s: string) => s.toUpperCase();\n', {
        sessionId: sess.id,
      });

      // globFiles
      const globs = toolkit.globFiles('src/utils/*.ts');
      assert.equal(globs.length, 2);

      // listDirectory
      const dirEntries = await toolkit.listDirectory('src/utils');
      assert.equal(dirEntries.length, 2);
      assert.ok(dirEntries.some((e) => e.name === 'math.ts'));

      // inspectFile
      const inspected = await toolkit.inspectFile('src/utils/math.ts');
      assert.equal(inspected.exists, true);
      assert.ok(inspected.sizeBytes > 0);
      assert.equal(inspected.linesCount, 2);
      assert.equal(inspected.extension, '.ts');
      assert.ok(inspected.sha256.length === 64);

      // gitBranches & gitValidateMerge (safe inside non-git or git worktree)
      const branches = toolkit.gitBranches();
      assert.ok(branches.current);
      const mergeValidation = toolkit.gitValidateMerge();
      assert.equal(mergeValidation.hasConflictMarkers, false);

      // runVerificationPipeline
      perms.setMode('trusted-automation');
      const beforeSnap = toolkit.snapshotWorkspaceFingerprints();
      await toolkit.writeFile('src/utils/math.ts', 'export const add = (a: number, b: number) => a + b + 0;\n', {
        sessionId: sess.id,
      });

      const verification = await toolkit.runVerificationPipeline({
        beforeSnapshot: beforeSnap,
        testCommand: 'node -e "process.exit(0)"',
        sessionId: sess.id,
      });
      assert.equal(verification.verified, true);
      assert.ok(verification.modifiedFiles.includes('src/utils/math.ts'));
      const testStep = verification.steps.find((s) => s.step === 'test');
      assert.equal(testStep?.status, 'passed');
      const lintStep = verification.steps.find((s) => s.step === 'lint');
      assert.equal(lintStep?.status, 'not_executed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('tests startup sequence and unified brain selector commands via CLI', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-brain-cli-'));
    try {
      const orch = new ShellGPTOrchestrator(tmpDir);

      // runStartupSequence
      const startup = await orch.runStartupSequence();
      assert.equal(startup.steps.length, 12);
      assert.equal(startup.steps[0].name, 'Resolve working directory');
      assert.equal(startup.steps[11].name, 'Accept real user input');

      // selectBrain: status
      const statusRes = await orch.selectBrain('status');
      assert.match(statusRes.output, /Brain Selector Status/);

      // selectBrain: fallback
      const fallbackRes = await orch.selectBrain('fallback', 'off');
      assert.match(fallbackRes.output, /Fallback Configuration/);

      // selectBrain: reset
      const resetRes = await orch.selectBrain('reset');
      assert.match(resetRes.output, /Reset brain selection/);

      await orch.mcp.disconnectAll();

      // CLI: shellgpt brain status
      const cliBrainStatus = await runCli(['brain', 'status'], { workspaceDir: tmpDir });
      assert.equal(cliBrainStatus.exitCode, 0);
      assert.match(cliBrainStatus.stdout, /Brain Selector Status/);

      // CLI: shellgpt session new & rename & search
      const cliSessNew = await runCli(['session', 'new', 'CLI Test Session'], { workspaceDir: tmpDir });
      assert.equal(cliSessNew.exitCode, 0);
      assert.match(cliSessNew.stdout, /Created session/);

      const cliSessList = await runCli(['session', 'list', '--json'], { workspaceDir: tmpDir });
      const sessList = JSON.parse(cliSessList.stdout);
      assert.ok(sessList.length >= 1);

      const cliRename = await runCli(['session', 'rename', sessList[0].id, 'Renamed Title'], {
        workspaceDir: tmpDir,
      });
      assert.equal(cliRename.exitCode, 0);

      const cliSearch = await runCli(['session', 'search', 'Renamed'], { workspaceDir: tmpDir });
      assert.equal(cliSearch.exitCode, 0);

      // CLI: shellgpt provider add wizard
      const cliProvAdd = await runCli(
        ['provider', 'add', 'test-api', 'http://127.0.0.1:9999/v1', 'openai', 'gpt-test'],
        { workspaceDir: tmpDir },
      );
      assert.equal(cliProvAdd.exitCode, 0);
      assert.match(cliProvAdd.stdout, /Added provider "test-api"/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
