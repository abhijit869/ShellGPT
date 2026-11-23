import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StreamableHTTPClientTransport, SSEClientTransport } from '@modelcontextprotocol/client';
import AjvModule from 'ajv';
import { sanitizeUntrustedContent, type PermissionEngine } from '@shellgpt/permissions';
import type { TelemetryManager } from '@shellgpt/telemetry';

const Ajv = (AjvModule as unknown as { default?: typeof AjvModule }).default || AjvModule;

export type McpTransportType = 'stdio' | 'streamable-http' | 'sse';

export interface McpServerConfig {
  name: string;
  transport: McpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  allowedAgents?: string[]; // if omitted, allowed for all agents
  timeoutMs?: number;
}

export interface McpDiscoveredTool {
  serverName: string;
  name: string;
  qualifiedName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpDiscoveredResource {
  serverName: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpDiscoveredPrompt {
  serverName: string;
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpServerStatus {
  name: string;
  enabled: boolean;
  connected: boolean;
  transport: McpTransportType;
  serverVersion?: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  lastError?: string;
  lastHealthCheck?: string;
}

interface ActiveConnection {
  config: McpServerConfig;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
  tools: McpDiscoveredTool[];
  resources: McpDiscoveredResource[];
  prompts: McpDiscoveredPrompt[];
  serverVersion?: string;
  lastError?: string;
}

export class McpManager {
  private readonly workspaceDir: string;
  private readonly configFilePath: string;
  private readonly servers = new Map<string, McpServerConfig>();
  private readonly connections = new Map<string, ActiveConnection>();
  private readonly logs: Array<{ timestamp: string; server: string; message: string }> = [];
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly permissions?: PermissionEngine;
  private readonly telemetry?: TelemetryManager;

  constructor(
    workspaceDir: string = process.cwd(),
    permissions?: PermissionEngine,
    telemetry?: TelemetryManager,
  ) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.configFilePath = path.join(this.workspaceDir, '.shellgpt', 'mcp.json');
    this.permissions = permissions;
    this.telemetry = telemetry;
    this.loadConfigurations();
  }

  private recordLog(server: string, message: string): void {
    const entry = {
      timestamp: new Date().toISOString(),
      server,
      message,
    };
    this.logs.push(entry);
    if (this.logs.length > 300) {
      this.logs.shift();
    }
    this.telemetry?.log('info', `mcp:${server}`, message);
  }

  public loadConfigurations(): void {
    const candidateFiles = [
      path.join(this.workspaceDir, '.agents', 'mcp_config.json'),
      path.join(this.workspaceDir, '.shellgpt', 'mcp.json'),
    ];

    for (const file of candidateFiles) {
      if (!fs.existsSync(file)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
          mcpServers?: Record<string, Record<string, unknown>>;
        };
        if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
          for (const [name, raw] of Object.entries(parsed.mcpServers)) {
            const url = (raw.url || raw.serverUrl) as string | undefined;
            const transport: McpTransportType = url
              ? raw.transport === 'sse'
                ? 'sse'
                : 'streamable-http'
              : 'stdio';
            this.servers.set(name, {
              name,
              transport,
              command: raw.command ? String(raw.command) : undefined,
              args: Array.isArray(raw.args) ? raw.args.map(String) : undefined,
              env:
                raw.env && typeof raw.env === 'object'
                  ? (raw.env as Record<string, string>)
                  : undefined,
              url,
              headers:
                raw.headers && typeof raw.headers === 'object'
                  ? (raw.headers as Record<string, string>)
                  : undefined,
              enabled: raw.enabled !== false,
              allowedAgents: Array.isArray(raw.allowedAgents)
                ? raw.allowedAgents.map(String)
                : undefined,
              timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : 30000,
            });
          }
        }
      } catch (err) {
        this.recordLog('config', `Failed to parse MCP config ${file}: ${(err as Error).message}`);
      }
    }
  }

  public saveConfigurations(): void {
    fs.mkdirSync(path.dirname(this.configFilePath), { recursive: true });
    const mcpServers: Record<string, unknown> = {};
    for (const [name, cfg] of this.servers.entries()) {
      mcpServers[name] = {
        transport: cfg.transport,
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
        url: cfg.url,
        headers: cfg.headers,
        enabled: cfg.enabled,
        allowedAgents: cfg.allowedAgents,
        timeoutMs: cfg.timeoutMs,
      };
    }
    fs.writeFileSync(this.configFilePath, JSON.stringify({ mcpServers }, null, 2), 'utf8');
  }

  public addServer(config: McpServerConfig): void {
    this.servers.set(config.name, config);
    this.saveConfigurations();
    this.recordLog(config.name, `Registered MCP server (${config.transport})`);
  }

  public removeServer(name: string): boolean {
    void this.disconnectServer(name);
    const existed = this.servers.delete(name);
    if (existed) {
      this.saveConfigurations();
      this.recordLog(name, 'Removed MCP server');
    }
    return existed;
  }

  public setServerEnabled(name: string, enabled: boolean): boolean {
    const srv = this.servers.get(name);
    if (!srv) return false;
    srv.enabled = enabled;
    if (!enabled) {
      void this.disconnectServer(name);
    }
    this.saveConfigurations();
    this.recordLog(name, `Server ${enabled ? 'enabled' : 'disabled'}`);
    return true;
  }

  public listServerConfigs(): McpServerConfig[] {
    return Array.from(this.servers.values());
  }

  public async connectServer(name: string): Promise<McpServerStatus> {
    const config = this.servers.get(name);
    if (!config) {
      throw new Error(`MCP server "${name}" is not configured.`);
    }
    if (!config.enabled) {
      throw new Error(`MCP server "${name}" is disabled.`);
    }

    if (this.connections.has(name)) {
      await this.disconnectServer(name);
    }

    const client = new Client(
      { name: 'shellgpt-mcp-client', version: '1.0.0' },
      { capabilities: {} },
    );

    let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

    if (config.transport === 'stdio') {
      if (!config.command) {
        throw new Error(`MCP stdio server "${name}" is missing a command.`);
      }
      // Resolve 'rea mcp' to 'rea --mcp' automatically if configured with args: ['mcp']
      const normalizedArgs =
        config.command.endsWith('rea') &&
        config.args?.length === 1 &&
        config.args[0] === 'mcp'
          ? ['--mcp']
          : config.args || [];

      const safeEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.endsWith('_API_KEY') && !k.endsWith('_TOKEN')) {
          safeEnv[k] = v;
        }
      }
      Object.assign(safeEnv, config.env || {});

      transport = new StdioClientTransport({
        command: config.command,
        args: normalizedArgs,
        env: safeEnv,
        stderr: 'pipe',
      });
    } else if (config.transport === 'streamable-http') {
      if (!config.url) {
        throw new Error(`MCP HTTP server "${name}" is missing a URL.`);
      }
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers },
      });
    } else {
      if (!config.url) {
        throw new Error(`MCP SSE server "${name}" is missing a URL.`);
      }
      transport = new SSEClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers },
      });
    }

    try {
      await client.connect(transport);
      const serverInfo = client.getServerVersion();
      const serverVersion = serverInfo
        ? `${serverInfo.name}@${serverInfo.version}`
        : undefined;

      let tools: McpDiscoveredTool[] = [];
      try {
        const toolList = await client.listTools();
        tools = (toolList.tools || []).map((t) => ({
          serverName: name,
          name: t.name,
          qualifiedName: `${name}__${t.name}`,
          description: t.description,
          inputSchema: (t.inputSchema as Record<string, unknown>) || { type: 'object' },
        }));
      } catch {
        // Server may not support tools capability
      }

      let resources: McpDiscoveredResource[] = [];
      try {
        const resList = await client.listResources();
        resources = (resList.resources || []).map((r) => ({
          serverName: name,
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        }));
      } catch {
        // Server may not support resources capability
      }

      let prompts: McpDiscoveredPrompt[] = [];
      try {
        const promptList = await client.listPrompts();
        prompts = (promptList.prompts || []).map((p) => ({
          serverName: name,
          name: p.name,
          description: p.description,
          arguments: p.arguments,
        }));
      } catch {
        // Server may not support prompts capability
      }

      this.connections.set(name, {
        config,
        client,
        transport,
        tools,
        resources,
        prompts,
        serverVersion,
      });

      this.recordLog(
        name,
        `Connected (${serverVersion || 'unknown version'}): ${tools.length} tools, ${resources.length} resources, ${prompts.length} prompts`,
      );

      return this.getServerStatus(name)!;
    } catch (err) {
      const msg = (err as Error).message;
      this.recordLog(name, `Connection failed: ${msg}`);
      throw err;
    }
  }

  public async disconnectServer(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    try {
      await conn.client.close();
    } catch {
      // Ignore close errors
    }
    this.connections.delete(name);
    this.recordLog(name, 'Disconnected');
  }

  public async disconnectAll(): Promise<void> {
    for (const name of Array.from(this.connections.keys())) {
      await this.disconnectServer(name);
    }
  }

  public async restartServer(name: string): Promise<McpServerStatus> {
    await this.disconnectServer(name);
    return this.connectServer(name);
  }

  public getServerStatus(name: string): McpServerStatus | undefined {
    const cfg = this.servers.get(name);
    if (!cfg) return undefined;
    const conn = this.connections.get(name);
    return {
      name,
      enabled: cfg.enabled,
      connected: Boolean(conn),
      transport: cfg.transport,
      serverVersion: conn?.serverVersion,
      toolCount: conn?.tools.length ?? 0,
      resourceCount: conn?.resources.length ?? 0,
      promptCount: conn?.prompts.length ?? 0,
      lastError: conn?.lastError,
      lastHealthCheck: new Date().toISOString(),
    };
  }

  public getAllStatuses(): McpServerStatus[] {
    return Array.from(this.servers.keys()).map((name) => this.getServerStatus(name)!);
  }

  /**
   * Lists all discovered tools across connected servers, resolving naming conflicts via `<serverName>__<toolName>`.
   */
  public getDiscoveredTools(agentName?: string): McpDiscoveredTool[] {
    const all: McpDiscoveredTool[] = [];
    const nameCounts = new Map<string, number>();

    for (const conn of this.connections.values()) {
      if (
        agentName &&
        conn.config.allowedAgents &&
        !conn.config.allowedAgents.includes(agentName)
      ) {
        continue;
      }
      for (const t of conn.tools) {
        nameCounts.set(t.name, (nameCounts.get(t.name) || 0) + 1);
        all.push(t);
      }
    }

    return all.map((t) => ({
      ...t,
      qualifiedName: (nameCounts.get(t.name) || 0) > 1 ? `${t.serverName}__${t.name}` : t.name,
    }));
  }

  public getDiscoveredResources(): McpDiscoveredResource[] {
    const all: McpDiscoveredResource[] = [];
    for (const conn of this.connections.values()) {
      all.push(...conn.resources);
    }
    return all;
  }

  public getDiscoveredPrompts(): McpDiscoveredPrompt[] {
    const all: McpDiscoveredPrompt[] = [];
    for (const conn of this.connections.values()) {
      all.push(...conn.prompts);
    }
    return all;
  }

  public validateToolArguments(
    tool: McpDiscoveredTool,
    args: Record<string, unknown>,
  ): { valid: boolean; errors: string[] } {
    try {
      const validate = this.ajv.compile(tool.inputSchema);
      const valid = Boolean(validate(args));
      const errors = (validate.errors || []).map(
        (e) => `${e.instancePath || '/'} ${e.message || 'invalid'}`,
      );
      return { valid, errors };
    } catch {
      return { valid: true, errors: [] };
    }
  }

  public async invokeTool(params: {
    serverName?: string;
    toolName: string;
    arguments: Record<string, unknown>;
    actor?: string;
  }): Promise<{
    serverName: string;
    toolName: string;
    rawResult: unknown;
    sanitizedText: string;
    isUntrusted: boolean;
  }> {
    let targetServer = params.serverName;
    let rawToolName = params.toolName;

    if (!targetServer && rawToolName.includes('__')) {
      const [srv, tName] = rawToolName.split('__', 2);
      targetServer = srv;
      rawToolName = tName;
    }

    let conn: ActiveConnection | undefined;
    if (targetServer) {
      conn = this.connections.get(targetServer);
      if (!conn && this.servers.get(targetServer)?.enabled) {
        await this.connectServer(targetServer);
        conn = this.connections.get(targetServer);
      }
    } else {
      for (const candidate of this.connections.values()) {
        if (candidate.tools.some((t) => t.name === rawToolName)) {
          conn = candidate;
          targetServer = candidate.config.name;
          break;
        }
      }
    }

    if (!conn || !targetServer) {
      throw new Error(`MCP tool "${params.toolName}" not found on any connected server.`);
    }

    if (
      params.actor &&
      conn.config.allowedAgents &&
      !conn.config.allowedAgents.includes(params.actor)
    ) {
      throw new Error(
        `Agent "${params.actor}" is not permitted to invoke tools on MCP server "${targetServer}".`,
      );
    }

    const toolDef = conn.tools.find((t) => t.name === rawToolName);
    if (!toolDef) {
      throw new Error(`Tool "${rawToolName}" is not exposed by MCP server "${targetServer}".`);
    }

    const validation = this.validateToolArguments(toolDef, params.arguments);
    if (!validation.valid) {
      throw new Error(
        `Invalid arguments for MCP tool "${rawToolName}": ${validation.errors.join('; ')}`,
      );
    }

    if (this.permissions) {
      const decision = await this.permissions.checkPermission({
        id: `mcp_${crypto.randomUUID().slice(0, 8)}`,
        actor: params.actor || 'shellgpt',
        category: 'mcp_tool',
        target: `${targetServer}:${rawToolName}`,
        description: `Invoke MCP tool ${targetServer}:${rawToolName}`,
        riskLevel: 'low',
      });
      if (!decision.allowed && decision.decision === 'deny') {
        throw new Error(`MCP tool invocation blocked by permission policy: ${decision.reason}`);
      }
    }

    this.recordLog(targetServer, `Invoking tool ${rawToolName}`);
    const result = (await conn.client.callTool({
      name: rawToolName,
      arguments: params.arguments,
    })) as Record<string, unknown>;

    const meta = result._meta as Record<string, unknown> | undefined;
    const provenance = meta?.provenance as Record<string, unknown> | undefined;
    const isUntrusted = Boolean(provenance?.untrusted_content);

    const contentBlocks = Array.isArray(result.content)
      ? (result.content as Array<{ type?: string; text?: string }>)
      : [];
    const combinedText = contentBlocks
      .map((b) => (typeof b.text === 'string' ? b.text : JSON.stringify(b)))
      .join('\n');

    const sanitized = sanitizeUntrustedContent(
      combinedText,
      `mcp:${targetServer}:${rawToolName}`,
    );

    return {
      serverName: targetServer,
      toolName: rawToolName,
      rawResult: result,
      sanitizedText: isUntrusted || sanitized.injectionDetected ? sanitized.sanitized : combinedText,
      isUntrusted: isUntrusted || sanitized.injectionDetected,
    };
  }

  public async runDoctor(): Promise<
    Array<{
      server: string;
      healthy: boolean;
      toolCount: number;
      detail: string;
    }>
  > {
    const reports: Array<{
      server: string;
      healthy: boolean;
      toolCount: number;
      detail: string;
    }> = [];

    for (const [name, cfg] of this.servers.entries()) {
      if (!cfg.enabled) {
        reports.push({
          server: name,
          healthy: true,
          toolCount: 0,
          detail: 'Disabled in configuration',
        });
        continue;
      }
      try {
        const status = await this.connectServer(name);
        reports.push({
          server: name,
          healthy: status.connected,
          toolCount: status.toolCount,
          detail: `Connected (${status.serverVersion || status.transport}): ${status.toolCount} tools, ${status.promptCount} prompts`,
        });
      } catch (err) {
        reports.push({
          server: name,
          healthy: false,
          toolCount: 0,
          detail: `Failed to connect: ${(err as Error).message}`,
        });
      }
    }

    return reports;
  }

  public exportConfig(): string {
    const mcpServers: Record<string, unknown> = {};
    for (const [name, cfg] of this.servers.entries()) {
      mcpServers[name] = cfg;
    }
    return JSON.stringify({ mcpServers }, null, 2);
  }

  public importConfig(jsonString: string): number {
    const parsed = JSON.parse(jsonString) as { mcpServers?: Record<string, McpServerConfig> };
    if (!parsed.mcpServers) return 0;
    let count = 0;
    for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
      this.servers.set(name, { ...cfg, name });
      count++;
    }
    this.saveConfigurations();
    return count;
  }

  public getLogs(limit = 50): Array<{ timestamp: string; server: string; message: string }> {
    return this.logs.slice(-limit);
  }
}
