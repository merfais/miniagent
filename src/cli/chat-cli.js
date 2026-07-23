const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const { AgentRuntime } = require('../agent/runtime');
const { SYSTEM_PROMPT } = require('../agent/system-prompt');
const { logEvent } = require('../core/logger');
const { createMessage } = require('../core/messages');
const { ToolRegistry } = require('../core/tool-registry');
const { createFileTools } = require('../tools/file-tools');
const { createShellTool } = require('../tools/shell-tool');
const { createWebSearchTool } = require('../tools/web-search-tool');

function renderToolCall({ toolName, args }) {
  return `[tool] ${toolName} ${JSON.stringify(args || {})}`;
}

function registerFunctionTools(registry, definitions, methods) {
  for (const definition of definitions) {
    registry.register({
      ...definition,
      execute: methods[definition.name],
    });
  }
}

function createDefaultToolRegistry({ workspaceRoot, fetchImpl }) {
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
    fileTools,
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

async function readUserMessage(rl) {
  try {
    const firstLine = await rl.question('you> ');
    if (!firstLine) {
      return '';
    }

    if (firstLine === ':multiline') {
      stdout.write('(multiline mode, finish with :end)\n');
      const lines = [];
      while (true) {
        const line = await rl.question('... ');
        if (line === ':end') {
          return lines.join('\n');
        }

        lines.push(line);
      }
    }

    return firstLine;
  } catch (error) {
    if (error && error.code === 'ERR_USE_AFTER_CLOSE') {
      return null;
    }

    throw error;
  }
}

function createRuntime({ provider, tools, logger }) {
  return new AgentRuntime({
    provider,
    tools,
    logger,
  });
}

async function startCli({
  input = stdin,
  output = stdout,
  provider,
  tools,
  logger,
  workspaceRoot = process.cwd(),
  fetchImpl = global.fetch,
  sessionStore,
} = {}) {
  const runtime = createRuntime({
    provider,
    tools: tools || createDefaultToolRegistry({ workspaceRoot, fetchImpl }),
    logger,
  });

  const rl = readline.createInterface({
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

  let sessionId = currentSession ? currentSession.sessionId : null;
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
  const multilineLines = [];
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
        await logEvent(logger, {
          event: 'process.error',
          error: error.message,
        });
        error.loggedToSession = true;
        throw error;
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

module.exports = {
  createDefaultToolRegistry,
  createRuntime,
  readUserMessage,
  renderToolCall,
  startCli,
};
