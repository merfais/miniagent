import { EventEmitter, once } from 'node:events';

import { Agent } from '../core/agent.js';
import type { ContentBlock } from '../providers/factory.js';
import type { SseEvent } from '../server/http/sse.js';
import { isPersistenceError, persistence, type PersistenceError } from './persistence.js';

export interface SessionMessage {
  turnId: number;
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

// 内存态：按 turn 分组的二维结构。第一维是 turn，第二维是 turn 内的记录。
// 磁盘保持 flat（append-only），group/flatten 在 Session 内部完成。
export interface TurnGroup<T> {
  turnId: number;
  items: T[];
}
export type MessageTurn = TurnGroup<SessionMessage>;
export type EventTurn = TurnGroup<UiEvent>;

export interface SessionMeta {
  summary: string;
  createdAt: number;
  updatedAt: number;
}

export type UiSegment =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_use'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'llm_error'; message: string; code?: string };

export type FinishReason =
  | 'end_turn'
  | 'max_tokens'
  | 'refusal'
  | 'user_cancelled'
  | 'error'
  | 'stalled';

export type UiEvent =
  | { type: 'user_message'; turnId: number; content: string }
  | { type: 'assistant_message'; turnId: number; segments: UiSegment[] }
  | {
      type: 'tool_result';
      turnId: number;
      toolUseId: string;
      result: unknown;
      isError?: boolean;
    }
  | {
      type: 'tool_approval_request';
      turnId: number;
      approvalId: string;
      toolUseId: string;
      name: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'tool_approval_decision';
      turnId: number;
      approvalId: string;
      decision: 'approve' | 'deny';
    }
  | {
      type: 'turn_done';
      turnId: number;
      finishReason: FinishReason;
      message?: string;
      code?: string;
    };

export interface SessionOptions {
  id: string;
}

export interface ForkSeed {
  eventTurns: EventTurn[];
  messageTurns: MessageTurn[];
  summary: string;
}

export interface SubscribeOptions {
  signal: AbortSignal;
  /** 断点续订：从该 eventId 之后开始推送。TODO 未实现，当前忽略。 */
  lastEventId?: string;
}

// Agent 通过此形态 append：turnId 不由 Agent 关心，由 Session 内部补齐当前 turn。
export interface AppendPayload {
  event?: OmitTurnId<UiEvent>;
  message?: OmitTurnId<SessionMessage>;
}

type OmitTurnId<T> = T extends unknown ? Omit<T, 'turnId'> : never;

// Session 对外错误统一形状 { code, message }。code 为 session 级语义（非底层存储细节），
// message 面向调用方/用户，需能定位环节；包装 persistence 失败时拼接其 code+message 保留细节。
export interface SessionError {
  code: 'turn_in_progress' | 'persist_failed' | 'not_found' | 'turn_not_forkable';
  message: string;
}

export function isSessionError(v: unknown): v is SessionError {
  return typeof v === 'object' && v !== null && 'code' in v && 'message' in v;
}

export class Session {
  readonly id: string;
  readonly active = new Set<string>();
  lastInactiveAt = 0;

  private _messageTurns: MessageTurn[] = [];
  private _eventTurns: EventTurn[] = [];
  private _nextTurnId = 1;
  private _currentTurnId = 0;
  private _meta: SessionMeta | null = null;
  private _turnInProgress = false;
  private _currentAbortController: AbortController | null = null;

  private readonly notifier = new EventEmitter();
  private agent: Agent;

  constructor(opts: SessionOptions) {
    this.id = opts.id;
    this.agent = new Agent(this);
  }

  // 给 Agent：flatten 后的一维消息序列。
  get messages(): SessionMessage[] {
    return this._messageTurns.flatMap((t) => t.items);
  }
  // 给前端：按 turn 分组的二维事件结构。
  get eventTurns(): readonly EventTurn[] {
    return this._eventTurns;
  }
  get signal(): AbortSignal {
    return this._currentAbortController?.signal ?? AbortSignal.abort();
  }
  get isTurnActive(): boolean {
    return this._turnInProgress;
  }
  get currentTurnId(): number {
    return this._currentTurnId;
  }

  async create(seed?: ForkSeed): Promise<SessionError | void> {
    if (seed) {
      this._eventTurns = seed.eventTurns;
      this._messageTurns = seed.messageTurns;
      const lastTurn = this._eventTurns[this._eventTurns.length - 1];
      this._nextTurnId = (lastTurn?.turnId ?? 0) + 1;
    }
    const err = await persistence.create(this.id, {
      eventTurns: this._eventTurns,
      messageTurns: this._messageTurns,
      summary: seed?.summary,
    });
    if (isPersistenceError(err)) {
      return {
        code: 'persist_failed',
        message: `session ${this.id} 保存失败：${err.code} ${err.message}`,
      };
    }
  }

  async load(): Promise<SessionError | void> {
    const snap = await persistence.read(this.id);
    if (isPersistenceError(snap)) {
      return {
        code: snap.code === 'not_found' ? 'not_found' : 'persist_failed',
        message: `session ${this.id} 加载失败：${snap.code} ${snap.message}`,
      };
    }
    this._eventTurns = snap.eventTurns;
    this._messageTurns = snap.messageTurns;
    this.reconcileUnfinishedTurn();
  }

  async getMeta(): Promise<SessionMeta> {
    return { ...(await this.ensureMeta()) };
  }

  async writeMeta(partial: Partial<SessionMeta>): Promise<SessionError | void> {
    const cur = await this.ensureMeta();
    this._meta = { ...cur, ...partial };
    const err = await persistence.saveMeta(this.id, this._meta);
    if (isPersistenceError(err)) {
      return {
        code: 'persist_failed',
        message: `session ${this.id} 保存失败：${err.code} ${err.message}`,
      };
    }
  }

  async runTurn(content: string): Promise<SessionError | void> {
    if (this._turnInProgress) {
      return { code: 'turn_in_progress', message: `session ${this.id} 正在处理上一轮，请稍后重试` };
    }
    // 闸门必须在任何 await 之前置位，否则下方 rewriteAll 的 await 窗口内并发的
    // runTurn 会漏过重入检查。
    this._turnInProgress = true;

    const tailTurn = this._eventTurns[this._eventTurns.length - 1];
    const tail = tailTurn?.items[tailTurn.items.length - 1];
    if (tail && tail.type === 'user_message') {
      // 冷启动残留的未完成 turn（reconcileUnfinishedTurn 已裁到仅剩首条 user_message）。
      // 剔除该 orphan 后，session 等价于末尾为 completed turn 的普通 session，新输入走全新 turn。
      // 磁盘同步全量重写为 completed-only：await 有双重作用——(1) 排序，保证它先于下方
      // append 落盘，杜绝写序竞态（append 是 fire-and-forget，若 rename 晚于 appendFile 会把
      // 新行覆盖丢失）；(2) 一致性，先落盘成功再提交内存剔除，失败则内存/磁盘均保持原样，
      // 闸门回滚，下次 runTurn 仍识别到该 orphan 可重试。失败上抛 { code, message } 让用户感知，
      // 否则内存已剔除而磁盘残留 orphan，后续 session 恢复会分叉。
      const completed = {
        eventTurns: this._eventTurns.slice(0, -1),
        messageTurns:
          this._messageTurns[this._messageTurns.length - 1]?.turnId === tail.turnId
            ? this._messageTurns.slice(0, -1)
            : this._messageTurns.slice(),
      };
      const err = await persistence.rewriteAll(this.id, completed);
      if (isPersistenceError(err)) {
        this._turnInProgress = false;
        return {
          code: 'persist_failed',
          message: `session ${this.id} 保存失败：${err.code} ${err.message}`,
        };
      }
      this._eventTurns = completed.eventTurns;
      this._messageTurns = completed.messageTurns;
    }

    // orphan 已剔除，_nextTurnId 复用其号（reconcile 设为该 turn），号不跳空。
    const turnId = this._nextTurnId;
    this._nextTurnId += 1;
    this._currentTurnId = turnId;
    this._currentAbortController = new AbortController();

    // 用户输入的 user_message 落盘失败需让用户感知；但内存是事实源，turn 照常发起，
    // 仅将 persist 错误随 runTurn 返回。
    const appendErr = await this.append({
      event: { type: 'user_message', content },
      message: { role: 'user', content: [{ type: 'text', text: content }] },
    });

    void this.agent
      .sendMessage()
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        // agent.sendMessage 内部应吞掉所有可预测错误；到这里说明有编程错误。
        // 兜底 append 一个 error turn_done，避免 UI 永远等待。
        void this.append({
          event: { type: 'turn_done', finishReason: 'error', message: err.message },
        });
      })
      .finally(() => {
        this._turnInProgress = false;
        this._currentAbortController = null;
        this._currentTurnId = 0;
      });

    return appendErr;
  }

  cancel(): void {
    if (!this._turnInProgress) {
      return;
    }
    this._currentAbortController?.abort();
  }

  async approve(approvalId: string, decision: 'approve' | 'deny'): Promise<SessionError | void> {
    const resolved = this.agent.resolveApproval(approvalId, decision);
    if (!resolved) {
      return;
    }
    return this.append({
      event: { type: 'tool_approval_decision', approvalId, decision },
    });
  }

  /**
   * 切换 Agent 实现类（不同 system prompt / tools 集合）。
   * 前置校验 !isTurnActive；返回 false 表示当前 turn 进行中，拒绝切换。
   * 具体销毁旧 Agent 的资源清理策略见 §2.5——Agent 侧无独立 dispose，直接替换引用。
   */
  switchAgent(): boolean {
    if (this._turnInProgress) {
      return false;
    }
    this.agent = new Agent(this);
    return true;
  }

  /**
   * append 单一入口：Agent 层不需要关心 turnId 与持久化，由 Session 用
   * `_currentTurnId` 补齐；跨文件原子性由 persistence 层 TODO 承接。
   *
   * 内存 push 与 notifier.emit 在首个 await 前同步完成——内存是事实源、UI 即时收到；
   * 随后等待各写入结果，任一失败则汇总为 persist_failed 向上传递（写失败需用户感知，
   * 但内存态与已 emit 的事件不回滚）。
   */
  async append(payload: AppendPayload): Promise<SessionError | void> {
    const turnId = this._currentTurnId;
    const writes: Promise<null | PersistenceError>[] = [];
    if (payload.message) {
      const m: SessionMessage = { ...payload.message, turnId } as SessionMessage;
      this.pushToTurn(this._messageTurns, turnId, m);
      writes.push(persistence.appendMessages(this.id, [m]));
    }
    if (payload.event) {
      const e = { ...payload.event, turnId } as UiEvent;
      this.pushToTurn(this._eventTurns, turnId, e);
      this.notifier.emit('change');
      writes.push(persistence.appendEvents(this.id, [e]));
    }
    writes.push(this.touchMeta());
    const errors = (await Promise.all(writes)).filter(isPersistenceError);
    if (errors.length > 0) {
      return {
        code: 'persist_failed',
        message: `session ${this.id} 保存失败：${errors
          .map((e) => `${e.code} ${e.message}`)
          .join('；')}`,
      };
    }
  }

  async forkFrom(atTurnId: number): Promise<ForkSeed | null> {
    const turn = this._eventTurns.find((t) => t.turnId === atTurnId);
    const done = turn?.items.find((e) => e.type === 'turn_done');
    if (!done || done.type !== 'turn_done' || done.finishReason !== 'end_turn') {
      return null;
    }
    const meta = await this.ensureMeta();
    return {
      eventTurns: this._eventTurns.filter((t) => t.turnId <= atTurnId),
      messageTurns: this._messageTurns.filter((t) => t.turnId <= atTurnId),
      summary: meta.summary,
    };
  }

  async *subscribe(opts: SubscribeOptions): AsyncIterable<SseEvent> {
    // TODO: 支持 opts.lastEventId 断点续订——当前实现无视该参数、始终从头回放全量事件。
    const { signal } = opts;
    let cursor = 0;
    while (!signal.aborted) {
      const flat = this._eventTurns.flatMap((t) => t.items);
      while (cursor < flat.length && !signal.aborted) {
        const event = flat[cursor]!;
        yield { id: String(cursor), type: event.type, data: event };
        cursor += 1;
      }
      if (signal.aborted) {
        return;
      }
      try {
        await once(this.notifier, 'change', { signal });
      } catch {
        return;
      }
    }
  }

  private async ensureMeta(): Promise<SessionMeta> {
    if (this._meta) {
      return this._meta;
    }
    const m = await persistence.readMeta(this.id);
    if (isPersistenceError(m)) {
      const now = Date.now();
      this._meta = { summary: '', createdAt: now, updatedAt: now };
    } else {
      this._meta = m;
    }
    return this._meta;
  }

  private async touchMeta(): Promise<null | PersistenceError> {
    const cur = await this.ensureMeta();
    this._meta = { ...cur, updatedAt: Date.now() };
    return persistence.saveMeta(this.id, this._meta);
  }

  /**
   * 冷启动仅调用一次：定位末尾未完成 turn 并同步内存/_nextTurnId。
   *
   * 不变式：turn 首条 event = user_message，首条 message = role='user'——由 runTurn 入口保证。
   * 因此未完成 turn 只需保留其首条，无需按 type/role 二次判定；runTurn 通过检测
   * 末尾 turn 组的最后一条是否为 user_message 来判断该 turn 是否为待剔除的 orphan。
   *
   * 三种情况一并处理：
   *   - 空 events：_nextTurnId 保持默认 1。
   *   - 末尾 turn 已含 turn_done：无未完成 turn，_nextTurnId = last + 1。
   *   - 否则末尾 turn 未完成：将该 turn 组裁到仅剩首条，_nextTurnId = 该 turn。
   *     磁盘保留原样；orphan 的剔除与全量重写延迟到下次 runTurn（须由用户真正发送新消息
   *     触发，冷启动后不发消息即切走再切回不能丢失该 turn），届时 _nextTurnId++ 复用该号。
   */
  private reconcileUnfinishedTurn(): void {
    const last = this._eventTurns[this._eventTurns.length - 1];
    if (!last) {
      return;
    }
    const finished = last.items.some((e) => e.type === 'turn_done');
    if (finished) {
      this._nextTurnId = last.turnId + 1;
      return;
    }
    last.items.length = 1;
    const lastMsg = this._messageTurns[this._messageTurns.length - 1];
    if (lastMsg && lastMsg.turnId === last.turnId) {
      lastMsg.items.length = 1;
    }
    this._nextTurnId = last.turnId;
  }

  private pushToTurn<T extends { turnId: number }>(
    groups: TurnGroup<T>[],
    turnId: number,
    item: T,
  ): void {
    const tail = groups[groups.length - 1];
    if (tail && tail.turnId === turnId) {
      tail.items.push(item);
    } else {
      groups.push({ turnId, items: [item] });
    }
  }
}
