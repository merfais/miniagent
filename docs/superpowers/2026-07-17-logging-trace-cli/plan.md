# Logging and Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session-scoped structured logging that always writes to `logs/{YYYY-MM-DD}/{sessionId}.log` by default, supports a configurable `logDir`, and mirrors the same events to the CLI when `logToCli: true`.

**Architecture:** Introduce a focused logger module under `src/core` that owns session ID generation, log path resolution, JSON Lines file output, and optional CLI rendering. Thread the logger through `src/index.js`, `src/cli/chat-cli.js`, and `src/agent/runtime.js` so startup, runtime steps, provider/tool calls, final answers, and fatal errors all emit consistent events without scattering raw `console.log` calls across the codebase.

**Tech Stack:** Node.js 22+, CommonJS modules, `node:test`, `node:assert/strict`, `node:fs/promises`, `node:path`, `node:crypto`

---

## File Structure

- `src/core/logger.js`
  Own session ID generation, date-partitioned file-path resolution, JSON Lines persistence, and CLI rendering helpers.
- `src/index.js`
  Normalize logging config, create the per-session logger, and record fatal startup/runtime failures.
- `src/cli/chat-cli.js`
  Emit session lifecycle events and pass the logger into the runtime without changing the existing chat loop behavior.
- `src/agent/runtime.js`
  Emit per-step, provider, tool, and final-answer events around the existing agent loop.
- `test/core/logger.test.js`
  Cover logger path rules, file output, CLI mirroring, and session ID shape.
- `test/index.test.js`
  Cover config parsing and startup logger creation.
- `test/cli/chat-cli.test.js`
  Cover session lifecycle logging and CLI mirroring behavior.
- `test/agent/runtime.test.js`
  Cover happy-path and error-path runtime trace events.
- `miniagent.config.example.json`
  Show the supported logging config shape.
- `README.md`
  Document the default log layout, `logDir`, and `logToCli`.

---

### Task 1: Add the shared logger module with path resolution and sinks

**Files:**
- Create: `src/core/logger.js`
- Test: `test/core/logger.test.js`

- [ ] **Step 1: Write the failing logger tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createSessionLogger,
  createSessionId,
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
```

- [ ] **Step 2: Run the logger tests to verify they fail**

Run: `npm test -- test/core/logger.test.js`  
Expected: FAIL with `Cannot find module '../../src/core/logger'`

- [ ] **Step 3: Write the minimal logger implementation**

```js
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function createSessionId() {
  return crypto.randomBytes(4).toString('hex');
}

function formatDateForLogDir(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function resolveLogFilePath({ workspaceRoot, logDir = 'logs', sessionId, now = new Date() }) {
  const baseDir = path.isAbsolute(logDir) ? logDir : path.join(workspaceRoot, logDir);
  return path.join(baseDir, formatDateForLogDir(now), `${sessionId}.log`);
}

function renderLogLine(entry) {
  const parts = ['[log]', `session=${entry.sessionId}`, `event=${entry.event}`];
  if (entry.step !== undefined) parts.push(`step=${entry.step}`);
  if (entry.toolName) parts.push(`tool=${entry.toolName}`);
  return `${parts.join(' ')}\n`;
}

function createSessionLogger({
  workspaceRoot,
  sessionId,
  logDir = 'logs',
  logToCli = false,
  cliWriter = () => {},
  now = new Date(),
}) {
  const filePath = resolveLogFilePath({ workspaceRoot, logDir, sessionId, now });

  return {
    sessionId,
    filePath,
    async log(event) {
      const entry = {
        timestamp: new Date().toISOString(),
        sessionId,
        ...event,
      };

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');

      if (logToCli) {
        cliWriter(renderLogLine(entry));
      }

      return entry;
    },
  };
}

module.exports = {
  createSessionId,
  createSessionLogger,
  formatDateForLogDir,
  renderLogLine,
  resolveLogFilePath,
};
```

- [ ] **Step 4: Run the logger tests to verify they pass**

Run: `npm test -- test/core/logger.test.js`  
Expected: PASS with 4 passing tests

- [ ] **Step 5: Commit the logger module**

```bash
git add src/core/logger.js test/core/logger.test.js
git commit -m "feat: add session logger"
```

### Task 2: Wire config, session creation, and fatal-error logging at startup

**Files:**
- Modify: `src/index.js`
- Modify: `miniagent.config.example.json`
- Modify: `README.md`
- Test: `test/index.test.js`

- [ ] **Step 1: Write failing startup and config tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createAppContextFromConfig,
  loadConfig,
} = require('../src/index');

test('loadConfig preserves logToCli and logDir from miniagent.config.json', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-config-'));
  const configPath = path.join(root, 'miniagent.config.json');

  await fs.writeFile(
    configPath,
    JSON.stringify({
      logToCli: true,
      logDir: '.miniagent-trace',
      provider: {
        type: 'openai-compatible',
        model: 'doubao-test-model',
        apiKey: 'config-key',
      },
    }),
    'utf8',
  );

  const config = await loadConfig({ cwd: root });
  assert.equal(config.logToCli, true);
  assert.equal(config.logDir, '.miniagent-trace');
});

test('createAppContextFromConfig creates one session logger per startup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-app-context-'));
  const { logger } = await createAppContextFromConfig({
    cwd: root,
    config: {
      logToCli: false,
      logDir: 'logs',
      provider: {
        type: 'openai-compatible',
        model: 'doubao-test-model',
        apiKey: 'config-key',
      },
    },
  });

  await logger.log({ event: 'session.start' });
  const entries = await fs.readFile(logger.filePath, 'utf8');

  assert.match(logger.filePath, /logs\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{8}\.log$/);
  assert.match(entries, /session\.start/);
});
```

- [ ] **Step 2: Run the startup tests to verify they fail**

Run: `npm test -- test/index.test.js`  
Expected: FAIL with `createAppContextFromConfig is not a function`

- [ ] **Step 3: Implement config plumbing and fatal-error logging**

```js
const { createSessionId, createSessionLogger } = require('./core/logger');

function normalizeLoggingConfig(config = {}) {
  return {
    logToCli: config.logToCli === true,
    logDir: typeof config.logDir === 'string' && config.logDir.trim() !== '' ? config.logDir : 'logs',
  };
}

async function createAppContextFromConfig({
  cwd = process.cwd(),
  config,
  env = process.env,
  output = process.stdout,
} = {}) {
  const resolvedConfig = config || (await loadConfig({ cwd }));
  const provider = createProviderFromObject(resolvedConfig, env);
  const { logToCli, logDir } = normalizeLoggingConfig(resolvedConfig);
  const sessionId = createSessionId();
  const logger = createSessionLogger({
    workspaceRoot: cwd,
    sessionId,
    logDir,
    logToCli,
    cliWriter: (line) => output.write(line),
  });

  return {
    config: resolvedConfig,
    logger,
    provider,
    sessionId,
  };
}

async function main() {
  const { provider, logger } = await createAppContextFromConfig();
  try {
    await startCli({ provider, logger });
  } catch (error) {
    await logger.log({ event: 'process.error', error: error.message });
    throw error;
  }
}
```

- [ ] **Step 4: Run the startup tests to verify they pass**

Run: `npm test -- test/index.test.js`  
Expected: PASS with the new config and startup logger cases

- [ ] **Step 5: Commit the startup plumbing**

```bash
git add src/index.js miniagent.config.example.json README.md test/index.test.js
git commit -m "feat: wire startup logging config"
```

### Task 3: Instrument the CLI and runtime with session, step, provider, tool, and final-answer events

**Files:**
- Modify: `src/cli/chat-cli.js`
- Modify: `src/agent/runtime.js`
- Test: `test/cli/chat-cli.test.js`
- Test: `test/agent/runtime.test.js`

- [ ] **Step 1: Write failing runtime and CLI logging tests**

```js
test('AgentRuntime logs provider, tool, and final-answer events', async () => {
  const events = [];
  const tools = new ToolRegistry();
  tools.register({
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ content: '# Example' }),
  });

  const runtime = new AgentRuntime({
    provider: {
      generate: async () => ({ type: 'tool_call', callId: 'call_1', toolName: 'read_file', args: {} }),
    },
    tools,
    logger: {
      log: async (entry) => {
        events.push(entry);
      },
    },
  });

  await runtime.respond([{ role: 'user', content: 'say done' }]);

  assert.deepEqual(
    events.map((entry) => entry.event),
    [
      'runtime.step.start',
      'provider.generate.start',
      'provider.generate.end',
      'tool.call.start',
      'tool.call.end',
      'runtime.step.end',
    ],
  );
});

test('startCli logs session start and session end', async () => {
  const events = [];
  const input = new PassThrough();
  input.end('hi\n');

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
```

- [ ] **Step 2: Run the runtime and CLI tests to verify they fail**

Run: `npm test -- test/agent/runtime.test.js test/cli/chat-cli.test.js`  
Expected: FAIL because `logger` is ignored and no events are recorded

- [ ] **Step 3: Implement logger calls in the runtime and CLI**

```js
async function logEvent(logger, entry) {
  if (logger && typeof logger.log === 'function') {
    await logger.log(entry);
  }
}

function createRuntime({ provider, tools, logger }) {
  return new AgentRuntime({
    provider,
    tools,
    logger,
  });
}

// Inside AgentRuntime.respond()
const stepNumber = step + 1;
await logEvent(this.logger, { event: 'runtime.step.start', step: stepNumber, messageCount: workingMessages.length });
await logEvent(this.logger, { event: 'provider.generate.start', step: stepNumber });

let action;
try {
  action = await this.provider.generate({
    messages: workingMessages,
    tools: this.tools.list(),
  });
  await logEvent(this.logger, { event: 'provider.generate.end', step: stepNumber, actionType: action.type });
} catch (error) {
  await logEvent(this.logger, { event: 'provider.generate.error', step: stepNumber, error: error.message });
  throw error;
}

if (action.type === 'tool_call') {
  const tool = this.tools.get(action.toolName);
  await logEvent(this.logger, {
    event: 'tool.call.start',
    step: stepNumber,
    toolName: action.toolName,
    callId: action.callId || `call_${stepNumber}`,
  });
}

// Inside startCli()
const runtime = createRuntime({
  provider,
  tools: tools || createDefaultToolRegistry({ workspaceRoot, fetchImpl }),
  logger,
});

await logEvent(logger, { event: 'session.start' });
try {
  // existing loop remains unchanged except for passing logger into createRuntime
} finally {
  await logEvent(logger, { event: 'session.end' });
}
```

- [ ] **Step 4: Run the runtime and CLI tests to verify they pass**

Run: `npm test -- test/agent/runtime.test.js test/cli/chat-cli.test.js`  
Expected: PASS with the new event assertions

- [ ] **Step 5: Commit the runtime and CLI instrumentation**

```bash
git add src/cli/chat-cli.js src/agent/runtime.js test/cli/chat-cli.test.js test/agent/runtime.test.js
git commit -m "feat: trace cli runtime events"
```

### Task 4: Cover error paths, keep documentation current, and run the full verification suite

**Files:**
- Modify: `src/agent/runtime.js`
- Modify: `test/agent/runtime.test.js`
- Modify: `test/cli/chat-cli.test.js`
- Modify: `README.md`
- Modify: `miniagent.config.example.json`
- Modify: `test/index.test.js`

- [ ] **Step 1: Write failing error-path and docs expectations**

```js
test('AgentRuntime logs tool.call.error when a tool throws', async () => {
  const events = [];
  const tools = new ToolRegistry();
  tools.register({
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      throw new Error('boom');
    },
  });

  const runtime = new AgentRuntime({
    provider: {
      generate: async () => ({
        type: 'tool_call',
        callId: 'call_1',
        toolName: 'read_file',
        args: {},
      }),
    },
    tools,
    logger: {
      log: async (entry) => {
        events.push(entry);
      },
    },
  });

  await assert.rejects(() => runtime.respond([{ role: 'user', content: 'read it' }]), /boom/);
  assert.equal(events.at(-1).event, 'tool.call.error');
});

test('createAppContextFromConfig falls back to defaults for invalid log config types', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-invalid-log-config-'));
  const { logger } = await createAppContextFromConfig({
    cwd: root,
    config: {
      logToCli: 'yes',
      logDir: 42,
      provider: {
        type: 'openai-compatible',
        model: 'doubao-test-model',
        apiKey: 'config-key',
      },
    },
  });

  assert.match(logger.filePath, /logs\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{8}\.log$/);
});

test('README documents logDir and logToCli', async () => {
  const readme = await fs.readFile(path.join(process.cwd(), 'README.md'), 'utf8');
  assert.match(readme, /logDir/);
  assert.match(readme, /logToCli/);
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `npm test -- test/agent/runtime.test.js test/index.test.js`  
Expected: FAIL because the error event and docs/config updates do not exist yet

- [ ] **Step 3: Finish error-path instrumentation and documentation**

```js
try {
  const result = await tool.execute(action.args || {});
  await this.log({ event: 'tool.call.end', step: stepNumber, toolName: action.toolName, callId: action.callId });
  trace.push({ toolName: action.toolName, args: action.args || {}, result });
} catch (error) {
  await this.log({
    event: 'tool.call.error',
    step: stepNumber,
    toolName: action.toolName,
    callId: action.callId,
    error: error.message,
  });
  throw error;
}

function normalizeLoggingConfig(config = {}) {
  return {
    logToCli: config.logToCli === true,
    logDir: typeof config.logDir === 'string' && config.logDir.trim() !== '' ? config.logDir : 'logs',
  };
}

MiniAgent writes one JSON Lines file per CLI session under
`{logDir}/{YYYY-MM-DD}/{sessionId}.log`.

Set `logToCli: true` to mirror each structured log event to the terminal while
still writing the same event to the session log file.

{
  "logDir": "logs",
  "logToCli": false,
  "provider": {
    "type": "openai-compatible",
    "model": "your_model_id",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "your_api_key"
  }
}
```

- [ ] **Step 4: Run the full verification suite**

Run: `npm test`  
Expected: PASS with all existing tests plus the new logger coverage

- [ ] **Step 5: Commit the final logging feature slice**

```bash
git add src/agent/runtime.js README.md miniagent.config.example.json test/agent/runtime.test.js test/cli/chat-cli.test.js test/index.test.js
git commit -m "docs: document session logging"
```
