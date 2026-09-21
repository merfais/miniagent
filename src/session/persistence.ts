import fs from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../core/logger.js';
import { runtimeRoot } from '../core/workspace.js';
import type {
  SessionMeta,
  UiEvent,
  SessionMessage,
  TurnGroup,
  EventTurn,
  MessageTurn,
} from './session.js';

// 持久化层专属类型：session.ts 自身不消费，故就近定义于此。
export type SessionListEntry = SessionMeta & { id: string };

// 磁盘保持 flat JSONL；对外以 2D turn 结构呈现，flat↔2D 转换是持久化层的能力。
export interface SessionSnapshot {
  eventTurns: EventTurn[];
  messageTurns: MessageTurn[];
  /** create/fork 时传入，用于初始化 meta.summary；read 返回时不填。 */
  summary?: string;
}

// 错误协议：所有 safe 原子函数与 Persistence 顶层方法返回的错误统一形状。
// code 覆盖 fs 与 JSON 两类失败；对外仅承诺 not_found / meta_corrupted / io_error 三种，
// 其它由 Persistence 内部处理或转换为 io_error。
export type PersistenceErrorCode =
  | 'not_found'
  | 'meta_corrupted'
  | 'io_error'
  | 'parse_error'
  | 'stringify_error';

export interface PersistenceError {
  code: PersistenceErrorCode;
  message: string;
}

export function isPersistenceError(v: unknown): v is PersistenceError {
  return typeof v === 'object' && v !== null && 'code' in v && 'message' in v;
}

async function safeReadFile(file: string): Promise<string | PersistenceError> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { code: 'not_found', message: err.message };
    }
    return { code: 'io_error', message: err.message };
  }
}

async function safeWriteFile(file: string, data: string): Promise<null | PersistenceError> {
  try {
    await fs.writeFile(file, data, 'utf8');
    return null;
  } catch (error) {
    return { code: 'io_error', message: (error as Error).message };
  }
}

async function safeAppendFile(file: string, data: string): Promise<null | PersistenceError> {
  try {
    await fs.appendFile(file, data, 'utf8');
    return null;
  } catch (error) {
    return { code: 'io_error', message: (error as Error).message };
  }
}

async function safeMkdir(dir: string): Promise<null | PersistenceError> {
  try {
    await fs.mkdir(dir, { recursive: true });
    return null;
  } catch (error) {
    return { code: 'io_error', message: (error as Error).message };
  }
}

async function safeReaddir(dir: string): Promise<string[] | PersistenceError> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { code: 'not_found', message: err.message };
    }
    return { code: 'io_error', message: err.message };
  }
}

async function safeRename(from: string, to: string): Promise<null | PersistenceError> {
  try {
    await fs.rename(from, to);
    return null;
  } catch (error) {
    return { code: 'io_error', message: (error as Error).message };
  }
}

async function safeRm(target: string): Promise<null | PersistenceError> {
  try {
    await fs.rm(target, { recursive: true, force: true });
    return null;
  } catch (error) {
    return { code: 'io_error', message: (error as Error).message };
  }
}

function safeJsonParse<T>(raw: string): T | PersistenceError {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    return { code: 'parse_error', message: (error as Error).message };
  }
}

function safeJsonStringify(v: unknown, pretty = false): string | PersistenceError {
  try {
    return pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v);
  } catch (error) {
    return { code: 'stringify_error', message: (error as Error).message };
  }
}

// flat JSONL → 2D turn 结构：相邻同 turnId 的记录归入同一组（写入顺序即分组顺序）。
function groupByTurn<T extends { turnId: number }>(flat: T[]): TurnGroup<T>[] {
  const groups: TurnGroup<T>[] = [];
  for (const item of flat) {
    const tail = groups[groups.length - 1];
    if (tail && tail.turnId === item.turnId) {
      tail.items.push(item);
    } else {
      groups.push({ turnId: item.turnId, items: [item] });
    }
  }
  return groups;
}

// 2D turn 结构 → flat：仅拍平，不校验 turnId 单调性。
function flattenTurns<T>(turns: TurnGroup<T>[]): T[] {
  return turns.flatMap((t) => t.items);
}

// 【失败处理约定】
// 内存态是唯一事实源，磁盘只是它的投影。所有方法（append*/saveMeta 与生命周期方法）
// 失败时均以 PersistenceError（{ code, message }）返回，绝不 throw 到 event loop
// （避免 UnhandledRejection）；由 Session 层判断是否需要用户感知并向上传递为 SessionError。
// 因此 Persistence 实现必须：
//   1) 捕获所有 IO/JSON 异常，写日志并以 PersistenceError 返回，不直接 throw；
//   2) 单条 append 内部序列化失败不影响其余条目（保持"尽力而为"的顺序推进），
//      但整体 write/mkdir 失败必须作为 PersistenceError 返回，让调用方可感知；
//   3) 严禁在 IO 失败时静默丢弃内存态——那是调用方（Session）的数据。

// TODO: 磁盘一致性问题——当前实现仅保证"能力可用"，未处理以下不一致场景：
// 【问题 1】跨文件不一致：event.jsonl 与 message.jsonl 是两个独立文件，各自 fire-and-forget
//        写入。进程崩溃或 IO 中途失败时，可能出现 event 已含 turn_done、但对应 assistant
//        message 缺失（或反之）。冷启动 rehydrate 会拿到"半个 turn"，fork/provider 拉历史
//        时会构造出畸形对话序列。
// 【问题 2】同进程写入乱序：多次 void persistence.appendXxx 之间的 fs.write 完成顺序不保证；
//        文件内行序可能与业务写入顺序不一致。
// 【问题 3】跨进程竞态：多个 server 进程或多个 Session 实例可能并发 append 同一文件，
//        导致行内容交错、meta.jsonc 覆盖错乱。
//
// 【方案（后续实现）】
//   1) 单 session 内维持一条 IO 串行队列（Promise chain），保证同进程内 append 顺序落盘；
//      event 与 message 的写入编排到同一队列，可选按 turn 打 barrier，保证 turn_done
//      落盘时该 turn 的所有 message 已在盘上。
//   2) 冷启动时校验 event.jsonl 与 message.jsonl 尾部一致性：以最后一条 turn_done 事件的
//      turnId 为 truth，丢弃两文件中超过该 turnId 的孤儿行（未 done 的残余）。
//   3) 跨进程竞态用 proper-lockfile 做文件级锁，或迁移到 SQLite 事务写入（见问题 3）。
// 当前仅承诺单进程、无崩溃、正常关闭下的正确性；异常场景以"最后若干条事件/消息可能丢失
// 或错位"为可接受语义。
export abstract class Persistence {
  abstract list(): Promise<SessionListEntry[] | PersistenceError>;
  abstract read(sessionId: string): Promise<SessionSnapshot | PersistenceError>;
  abstract readMeta(sessionId: string): Promise<SessionMeta | PersistenceError>;
  abstract appendEvents(sessionId: string, events: UiEvent[]): Promise<null | PersistenceError>;
  abstract appendMessages(
    sessionId: string,
    messages: SessionMessage[],
  ): Promise<null | PersistenceError>;
  abstract saveMeta(sessionId: string, meta: SessionMeta): Promise<null | PersistenceError>;
  abstract create(sessionId: string, info?: SessionSnapshot): Promise<null | PersistenceError>;
  abstract delete(sessionId: string): Promise<void>;
  abstract loadCounter(): Promise<number | PersistenceError>;
  abstract saveCounter(counter: number): Promise<null | PersistenceError>;
  /**
   * 原子替换 session 的 events / messages 文件（临时文件 + rename）。
   * 用于 Session.runTurn 剔除冷启动残留的未完成 turn 后，将磁盘同步为 completed-only。
   * meta 不在此接口内改动；如需同步更新 meta 由调用方另行 saveMeta。
   */
  abstract rewriteAll(
    sessionId: string,
    payload: { eventTurns: EventTurn[]; messageTurns: MessageTurn[] },
  ): Promise<null | PersistenceError>;
}

const EVENT_FILE = 'event.jsonl';
const MESSAGE_FILE = 'message.jsonl';
const META_FILE = 'meta.jsonc';
const GLOBAL_META_FILE = 'meta.jsonc';

export class FsPersistence extends Persistence {
  private readonly root: string;

  constructor(root: string) {
    super();
    this.root = root;
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.root, sessionId);
  }

  // 读取 jsonl：整体 fs 失败向上抛 PersistenceError；单行 JSON 失败 skip 并 logger.error（尾部半写入语义）。
  private async readJsonl<T>(file: string): Promise<T[] | PersistenceError> {
    const raw = await safeReadFile(file);
    if (isPersistenceError(raw)) {
      return raw;
    }
    const out: T[] = [];
    let lineNo = 0;
    for (const line of raw.split('\n')) {
      lineNo += 1;
      if (line.trim() === '') {
        continue;
      }
      const parsed = safeJsonParse<T>(line);
      if (isPersistenceError(parsed)) {
        logger.error('persistence.readJsonl.lineCorrupted', {
          file,
          lineNo,
          error: parsed.message,
        });
        continue;
      }
      out.push(parsed);
    }
    return out;
  }

  async list(): Promise<SessionListEntry[] | PersistenceError> {
    const entries = await safeReaddir(this.root);
    if (isPersistenceError(entries)) {
      logger.error('persistence.list.readdirFailed', {
        root: this.root,
        error: entries.message,
      });
      return entries;
    }
    const out: SessionListEntry[] = [];
    for (const id of entries) {
      const metaPath = path.join(this.sessionDir(id), META_FILE);
      const raw = await safeReadFile(metaPath);
      if (isPersistenceError(raw)) {
        logger.error('persistence.list.readMetaFailed', {
          sessionId: id,
          code: raw.code,
          error: raw.message,
        });
        continue;
      }
      const meta = safeJsonParse<SessionMeta>(raw);
      if (isPersistenceError(meta)) {
        logger.error('persistence.list.metaCorrupted', {
          sessionId: id,
          error: meta.message,
        });
        continue;
      }
      out.push({ id, ...meta });
    }
    return out;
  }

  async read(sessionId: string): Promise<SessionSnapshot | PersistenceError> {
    const dir = this.sessionDir(sessionId);
    const events = await this.readJsonl<UiEvent>(path.join(dir, EVENT_FILE));
    if (isPersistenceError(events)) {
      logger.error('persistence.read.readEventsFailed', {
        sessionId,
        code: events.code,
        error: events.message,
      });
      return events;
    }
    const messages = await this.readJsonl<SessionMessage>(path.join(dir, MESSAGE_FILE));
    if (isPersistenceError(messages)) {
      logger.error('persistence.read.readMessagesFailed', {
        sessionId,
        code: messages.code,
        error: messages.message,
      });
      return messages;
    }
    return { eventTurns: groupByTurn(events), messageTurns: groupByTurn(messages) };
  }

  async readMeta(sessionId: string): Promise<SessionMeta | PersistenceError> {
    const dir = this.sessionDir(sessionId);
    const metaRaw = await safeReadFile(path.join(dir, META_FILE));
    if (isPersistenceError(metaRaw)) {
      logger.error('persistence.readMeta.readFailed', { sessionId, error: metaRaw.message });
      return metaRaw;
    }
    const meta = safeJsonParse<SessionMeta>(metaRaw);
    if (isPersistenceError(meta)) {
      logger.error('persistence.readMeta.corrupted', { sessionId, error: meta.message });
      return { code: 'meta_corrupted', message: meta.message };
    }
    return meta;
  }

  async appendEvents(sessionId: string, events: UiEvent[]): Promise<null | PersistenceError> {
    if (events.length === 0) {
      return null;
    }
    const dir = this.sessionDir(sessionId);
    const mkErr = await safeMkdir(dir);
    if (mkErr) {
      logger.error('persistence.appendEvents.mkdirFailed', { sessionId, error: mkErr.message });
      return mkErr;
    }
    const lines: string[] = [];
    for (const e of events) {
      const s = safeJsonStringify(e);
      if (isPersistenceError(s)) {
        logger.error('persistence.appendEvents.stringifyFailed', {
          sessionId,
          error: s.message,
        });
        continue;
      }
      lines.push(s);
    }
    if (lines.length === 0) {
      return null;
    }
    const writeErr = await safeAppendFile(path.join(dir, EVENT_FILE), lines.join('\n') + '\n');
    if (writeErr) {
      logger.error('persistence.appendEvents.writeFailed', { sessionId, error: writeErr.message });
    }
    return writeErr;
  }

  async appendMessages(
    sessionId: string,
    messages: SessionMessage[],
  ): Promise<null | PersistenceError> {
    if (messages.length === 0) {
      return null;
    }
    const dir = this.sessionDir(sessionId);
    const mkErr = await safeMkdir(dir);
    if (mkErr) {
      logger.error('persistence.appendMessages.mkdirFailed', { sessionId, error: mkErr.message });
      return mkErr;
    }
    const lines: string[] = [];
    for (const m of messages) {
      const s = safeJsonStringify(m);
      if (isPersistenceError(s)) {
        logger.error('persistence.appendMessages.stringifyFailed', {
          sessionId,
          error: s.message,
        });
        continue;
      }
      lines.push(s);
    }
    if (lines.length === 0) {
      return null;
    }
    const writeErr = await safeAppendFile(path.join(dir, MESSAGE_FILE), lines.join('\n') + '\n');
    if (writeErr) {
      logger.error('persistence.appendMessages.writeFailed', {
        sessionId,
        error: writeErr.message,
      });
    }
    return writeErr;
  }

  async saveMeta(sessionId: string, meta: SessionMeta): Promise<null | PersistenceError> {
    const dir = this.sessionDir(sessionId);
    const mkErr = await safeMkdir(dir);
    if (mkErr) {
      logger.error('persistence.saveMeta.mkdirFailed', { sessionId, error: mkErr.message });
      return mkErr;
    }
    const raw = safeJsonStringify(meta, true);
    if (isPersistenceError(raw)) {
      logger.error('persistence.saveMeta.stringifyFailed', { sessionId, error: raw.message });
      return raw;
    }
    const writeErr = await safeWriteFile(path.join(dir, META_FILE), raw);
    if (writeErr) {
      logger.error('persistence.saveMeta.writeFailed', { sessionId, error: writeErr.message });
    }
    return writeErr;
  }

  async create(sessionId: string, info?: SessionSnapshot): Promise<null | PersistenceError> {
    const dir = this.sessionDir(sessionId);
    const mkErr = await safeMkdir(dir);
    if (mkErr) {
      logger.error('persistence.create.mkdirFailed', { sessionId, error: mkErr.message });
      return mkErr;
    }
    const now = Date.now();
    const meta: SessionMeta = {
      summary: info?.summary ?? '',
      createdAt: now,
      updatedAt: now,
    };
    const metaRaw = safeJsonStringify(meta, true);
    if (isPersistenceError(metaRaw)) {
      logger.error('persistence.create.metaStringifyFailed', { sessionId, error: metaRaw.message });
      return metaRaw;
    }
    const metaWriteErr = await safeWriteFile(path.join(dir, META_FILE), metaRaw);
    if (metaWriteErr) {
      logger.error('persistence.create.metaWriteFailed', {
        sessionId,
        error: metaWriteErr.message,
      });
      return metaWriteErr;
    }

    const eventsBody = this.serializeInitialLines(flattenTurns(info?.eventTurns ?? []));
    if (isPersistenceError(eventsBody)) {
      logger.error('persistence.create.eventsStringifyFailed', {
        sessionId,
        error: eventsBody.message,
      });
      return eventsBody;
    }
    const evWriteErr = await safeWriteFile(path.join(dir, EVENT_FILE), eventsBody);
    if (evWriteErr) {
      logger.error('persistence.create.eventsWriteFailed', {
        sessionId,
        error: evWriteErr.message,
      });
      return evWriteErr;
    }

    const messagesBody = this.serializeInitialLines(flattenTurns(info?.messageTurns ?? []));
    if (isPersistenceError(messagesBody)) {
      logger.error('persistence.create.messagesStringifyFailed', {
        sessionId,
        error: messagesBody.message,
      });
      return messagesBody;
    }
    const msgWriteErr = await safeWriteFile(path.join(dir, MESSAGE_FILE), messagesBody);
    if (msgWriteErr) {
      logger.error('persistence.create.messagesWriteFailed', {
        sessionId,
        error: msgWriteErr.message,
      });
    }
    return msgWriteErr;
  }

  private serializeInitialLines(items: unknown[]): string | PersistenceError {
    if (items.length === 0) {
      return '';
    }
    const lines: string[] = [];
    for (const it of items) {
      const s = safeJsonStringify(it);
      if (isPersistenceError(s)) {
        return s;
      }
      lines.push(s);
    }
    return lines.join('\n') + '\n';
  }

  async delete(sessionId: string): Promise<void> {
    const err = await safeRm(this.sessionDir(sessionId));
    if (err) {
      logger.error('persistence.delete.failed', { sessionId, error: err.message });
    }
  }

  async loadCounter(): Promise<number | PersistenceError> {
    const raw = await safeReadFile(path.join(this.root, GLOBAL_META_FILE));
    if (isPersistenceError(raw)) {
      // 首次运行无全局 meta 文件属正常，counter 归零；仅 IO 错误上抛。
      if (raw.code === 'not_found') {
        return 0;
      }
      logger.error('persistence.loadCounter.readFailed', { error: raw.message });
      return raw;
    }
    const parsed = safeJsonParse<{ counter?: unknown }>(raw);
    if (isPersistenceError(parsed)) {
      logger.error('persistence.loadCounter.parseFailed', { error: parsed.message });
      return parsed;
    }
    return typeof parsed.counter === 'number' ? parsed.counter : 0;
  }

  async saveCounter(counter: number): Promise<null | PersistenceError> {
    const mkErr = await safeMkdir(this.root);
    if (mkErr) {
      logger.error('persistence.saveCounter.mkdirFailed', { error: mkErr.message });
      return mkErr;
    }
    const raw = safeJsonStringify({ counter }, true);
    if (isPersistenceError(raw)) {
      logger.error('persistence.saveCounter.stringifyFailed', { error: raw.message });
      return raw;
    }
    const writeErr = await safeWriteFile(path.join(this.root, GLOBAL_META_FILE), raw);
    if (writeErr) {
      logger.error('persistence.saveCounter.writeFailed', { error: writeErr.message });
    }
    return writeErr;
  }

  async rewriteAll(
    sessionId: string,
    payload: { eventTurns: EventTurn[]; messageTurns: MessageTurn[] },
  ): Promise<null | PersistenceError> {
    const dir = this.sessionDir(sessionId);
    const mkErr = await safeMkdir(dir);
    if (mkErr) {
      logger.error('persistence.rewriteAll.mkdirFailed', { sessionId, error: mkErr.message });
      return mkErr;
    }
    const eventsBody = this.serializeInitialLines(flattenTurns(payload.eventTurns));
    if (isPersistenceError(eventsBody)) {
      logger.error('persistence.rewriteAll.eventsStringifyFailed', {
        sessionId,
        error: eventsBody.message,
      });
      return eventsBody;
    }
    const messagesBody = this.serializeInitialLines(flattenTurns(payload.messageTurns));
    if (isPersistenceError(messagesBody)) {
      logger.error('persistence.rewriteAll.messagesStringifyFailed', {
        sessionId,
        error: messagesBody.message,
      });
      return messagesBody;
    }
    const evPath = path.join(dir, EVENT_FILE);
    const msgPath = path.join(dir, MESSAGE_FILE);
    const evTmp = `${evPath}.tmp`;
    const msgTmp = `${msgPath}.tmp`;
    const evWriteErr = await safeWriteFile(evTmp, eventsBody);
    if (evWriteErr) {
      logger.error('persistence.rewriteAll.eventsWriteFailed', {
        sessionId,
        error: evWriteErr.message,
      });
      return evWriteErr;
    }
    const msgWriteErr = await safeWriteFile(msgTmp, messagesBody);
    if (msgWriteErr) {
      logger.error('persistence.rewriteAll.messagesWriteFailed', {
        sessionId,
        error: msgWriteErr.message,
      });
      return msgWriteErr;
    }
    const evRenameErr = await safeRename(evTmp, evPath);
    if (evRenameErr) {
      logger.error('persistence.rewriteAll.renameFailed', {
        sessionId,
        error: evRenameErr.message,
      });
      return evRenameErr;
    }
    const msgRenameErr = await safeRename(msgTmp, msgPath);
    if (msgRenameErr) {
      logger.error('persistence.rewriteAll.renameFailed', {
        sessionId,
        error: msgRenameErr.message,
      });
    }
    return msgRenameErr;
  }
}

export const persistence: Persistence = new FsPersistence(
  path.join(runtimeRoot, '.miniagent/sessions'),
);
