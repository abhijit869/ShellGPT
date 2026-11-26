import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface ClaudeAdapterStatus {
  enabled: boolean;
  installed: boolean;
  symlinkPresent: boolean;
  binaryPath?: string;
  symlinkTarget?: string;
  diagnostic: string;
}

export class ClaudeAdapter {
  private readonly enabled: boolean;
  private readonly binaryHint: string;
  private readonly defaultModel: string;

  constructor(options: { enabled?: boolean; binaryPath?: string; defaultModel?: string } = {}) {
    this.enabled = options.enabled ?? false;
    this.binaryHint = process.env.CLAUDE_BIN || options.binaryPath || 'claude';
    this.defaultModel =
      process.env.CLAUDE_MODEL || options.defaultModel || 'claude-sonnet-5-5';
  }

  public getStatus(): ClaudeAdapterStatus {
    const candidates = [
      this.binaryHint,
      '/home/codespace/.local/bin/claude',
      '/usr/local/bin/claude',
    ];

    for (const c of candidates) {
      if (path.isAbsolute(c)) {
        try {
          const lstat = fs.lstatSync(c);
          if (lstat.isSymbolicLink()) {
            const target = fs.readlinkSync(c);
            const exists = fs.existsSync(c);
            return {
              enabled: this.enabled,
              installed: true,
              symlinkPresent: true,
              binaryPath: c,
              symlinkTarget: target,
              diagnostic: exists
                ? `Claude Code CLI installed at ${c} (enabled=${this.enabled}).`
                : `Claude Code symlink at ${c} -> ${target} (target unmounted in sandbox; enabled=${this.enabled}).`,
            };
          }
          if (lstat.isFile()) {
            return {
              enabled: this.enabled,
              installed: true,
              symlinkPresent: false,
              binaryPath: c,
              diagnostic: `Claude Code CLI installed at ${c} (enabled=${this.enabled}).`,
            };
          }
        } catch {
          continue;
        }
      } else {
        try {
          const found = execFileSync('which', [c], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
          if (found) {
            return {
              enabled: this.enabled,
              installed: true,
              symlinkPresent: false,
              binaryPath: found,
              diagnostic: `Claude Code CLI installed at ${found} (enabled=${this.enabled}).`,
            };
          }
        } catch {
          continue;
        }
      }
    }

    return {
      enabled: this.enabled,
      installed: false,
      symlinkPresent: false,
      diagnostic: 'Optional Claude Code adapter is not installed (disabled by default).',
    };
  }
}
