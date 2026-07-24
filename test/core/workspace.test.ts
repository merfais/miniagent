import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { normalizeWorkspaceRoot, resolveWorkspacePath } from '../../src/core/workspace.js';

test('normalizeWorkspaceRoot resolves an absolute workspace path', () => {
  assert.equal(normalizeWorkspaceRoot('.'), path.resolve('.'));
});

test('resolveWorkspacePath rejects paths outside the workspace', () => {
  assert.throws(
    () => resolveWorkspacePath('/tmp/workspace', '../escape'),
    /outside the workspace root/,
  );
});
