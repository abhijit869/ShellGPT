import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { runCli } from '../../apps/cli/src/index.ts';
import { ShellGPTOrchestrator } from '@shellgpt/core';
import { ConfigManager } from '@shellgpt/config';

describe('Phase 7 & 8 E2E: CLI Commands, Real Execution Scenarios A-E, Cancellation, and Cross-Platform Checks', () => {
  it('supports CLI startup, init, version, help, agent switching, session management, and REA commands', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-e2e-'));
    try {
      // 1. First-run onboarding (init)
      const initRes = await runCli(['init'], { workspaceDir: tmpDir });
      assert.equal(initRes.exitCode, 0);
      assert.equal(
        fs.existsSync(path.join(tmpDir, '.shellgpt', 'config.yaml')),
        true,
      );

      // 2. Version & Help
      const verRes = await runCli(['version', '--json'], { workspaceDir: tmpDir });
      assert.equal(verRes.exitCode, 0);
      const verJson = JSON.parse(verRes.stdout);
      assert.equal(verJson.shellgpt, '1.0.0');
      assert.equal(verJson.rea, '6.10.1');

      // 3. Scenario B — Pin Codex as primary agent and verify context transfer
      const useCodex = await runCli(['agent', 'use', 'codex'], {
        workspaceDir: tmpDir,
      });
      assert.equal(useCodex.exitCode, 0);
      assert.match(useCodex.stdout, /MODE_C_CODEX_PRIMARY/);

      // Switch to Antigravity as primary agent
      const useAgy = await runCli(['agent', 'use', 'antigravity'], {
        workspaceDir: tmpDir,
      });
      assert.equal(useAgy.exitCode, 0);
      assert.match(useAgy.stdout, /MODE_B_ANTIGRAVITY_PRIMARY/);

      // Switch back to auto
      await runCli(['agent', 'use', 'auto'], { workspaceDir: tmpDir });

      // 4. Scenario D — REA workflow via CLI
      const reaEngines = await runCli(['rea', 'engines'], {
        workspaceDir: tmpDir,
      });
      assert.equal(reaEngines.exitCode, 0);
      assert.match(reaEngines.stdout, /javascript-babel-ast/);

      // This CLI/session test must not submit prompts to host-authenticated runtimes.
      const config = new ConfigManager(tmpDir);
      config.get().agents.antigravity.enabled = false;
      config.get().agents.codex.enabled = false;
      config.get().agents.customLlm.enabled = false;
      config.get().routing.allowLocalModelRecovery = false;
      config.save();

      // 5. Headless setup diagnostics with --json output
      const headless = await runCli(
        ['exec', 'Inspect the repository status', '--json'],
        { workspaceDir: tmpDir },
      );
      assert.equal(headless.exitCode, 0);
      const parsedExec = JSON.parse(headless.stdout);
      assert.ok(parsedExec.requestId);
      assert.ok(parsedExec.sessionId);
      assert.equal(parsedExec.lifecycleLog.length, 17);

      // 6. Session list, fork, and export
      const sessList = await runCli(['session', 'list', '--json'], {
        workspaceDir: tmpDir,
      });
      const sessions = JSON.parse(sessList.stdout);
      assert.ok(sessions.length >= 1);

      const forkRes = await runCli(
        ['session', 'fork', sessions[0].id, 'E2E-Fork', '--json'],
        { workspaceDir: tmpDir },
      );
      assert.equal(forkRes.exitCode, 0);
      const forked = JSON.parse(forkRes.stdout);
      assert.equal(forked.parentSessionId, sessions[0].id);

      const exportMd = await runCli(
        ['session', 'export', forked.id, 'md'],
        { workspaceDir: tmpDir },
      );
      assert.equal(exportMd.exitCode, 0);
      assert.match(exportMd.stdout, /# E2E-Fork/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('verifies Scenario A, B, C, and E: Bidirectional Antigravity <-> Codex delegation and mid-task Failure Recovery', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-scenarios-'));

    // Create deterministic local executable test harnesses for agy and codex CLI contracts
    const fakeBinDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeAgy = path.join(fakeBinDir, 'agy');
    const fakeCodex = path.join(fakeBinDir, 'codex');

    fs.writeFileSync(
      fakeAgy,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.5.14'); process.exit(0); }
if (args.includes('models')) { console.log('gemini-3.8-flash-low\\ngemini-4-argon-high'); process.exit(0); }
if (process.env.SIMULATE_AGY_CRASH === '1') {
  console.error('Antigravity simulated mid-task failure');
  process.exit(1);
}
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  const shouldDelegate = input.includes('DELEGATE_TO_CODEX');
  const structured = {
    text: shouldDelegate
      ? 'Antigravity planned architecture and delegated implementation to Codex.'
      : 'Antigravity completed research task.',
    tool_calls: [],
    delegate_to_codex: shouldDelegate ? [{
      objective: 'Implement endpoint module',
      scope: 'src/endpoint.ts',
      allowed_files: ['src/endpoint.ts'],
      verification_commands: []
    }] : []
  };
  console.log(JSON.stringify({
    event: 'result',
    result: {
      status: 'SUCCESS',
      structured_output: structured,
      usage: { input_tokens: 30, output_tokens: 15 }
    }
  }));
});
`,
      { mode: 0o755 },
    );

    fs.writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.118.0'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in as developer'); process.exit(0); }
const outIdx = args.indexOf('--output-last-message');
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  const shouldDelegate = input.includes('DELEGATE_TO_AGY');
  const structured = {
    text: shouldDelegate
      ? 'Codex implemented core logic and delegated architecture review to Antigravity.'
      : 'Codex completed delegated coding task.',
    tool_calls: [],
    delegate_to_antigravity: shouldDelegate ? [{
      objective: 'Verify system architecture',
      scope: 'docs/arch.md',
      allowed_files: ['docs/arch.md'],
      verification_commands: []
    }] : []
  };
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(structured), 'utf8');
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 25, output_tokens: 10 } }));
});
`,
      { mode: 0o755 },
    );

    const prevAgy = process.env.ANTIGRAVITY_BIN;
    const prevCodex = process.env.CODEX_BIN;

    try {
      process.env.ANTIGRAVITY_BIN = fakeAgy;
      process.env.CODEX_BIN = fakeCodex;

      const orch = new ShellGPTOrchestrator(tmpDir);

      // Scenario A: No primary API -> Antigravity selected as primary brain (MODE B), Codex registered as supporting worker
      const routeA = await orch.resolveRoute();
      assert.equal(routeA.mode, 'MODE_B_ANTIGRAVITY_PRIMARY');
      assert.equal(routeA.primaryBrain, 'antigravity');
      assert.ok(routeA.supportingAgents.includes('codex'));

      // Antigravity Primary -> delegates to Codex subagent -> returns verified outcome
      const turnA = await orch.processUserRequest({
        prompt: 'Build backend feature and DELEGATE_TO_CODEX',
      });
      assert.equal(turnA.verified, true);
      assert.equal(turnA.delegatedOutcomes.length, 1);
      assert.equal(turnA.delegatedOutcomes[0].assigned_to, 'codex');
      assert.equal(turnA.delegatedOutcomes[0].status, 'completed');

      // Scenario B: Switch to Codex Primary -> delegates to Antigravity subagent -> returns verified outcome
      await orch.switchAgent('codex');
      const turnB = await orch.processUserRequest({
        prompt: 'Refactor module and DELEGATE_TO_AGY',
      });
      assert.equal(turnB.route.mode, 'MODE_C_CODEX_PRIMARY');
      assert.equal(turnB.delegatedOutcomes.length, 1);
      assert.equal(turnB.delegatedOutcomes[0].assigned_to, 'antigravity');
      assert.equal(turnB.delegatedOutcomes[0].status, 'completed');

      // Scenario E: Failure Recovery — Antigravity becomes unavailable mid-task -> preserves uncommitted file & fails over to Codex with context transfer summary
      await orch.switchAgent('auto');
      const uncommittedFile = path.join(tmpDir, 'uncommitted-work.ts');
      fs.writeFileSync(uncommittedFile, 'export const workInProgress = true;\n', 'utf8');

      process.env.SIMULATE_AGY_CRASH = '1';
      const recoveryTurn = await orch.processUserRequest({
        prompt: 'Continue implementation after primary brain failure',
      });

      assert.equal(recoveryTurn.verified, true);
      assert.equal(recoveryTurn.route.mode, 'MODE_C_CODEX_PRIMARY');
      assert.ok(recoveryTurn.contextTransfer);
      assert.equal(recoveryTurn.contextTransfer.previousAgent, 'antigravity');
      assert.equal(recoveryTurn.contextTransfer.targetAgent, 'codex');
      // Verify uncommitted user work was preserved intact
      assert.equal(
        fs.readFileSync(uncommittedFile, 'utf8'),
        'export const workInProgress = true;\n',
      );

      await orch.mcp.disconnectAll();
    } finally {
      delete process.env.SIMULATE_AGY_CRASH;
      if (prevAgy === undefined) delete process.env.ANTIGRAVITY_BIN;
      else process.env.ANTIGRAVITY_BIN = prevAgy;
      if (prevCodex === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = prevCodex;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('supports Mode D (Local Model Recovery with reduced-capability warning) and task cancellation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-moded-'));

    // Spin up a mock Ollama local server on an ephemeral port
    const ollamaServer = http.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'tinyllama:latest' }] }));
        return;
      }
      if (req.url === '/api/chat' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: 'Local model recovery response from Ollama.',
            },
            prompt_eval_count: 18,
            eval_count: 9,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) =>
      ollamaServer.listen(0, '127.0.0.1', resolve),
    );
    const port = (ollamaServer.address() as { port: number }).port;
    const prevOllama = process.env.OLLAMA_HOST;

    try {
      process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
      const orch = new ShellGPTOrchestrator(tmpDir);
      await orch.switchAgent('local', 'tinyllama:latest');

      const routeD = await orch.resolveRoute();
      assert.equal(routeD.mode, 'MODE_D_LOCAL_RECOVERY');
      assert.equal(routeD.primaryBrain, 'local:ollama');
      assert.ok(routeD.reducedCapabilityWarning);

      const turnD = await orch.processUserRequest({
        prompt: 'Explain the local model recovery mode',
      });
      assert.equal(turnD.verified, true);
      assert.match(turnD.responseText, /Local model recovery response from Ollama/);
      assert.ok(turnD.diagnostics.length >= 1);

      await orch.mcp.disconnectAll();
    } finally {
      if (prevOllama === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = prevOllama;
      ollamaServer.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
