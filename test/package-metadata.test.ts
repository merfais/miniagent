import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('package.json exposes the TypeScript/ESM runtime surface', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8'));

  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, './dist/src/index.js');
  assert.equal(pkg.types, './dist/src/index.d.ts');
  assert.equal(pkg.bin.miniagent, './dist/src/index.js');
  assert.deepEqual(pkg.exports['.'], {
    types: './dist/src/index.d.ts',
    import: './dist/src/index.js',
  });
  assert.equal(pkg.scripts.start, 'tsx src/index.ts');
  assert.equal(pkg.scripts.test, 'node --import tsx --test test/*.test.ts test/**/*.test.ts');
  assert.equal(pkg.scripts.typecheck, 'tsc --noEmit -p tsconfig.json');
  assert.equal(pkg.scripts.build, 'tsc -p tsconfig.json');
  assert.equal(pkg.scripts.server, 'tsx src/server/main.ts');
  assert.equal(pkg.scripts.cli, 'tsx src/ui-cli/main.ts');
  assert.equal(pkg.devDependencies.typescript, '^5.6.0');
  assert.equal(pkg.devDependencies.tsx, '^4.19.0');
  assert.equal(pkg.devDependencies['@types/node'], '^22.10.0');
});
