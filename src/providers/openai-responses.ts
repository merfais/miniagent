import OpenAI from 'openai';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
  ResponseOutputItem,
  Tool as ResponsesTool,
} from 'openai/resources/responses/responses';

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
  logger.warn('openai-responses.tool-args-parse-error', { toolName });
  return { __raw: text, __parseError: true };
}

function formatMessages(messages: UMessage[]): ResponseInputItem[] {
  const out: ResponseInputItem[] = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'text') {
        out.push({ role: msg.role, content: block.text });
      } else if (block.type === 'tool_use') {
        out.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === 'tool_result') {
        out.push({
          type: 'function_call_output',
          call_id: block.id,
          output: block.content,
        });
      }
    }
  }
  return out;
}

function formatTools(tools: UTool[]): ResponsesTool[] {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description ?? '',
    parameters: t.parameters,
    strict: false,
  }));
}

function formatFinishReason(res: Response, hasToolUse: boolean, logger: Logger): UStopReason {
  if (hasToolUse) {
    return 'tool_use';
  }
  if (res.incomplete_details?.reason === 'max_output_tokens') {
    return 'max_tokens';
  }
  if (res.status === 'completed') {
    return 'end_turn';
  }
  logger.info('openai-responses.unknown-status', { status: res.status });
  return 'other';
}

function formatResponse(res: Response, logger: Logger): UnifiedResponse {
  const content: UOutputBlock[] = [];
  let hasToolUse = false;
  for (const item of res.output ?? []) {
    if (item.type === 'function_call') {
      hasToolUse = true;
      content.push({
        type: 'tool_use',
        id: item.call_id,
        name: item.name,
        input: parseToolArgs(item.arguments, item.name, logger),
      });
    } else if (item.type === 'message') {
      for (const block of item.content ?? []) {
        if (block.type === 'output_text' && block.text) {
          content.push({ type: 'text', text: block.text });
        }
      }
    } else {
      logger.info('openai-responses.unknown-output-item', {
        type: (item as ResponseOutputItem).type,
      });
    }
  }
  if (content.length === 0) {
    logger.warn('openai-responses.empty-response');
    return { content: [], stopReason: 'other', raw: res };
  }
  return {
    content,
    stopReason: formatFinishReason(res, hasToolUse, logger),
    ...(res.usage
      ? {
          usage: {
            inputTokens: res.usage.input_tokens,
            outputTokens: res.usage.output_tokens,
          },
        }
      : {}),
    raw: res,
  };
}

export class OpenAIResponsesProvider implements Provider {
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
    const params: ResponseCreateParamsNonStreaming = {
      model: this.model,
      input: formatMessages(messages),
      ...(this.system !== '' ? { instructions: this.system } : {}),
      ...(this.tools.length > 0 ? { tools: formatTools(this.tools) } : {}),
      ...(this.maxTokens !== undefined ? { max_output_tokens: this.maxTokens } : {}),
    };
    const res = (await this.client.responses.create(params)) as Response;
    return formatResponse(res, logger);
  }
}
