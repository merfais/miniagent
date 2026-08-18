import crypto from 'node:crypto';

import type { AppConfig } from '../config/app-config.js';
import { createProvider } from '../providers/factory.js';
import type { Provider, UBlock, UMessage } from '../providers/types.js';
import { createDefaultToolRegistry } from '../tools/default-tool-registry.js';
import { AsyncQueue } from './async-queue.js';
import type { AgentEvent, ApprovalDecision, Agent } from './events.js';
import { logger as globalLogger, type Logger } from './logger.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import type { RegisteredTool } from './tool-registry.js';

export interface ToolRegistryLike {
  get(name: string): RegisteredTool | undefined;
  list(): RegisteredTool[];
}

export interface TurnOptions {
  provider: Provider;
  tools: ToolRegistryLike;
  history: UMessage[];
  turnId: string;
  emit: (event: AgentEvent) => void;
  requestApproval: (
    turnId: string,
    toolCallId: string,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ApprovalDecision>;
  isCancelled: () => boolean;
  maxSteps: number;
  logger: Logger;
}

export async function runTurn(opts: TurnOptions): Promise<string> {
  const { provider, tools, history, turnId, emit, requestApproval, isCancelled, maxSteps, logger } =
    opts;

  for (let step = 0; step < maxSteps; step += 1) {
    if (isCancelled()) {
      return 'cancelled';
    }

    let res;
    try {
      res = await provider.generate(history, { logger });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('turn.provider.error', { turnId, error: err.message });
      emit({ type: 'error', turnId, message: `provider error: ${err.message}` });
      return 'error';
    }

    history.push({ role: 'assistant', content: res.content });

    for (const block of res.content) {
      if (block.type === 'text' && block.text) {
        emit({ type: 'text_delta', turnId, text: block.text });
      }
    }

    if (res.stopReason !== 'tool_use') {
      return res.stopReason;
    }

    const toolResults: UBlock[] = [];
    for (const block of res.content) {
      if (block.type !== 'tool_use') {
        continue;
      }
      if (isCancelled()) {
        return 'cancelled';
      }

      emit({
        type: 'tool_call',
        turnId,
        toolCallId: block.id,
        name: block.name,
        args: block.input,
      });

      const tool = tools.get(block.name);
      if (!tool) {
        const message = `Unknown tool: ${block.name}`;
        emit({ type: 'tool_result', turnId, toolCallId: block.id, result: message, isError: true });
        toolResults.push({ type: 'tool_result', id: block.id, content: message, isError: true });
        continue;
      }

      const decision = await requestApproval(turnId, block.id, block.name, block.input);
      if (decision === 'deny') {
        const message = `Tool "${block.name}" denied by user`;
        emit({
          type: 'tool_result',
          turnId,
          toolCallId: block.id,
          result: message,
          isError: true,
        });
        toolResults.push({ type: 'tool_result', id: block.id, content: message, isError: true });
        continue;
      }

      try {
        tool.validateArgs(block.input);
        const output = await tool.execute(block.input);
        const content = typeof output === 'string' ? output : JSON.stringify(output);
        emit({ type: 'tool_result', turnId, toolCallId: block.id, result: output });
        toolResults.push({ type: 'tool_result', id: block.id, content });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('turn.tool.error', { turnId, tool: block.name, error: err.message });
        emit({
          type: 'tool_result',
          turnId,
          toolCallId: block.id,
          result: err.message,
          isError: true,
        });
        toolResults.push({
          type: 'tool_result',
          id: block.id,
          content: err.message,
          isError: true,
        });
      }
    }

    history.push({ role: 'user', content: toolResults });
  }

  emit({
    type: 'notice',
    turnId,
    level: 'warn',
    message: `reached max steps (${maxSteps}); stopping turn`,
  });
  return 'max_steps';
}

export interface CreateAgentOptions {
  config: AppConfig;
  cwd: string;
  approvalTimeoutMs?: number;
  maxSteps?: number;
  logger?: Logger;
}

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

export function createAgent(opts: CreateAgentOptions): Agent {
  const logger = opts.logger ?? globalLogger;
  const tools = createDefaultToolRegistry({ workspaceRoot: opts.cwd });
  const provider = createProvider(opts.config.provider, {
    system: SYSTEM_PROMPT,
    tools: tools.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? { type: 'object', properties: {} },
    })),
  });
  if (!provider) {
    throw new Error('failed to create provider; check config or env');
  }

  const history: UMessage[] = [];
  const approvals = new Map<string, PendingApproval>();
  const approvalTimeoutMs = opts.approvalTimeoutMs ?? 5 * 60 * 1000;
  const maxSteps = opts.maxSteps ?? 8;
  let currentTurn: { turnId: string; cancelled: boolean } | undefined;

  function requestApproval(
    turnId: string,
    toolCallId: string,
    name: string,
    args: Record<string, unknown>,
    emit: (event: AgentEvent) => void,
  ): Promise<ApprovalDecision> {
    const approvalId = crypto.randomBytes(6).toString('hex');
    emit({
      type: 'tool_approval_request',
      turnId,
      approvalId,
      toolCallId,
      name,
      args,
    });
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (approvals.delete(approvalId)) {
          emit({
            type: 'notice',
            turnId,
            level: 'warn',
            message: `approval ${approvalId} timed out; denying`,
          });
          resolve('deny');
        }
      }, approvalTimeoutMs);
      approvals.set(approvalId, { resolve, timer });
    });
  }

  return {
    sendUserMessage(content: string): AsyncIterable<AgentEvent> {
      const turnId = crypto.randomBytes(4).toString('hex');
      const queue = new AsyncQueue<AgentEvent>();
      const state = { turnId, cancelled: false };
      currentTurn = state;
      history.push({ role: 'user', content: [{ type: 'text', text: content }] });

      const emit = (event: AgentEvent): void => {
        queue.push(event);
      };

      void (async () => {
        let finishReason = 'end_turn';
        try {
          finishReason = await runTurn({
            provider,
            tools,
            history,
            turnId,
            emit,
            requestApproval: (tid, tcid, name, args) =>
              requestApproval(tid, tcid, name, args, emit),
            isCancelled: () => state.cancelled,
            maxSteps,
            logger,
          });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.error('turn.uncaught', { turnId, error: err.message });
          emit({ type: 'error', turnId, message: err.message });
          finishReason = 'crashed';
        } finally {
          for (const [id, pending] of approvals) {
            clearTimeout(pending.timer);
            pending.resolve('deny');
            approvals.delete(id);
          }
          emit({ type: 'turn_done', turnId, finishReason });
          queue.close();
          if (currentTurn === state) {
            currentTurn = undefined;
          }
        }
      })();

      return queue;
    },
    cancel(): void {
      if (currentTurn) {
        currentTurn.cancelled = true;
      }
    },
    approve(approvalId: string, decision: ApprovalDecision): void {
      const pending = approvals.get(approvalId);
      if (!pending) {
        logger.warn('approval.unknown', { approvalId });
        return;
      }
      clearTimeout(pending.timer);
      approvals.delete(approvalId);
      pending.resolve(decision);
    },
  };
}
