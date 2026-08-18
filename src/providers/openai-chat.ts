import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

import { logger as globalLogger, type Logger } from '../core/logger.js';
import type {
  GenerateOptions,
  Provider,
  ProviderConstructorConfig,
  UMessage,
  UOutputBlock,
  UStopReason,
  UTool,
  UnifiedResponse,
} from './types.js';

function parseToolArgs(text: string, toolName: string, logger: Logger): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fallthrough
  }
  logger.warn('openai-chat.tool-args-parse-error', { toolName });
  return { __raw: text, __parseError: true };
}

function formatMessages(system: string, messages: UMessage[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  if (system !== '') {
    out.push({ role: 'system', content: system });
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      for (const block of msg.content) {
        if (block.type === 'text') {
          out.push({ role: 'user', content: block.text });
        } else if (block.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: block.id, content: block.content });
        }
      }
      continue;
    }

    let toolRun: ChatCompletionMessageToolCall[] = [];
    const flushTools = () => {
      if (toolRun.length === 0) {
        return;
      }
      out.push({ role: 'assistant', content: null, tool_calls: toolRun });
      toolRun = [];
    };

    for (const block of msg.content) {
      if (block.type === 'text') {
        flushTools();
        out.push({ role: 'assistant', content: block.text });
      } else if (block.type === 'tool_use') {
        toolRun.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      }
    }
    flushTools();
  }
  return out;
}

function formatTools(tools: UTool[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters,
    },
  }));
}

function formatFinishReason(raw: string | null | undefined, logger: Logger): UStopReason {
  switch (raw) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'other';
    default:
      if (raw) {
        logger.info('openai-chat.unknown-finish-reason', { raw });
      }
      return 'other';
  }
}

function formatResponse(res: ChatCompletion, logger: Logger): UnifiedResponse {
  const choice = res.choices[0];
  const msg = choice?.message;
  const content: UOutputBlock[] = [];
  if (msg?.content) {
    content.push({ type: 'text', text: msg.content });
  }
  for (const call of msg?.tool_calls ?? []) {
    if (call.type !== 'function') {
      continue;
    }
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseToolArgs(call.function.arguments, call.function.name, logger),
    });
  }
  if (content.length === 0) {
    logger.warn('openai-chat.empty-response');
    return { content: [], stopReason: 'other', raw: res };
  }
  return {
    content,
    stopReason: formatFinishReason(choice?.finish_reason, logger),
    ...(res.usage
      ? {
          usage: {
            inputTokens: res.usage.prompt_tokens,
            outputTokens: res.usage.completion_tokens,
          },
        }
      : {}),
    raw: res,
  };
}

export class OpenAIChatProvider implements Provider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly system: string;
  private readonly tools: UTool[];
  private readonly maxTokens?: number;

  constructor(config: ProviderConstructorConfig) {
    this.model = config.model;
    this.system = config.system ?? '';
    this.tools = config.tools ?? [];
    this.maxTokens = config.maxTokens;
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  }

  async generate(messages: UMessage[], options?: GenerateOptions): Promise<UnifiedResponse> {
    const logger = options?.logger ?? globalLogger;
    const params: ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: formatMessages(this.system, messages),
      ...(this.tools.length > 0 ? { tools: formatTools(this.tools) } : {}),
      ...(this.maxTokens !== undefined ? { max_tokens: this.maxTokens } : {}),
    };
    const res = await this.client.chat.completions.create(params);
    return formatResponse(res, logger);
  }
}
