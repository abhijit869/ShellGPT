import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter, ModelCandidateSchema } from '../../packages/router/src/index.ts';
const candidate = (providerId: string, extra = {}) => ModelCandidateSchema.parse({ providerId, model: 'configured', enabled: true, healthy: true, authenticated: true, authorized: true, ...extra });
test('manual pin never silently switches model or provider', () => {
  const router = new ModelRouter();
  assert.equal(router.select([candidate('work'), candidate('personal')], { providerId: 'missing' }).selected, undefined);
  assert.equal(router.select([candidate('work')], { model: 'invented' }).selected, undefined);
});
test('routing excludes unhealthy, unauthorized, incapable and over-budget candidates', () => {
  const result = new ModelRouter().select([
    candidate('unhealthy', { healthy: false }), candidate('unapproved', { authorized: false }),
    candidate('expensive', { capabilities: ['tools'], costPerMillion: 9 }),
    candidate('unknown-cost', { capabilities: ['tools'] }), candidate('incapable', { costPerMillion: 1 }),
    candidate('winner', { capabilities: ['tools'], costPerMillion: 2 }),
  ], { requiredCapabilities: ['tools'], maxCostPerMillion: 3 });
  assert.equal(result.selected?.providerId, 'winner'); assert.equal(result.rejected.length, 5);
});
test('priority, cost, latency and failed-provider exclusions produce deterministic choices', () => {
  const router = new ModelRouter();
  const input = [candidate('a', { priority: 0, costPerMillion: 4, latencyMs: 20 }), candidate('b', { priority: 1, costPerMillion: 1, latencyMs: 100 })];
  assert.equal(router.select(input).selected?.providerId, 'a');
  assert.equal(router.select(input, { strategy: 'cost' }).selected?.providerId, 'b');
  assert.equal(router.select(input, { strategy: 'latency' }).selected?.providerId, 'a');
  assert.equal(router.select(input, { excludeProviders: ['a'] }).selected?.providerId, 'b');
  assert.equal(router.select(input, { contextTokens: 100 }).selected, undefined);
});
