const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createSessionStore } = require('../../src/core/session-store');

test('createSession creates a dated session directory and updates meta.json', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-session-store-'));
  const store = createSessionStore({
    workspaceRoot: root,
    now: () => new Date('2026-07-23T09:00:00Z'),
    randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  });

  const session = await store.createSession({
    initialMessages: [{ role: 'system', content: 'system prompt' }],
  });

  assert.equal(
    session.sessionId,
    '2026-07-23/1-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  );
  assert.equal(session.nextTurn, 1);
  assert.deepEqual(session.messages, [{ role: 'system', content: 'system prompt' }]);

  const meta = JSON.parse(
    await fs.readFile(path.join(root, 'sessions', 'meta.json'), 'utf8'),
  );
  assert.equal(meta.activeSessionId, session.sessionId);
  assert.deepEqual(meta.dailyIncrement, { date: '2026-07-23', value: 1 });

  const sessionDir = path.join(
    root,
    'sessions',
    '2026-07-23',
    '1-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  );
  await assert.doesNotReject(() => fs.access(path.join(sessionDir, 'history.jsonl')));
  await assert.doesNotReject(() => fs.access(path.join(sessionDir, 'message.jsonl')));
  await assert.doesNotReject(() => fs.access(path.join(sessionDir, 'message-before')));
  await assert.doesNotReject(() => fs.access(path.join(sessionDir, 'artifacts')));
  await assert.doesNotReject(() => fs.access(path.join(sessionDir, 'pending')));
});

test('createSession increments within a day and resets on a new day', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-session-store-day-'));
  let currentDate = '2026-07-23T09:00:00Z';
  let uuidCounter = 0;
  const store = createSessionStore({
    workspaceRoot: root,
    now: () => new Date(currentDate),
    randomUUID: () => `00000000-0000-0000-0000-${String(++uuidCounter).padStart(12, '0')}`,
  });

  const first = await store.createSession();
  const second = await store.createSession();
  currentDate = '2026-07-24T09:00:00Z';
  const third = await store.createSession();

  assert.equal(first.sessionId, '2026-07-23/1-00000000-0000-0000-0000-000000000001');
  assert.equal(second.sessionId, '2026-07-23/2-00000000-0000-0000-0000-000000000002');
  assert.equal(third.sessionId, '2026-07-24/1-00000000-0000-0000-0000-000000000003');
});

test('createSession allocates unique daily increments under concurrent calls', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-session-concurrent-'));
  let uuidCounter = 0;
  const store = createSessionStore({
    workspaceRoot: root,
    now: () => new Date('2026-07-23T09:00:00Z'),
    randomUUID: () => `00000000-0000-0000-0000-${String(++uuidCounter).padStart(12, '0')}`,
  });

  const sessions = await Promise.all([
    store.createSession(),
    store.createSession(),
    store.createSession(),
    store.createSession(),
  ]);

  assert.deepEqual(
    sessions.map((session) => session.sessionId).sort(),
    [
      '2026-07-23/1-00000000-0000-0000-0000-000000000001',
      '2026-07-23/2-00000000-0000-0000-0000-000000000002',
      '2026-07-23/3-00000000-0000-0000-0000-000000000003',
      '2026-07-23/4-00000000-0000-0000-0000-000000000004',
    ],
  );
});

test('listSessions returns canonical session ids sorted by date and daily increment', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-session-list-'));
  let currentDate = '2026-07-23T09:00:00Z';
  let uuidCounter = 0;
  const store = createSessionStore({
    workspaceRoot: root,
    now: () => new Date(currentDate),
    randomUUID: () => `00000000-0000-0000-0000-${String(++uuidCounter).padStart(12, '0')}`,
  });

  await store.createSession();
  await store.createSession();
  currentDate = '2026-07-24T09:00:00Z';
  await store.createSession();

  assert.deepEqual(await store.listSessions(), [
    '2026-07-23/1-00000000-0000-0000-0000-000000000001',
    '2026-07-23/2-00000000-0000-0000-0000-000000000002',
    '2026-07-24/1-00000000-0000-0000-0000-000000000003',
  ]);
});

test('persistCompletedTurn writes factual history and message snapshot entries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-session-turn-'));
  const store = createSessionStore({
    workspaceRoot: root,
    now: () => new Date('2026-07-23T09:00:00Z'),
    randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  });

  const session = await store.createSession({
    initialMessages: [{ role: 'system', content: 'system prompt' }],
  });

  const state = await store.persistCompletedTurn({
    sessionId: session.sessionId,
    turn: 1,
    userMessage: { role: 'user', content: 'read README' },
    assistantMessage: { role: 'assistant', content: 'Done.' },
    toolTrace: [
      {
        callId: 'call_1',
        toolName: 'read_file',
        args: { path: 'README.md' },
        result: { content: '# Example' },
      },
    ],
  });

  assert.equal(state.nextTurn, 2);
  assert.equal(state.messages.at(-1).role, 'assistant');

  const sessionDir = store.resolveSessionDir(session.sessionId);
  const history = (await fs.readFile(path.join(sessionDir, 'history.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const persistedMessages = (await fs.readFile(path.join(sessionDir, 'message.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.deepEqual(
    history.map((entry) => entry.type),
    ['message', 'tool_call', 'tool_result', 'message'],
  );
  assert.deepEqual(
    persistedMessages.map((entry) => entry.turn),
    [0, 1, 1, 1],
  );
  assert.deepEqual(
    persistedMessages.map((entry) => entry.message.role),
    ['system', 'user', 'tool', 'assistant'],
  );
});

test('loadActiveSession restores the active session messages and nextTurn', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-active-session-'));
  const store = createSessionStore({
    workspaceRoot: root,
    now: () => new Date('2026-07-23T09:00:00Z'),
    randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  });

  const session = await store.createSession({
    initialMessages: [{ role: 'system', content: 'system prompt' }],
  });

  await store.persistCompletedTurn({
    sessionId: session.sessionId,
    turn: 1,
    userMessage: { role: 'user', content: 'hello' },
    assistantMessage: { role: 'assistant', content: 'hi' },
    toolTrace: [],
  });

  const loaded = await store.loadActiveSession();
  assert.equal(loaded.sessionId, session.sessionId);
  assert.equal(loaded.nextTurn, 2);
  assert.deepEqual(loaded.messages.map((message) => message.role), [
    'system',
    'user',
    'assistant',
  ]);
});

test('activateSession switches the active session in meta.json', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-activate-session-'));
  let uuidCounter = 0;
  const store = createSessionStore({
    workspaceRoot: root,
    now: () => new Date('2026-07-23T09:00:00Z'),
    randomUUID: () => `00000000-0000-0000-0000-${String(++uuidCounter).padStart(12, '0')}`,
  });

  const first = await store.createSession({
    initialMessages: [{ role: 'system', content: 'first prompt' }],
  });
  const second = await store.createSession({
    initialMessages: [{ role: 'system', content: 'second prompt' }],
  });

  await store.activateSession(first.sessionId);
  const loaded = await store.loadActiveSession();

  assert.equal(second.sessionId, '2026-07-23/2-00000000-0000-0000-0000-000000000002');
  assert.equal(loaded.sessionId, first.sessionId);
  assert.equal(loaded.messages[0].content, 'first prompt');
});

test('loadSession fails clearly when message.jsonl is missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-session-missing-message-'));
  const store = createSessionStore({
    workspaceRoot: root,
    now: () => new Date('2026-07-23T09:00:00Z'),
    randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  });

  const session = await store.createSession();
  await fs.rm(path.join(store.resolveSessionDir(session.sessionId), 'message.jsonl'));

  await assert.rejects(
    () => store.loadSession(session.sessionId),
    /Missing required session file: .*message\.jsonl/,
  );
});

test('persistCompletedTurn externalizes large tool results into artifacts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-session-artifact-'));
  const store = createSessionStore({
    workspaceRoot: root,
    now: () => new Date('2026-07-23T09:00:00Z'),
    randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  });

  const session = await store.createSession({
    initialMessages: [{ role: 'system', content: 'system prompt' }],
  });

  const hugeContent = 'x'.repeat(20 * 1024);
  const state = await store.persistCompletedTurn({
    sessionId: session.sessionId,
    turn: 1,
    userMessage: { role: 'user', content: 'read big file' },
    assistantMessage: { role: 'assistant', content: 'Done.' },
    toolTrace: [
      {
        callId: 'call_1',
        toolName: 'read_file',
        args: { path: 'big.txt' },
        result: { content: hugeContent },
      },
    ],
  });

  const toolMessage = state.messages.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /artifactRef/);
  assert.match(toolMessage.content, /stored at/);

  const sessionDir = store.resolveSessionDir(session.sessionId);
  const history = (await fs.readFile(path.join(sessionDir, 'history.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const toolResult = history.find((entry) => entry.type === 'tool_result');

  assert.equal(toolResult.artifactRef, 'artifacts/tool/1-call_1.json');
  await assert.doesNotReject(() =>
    fs.access(path.join(sessionDir, toolResult.artifactRef)),
  );
});

test('applyCompression writes message-before snapshot and compression history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-session-compression-'));
  const store = createSessionStore({
    workspaceRoot: root,
    now: () => new Date('2026-07-23T09:00:00Z'),
    randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  });

  const session = await store.createSession({
    initialMessages: [{ role: 'system', content: 'system prompt' }],
  });

  await store.persistCompletedTurn({
    sessionId: session.sessionId,
    turn: 1,
    userMessage: { role: 'user', content: 'hello' },
    assistantMessage: { role: 'assistant', content: 'hi' },
    toolTrace: [],
  });

  await store.applyCompression({
    sessionId: session.sessionId,
    compressionId: 'cmp-0001',
    appliedBeforeTurn: 2,
    summary: '前 1 轮摘要',
    nextEntries: [
      { turn: 0, message: { role: 'system', content: 'system prompt' } },
      { turn: 1, message: { role: 'system', content: '前 1 轮摘要' } },
    ],
  });

  const sessionDir = store.resolveSessionDir(session.sessionId);
  await assert.doesNotReject(() =>
    fs.readFile(path.join(sessionDir, 'message-before', 'cmp-0001.before.jsonl'), 'utf8'),
  );

  const history = (await fs.readFile(path.join(sessionDir, 'history.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  const compression = history.find((entry) => entry.type === 'compression');
  assert.equal(compression.sessionId, session.sessionId);
  assert.equal(compression.beforeMessageRef, 'message-before/cmp-0001.before.jsonl');
});

test('loadSession backfills a matching pending compression record', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-session-recover-'));
  const store = createSessionStore({
    workspaceRoot: root,
    now: () => new Date('2026-07-23T09:00:00Z'),
    randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  });

  const session = await store.createSession({
    initialMessages: [{ role: 'system', content: 'system prompt' }],
  });

  const sessionDir = store.resolveSessionDir(session.sessionId);
  const nextEntries = [
    { turn: 0, message: { role: 'system', content: 'system prompt' } },
    { turn: 1, message: { role: 'system', content: '压缩后的摘要' } },
  ];
  const nextBody = `${nextEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;

  await fs.writeFile(path.join(sessionDir, 'message.jsonl'), nextBody, 'utf8');
  await fs.writeFile(
    path.join(sessionDir, 'pending', 'compression.json'),
    JSON.stringify({
      sessionId: session.sessionId,
      compressionId: 'cmp-0001',
      appliedBeforeTurn: 2,
      beforeMessageRef: 'message-before/cmp-0001.before.jsonl',
      summary: '前 1 轮摘要',
      afterDigest: crypto.createHash('sha256').update(nextBody).digest('hex'),
    }),
    'utf8',
  );

  await store.loadSession(session.sessionId);

  const history = (await fs.readFile(path.join(sessionDir, 'history.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(history.find((entry) => entry.type === 'compression'));
});

test('loadSession fails when pending compression belongs to another session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-session-pending-mismatch-'));
  const store = createSessionStore({
    workspaceRoot: root,
    now: () => new Date('2026-07-23T09:00:00Z'),
    randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  });

  const session = await store.createSession({
    initialMessages: [{ role: 'system', content: 'system prompt' }],
  });

  const sessionDir = store.resolveSessionDir(session.sessionId);
  await fs.writeFile(
    path.join(sessionDir, 'pending', 'compression.json'),
    JSON.stringify({
      sessionId: '2026-07-23/999-ffffffff-ffff-ffff-ffff-ffffffffffff',
      compressionId: 'cmp-0001',
      appliedBeforeTurn: 2,
      beforeMessageRef: 'message-before/cmp-0001.before.jsonl',
      afterDigest: 'deadbeef',
    }),
    'utf8',
  );

  await assert.rejects(
    () => store.loadSession(session.sessionId),
    /Pending compression sessionId mismatch/,
  );
});

test('forkSession picks the first later compression snapshot and slices by turn', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-session-fork-'));
  let uuidCounter = 0;
  const store = createSessionStore({
    workspaceRoot: root,
    now: () => new Date('2026-07-23T09:00:00Z'),
    randomUUID: () => `00000000-0000-0000-0000-${String(++uuidCounter).padStart(12, '0')}`,
  });

  const source = await store.createSession({
    initialMessages: [{ role: 'system', content: 'system prompt' }],
  });

  await store.persistCompletedTurn({
    sessionId: source.sessionId,
    turn: 1,
    userMessage: { role: 'user', content: 'q1' },
    assistantMessage: { role: 'assistant', content: 'a1' },
    toolTrace: [],
  });

  await store.persistCompletedTurn({
    sessionId: source.sessionId,
    turn: 2,
    userMessage: { role: 'user', content: 'q2' },
    assistantMessage: { role: 'assistant', content: 'a2' },
    toolTrace: [],
  });

  await store.applyCompression({
    sessionId: source.sessionId,
    compressionId: 'cmp-0001',
    appliedBeforeTurn: 3,
    summary: '前 1-2 轮摘要',
    nextEntries: [
      { turn: 0, message: { role: 'system', content: 'system prompt' } },
      { turn: 2, message: { role: 'system', content: '前 1-2 轮摘要' } },
    ],
  });

  const forked = await store.forkSession({
    sourceSessionId: source.sessionId,
    targetTurn: 1,
    newUserInput: 'rewrite q2',
  });

  assert.equal(forked.sessionId, '2026-07-23/2-00000000-0000-0000-0000-000000000002');
  assert.deepEqual(forked.messages.map((message) => message.content), [
    'system prompt',
    'q1',
    'a1',
    'rewrite q2',
  ]);
  assert.equal(forked.nextTurn, 2);
});

test('forkSession rejects a non-existent completed turn boundary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-session-fork-invalid-'));
  const store = createSessionStore({
    workspaceRoot: root,
    now: () => new Date('2026-07-23T09:00:00Z'),
    randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  });

  const session = await store.createSession({
    initialMessages: [{ role: 'system', content: 'system prompt' }],
  });

  await store.persistCompletedTurn({
    sessionId: session.sessionId,
    turn: 1,
    userMessage: { role: 'user', content: 'q1' },
    assistantMessage: { role: 'assistant', content: 'a1' },
    toolTrace: [],
  });

  await assert.rejects(
    () =>
      store.forkSession({
        sourceSessionId: session.sessionId,
        targetTurn: 3,
        newUserInput: 'rewrite',
      }),
    /Invalid fork target turn: 3/,
  );
});

test('forkSession copies referenced artifacts for retained history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-session-fork-artifact-'));
  let uuidCounter = 0;
  const store = createSessionStore({
    workspaceRoot: root,
    now: () => new Date('2026-07-23T09:00:00Z'),
    randomUUID: () => `00000000-0000-0000-0000-${String(++uuidCounter).padStart(12, '0')}`,
  });

  const source = await store.createSession({
    initialMessages: [{ role: 'system', content: 'system prompt' }],
  });

  await store.persistCompletedTurn({
    sessionId: source.sessionId,
    turn: 1,
    userMessage: { role: 'user', content: 'get artifact' },
    assistantMessage: { role: 'assistant', content: 'done' },
    toolTrace: [
      {
        callId: 'call_1',
        toolName: 'read_file',
        args: { path: 'big.txt' },
        result: { content: 'x'.repeat(20 * 1024) },
      },
    ],
  });

  const forked = await store.forkSession({
    sourceSessionId: source.sessionId,
    targetTurn: 1,
    newUserInput: 'continue',
  });

  const forkedDir = store.resolveSessionDir(forked.sessionId);
  await assert.doesNotReject(() =>
    fs.access(path.join(forkedDir, 'artifacts', 'tool', '1-call_1.json')),
  );
});
