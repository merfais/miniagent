import path from 'node:path';

export function normalizeWorkspaceRoot(workspaceRoot: string): string {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw new Error('workspaceRoot is required');
  }

  return path.resolve(workspaceRoot);
}

export function resolveWorkspacePath(
  workspaceRoot: string,
  targetPath = '.',
): string {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const resolved = path.resolve(root, targetPath);
  const relative = path.relative(root, resolved);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path "${targetPath}" is outside the workspace root`);
  }

  return resolved;
}
