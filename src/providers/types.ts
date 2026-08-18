import type { Logger } from '../core/logger.js';

export type UBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean };

export interface UMessage {
  role: 'user' | 'assistant';
  content: UBlock[];
}

export interface UTool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export type UOutputBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export type UStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'other';

export interface UnifiedResponse {
  content: UOutputBlock[];
  stopReason: UStopReason;
  usage?: { inputTokens: number; outputTokens: number };
  raw?: unknown;
}

export interface ProviderConstructorConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  system?: string;
  tools?: UTool[];
  maxTokens?: number;
}

export interface GenerateOptions {
  logger?: Logger;
}

export interface Provider {
  generate(messages: UMessage[], options?: GenerateOptions): Promise<UnifiedResponse>;
}
