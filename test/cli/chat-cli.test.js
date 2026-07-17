const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('node:stream');

const {
  createDefaultToolRegistry,
  renderToolCall,
  startCli,
} = require('../../src/cli/chat-cli');

test('renderToolCall prints a readable status line', () => {
  assert.match(
    renderToolCall({ toolName: 'read_file', args: { path: 'src/index.js' } }),
    /\[tool\] read_file/,
  );
});

test('createDefaultToolRegistry registers MVP tools', () => {
  const registry = createDefaultToolRegistry({
    workspaceRoot: process.cwd(),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ RelatedTopics: [] }),
    }),
  });

  assert.ok(registry.get('read_file'));
  assert.ok(registry.get('write_file'));
  assert.ok(registry.get('list_files'));
  assert.ok(registry.get('search_code'));
  assert.ok(registry.get('run_command'));
  assert.ok(registry.get('web_search'));
});

test('startCli exits cleanly on EOF', async () => {
  const input = new PassThrough();
  input.end();

  let output = '';
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });

  await startCli({
    input,
    output: outputStream,
    provider: {
      generate: async () => ({ type: 'final_answer', content: 'unused' }),
    },
    tools: createDefaultToolRegistry({ workspaceRoot: process.cwd() }),
  });

  assert.match(output, /MiniAgent ready/);
  assert.match(output, /Bye/);
});

test('startCli prints tool activity and a grounded final answer', async () => {
  const input = new PassThrough();
  input.end('fix it\n');

  let output = '';
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });

  const actions = [
    {
      type: 'tool_call',
      callId: 'call_1',
      toolName: 'run_command',
      args: { cmd: 'node -p "1 + 1"' },
    },
    {
      type: 'final_answer',
      content: 'Updated local code and ran node -p "1 + 1" for verification.',
    },
  ];

  await startCli({
    input,
    output: outputStream,
    provider: {
      generate: async () => actions.shift() || { type: 'final_answer', content: 'Bye.' },
    },
    tools: createDefaultToolRegistry({ workspaceRoot: process.cwd() }),
  });

  assert.match(output, /\[tool\] run_command/);
  assert.match(output, /Updated local code and ran node -p "1 \+ 1" for verification\./);
});

test('startCli logs session start and session end', async () => {
  const input = new PassThrough();
  input.end('hi\n');

  let output = '';
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });

  const events = [];

  await startCli({
    input,
    output: outputStream,
    provider: {
      generate: async () => ({ type: 'final_answer', content: 'Done.' }),
    },
    tools: createDefaultToolRegistry({ workspaceRoot: process.cwd() }),
    logger: {
      log: async (entry) => {
        events.push(entry);
      },
    },
  });

  assert.equal(events[0].event, 'session.start');
  assert.equal(events.at(-1).event, 'session.end');
});

test('startCli logs process.error before session.end when execution fails', async () => {
  const input = new PassThrough();
  input.end('hi\n');

  const outputStream = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  const events = [];

  await assert.rejects(
    () =>
      startCli({
        input,
        output: outputStream,
        provider: {
          generate: async () => {
            throw new Error('boom');
          },
        },
        tools: createDefaultToolRegistry({ workspaceRoot: process.cwd() }),
        logger: {
          log: async (entry) => {
            events.push(entry);
          },
        },
      }),
    /boom/,
  );

  assert.deepEqual(
    events.map((entry) => entry.event),
    ['session.start', 'runtime.step.start', 'provider.generate.start', 'provider.generate.error', 'runtime.step.end', 'process.error', 'session.end'],
  );
});

test('startCli writes session.start logs before the first prompt when cli mirroring is enabled', async () => {
  const input = new PassThrough();
  input.end();

  let output = '';
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });

  await startCli({
    input,
    output: outputStream,
    provider: {
      generate: async () => ({ type: 'final_answer', content: 'unused' }),
    },
    tools: createDefaultToolRegistry({ workspaceRoot: process.cwd() }),
    logger: {
      log: async (entry) => {
        outputStream.write(`[log] ${entry.event}\n`);
      },
    },
  });

  assert.ok(output.indexOf('[log] session.start') < output.indexOf('you> '));
  assert.doesNotMatch(output, /you> \[log\] session\.start/);
});
