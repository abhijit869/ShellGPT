import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import YAML from 'yaml';
import { inventory, safeRead, type ConfigEntry, type EntryKind } from './files.ts';
import { resolveSettings, CompatibilityModeSchema, type CompatibilityMode, type SettingsSource, type Resolution } from './settings.ts';
export * from './settings.ts';
export * from './files.ts';

export class ClaudeConfigCompatibilityEngine {
  readonly workspaceDir: string;
  readonly homeDir: string;
  constructor(workspaceDir: string, homeDir = os.homedir()) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.homeDir = path.resolve(homeDir);
  }
  inventory(options: { project?: boolean; global?: boolean } = {}): ConfigEntry[] {
    return [
      ...(options.global ? inventory(path.join(this.homeDir, '.claude'), 'user', true) : []),
      ...(options.project !== false ? inventory(this.workspaceDir, 'project') : []),
    ];
  }
  resolve(options: { mode?: CompatibilityMode; session?: Record<string, unknown>; organization?: Record<string, unknown>; security?: Record<string, unknown>; nativeConfig?: Record<string, unknown> } = {}): Resolution & { mode: CompatibilityMode; sources: SettingsSource[]; entries: ConfigEntry[] } {
    const nativePath = path.join(this.workspaceDir, '.shellgpt/config.yaml');
    let native: Record<string, unknown> = options.nativeConfig ?? {};
    if (!options.nativeConfig && fs.existsSync(nativePath)) {
      try { native = YAML.parse(safeRead(this.workspaceDir, '.shellgpt/config.yaml')) ?? {}; }
      catch { throw new Error('Invalid or unsafe native config.yaml; contents omitted.'); }
    }
    const nativeSettings = native as { compatibility?: { mode?: unknown }; routing?: { activeModel?: unknown } };
    const mode = CompatibilityModeSchema.parse(options.mode ?? nativeSettings.compatibility?.mode ?? 'native');
    const entries = mode === 'claude-compatible' || mode === 'hybrid' ? this.inventory({ global: true }) : [];
    const sources: SettingsSource[] = entries.filter(e => e.kind === 'settings').map(e => ({ path: e.source, scope: e.scope, values: e.data ?? {} }));
    const globalImported = '.shellgpt/claude-import/settings.json';
    if (fs.existsSync(path.join(this.homeDir, globalImported))) sources.unshift({ path: path.join(this.homeDir, globalImported), scope: 'user', values: JSON.parse(safeRead(this.homeDir, globalImported)) });
    const imported = '.shellgpt/claude-import/settings.json';
    if (fs.existsSync(path.join(this.workspaceDir, imported))) sources.push({ path: path.join(this.workspaceDir, imported), scope: 'project', values: JSON.parse(safeRead(this.workspaceDir, imported)) });
    if (typeof nativeSettings.routing?.activeModel === 'string') sources.push({ path: nativePath, scope: 'local', values: { model: nativeSettings.routing!.activeModel } });
    for (const scope of ['session', 'organization', 'security'] as const) if (options[scope]) sources.push({ path: `<${scope}>`, scope, values: options[scope]! });
    const result = resolveSettings(sources);
    result.diagnostics.push(...entries.flatMap(e => e.diagnostics));
    return { ...result, mode, sources, entries };
  }
  /** Never activates partially supported settings: ignoring a deny rule would widen authority. */
  activeModel(mode: CompatibilityMode, nativeConfig?: Record<string, unknown>): string | undefined {
    const result = this.resolve({ mode, nativeConfig });
    const blocked = result.entries.some(e => e.kind === 'settings' && e.status !== 'compatible');
    if (blocked || result.diagnostics.some(d => d.severity === 'error')) throw new Error('Claude settings cannot be activated: run shellgpt config validate --compat ' + mode + ' to inspect unsupported or invalid fields.');
    return typeof result.effective.model === 'string' ? result.effective.model : undefined;
  }
  import(options: { dryRun?: boolean; global?: boolean; project?: boolean; kinds?: EntryKind[] } = {}) {
    const entries = this.inventory({ global: options.global, project: options.project ?? !options.global });
    const selected = entries.filter(e => !options.kinds?.length || options.kinds.includes(e.kind));
    const destinationRoot = options.global ? path.join(this.homeDir, '.shellgpt') : path.join(this.workspaceDir, '.shellgpt');
    const operations: Array<{ source: string; destination?: string; status: string; reason?: string }> = [];
    const writes: Array<{ relative: string; content: string; operation: number }> = [];
    const settings = selected.filter(e => e.kind === 'settings');
    for (const entry of selected) {
      const operation = { source: entry.source, status: 'skipped', reason: undefined as string | undefined, destination: undefined as string | undefined };
      operations.push(operation);
      if (entry.status !== 'compatible') { operation.reason = 'Unsupported or invalid entry; see diagnostics.'; continue; }
      let relative: string | undefined;
      let content = entry.text;
      if (entry.kind === 'settings') {
        if (settings.some(e => e.status !== 'compatible')) { operation.reason = 'Settings import is blocked until all selected settings are supported and valid.'; continue; }
        if (entry !== settings.at(-1)) { operation.reason = 'Merged into highest-precedence settings entry.'; continue; }
        relative = 'claude-import/settings.json';
        content = JSON.stringify(resolveSettings(settings.map(e => ({ path: e.source, scope: e.scope, values: e.data ?? {} }))).effective, null, 2) + '\n';
      } else if (entry.kind === 'skills') relative = path.join('skills', path.basename(path.dirname(entry.source)), 'SKILL.md');
      else if (entry.kind === 'instructions' || entry.kind === 'rules') relative = path.join('rules', 'claude-' + crypto.createHash('sha256').update(entry.relativePath).digest('hex').slice(0, 12) + '.md');
      if (!relative || content === undefined) { operation.reason = 'No supported native consumer.'; continue; }
      operation.destination = path.join(destinationRoot, relative);
      if (fs.existsSync(operation.destination)) { operation.status = 'conflict'; operation.reason = 'Existing destination preserved; automatic overwrite is forbidden.'; continue; }
      operation.status = 'planned';
      writes.push({ relative, content, operation: operations.length - 1 });
    }
    const report = { schemaVersion: 1, dryRun: Boolean(options.dryRun), operations, diagnostics: selected.flatMap(e => e.diagnostics), reportPath: undefined as string | undefined };
    if (!options.dryRun) {
      // Re-check every ancestor and use exclusive file creation; never follow an existing link.
      const write = (relative: string, content: string) => {
        const target = path.resolve(destinationRoot, relative);
        if (!target.startsWith(destinationRoot + path.sep)) throw new Error('Unsafe import destination.');
        const parts = target.split(path.sep);
        let current = path.parse(target).root;
        for (const part of parts.slice(1, -1)) {
          current = path.join(current, part);
          if (fs.existsSync(current)) {
            if (fs.lstatSync(current).isSymbolicLink() || !fs.statSync(current).isDirectory()) throw new Error('Unsafe import destination ancestor.');
          } else fs.mkdirSync(current, { mode: 0o700 });
        }
        fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
      };
      for (const pending of writes) {
        try { write(pending.relative, pending.content); operations[pending.operation].status = 'imported'; }
        catch { operations[pending.operation].status = 'conflict'; operations[pending.operation].reason = 'Destination changed, is unsafe or is not writable; preserved.'; }
      }
      const reportName = path.join('imports', `claude-${crypto.randomUUID()}.json`);
      report.reportPath = path.join(destinationRoot, reportName);
      write(reportName, JSON.stringify(report, null, 2) + '\n');
    }
    return report;
  }
}
