import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { ClaudeConfigCompatibilityEngine } from '../../packages/claude-compat/src/index.ts';
import { ProviderProfileSchema } from '@shellgpt/config';
import { ProviderGateway } from '@shellgpt/providers';

test('Claude import → custom profile routing → incremental SSE and structured tools (local fixture)', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-gateway-v3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude/settings.json'), JSON.stringify({ model: 'fixture-model' }));
  const engine = new ClaudeConfigCompatibilityEngine(root, root);
  assert.equal(engine.import().operations[0].status, 'imported');
  const model = engine.activeModel('migration');
  let unhealthy = false, truncated = false, sawChunkBeforeEnd = false, ended = false;
  const seenBodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(unhealthy ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seenBodies.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const event = (delta: object, finish_reason: string | null = null) => res.write('data: ' + JSON.stringify({ id: 'fixture-response', choices: [{ index: 0, delta, finish_reason }] }) + '\r\n\r\n');
      event({ content: 'Hello ' });
      if (truncated) { res.end(); return; }
      const timer = setTimeout(() => {
        event({ content: 'world' });
        event({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } }] });
        event({ tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] });
        event({}, 'tool_calls');
        res.end('data: [DONE]\n\n'); ended = true;
      }, 40);
      res.on('close', () => clearTimeout(timer));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const previous = process.env.SHELLGPT_FIXTURE_KEY; process.env.SHELLGPT_FIXTURE_KEY = 'local-fixture-key';
  t.after(() => { if (previous === undefined) delete process.env.SHELLGPT_FIXTURE_KEY; else process.env.SHELLGPT_FIXTURE_KEY = previous; });
  const profile = ProviderProfileSchema.parse({ id: 'work-custom', name: 'Local test fixture', type: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'SHELLGPT_FIXTURE_KEY', defaultModel: model, billable: true, capabilities: ['tools'] });
  const gateway = new ProviderGateway({ 'work-custom': profile });
  assert.equal(await gateway.routeModel(['work-custom']), undefined, 'credentials alone do not authorize paid fallback');
  const selected = await gateway.routeModel(['work-custom'], { providerId: 'work-custom', model, requiredCapabilities: ['tools'] });
  assert.ok(selected);
  const deltas: string[] = [];
  const result = await selected.provider.stream({ model, messages: [{ role: 'user', content: 'fixture request' }], tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }] }, delta => {
    if (delta.text) { deltas.push(delta.text); if (!ended) sawChunkBeforeEnd = true; }
  });
  assert.equal(sawChunkBeforeEnd, true);
  assert.deepEqual(deltas, ['Hello ', 'world']); assert.equal(result.text, 'Hello world');
  assert.deepEqual(result.toolCalls[0].arguments, { path: 'README.md' });
  assert.equal(result.usage.measurementType, 'unavailable');
  assert.equal(seenBodies[0].stream, true);
  truncated = true;
  await assert.rejects(() => selected.provider.stream({ model, messages: [] }, () => {}), /partial output is not a successful result/);
  truncated = false;
  const controller = new AbortController();
  await assert.rejects(() => selected.provider.stream({ model, messages: [], signal: controller.signal }, () => controller.abort()), /abort/i);
  unhealthy = true;
  assert.equal((await selected.provider.healthCheck()).healthy, false);
  assert.equal(await selected.provider.validateModel('fixture-model'), false);
  assert.equal(await gateway.routeModel([], { providerId: 'work-custom' }), undefined);
});
