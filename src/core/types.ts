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
