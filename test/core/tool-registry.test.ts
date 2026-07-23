import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry } from '../../src/core/tool-registry';

test('ToolRegistry registers tools and prevents duplicates', () => {
  const registry = new ToolRegistry();

  registry.register({
    name: 'echo',
    description: 'Echo input',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  });

  assert.equal(registry.list().length, 1);
  assert.equal(registry.get('echo')?.description, 'Echo input');
  assert.equal(registry.get('missing'), undefined);
  assert.throws(() => {
    registry.register({
      name: 'echo',
      description: 'Duplicate',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ ok: true }),
    });
  }, /already registered/i);
});

test('ToolRegistry validates required tool fields', () => {
  const registry = new ToolRegistry();

  assert.throws(() => {
    registry.register({ name: '', execute: async () => ({}) });
  }, /tool name/i);

  assert.throws(() => {
    registry.register({ name: 'bad', execute: 'not a function' as never });
  }, /execute/i);
});

test('ToolRegistry validates tool arguments against required schema fields', () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'write_file',
    description: 'Write a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    execute: async () => ({ ok: true }),
  });

  const tool = registry.get('write_file');
  assert.ok(tool);
  assert.doesNotThrow(() => {
    tool.validateArgs({ path: 'a.txt', content: 'hello' });
  });
  assert.throws(() => {
    tool.validateArgs({ path: 'a.txt' });
  }, /content/i);
});
