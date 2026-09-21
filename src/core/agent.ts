import { config, type ProviderConfig } from '../config/app-config.js';
import {
  createProvider,
  type ContentBlock,
  type Provider,
  type StopReason,
  type ToolResultBlock,
  type ToolUseBlock,
} from '../providers/factory.js';
import type { Session, UiSegment } from '../session/session.js';
import { createDefaultToolRegistry } from '../tools/default-tool-registry.js';
import { REFLECTION_PROMPT, SYSTEM_PROMPT } from './system-prompt.js';
import type { ToolRegistry } from './tool-registry.js';

export type ApprovalDecision = 'approve' | 'deny';
export type SwitchResult = 'ok' | 'busy' | 'invalid_config';

import { logger as globalLogger, type Logger } from './logger.js';

// 默认工具集是跨 session 只读共享的 boot 期常量，首个 Agent 构造时惰性建一次。
let defaultTools: ToolRegistry | null = null;
function getDefaultTools(): ToolRegistry {
  if (!defaultTools) {
    defaultTools = createDefaultToolRegistry();
  }
  return defaultTools;
}

interface Pending {
  id: string;
  resolve: (d: ApprovalDecision) => void;
  abortListener: () => void;
}

const DEFAULT_MAX_STEPS = 32;
const DEFAULT_MAX_REFLECTIONS = 3;
const STALLED_TEXT = '任务达到反思上限,被迫终止。请细化任务目标后重新发起。';

export class Agent {
  private readonly session: Session;
  private readonly logger: Logger;
  private readonly maxSteps: number;
  private readonly maxReflections: number;
  private tools: ToolRegistry;
  private provider: Provider;
  // Approval pending 表；清理三路径见 §2.2 注释：
  //   1) resolveApproval 命中；2) abort listener 触发；3) sendMessage finally 兜底。
  // 每条路径都通过 cleanupPending(id, decision) 完整做 delete + removeEventListener + resolve，
  // 幂等（第二次进入时 Map 已空，直接返回）。
  private readonly pending = new Map<string, Pending>();

  constructor(session: Session) {
    this.session = session;
    this.logger = globalLogger;
    this.maxSteps = DEFAULT_MAX_STEPS;
    this.maxReflections = DEFAULT_MAX_REFLECTIONS;
    this.tools = getDefaultTools();
    // config 由 startServer 入口保证已 resolveConfig 填充；非法时 createProvider 返回 undefined。
    const provider = createProvider(config?.provider, {
      system: SYSTEM_PROMPT,
      tools: this.tools.listSchemas(),
    });
    if (!provider) {
      throw new Error('failed to create provider; check config or env');
    }
    this.provider = provider;
  }

  switchProvider(config: ProviderConfig): SwitchResult {
    if (this.session.isTurnActive) {
      return 'busy';
    }
    const next = createProvider(config, {
      system: SYSTEM_PROMPT,
      tools: this.tools.listSchemas(),
    });
    if (!next) {
      return 'invalid_config';
    }
    this.provider = next;
    return 'ok';
  }

  switchTools(tools: ToolRegistry): SwitchResult {
    if (this.session.isTurnActive) {
      return 'busy';
    }
    this.tools = tools;
    this.provider.setTools(tools.listSchemas());
    return 'ok';
  }

  resolveApproval(id: string, decision: ApprovalDecision): boolean {
    if (!this.pending.has(id)) {
      return false;
    }
    this.cleanupPending(id, decision);
    return true;
  }

  async sendMessage(): Promise<void> {
    const abort = this.session.signal;
    const aborted = (): boolean => abort.aborted;
    let step = 0;
    let reflectionCount = 0;

    try {
      while (true) {
        if (aborted()) {
          return this.finalizeCancelled(null, null);
        }

        const snapshot = this.session.messages.slice();
        const wire = snapshot.map(({ role, content }) => ({ role, content }));

        let content: ContentBlock[];
        let stopReason: StopReason;
        try {
          const result = await this.provider.generate(wire, { signal: abort });
          content = result.content;
          stopReason = result.stopReason;
          // TODO(agent-usage): usage 目前 provider 已返回但 Agent 尚未消费。
          // 后续接入 turn 级 usage 累计 / event 上报时启用 result.usage。
        } catch (error) {
          if (aborted()) {
            return this.finalizeCancelled(null, null);
          }
          const err = error instanceof Error ? error : new Error(String(error));
          this.logger.error('agent.provider.error', {
            sessionId: this.session.id,
            error: err.message,
          });
          void this.session.append({
            event: { type: 'turn_done', finishReason: 'error', message: err.message },
          });
          return;
        }

        if (aborted()) {
          return this.finalizeCancelled(null, null);
        }

        void this.session.append({
          message: { role: 'assistant', content },
          event: { type: 'assistant_message', segments: toUiSegments(content) },
        });

        if (stopReason !== 'tool_use') {
          void this.session.append({ event: { type: 'turn_done', finishReason: stopReason } });
          return;
        }

        // stopReason === 'tool_use'
        const toolUses = content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
        const results: ToolResultBlock[] = [];

        let cancelledMid = false;
        for (const tu of toolUses) {
          if (aborted()) {
            cancelledMid = true;
            break;
          }

          if (this.tools.needsApproval(tu.name)) {
            const decision = await this.requestApproval(tu);
            if (aborted()) {
              cancelledMid = true;
              break;
            }
            if (decision === 'deny') {
              const r: ToolResultBlock = {
                type: 'tool_result',
                tool_use_id: tu.tool_use_id,
                is_error: true,
                content: 'denied by user',
              };
              results.push(r);
              void this.session.append({
                event: {
                  type: 'tool_result',
                  toolUseId: tu.tool_use_id,
                  result: r.content,
                  isError: true,
                },
              });
              continue;
            }
          }

          const result = await this.tools.run(tu, { signal: abort });
          results.push(result);
          void this.session.append({
            event: {
              type: 'tool_result',
              toolUseId: tu.tool_use_id,
              result: result.content,
              isError: result.is_error,
            },
          });
        }

        if (cancelledMid || aborted()) {
          return this.finalizeCancelled(toolUses, results);
        }

        void this.session.append({ message: { role: 'user', content: results } });

        step += 1;
        if (step >= this.maxSteps) {
          reflectionCount += 1;
          if (reflectionCount > this.maxReflections) {
            void this.session.append({
              message: { role: 'assistant', content: [{ type: 'text', text: STALLED_TEXT }] },
              event: {
                type: 'assistant_message',
                segments: [{ type: 'text', text: STALLED_TEXT }],
              },
            });
            void this.session.append({ event: { type: 'turn_done', finishReason: 'stalled' } });
            return;
          }
          const reflection = {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: REFLECTION_PROMPT }],
          };
          void this.session.append({ message: reflection });
          step = 0;
        }
      }
    } finally {
      // 见 §2.2：兜底防御 sendMessage 循环内非 abort 异常导致 pending 悬挂。
      // 正常路径下此时 Map 已空。
      for (const id of this.pending.keys()) {
        this.cleanupPending(id, 'deny');
      }
    }
  }

  private cleanupPending(id: string, decision: ApprovalDecision): void {
    const p = this.pending.get(id);
    if (!p) {
      return;
    }
    this.pending.delete(id);
    this.session.signal.removeEventListener('abort', p.abortListener);
    p.resolve(decision);
  }

  private requestApproval(tu: ToolUseBlock): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const id = tu.tool_use_id;
      const abortListener = (): void => this.cleanupPending(id, 'deny');
      this.pending.set(id, { id, resolve, abortListener });
      this.session.signal.addEventListener('abort', abortListener, { once: true });
      void this.session.append({
        event: {
          type: 'tool_approval_request',
          approvalId: id,
          toolUseId: tu.tool_use_id,
          name: tu.name,
          args: tu.input,
        },
      });
    });
  }

  private finalizeCancelled(
    emittedToolUses: readonly ToolUseBlock[] | null,
    collectedResults: readonly ToolResultBlock[] | null,
  ): void {
    if (emittedToolUses && emittedToolUses.length > 0) {
      const doneIds = new Set((collectedResults ?? []).map((r) => r.tool_use_id));
      const missing = emittedToolUses.filter((tu) => !doneIds.has(tu.tool_use_id));
      const fakeResults: ToolResultBlock[] = missing.map((tu) => ({
        type: 'tool_result',
        tool_use_id: tu.tool_use_id,
        is_error: true,
        content: '用户主动取消,无运行结果',
      }));
      for (const fr of fakeResults) {
        void this.session.append({
          event: {
            type: 'tool_result',
            toolUseId: fr.tool_use_id,
            result: fr.content,
            isError: true,
          },
        });
      }
      const merged: ToolResultBlock[] = [...(collectedResults ?? []), ...fakeResults];
      void this.session.append({ message: { role: 'user', content: merged } });
    }
    void this.session.append({ event: { type: 'turn_done', finishReason: 'user_cancelled' } });
  }
}

function toUiSegments(content: ContentBlock[]): UiSegment[] {
  const out: UiSegment[] = [];
  for (const b of content) {
    if (b.type === 'text') {
      if (b.text) {
        out.push({ type: 'text', text: b.text });
      }
    } else if (b.type === 'thinking') {
      if (b.text) {
        out.push({ type: 'reasoning', text: b.text });
      }
    } else if (b.type === 'tool_use') {
      out.push({ type: 'tool_use', id: b.tool_use_id, name: b.name, args: b.input });
    }
    // tool_result 不会出现在 assistant content 中；此处忽略。
  }
  return out;
}
