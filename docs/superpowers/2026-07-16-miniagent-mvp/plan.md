# MiniAgent MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a terminal-based coding agent MVP that uses a OpenAI-compatible-backed LLM to converse, call local tools, optionally produce spec/plan/handoff text in chat, search the web, and modify local code.

**Architecture:** The implementation uses a single Node.js process with a small internal runtime: a CLI loop, an agent loop, a provider adapter, a tool registry, and workspace-local tools. The system stays prompt-driven instead of workflow-driven, and uses a normalized internal action format for model outputs and tool execution.

**Tech Stack:** Node.js 22, built-in `node:test`, built-in `fetch`, CommonJS modules, local filesystem and child process APIs

---

### Task 1: Establish project scripts and shared runtime contracts

**Files:**
- Modify: `package.json`
- Create: `src/core/messages.js`
- Create: `src/core/tool-registry.js`
- Create: `src/core/workspace.js`
- Test: `test/core/tool-registry.test.js`

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { ToolRegistry } = require('../../src/core/tool-registry');

test('ToolRegistry registers tools and prevents duplicates', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo',
    description: 'Echo input',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  });

  assert.equal(registry.list().length, 1);
  assert.throws(() => {
    registry.register({
      name: 'echo',
      description: 'Duplicate',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ ok: true }),
    });
  }, /already registered/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/core/tool-registry.test.js`
Expected: FAIL because `src/core/tool-registry.js` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```js
class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }

    this.tools.set(tool.name, tool);
  }

  get(name) {
    return this.tools.get(name);
  }

  list() {
    return Array.from(this.tools.values());
  }
}

module.exports = {
  ToolRegistry,
};
```

- [ ] **Step 4: Add project scripts and shared helpers**

```json
{
  "name": "miniagent",
  "version": "1.0.0",
  "description": "A minimal prompt-driven coding agent for the terminal",
  "type": "commonjs",
  "main": "src/index.js",
  "bin": {
    "miniagent": "./src/index.js"
  },
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test"
  }
}
```

```js
function createMessage(role, content, extras = {}) {
  return { role, content, ...extras };
}

function createToolMessage(toolName, content, callId) {
  return { role: 'tool', toolName, content, callId };
}

module.exports = {
  createMessage,
  createToolMessage,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/core/tool-registry.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json src/core/messages.js src/core/tool-registry.js src/core/workspace.js test/core/tool-registry.test.js
git commit -m "chore: bootstrap miniagent runtime contracts"
```

### Task 2: Implement workspace-safe file and shell tools with guardrails

**Files:**
- Modify: `src/core/workspace.js`
- Create: `src/tools/file-tools.js`
- Create: `src/tools/shell-tool.js`
- Test: `test/tools/file-tools.test.js`
- Test: `test/tools/shell-tool.test.js`

- [ ] **Step 1: Write the failing file tool test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createFileTools } = require('../../src/tools/file-tools');

test('read_file and write_file stay inside the workspace root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-files-'));
  const tools = createFileTools({ workspaceRoot: root });
  const filePath = 'notes/todo.txt';

  await tools.write_file({ path: filePath, content: 'hello' });
  const result = await tools.read_file({ path: filePath });

  assert.match(result.content, /hello/);
  await assert.rejects(
    () => tools.read_file({ path: '../outside.txt' }),
    /outside the workspace/i,
  );
});
```

- [ ] **Step 2: Write the failing shell guardrail test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { createShellTool } = require('../../src/tools/shell-tool');

test('run_command rejects dangerous commands', async () => {
  const tool = createShellTool({ workspaceRoot: process.cwd() });

  await assert.rejects(
    () => tool.run_command({ cmd: 'rm -rf /' }),
    /dangerous command/i,
  );
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/tools/file-tools.test.js test/tools/shell-tool.test.js`
Expected: FAIL because the tool modules do not exist yet.

- [ ] **Step 4: Write minimal implementation**

```js
function createFileTools({ workspaceRoot }) {
  return {
    async read_file({ path }) {
      const filePath = resolveWorkspacePath(workspaceRoot, path);
      return { path, content: await fs.readFile(filePath, 'utf8') };
    },
    async write_file({ path, content }) {
      const filePath = resolveWorkspacePath(workspaceRoot, path);
      await fs.mkdir(nodePath.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf8');
      return { path, bytesWritten: Buffer.byteLength(content, 'utf8') };
    },
  };
}
```

```js
function createShellTool({ workspaceRoot }) {
  return {
    async run_command({ cmd, cwd }) {
      assertSafeCommand(cmd);
      return runCommand(cmd, { cwd: cwd || workspaceRoot });
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/tools/file-tools.test.js test/tools/shell-tool.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/workspace.js src/tools/file-tools.js src/tools/shell-tool.js test/tools/file-tools.test.js test/tools/shell-tool.test.js
git commit -m "feat: add workspace-safe file and shell tools"
```

### Task 3: Add web search and OpenAI-compatible provider adapters

**Files:**
- Create: `src/tools/web-search-tool.js`
- Create: `src/providers/openai-compatible.js`
- Create: `src/providers/openai-compatible.js`
- Test: `test/tools/web-search-tool.test.js`
- Test: `test/providers/openai-compatible.test.js`

- [ ] **Step 1: Write the failing web search test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { createWebSearchTool } = require('../../src/tools/web-search-tool');

test('web_search normalizes search results', async () => {
  const tool = createWebSearchTool({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        AbstractText: '',
        RelatedTopics: [{ Text: 'Example result', FirstURL: 'https://example.com' }],
      }),
    }),
  });

  const result = await tool.web_search({ query: 'example' });
  assert.equal(result.results[0].title, 'Example result');
});
```

- [ ] **Step 2: Write the failing provider test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { OpenAiCompatibleProvider } = require('../../src/providers/openai-compatible');

test('OpenAiCompatibleProvider maps chat completion responses into internal actions', async () => {
  const provider = new OpenAiCompatibleProvider({
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    model: 'doubao-test-model',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  function: { name: 'read_file', arguments: '{"path":"README.md"}' },
                },
              ],
            },
          },
        ],
      }),
    }),
  });

  const result = await provider.generate({ messages: [], tools: [] });
  assert.equal(result.type, 'tool_call');
  assert.equal(result.toolName, 'read_file');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/tools/web-search-tool.test.js test/providers/openai-compatible.test.js`
Expected: FAIL because the provider and web search modules do not exist yet.

- [ ] **Step 4: Write minimal implementation**

```js
class OpenAiCompatibleProvider {
  async generate({ messages, tools }) {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        tools,
      }),
    });

    return parseProviderResponse(await response.json());
  }
}
```

```js
class OpenAiCompatibleProvider extends OpenAiCompatibleProvider {}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/tools/web-search-tool.test.js test/providers/openai-compatible.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/web-search-tool.js src/providers/openai-compatible.js src/providers/openai-compatible.js test/tools/web-search-tool.test.js test/providers/openai-compatible.test.js
git commit -m "feat: add openai-compatible provider and web search tool"
```

### Task 4: Implement the agent loop and tool dispatch

**Files:**
- Create: `src/agent/system-prompt.js`
- Create: `src/agent/runtime.js`
- Test: `test/agent/runtime.test.js`

- [ ] **Step 1: Write the failing runtime test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { AgentRuntime } = require('../../src/agent/runtime');

test('AgentRuntime executes a tool call and returns a final answer', async () => {
  const providerOutputs = [
    { type: 'tool_call', callId: 'call_1', toolName: 'read_file', args: { path: 'README.md' } },
    { type: 'final_answer', content: 'Done.' },
  ];

  const runtime = new AgentRuntime({
    provider: { generate: async () => providerOutputs.shift() },
    tools: {
      get(name) {
        return {
          name,
          execute: async () => ({ content: '# Example' }),
        };
      },
      list() {
        return [];
      },
    },
  });

  const result = await runtime.respond([{ role: 'user', content: 'read the readme' }]);
  assert.equal(result.output.content, 'Done.');
  assert.equal(result.trace.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/agent/runtime.test.js`
Expected: FAIL because `src/agent/runtime.js` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```js
class AgentRuntime {
  async respond(messages) {
    const trace = [];
    const workingMessages = [...messages];

    for (let step = 0; step < this.maxSteps; step += 1) {
      const action = await this.provider.generate({
        messages: workingMessages,
        tools: this.tools.list(),
      });

      if (action.type === 'tool_call') {
        const tool = this.tools.get(action.toolName);
        const result = await tool.execute(action.args);
        trace.push({ toolName: action.toolName, args: action.args, result });
        workingMessages.push({
          role: 'tool',
          toolName: action.toolName,
          callId: action.callId,
          content: JSON.stringify(result),
        });
        continue;
      }

      return { output: action, trace, messages: workingMessages };
    }

    throw new Error('Agent exceeded max steps');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/agent/runtime.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/system-prompt.js src/agent/runtime.js test/agent/runtime.test.js
git commit -m "feat: add prompt-driven agent runtime"
```

### Task 5: Build the CLI entrypoint and end-to-end smoke coverage

**Files:**
- Create: `src/cli/chat-cli.js`
- Create: `src/index.js`
- Test: `test/cli/chat-cli.test.js`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Write the failing CLI smoke test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { renderToolCall } = require('../../src/cli/chat-cli');

test('renderToolCall prints a readable status line', async () => {
  assert.match(renderToolCall({ toolName: 'read_file', args: { path: 'src/index.js' } }), /read_file/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cli/chat-cli.test.js`
Expected: FAIL because the CLI module does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```js
function renderToolCall({ toolName, args }) {
  return `[tool] ${toolName} ${JSON.stringify(args)}`;
}

async function startCli(deps) {
  // use readline/promises to read user input,
  // send it through AgentRuntime,
  // print tool trace and final output,
  // stop on :quit or EOF.
}
```

- [ ] **Step 4: Add startup wiring**

```js
#!/usr/bin/env node

const { startCli } = require('./cli/chat-cli');

startCli().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
```

- [ ] **Step 5: Run full tests**

Run: `npm test`
Expected: PASS with all test files green.

- [ ] **Step 6: Commit**

```bash
git add package.json README.md src/cli/chat-cli.js src/index.js test/cli/chat-cli.test.js
git commit -m "feat: ship terminal coding agent mvp"
```

