import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry } from '../../src/core/tool-registry';
import type { ProviderAction } from '../../src/core/types';
import { AgentRuntime } from '../../src/agent/runtime';

function nextProviderOutput<T>(outputs: T[]): T {
  const output = outputs.shift();
  if (!output) {
    throw new Error('missing provider output');
  }

  return output;
}

test('AgentRuntime executes a tool call and returns a final answer', async () => {
  const providerOutputs: ProviderAction[] = [
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
      generate: async () => nextProviderOutput(providerOutputs),
    },
    tools,
  });

  const result = await runtime.respond([{ role: 'user', content: 'read the readme' }]);

  assert.equal(result.output.content, 'Done.');
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0]?.toolName, 'read_file');
  assert.equal(result.messages.at(-1)?.role, 'tool');
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
  const events: Array<Record<string, unknown>> = [];
  const providerOutputs: ProviderAction[] = [
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
      generate: async () => nextProviderOutput(providerOutputs),
    },
    tools,
    logger: {
      log: async (entry: Record<string, unknown>) => {
        events.push(entry);
        return entry;
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

test('AgentRuntime logs provider.generate.error when the provider throws', async () => {
  const events: Array<Record<string, unknown>> = [];
  const runtime = new AgentRuntime({
    provider: {
      generate: async () => {
        throw new Error('provider failed');
      },
    },
    tools: new ToolRegistry(),
    logger: {
      log: async (entry: Record<string, unknown>) => {
        events.push(entry);
        return entry;
      },
    },
  });

  await assert.rejects(
    () => runtime.respond([{ role: 'user', content: 'fail please' }]),
    /provider failed/,
  );

  assert.deepEqual(
    events.slice(-2).map((entry) => entry.event),
    ['provider.generate.error', 'runtime.step.end'],
  );
});

test('AgentRuntime logs tool.call.error when a tool throws', async () => {
  const events: Array<Record<string, unknown>> = [];
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
      log: async (entry: Record<string, unknown>) => {
        events.push(entry);
        return entry;
      },
    },
  });

  await assert.rejects(() => runtime.respond([{ role: 'user', content: 'read it' }]), /boom/);
  assert.deepEqual(
    events.slice(-2).map((entry) => entry.event),
    ['tool.call.error', 'runtime.step.end'],
  );
});

test('AgentRuntime trace preserves the tool call id', async () => {
  const providerOutputs: ProviderAction[] = [
    {
      type: 'tool_call',
      callId: 'call_123',
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
      generate: async () => nextProviderOutput(providerOutputs),
    },
    tools,
  });

  const result = await runtime.respond([{ role: 'user', content: 'read it' }]);
  assert.equal(result.trace[0]?.callId, 'call_123');
});

test('AgentRuntime preserves the original provider error when logging fails', async () => {
  const runtime = new AgentRuntime({
    provider: {
      generate: async () => {
        throw new Error('provider failed');
      },
    },
    tools: new ToolRegistry(),
    logger: {
      log: async (entry: Record<string, unknown>) => {
        if (entry.event === 'provider.generate.error') {
          throw new Error('log write failed');
        }

        return entry;
      },
    },
  });

  await assert.rejects(
    () => runtime.respond([{ role: 'user', content: 'fail please' }]),
    /provider failed/,
  );
});

test('AgentRuntime logs unknown tool failures as tool.call.error', async () => {
  const events: Array<Record<string, unknown>> = [];
  const runtime = new AgentRuntime({
    provider: {
      generate: async () => ({
        type: 'tool_call',
        callId: 'call_1',
        toolName: 'missing_tool',
        args: {},
      }),
    },
    tools: new ToolRegistry(),
    logger: {
      log: async (entry: Record<string, unknown>) => {
        events.push(entry);
        return entry;
      },
    },
  });

  await assert.rejects(
    () => runtime.respond([{ role: 'user', content: 'trigger unknown tool' }]),
    /Unknown tool: missing_tool/,
  );

  assert.deepEqual(
    events.slice(-3).map((entry) => entry.event),
    ['tool.call.start', 'tool.call.error', 'runtime.step.end'],
  );
});

test('AgentRuntime logs tool.call.error when tool result serialization fails', async () => {
  const events: Array<Record<string, unknown>> = [];
  const tools = new ToolRegistry();
  tools.register({
    name: 'bigint_tool',
    description: 'Return an unserializable payload',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ value: 1n }),
  });

  const runtime = new AgentRuntime({
    provider: {
      generate: async () => ({
        type: 'tool_call',
        callId: 'call_1',
        toolName: 'bigint_tool',
        args: {},
      }),
    },
    tools,
    logger: {
      log: async (entry: Record<string, unknown>) => {
        events.push(entry);
        return entry;
      },
    },
  });

  await assert.rejects(
    () => runtime.respond([{ role: 'user', content: 'serialize this' }]),
    /serialize a BigInt/,
  );

  assert.deepEqual(
    events.slice(-3).map((entry) => entry.event),
    ['tool.call.start', 'tool.call.error', 'runtime.step.end'],
  );
});
