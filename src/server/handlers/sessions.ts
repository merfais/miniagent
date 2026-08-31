import type { Handler } from '../http/router.js';
import type { SseEvent } from '../http/sse.js';
import type { SessionStore } from '../sessions.js';

export function createSession(sessionStore: SessionStore): Handler {
  return (ctx) => {
    const session = sessionStore.create();
    ctx.ok({ sessionId: session.id });
  };
}

export function subscribeEvents(_: SessionStore): Handler {
  return async (ctx) => {
    // 旧实现（保留以便迭代 session 时对齐订阅/取消订阅逻辑）：
    // const sessionId = ctx.query.get('sessionId') ?? '';
    // const session = sessionStore.get(sessionId);
    // if (!session) {
    //   return ctx.fail(404, 'session_not_found', `session ${sessionId} not found`);
    // }
    // const queue = new AsyncQueue<AgentEvent>();
    // const unsubscribe = session.subscribe((event) => queue.push(event));
    // try {
    //   await ctx.sse(queue);
    // } finally {
    //   unsubscribe();
    // }
    //
    // TODO: 接入真实 session 模块，替换下方 mock。约定形态：
    //   const session = sessions.getOrCreate(ctx.query.get('sessionId'));
    //   const lastId = ctx.header('last-event-id') ?? null;
    //   await ctx.sse((signal) => session.subscribe(lastId, signal));
    // 其中 session.subscribe(afterEventId, signal): AsyncIterable<SseEvent>
    // 内部负责：基于 eventId 的 replay + live 合并；感知 signal，
    // signal abort 时立刻让 next() resolve 成 { done: true } 并回收订阅。
    await ctx.sse(mockSseSource);
  };
}

export function cancelTurn(sessionStore: SessionStore): Handler {
  return (ctx) => {
    const sessionId = ctx.query.get('sessionId') ?? '';
    const session = sessionStore.get(sessionId);
    if (!session) {
      return ctx.fail(404, 'session_not_found', `session ${sessionId} not found`);
    }
    session.agent.cancel();
    ctx.ok();
  };
}

async function* mockSseSource(signal: AbortSignal): AsyncIterable<SseEvent> {
  let n = 0;
  while (n < 3 && !signal.aborted) {
    yield { id: String(++n), type: 'mock', data: { n } };
    await new Promise((r) => setTimeout(r, 100));
  }
}
