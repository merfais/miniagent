import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createFileTools } from '../../src/tools/file-tools';

test('read_file and write_file stay inside the workspace root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-files-'));
  const tools = createFileTools({ workspaceRoot: root });
  const filePath = 'notes/todo.txt';

  await tools.write_file({ path: filePath, content: 'hello' });
  const result = await tools.read_file({ path: filePath });

  assert.equal(result.path, filePath);
  assert.match(result.content, /hello/);
  await assert.rejects(
    () => tools.read_file({ path: '../outside.txt' }),
    /outside the workspace/i,
  );
});

test('list_files returns relative file paths and search_code finds matches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-search-'));
  const tools = createFileTools({ workspaceRoot: root });

  await tools.write_file({ path: 'src/example.js', content: 'const answer = 42;\n' });
  await tools.write_file({ path: 'README.md', content: 'MiniAgent\n' });

  const listed = await tools.list_files({ path: '.' });
  assert.deepEqual(listed.files.sort(), ['README.md', 'src/example.js'].sort());

  const matches = await tools.search_code({ query: 'answer', path: '.' });
  assert.equal(matches.matches.length, 1);
  assert.equal(matches.matches[0]?.path, 'src/example.js');
  assert.equal(matches.matches[0]?.line, 1);
});
