const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { normalizeWorkspaceRoot, resolveWorkspacePath } = require('../core/workspace');

const execFileAsync = promisify(execFile);

const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+-rf\s+\//i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  />\s*\/dev\//i,
];

function assertSafeCommand(cmd) {
  if (typeof cmd !== 'string' || cmd.trim() === '') {
    throw new Error('Command is required');
  }

  const matchedPattern = DANGEROUS_COMMAND_PATTERNS.find((pattern) => pattern.test(cmd));
  if (matchedPattern) {
    throw new Error(`Dangerous command rejected: ${cmd}`);
  }
}

function createShellTool({ workspaceRoot }) {
  const root = normalizeWorkspaceRoot(workspaceRoot);

  return {
    async run_command({ cmd, cwd } = {}) {
      assertSafeCommand(cmd);
      const workingDirectory = cwd ? resolveWorkspacePath(root, cwd) : root;

      try {
        const { stdout, stderr } = await execFileAsync('bash', ['-lc', cmd], {
          cwd: workingDirectory,
          maxBuffer: 1024 * 1024,
        });

        return {
          stdout,
          stderr,
          exitCode: 0,
        };
      } catch (error) {
        return {
          stdout: error.stdout || '',
          stderr: error.stderr || error.message,
          exitCode: typeof error.code === 'number' ? error.code : 1,
        };
      }
    },
  };
}

module.exports = {
  assertSafeCommand,
  createShellTool,
};

