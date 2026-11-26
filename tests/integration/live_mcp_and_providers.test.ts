import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { McpManager } from '@shellgpt/mcp';
import { ReaIntegration } from '@shellgpt/rea';
import { PermissionEngine } from '@shellgpt/permissions';
import { MemoryManager } from '@shellgpt/memory';
import { CodingToolkit } from '@shellgpt/tools';
import { ShellGPTOrchestrator } from '@shellgpt/core';

describe('Phase 4, 5 & 6 Integration: Live REA MCP Server, Provider Gateway HTTP/SSE, and Coding Tools', () => {
  it('connects to live installed REA MCP server, discovers 263 real tools, and executes authorized analysis', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-rea-int-'));
    const perms = new PermissionEngine(tmpDir, 'workspace-write');
    const mcp = new McpManager(tmpDir, perms);
    const rea = new ReaIntegration(tmpDir, mcp);

    try {
      const binInfo = rea.detectBinary();
      assert.equal(binInfo.installed, true);
      assert.equal(binInfo.version, '6.10.1');

      const tools = await rea.discoverLiveReaTools();
      assert.equal(tools.length, 263);

      // Unauthorized target outside workspace must be blocked
      await assert.rejects(async () => {
        await rea.analyzeTarget({
          targetPath: '/etc/passwd',
          explicitAuthorization: false,
        });
      }, /outside authorized boundaries/);

      // Authorized analysis succeeds and captures structured evidence
      const evidence = await rea.analyzeTarget({
        workflow: 'session-overview',
        explicitAuthorization: true,
      });
      assert.equal(evidence.authorizedByUser, true);
      assert.equal(evidence.toolUsed, 'binary_session');

      const report = rea.generateReport([evidence]);
      assert.match(report, /REA Reverse-Engineering Analysis Report/);
    } finally {
      await mcp.disconnectAll();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('executes MODE A against a deterministic local JSON HTTP fixture', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-modea-int-'));

    // Spin up a real local OpenAI-compatible HTTP endpoint representing Asemprotic / Custom API
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/models' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'asemprotic-architect-v1' }] }));
        return;
      }
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const parsed = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl_live_1',
              model: parsed.model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content:
                      'Verified architecture response from Asemprotic Custom API controller.',
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 42,
                completion_tokens: 12,
                total_tokens: 54,
              },
            }),
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}/v1`;

    const prevEnv = {
      ASEMPROTIC_API_KEY: process.env.ASEMPROTIC_API_KEY,
      ASEMPROTIC_BASE_URL: process.env.ASEMPROTIC_BASE_URL,
      ASEMPROTIC_MODEL: process.env.ASEMPROTIC_MODEL,
      ASEMPROTIC_API_FORMAT: process.env.ASEMPROTIC_API_FORMAT,
    };

    try {
      process.env.ASEMPROTIC_API_KEY = 'asem_live_test_key_12345';
      process.env.ASEMPROTIC_BASE_URL = baseUrl;
      process.env.ASEMPROTIC_MODEL = 'asemprotic-architect-v1';
      process.env.ASEMPROTIC_API_FORMAT = 'openai';

      const orch = new ShellGPTOrchestrator(tmpDir);
      orch.configManager.get().routing.activeProviderId = 'asemprotic';
      orch.providers.getProvider('asemprotic')!.profile.streaming = false;
      const route = await orch.resolveRoute();

      assert.equal(route.mode, 'MODE_A_CUSTOM_API');
      assert.equal(route.primaryBrain, 'custom-api:asemprotic');
      assert.equal(route.activeModel, 'asemprotic-architect-v1');

      const turn = await orch.processUserRequest({
        prompt: 'Verify the custom API controller workflow.',
      });

      assert.equal(turn.verified, true);
      assert.match(
        turn.responseText,
        /Verified architecture response from Asemprotic Custom API controller/,
      );
      assert.equal(turn.lifecycleLog.length, 17);
      await orch.mcp.disconnectAll();
    } finally {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('performs real file read/write/edit/patch, symbol search, and checkpoint rollback via CodingToolkit', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-tools-int-'));
    try {
      const perms = new PermissionEngine(tmpDir, 'workspace-write');
      const mem = new MemoryManager(tmpDir);
      const sess = mem.createSession({ title: 'Toolkit Test' });
      const toolkit = new CodingToolkit(tmpDir, perms, mem);

      await toolkit.writeFile(
        'src/math.ts',
        `export function calculateSum(a: number, b: number): number {\n  return a + b;\n}\n`,
        { sessionId: sess.id },
      );

      const readRes = await toolkit.readFile('src/math.ts');
      assert.equal(readRes.totalLines, 4);

      const editRes = await toolkit.editFile(
        'src/math.ts',
        'return a + b;',
        'return a + b + 0;',
        { sessionId: sess.id },
      );
      assert.equal(editRes.replacements, 1);
      assert.ok(editRes.checkpointId);

      const symbols = toolkit.findSymbols('calculateSum');
      assert.equal(symbols.length, 1);
      assert.equal(symbols[0].name, 'calculateSum');

      // Rollback via checkpoint
      mem.restoreCheckpoint(editRes.checkpointId!);
      const rolledBack = await toolkit.readFile('src/math.ts');
      assert.match(rolledBack.content, /return a \+ b;/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
