import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages';

import { logger } from '../core/logger.js';
import type {
  ContentBlock,
  GenerateOptions,
  GenerateResult,
  Provider,
  ProviderInitOptions,
  ProviderMessage,
  StopReason,
  StreamChunk,
  ToolSchema,
  Usage,
} from './factory.js';

const PROVIDER_TAG = 'anthropic' as const;

function formatMessages(messages: readonly ProviderMessage[]): MessageParam[] {
  return messages.map((msg) => {
    const content: ContentBlockParam[] = [];
    msg.content.forEach((block) => {
      // 无 from 的 block 三家通用（text / tool_use / tool_result）；直接按结构映射。
      // role 语义校验：tool_use 仅 assistant，tool_result 仅 user。
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
        return;
      }
      if (block.type === 'tool_use') {
        if (msg.role !== 'assistant') {
          logger.warn('anthropic.drop-misplaced-tool-use', { role: msg.role });
          return;
        }
        content.push({
          type: 'tool_use',
          id: block.tool_use_id,
          name: block.name,
          input: block.input,
        });
        return;
      }
      if (block.type === 'tool_result') {
        if (msg.role !== 'user') {
          logger.warn('anthropic.drop-misplaced-tool-result', { role: msg.role });
          return;
        }
        content.push({
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: block.content,
          ...(block.is_error ? { is_error: true } : {}),
        });
        return;
      }
      // 带 from 的 block：过滤非本 provider 的来源，跨 provider 迁入的都打日志丢弃。
      if (block.from !== PROVIDER_TAG) {
        logger.warn('anthropic.drop-foreign-block', { type: block.type, from: block.from });
        return;
      }
      if (block.type === 'thinking') {
        // 有 signature 时按 Anthropic 契约原样回传；无 signature 说明 IR 采集不完整，丢弃。
        if (block.signature) {
          content.push({ type: 'thinking', thinking: block.text, signature: block.signature });
          return;
        }
        logger.warn('anthropic.drop-thinking-block', { reason: 'no-signature' });
        return;
      }
      if (block.type === 'redacted_thinking') {
        content.push({ type: 'redacted_thinking', data: block.data });
        return;
      }
      if (block.type === 'web_search_use') {
        content.push({
          type: 'server_tool_use',
          id: block.id,
          name: 'web_search',
          input: { query: block.query },
        });
        return;
      }
      if (block.type === 'web_search_result') {
        if (block.error) {
          content.push({
            type: 'web_search_tool_result',
            tool_use_id: block.tool_use_id,
            content: { type: 'web_search_tool_result_error', error_code: 'unavailable' },
          });
          return;
        }
        content.push({
          type: 'web_search_tool_result',
          tool_use_id: block.tool_use_id,
          content: block.results.map((r) => ({
            type: 'web_search_result',
            title: r.title,
            url: r.url,
            encrypted_content: r.encrypted_content,
            ...(r.page_age !== undefined ? { page_age: r.page_age } : {}),
          })),
        });
        return;
      }
      // 前面已过滤 foreign 且所有具名分支穷尽，此处 TS 判别联合收敛到 UnknownBlock；
      // raw 为同源 SDK 原生结构，透传给 Anthropic SDK 消费。
      logger.info('anthropic.passthrough-block', { type: block.type });
      content.push(block.raw as ContentBlockParam);
    });
    return { role: msg.role, content };
  });
}

function formatTools(tools: ToolSchema[]): Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.parameters as Tool['input_schema'],
  }));
}

// Anthropic `Message.stop_reason` 全集与 IR StopReason 的映射：
//   tool_use                        → tool_use
//   max_tokens                      → max_tokens
//   model_context_window_exceeded   → max_tokens（语义等价：输出被截断，均视为长度上限）
//   refusal                         → refusal（Claude 4.5+ 安全策略拒答）
// 归入 end_turn（不打日志，行为等价于自然结束）：
//   - end_turn         模型自然结束
//   - stop_sequence    调用方设置的 stop_sequences 命中
//   - null             流式尚未结束（当前非流式路径不应出现）
// 归入 end_turn 但打 info 日志（未识别，待扩展 IR 时补充）：
//   - pause_turn       server tools 中途暂停，需回传 assistant message 继续；当前项目不用 server tools
//   - 其它未来新增取值
function formatStopReason(raw: Message['stop_reason']): StopReason {
  switch (raw) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      // end_turn / stop_sequence / null / 其它 → 归一为 end_turn。
      if (raw && raw !== 'end_turn' && raw !== 'stop_sequence') {
        logger.info('anthropic.unknown-stop-reason', { raw });
      }
      return 'end_turn';
  }
}

function formatContent(res: Message): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of res.content) {
    if (block.type === 'text') {
      out.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking') {
      out.push({
        type: 'thinking',
        from: PROVIDER_TAG,
        text: block.thinking,
        signature: block.signature,
      });
    } else if (block.type === 'redacted_thinking') {
      // redacted_thinking：安全策略下模型思考被打码，无明文可展示；data 是加密串，回传时原样发回。
      out.push({ type: 'redacted_thinking', from: PROVIDER_TAG, data: block.data });
    } else if (block.type === 'tool_use') {
      out.push({
        type: 'tool_use',
        tool_use_id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      });
    } else if (block.type === 'server_tool_use') {
      // Anthropic server tool 调用：目前 IR 只针对 web_search 提取字段；其余走 unknown 透传。
      // TODO(agent-server-tool): Agent 循环需按 IR type 分支，此处不进 ToolRegistry。
      // TODO(ui-server-tool): session.UiSegment 未来展示 web_search 时读取 IR 字段。
      if (block.name === 'web_search') {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const query = typeof input.query === 'string' ? input.query : '';
        out.push({ type: 'web_search_use', from: PROVIDER_TAG, id: block.id, query });
      } else {
        out.push({ type: 'unknown', from: PROVIDER_TAG, raw: block });
      }
    } else if (block.type === 'web_search_tool_result') {
      const c = block.content;
      if (Array.isArray(c)) {
        out.push({
          type: 'web_search_result',
          from: PROVIDER_TAG,
          tool_use_id: block.tool_use_id,
          results: c.map((r) => ({
            title: r.title,
            url: r.url,
            encrypted_content: r.encrypted_content,
            ...(r.page_age !== null && r.page_age !== undefined ? { page_age: r.page_age } : {}),
          })),
        });
      } else {
        out.push({
          type: 'web_search_result',
          from: PROVIDER_TAG,
          tool_use_id: block.tool_use_id,
          results: [],
          error: c.error_code,
        });
      }
    } else {
      // 归入 unknown 的 Anthropic 原生 block（web_fetch_tool_result /
      // code_execution_tool_result / bash_code_execution_tool_result /
      // text_editor_code_execution_tool_result / tool_search_tool_result / container_upload
      // 以及未来新增类型）：raw 原样保存，formatMessages 透传回 SDK。
      logger.info('anthropic.unknown-output-block', { type: (block as { type: string }).type });
      out.push({ type: 'unknown', from: PROVIDER_TAG, raw: block });
    }
  }
  return out;
}

function toUsage(u: Message['usage']): Usage {
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
  };
}

export class AnthropicProvider implements Provider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly system: string;
  private tools: ToolSchema[];
  private readonly maxTokens: number;

  constructor(config: ProviderInitOptions) {
    this.model = config.model;
    this.system = config.system;
    this.tools = config.tools;
    this.maxTokens = config.maxTokens ?? 4096;
    this.client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseURL });
  }

  setTools(tools: ToolSchema[]): void {
    this.tools = tools;
  }

  async generate(
    messages: readonly ProviderMessage[],
    opts: GenerateOptions,
  ): Promise<GenerateResult> {
    const params: MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: formatMessages(messages),
      ...(this.system !== '' ? { system: this.system } : {}),
      ...(this.tools.length > 0 ? { tools: formatTools(this.tools) } : {}),
    };
    const res = await this.client.messages.create(params, { signal: opts.signal });
    return {
      content: formatContent(res),
      stopReason: formatStopReason(res.stop_reason),
      usage: toUsage(res.usage),
    };
  }

  // TODO(provider-stream): 用 client.messages.stream 接入真流式；
  // usage 分两次到达（message_start 给 input，message_delta 累积 output_tokens）。
  stream(messages: readonly ProviderMessage[], opts: GenerateOptions): AsyncIterable<StreamChunk> {
    void messages;
    void opts;
    throw new Error('AnthropicProvider.stream not implemented');
  }
}
