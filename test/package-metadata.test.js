const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

test('package.json declares the TypeScript migration scripts and devDependencies', async () => {
  const pkg = JSON.parse(
    await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
  );

  assert.equal(pkg.scripts.typecheck, 'tsc --noEmit -p tsconfig.json');
  assert.equal(pkg.scripts.build, 'tsc -p tsconfig.json');
  assert.equal(pkg.scripts['test:ts'], 'node --import tsx --test test/**/*.test.ts');
  assert.equal(pkg.scripts['test:dist'], 'node --test dist/test/**/*.test.js');
  assert.equal(pkg.devDependencies.typescript, '^5.6.0');
  assert.equal(pkg.devDependencies.tsx, '^4.19.0');
  assert.equal(pkg.devDependencies['@types/node'], '^22.10.0');
});
