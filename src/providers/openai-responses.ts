import OpenAI from 'openai';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionWebSearch,
  ResponseInputItem,
  ResponseOutputItem,
  Tool as ResponsesTool,
} from 'openai/resources/responses/responses';

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

const PROVIDER_TAG = 'openai-responses' as const;

function parseToolArgs(text: string, toolName: string): Record<string, unknown> {
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

function formatMessages(messages: readonly ProviderMessage[]): ResponseInputItem[] {
  const out: ResponseInputItem[] = [];
  for (const msg of messages) {
    msg.content.forEach((block) => {
      // 无 from 的 block 三家通用（text / tool_use / tool_result）；直接按结构映射。
      // role 语义校验：tool_use 仅 assistant，tool_result 仅 user。
      if (block.type === 'text') {
        out.push({ role: msg.role, content: block.text });
        return;
      }
      if (block.type === 'tool_use') {
        if (msg.role !== 'assistant') {
          logger.warn('openai-responses.drop-misplaced-tool-use', { role: msg.role });
          return;
        }
        out.push({
          type: 'function_call',
          call_id: block.tool_use_id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
        return;
      }
      if (block.type === 'tool_result') {
        if (msg.role !== 'user') {
          logger.warn('openai-responses.drop-misplaced-tool-result', { role: msg.role });
          return;
        }
        out.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: block.content,
        });
        return;
      }
      // 带 from 的 block：过滤非本 provider 的来源，跨 provider 迁入的都打日志丢弃。
      if (block.from !== PROVIDER_TAG) {
        logger.warn('openai-responses.drop-foreign-block', {
          type: block.type,
          from: block.from,
        });
        return;
      }
      if (block.type === 'thinking') {
        // 回灌为 Responses 的 reasoning input item。summary 仅在有明文时携带（encrypted 模式无摘要）。
        const summary = block.text ? [{ type: 'summary_text' as const, text: block.text }] : [];
        out.push({
          type: 'reasoning',
          id: block.id ?? '',
          summary,
          ...(block.encrypted_content !== undefined && block.encrypted_content !== null
            ? { encrypted_content: block.encrypted_content }
            : {}),
        });
        return;
      }
      if (block.type === 'web_search_call') {
        // 由 IR 字段重建 SDK 结构；action 字段按 action_type 组装。
        let action: ResponseFunctionWebSearch['action'];
        if (block.action_type === 'search') {
          action = { type: 'search', ...(block.queries ? { queries: block.queries } : {}) };
        } else if (block.action_type === 'open_page') {
          action = { type: 'open_page', url: block.url ?? '' };
        } else {
          action = { type: 'find_in_page', url: block.url ?? '', pattern: block.pattern ?? '' };
        }
        out.push({ type: 'web_search_call', id: block.id, status: block.status, action });
        return;
      }
      if (block.type === 'mcp_call') {
        out.push({
          type: 'mcp_call',
          id: block.id,
          server_label: block.server_label,
          name: block.name,
          arguments: JSON.stringify(block.input),
          ...(block.output !== undefined ? { output: block.output } : {}),
          ...(block.error !== undefined ? { error: block.error } : {}),
          ...(block.status !== undefined ? { status: block.status } : {}),
          ...(block.approval_request_id !== undefined
            ? { approval_request_id: block.approval_request_id }
            : {}),
        });
        return;
      }
      if (block.type === 'mcp_list_tools') {
        out.push({
          type: 'mcp_list_tools',
          id: block.id,
          server_label: block.server_label,
          tools: block.tools.map((t) => ({
            name: t.name,
            input_schema: t.input_schema,
            ...(t.description !== undefined ? { description: t.description } : {}),
            ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
          })),
          ...(block.error !== undefined ? { error: block.error } : {}),
        });
        return;
      }
      if (block.type === 'mcp_approval_request') {
        out.push({
          type: 'mcp_approval_request',
          id: block.id,
          server_label: block.server_label,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
        return;
      }
      if (block.type === 'mcp_approval_response') {
        out.push({
          type: 'mcp_approval_response',
          approval_request_id: block.approval_request_id,
          approve: block.approve,
          ...(block.reason !== undefined ? { reason: block.reason } : {}),
        });
        return;
      }
      if (block.type === 'refusal') {
        // Responses input 侧 ResponseInputContent 仅支持 text/image/file，
        // 无法回灌 refusal content part；打日志丢弃，refusal 仅供 UI 展示。
        logger.warn('openai-responses.drop-refusal-block', {});
        return;
      }
      // 前面已过滤 foreign 且所有具名分支穷尽，此处 TS 判别联合收敛到 UnknownBlock；
      // raw 为同源 SDK 原生结构，透传给 Responses SDK 消费。
      logger.info('openai-responses.passthrough-block', { type: block.type });
      out.push(block.raw as ResponseInputItem);
    });
  }
  return out;
}

function formatTools(tools: ToolSchema[]): ResponsesTool[] {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description ?? '',
    parameters: t.parameters,
    strict: false,
  }));
}

// OpenAI Responses 无单一 finish_reason 字段，结束语义分散在多处，判定顺序：
//   1) `res.output[]` 中存在 `type: 'function_call'` 条目 → tool_use
//   2) `res.incomplete_details.reason`：
//        - 'max_output_tokens' → max_tokens
//        - 'content_filter'    → refusal
//   3) 其余归入 end_turn；若 `res.status !== 'completed'` 额外打 info 日志。
// 归入 end_turn 但打 info 日志（未识别，待扩展 IR 时补充）：
//   - status: failed / cancelled  异常路径，理论上 SDK 应抛错；即便落到这里当前也无独立业务行为
//   - incomplete_details.reason 的其它取值 / 未来新增 status
function formatStopReason(res: Response): StopReason {
  if (res.output?.some((item) => item.type === 'function_call')) {
    return 'tool_use';
  }
  const reason = res.incomplete_details?.reason;
  if (reason === 'max_output_tokens') {
    return 'max_tokens';
  }
  if (reason === 'content_filter') {
    return 'refusal';
  }
  if (res.status !== 'completed') {
    logger.info('openai-responses.unknown-status', { status: res.status });
  }
  return 'end_turn';
}

function formatContent(res: Response): ContentBlock[] {
  const content: ContentBlock[] = [];
  for (const item of res.output ?? []) {
    if (item.type === 'function_call') {
      content.push({
        type: 'tool_use',
        tool_use_id: item.call_id,
        name: item.name,
        input: parseToolArgs(item.arguments, item.name),
      });
    } else if (item.type === 'message') {
      for (const block of item.content ?? []) {
        if (block.type === 'output_text' && block.text) {
          content.push({ type: 'text', text: block.text });
        } else if (block.type === 'refusal' && block.refusal) {
          // refusal 单独建模：Responses input 侧不支持回灌，formatMessages 会丢弃，仅供 UI。
          content.push({ type: 'refusal', from: PROVIDER_TAG, text: block.refusal });
        }
      }
    } else if (item.type === 'reasoning') {
      // Responses API 对 o 系列推理模型可能返回 reasoning summary（明文摘要）；
      // 若未返回 summary（例如 encrypted 模式），退化为空 text。
      // 采集 id 与 encrypted_content 以便回灌为 reasoning input item。
      const text = (item.summary ?? [])
        .map((s) => (s.type === 'summary_text' ? s.text : ''))
        .filter((t) => t)
        .join('\n');
      content.push({
        type: 'thinking',
        from: PROVIDER_TAG,
        text,
        id: item.id,
        ...(item.encrypted_content !== undefined && item.encrypted_content !== null
          ? { encrypted_content: item.encrypted_content }
          : {}),
      });
    } else if (item.type === 'web_search_call') {
      // TODO(agent-server-tool): Agent 循环需按 IR type 处理，不进 ToolRegistry。
      // TODO(ui-server-tool): session.UiSegment 未来展示 web_search 时读取 IR 字段。
      const a = item.action;
      if (a.type === 'search') {
        content.push({
          type: 'web_search_call',
          from: PROVIDER_TAG,
          id: item.id,
          action_type: 'search',
          ...(a.queries !== undefined ? { queries: a.queries } : {}),
          status: item.status,
        });
      } else if (a.type === 'open_page') {
        content.push({
          type: 'web_search_call',
          from: PROVIDER_TAG,
          id: item.id,
          action_type: 'open_page',
          ...(a.url ? { url: a.url } : {}),
          status: item.status,
        });
      } else {
        content.push({
          type: 'web_search_call',
          from: PROVIDER_TAG,
          id: item.id,
          action_type: 'find_in_page',
          url: a.url,
          pattern: a.pattern,
          status: item.status,
        });
      }
    } else if (item.type === 'mcp_call') {
      content.push({
        type: 'mcp_call',
        from: PROVIDER_TAG,
        id: item.id,
        server_label: item.server_label,
        name: item.name,
        input: parseToolArgs(item.arguments, item.name),
        ...(item.output !== undefined ? { output: item.output } : {}),
        ...(item.error !== undefined ? { error: item.error } : {}),
        ...(item.status !== undefined ? { status: item.status } : {}),
        ...(item.approval_request_id !== undefined
          ? { approval_request_id: item.approval_request_id }
          : {}),
      });
    } else if (item.type === 'mcp_list_tools') {
      content.push({
        type: 'mcp_list_tools',
        from: PROVIDER_TAG,
        id: item.id,
        server_label: item.server_label,
        tools: item.tools.map((t) => ({
          name: t.name,
          input_schema: t.input_schema,
          ...(t.description !== undefined ? { description: t.description } : {}),
          ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
        })),
        ...(item.error !== undefined ? { error: item.error } : {}),
      });
    } else if (item.type === 'mcp_approval_request') {
      content.push({
        type: 'mcp_approval_request',
        from: PROVIDER_TAG,
        id: item.id,
        server_label: item.server_label,
        name: item.name,
        input: parseToolArgs(item.arguments, item.name),
      });
    } else {
      // 归入 unknown 的 OpenAI Responses 原生 item（file_search_call / computer_call /
      // code_interpreter_call / image_generation_call / local_shell_call 以及未来新增类型）：
      // raw 原样保存，formatMessages 透传回 SDK。
      logger.info('openai-responses.unknown-output-item', {
        type: (item as ResponseOutputItem).type,
      });
      content.push({ type: 'unknown', from: PROVIDER_TAG, raw: item });
    }
  }
  return content;
}

function toUsage(u: Response['usage']): Usage {
  return {
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
  };
}

export class OpenAIResponsesProvider implements Provider {
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
    const params: ResponseCreateParamsNonStreaming = {
      model: this.model,
      input: formatMessages(messages),
      ...(this.system !== '' ? { instructions: this.system } : {}),
      ...(this.tools.length > 0 ? { tools: formatTools(this.tools) } : {}),
      ...(this.maxTokens !== undefined ? { max_output_tokens: this.maxTokens } : {}),
    };
    const res = (await this.client.responses.create(params, {
      signal: opts.signal,
    })) as Response;
    return {
      content: formatContent(res),
      stopReason: formatStopReason(res),
      usage: toUsage(res.usage),
    };
  }

  // TODO(provider-stream): 用 client.responses.stream 接入真流式；
  // usage 仅在 response.completed 事件里出现一次全量值。
  stream(messages: readonly ProviderMessage[], opts: GenerateOptions): AsyncIterable<StreamChunk> {
    void messages;
    void opts;
    throw new Error('OpenAIResponsesProvider.stream not implemented');
  }
}
