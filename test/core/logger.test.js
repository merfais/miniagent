const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createSessionLogger,
  createSessionId,
  logEvent,
  resolveLogFilePath,
} = require('../../src/core/logger');

test('resolveLogFilePath uses the default logs directory and date partition', () => {
  const result = resolveLogFilePath({
    workspaceRoot: '/workspace/demo',
    logDir: undefined,
    sessionId: 'ab12cd34',
    now: new Date('2026-07-17T08:00:00Z'),
  });

  assert.equal(result, path.join('/workspace/demo', 'logs', '2026-07-17', 'ab12cd34.log'));
});

test('createSessionLogger writes json lines to the configured log file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-logger-'));
  const writes = [];
  const logger = createSessionLogger({
    workspaceRoot: root,
    sessionId: 'ab12cd34',
    logDir: 'trace-output',
    logToCli: false,
    cliWriter: (line) => writes.push(line),
    now: new Date('2026-07-17T08:00:00Z'),
  });

  await logger.log({ event: 'session.start' });
  const file = path.join(root, 'trace-output', '2026-07-17', 'ab12cd34.log');
  const content = await fs.readFile(file, 'utf8');
  const parsed = JSON.parse(content.trim());

  assert.equal(parsed.sessionId, 'ab12cd34');
  assert.equal(parsed.event, 'session.start');
  assert.deepEqual(writes, []);
});

test('createSessionLogger mirrors logs to cli when logToCli is enabled', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-logger-cli-'));
  const writes = [];
  const logger = createSessionLogger({
    workspaceRoot: root,
    sessionId: 'ab12cd34',
    logDir: 'logs',
    logToCli: true,
    cliWriter: (line) => writes.push(line),
    now: new Date('2026-07-17T08:00:00Z'),
  });

  await logger.log({ event: 'provider.generate.start', step: 1 });

  assert.match(writes[0], /\[log\]/);
  assert.match(writes[0], /provider\.generate\.start/);
});

test('createSessionId returns a short random identifier', () => {
  const sessionId = createSessionId();
  assert.match(sessionId, /^[a-f0-9]{8}$/);
});

test('logEvent resolves to undefined even when the logger returns a value', async () => {
  const result = await logEvent(
    {
      log: async () => ({ ok: true }),
    },
    { event: 'session.start' },
  );

  assert.equal(result, undefined);
});
