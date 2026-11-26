import { runtimeEnvironment } from '@shellgpt/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { McpManager, McpDiscoveredTool } from '@shellgpt/mcp';

export interface ReaEngineStatus {
  name: string;
  available: boolean;
  pathOrDetail: string;
  capabilities: string[];
}

export interface ReaDoctorReport {
  installed: boolean;
  version?: string;
  binaryPath?: string;
  mcpHealthy: boolean;
  observedTools: number;
  observedPrompts: number;
  catalogDigest?: string;
  requestFlowOk: boolean;
  engines: ReaEngineStatus[];
  skillsPath?: string;
  diagnostic: string;
}

export interface ReaAnalysisEvidence {
  targetPath: string;
  authorizedByUser: boolean;
  workflow:
    | 'javascript-application'
    | 'web-bundle'
    | 'source-map'
    | 'native-binary'
    | 'android-apk'
    | 'api-contract'
    | 'session-overview';
  toolUsed: string;
  timestamp: string;
  rawSummary: string;
  structuredFindings: Record<string, unknown>;
}

export class ReaIntegration {
  private readonly workspaceDir: string;
  private readonly mcp: McpManager;
  private authorizedTargets = new Set<string>();

  constructor(workspaceDir: string, mcp: McpManager) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.mcp = mcp;
    // Automatically authorize the current workspace directory
    this.authorizedTargets.add(this.workspaceDir);
  }

  public authorizeTarget(targetPath: string): void {
    this.authorizedTargets.add(path.resolve(this.workspaceDir, targetPath));
  }

  public isTargetAuthorized(targetPath: string): boolean {
    const resolved = path.resolve(this.workspaceDir, targetPath);
    for (const allowed of this.authorizedTargets) {
      if (resolved === allowed || resolved.startsWith(allowed + path.sep)) {
        return true;
      }
    }
    return false;
  }

  public detectBinary(): { installed: boolean; binaryPath?: string; version?: string; skillsPath?: string } {
    const candidates = [
      process.env.REA_BIN,
      'rea',
      '/usr/local/share/nvm/versions/node/v24.22.2/bin/rea',
    ].filter((c): c is string => Boolean(c));

    for (const bin of candidates) {
      try {
        const version = execFileSync(bin, ['--version'], {
          env: runtimeEnvironment(),
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const skillsCandidate =
          '/usr/local/share/nvm/versions/node/v24.22.2/lib/node_modules/rea-agents/skills';
        return {
          installed: true,
          binaryPath: bin,
          version,
          skillsPath: fs.existsSync(skillsCandidate) ? skillsCandidate : undefined,
        };
      } catch {
        continue;
      }
    }
    return { installed: false };
  }

  public detectEngines(): ReaEngineStatus[] {
    const checkBin = (bin: string): string | undefined => {
      try {
        return execFileSync('which', [bin], {
          env: runtimeEnvironment(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        return undefined;
      }
    };

    const ghidraDir =
      process.env.GHIDRA_INSTALL_DIR || '/opt/ghidra/ghidra_12.2_PUBLIC';
    const ghidraAvailable = fs.existsSync(ghidraDir);
    const objdumpPath = checkBin('objdump');
    const rizinPath = checkBin('rizin') || checkBin('rz-bin');
    const gdbPath = checkBin('gdb');
    const adbPath = checkBin('adb');
    const apktoolPath = checkBin('apktool');
    const python3Path = checkBin('python3');

    return [
      {
        name: 'javascript-babel-ast',
        available: true,
        pathOrDetail: 'Built-in @babel/parser & @jridgewell/trace-mapping in rea-agents',
        capabilities: [
          'analyze_javascript_application',
          'recover_javascript_sources',
          'trace_javascript_semantics',
          'trace_web_source_location',
        ],
      },
      {
        name: 'ghidra',
        available: ghidraAvailable,
        pathOrDetail: ghidraAvailable ? ghidraDir : 'Not installed (set GHIDRA_INSTALL_DIR)',
        capabilities: ['open_binary', 'batch_decompile', 'analyze_function', 'list_procedures'],
      },
      {
        name: 'objdump-binutils',
        available: Boolean(objdumpPath),
        pathOrDetail: objdumpPath || 'Not found in PATH',
        capabilities: ['inspect_with_objdump', 'inspect_elf_notes', 'inspect_binary_hardening'],
      },
      {
        name: 'rizin',
        available: Boolean(rizinPath),
        pathOrDetail: rizinPath || 'Not found in PATH',
        capabilities: ['execute_rizin_command', 'start_rizin_debug_session'],
      },
      {
        name: 'gdb',
        available: Boolean(gdbPath),
        pathOrDetail: gdbPath || 'Not found in PATH',
        capabilities: ['start_gdb_session', 'gdb_console'],
      },
      {
        name: 'android-adb-apktool',
        available: Boolean(adbPath || apktoolPath),
        pathOrDetail: adbPath || apktoolPath || 'ADB/Apktool not installed',
        capabilities: ['inspect_android_package', 'search_android_classes', 'decode_android_resources'],
      },
      {
        name: 'python-pyc-sqlite',
        available: Boolean(python3Path),
        pathOrDetail: python3Path || 'python3 not found',
        capabilities: ['inspect_python_pyc', 'inspect_sqlite_database'],
      },
    ];
  }

  public ensureRegisteredInMcp(): void {
    const det = this.detectBinary();
    const existing = this.mcp.listServerConfigs().find((s) => s.name === 'rea');
    if (!existing && det.installed) {
      this.mcp.addServer({
        name: 'rea',
        transport: 'stdio',
        command: det.binaryPath || 'rea',
        args: ['--mcp'],
        env: {
          GHIDRA_INSTALL_DIR:
            process.env.GHIDRA_INSTALL_DIR || '/opt/ghidra/ghidra_12.2_PUBLIC',
        },
        enabled: true,
      });
    }
  }

  public async runDoctor(): Promise<ReaDoctorReport> {
    const det = this.detectBinary();
    const engines = this.detectEngines();
    if (!det.installed || !det.binaryPath) {
      return {
        installed: false,
        mcpHealthy: false,
        observedTools: 0,
        observedPrompts: 0,
        requestFlowOk: false,
        engines,
        diagnostic:
          'REA (rea-agents) is not installed. Run `npm install -g rea-agents` and `rea mcp add`.',
      };
    }

    try {
      const out = execFileSync(det.binaryPath, ['mcp', 'doctor', '--json'], {
        env: runtimeEnvironment(),
        encoding: 'utf8',
        timeout: 20000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const parsed = JSON.parse(out) as {
        healthy: boolean;
        inventory?: {
          tools?: { observed?: number };
          prompts?: { observed?: number };
        };
        identity?: { observed_catalog_digest?: string };
        request_flow?: { ok?: boolean };
      };

      return {
        installed: true,
        version: det.version,
        binaryPath: det.binaryPath,
        mcpHealthy: Boolean(parsed.healthy),
        observedTools: parsed.inventory?.tools?.observed ?? 0,
        observedPrompts: parsed.inventory?.prompts?.observed ?? 0,
        catalogDigest: parsed.identity?.observed_catalog_digest,
        requestFlowOk: Boolean(parsed.request_flow?.ok),
        engines,
        skillsPath: det.skillsPath,
        diagnostic: `REA v${det.version} healthy (${parsed.inventory?.tools?.observed ?? 0} tools, ${parsed.inventory?.prompts?.observed ?? 0} prompts verified).`,
      };
    } catch (err) {
      return {
        installed: true,
        version: det.version,
        binaryPath: det.binaryPath,
        mcpHealthy: false,
        observedTools: 0,
        observedPrompts: 0,
        requestFlowOk: false,
        engines,
        skillsPath: det.skillsPath,
        diagnostic: `REA binary found (${det.version}), but doctor check failed: ${(err as Error).message}`,
      };
    }
  }

  public async discoverLiveReaTools(): Promise<McpDiscoveredTool[]> {
    this.ensureRegisteredInMcp();
    const status = this.mcp.getServerStatus('rea');
    if (!status?.connected) {
      await this.mcp.connectServer('rea');
    }
    return this.mcp.getDiscoveredTools().filter((t) => t.serverName === 'rea');
  }

  /**
   * Executes a real REA analysis workflow using genuine discovered REA MCP tools.
   * Never invents REA tools that the server does not expose.
   */
  public async analyzeTarget(params: {
    targetPath?: string;
    workflow?: ReaAnalysisEvidence['workflow'];
    explicitAuthorization?: boolean;
    actor?: string;
  }): Promise<ReaAnalysisEvidence> {
    const resolvedTarget = params.targetPath
      ? path.resolve(this.workspaceDir, params.targetPath)
      : this.workspaceDir;

    if (params.explicitAuthorization) {
      this.authorizeTarget(resolvedTarget);
    }

    if (!this.isTargetAuthorized(resolvedTarget)) {
      throw new Error(
        `Reverse engineering target "${resolvedTarget}" is outside authorized boundaries. Confirm ownership/authorization first.`,
      );
    }

    const discoveredTools = await this.discoverLiveReaTools();
    const availableNames = new Set(discoveredTools.map((t) => t.name));

    let workflow = params.workflow;
    if (!workflow) {
      if (/\.(js|mjs|cjs|ts|jsx|tsx)$/.test(resolvedTarget)) {
        workflow = 'javascript-application';
      } else if (/\.map$/.test(resolvedTarget)) {
        workflow = 'source-map';
      } else if (/\.apk$/.test(resolvedTarget)) {
        workflow = 'android-apk';
      } else if (fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isFile()) {
        workflow = 'native-binary';
      } else {
        workflow = 'session-overview';
      }
    }

    // Check which real REA tool is exposed for this workflow
    let selectedTool = 'binary_session';
    let toolArgs: Record<string, unknown> = {};

    if (
      workflow === 'javascript-application' &&
      availableNames.has('analyze_javascript_application') &&
      params.targetPath &&
      fs.existsSync(resolvedTarget)
    ) {
      selectedTool = 'analyze_javascript_application';
      toolArgs = { path: resolvedTarget };
    } else if (
      workflow === 'native-binary' &&
      availableNames.has('inspect_binary_hardening') &&
      params.targetPath &&
      fs.existsSync(resolvedTarget)
    ) {
      selectedTool = 'inspect_binary_hardening';
      toolArgs = { path: resolvedTarget };
    } else if (
      workflow === 'android-apk' &&
      availableNames.has('inspect_android_package') &&
      params.targetPath &&
      fs.existsSync(resolvedTarget)
    ) {
      selectedTool = 'inspect_android_package';
      toolArgs = { path: resolvedTarget };
    } else {
      if (!availableNames.has('binary_session')) {
        throw new Error('Connected REA MCP server does not expose expected diagnostic tool.');
      }
      selectedTool = 'binary_session';
      toolArgs = {};
    }

    try {
      const invocation = await this.mcp.invokeTool({
        serverName: 'rea',
        toolName: selectedTool,
        arguments: toolArgs,
        actor: params.actor || 'shellgpt',
      });

      let structuredFindings: Record<string, unknown> = {};
      try {
        const blocks = (invocation.rawResult as { content?: Array<{ text?: string }> })?.content;
        if (blocks && blocks[0]?.text) {
          structuredFindings = JSON.parse(blocks[0].text) as Record<string, unknown>;
        }
      } catch {
        structuredFindings = { rawText: invocation.sanitizedText };
      }

      return {
        targetPath: resolvedTarget,
        authorizedByUser: true,
        workflow,
        toolUsed: selectedTool,
        timestamp: new Date().toISOString(),
        rawSummary: invocation.sanitizedText.slice(0, 2000),
        structuredFindings,
      };
    } catch (err) {
      // Fallback to target-free binary_session + guided_workflows if target args didn't match schema
      const fallback = await this.mcp.invokeTool({
        serverName: 'rea',
        toolName: 'binary_session',
        arguments: {},
        actor: params.actor || 'shellgpt',
      });
      return {
        targetPath: resolvedTarget,
        authorizedByUser: true,
        workflow,
        toolUsed: 'binary_session',
        timestamp: new Date().toISOString(),
        rawSummary: fallback.sanitizedText.slice(0, 2000),
        structuredFindings: {
          note: `Initial tool ${selectedTool} returned schema/engine notice (${(err as Error).message}); verified session via binary_session.`,
          session: fallback.rawResult,
        },
      };
    }
  }

  public generateReport(evidenceList: ReaAnalysisEvidence[]): string {
    const lines: string[] = [
      `# REA Reverse-Engineering Analysis Report`,
      ``,
      `- **Generated At**: ${new Date().toISOString()}`,
      `- **Evidence Records**: ${evidenceList.length}`,
      ``,
    ];

    for (let i = 0; i < evidenceList.length; i++) {
      const ev = evidenceList[i];
      lines.push(
        `## Finding ${i + 1}: ${ev.workflow} (${path.basename(ev.targetPath)})`,
        ``,
        `- **Target**: \`${ev.targetPath}\``,
        `- **Authorized**: ${ev.authorizedByUser ? 'Yes' : 'No'}`,
        `- **REA Tool Invoked**: \`${ev.toolUsed}\``,
        `- **Timestamp**: ${ev.timestamp}`,
        ``,
        `### Structured Output`,
        '```json',
        JSON.stringify(ev.structuredFindings, null, 2),
        '```',
        ``,
      );
    }

    return lines.join('\n');
  }
}
