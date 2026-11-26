import { z } from 'zod';
export const ModelCandidateSchema = z.object({
  providerId: z.string().min(1), model: z.string().min(1), enabled: z.boolean(),
  healthy: z.boolean(), authenticated: z.boolean(), authorized: z.boolean(),
  local: z.boolean().default(false), priority: z.number().default(100),
  capabilities: z.array(z.string()).default([]), contextTokens: z.number().positive().optional(),
  costPerMillion: z.number().nonnegative().optional(), latencyMs: z.number().nonnegative().optional(),
});
export type ModelCandidate = z.infer<typeof ModelCandidateSchema>;
export interface RoutingRequest {
  strategy?: 'priority' | 'cost' | 'latency'; providerId?: string; model?: string;
  requiredCapabilities?: string[]; contextTokens?: number; maxCostPerMillion?: number;
  excludeProviders?: string[]; local?: boolean;
}
/** Pure model selection; agent runtime selection remains owned by the orchestrator. */
export class ModelRouter {
  select(input: ModelCandidate[], request: RoutingRequest = {}): { selected?: ModelCandidate; rejected: Array<{ providerId: string; model: string; reason: string }> } {
    const rejected: Array<{ providerId: string; model: string; reason: string }> = [];
    const candidates = input.map(c => ModelCandidateSchema.parse(c)).filter(c => {
      const reason = !c.enabled ? 'disabled' : !c.authorized ? 'not authorized' : !c.authenticated ? 'not authenticated' : !c.healthy ? 'unhealthy'
        : request.excludeProviders?.includes(c.providerId) ? 'excluded after failure'
        : request.providerId && c.providerId !== request.providerId ? 'manual provider pin'
        : request.model && c.model !== request.model ? 'manual model pin'
        : request.local !== undefined && c.local !== request.local ? 'runtime class'
        : request.requiredCapabilities?.some(cap => !c.capabilities.includes(cap)) ? 'missing capability'
        : request.contextTokens !== undefined && (c.contextTokens === undefined || c.contextTokens < request.contextTokens) ? 'insufficient known context capacity'
        : request.maxCostPerMillion !== undefined && (c.costPerMillion === undefined || c.costPerMillion > request.maxCostPerMillion) ? 'unknown or excessive cost' : undefined;
      if (reason) rejected.push({ providerId: c.providerId, model: c.model, reason });
      return !reason;
    });
    const metric = (c: ModelCandidate) => request.strategy === 'cost' ? c.costPerMillion ?? Infinity : request.strategy === 'latency' ? c.latencyMs ?? Infinity : c.priority;
    candidates.sort((a, b) => (metric(a) - metric(b)) || (a.priority - b.priority) || a.providerId.localeCompare(b.providerId) || a.model.localeCompare(b.model));
    return { selected: candidates[0], rejected };
  }
}
