import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { normalizeWorkspaceRoot, resolveWorkspacePath } from '../core/workspace.js';

const execFileAsync = promisify(execFile);

const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+-rf\s+\//i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  />\s*\/dev\//i,
];

interface ExecErrorLike {
  stdout?: string;
  stderr?: string;
  message?: string;
  code?: number | string;
}

export function assertSafeCommand(cmd: string): void {
  if (typeof cmd !== 'string' || cmd.trim() === '') {
    throw new Error('Command is required');
  }

  const matchedPattern = DANGEROUS_COMMAND_PATTERNS.find((pattern) => pattern.test(cmd));
  if (matchedPattern) {
    throw new Error(`Dangerous command rejected: ${cmd}`);
  }
}

export function createShellTool({ workspaceRoot }: { workspaceRoot: string }) {
  const root = normalizeWorkspaceRoot(workspaceRoot);

  return {
    async run_command({ cmd, cwd }: { cmd?: string; cwd?: string } = {}) {
      assertSafeCommand(cmd as string);
      const workingDirectory = cwd ? resolveWorkspacePath(root, cwd) : root;

      try {
        const { stdout, stderr } = await execFileAsync('bash', ['-lc', cmd as string], {
          cwd: workingDirectory,
          maxBuffer: 1024 * 1024,
        });

        return {
          stdout,
          stderr,
          exitCode: 0,
        };
      } catch (error) {
        const execError = error as ExecErrorLike;
        return {
          stdout: execError.stdout || '',
          stderr: execError.stderr || execError.message || '',
          exitCode: typeof execError.code === 'number' ? execError.code : 1,
        };
      }
    },
  };
}
