import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Readable } from 'node:stream';
import type { Interface as ReadlineInterface } from 'node:readline';

import { AgentRuntime } from '../agent/runtime.js';
import { SYSTEM_PROMPT } from '../agent/system-prompt.js';
import { logEvent } from '../core/logger.js';
import { createMessage } from '../core/messages.js';
import { ToolRegistry } from '../core/tool-registry.js';
import type { Message, SessionLogger, ToolDefinition, ToolInputSchema } from '../core/types.js';
import { createFileTools } from '../tools/file-tools.js';
import { createShellTool } from '../tools/shell-tool.js';
import { createWebSearchTool } from '../tools/web-search-tool.js';
import type { FetchLike } from '../tools/web-search-tool.js';

interface ToolRegistryFactoryOptions {
  workspaceRoot: string;
  fetchImpl?: FetchLike;
}

interface SessionStoreLike {
  loadActiveSession(): Promise<{
    sessionId: string;
    messages: Message[];
    nextTurn: number;
  } | null>;
  createSession(options: { initialMessages: Message[] }): Promise<{
    sessionId: string;
    messages: Message[];
    nextTurn: number;
  }>;
  persistCompletedTurn(options: {
    sessionId: string;
    turn: number;
    userMessage: Message;
    assistantMessage: Message;
    toolTrace: Array<{
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
      result: unknown;
    }>;
  }): Promise<{
    messages: Message[];
    nextTurn: number;
  }>;
}

interface StartCliOptions {
  input?: Readable;
  output?: NodeJS.WritableStream;
  provider: {
    generate(args: {
      messages: Message[];
      tools: ToolDefinition[];
    }): Promise<{ type: 'tool_call'; callId: string; toolName: string; args: Record<string, unknown> } | { type: 'final_answer' | 'assistant_message'; content: string }>;
  };
  tools?: ToolRegistry;
  logger?: Pick<SessionLogger, 'log'> | null;
  workspaceRoot?: string;
  fetchImpl?: FetchLike;
  sessionStore?: SessionStoreLike;
}

export function renderToolCall({
  toolName,
  args,
}: {
  toolName: string;
  args: Record<string, unknown>;
}): string {
  return `[tool] ${toolName} ${JSON.stringify(args || {})}`;
}

function registerFunctionTools(
  registry: ToolRegistry,
  definitions: Array<{
    name: string;
    description: string;
    inputSchema: ToolInputSchema;
  }>,
  methods: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
): void {
  for (const definition of definitions) {
    registry.register({
      ...definition,
      execute: methods[definition.name]!,
    });
  }
}

export function createDefaultToolRegistry({
  workspaceRoot,
  fetchImpl,
}: ToolRegistryFactoryOptions): ToolRegistry {
  const registry = new ToolRegistry();
  const fileTools = createFileTools({ workspaceRoot });
  const shellTool = createShellTool({ workspaceRoot });
  const webSearchTool = createWebSearchTool({ fetchImpl });

  registerFunctionTools(
    registry,
    [
      {
        name: 'read_file',
        description: 'Read a UTF-8 text file in the workspace',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: 'Write a UTF-8 text file in the workspace',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'list_files',
        description: 'List files inside a workspace directory',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
      {
        name: 'search_code',
        description: 'Search for a text query inside workspace files',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            path: { type: 'string' },
          },
          required: ['query'],
        },
      },
    ],
    fileTools as unknown as Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  );

  registry.register({
    name: 'run_command',
    description: 'Run a safe shell command inside the workspace',
    inputSchema: {
      type: 'object',
      properties: {
        cmd: { type: 'string' },
        cwd: { type: 'string' },
      },
      required: ['cmd'],
    },
    execute: shellTool.run_command,
  });

  registry.register({
    name: 'web_search',
    description: 'Search public web results for open-ended questions',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
    execute: webSearchTool.web_search,
  });

  return registry;
}

export function createRuntime({
  provider,
  tools,
  logger,
}: {
  provider: StartCliOptions['provider'];
  tools: ToolRegistry;
  logger?: Pick<SessionLogger, 'log'> | null;
}): AgentRuntime {
  return new AgentRuntime({
    provider,
    tools,
    logger,
  });
}

export async function startCli({
  input = stdin,
  output = stdout,
  provider,
  tools,
  logger,
  workspaceRoot = process.cwd(),
  fetchImpl = global.fetch,
  sessionStore,
}: StartCliOptions): Promise<void> {
  const runtime = createRuntime({
    provider,
    tools: tools || createDefaultToolRegistry({ workspaceRoot, fetchImpl }),
    logger,
  });

  const rl: ReadlineInterface = readline.createInterface({
    input,
    output,
  });

  const restoredSession = sessionStore ? await sessionStore.loadActiveSession() : null;
  const currentSession =
    restoredSession ||
    (sessionStore
      ? await sessionStore.createSession({
          initialMessages: [createMessage('system', SYSTEM_PROMPT)],
        })
      : null);

  const sessionId = currentSession ? currentSession.sessionId : null;
  let nextTurn = currentSession ? currentSession.nextTurn : 1;
  let messages = currentSession
    ? currentSession.messages
    : [createMessage('system', SYSTEM_PROMPT)];

  output.write('MiniAgent ready. Type :quit to exit. Use :multiline for multi-line input.\n');
  await logEvent(logger, { event: 'session.start' });
  rl.setPrompt('you> ');
  rl.prompt();

  let saidBye = false;
  let multiline = false;
  const multilineLines: string[] = [];
  try {
    for await (const line of rl) {
      let userInput = line;

      if (multiline) {
        if (line === ':end') {
          userInput = multilineLines.splice(0).join('\n');
          multiline = false;
          rl.setPrompt('you> ');
        } else {
          multilineLines.push(line);
          rl.setPrompt('... ');
          rl.prompt();
          continue;
        }
      } else if (line === ':multiline') {
        multiline = true;
        output.write('(multiline mode, finish with :end)\n');
        rl.setPrompt('... ');
        rl.prompt();
        continue;
      }

      if (userInput === ':quit') {
        output.write('Bye.\n');
        saidBye = true;
        break;
      }

      if (!userInput) {
        rl.prompt();
        continue;
      }

      const userMessage = createMessage('user', userInput);
      messages.push(userMessage);
      let result;
      try {
        result = await runtime.respond(messages);
      } catch (error) {
        const runtimeError = error instanceof Error ? error : new Error(String(error));
        await logEvent(logger, {
          event: 'process.error',
          error: runtimeError.message,
        });
        (runtimeError as Error & { loggedToSession?: boolean }).loggedToSession = true;
        throw runtimeError;
      }

      for (const entry of result.trace) {
        output.write(`${renderToolCall(entry)}\n`);
      }

      const assistantMessage = createMessage('assistant', result.output.content);
      output.write(`assistant> ${assistantMessage.content}\n`);

      if (sessionStore && sessionId) {
        const persisted = await sessionStore.persistCompletedTurn({
          sessionId,
          turn: nextTurn,
          userMessage,
          assistantMessage,
          toolTrace: result.trace,
        });

        messages = persisted.messages;
        nextTurn = persisted.nextTurn;
      } else {
        messages = [...result.messages, assistantMessage];
      }

      rl.prompt();
    }

    if (!saidBye) {
      output.write('Bye.\n');
    }
  } finally {
    await logEvent(logger, { event: 'session.end' });
    rl.close();
  }
}
