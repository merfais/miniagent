export type AgentEvent =
  | { type: 'text_delta'; turnId: string; text: string }
  | { type: 'reasoning_delta'; turnId: string; text: string }
  | {
      type: 'tool_call';
      turnId: string;
      toolCallId: string;
      name: string;
      args: Record<string, unknown>;
    }
  | { type: 'tool_result'; turnId: string; toolCallId: string; result: unknown; isError?: boolean }
  | {
      type: 'tool_approval_request';
      turnId: string;
      approvalId: string;
      toolCallId: string;
      name: string;
      args: Record<string, unknown>;
    }
  | { type: 'notice'; turnId?: string; level: 'info' | 'warn'; message: string; meta?: unknown }
  | { type: 'error'; turnId?: string; message: string; meta?: unknown }
  | { type: 'turn_done'; turnId: string; finishReason: string };

export type AgentEventType = AgentEvent['type'];

export type ApprovalDecision = 'approve' | 'deny';

export interface Agent {
  sendUserMessage(content: string): AsyncIterable<AgentEvent>;
  cancel(): void;
  approve(approvalId: string, decision: ApprovalDecision): void;
}
