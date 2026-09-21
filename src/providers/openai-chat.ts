import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionContentPartText,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

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
  UrlCitation,
} from './factory.js';

const PROVIDER_TAG = 'openai-chat' as const;

function parseToolArgs(text: string, toolName: string): Record<string, unknown> {
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

function formatMessages(
  system: string,
  messages: readonly ProviderMessage[],
): ChatCompletionMessageParam[] {
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
          out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content });
        } else if (block.type === 'tool_use') {
          logger.warn('openai-chat.drop-misplaced-tool-use', { role: msg.role });
        }
      }
      continue;
    }

    // assistant 侧：把同一条 IR 消息里 text / tool_use / refusal 聚合成单条
    // ChatCompletionAssistantMessageParam（Chat API 允许 content/tool_calls/refusal 并存）。
    // 多个 text block 用 content parts 数组保留边界，避免拼接丢分段语义。
    const textParts: ChatCompletionContentPartText[] = [];
    const toolCalls: ChatCompletionMessageToolCall[] = [];
    let refusal: string | null = null;

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push({ type: 'text', text: block.text });
        continue;
      }
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.tool_use_id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
        continue;
      }
      if (block.type === 'tool_result') {
        // tool_result 属于 user 侧，assistant 消息不应携带；防御性丢弃并记录。
        logger.warn('openai-chat.drop-misplaced-tool-result', {});
        continue;
      }
      // 带 from 的 block：过滤非本 provider 的来源，跨 provider 迁入的都打日志丢弃。
      if (block.from !== PROVIDER_TAG) {
        logger.warn('openai-chat.drop-foreign-block', { type: block.type, from: block.from });
        continue;
      }
      if (block.type === 'refusal') {
        refusal = block.text;
        continue;
      }
      if (block.type === 'url_citation') {
        // annotations 是模型输出的引用元数据；ChatCompletionAssistantMessageParam
        // 没有 annotations 字段，无法回传，仅 UI 消费。此处静默丢弃（预期行为）。
        continue;
      }
      // 前面已过滤 foreign 且所有具名分支穷尽，此处 TS 判别联合收敛到 UnknownBlock。
      // Chat API 的 unknown block 无 SDK item 概念（assistant message 是扁平对象），
      // 无法透传，只能打日志丢弃。
      logger.warn('openai-chat.drop-unknown-block', { type: block.type });
    }

    if (textParts.length === 0 && toolCalls.length === 0 && refusal === null) {
      continue;
    }
    const assistant: ChatCompletionMessageParam = {
      role: 'assistant',
      content: textParts.length > 0 ? textParts : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(refusal !== null ? { refusal } : {}),
    };
    out.push(assistant);
  }
  return out;
}

function formatTools(tools: ToolSchema[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters,
    },
  }));
}

// OpenAI Chat `choice.finish_reason` 全集与 IR StopReason 的映射：
//   tool_calls       → tool_use
//   length           → max_tokens
//   content_filter   → refusal
// 归入 end_turn（不打日志）：
//   - stop           模型自然结束（含调用方 stop 参数命中，Chat API 不区分）
//   - null           流式尚未结束（当前非流式路径不应出现）
// 归入 end_turn 但打 info 日志（未识别，待扩展 IR 时补充）：
//   - function_call  旧式 function calling，已 deprecated；SDK 通常已转为 tool_calls
//   - 其它未来新增取值
function formatStopReason(raw: string | null | undefined): StopReason {
  switch (raw) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      if (raw && raw !== 'stop') {
        logger.info('openai-chat.unknown-finish-reason', { raw });
      }
      return 'end_turn';
  }
}

function formatContent(res: ChatCompletion): ContentBlock[] {
  const choice = res.choices[0];
  const msg = choice?.message;
  const content: ContentBlock[] = [];
  if (msg?.content) {
    content.push({ type: 'text', text: msg.content });
  }
  if (msg?.refusal) {
    // refusal 是模型的拒答说明；单独建模以便回传到 assistant.refusal 顶层字段。
    // finish_reason 已在 formatStopReason 里映射为 IR 的 'refusal'。
    content.push({ type: 'refusal', from: PROVIDER_TAG, text: msg.refusal });
  }
  for (const call of msg?.tool_calls ?? []) {
    if (call.type !== 'function') {
      // OpenAI Chat 的 tool_call.type 目前仅 'function' 一种；将来若引入 built-in 工具（如 custom tool 类型），
      // 需在此扩展。
      logger.info('openai-chat.unknown-tool-call-type', { type: call.type });
      continue;
    }
    content.push({
      type: 'tool_use',
      tool_use_id: call.id,
      name: call.function.name,
      input: parseToolArgs(call.function.arguments, call.function.name),
    });
  }
  if (msg?.annotations && msg.annotations.length > 0) {
    // annotations 是 web_search 引用元数据；ChatCompletionAssistantMessageParam
    // 不接收该字段，仅 UI 展示，不参与回传。
    const citations: UrlCitation[] = msg.annotations
      .filter((a) => a.type === 'url_citation')
      .map((a) => ({
        url: a.url_citation.url,
        title: a.url_citation.title,
        start_index: a.url_citation.start_index,
        end_index: a.url_citation.end_index,
      }));
    if (citations.length > 0) {
      content.push({ type: 'url_citation', from: PROVIDER_TAG, citations });
    }
  }
  // OpenAI Chat API assistant message 中当前不暴露以下类型（无需 IR 处理）：
  //   - reasoning / thinking 明文     Chat API 对 o 系列推理模型不返回思考内容（仅 Responses API 提供）
  //   - audio                         Chat Completions audio 输出（当前项目不启用）
  //   - function_call（旧式）         已 deprecated，SDK 通常转为 tool_calls
  return content;
}

function toUsage(u: ChatCompletion['usage']): Usage {
  return {
    input_tokens: u?.prompt_tokens ?? 0,
    output_tokens: u?.completion_tokens ?? 0,
  };
}

export class OpenAIChatProvider implements Provider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly system: string;
  private tools: ToolSchema[];
  private readonly maxTokens?: number;

  constructor(config: ProviderInitOptions) {
    this.model = config.model;
    this.system = config.system;
    this.tools = config.tools;
    this.maxTokens = config.maxTokens;
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  }

  setTools(tools: ToolSchema[]): void {
    this.tools = tools;
  }

  async generate(
    messages: readonly ProviderMessage[],
    opts: GenerateOptions,
  ): Promise<GenerateResult> {
    const params: ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: formatMessages(this.system, messages),
      ...(this.tools.length > 0 ? { tools: formatTools(this.tools) } : {}),
      ...(this.maxTokens !== undefined ? { max_tokens: this.maxTokens } : {}),
    };
    const res = await this.client.chat.completions.create(params, { signal: opts.signal });
    return {
      content: formatContent(res),
      stopReason: formatStopReason(res.choices[0]?.finish_reason),
      usage: toUsage(res.usage),
    };
  }

  // TODO(provider-stream): 用 stream:true + stream_options.include_usage 接入真流式；
  // usage 只在收尾 chunk 一次给出，需要在流末补 usage/done。
  stream(messages: readonly ProviderMessage[], opts: GenerateOptions): AsyncIterable<StreamChunk> {
    void messages;
    void opts;
    throw new Error('OpenAIChatProvider.stream not implemented');
  }
}
