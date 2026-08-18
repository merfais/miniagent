import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages';

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

function formatMessages(messages: UMessage[]): MessageParam[] {
  return messages.map((msg) => ({
    role: msg.role,
    content: msg.content.map((block): ContentBlockParam => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text };
      }
      if (block.type === 'tool_use') {
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      }
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: block.content,
        ...(block.isError ? { is_error: true } : {}),
      };
    }),
  }));
}

function formatTools(tools: UTool[]): Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.parameters as Tool['input_schema'],
  }));
}

function formatFinishReason(raw: Message['stop_reason'], logger: Logger): UStopReason {
  switch (raw) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    default:
      if (raw) {
        logger.info('anthropic.unknown-stop-reason', { raw });
      }
      return 'other';
  }
}

function formatResponse(res: Message, logger: Logger): UnifiedResponse {
  const content: UOutputBlock[] = [];
  for (const block of res.content) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      content.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      });
    } else {
      logger.info('anthropic.unknown-output-block', { type: block.type });
    }
  }
  if (content.length === 0) {
    logger.warn('anthropic.empty-response');
    return { content: [], stopReason: 'other', raw: res };
  }
  return {
    content,
    stopReason: formatFinishReason(res.stop_reason, logger),
    usage: {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
    },
    raw: res,
  };
}

export class AnthropicProvider implements Provider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly system: string;
  private readonly tools: UTool[];
  private readonly maxTokens: number;

  constructor(config: ProviderConstructorConfig) {
    this.model = config.model;
    this.system = config.system ?? '';
    this.tools = config.tools ?? [];
    this.maxTokens = config.maxTokens ?? 4096;
    this.client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseURL });
  }

  async generate(messages: UMessage[], options?: GenerateOptions): Promise<UnifiedResponse> {
    const logger = options?.logger ?? globalLogger;
    const params: MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: formatMessages(messages),
      ...(this.system !== '' ? { system: this.system } : {}),
      ...(this.tools.length > 0 ? { tools: formatTools(this.tools) } : {}),
    };
    const res = await this.client.messages.create(params);
    return formatResponse(res, logger);
  }
}
