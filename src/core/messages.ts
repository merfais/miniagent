import type { Message, MessageRole, ToolMessage } from './types';

export function createMessage<T extends Record<string, unknown> = Record<string, never>>(
  role: MessageRole,
  content: string,
  extras?: T,
): Message & T {
  return {
    role,
    content,
    ...(extras ?? ({} as T)),
  } as Message & T;
}

export function createToolMessage(
  toolName: string,
  content: string,
  callId: string,
): ToolMessage {
  return {
    role: 'tool',
    toolName,
    callId,
    content,
  };
}
