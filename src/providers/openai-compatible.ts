import type { Message, ProviderAction, ToolDefinition, ToolMessage } from '../core/types';

interface FunctionToolShape {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface NormalizedTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

interface FetchResponseLike {
  ok: boolean;
  status?: number;
  text?: () => Promise<string>;
  json: () => Promise<unknown>;
}

type FetchLike = (
  url: string,
  options: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<FetchResponseLike>;

interface GenerateOptions {
  messages: Message[];
  tools?: Array<FunctionToolShape | NormalizedTool>;
}

interface ProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: FetchLike;
  systemPrompt?: string;
}

export function normalizeTool(tool: FunctionToolShape): NormalizedTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || {
        type: 'object',
        properties: {},
      },
    },
  };
}

export function normalizeActionFromResponse(payload: unknown): ProviderAction {
  const response = payload as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: {
            name?: string;
            arguments?: string;
          };
        }>;
      };
    }>;
  };

  const choice = response?.choices?.[0];
  const message = choice?.message;

  if (!message) {
    throw new Error('Provider response does not contain a message');
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    const toolCall = message.tool_calls[0];
    return {
      type: 'tool_call',
      callId: toolCall?.id || 'call_1',
      toolName: toolCall?.function?.name || '',
      args: JSON.parse(toolCall?.function?.arguments || '{}') as Record<string, unknown>,
    };
  }

  if (typeof message.content === 'string' && message.content.trim() !== '') {
    return {
      type: 'final_answer',
      content: message.content,
    };
  }

  throw new Error('Provider response does not contain content or tool calls');
}

export function normalizeMessage(message: Message): Record<string, unknown> {
  if (message.role === 'tool') {
    const toolMessage = message as ToolMessage;
    return {
      role: 'tool',
      tool_call_id: toolMessage.callId,
      content: toolMessage.content,
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

export class OpenAiCompatibleProvider {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly fetchImpl: FetchLike;
  readonly systemPrompt: string;

  constructor({
    apiKey,
    baseUrl,
    model,
    fetchImpl = global.fetch as unknown as FetchLike,
    systemPrompt = '',
  }: ProviderOptions) {
    if (!apiKey) {
      throw new Error('apiKey is required');
    }

    if (!baseUrl) {
      throw new Error('baseUrl is required');
    }

    if (!model) {
      throw new Error('model is required');
    }

    if (typeof fetchImpl !== 'function') {
      throw new Error('fetchImpl must be a function');
    }

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.systemPrompt = systemPrompt;
  }

  buildMessages(messages: Message[]): Array<Record<string, unknown>> {
    const providerMessages = messages.map(normalizeMessage);

    if (!this.systemPrompt) {
      return providerMessages;
    }

    return [
      {
        role: 'system',
        content: this.systemPrompt,
      },
      ...providerMessages,
    ];
  }

  async generate({ messages, tools }: GenerateOptions): Promise<ProviderAction> {
    const normalizedTools = (tools || []).map((tool) => {
      if ('type' in tool && tool.type === 'function' && 'function' in tool) {
        return tool as NormalizedTool;
      }

      return normalizeTool(tool as ToolDefinition);
    });

    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: this.buildMessages(messages),
        tools: normalizedTools,
      }),
    });

    if (!response.ok) {
      const body = typeof response.text === 'function' ? await response.text() : '';
      throw new Error(`Provider request failed: ${response.status || 'unknown'} ${body}`.trim());
    }

    return normalizeActionFromResponse(await response.json());
  }
}
