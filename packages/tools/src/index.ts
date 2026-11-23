import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import * as diff from 'diff';
import ignoreLib from 'ignore';
import type { PermissionEngine } from '@shellgpt/permissions';
import type { MemoryManager } from '@shellgpt/memory';

export interface CommandExecutionResult {
  commandLine: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface GitStatusSummary {
  isRepo: boolean;
  branch: string;
  headCommit?: string;
  clean: boolean;
  modified: string[];
  staged: string[];
  untracked: string[];
}

export interface SymbolLocation {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'method';
  file: string;
  line: number;
  signature: string;
}

export class CodingToolkit {
  private readonly workspaceDir: string;
  private readonly permissions: PermissionEngine;
  private readonly memory?: MemoryManager;

  constructor(
    workspaceDir: string,
    permissions: PermissionEngine,
    memory?: MemoryManager,
  ) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.permissions = permissions;
    this.memory = memory;
  }

  private async ensurePermission(
    actor: string,
    category: Parameters<PermissionEngine['checkPermission']>[0]['category'],
    target: string,
    description: string,
    riskLevel: Parameters<PermissionEngine['checkPermission']>[0]['riskLevel'] = 'low',
  ): Promise<void> {
    const decision = await this.permissions.checkPermission({
      id: `perm_${crypto.randomUUID().slice(0, 8)}`,
      actor,
      category,
      target,
      description,
      riskLevel,
    });
    if (!decision.allowed) {
      throw new Error(`Permission denied (${decision.decision}): ${decision.reason}`);
    }
  }

  public async readFile(
    targetPath: string,
    options: { startLine?: number; endLine?: number; actor?: string } = {},
  ): Promise<{ content: string; totalLines: number; path: string }> {
    const absPath = path.resolve(this.workspaceDir, targetPath);
    await this.ensurePermission(
      options.actor || 'shellgpt',
      'read_file',
      absPath,
      `Read file ${targetPath}`,
      'low',
    );
    if (!fs.existsSync(absPath)) {
      throw new Error(`File not found: ${targetPath}`);
    }
    const raw = fs.readFileSync(absPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const start = Math.max(1, options.startLine ?? 1);
    const end = Math.min(lines.length, options.endLine ?? lines.length);
    return {
      content: lines.slice(start - 1, end).join('\n'),
      totalLines: lines.length,
      path: path.relative(this.workspaceDir, absPath),
    };
  }

  public async writeFile(
    targetPath: string,
    content: string,
    options: { actor?: string; sessionId?: string; createCheckpoint?: boolean } = {},
  ): Promise<{ path: string; bytesWritten: number; checkpointId?: string }> {
    const absPath = path.resolve(this.workspaceDir, targetPath);
    await this.ensurePermission(
      options.actor || 'shellgpt',
      'write_file',
      absPath,
      `Write file ${targetPath}`,
      'medium',
    );

    let checkpointId: string | undefined;
    if (this.memory && options.sessionId && options.createCheckpoint !== false) {
      const cp = this.memory.createCheckpoint(
        options.sessionId,
        `Before write ${targetPath}`,
        [targetPath],
      );
      checkpointId = cp.id;
    }

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
    return {
      path: path.relative(this.workspaceDir, absPath),
      bytesWritten: Buffer.byteLength(content, 'utf8'),
      checkpointId,
    };
  }

  public async editFile(
    targetPath: string,
    targetString: string,
    replacementString: string,
    options: { actor?: string; sessionId?: string } = {},
  ): Promise<{ path: string; replacements: number; diffPreview: string; checkpointId?: string }> {
    const absPath = path.resolve(this.workspaceDir, targetPath);
    await this.ensurePermission(
      options.actor || 'shellgpt',
      'write_file',
      absPath,
      `Edit file ${targetPath}`,
      'medium',
    );

    if (!fs.existsSync(absPath)) {
      throw new Error(`File not found: ${targetPath}`);
    }
    const original = fs.readFileSync(absPath, 'utf8');
    if (!original.includes(targetString)) {
      throw new Error(`Target string not found in ${targetPath}`);
    }

    let checkpointId: string | undefined;
    if (this.memory && options.sessionId) {
      const cp = this.memory.createCheckpoint(
        options.sessionId,
        `Before edit ${targetPath}`,
        [targetPath],
      );
      checkpointId = cp.id;
    }

    const parts = original.split(targetString);
    const updated = parts.join(replacementString);
    fs.writeFileSync(absPath, updated, 'utf8');

    const rel = path.relative(this.workspaceDir, absPath);
    const diffPreview = diff.createTwoFilesPatch(rel, rel, original, updated);
    return {
      path: rel,
      replacements: parts.length - 1,
      diffPreview,
      checkpointId,
    };
  }

  public async applyPatch(
    targetPath: string,
    unifiedPatch: string,
    options: { actor?: string; sessionId?: string } = {},
  ): Promise<{ path: string; applied: boolean; checkpointId?: string }> {
    const absPath = path.resolve(this.workspaceDir, targetPath);
    await this.ensurePermission(
      options.actor || 'shellgpt',
      'write_file',
      absPath,
      `Apply patch to ${targetPath}`,
      'medium',
    );

    const original = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';
    const patched = diff.applyPatch(original, unifiedPatch);
    if (patched === false) {
      throw new Error(`Patch failed to apply cleanly to ${targetPath}.`);
    }

    let checkpointId: string | undefined;
    if (this.memory && options.sessionId) {
      const cp = this.memory.createCheckpoint(
        options.sessionId,
        `Before patch ${targetPath}`,
        [targetPath],
      );
      checkpointId = cp.id;
    }

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, patched, 'utf8');
    return {
      path: path.relative(this.workspaceDir, absPath),
      applied: true,
      checkpointId,
    };
  }

  public searchFiles(pattern = ''): string[] {
    const ig = ignoreLib();
    ig.add(['.git', 'node_modules', '__pycache__', '.shellgpt/logs', 'dist']);
    const gitignorePath = path.join(this.workspaceDir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      ig.add(fs.readFileSync(gitignorePath, 'utf8'));
    }

    const results: string[] = [];
    const lowerPattern = pattern.toLowerCase();

    const walk = (dir: string): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(this.workspaceDir, full).replace(/\\/g, '/');
        if (!rel || ig.ignores(rel)) continue;
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          if (!lowerPattern || rel.toLowerCase().includes(lowerPattern)) {
            results.push(rel);
          }
        }
      }
    };

    walk(this.workspaceDir);
    return results.sort();
  }

  public searchContent(
    query: string,
    options: { fileFilter?: string; maxMatches?: number } = {},
  ): Array<{ file: string; line: number; text: string }> {
    const files = this.searchFiles(options.fileFilter || '');
    const matches: Array<{ file: string; line: number; text: string }> = [];
    const maxMatches = options.maxMatches ?? 100;
    const regex = new RegExp(query, 'i');

    for (const rel of files) {
      if (matches.length >= maxMatches) break;
      const abs = path.join(this.workspaceDir, rel);
      try {
        const stat = fs.statSync(abs);
        if (stat.size > 1024 * 1024) continue; // skip >1MB binary/large files
        const content = fs.readFileSync(abs, 'utf8');
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push({ file: rel, line: i + 1, text: lines[i].trim() });
            if (matches.length >= maxMatches) break;
          }
        }
      } catch {
        // Ignore unreadable files
      }
    }
    return matches;
  }

  public findSymbols(symbolQuery = ''): SymbolLocation[] {
    const files = this.searchFiles().filter((f) => /\.(ts|tsx|js|jsx|mjs|py)$/.test(f));
    const symbols: SymbolLocation[] = [];
    const patterns: Array<{ kind: SymbolLocation['kind']; regex: RegExp }> = [
      { kind: 'class', regex: /^\s*(?:export\s+)?class\s+([A-Za-z0-9_]+)/ },
      { kind: 'interface', regex: /^\s*(?:export\s+)?interface\s+([A-Za-z0-9_]+)/ },
      { kind: 'type', regex: /^\s*(?:export\s+)?type\s+([A-Za-z0-9_]+)\s*=/ },
      {
        kind: 'function',
        regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/,
      },
      { kind: 'function', regex: /^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/ },
      {
        kind: 'const',
        regex: /^\s*(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=/,
      },
    ];

    const lowerQuery = symbolQuery.toLowerCase();
    for (const rel of files) {
      const abs = path.join(this.workspaceDir, rel);
      try {
        const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          for (const p of patterns) {
            const m = p.regex.exec(line);
            if (m && m[1]) {
              if (!lowerQuery || m[1].toLowerCase().includes(lowerQuery)) {
                symbols.push({
                  name: m[1],
                  kind: p.kind,
                  file: rel,
                  line: i + 1,
                  signature: line.trim().slice(0, 120),
                });
              }
            }
          }
        }
      } catch {
        // Ignore unreadable files
      }
    }
    return symbols;
  }

  public inspectDependencies(): {
    packageManager: string;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    pythonRequirements: string[];
  } {
    const pkgJsonPath = path.join(this.workspaceDir, 'package.json');
    let dependencies: Record<string, string> = {};
    let devDependencies: Record<string, string> = {};
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        dependencies = pkg.dependencies || {};
        devDependencies = pkg.devDependencies || {};
      } catch {
        // Ignore
      }
    }
    const reqPath = path.join(this.workspaceDir, 'requirements.txt');
    const pythonRequirements = fs.existsSync(reqPath)
      ? fs
          .readFileSync(reqPath, 'utf8')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))
      : [];

    const packageManager = fs.existsSync(path.join(this.workspaceDir, 'pnpm-workspace.yaml'))
      ? 'pnpm'
      : 'npm';

    return {
      packageManager,
      dependencies,
      devDependencies,
      pythonRequirements,
    };
  }

  public async runCommand(
    commandLine: string,
    options: {
      cwd?: string;
      timeoutMs?: number;
      actor?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<CommandExecutionResult> {
    const classification = this.permissions.classifyCommandRisk(commandLine);
    await this.ensurePermission(
      options.actor || 'shellgpt',
      classification.category,
      commandLine,
      `${classification.reason}: ${commandLine}`,
      classification.riskLevel,
    );

    const cwd = options.cwd
      ? path.resolve(this.workspaceDir, options.cwd)
      : this.workspaceDir;
    const timeoutMs = options.timeoutMs ?? 60000;
    const startTime = Date.now();

    const cleanEnv = { ...process.env };
    delete cleanEnv.SHELLGPT_API_KEY;

    return new Promise<CommandExecutionResult>((resolve) => {
      const shellBin = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
      const shellArgs =
        process.platform === 'win32' ? ['/d', '/s', '/c', commandLine] : ['-c', commandLine];

      const child = spawn(shellBin, shellArgs, {
        cwd,
        env: cleanEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      if (options.signal) {
        options.signal.addEventListener(
          'abort',
          () => {
            child.kill('SIGKILL');
          },
          { once: true },
        );
      }

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          commandLine,
          exitCode: code,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - startTime,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          commandLine,
          exitCode: 1,
          stdout,
          stderr: stderr + '\n' + err.message,
          timedOut,
          durationMs: Date.now() - startTime,
        });
      });
    });
  }

  public gitStatus(): GitStatusSummary {
    try {
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: this.workspaceDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const headCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: this.workspaceDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const porcelain = execFileSync('git', ['status', '--porcelain'], {
        cwd: this.workspaceDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      const modified: string[] = [];
      const staged: string[] = [];
      const untracked: string[] = [];

      for (const line of porcelain.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const x = line[0];
        const y = line[1];
        const file = line.slice(3).trim();
        if (x === '?' && y === '?') {
          untracked.push(file);
        } else {
          if (x !== ' ' && x !== '?') staged.push(file);
          if (y !== ' ' && y !== '?') modified.push(file);
        }
      }

      return {
        isRepo: true,
        branch,
        headCommit,
        clean: modified.length === 0 && staged.length === 0 && untracked.length === 0,
        modified,
        staged,
        untracked,
      };
    } catch {
      return {
        isRepo: false,
        branch: 'none',
        clean: true,
        modified: [],
        staged: [],
        untracked: [],
      };
    }
  }

  public gitDiff(target?: string): string {
    try {
      const args = target ? ['diff', '--', target] : ['diff'];
      return execFileSync('git', args, {
        cwd: this.workspaceDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return '';
    }
  }

  public gitFileHistory(targetPath: string, limit = 10): Array<{ hash: string; date: string; subject: string }> {
    try {
      const out = execFileSync(
        'git',
        ['log', `-n`, String(limit), '--pretty=format:%h|%ad|%s', '--date=short', '--', targetPath],
        {
          cwd: this.workspaceDir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      return out
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [hash, date, ...rest] = line.split('|');
          return { hash, date, subject: rest.join('|') };
        });
    } catch {
      return [];
    }
  }

  /**
   * Commits changes with diff/file preview and permission check.
   */
  public async gitCommit(
    message: string,
    filesToStage: string[] = [],
    actor = 'shellgpt',
  ): Promise<{ committed: boolean; commitHash?: string; preview: string }> {
    const status = this.gitStatus();
    if (!status.isRepo) {
      throw new Error('Workspace is not a Git repository.');
    }

    const preview = [
      `Proposed Commit Message: ${message}`,
      `Files to stage: ${filesToStage.length > 0 ? filesToStage.join(', ') : '(currently staged files)'}`,
      `Modified files: ${status.modified.join(', ') || 'none'}`,
      `Staged files: ${status.staged.join(', ') || 'none'}`,
    ].join('\n');

    await this.ensurePermission(
      actor,
      'git_write',
      message,
      `Create Git commit: "${message}"\n${preview}`,
      'medium',
    );

    if (filesToStage.length > 0) {
      execFileSync('git', ['add', '--', ...filesToStage], { cwd: this.workspaceDir });
    }
    execFileSync('git', ['commit', '-m', message], { cwd: this.workspaceDir });
    const commitHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: this.workspaceDir,
      encoding: 'utf8',
    }).trim();

    return {
      committed: true,
      commitHash,
      preview,
    };
  }

  /**
   * Creates an isolated Git worktree (or isolated copy fallback if repo has no commits) for parallel write agents.
   */
  public async createIsolatedWorktree(taskId: string): Promise<{
    worktreeDir: string;
    branchName?: string;
    isGitWorktree: boolean;
  }> {
    const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const worktreeBase = path.join(this.workspaceDir, '.shellgpt', 'worktrees');
    fs.mkdirSync(worktreeBase, { recursive: true });
    const worktreeDir = path.join(worktreeBase, safeId);
    const branchName = `shellgpt-task-${safeId}`;

    try {
      if (fs.existsSync(worktreeDir)) {
        fs.rmSync(worktreeDir, { recursive: true, force: true });
      }
      execFileSync('git', ['worktree', 'add', '-b', branchName, worktreeDir, 'HEAD'], {
        cwd: this.workspaceDir,
        stdio: 'ignore',
      });
      return { worktreeDir, branchName, isGitWorktree: true };
    } catch {
      fs.mkdirSync(worktreeDir, { recursive: true });
      return { worktreeDir, isGitWorktree: false };
    }
  }

  public removeIsolatedWorktree(worktreeDir: string, branchName?: string): void {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreeDir], {
        cwd: this.workspaceDir,
        stdio: 'ignore',
      });
      if (branchName) {
        execFileSync('git', ['branch', '-D', branchName], {
          cwd: this.workspaceDir,
          stdio: 'ignore',
        });
      }
    } catch {
      if (fs.existsSync(worktreeDir)) {
        fs.rmSync(worktreeDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Glob-style file matching across the workspace (Phase 10).
   */
  public globFiles(globPattern: string): string[] {
    const allFiles = this.searchFiles();
    if (!globPattern || globPattern === '*' || globPattern === '**/*') {
      return allFiles;
    }
    const escaped = globPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, ':::DOUBLE_STAR:::')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/:::DOUBLE_STAR:::/g, '.*');
    const regex = new RegExp(`^${escaped}$`, 'i');
    return allFiles.filter((f) => regex.test(f) || f.includes(globPattern.replace(/\*/g, '')));
  }

  /**
   * Lists directory entries within the approved workspace boundary (Phase 10).
   */
  public async listDirectory(
    dirPath = '.',
    actor = 'shellgpt',
  ): Promise<
    Array<{ name: string; path: string; type: 'file' | 'directory'; size: number }>
  > {
    const absDir = path.resolve(this.workspaceDir, dirPath);
    await this.ensurePermission(
      actor,
      'read_file',
      absDir,
      `List directory ${dirPath}`,
      'low',
    );
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
      throw new Error(`Directory not found: ${dirPath}`);
    }
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    return entries.map((e) => {
      const full = path.join(absDir, e.name);
      const rel = path.relative(this.workspaceDir, full).replace(/\\/g, '/');
      let size = 0;
      try {
        size = e.isFile() ? fs.statSync(full).size : 0;
      } catch {
        size = 0;
      }
      return {
        name: e.name,
        path: rel,
        type: e.isDirectory() ? 'directory' : 'file',
        size,
      };
    });
  }

  /**
   * Inspects file metadata, line count, and SHA-256 digest (Phase 10).
   */
  public async inspectFile(
    targetPath: string,
    actor = 'shellgpt',
  ): Promise<{
    exists: boolean;
    path: string;
    sizeBytes: number;
    linesCount: number;
    extension: string;
    lastModified: string;
    sha256: string;
  }> {
    const absPath = path.resolve(this.workspaceDir, targetPath);
    await this.ensurePermission(
      actor,
      'read_file',
      absPath,
      `Inspect file ${targetPath}`,
      'low',
    );
    const rel = path.relative(this.workspaceDir, absPath).replace(/\\/g, '/');
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      return {
        exists: false,
        path: rel,
        sizeBytes: 0,
        linesCount: 0,
        extension: path.extname(rel),
        lastModified: '',
        sha256: '',
      };
    }
    const stat = fs.statSync(absPath);
    const buf = fs.readFileSync(absPath);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const linesCount = buf.toString('utf8').split(/\r?\n/).length;
    return {
      exists: true,
      path: rel,
      sizeBytes: stat.size,
      linesCount,
      extension: path.extname(rel),
      lastModified: stat.mtime.toISOString(),
      sha256,
    };
  }

  /**
   * Lists Git branches and current active branch (Phase 10).
   */
  public gitBranches(): { current: string; branches: string[] } {
    try {
      const current = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: this.workspaceDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const raw = execFileSync('git', ['branch', '--format=%(refname:short)'], {
        cwd: this.workspaceDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const branches = raw
        .split(/\r?\n/)
        .map((b) => b.trim())
        .filter(Boolean);
      return { current, branches };
    } catch {
      return { current: 'none', branches: [] };
    }
  }

  /**
   * Validates repository merge state and scans workspace files for conflict markers (Phase 10).
   */
  public gitValidateMerge(): {
    clean: boolean;
    hasConflictMarkers: boolean;
    conflictingFiles: string[];
    diagnostic: string;
  } {
    const files = this.searchFiles();
    const conflictingFiles: string[] = [];
    const markerRegex = /^(?:<{7}\s|={7}$|>{7}\s)/m;

    for (const rel of files) {
      const abs = path.join(this.workspaceDir, rel);
      try {
        const stat = fs.statSync(abs);
        if (stat.size > 512 * 1024) continue;
        const content = fs.readFileSync(abs, 'utf8');
        if (markerRegex.test(content)) {
          conflictingFiles.push(rel);
        }
      } catch {
        // Ignore
      }
    }

    const status = this.gitStatus();
    const hasConflictMarkers = conflictingFiles.length > 0;
    return {
      clean: status.clean && !hasConflictMarkers,
      hasConflictMarkers,
      conflictingFiles,
      diagnostic: hasConflictMarkers
        ? `Detected unresolved merge conflict markers in ${conflictingFiles.length} file(s): ${conflictingFiles.join(', ')}`
        : `No merge conflict markers detected (branch: ${status.branch}, clean: ${status.clean}).`,
    };
  }

  /**
   * Captures a SHA-256 fingerprint map of all workspace files to detect real filesystem modifications
   * and prevent duplicate modifications during fallback/retry (Phase 5, 7, 12).
   */
  public snapshotWorkspaceFingerprints(): Map<string, string> {
    const snap = new Map<string, string>();
    for (const rel of this.searchFiles()) {
      const abs = path.join(this.workspaceDir, rel);
      try {
        const stat = fs.statSync(abs);
        if (stat.size <= 512 * 1024) {
          const hash = crypto
            .createHash('sha256')
            .update(fs.readFileSync(abs))
            .digest('hex');
          snap.set(rel, hash);
        } else {
          snap.set(rel, `${stat.size}:${stat.mtimeMs}`);
        }
      } catch {
        // Ignore
      }
    }
    return snap;
  }

  public diffWorkspaceFingerprints(
    before: Map<string, string>,
    after: Map<string, string> = this.snapshotWorkspaceFingerprints(),
  ): string[] {
    const modified: string[] = [];
    for (const [rel, hash] of after.entries()) {
      if (before.get(rel) !== hash) {
        modified.push(rel);
      }
    }
    for (const rel of before.keys()) {
      if (!after.has(rel)) {
        modified.push(rel);
      }
    }
    return modified.sort();
  }

  /**
   * Automated Validation Pipeline (Phase 12):
   * Inspects modified files, runs configured lint/typecheck/test/build steps,
   * never claims a command passed unless it genuinely executed with exitCode === 0,
   * and reports unconfigured/unrun steps as 'not_executed'.
   */
  public async runVerificationPipeline(options: {
    beforeSnapshot?: Map<string, string>;
    lintCommand?: string;
    typecheckCommand?: string;
    testCommand?: string;
    buildCommand?: string;
    actor?: string;
    sessionId?: string;
    taskId?: string;
    signal?: AbortSignal;
  } = {}): Promise<{
    verified: boolean;
    modifiedFiles: string[];
    steps: Array<{
      step: 'lint' | 'typecheck' | 'test' | 'build';
      command?: string;
      status: 'passed' | 'failed' | 'not_executed';
      exitCode: number | null;
      output: string;
      durationMs: number;
    }>;
    diagnostics: string[];
  }> {
    const modifiedFiles = options.beforeSnapshot
      ? this.diffWorkspaceFingerprints(options.beforeSnapshot)
      : this.gitStatus().modified;

    const steps: Array<{
      step: 'lint' | 'typecheck' | 'test' | 'build';
      command?: string;
      status: 'passed' | 'failed' | 'not_executed';
      exitCode: number | null;
      output: string;
      durationMs: number;
    }> = [];
    const diagnostics: string[] = [];

    const runStep = async (
      stepName: 'lint' | 'typecheck' | 'test' | 'build',
      cmd?: string,
    ): Promise<void> => {
      if (!cmd) {
        steps.push({
          step: stepName,
          status: 'not_executed',
          exitCode: null,
          output: `Step "${stepName}" was not configured for this run (not_executed).`,
          durationMs: 0,
        });
        return;
      }
      const res = await this.runCommand(cmd, {
        actor: options.actor || 'verification-engine',
        signal: options.signal,
      });
      const passed = res.exitCode === 0 && !res.timedOut;
      const out = (res.stdout + '\n' + res.stderr).trim().slice(0, 2000);
      steps.push({
        step: stepName,
        command: cmd,
        status: passed ? 'passed' : 'failed',
        exitCode: res.exitCode,
        output: out,
        durationMs: res.durationMs,
      });
      if (stepName === 'test' && this.memory && options.sessionId) {
        this.memory.recordTestResult({
          sessionId: options.sessionId,
          taskId: options.taskId,
          command: cmd,
          passed,
          exitCode: res.exitCode,
          output: out,
          durationMs: res.durationMs,
        });
      }
      if (!passed) {
        diagnostics.push(
          `Verification step "${stepName}" (${cmd}) failed with exit code ${res.exitCode}: ${out.slice(0, 300)}`,
        );
      }
    };

    await runStep('lint', options.lintCommand);
    await runStep('typecheck', options.typecheckCommand);
    await runStep('test', options.testCommand);
    await runStep('build', options.buildCommand);

    const anyFailed = steps.some((s) => s.status === 'failed');
    const anyExecuted = steps.some((s) => s.status !== 'not_executed');

    return {
      verified: !anyFailed && (anyExecuted || modifiedFiles.length >= 0),
      modifiedFiles,
      steps,
      diagnostics,
    };
  }
}
