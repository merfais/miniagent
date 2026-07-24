import type { RegisteredTool, ToolDefinition, ToolInputSchema } from './types.js';

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
      ...tool,
      validateArgs: createArgsValidator(tool),
    });
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }
}

function createArgsValidator(tool: ToolDefinition): (args?: Record<string, unknown>) => void {
  const schema: ToolInputSchema = tool.inputSchema || { type: 'object', properties: {} };

  return function validateArgs(args: Record<string, unknown> = {}): void {
    if (schema.type && schema.type !== 'object') {
      throw new Error(`Tool "${tool.name}" must use an object input schema`);
    }

    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error(`Tool "${tool.name}" arguments must be an object`);
    }

    const requiredFields = schema.required || [];
    for (const field of requiredFields) {
      if (!(field in args)) {
        throw new Error(`Tool "${tool.name}" is missing required argument "${field}"`);
      }
    }

    const properties = schema.properties || {};
    for (const [key, value] of Object.entries(args)) {
      const propertySchema = properties[key];
      if (!propertySchema || !propertySchema.type) {
        continue;
      }

      if (propertySchema.type === 'string' && typeof value !== 'string') {
        throw new Error(`Tool "${tool.name}" argument "${key}" must be a string`);
      }

      if (propertySchema.type === 'number' && typeof value !== 'number') {
        throw new Error(`Tool "${tool.name}" argument "${key}" must be a number`);
      }

      if (propertySchema.type === 'boolean' && typeof value !== 'boolean') {
        throw new Error(`Tool "${tool.name}" argument "${key}" must be a boolean`);
      }
    }
  };
}
