const test = require('node:test');
const assert = require('node:assert/strict');

const { createShellTool } = require('../../src/tools/shell-tool');

test('run_command rejects dangerous commands', async () => {
  const tool = createShellTool({ workspaceRoot: process.cwd() });

  await assert.rejects(
    () => tool.run_command({ cmd: 'rm -rf /' }),
    /dangerous command/i,
  );
});

test('run_command executes safe commands in the workspace', async () => {
  const tool = createShellTool({ workspaceRoot: process.cwd() });
  const result = await tool.run_command({ cmd: 'node -p "1 + 1"' });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), '2');
});

