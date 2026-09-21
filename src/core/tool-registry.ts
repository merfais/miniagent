import type { ToolResultBlock, ToolSchema, ToolUseBlock } from '../providers/factory.js';

interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, { type?: string } | undefined>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  /** true = 每次调用前需向用户请求 approval。默认 false。 */
  needsApproval?: boolean;
  /** 单次执行超时（ms）。默认由 registry 提供，可按工具覆写。 */
  timeoutMs?: number;
  execute: (
    args: Record<string, unknown>,
    ctx: { signal: AbortSignal },
  ) => Promise<unknown> | unknown;
}

interface RegisteredTool extends Required<Pick<ToolDefinition, 'needsApproval'>> {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  timeoutMs: number;
  execute: ToolDefinition['execute'];
  validateArgs: (args: Record<string, unknown>) => string | null;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: ToolDefinition): void {
    if (!tool || typeof tool.name !== 'string' || tool.name.trim() === '') {
      throw new Error('Tool name is required');
    }
    if (typeof tool.execute !== 'function') {
      throw new Error(`Tool "${tool.name}" must define an execute function`);
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
      needsApproval: tool.needsApproval ?? false,
      timeoutMs: tool.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      execute: tool.execute,
      validateArgs: createArgsValidator(tool),
    });
  }

  listSchemas(): ToolSchema[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  needsApproval(name: string): boolean {
    return this.tools.get(name)?.needsApproval ?? false;
  }

  // 永不 throw。参数校验失败 / 执行异常 / 超时 → is_error=true 的 ToolResultBlock。
  // 外部 signal 只表示用户 abort；超时使用内部合成 signal，不污染用户取消语义。
  async run(toolUse: ToolUseBlock, opts: { signal: AbortSignal }): Promise<ToolResultBlock> {
    const tool = this.tools.get(toolUse.name);
    if (!tool) {
      return errResult(toolUse.tool_use_id, `Unknown tool: ${toolUse.name}`);
    }

    const validationErr = tool.validateArgs(toolUse.input);
    if (validationErr) {
      return errResult(toolUse.tool_use_id, validationErr);
    }

    const timeoutCtl = new AbortController();
    const composite = anySignal([opts.signal, timeoutCtl.signal]);
    const timer = setTimeout(() => timeoutCtl.abort(), tool.timeoutMs);
    try {
      const output = await Promise.resolve(tool.execute(toolUse.input, { signal: composite }));
      if (opts.signal.aborted) {
        return errResult(toolUse.tool_use_id, 'user cancelled');
      }
      if (timeoutCtl.signal.aborted) {
        return errResult(
          toolUse.tool_use_id,
          `tool "${toolUse.name}" timed out after ${tool.timeoutMs}ms`,
        );
      }
      const content = typeof output === 'string' ? output : safeStringify(output);
      return { type: 'tool_result', tool_use_id: toolUse.tool_use_id, content };
    } catch (error) {
      if (timeoutCtl.signal.aborted && !opts.signal.aborted) {
        return errResult(
          toolUse.tool_use_id,
          `tool "${toolUse.name}" timed out after ${tool.timeoutMs}ms`,
        );
      }
      const msg = error instanceof Error ? error.message : String(error);
      return errResult(toolUse.tool_use_id, msg);
    } finally {
      clearTimeout(timer);
    }
  }
}

function errResult(id: string, message: string): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: id, content: message, is_error: true };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctl.abort();
      return ctl.signal;
    }
    s.addEventListener('abort', () => ctl.abort(), { once: true });
  }
  return ctl.signal;
}

function createArgsValidator(
  tool: ToolDefinition,
): (args: Record<string, unknown>) => string | null {
  const schema = (tool.parameters ?? { type: 'object', properties: {} }) as JsonSchemaObject;

  return function validateArgs(args: Record<string, unknown> = {}): string | null {
    if (schema.type && schema.type !== 'object') {
      return `Tool "${tool.name}" must use an object input schema`;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return `Tool "${tool.name}" arguments must be an object`;
    }
    for (const field of schema.required ?? []) {
      if (!(field in args)) {
        return `Tool "${tool.name}" is missing required argument "${field}"`;
      }
    }
    for (const [key, value] of Object.entries(args)) {
      const propertySchema = (schema.properties ?? {})[key];
      if (!propertySchema || !propertySchema.type) {
        continue;
      }
      if (propertySchema.type === 'string' && typeof value !== 'string') {
        return `Tool "${tool.name}" argument "${key}" must be a string`;
      }
      if (propertySchema.type === 'number' && typeof value !== 'number') {
        return `Tool "${tool.name}" argument "${key}" must be a number`;
      }
      if (propertySchema.type === 'boolean' && typeof value !== 'boolean') {
        return `Tool "${tool.name}" argument "${key}" must be a boolean`;
      }
    }
    return null;
  };
}
