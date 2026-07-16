const path = require('node:path');

function normalizeWorkspaceRoot(workspaceRoot) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw new Error('workspaceRoot is required');
  }

  return path.resolve(workspaceRoot);
}

function resolveWorkspacePath(workspaceRoot, targetPath = '.') {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const resolved = path.resolve(root, targetPath);
  const relative = path.relative(root, resolved);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path "${targetPath}" is outside the workspace root`);
  }

  return resolved;
}

module.exports = {
  normalizeWorkspaceRoot,
  resolveWorkspacePath,
};

