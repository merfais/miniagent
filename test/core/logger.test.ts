import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createBootLogger,
  createSessionLogger,
  logger,
  stdLogger,
  type LogRecord,
} from '../../src/core/logger.js';

test('createBootLogger writes to boot log file under cwd/logDir/date', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-logger-'));
  const originalCwd = process.cwd();
  process.chdir(root);
  try {
    createBootLogger({ logDir: 'trace-output' });
    logger.info('boot.start', { step: 1 });

    const date = new Date().toISOString().slice(0, 10);
    const dir = path.join(root, 'trace-output', date);
    const entries = await fs.readdir(dir);
    const bootFile = entries.find((f) => /^sys-\d{6}-[a-f0-9]{4}\.log$/.test(f));
    assert.ok(bootFile, `expected sys log in ${dir}, got ${entries.join(',')}`);
    const content = await fs.readFile(path.join(dir, bootFile as string), 'utf8');
    const parsed = JSON.parse(content.trim().split('\n')[0]);
    assert.equal(parsed.message, 'boot.start');
  } finally {
    process.chdir(originalCwd);
  }
});

test('createSessionLogger increments n from meta.json and creates session log', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-logger-session-'));
  const originalCwd = process.cwd();
  process.chdir(root);
  try {
    createBootLogger();
    const first = createSessionLogger();
    const second = createSessionLogger();

    assert.match(first.sessionId, /^1-\d{6}-[a-f0-9]{4}$/);
    assert.match(second.sessionId, /^2-\d{6}-[a-f0-9]{4}$/);

    const date = new Date().toISOString().slice(0, 10);
    const metaRaw = await fs.readFile(path.join(root, 'logs', date, 'meta.json'), 'utf8');
    assert.deepEqual(JSON.parse(metaRaw), { n: 2 });

    first.logger.info('hello.session');
    const content = await fs.readFile(first.filePath, 'utf8');
    assert.match(content, /hello\.session/);
  } finally {
    process.chdir(originalCwd);
  }
});

test('stdLogger writes to stdout and does not throw', () => {
  assert.doesNotThrow(() => stdLogger.info('hello'));
});

test('logger buffers records before init and can be captured with setSinks', () => {
  const records: LogRecord[] = [];
  logger.setSinks([{ write: (r) => records.push(r) }]);
  logger.info('captured');
  assert.equal(records.at(-1)?.message, 'captured');
});
