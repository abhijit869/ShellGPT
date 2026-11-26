import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClaudeConfigCompatibilityEngine, parseMarkdown, resolveSettings } from '../../packages/claude-compat/src/index.ts';
import { ConfigManager } from '@shellgpt/config';
import { InstructionBridge } from '@shellgpt/agents';
import { runCli } from '../../apps/cli/src/index.ts';
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shellgpt-compat-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file: string, value: string | object) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value)); };
  return { root, home, write, engine: new ClaudeConfigCompatibilityEngine(root, home) };
}
test('scalar precedence and complete provenance keep security above session', () => {
  const result = resolveSettings([
    { path: 'security', scope: 'security', values: { model: 'locked' } },
    { path: 'project', scope: 'project', values: { model: 'shared' } },
    { path: 'user', scope: 'user', values: { model: 'personal' } },
    { path: 'session', scope: 'session', values: { model: 'temporary' } },
  ]);
  assert.equal(result.effective.model, 'locked');
  assert.deepEqual(result.provenance.model.map(s => s.source), ['user', 'project', 'session', 'security']);
});
test('native mode excludes Claude data; hybrid resolves local and native pins', t => {
  const f = fixture(t);
  f.write('home/.claude/settings.json', { model: 'global' });
  f.write('.claude/settings.json', { model: 'project' });
  f.write('.claude/settings.local.json', { model: 'local' });
  assert.equal(f.engine.resolve().effective.model, undefined);
  assert.equal(f.engine.resolve({ mode: 'hybrid' }).effective.model, 'local');
  f.write('.shellgpt/config.yaml', 'routing:\n  activeModel: native\n');
  assert.equal(f.engine.resolve({ mode: 'hybrid' }).effective.model, 'native');
});
test('unsupported security settings block activation and migration, without leaking values', t => {
  const f = fixture(t);
  f.write('.claude/settings.json', { model: 'configured', permissions: { deny: ['Read(.env)'] }, env: { TOKEN: 'must-not-appear' } });
  const resolved = f.engine.resolve({ mode: 'claude-compatible' });
  assert.deepEqual(resolved.diagnostics.map(d => d.field), ['permissions', 'env']);
  assert.throws(() => f.engine.activeModel('hybrid'), /cannot be activated/);
  const report = f.engine.import({ dryRun: true });
  assert.equal(report.operations[0].status, 'skipped');
  assert.ok(!JSON.stringify(report).includes('must-not-appear'));
  assert.equal(fs.existsSync(path.join(f.root, '.shellgpt')), false);
});
test('dry-run makes no writes; migration preserves sources and refuses collisions', t => {
  const f = fixture(t);
  f.write('.claude/settings.json', { model: 'configured-model' });
  f.write('.claude/skills/review/SKILL.md', '---\nname: review\ndescription: Review changes\n---\nReview actual diffs.\n');
  f.write('CLAUDE.md', 'Project instruction');
  const before = fs.readFileSync(path.join(f.root, '.claude/settings.json'), 'utf8');
  assert.equal(f.engine.import({ dryRun: true }).operations.filter(o => o.status === 'planned').length, 3);
  assert.equal(fs.existsSync(path.join(f.root, '.shellgpt')), false);
  const imported = f.engine.import();
  assert.ok(imported.reportPath && fs.existsSync(imported.reportPath));
  assert.equal(imported.operations.filter(o => o.status === 'imported').length, 3);
  assert.equal(fs.readFileSync(path.join(f.root, '.claude/settings.json'), 'utf8'), before);
  assert.equal(new ConfigManager(f.root).get().routing.activeModel, 'configured-model');
  assert.match(new InstructionBridge(f.root, '', 'native').resolvePolicy().canonicalText, /Project instruction/);
  assert.equal(f.engine.import().operations.filter(o => o.status === 'conflict').length, 3);
});
test('symlinks, malformed JSON and unsupported path rules are not activated', t => {
  const f = fixture(t);
  f.write('outside.md', 'private'); f.write('.claude/settings.json', '{broken');
  f.write('.claude/rules/scoped.md', '---\npaths: ["src/**"]\n---\nScoped only');
  fs.symlinkSync(path.join(f.root, 'outside.md'), path.join(f.root, 'CLAUDE.md'));
  const entries = f.engine.inventory();
  assert.equal(entries.find(e => e.kind === 'instructions')?.status, 'invalid');
  assert.equal(entries.find(e => e.kind === 'rules')?.status, 'unsupported');
  assert.throws(() => f.engine.activeModel('hybrid'));
  assert.doesNotMatch(new InstructionBridge(f.root, '', 'hybrid').resolvePolicy().canonicalText, /Scoped only|private/);
});
test('frontmatter supports CRLF and rejects duplicates, arrays and shell interpolation', t => {
  const f = fixture(t);
  assert.equal(parseMarkdown('---\r\nname: hi\r\n---\r\nbody').metadata.name, 'hi');
  assert.throws(() => parseMarkdown('---\na: 1\na: 2\n---\nbody'));
  assert.throws(() => parseMarkdown('---\n- a\n---\nbody'));
  f.write('.claude/skills/x/SKILL.md', '---\ndescription: test\n---\n!`touch marker`');
  assert.equal(f.engine.inventory()[0].status, 'unsupported');
});
test('account and transcript files are never inventoried or copied', t => {
  const f = fixture(t);
  f.write('home/.claude.json', '{broken');
  f.write('home/.claude/.credentials.json', '{broken');
  f.write('home/.claude/projects/private/history.jsonl', 'private');
  f.write('home/.claude/settings.json', { model: 'configured' });
  assert.equal(f.engine.inventory({ global: true, project: false }).length, 1);
});
test('CLI dry-run and config explain have no orchestrator side effects', async t => {
  const f = fixture(t); f.write('.claude/settings.json', { model: 'configured' });
  const preview = await runCli(['import', 'claude', '--dry-run'], { workspaceDir: f.root });
  assert.equal(preview.exitCode, 0);
  const explain = await runCli(['config', 'explain', 'model', '--compat', 'hybrid'], { workspaceDir: f.root });
  assert.equal(JSON.parse(explain.stdout).value, 'configured');
  assert.equal(fs.existsSync(path.join(f.root, '.shellgpt')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'skills')), false);
});
test('global settings import is consumed natively and source directories cannot be symlinks', t => {
  const f = fixture(t); f.write('home/.claude/settings.json', { model: 'global-import' });
  assert.equal(f.engine.import({ global: true }).operations[0].status, 'imported');
  assert.equal(f.engine.resolve({ mode: 'native' }).effective.model, 'global-import');
  fs.symlinkSync(path.join(f.home, '.claude'), path.join(f.root, '.claude'));
  assert.throws(() => f.engine.activeModel('hybrid'), /cannot be activated/);
});
