import path from 'node:path';

// 全项目共享的工作区根：默认当前进程工作目录，运行时可由 switchWorkspace 切换。
// 工具在每次调用时读取此全局（而非工厂构造时快照），故切换后续调用即时生效。
let workspaceRoot = path.resolve(process.cwd());

// runtimeRoot：agent 服务启动、读写自身系统文件（配置、日志、会话存储、runtime.json）的目录。
// 与 workspaceRoot（agent 操作对象的空间）语义不同；进程启动即固定，不可修改。
export const runtimeRoot = path.resolve(process.cwd());

export function getWorkspaceRoot(): string {
  return workspaceRoot;
}

export function switchWorkspace(root: string): void {
  if (!root || typeof root !== 'string') {
    throw new Error('workspaceRoot is required');
  }
  workspaceRoot = path.resolve(root);
}

export function resolveWorkspacePath(targetPath = '.'): string {
  const root = workspaceRoot;
  const resolved = path.resolve(root, targetPath);
  const relative = path.relative(root, resolved);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path "${targetPath}" is outside the workspace root`);
  }

  return resolved;
}
