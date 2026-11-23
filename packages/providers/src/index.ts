import * as crypto from 'node:crypto';
import {
  type ProviderProfile,
  type ApiFormat,
  resolveAsemproticConfig,
  type SecretStore,
} from '@shellgpt/config';
import { estimateTokens } from '@shellgpt/memory';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCallRequest[];
}

export interface GenerateRequest {
  requestId?: string;
  model?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  signal?: AbortSignal;
}

export interface GenerateResponse {
  id: string;
  providerId: string;
  model: string;
  text: string;
  toolCalls: ToolCallRequest[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  usage: {
    inputTokens: number | 'unavailable';
    outputTokens: number | 'unavailable';
    totalTokens: number | 'unavailable';
    measurementType: 'measured' | 'estimated' | 'unavailable';
    estimatedCostUsd: number | 'unavailable';
  };
  reducedCapabilityWarning?: string;
}

export interface ProviderHealthStatus {
  providerId: string;
  healthy: boolean;
  authenticated: boolean;
  availableModels: string[];
  supportsTools: boolean;
  supportsStreaming: boolean;
  latencyMs?: number;
  diagnostic: string;
  lastError?: string;
}

export interface ModelProvider {
  readonly id: string;
  readonly profile: ProviderProfile;
  initialize(): Promise<void>;
  authenticate(): Promise<{ authenticated: boolean; detail: string }>;
  listModels(): Promise<string[]>;
  validateModel(model: string): Promise<boolean>;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
  stream(
    request: GenerateRequest,
    onChunk: (delta: { text?: string; toolCall?: ToolCallRequest }) => void,
  ): Promise<GenerateResponse>;
  executeToolCalls(
    toolCalls: ToolCallRequest[],
    executor: (call: ToolCallRequest) => Promise<string>,
  ): Promise<Array<{ toolCallId: string; name: string; output: string }>>;
  cancel(requestId: string): void;
  estimateUsage(
    request: GenerateRequest,
    responseText: string,
  ): GenerateResponse['usage'];
  healthCheck(): Promise<ProviderHealthStatus>;
}

export class UniversalHttpProvider implements ModelProvider {
  public readonly id: string;
  public readonly profile: ProviderProfile;
  private readonly secrets?: SecretStore;
  private readonly activeControllers = new Map<string, AbortController>();
  private totalSpendUsd = 0;

  constructor(profile: ProviderProfile, secrets?: SecretStore) {
    this.id = profile.id;
    this.profile = profile;
    this.secrets = secrets;
  }

  public async initialize(): Promise<void> {
    // Initialization hook
  }

  private resolveApiKey(): string | undefined {
    if (this.profile.type === 'asemprotic') {
      return (
        this.secrets?.getSecret('ASEMPROTIC_API_KEY') ||
        process.env.ASEMPROTIC_API_KEY
      );
    }
    if (this.profile.apiKeyEnv) {
      return (
        this.secrets?.getSecret(this.profile.apiKeyEnv) ||
        process.env[this.profile.apiKeyEnv]
      );
    }
    return undefined;
  }

  private resolveEffectiveFormat(): {
    valid: boolean;
    format: ApiFormat;
    baseUrl?: string;
    diagnostic: string;
  } {
    if (this.profile.type === 'asemprotic') {
      const asem = resolveAsemproticConfig(process.env, this.profile);
      return {
        valid: asem.valid,
        format: asem.apiFormat,
        baseUrl: asem.baseUrl,
        diagnostic: asem.diagnostic,
      };
    }

    if (!this.profile.baseUrl) {
      return {
        valid: false,
        format: this.profile.apiFormat,
        diagnostic: `Provider "${this.id}" has no baseUrl configured.`,
      };
    }

    return {
      valid: true,
      format: this.profile.apiFormat,
      baseUrl: this.profile.baseUrl.replace(/\/+$/, ''),
      diagnostic: `Configured (${this.profile.apiFormat} at ${this.profile.baseUrl})`,
    };
  }

  public async authenticate(): Promise<{ authenticated: boolean; detail: string }> {
    const resolved = this.resolveEffectiveFormat();
    if (!resolved.valid) {
      return { authenticated: false, detail: resolved.diagnostic };
    }

    const isLocal = ['ollama', 'lmstudio', 'llamacpp', 'vllm'].includes(this.profile.type);
    const key = this.resolveApiKey();
    if (!isLocal && !key) {
      return {
        authenticated: false,
        detail: `Missing API key (${this.profile.apiKeyEnv || 'API_KEY'}) for provider "${this.id}".`,
      };
    }

    return {
      authenticated: true,
      detail: isLocal
        ? `Local backend configured at ${resolved.baseUrl}`
        : `Credentials present for ${this.id}`,
    };
  }

  public async listModels(): Promise<string[]> {
    const resolved = this.resolveEffectiveFormat();
    if (!resolved.valid || !resolved.baseUrl) return [];
    const auth = await this.authenticate();
    if (!auth.authenticated) return [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      if (resolved.format === 'ollama') {
        const res = await fetch(`${resolved.baseUrl}/api/tags`, {
          signal: controller.signal,
        });
        if (!res.ok) return [];
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        return (data.models || []).map((m) => m.name);
      }

      if (resolved.format === 'openai') {
        const key = this.resolveApiKey();
        const headers: Record<string, string> = { ...this.profile.headers };
        if (key) headers.Authorization = `Bearer ${key}`;
        const res = await fetch(`${resolved.baseUrl}/models`, {
          headers,
          signal: controller.signal,
        });
        if (!res.ok) return this.profile.defaultModel ? [this.profile.defaultModel] : [];
        const data = (await res.json()) as { data?: Array<{ id: string }> };
        return (data.data || []).map((m) => m.id);
      }

      return this.profile.defaultModel ? [this.profile.defaultModel] : [];
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  public async validateModel(model: string): Promise<boolean> {
    if (!model || !model.trim()) return false;
    const models = await this.listModels();
    if (models.length === 0) return Boolean(this.profile.defaultModel || model);
    return models.includes(model);
  }

  public estimateUsage(
    request: GenerateRequest,
    responseText: string,
  ): GenerateResponse['usage'] {
    const inputText = request.messages.map((m) => m.content).join('\n');
    const inputTokens = estimateTokens(inputText);
    const outputTokens = estimateTokens(responseText);
    const totalTokens = inputTokens + outputTokens;
    const estimatedCostUsd = this.profile.billable
      ? Number(((inputTokens * 0.000003) + (outputTokens * 0.000015)).toFixed(6))
      : 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      measurementType: 'estimated',
      estimatedCostUsd,
    };
  }

  public cancel(requestId: string): void {
    const ctrl = this.activeControllers.get(requestId);
    if (ctrl) {
      ctrl.abort();
      this.activeControllers.delete(requestId);
    }
  }

  public async executeToolCalls(
    toolCalls: ToolCallRequest[],
    executor: (call: ToolCallRequest) => Promise<string>,
  ): Promise<Array<{ toolCallId: string; name: string; output: string }>> {
    const results: Array<{ toolCallId: string; name: string; output: string }> = [];
    for (const call of toolCalls) {
      const output = await executor(call);
      results.push({ toolCallId: call.id, name: call.name, output });
    }
    return results;
  }

  public async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const resolved = this.resolveEffectiveFormat();
    if (!resolved.valid || !resolved.baseUrl) {
      throw new Error(resolved.diagnostic);
    }
    const auth = await this.authenticate();
    if (!auth.authenticated) {
      throw new Error(auth.detail);
    }

    if (
      this.profile.budgetLimitUsd !== undefined &&
      this.totalSpendUsd >= this.profile.budgetLimitUsd
    ) {
      throw new Error(
        `Provider "${this.id}" exceeded configured budget limit ($${this.profile.budgetLimitUsd}).`,
      );
    }

    const reqId = request.requestId || `req_${crypto.randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    this.activeControllers.set(reqId, controller);
    if (request.signal) {
      request.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const timer = setTimeout(() => controller.abort(), this.profile.timeoutMs);

    try {
      const model =
        request.model ||
        (this.profile.type === 'asemprotic'
          ? process.env.ASEMPROTIC_MODEL || this.profile.defaultModel
          : this.profile.defaultModel) ||
        'default';

      if (resolved.format === 'anthropic') {
        return await this.generateAnthropic(
          resolved.baseUrl,
          model,
          request,
          controller.signal,
        );
      }
      if (resolved.format === 'gemini') {
        return await this.generateGemini(
          resolved.baseUrl,
          model,
          request,
          controller.signal,
        );
      }
      if (resolved.format === 'ollama') {
        return await this.generateOllama(
          resolved.baseUrl,
          model,
          request,
          controller.signal,
        );
      }
      return await this.generateOpenAI(
        resolved.baseUrl,
        model,
        request,
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
      this.activeControllers.delete(reqId);
    }
  }

  private async generateOpenAI(
    baseUrl: string,
    model: string,
    request: GenerateRequest,
    signal: AbortSignal,
  ): Promise<GenerateResponse> {
    const key = this.resolveApiKey();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.profile.headers,
    };
    if (key) headers.Authorization = `Bearer ${key}`;

    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      max_tokens: request.maxTokens ?? this.profile.maxOutputTokens,
      temperature: request.temperature ?? this.profile.temperature,
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    const endpoint = baseUrl.endsWith('/chat/completions')
      ? baseUrl
      : `${baseUrl}/chat/completions`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status} from ${this.id}: ${errText.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      id?: string;
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{
            id?: string;
            function?: { name: string; arguments: string };
          }>;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const choice = data.choices?.[0];
    const text = choice?.message?.content || '';
    const toolCalls: ToolCallRequest[] = (choice?.message?.tool_calls || []).map((tc) => ({
      id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`,
      name: tc.function?.name || 'unknown',
      arguments: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
    }));

    const hasMeasured = typeof data.usage?.prompt_tokens === 'number';
    const usage: GenerateResponse['usage'] = hasMeasured
      ? {
          inputTokens: data.usage!.prompt_tokens!,
          outputTokens: data.usage!.completion_tokens ?? 0,
          totalTokens:
            data.usage!.total_tokens ??
            data.usage!.prompt_tokens! + (data.usage!.completion_tokens ?? 0),
          measurementType: 'measured',
          estimatedCostUsd: this.profile.billable
            ? Number(
                (
                  data.usage!.prompt_tokens! * 0.000003 +
                  (data.usage!.completion_tokens ?? 0) * 0.000015
                ).toFixed(6),
              )
            : 0,
        }
      : this.estimateUsage(request, text);

    if (typeof usage.estimatedCostUsd === 'number') {
      this.totalSpendUsd += usage.estimatedCostUsd;
    }

    return {
      id: data.id || `gen_${crypto.randomUUID().slice(0, 8)}`,
      providerId: this.id,
      model,
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage,
    };
  }

  private async generateAnthropic(
    baseUrl: string,
    model: string,
    request: GenerateRequest,
    signal: AbortSignal,
  ): Promise<GenerateResponse> {
    const key = this.resolveApiKey();
    const systemMsgs = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const chatMsgs = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));

    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? this.profile.maxOutputTokens,
      messages: chatMsgs,
    };
    if (systemMsgs) body.system = systemMsgs;
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    const endpoint = baseUrl.endsWith('/v1/messages')
      ? baseUrl
      : `${baseUrl}/v1/messages`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key || '',
        'anthropic-version': '2023-06-01',
        ...this.profile.headers,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status} from ${this.id}: ${errText.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      id?: string;
      content?: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const textParts: string[] = [];
    const toolCalls: ToolCallRequest[] = [];
    for (const block of data.content || []) {
      if (block.type === 'text' && block.text) textParts.push(block.text);
      if (block.type === 'tool_use' && block.name) {
        toolCalls.push({
          id: block.id || `toolu_${crypto.randomUUID().slice(0, 8)}`,
          name: block.name,
          arguments: block.input || {},
        });
      }
    }

    const text = textParts.join('\n');
    const inTok = data.usage?.input_tokens;
    const outTok = data.usage?.output_tokens ?? 0;

    return {
      id: data.id || `msg_${crypto.randomUUID().slice(0, 8)}`,
      providerId: this.id,
      model,
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage:
        typeof inTok === 'number'
          ? {
              inputTokens: inTok,
              outputTokens: outTok,
              totalTokens: inTok + outTok,
              measurementType: 'measured',
              estimatedCostUsd: Number(((inTok * 0.000003) + (outTok * 0.000015)).toFixed(6)),
            }
          : this.estimateUsage(request, text),
    };
  }

  private async generateGemini(
    baseUrl: string,
    model: string,
    request: GenerateRequest,
    signal: AbortSignal,
  ): Promise<GenerateResponse> {
    const key = this.resolveApiKey();
    const contents = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const endpoint = `${baseUrl}/models/${model}:generateContent${key ? `?key=${key}` : ''}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.profile.headers },
      body: JSON.stringify({ contents }),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status} from ${this.id}: ${errText.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            functionCall?: { name: string; args: Record<string, unknown> };
          }>;
        };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };

    const parts = data.candidates?.[0]?.content?.parts || [];
    const text = parts
      .map((p) => p.text)
      .filter(Boolean)
      .join('\n');
    const toolCalls: ToolCallRequest[] = parts
      .filter((p) => p.functionCall)
      .map((p) => ({
        id: `call_${crypto.randomUUID().slice(0, 8)}`,
        name: p.functionCall!.name,
        arguments: p.functionCall!.args || {},
      }));

    return {
      id: `gem_${crypto.randomUUID().slice(0, 8)}`,
      providerId: this.id,
      model,
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage:
        typeof data.usageMetadata?.promptTokenCount === 'number'
          ? {
              inputTokens: data.usageMetadata.promptTokenCount,
              outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
              totalTokens: data.usageMetadata.totalTokenCount ?? 0,
              measurementType: 'measured',
              estimatedCostUsd: 0,
            }
          : this.estimateUsage(request, text),
    };
  }

  private async generateOllama(
    baseUrl: string,
    model: string,
    request: GenerateRequest,
    signal: AbortSignal,
  ): Promise<GenerateResponse> {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: request.messages.map((m) => ({
          role: m.role === 'tool' ? 'user' : m.role,
          content: m.content,
        })),
      }),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama error (${res.status}): ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      message?: {
        content?: string;
        tool_calls?: Array<{
          function?: { name: string; arguments: Record<string, unknown> };
        }>;
      };
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const text = data.message?.content || '';
    const toolCalls: ToolCallRequest[] = (data.message?.tool_calls || []).map((tc) => ({
      id: `ollama_${crypto.randomUUID().slice(0, 8)}`,
      name: tc.function?.name || 'unknown',
      arguments: tc.function?.arguments || {},
    }));

    const supportsNativeTools = !/(?:tinyllama|phi2|gemma:2b)/i.test(model);
    const reducedCapabilityWarning =
      request.tools && request.tools.length > 0 && !supportsNativeTools
        ? `Local model "${model}" has limited or unreliable native tool-calling support. Operating in reduced-capability prompt mode.`
        : undefined;

    return {
      id: `ollama_${crypto.randomUUID().slice(0, 8)}`,
      providerId: this.id,
      model,
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage: {
        inputTokens: data.prompt_eval_count ?? estimateTokens(text),
        outputTokens: data.eval_count ?? estimateTokens(text),
        totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
        measurementType: typeof data.eval_count === 'number' ? 'measured' : 'estimated',
        estimatedCostUsd: 0,
      },
      reducedCapabilityWarning,
    };
  }

  public async stream(
    request: GenerateRequest,
    onChunk: (delta: { text?: string; toolCall?: ToolCallRequest }) => void,
  ): Promise<GenerateResponse> {
    const response = await this.generate({ ...request, stream: true });
    if (response.text) {
      onChunk({ text: response.text });
    }
    for (const tc of response.toolCalls) {
      onChunk({ toolCall: tc });
    }
    return response;
  }

  public async healthCheck(): Promise<ProviderHealthStatus> {
    const start = Date.now();
    const resolved = this.resolveEffectiveFormat();
    const auth = await this.authenticate();

    if (!resolved.valid || !auth.authenticated) {
      return {
        providerId: this.id,
        healthy: false,
        authenticated: auth.authenticated,
        availableModels: [],
        supportsTools: resolved.format !== 'unknown',
        supportsStreaming: this.profile.streaming,
        diagnostic: !resolved.valid ? resolved.diagnostic : auth.detail,
      };
    }

    const isLocal = ['ollama', 'lmstudio', 'llamacpp', 'vllm'].includes(this.profile.type);
    if (isLocal) {
      const models = await this.listModels();
      const healthy = models.length > 0;
      return {
        providerId: this.id,
        healthy,
        authenticated: healthy,
        availableModels: models,
        supportsTools: true,
        supportsStreaming: true,
        latencyMs: Date.now() - start,
        diagnostic: healthy
          ? `Local server online (${models.length} models: ${models.slice(0, 3).join(', ')})`
          : `Local server at ${resolved.baseUrl} is unreachable or has no loaded models.`,
      };
    }

    return {
      providerId: this.id,
      healthy: true,
      authenticated: true,
      availableModels: this.profile.defaultModel ? [this.profile.defaultModel] : [],
      supportsTools: true,
      supportsStreaming: this.profile.streaming,
      latencyMs: Date.now() - start,
      diagnostic: `${this.profile.name} ready (${resolved.format}, default model: ${this.profile.defaultModel || 'unspecified'}).`,
    };
  }
}

export class ProviderGateway {
  private readonly providers = new Map<string, ModelProvider>();
  private readonly secrets?: SecretStore;

  constructor(profiles: Record<string, ProviderProfile>, secrets?: SecretStore) {
    this.secrets = secrets;
    for (const profile of Object.values(profiles)) {
      this.registerProvider(new UniversalHttpProvider(profile, secrets));
    }
  }

  public registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  public removeProvider(id: string): boolean {
    return this.providers.delete(id);
  }

  public getProvider(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }

  public listProviders(): ModelProvider[] {
    return Array.from(this.providers.values());
  }

  public async checkAllHealth(): Promise<ProviderHealthStatus[]> {
    const results: ProviderHealthStatus[] = [];
    for (const provider of this.providers.values()) {
      results.push(await provider.healthCheck());
    }
    return results;
  }

  public async findHealthyCustomProvider(priorityOrder: string[]): Promise<{
    provider: ModelProvider;
    health: ProviderHealthStatus;
  } | undefined> {
    const localIds = new Set(['ollama', 'lmstudio', 'llamacpp', 'vllm']);
    for (const id of priorityOrder) {
      if (localIds.has(id)) continue;
      const p = this.providers.get(id);
      if (!p || !p.profile.enabled) continue;
      const health = await p.healthCheck();
      if (health.healthy && health.authenticated) {
        return { provider: p, health };
      }
    }
    return undefined;
  }

  public async findHealthyLocalProvider(): Promise<{
    provider: ModelProvider;
    health: ProviderHealthStatus;
  } | undefined> {
    for (const id of ['ollama', 'lmstudio', 'llamacpp', 'vllm']) {
      const p = this.providers.get(id);
      if (!p || !p.profile.enabled) continue;
      const health = await p.healthCheck();
      if (health.healthy) {
        return { provider: p, health };
      }
    }
    return undefined;
  }
}
