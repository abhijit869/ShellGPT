import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { validateSettings, type Diagnostic, type Scope } from './settings.ts';

export type EntryKind = 'settings' | 'instructions' | 'rules' | 'skills' | 'agents' | 'commands' | 'mcp' | 'plugins' | 'workflows' | 'memory' | 'styles' | 'keybindings' | 'worktree';
export interface ConfigEntry {
  source: string; relativePath: string; scope: Scope; kind: EntryKind;
  status: 'compatible' | 'unsupported' | 'invalid'; diagnostics: Diagnostic[];
  data?: Record<string, unknown>; text?: string;
}
const MAX_BYTES = 256 * 1024;
export function safeRead(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path outside configuration scope.');
  let current = path.resolve(root);
  if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic link configuration roots are not followed.');
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are not followed.');
  }
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Configuration must be a regular file no larger than 256 KiB.');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
export function parseMarkdown(text: string): { metadata: Record<string, unknown>; body: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { metadata: {}, body: normalized };
  const end = normalized.indexOf('\n---', 4);
  if (end < 0 || !/^\n---(?:\n|$)/.test(normalized.slice(end))) throw new Error('Unterminated YAML frontmatter.');
  const doc = YAML.parseDocument(normalized.slice(4, end), { uniqueKeys: true });
  if (doc.errors.length) throw new Error('Invalid YAML frontmatter.');
  const metadata = z.record(z.string(), z.unknown()).parse(doc.toJS({ maxAliasCount: 20 }) ?? {});
  if (Object.keys(metadata).some(k => ['__proto__', 'prototype', 'constructor'].includes(k))) throw new Error('Unsafe frontmatter key.');
  return { metadata, body: normalized.slice(end + 4).replace(/^\n/, '') };
}
export function inventory(root: string, scope: Scope, global = false): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  const add = (relativePath: string, kind: EntryKind) => {
    if (entries.length >= 2000) throw new Error('Configuration inventory exceeded 2000 entries.');
    const source = path.join(root, relativePath);
    const entry: ConfigEntry = { source, relativePath, scope, kind, status: 'compatible', diagnostics: [] };
    entries.push(entry);
    try {
      // Memory/workflows are inventoried by path only, never read or executed.
      if (['memory', 'workflows', 'worktree', 'keybindings'].includes(kind)) {
        entry.status = 'unsupported';
        entry.diagnostics.push({ source, severity: 'unsupported', message: 'Inventory only; no automatic read, migration or execution.' });
        return;
      }
      const text = safeRead(root, relativePath);
      if (kind === 'settings') {
        const parsed = validateSettings(JSON.parse(text), source);
        entry.data = parsed.values;
        entry.diagnostics.push(...parsed.diagnostics);
      } else if (kind === 'mcp' || kind === 'plugins') {
        z.record(z.string(), z.unknown()).parse(JSON.parse(text));
        entry.status = 'unsupported';
        entry.diagnostics.push({ source, severity: 'unsupported', message: 'JSON syntax validated; runtime schema translation and activation require a later milestone.' });
      } else {
        const { metadata, body } = parseMarkdown(text);
        const allowed = kind === 'skills' ? ['name', 'description'] : [];
        for (const key of Object.keys(metadata)) {
          if (!allowed.includes(key)) entry.diagnostics.push({ source, field: key, severity: 'unsupported', message: 'Frontmatter semantics are not implemented; this entry will not be activated.' });
        }
        if (kind === 'skills') {
          z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(), description: z.string().min(1) }).parse(metadata);
        }
        if (['agents', 'commands', 'styles'].includes(kind)) entry.diagnostics.push({ source, severity: 'unsupported', message: 'Validated Markdown/frontmatter; execution semantics are not implemented.' });
        if (/!`|!\$\(/.test(body)) entry.diagnostics.push({ source, severity: 'unsupported', message: 'Shell interpolation is not supported or executed.' });
        entry.data = metadata;
        entry.text = text;
      }
      if (entry.diagnostics.length) entry.status = entry.diagnostics.some(d => d.severity === 'error') ? 'invalid' : 'unsupported';
    } catch {
      entry.status = 'invalid';
      entry.diagnostics.push({ source, severity: 'error', message: 'Unreadable, unsafe, oversized or invalid configuration. File contents are omitted from diagnostics.' });
    }
  };
  const single = (rel: string, kind: EntryKind) => { if (fs.existsSync(path.join(root, rel))) add(rel, kind); };
  const prefix = global ? '' : '.claude/';
  const configRoot = path.join(root, prefix || '.');
  if (fs.existsSync(configRoot) && fs.lstatSync(configRoot).isSymbolicLink()) {
    return [{ source: configRoot, relativePath: prefix, scope, kind: 'settings', status: 'invalid', diagnostics: [{ source: configRoot, severity: 'error', message: 'Symbolic link configuration roots are not followed.' }] }];
  }
  single(prefix + 'settings.json', 'settings');
  if (!global) single(prefix + 'settings.local.json', 'settings');
  single('CLAUDE.md', 'instructions');
  if (!global) { single('CLAUDE.local.md', 'instructions'); single('.mcp.json', 'mcp'); single('.worktreeinclude', 'worktree'); }
  else single('keybindings.json', 'keybindings');
  for (const [dir, kind] of Object.entries({ rules: 'rules', skills: 'skills', agents: 'agents', commands: 'commands', workflows: 'workflows', 'agent-memory': 'memory', 'output-styles': 'styles' }) as Array<[string, EntryKind]>) {
    const walk = (rel: string, depth: number) => {
      const full = path.join(root, rel);
      if (!fs.existsSync(full)) return;
      if (depth > 16 || entries.length >= 2000 || fs.lstatSync(full).isSymbolicLink()) {
        entries.push({ source: full, relativePath: rel, scope, kind, status: 'invalid', diagnostics: [{ source: full, severity: 'error', message: 'Unsafe directory or inventory limit reached.' }] }); return;
      }
      for (const item of fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const child = path.join(rel, item.name);
        if (item.isDirectory()) walk(child, depth + 1);
        else if (kind !== 'skills' || item.name === 'SKILL.md') add(child, kind);
      }
    };
    // Check the containing .claude directory too, before enumeration.
    if (fs.existsSync(path.join(root, prefix || '.')) && !fs.lstatSync(path.join(root, prefix || '.')).isSymbolicLink()) walk(prefix + dir, 0);
  }
  single('.claude-plugin/plugin.json', 'plugins');
  single('.claude-plugin/marketplace.json', 'plugins');
  for (const entry of entries) if (entry.relativePath === '.claude/settings.local.json') entry.scope = 'local';
  return entries;
}
