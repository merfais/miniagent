import fs from 'node:fs/promises';
import path from 'node:path';

import { normalizeWorkspaceRoot, resolveWorkspacePath } from '../core/workspace';

async function listFilesRecursive(
  root: string,
  currentDir: string,
  collected: string[],
): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }

    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await listFilesRecursive(root, absolutePath, collected);
      continue;
    }

    collected.push(path.relative(root, absolutePath));
  }
}

export function createFileTools({ workspaceRoot }: { workspaceRoot: string }) {
  const root = normalizeWorkspaceRoot(workspaceRoot);

  return {
    async read_file({ path: targetPath }: { path: string }) {
      const filePath = resolveWorkspacePath(root, targetPath);
      return {
        path: targetPath,
        content: await fs.readFile(filePath, 'utf8'),
      };
    },

    async write_file({ path: targetPath, content }: { path: string; content: string }) {
      const filePath = resolveWorkspacePath(root, targetPath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf8');

      return {
        path: targetPath,
        bytesWritten: Buffer.byteLength(content, 'utf8'),
      };
    },

    async list_files({ path: targetPath = '.' }: { path?: string } = {}) {
      const directoryPath = resolveWorkspacePath(root, targetPath);
      const files: string[] = [];
      await listFilesRecursive(root, directoryPath, files);
      files.sort();

      return {
        path: targetPath,
        files,
      };
    },

    async search_code({ query, path: targetPath = '.' }: { query: string; path?: string }) {
      const directoryPath = resolveWorkspacePath(root, targetPath);
      const files: string[] = [];
      await listFilesRecursive(root, directoryPath, files);

      const matches: Array<{ path: string; line: number; content: string }> = [];
      for (const relativePath of files) {
        const absolutePath = resolveWorkspacePath(root, relativePath);
        const content = await fs.readFile(absolutePath, 'utf8');
        const lines = content.split(/\r?\n/);

        lines.forEach((lineContent, index) => {
          if (lineContent.includes(query)) {
            matches.push({
              path: relativePath,
              line: index + 1,
              content: lineContent,
            });
          }
        });
      }

      return {
        query,
        matches,
      };
    },
  };
}
