const test = require('node:test');
const assert = require('node:assert/strict');

const { ToolRegistry } = require('../../src/core/tool-registry');
const { AgentRuntime } = require('../../src/agent/runtime');

test('AgentRuntime executes a tool call and returns a final answer', async () => {
  const providerOutputs = [
    {
      type: 'tool_call',
      callId: 'call_1',
      toolName: 'read_file',
      args: { path: 'README.md' },
    },
    {
      type: 'final_answer',
      content: 'Done.',
    },
  ];

  const tools = new ToolRegistry();
  tools.register({
    name: 'read_file',
    description: 'Read a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
    },
    execute: async () => ({ content: '# Example' }),
  });

  const runtime = new AgentRuntime({
    provider: {
      generate: async () => providerOutputs.shift(),
    },
    tools,
  });

  const result = await runtime.respond([{ role: 'user', content: 'read the readme' }]);

  assert.equal(result.output.content, 'Done.');
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].toolName, 'read_file');
  assert.equal(result.messages.at(-1).role, 'tool');
});

test('AgentRuntime throws when it exceeds max steps', async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ content: 'x' }),
  });

  const runtime = new AgentRuntime({
    maxSteps: 1,
    provider: {
      generate: async () => ({
        type: 'tool_call',
        callId: 'call_1',
        toolName: 'read_file',
        args: {},
      }),
    },
    tools,
  });

  await assert.rejects(
    () => runtime.respond([{ role: 'user', content: 'loop forever' }]),
    /max steps/i,
  );
});

test('AgentRuntime rejects tool calls with schema-invalid arguments', async () => {
  const tools = new ToolRegistry();
  tools.register({
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

  const runtime = new AgentRuntime({
    provider: {
      generate: async () => ({
        type: 'tool_call',
        callId: 'call_1',
        toolName: 'write_file',
        args: { path: 'README.md' },
      }),
    },
    tools,
  });

  await assert.rejects(
    () => runtime.respond([{ role: 'user', content: 'write a file' }]),
    /content/i,
  );
});

test('AgentRuntime logs provider, tool, and final-answer events', async () => {
  const events = [];
  const providerOutputs = [
    {
      type: 'tool_call',
      callId: 'call_1',
      toolName: 'read_file',
      args: { path: 'README.md' },
    },
    {
      type: 'final_answer',
      content: 'Done.',
    },
  ];

  const tools = new ToolRegistry();
  tools.register({
    name: 'read_file',
    description: 'Read a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
    execute: async () => ({ content: '# Example' }),
  });

  const runtime = new AgentRuntime({
    provider: {
      generate: async () => providerOutputs.shift(),
    },
    tools,
    logger: {
      log: async (entry) => {
        events.push(entry);
      },
    },
  });

  await runtime.respond([{ role: 'user', content: 'read the readme' }]);

  assert.deepEqual(
    events.map((entry) => entry.event),
    [
      'runtime.step.start',
      'provider.generate.start',
      'provider.generate.end',
      'tool.call.start',
      'tool.call.end',
      'runtime.step.end',
      'runtime.step.start',
      'provider.generate.start',
      'provider.generate.end',
      'assistant.final',
      'runtime.step.end',
    ],
  );
});
