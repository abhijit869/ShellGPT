import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillManager } from '@shellgpt/skills';
import type { HookEngine } from '@shellgpt/hooks';
import type { McpManager } from '@shellgpt/mcp';

export interface PluginManifest {
  id: string;
  name: string;
  author?: string | { name: string; url?: string };
  homepage?: string;
  repository?: string | { type: string; url: string };
  disabled?: boolean;
  directory: string;
  enabled: boolean;
  skillsCount: number;
  hasRules: boolean;
  hasHooks: boolean;
  hasMcpConfig: boolean;
}

export class PluginManager {
  private readonly workspaceDir: string;
  private readonly plugins = new Map<string, PluginManifest>();
  private readonly configOverrides: Record<string, { enabled: boolean }>;

  constructor(
    workspaceDir: string = process.cwd(),
    configOverrides: Record<string, { enabled: boolean }> = {},
  ) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.configOverrides = configOverrides;
    this.discoverPlugins();
  }

  public discoverPlugins(): PluginManifest[] {
    this.plugins.clear();
    const roots = [
      path.join(this.workspaceDir, '.agents', 'plugins'),
      path.join(this.workspaceDir, '.shellgpt', 'plugins'),
    ];

    for (const root of roots) {
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pluginDir = path.join(root, entry.name);
        const manifestFile = path.join(pluginDir, 'plugin.json');
        if (!fs.existsSync(manifestFile)) continue;

        try {
          const raw = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<
            string,
            unknown
          >;
          const id = entry.name;
          const override = this.configOverrides[id];
          const defaultEnabled = raw.disabled !== true;
          const enabled = override !== undefined ? override.enabled : defaultEnabled;

          const skillsDir = path.join(pluginDir, 'skills');
          let skillsCount = 0;
          if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
            skillsCount = fs
              .readdirSync(skillsDir, { withFileTypes: true })
              .filter(
                (d) =>
                  d.isDirectory() &&
                  fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md')),
              ).length;
          }

          const hasRules =
            fs.existsSync(path.join(pluginDir, 'rules', 'AGENTS.md')) ||
            fs.existsSync(path.join(pluginDir, 'rules', 'GEMINI.md'));
          const hasHooks = fs.existsSync(path.join(pluginDir, 'hooks.json'));
          const hasMcpConfig = fs.existsSync(path.join(pluginDir, 'mcp_config.json'));

          this.plugins.set(id, {
            id,
            name: typeof raw.name === 'string' ? raw.name : id,
            author: raw.author as PluginManifest['author'],
            homepage: typeof raw.homepage === 'string' ? raw.homepage : undefined,
            repository: raw.repository as PluginManifest['repository'],
            disabled: Boolean(raw.disabled),
            directory: pluginDir,
            enabled,
            skillsCount,
            hasRules,
            hasHooks,
            hasMcpConfig,
          });
        } catch {
          // Ignore invalid plugin manifest
        }
      }
    }

    return this.listPlugins();
  }

  public listPlugins(): PluginManifest[] {
    return Array.from(this.plugins.values());
  }

  public setPluginEnabled(id: string, enabled: boolean): boolean {
    const plugin = this.plugins.get(id);
    if (!plugin) return false;
    plugin.enabled = enabled;
    this.configOverrides[id] = { enabled };
    return true;
  }

  public ingestActivePlugins(deps: {
    skills?: SkillManager;
    hooks?: HookEngine;
    mcp?: McpManager;
  }): void {
    for (const plugin of this.plugins.values()) {
      if (!plugin.enabled) continue;
      if (plugin.hasMcpConfig && deps.mcp) {
        const mcpFile = path.join(plugin.directory, 'mcp_config.json');
        try {
          deps.mcp.importConfig(fs.readFileSync(mcpFile, 'utf8'));
        } catch {
          // Ignore
        }
      }
      if (plugin.hasHooks && deps.hooks) {
        const hooksFile = path.join(plugin.directory, 'hooks.json');
        try {
          const parsed = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as Record<
            string,
            Record<string, unknown>
          >;
          for (const [hName, hCfg] of Object.entries(parsed)) {
            deps.hooks.registerHook(`${plugin.id}:${hName}`, hCfg, {
              baseDir: plugin.directory,
            });
          }
        } catch {
          // Ignore
        }
      }
    }
  }
}
