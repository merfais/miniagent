import type { ProviderConfig } from '../config/app-config.js';
import { logger } from '../core/logger.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIChatProvider } from './openai-chat.js';
import { OpenAIResponsesProvider } from './openai-responses.js';

// `from` 字段：标记该 block 由哪个 provider 产生，供跨 provider 场景下 formatMessages 过滤。
// 三家均可无损互转的 block（text / tool_use / tool_result）不带 from；仅部分 provider 支持
// 的 block 带 from：若两个 OpenAI API 都支持则可省略 openai-chat（值仅 2 种），否则枚举 3 种。
// from 与 unknown.raw 各自解决不同问题：from 用于跨家过滤（判定同源），
// unknown.raw 用于 IR 未建模的同源结构透传；二者互补，不冗余。
export type ProviderTag = 'anthropic' | 'openai-chat' | 'openai-responses';

export type TextBlock = { type: 'text'; text: string };
// ThinkingBlock：对上层 agent 循环 / UI 侧屏蔽 provider 差异——三家 thinking 语义等价，
// 上层只关心 `text`（明文摘要，可能为空）。以下字段仅供 provider 内部 round-trip，上层不应读取：
//   signature          Anthropic extended thinking 回传签名；
//   id                 OpenAI Responses reasoning item 的 id（回灌必需）；
//   encrypted_content  OpenAI Responses reasoning 的加密内容（启用 include 时下发）。
// openai-chat 不支持 reasoning input，故 from 只有两种取值。
export type ThinkingBlock = {
  type: 'thinking';
  from: 'anthropic' | 'openai-responses';
  text: string;
  signature?: string;
  id?: string;
  encrypted_content?: string | null;
};
// Anthropic redacted_thinking：安全策略下模型思考被打码，无明文；仅有加密 data 需原样回传。
// 单独建模避免与 thinking 混淆（回传时结构不同：redacted_thinking.data vs thinking.signature）。
export type RedactedThinkingBlock = {
  type: 'redacted_thinking';
  from: 'anthropic';
  data: string;
};
export type ToolUseBlock = {
  type: 'tool_use';
  tool_use_id: string;
  name: string;
  input: Record<string, unknown>;
};
export type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

// ---- web_search ----
// Anthropic 用两个 block（`server_tool_use(name='web_search')` + `web_search_tool_result`）；
// OpenAI Responses 用一个 `web_search_call`。结构差异较大，各自保留一种 IR block。
// 消费方（Agent 循环、UI）需要展示模型查了什么 / 返回了什么，因此提取核心字段；
// 回传时按字段在各自 provider 的 formatMessages 重建 SDK 结构。

export type WebSearchUseBlock = {
  // 对应 Anthropic 的 `server_tool_use(name='web_search')`。
  type: 'web_search_use';
  from: 'anthropic';
  id: string;
  query: string;
};

export type WebSearchResultItem = {
  title: string;
  url: string;
  // Anthropic web_search_tool_result 回传时必需的签名字段；同源 round-trip 必然存在。
  encrypted_content: string;
  page_age?: string | null;
};

export type WebSearchResultBlock = {
  // 对应 Anthropic 的 `web_search_tool_result`。
  type: 'web_search_result';
  from: 'anthropic';
  tool_use_id: string;
  results: WebSearchResultItem[];
  error?: string;
};

export type WebSearchCallBlock = {
  // 对应 OpenAI Responses 的 `web_search_call`（含 action 与 status）。
  type: 'web_search_call';
  from: 'openai-responses';
  id: string;
  action_type: 'search' | 'open_page' | 'find_in_page';
  queries?: string[];
  url?: string;
  pattern?: string;
  status: 'in_progress' | 'searching' | 'completed' | 'failed';
};

// ---- refusal / annotations（OpenAI 系列）----
// OpenAI Chat assistant message 顶层含 `refusal` 与 `annotations` 两个字段；
// OpenAI Responses output message 内容里也有 `refusal` content part。
// RefusalBlock 覆盖两家，但回传行为按 from 分流（不对称）：
//   - openai-chat       回传时映射到 assistant.refusal 顶层字段。
//   - openai-responses  input 侧 ResponseInputContent 只支持 text/image/file，
//                       无法回灌 refusal，formatMessages 丢弃并打日志，仅供 UI。
export type RefusalBlock = {
  type: 'refusal';
  from: 'openai-chat' | 'openai-responses';
  text: string;
};

export type UrlCitation = {
  url: string;
  title: string;
  start_index: number;
  end_index: number;
};

// UrlCitationBlock（openai-chat 专有）：web_search 引用元数据；
// ChatCompletionAssistantMessageParam 不接收 annotations，仅供 UI 展示，回传时丢弃。
export type UrlCitationBlock = {
  type: 'url_citation';
  from: 'openai-chat';
  citations: UrlCitation[];
};

// ---- MCP（OpenAI Responses 托管 MCP，4 个 block 闭环）----
// TODO(anthropic-mcp): Anthropic 稳定版 SDK 未收录 mcp_tool_use / mcp_tool_result，
// 未来切 beta 或 SDK 升级后在此扩展。

export type McpListToolsTool = {
  name: string;
  input_schema: unknown;
  description?: string | null;
  annotations?: unknown | null;
};

export type McpListToolsBlock = {
  type: 'mcp_list_tools';
  from: 'openai-responses';
  id: string;
  server_label: string;
  tools: McpListToolsTool[];
  error?: string | null;
};

export type McpCallBlock = {
  type: 'mcp_call';
  from: 'openai-responses';
  id: string;
  server_label: string;
  name: string;
  // 原生 API 里 arguments 是 JSON 字符串；这里解析为对象方便消费，回传时序列化回字符串。
  input: Record<string, unknown>;
  output?: string | null;
  error?: string | null;
  status?: 'in_progress' | 'completed' | 'incomplete' | 'calling' | 'failed';
  approval_request_id?: string | null;
};

export type McpApprovalRequestBlock = {
  type: 'mcp_approval_request';
  from: 'openai-responses';
  id: string;
  server_label: string;
  name: string;
  input: Record<string, unknown>;
};

export type McpApprovalResponseBlock = {
  // Agent 侧生成，回传给 provider；闭合 mcp_approval_request。
  type: 'mcp_approval_response';
  from: 'openai-responses';
  approval_request_id: string;
  approve: boolean;
  reason?: string;
};

// ---- unknown 兜底 ----
// 承载所有未被单独定义 IR 的 provider 原生 block。formatContent 归入本类型只做透传，
// formatMessages 拿 raw 原样回传给 SDK（跨 provider 迁移时若结构不匹配由 SDK 报错）。
//   Anthropic：web_fetch_tool_result / code_execution_tool_result /
//              bash_code_execution_tool_result / text_editor_code_execution_tool_result /
//              tool_search_tool_result / container_upload
//   OpenAI Responses：file_search_call / computer_call / code_interpreter_call /
//              image_generation_call / local_shell_call
// 例外：openai-chat assistant message 是扁平对象、无 item 概念，无法透传 raw，
// 其 formatMessages 对 unknown 一律 drop + warn（不产生同源 unknown 输出）。
export type UnknownBlock = {
  type: 'unknown';
  from: ProviderTag;
  raw: unknown;
};

// IR ContentBlock：Provider 与 Agent 之间的中立表示。
// invariant（类型层松散，由约定保证）：
//   ToolUseBlock / ThinkingBlock 仅出现在 assistant content；
//   ToolResultBlock 仅出现在 user content。
//
// 建具名 IR 的判据：
//   仅当 Agent 循环（含 UI 展示侧）需要感知、参与决策、且跨 provider 可归一的语义，
//   才为其建具名 IR block；否则一律走 UnknownBlock 由 raw 透传。
//   典型具名场景：thinking（UI 展示）、web_search_*（UI 展示模型查了什么）、
//   mcp_*（agent 循环感知 MCP 生命周期与 approval 决策）、refusal（UI 提示）。
//   典型 unknown 场景：file_search_call / code_interpreter_call / computer_call /
//   code_execution_tool_result 等 —— agent 不参与决策、UI 无需专属渲染，
//   仅需 provider 内部 round-trip 回传给 SDK。
export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | WebSearchUseBlock
  | WebSearchResultBlock
  | WebSearchCallBlock
  | RefusalBlock
  | UrlCitationBlock
  | McpListToolsBlock
  | McpCallBlock
  | McpApprovalRequestBlock
  | McpApprovalResponseBlock
  | UnknownBlock;

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolSchema {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

// Provider 对外 stopReason 只承认四值；其它状态在 provider 内部消化（详见各 provider 实现）。
//   end_turn   模型自然结束
//   tool_use   模型请求工具调用
//   max_tokens 输出长度上限
//   refusal    模型出于安全/内容策略拒答
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';

// Usage 只保留通用的 input/output tokens；各家私有维度（cache/reasoning）不暴露到 IR。
export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface GenerateResult {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
}

// 流式契约预留：Agent 当前只用 generate；stream 供未来 UI 流式渲染使用。
// usage 事件语义：cumulative=true 表示当次值是运行累计（Anthropic message_delta）；
// cumulative=false 表示当次值是全量（OpenAI 收尾一次）。done 事件必带最终完整 usage。
export type StreamChunk =
  | { type: 'content_start'; index: number; block: ContentBlock }
  | { type: 'text_delta'; index: number; text: string }
  | { type: 'thinking_delta'; index: number; text: string }
  | { type: 'tool_input_delta'; index: number; partialJson: string }
  | { type: 'content_stop'; index: number }
  | { type: 'usage'; usage: Usage; cumulative: boolean }
  | { type: 'done'; stopReason: StopReason; usage: Usage };

export interface ProviderInitOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
  system: string;
  tools: ToolSchema[];
  maxTokens?: number;
}

export interface GenerateOptions {
  signal: AbortSignal;
}

export interface Provider {
  generate(messages: readonly ProviderMessage[], opts: GenerateOptions): Promise<GenerateResult>;
  // 预留：真流式渲染入口。当前各 provider 实现抛 not-implemented；
  // 未来 UI 流式接入时按 §StreamChunk 契约实现。
  stream(messages: readonly ProviderMessage[], opts: GenerateOptions): AsyncIterable<StreamChunk>;
  setTools(tools: ToolSchema[]): void;
}

export interface CreateProviderOptions {
  system: string;
  tools: ToolSchema[];
}

export function createProvider(
  config: ProviderConfig | undefined,
  options: CreateProviderOptions,
): Provider | undefined {
  if (!config) {
    logger.error('missing provider config');
    return undefined;
  }
  if (!config.apiKey) {
    logger.error('missing provider.apiKey');
    return undefined;
  }
  if (!config.model) {
    logger.error('missing provider.model');
    return undefined;
  }

  const ctor: ProviderInitOptions = {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: config.model,
    system: options.system,
    tools: options.tools,
    ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
  };

  switch (config.type) {
    case 'openai-chat':
      return new OpenAIChatProvider(ctor);
    case 'openai-responses':
      return new OpenAIResponsesProvider(ctor);
    case 'anthropic':
      return new AnthropicProvider(ctor);
    default:
      logger.error(`unsupported provider type: ${(config as { type?: string }).type}`);
      return undefined;
  }
}
