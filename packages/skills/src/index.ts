import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import YAML from 'yaml';

export interface SkillDefinition {
  name: string;
  namespace: 'workspace' | 'bundled' | 'global' | 'ecosystem';
  description: string;
  version: string;
  enabled: boolean;
  filePath: string;
  agentScope?: string[];
  dependencies?: string[];
  fullContent?: string; // Loaded on-demand via progressive disclosure
}

export const NATIVE_SKILL_CATALOG: Array<{
  name: string;
  description: string;
  instructions: string;
}> = [
  {
    name: 'code-generation',
    description: 'Use when generating new TypeScript, Python, or full-stack modules following project architecture and strict typing.',
    instructions: `# Code Generation Skill\n1. Inspect neighboring modules and tsconfig/package conventions.\n2. Define explicit interfaces and Zod schemas before implementation.\n3. Verify generated files compile and pass unit tests.`,
  },
  {
    name: 'debugging',
    description: 'Use when diagnosing failing tests, runtime exceptions, compilation errors, or unexpected behavior.',
    instructions: `# Debugging Skill\n1. Reproduce the failure and capture exact stack traces.\n2. Formulate a root-cause hypothesis and inspect relevant symbols.\n3. Apply a minimal fix and verify with automated tests.`,
  },
  {
    name: 'code-review',
    description: 'Use when reviewing diffs or pull requests for correctness, security, edge cases, and maintainability.',
    instructions: `# Code Review Skill\n1. Inspect git diff and modified files.\n2. Check permission boundaries, error handling, and type safety.\n3. Report findings ranked by severity with file and line references.`,
  },
  {
    name: 'test-generation',
    description: 'Use when creating deterministic unit, integration, or end-to-end test suites.',
    instructions: `# Test Generation Skill\n1. Identify target functions, edge cases, and failure modes.\n2. Mock external network/API boundaries for deterministic unit tests.\n3. Run the test runner and confirm zero flakiness.`,
  },
  {
    name: 'api-implementation',
    description: 'Use when designing or building REST, GraphQL, JSON-RPC, or SSE streaming endpoints.',
    instructions: `# API Implementation Skill\n1. Validate request payloads and headers with strict schemas.\n2. Implement structured error envelopes and status codes.\n3. Add request timeout, rate-limit, and authentication guards.`,
  },
  {
    name: 'database-migration',
    description: 'Use when creating or migrating SQLite or PostgreSQL schemas and queries.',
    instructions: `# Database Migration Skill\n1. Use idempotent schema migrations and transactions.\n2. Parameterize all SQL queries to prevent SQL injection.\n3. Verify forward migration and data preservation.`,
  },
  {
    name: 'security-auditing',
    description: 'Use when auditing code, permissions, secrets handling, sandboxing, and untrusted input sanitization.',
    instructions: `# Security Auditing Skill\n1. Scan for hardcoded secrets, unsafe shell execution, and path traversal.\n2. Verify untrusted external/MCP data is sanitized against prompt injection.\n3. Confirm child agents never exceed parent permission modes.`,
  },
  {
    name: 'documentation',
    description: 'Use when writing READMEs, architecture references, CLI usage guides, and feature matrices.',
    instructions: `# Documentation Skill\n1. Document real verified commands and configuration options.\n2. Maintain an accurate feature parity matrix with honest statuses.\n3. Include troubleshooting steps for missing credentials or external runtimes.`,
  },
  {
    name: 'devops-deployment',
    description: 'Use when configuring CI/CD workflows, installation scripts, packaging, or container environments.',
    instructions: `# DevOps Deployment Skill\n1. Create reproducible build and test pipelines.\n2. Gate destructive or production deployment steps behind explicit approval.\n3. Verify cross-platform compatibility (Linux, macOS, Windows, WSL).`,
  },
  {
    name: 'git-workflows',
    description: 'Use when managing branches, diffs, worktrees, checkpoints, conflict detection, and safe commits.',
    instructions: `# Git Workflows Skill\n1. Inspect git status and diff before staging changes.\n2. Use isolated Git worktrees for concurrent multi-agent write tasks.\n3. Never overwrite uncommitted user changes or force-push without explicit approval.`,
  },
  {
    name: 'rea-reverse-engineering',
    description: 'Use when performing authorized reverse-engineering analysis on JavaScript bundles, web apps, Android APKs, or native binaries via REA MCP.',
    instructions: `# REA Reverse Engineering Skill\n1. Confirm user ownership/authorization for the target path.\n2. Discover real available tools from the connected REA MCP server.\n3. Capture structured evidence and sanitize untrusted target strings.`,
  },
  {
    name: 'project-planning',
    description: 'Use when breaking down large software-engineering requests into multi-agent task plans and dependency graphs.',
    instructions: `# Project Planning Skill\n1. Analyze user goals and inspect existing repository state.\n2. Partition work into independent tasks with non-overlapping file scopes.\n3. Assign appropriate worker roles (Antigravity for planning/research, Codex for coding/testing) and define verification commands.`,
  },
  {
    name: 'performance-optimization',
    description: 'Use when reducing execution latency, memory usage, I/O bottlenecks, or LLM context token consumption.',
    instructions: `# Performance Optimization Skill\n1. Measure baseline latency and token/memory metrics.\n2. Apply bounded concurrency, caching, or context compaction.\n3. Re-measure and verify no behavioral regressions.`,
  },
];

export class SkillManager {
  private readonly workspaceDir: string;
  private readonly bundledSkillsDir: string;
  private readonly skills = new Map<string, SkillDefinition>();

  constructor(workspaceDir: string = process.cwd()) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.bundledSkillsDir = path.join(this.workspaceDir, 'skills');
    this.ensureBundledSkillsOnDisk();
    this.discoverAll();
  }

  public ensureBundledSkillsOnDisk(): void {
    for (const item of NATIVE_SKILL_CATALOG) {
      const dir = path.join(this.bundledSkillsDir, item.name);
      const skillFile = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          const content = [
            `---`,
            `name: ${item.name}`,
            `description: >-`,
            `  ${item.description}`,
            `version: "1.0.0"`,
            `---`,
            ``,
            item.instructions,
            ``,
          ].join('\n');
          fs.writeFileSync(skillFile, content, 'utf8');
        } catch {
          // Ignore write error if read-only
        }
      }
    }
  }

  private parseSkillFile(
    filePath: string,
    namespace: SkillDefinition['namespace'],
  ): SkillDefinition | undefined {
    if (!fs.existsSync(filePath)) return undefined;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
      let name = path.basename(path.dirname(filePath));
      let description = 'ShellGPT skill workflow';
      let version = '1.0.0';

      if (fmMatch) {
        const parsed = YAML.parse(fmMatch[1]) as Record<string, unknown>;
        if (typeof parsed?.name === 'string') name = parsed.name;
        if (typeof parsed?.description === 'string') description = parsed.description;
        if (typeof parsed?.version === 'string') version = parsed.version;
      }

      return {
        name,
        namespace,
        description: description.replace(/\s+/g, ' ').trim(),
        version,
        enabled: true,
        filePath,
      };
    } catch {
      return undefined;
    }
  }

  public discoverAll(): SkillDefinition[] {
    this.skills.clear();

    const searchRoots: Array<{ dir: string; namespace: SkillDefinition['namespace'] }> = [
      {
        dir: '/usr/local/share/nvm/versions/node/v24.22.2/lib/node_modules/rea-agents/skills',
        namespace: 'ecosystem',
      },
      { dir: path.join(os.homedir(), '.gemini', 'config', 'skills'), namespace: 'global' },
      { dir: this.bundledSkillsDir, namespace: 'bundled' },
      { dir: path.join(this.workspaceDir, '.agents', 'skills'), namespace: 'workspace' },
      { dir: path.join(this.workspaceDir, '.shellgpt', 'skills'), namespace: 'workspace' },
    ];

    for (const root of searchRoots) {
      if (!fs.existsSync(root.dir) || !fs.statSync(root.dir).isDirectory()) continue;
      for (const entry of fs.readdirSync(root.dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(root.dir, entry.name, 'SKILL.md');
        const parsed = this.parseSkillFile(skillMd, root.namespace);
        if (parsed) {
          // Higher priority roots (later in list) override earlier ones
          this.skills.set(parsed.name, parsed);
        }
      }
    }

    return this.listSkills();
  }

  public listSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  public setSkillEnabled(name: string, enabled: boolean): boolean {
    const skill = this.skills.get(name);
    if (!skill) return false;
    skill.enabled = enabled;
    return true;
  }

  /**
   * Progressive disclosure: returns only names and descriptions for prompt injection.
   */
  public getProgressiveDisclosureSummary(): string {
    const active = this.listSkills().filter((s) => s.enabled);
    return active.map((s) => `- ${s.name} (${s.namespace}): ${s.description}`).join('\n');
  }

  /**
   * Loads the full SKILL.md body on demand when a skill is activated.
   */
  public activateSkill(name: string): SkillDefinition | undefined {
    const skill = this.skills.get(name);
    if (!skill || !skill.enabled) return undefined;
    if (!skill.fullContent && fs.existsSync(skill.filePath)) {
      skill.fullContent = fs.readFileSync(skill.filePath, 'utf8');
    }
    return skill;
  }

  public installLocalSkill(params: {
    name: string;
    description: string;
    instructions: string;
  }): SkillDefinition {
    const dir = path.join(this.workspaceDir, '.shellgpt', 'skills', params.name);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'SKILL.md');
    const content = [
      `---`,
      `name: ${params.name}`,
      `description: >-`,
      `  ${params.description}`,
      `version: "1.0.0"`,
      `---`,
      ``,
      params.instructions,
      ``,
    ].join('\n');
    fs.writeFileSync(filePath, content, 'utf8');
    const def: SkillDefinition = {
      name: params.name,
      namespace: 'workspace',
      description: params.description,
      version: '1.0.0',
      enabled: true,
      filePath,
      fullContent: content,
    };
    this.skills.set(params.name, def);
    return def;
  }
}
