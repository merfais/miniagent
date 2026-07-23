export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface BaseMessage {
  role: MessageRole;
  content: string;
}

export interface StandardMessage extends BaseMessage {
  role: 'system' | 'user' | 'assistant';
}

export interface ToolMessage extends BaseMessage {
  role: 'tool';
  toolName: string;
  callId: string;
}

export type Message = StandardMessage | ToolMessage;

export interface ToolInputProperty {
  type?: string;
}

export interface ToolInputSchema {
  type?: string;
  properties?: Record<string, ToolInputProperty>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: ToolInputSchema;
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface RegisteredTool extends ToolDefinition {
  validateArgs: (args: Record<string, unknown>) => void;
}

export interface ToolCallTrace {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface ToolCallAction {
  type: 'tool_call';
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface FinalAnswerAction {
  type: 'final_answer' | 'assistant_message';
  content: string;
}

export type ProviderAction = ToolCallAction | FinalAnswerAction;

export interface SessionLogger {
  sessionId: string;
  filePath: string;
  log(event: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface SessionMessageEntry {
  turn: number;
  message: Message;
}

export interface SessionMeta {
  activeSessionId: string | null;
  dailyIncrement: {
    date: string | null;
    value: number;
  };
}

export interface MessageHistoryRecord {
  type: 'message';
  turn: number;
  role: Message['role'];
  content: string;
  timestamp: string;
}

export interface ToolCallHistoryRecord {
  type: 'tool_call';
  turn: number;
  toolName: string;
  callId: string;
  args: Record<string, unknown>;
  timestamp: string;
}

export interface ToolResultHistoryRecord {
  type: 'tool_result';
  turn: number;
  toolName: string;
  callId: string;
  displaySummary: string;
  artifactRef?: string;
  timestamp: string;
}

export interface CompressionRecord {
  type: 'compression';
  sessionId: string;
  compressionId: string;
  appliedBeforeTurn: number;
  beforeMessageRef: string;
  summary: string;
  afterDigest: string;
  timestamp: string;
}

export type HistoryRecord =
  | MessageHistoryRecord
  | ToolCallHistoryRecord
  | ToolResultHistoryRecord
  | CompressionRecord;

export interface PendingCompressionRecord {
  sessionId: string;
  compressionId: string;
  appliedBeforeTurn: number;
  beforeMessageRef: string;
  summary?: string;
  afterDigest: string;
}
