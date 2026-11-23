import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import YAML from 'yaml';

export const ExecutionModeSchema = z.enum(['ask', 'plan', 'edit', 'agent', 'review', 'auto']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const PermissionModeSchema = z.enum([
  'read-only',
  'ask',
  'workspace-write',
  'trusted-automation',
  'sandbox',
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const ApiFormatSchema = z.enum([
  'openai',
  'anthropic',
  'gemini',
  'ollama',
  'custom',
  'unknown',
]);
export type ApiFormat = z.infer<typeof ApiFormatSchema>;

export const ProviderProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum([
    'asemprotic',
    'openai-compatible',
    'anthropic-compatible',
    'gemini',
    'openrouter',
    'ollama',
    'lmstudio',
    'vllm',
    'llamacpp',
    'custom',
  ]),
  enabled: z.boolean().default(true),
  baseUrl: z.string().optional(),
  apiFormat: ApiFormatSchema.default('openai'),
  apiKeyEnv: z.string().optional(),
  defaultModel: z.string().optional(),
  fastModel: z.string().optional(),
  planningModel: z.string().optional(),
  codingModel: z.string().optional(),
  reviewModel: z.string().optional(),
  contextBudget: z.number().int().positive().default(128000),
  temperature: z.number().min(0).max(2).default(0.2),
  topP: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().positive().default(4096),
  timeoutMs: z.number().int().positive().default(120000),
  streaming: z.boolean().default(true),
  budgetLimitUsd: z.number().nonnegative().optional(),
  billable: z.boolean().default(true),
  headers: z.record(z.string(), z.string()).optional(),
});
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

export const AgentConfigEntrySchema = z.object({
  enabled: z.boolean().default(true),
  primaryCapable: z.boolean().default(true),
  subagentCapable: z.boolean().default(true),
  binaryPath: z.string().optional(),
  defaultModel: z.string().optional(),
  timeoutMs: z.number().int().positive().default(180000),
});

export const ShellGPTConfigSchema = z.object({
  configVersion: z.number().int().default(1),
  general: z
    .object({
      appName: z.string().default('ShellGPT'),
      executionMode: ExecutionModeSchema.default('auto'),
      defaultWorkspace: z.string().default('.'),
      theme: z.enum(['dark', 'light', 'custom']).default('dark'),
      streaming: z.boolean().default(true),
      defaultPermissionMode: PermissionModeSchema.default('ask'),
      outputStyle: z.enum(['compact', 'standard', 'verbose', 'json']).default('standard'),
      vimMode: z.boolean().default(false),
    })
    .default({
      appName: 'ShellGPT',
      executionMode: 'auto',
      defaultWorkspace: '.',
      theme: 'dark',
      streaming: true,
      defaultPermissionMode: 'ask',
      outputStyle: 'standard',
      vimMode: false,
    }),
  routing: z
    .object({
      explicitAgent: z
        .enum(['auto', 'antigravity', 'codex', 'custom', 'local', 'claude'])
        .default('auto'),
      activeProviderId: z.string().optional(),
      activeModel: z.string().optional(),
      preferCustomApiWhenHealthy: z.boolean().default(true),
      preferAntigravityWhenNoApi: z.boolean().default(true),
      fallbackToCodex: z.boolean().default(true),
      allowManualPinning: z.boolean().default(true),
      allowLocalModelRecovery: z.boolean().default(true),
      enableAutomaticFallback: z.boolean().default(true),
      allowBillableFallback: z.boolean().default(false),
      circuitBreakerThreshold: z.number().int().positive().default(3),
      circuitBreakerResetMs: z.number().int().positive().default(60000),
      maxRetries: z.number().int().nonnegative().default(2),
      providerPriority: z
        .array(z.string())
        .default([
          'asemprotic',
          'openai',
          'anthropic',
          'gemini',
          'openrouter',
          'ollama',
          'lmstudio',
          'vllm',
          'llamacpp',
        ]),
    })
    .default({
      explicitAgent: 'auto',
      preferCustomApiWhenHealthy: true,
      preferAntigravityWhenNoApi: true,
      fallbackToCodex: true,
      allowManualPinning: true,
      allowLocalModelRecovery: true,
      enableAutomaticFallback: true,
      allowBillableFallback: false,
      circuitBreakerThreshold: 3,
      circuitBreakerResetMs: 60000,
      maxRetries: 2,
      providerPriority: [
        'asemprotic',
        'openai',
        'anthropic',
        'gemini',
        'openrouter',
        'ollama',
        'lmstudio',
        'vllm',
        'llamacpp',
      ],
    }),
  agents: z
    .object({
      antigravity: AgentConfigEntrySchema.default({
        enabled: true,
        primaryCapable: true,
        subagentCapable: true,
        binaryPath: 'agy',
        defaultModel: 'gemini-3.8-flash-low',
        timeoutMs: 180000,
      }),
      codex: AgentConfigEntrySchema.default({
        enabled: true,
        primaryCapable: true,
        subagentCapable: true,
        binaryPath: 'codex',
        defaultModel: 'gpt-6-astra',
        timeoutMs: 180000,
      }),
      customLlm: z
        .object({
          enabled: z.boolean().default(true),
          controllerCapable: z.boolean().default(true),
        })
        .default({
          enabled: true,
          controllerCapable: true,
        }),
      claude: AgentConfigEntrySchema.default({
        enabled: false,
        primaryCapable: false,
        subagentCapable: true,
        binaryPath: 'claude',
        defaultModel: 'claude-sonnet-5-5',
        timeoutMs: 180000,
      }),
    })
    .default({
      antigravity: {
        enabled: true,
        primaryCapable: true,
        subagentCapable: true,
        binaryPath: 'agy',
        defaultModel: 'gemini-3.8-flash-low',
        timeoutMs: 180000,
      },
      codex: {
        enabled: true,
        primaryCapable: true,
        subagentCapable: true,
        binaryPath: 'codex',
        defaultModel: 'gpt-6-astra',
        timeoutMs: 180000,
      },
      customLlm: {
        enabled: true,
        controllerCapable: true,
      },
      claude: {
        enabled: false,
        primaryCapable: false,
        subagentCapable: true,
        binaryPath: 'claude',
        defaultModel: 'claude-sonnet-5-5',
        timeoutMs: 180000,
      },
    }),
  orchestration: z
    .object({
      maxParallelWorkers: z.number().int().min(1).max(16).default(3),
      maxRepairAttempts: z.number().int().min(0).max(10).default(3),
      automaticVerification: z.boolean().default(true),
      gitWorktreeIsolation: z.boolean().default(true),
      conflictDetection: z.boolean().default(true),
      requireApprovalForDestructiveActions: z.boolean().default(true),
      taskTimeoutMs: z.number().int().positive().default(180000),
    })
    .default({
      maxParallelWorkers: 3,
      maxRepairAttempts: 3,
      automaticVerification: true,
      gitWorktreeIsolation: true,
      conflictDetection: true,
      requireApprovalForDestructiveActions: true,
      taskTimeoutMs: 180000,
    }),
  mcp: z
    .object({
      enabled: z.boolean().default(true),
      reaEnabled: z.boolean().default(true),
      discovery: z.boolean().default(true),
      toolPermissionChecks: z.boolean().default(true),
    })
    .default({
      enabled: true,
      reaEnabled: true,
      discovery: true,
      toolPermissionChecks: true,
    }),
  memory: z
    .object({
      persistentSessions: z.boolean().default(true),
      sqliteEnabled: z.boolean().default(true),
      databasePath: z.string().default('.shellgpt/shellgpt.db'),
      contextCompaction: z.boolean().default(true),
      maxContextTokens: z.number().int().positive().default(120000),
      automaticCheckpoints: z.boolean().default(true),
      retentionDays: z.number().int().positive().default(90),
    })
    .default({
      persistentSessions: true,
      sqliteEnabled: true,
      databasePath: '.shellgpt/shellgpt.db',
      contextCompaction: true,
      maxContextTokens: 120000,
      automaticCheckpoints: true,
      retentionDays: 90,
    }),
  providers: z.record(z.string(), ProviderProfileSchema).default({}),
  roleAssignments: z.record(z.string(), z.string()).default({}),
  plugins: z.record(z.string(), z.object({ enabled: z.boolean() })).default({}),
});

export type ShellGPTConfig = z.infer<typeof ShellGPTConfigSchema>;

export interface AsemproticEnvConfig {
  configured: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  apiFormat: ApiFormat;
  valid: boolean;
  diagnostic: string;
}

/**
 * Inspect ASEMPROTIC_* environment and config without ever assuming or inventing a default URL/protocol.
 */
export function resolveAsemproticConfig(
  env: NodeJS.ProcessEnv = process.env,
  profile?: ProviderProfile,
): AsemproticEnvConfig {
  const apiKey = env.ASEMPROTIC_API_KEY?.trim();
  const baseUrl = (env.ASEMPROTIC_BASE_URL || profile?.baseUrl)?.trim();
  const model = (env.ASEMPROTIC_MODEL || profile?.defaultModel)?.trim();
  const rawFormat = (env.ASEMPROTIC_API_FORMAT || profile?.apiFormat)?.trim()?.toLowerCase();

  const configured = Boolean(apiKey || baseUrl || model || rawFormat || profile);
  if (!configured) {
    return {
      configured: false,
      apiFormat: 'unknown',
      valid: false,
      diagnostic:
        'Asemprotic is not configured. Set ASEMPROTIC_BASE_URL, ASEMPROTIC_API_KEY, ASEMPROTIC_MODEL, and ASEMPROTIC_API_FORMAT (openai|anthropic|gemini|custom).',
    };
  }

  let apiFormat: ApiFormat = 'unknown';
  if (
    rawFormat === 'openai' ||
    rawFormat === 'anthropic' ||
    rawFormat === 'gemini' ||
    rawFormat === 'ollama' ||
    rawFormat === 'custom'
  ) {
    apiFormat = rawFormat;
  }

  if (!baseUrl) {
    return {
      configured: true,
      apiKey,
      model,
      apiFormat,
      valid: false,
      diagnostic:
        'Asemprotic requires an explicit ASEMPROTIC_BASE_URL (ShellGPT never assumes an unverified Asemprotic endpoint).',
    };
  }

  if (apiFormat === 'unknown') {
    return {
      configured: true,
      apiKey,
      baseUrl,
      model,
      apiFormat: 'unknown',
      valid: false,
      diagnostic:
        'Asemprotic protocol format is unknown. Specify ASEMPROTIC_API_FORMAT (openai, anthropic, gemini, or custom) or provide the API specification.',
    };
  }

  return {
    configured: true,
    apiKey,
    baseUrl,
    model: model || 'default',
    apiFormat,
    valid: true,
    diagnostic: `Asemprotic configured (${apiFormat} protocol at ${baseUrl}, model=${model || 'default'}).`,
  };
}

/**
 * Secure SecretStore using OS credential helpers where available, with AES-256-GCM local vault fallback.
 * Never logs or exposes raw secrets in session databases.
 */
export class SecretStore {
  private readonly vaultPath: string;
  private readonly keyPath: string;
  private readonly knownSecretValues = new Set<string>();

  constructor(workspaceDir: string = process.cwd()) {
    const shellgptDir = path.join(workspaceDir, '.shellgpt');
    fs.mkdirSync(shellgptDir, { recursive: true });
    this.vaultPath = path.join(shellgptDir, 'secrets.enc');
    this.keyPath = path.join(os.homedir(), '.shellgpt-master.key');
    this.collectEnvSecrets();
  }

  private collectEnvSecrets(): void {
    const secretEnvKeys = [
      'ASEMPROTIC_API_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'OPENROUTER_API_KEY',
      'SHELLGPT_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ];
    for (const k of secretEnvKeys) {
      const val = process.env[k];
      if (val && val.length >= 6 && val !== 'replace-with-a-random-local-key') {
        this.knownSecretValues.add(val);
      }
    }
  }

  private getOrCreateMasterKey(): Buffer {
    try {
      if (fs.existsSync(this.keyPath)) {
        return Buffer.from(fs.readFileSync(this.keyPath, 'utf8').trim(), 'hex');
      }
      const key = crypto.randomBytes(32);
      fs.writeFileSync(this.keyPath, key.toString('hex'), { mode: 0o600 });
      return key;
    } catch {
      // Fallback key derived from machine uid/homedir if homedir is read-only in sandbox
      const fallbackPath = path.join(os.tmpdir(), '.shellgpt-sandbox.key');
      if (fs.existsSync(fallbackPath)) {
        return Buffer.from(fs.readFileSync(fallbackPath, 'utf8').trim(), 'hex');
      }
      const key = crypto.randomBytes(32);
      fs.writeFileSync(fallbackPath, key.toString('hex'), { mode: 0o600 });
      return key;
    }
  }

  private readVault(): Record<string, string> {
    if (!fs.existsSync(this.vaultPath)) return {};
    try {
      const payload = JSON.parse(fs.readFileSync(this.vaultPath, 'utf8'));
      const key = this.getOrCreateMasterKey();
      const iv = Buffer.from(payload.iv, 'hex');
      const tag = Buffer.from(payload.tag, 'hex');
      const encrypted = Buffer.from(payload.data, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
        'utf8',
      );
      const parsed = JSON.parse(decrypted) as Record<string, string>;
      for (const v of Object.values(parsed)) {
        if (v && v.length >= 6) this.knownSecretValues.add(v);
      }
      return parsed;
    } catch {
      return {};
    }
  }

  private writeVault(secrets: Record<string, string>): void {
    const key = this.getOrCreateMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(secrets), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    fs.writeFileSync(
      this.vaultPath,
      JSON.stringify({
        version: 1,
        iv: iv.toString('hex'),
        tag: tag.toString('hex'),
        data: encrypted.toString('hex'),
      }),
      { mode: 0o600 },
    );
  }

  public setSecret(name: string, value: string): void {
    if (value && value.length >= 6) {
      this.knownSecretValues.add(value);
    }
    // Attempt OS keyring if available on macOS/Linux
    if (process.platform === 'darwin') {
      try {
        execFileSync(
          'security',
          ['add-generic-password', '-a', 'shellgpt', '-s', `shellgpt:${name}`, '-w', value, '-U'],
          { stdio: 'ignore', timeout: 2000 },
        );
      } catch {
        // Fallback to encrypted vault
      }
    }
    const vault = this.readVault();
    vault[name] = value;
    this.writeVault(vault);
  }

  public getSecret(name: string): string | undefined {
    if (process.env[name]) {
      const val = process.env[name]!;
      if (val.length >= 6) this.knownSecretValues.add(val);
      return val;
    }
    const vault = this.readVault();
    return vault[name];
  }

  public deleteSecret(name: string): boolean {
    const vault = this.readVault();
    if (!(name in vault)) return false;
    delete vault[name];
    this.writeVault(vault);
    return true;
  }

  public getKnownSecrets(): string[] {
    this.readVault();
    this.collectEnvSecrets();
    return Array.from(this.knownSecretValues);
  }
}

export class ConfigManager {
  private readonly workspaceDir: string;
  private readonly configPath: string;
  private config: ShellGPTConfig;
  public readonly secrets: SecretStore;

  constructor(workspaceDir: string = process.cwd(), customConfigPath?: string) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.configPath =
      customConfigPath || path.join(this.workspaceDir, '.shellgpt', 'config.yaml');
    this.secrets = new SecretStore(this.workspaceDir);
    this.config = this.load();
  }

  public getConfigPath(): string {
    return this.configPath;
  }

  public getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  public load(): ShellGPTConfig {
    let raw: Record<string, unknown> = {};
    if (fs.existsSync(this.configPath)) {
      const content = fs.readFileSync(this.configPath, 'utf8');
      raw = (YAML.parse(content) as Record<string, unknown>) || {};
    }
    const migrated = this.migrate(raw);
    const parsed = ShellGPTConfigSchema.parse(migrated);
    this.applyDefaultProviders(parsed);
    this.config = parsed;
    return this.config;
  }

  private migrate(raw: Record<string, unknown>): Record<string, unknown> {
    const copy = { ...raw };
    if (!copy.configVersion) {
      copy.configVersion = 1;
    }
    return copy;
  }

  private applyDefaultProviders(cfg: ShellGPTConfig): void {
    const defaults: Record<string, ProviderProfile> = {
      asemprotic: ProviderProfileSchema.parse({
        id: 'asemprotic',
        name: 'Asemprotic Custom API',
        type: 'asemprotic',
        enabled: true,
        baseUrl: process.env.ASEMPROTIC_BASE_URL,
        apiFormat:
          (process.env.ASEMPROTIC_API_FORMAT as ApiFormat | undefined) || 'unknown',
        apiKeyEnv: 'ASEMPROTIC_API_KEY',
        defaultModel: process.env.ASEMPROTIC_MODEL,
        billable: false,
      }),
      openai: ProviderProfileSchema.parse({
        id: 'openai',
        name: 'OpenAI API',
        type: 'openai-compatible',
        enabled: true,
        baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        apiFormat: 'openai',
        apiKeyEnv: 'OPENAI_API_KEY',
        defaultModel: process.env.OPENAI_MODEL || 'gpt-4.1',
        billable: true,
      }),
      anthropic: ProviderProfileSchema.parse({
        id: 'anthropic',
        name: 'Anthropic Messages API',
        type: 'anthropic-compatible',
        enabled: true,
        baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
        apiFormat: 'anthropic',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        defaultModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
        billable: true,
      }),
      gemini: ProviderProfileSchema.parse({
        id: 'gemini',
        name: 'Google Gemini API',
        type: 'gemini',
        enabled: true,
        baseUrl:
          process.env.GEMINI_BASE_URL ||
          'https://generativelanguage.googleapis.com/v1beta',
        apiFormat: 'gemini',
        apiKeyEnv: 'GEMINI_API_KEY',
        defaultModel: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
        billable: true,
      }),
      openrouter: ProviderProfileSchema.parse({
        id: 'openrouter',
        name: 'OpenRouter Gateway',
        type: 'openrouter',
        enabled: true,
        baseUrl: 'https://openrouter.ai/api/v1',
        apiFormat: 'openai',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        defaultModel: 'anthropic/claude-3.7-sonnet',
        billable: true,
      }),
      ollama: ProviderProfileSchema.parse({
        id: 'ollama',
        name: 'Ollama Local Server',
        type: 'ollama',
        enabled: true,
        baseUrl: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
        apiFormat: 'ollama',
        defaultModel: process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b',
        billable: false,
      }),
      lmstudio: ProviderProfileSchema.parse({
        id: 'lmstudio',
        name: 'LM Studio Local Server',
        type: 'lmstudio',
        enabled: true,
        baseUrl: process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1',
        apiFormat: 'openai',
        defaultModel: 'local-model',
        billable: false,
      }),
      llamacpp: ProviderProfileSchema.parse({
        id: 'llamacpp',
        name: 'llama.cpp HTTP Server',
        type: 'llamacpp',
        enabled: true,
        baseUrl: process.env.LLAMACPP_BASE_URL || 'http://127.0.0.1:8080/v1',
        apiFormat: 'openai',
        defaultModel: 'local-gguf',
        billable: false,
      }),
      vllm: ProviderProfileSchema.parse({
        id: 'vllm',
        name: 'vLLM OpenAI Server',
        type: 'vllm',
        enabled: true,
        baseUrl: process.env.VLLM_BASE_URL || 'http://127.0.0.1:8000/v1',
        apiFormat: 'openai',
        defaultModel: 'default',
        billable: false,
      }),
    };

    for (const [id, profile] of Object.entries(defaults)) {
      if (!cfg.providers[id]) {
        cfg.providers[id] = profile;
      }
    }
  }

  public get(): ShellGPTConfig {
    return this.config;
  }

  public update(updater: (cfg: ShellGPTConfig) => void): ShellGPTConfig {
    updater(this.config);
    this.config = ShellGPTConfigSchema.parse(this.config);
    this.save();
    return this.config;
  }

  public save(): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    const yamlStr = YAML.stringify(this.config);
    fs.writeFileSync(this.configPath, yamlStr, 'utf8');
  }
}
