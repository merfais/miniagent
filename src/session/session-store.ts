import crypto from 'node:crypto';

import { isPersistenceError, persistence, type SessionListEntry } from './persistence.js';
import { Session, isSessionError, type SessionError } from './session.js';

const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function fmtNow(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}_${pad(d.getMonth() + 1)}_${pad(d.getDate())}_` +
    `${pad(d.getHours())}_${pad(d.getMinutes())}_${pad(d.getSeconds())}`
  );
}

function randomBase36(len: number): string {
  return crypto
    .randomBytes(8)
    .toString('base64url')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, len)
    .padEnd(len, '0');
}

// TODO: clientBindings 目前只增不删——client 长时间不再出现时，映射条目常驻内存。
export class SessionStore {
  private readonly loaded = new Map<string, Session>();
  private readonly clientBindings = new Map<string, string>();
  private counter: number | null = null;

  async list(): Promise<SessionListEntry[] | SessionError> {
    const entries = await persistence.list();
    if (isPersistenceError(entries)) {
      return {
        code: 'persist_failed',
        message: `session 列表加载失败：${entries.code} ${entries.message}`,
      };
    }
    return entries;
  }

  async get(sessionId: string): Promise<Session | SessionError | null> {
    this.removeIdle();

    const cached = this.loaded.get(sessionId);
    if (cached) {
      return cached;
    }

    const session = new Session({ id: sessionId });
    const err = await session.load();
    if (err) {
      // not_found 语义上等价于"无此 session"，仍返回 null；其余为真实 IO 错误，上抛。
      return err.code === 'not_found' ? null : err;
    }
    this.loaded.set(sessionId, session);
    return session;
  }

  async create(): Promise<Session | SessionError> {
    this.removeIdle();
    const id = await this.allocateId();
    const session = new Session({ id });
    const err = await session.create();
    if (err) {
      return err;
    }
    this.loaded.set(id, session);
    return session;
  }

  async fork(sourceId: string, atTurnId: number): Promise<Session | SessionError> {
    const source = await this.get(sourceId);
    if (!source) {
      return { code: 'not_found', message: `源 session ${sourceId} 不存在` };
    }
    if (isSessionError(source)) {
      return source;
    }
    const seed = await source.forkFrom(atTurnId);
    if (!seed) {
      return {
        code: 'turn_not_forkable',
        message: `session ${sourceId} 的 turn ${atTurnId} 不可分叉`,
      };
    }

    this.removeIdle();
    const id = await this.allocateId();
    const forked = new Session({ id });
    const err = await forked.create(seed);
    if (err) {
      return err;
    }
    this.loaded.set(id, forked);
    return forked;
  }

  switchClient(clientId: string, sessionId: string): void {
    const prevSessionId = this.clientBindings.get(clientId);
    if (prevSessionId === sessionId) {
      return;
    }
    if (prevSessionId) {
      const prev = this.loaded.get(prevSessionId);
      if (prev) {
        prev.active.delete(clientId);
        prev.lastInactiveAt = Date.now();
      }
    }
    this.clientBindings.set(clientId, sessionId);
    const cur = this.loaded.get(sessionId);
    if (cur) {
      cur.active.add(clientId);
    }
  }

  private removeIdle(): void {
    const now = Date.now();
    for (const [id, s] of this.loaded) {
      // turn 进行中的 Session 不能淘汰：Agent 循环仍持有 session 引用，
      // 从 loaded Map 抽走会造成事件流断裂。
      if (s.isTurnActive) {
        continue;
      }
      if (s.active.size === 0 && now - s.lastInactiveAt > IDLE_TIMEOUT_MS) {
        this.loaded.delete(id);
      }
    }
  }

  private async allocateId(): Promise<string> {
    if (this.counter === null) {
      const loaded = await persistence.loadCounter();
      // 计数器读失败降级为 0：id 尾部随机后缀已提供防碰撞，不因此阻断建号。
      this.counter = isPersistenceError(loaded) ? 0 : loaded;
    }
    this.counter += 1;
    // 写失败仅记日志（persistence 内部已记），不阻断建号。
    void persistence.saveCounter(this.counter);
    return `${fmtNow()}_${this.counter}_${randomBase36(4)}`;
  }
}

export let sessionStore: SessionStore;

export function initSessionStore(): SessionStore {
  sessionStore = new SessionStore();
  return sessionStore;
}
