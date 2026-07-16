const fs = require('node:fs/promises');
const path = require('node:path');

const { normalizeWorkspaceRoot, resolveWorkspacePath } = require('../core/workspace');

async function listFilesRecursive(root, currentDir, collected) {
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

function createFileTools({ workspaceRoot }) {
  const root = normalizeWorkspaceRoot(workspaceRoot);

  return {
    async read_file({ path: targetPath }) {
      const filePath = resolveWorkspacePath(root, targetPath);
      return {
        path: targetPath,
        content: await fs.readFile(filePath, 'utf8'),
      };
    },

    async write_file({ path: targetPath, content }) {
      const filePath = resolveWorkspacePath(root, targetPath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf8');

      return {
        path: targetPath,
        bytesWritten: Buffer.byteLength(content, 'utf8'),
      };
    },

    async list_files({ path: targetPath = '.' } = {}) {
      const directoryPath = resolveWorkspacePath(root, targetPath);
      const files = [];
      await listFilesRecursive(root, directoryPath, files);
      files.sort();

      return {
        path: targetPath,
        files,
      };
    },

    async search_code({ query, path: targetPath = '.' }) {
      const directoryPath = resolveWorkspacePath(root, targetPath);
      const files = [];
      await listFilesRecursive(root, directoryPath, files);

      const matches = [];
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

module.exports = {
  createFileTools,
};
