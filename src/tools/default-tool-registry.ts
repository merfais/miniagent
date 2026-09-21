import { ToolRegistry } from '../core/tool-registry.js';
import { createFileTools } from './file-tools.js';
import { createShellTool } from './shell-tool.js';
import { createWebSearchTool } from './web-search-tool.js';
import type { FetchLike } from './web-search-tool.js';

export interface ToolRegistryFactoryOptions {
  fetchImpl?: FetchLike;
}

function registerFunctionTools(
  registry: ToolRegistry,
  definitions: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    needsApproval?: boolean;
  }>,
  methods: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
): void {
  for (const definition of definitions) {
    registry.register({
      ...definition,
      execute: (args) => methods[definition.name]!(args),
    });
  }
}

export function createDefaultToolRegistry({
  fetchImpl,
}: ToolRegistryFactoryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  const fileTools = createFileTools();
  const shellTool = createShellTool();
  const webSearchTool = createWebSearchTool({ fetchImpl });

  registerFunctionTools(
    registry,
    [
      {
        name: 'read_file',
        description: 'Read a UTF-8 text file in the workspace',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: 'Write a UTF-8 text file in the workspace',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
        needsApproval: true,
      },
      {
        name: 'list_files',
        description: 'List files inside a workspace directory',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
      {
        name: 'search_code',
        description: 'Search for a text query inside workspace files',
        parameters: {
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
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string' },
        cwd: { type: 'string' },
      },
      required: ['cmd'],
    },
    needsApproval: true,
    execute: shellTool.run_command,
  });

  registry.register({
    name: 'web_search',
    description: 'Search public web results for open-ended questions',
    parameters: {
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
