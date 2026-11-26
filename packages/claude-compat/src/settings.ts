import { z } from 'zod';

export const CompatibilityModeSchema = z.enum(['native', 'claude-compatible', 'hybrid', 'migration']);
export type CompatibilityMode = z.infer<typeof CompatibilityModeSchema>;
export type Scope = 'defaults' | 'user' | 'project' | 'local' | 'session' | 'organization' | 'security';
export interface Diagnostic { source: string; field?: string; severity: 'error' | 'unsupported'; message: string }
export interface SettingsSource { path: string; scope: Scope; values: Record<string, unknown> }
export interface Resolution {
  effective: Record<string, unknown>;
  provenance: Record<string, Array<{ source: string; scope: Scope; value: unknown }>>;
  diagnostics: Diagnostic[];
}
const scopes: Scope[] = ['defaults', 'user', 'project', 'local', 'session', 'organization', 'security'];
// Only fields with a real consumer may become effective settings. In particular, do not
// weaken permissions by parsing allow/deny syntax without an enforcement implementation.
const supported = z.object({ model: z.string().min(1).max(256).optional() });
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
export function validateSettings(value: unknown, source: string): { values: Record<string, unknown>; diagnostics: Diagnostic[] } {
  const object = z.record(z.string(), z.unknown()).safeParse(value);
  if (!object.success) return { values: {}, diagnostics: [{ source, severity: 'error', message: 'Settings must be a JSON object.' }] };
  const diagnostics: Diagnostic[] = [];
  for (const field of Object.keys(object.data)) {
    if (unsafe.has(field)) diagnostics.push({ source, field, severity: 'error', message: 'Unsafe object key.' });
    else if (field !== 'model' && field !== '$schema') diagnostics.push({ source, field, severity: 'unsupported', message: 'Not applied or imported by this compatibility version.' });
  }
  const result = supported.safeParse(object.data);
  if (!result.success) {
    for (const issue of result.error.issues) diagnostics.push({ source, field: issue.path.join('.'), severity: 'error', message: 'Invalid compatible setting type or value.' });
  }
  return { values: result.success ? result.data : {}, diagnostics };
}
export function resolveSettings(sources: SettingsSource[]): Resolution {
  const result: Resolution = { effective: {}, provenance: {}, diagnostics: [] };
  for (const source of [...sources].sort((a, b) => scopes.indexOf(a.scope) - scopes.indexOf(b.scope))) {
    const parsed = validateSettings(source.values, source.path);
    result.diagnostics.push(...parsed.diagnostics);
    for (const [key, value] of Object.entries(parsed.values)) {
      result.effective[key] = value;
      (result.provenance[key] ||= []).push({ source: source.path, scope: source.scope, value });
    }
  }
  return result;
}
