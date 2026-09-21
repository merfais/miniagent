import type { Handler } from './http/router.js';
import type { SseEvent } from './http/sse.js';

// 旧实现（依赖 SessionStore，随 SessionStore 一并作废）：
// export function createSession(sessionStore: SessionStore): Handler {
//   return (ctx) => {
//     const session = sessionStore.create();
//     ctx.ok({ sessionId: session.id });
//   };
// }
// export function subscribeEvents(sessionStore: SessionStore): Handler {
//   return async (ctx) => {
//     const sessionId = ctx.query.get('sessionId') ?? '';
//     const session = sessionStore.get(sessionId);
//     if (!session) return ctx.fail(404, 'session_not_found', `session ${sessionId} not found`);
//     const queue = new AsyncQueue<AgentEvent>();
//     const unsubscribe = session.subscribe((event) => queue.push(event));
//     try { await ctx.sse(queue); } finally { unsubscribe(); }
//   };
// }
// export function cancelTurn(sessionStore: SessionStore): Handler {
//   return (ctx) => {
//     const sessionId = ctx.query.get('sessionId') ?? '';
//     const session = sessionStore.get(sessionId);
//     if (!session) return ctx.fail(404, 'session_not_found', `session ${sessionId} not found`);
//     session.agent.cancel();
//     ctx.ok();
//   };
// }
//
// TODO: 接入真实 session 模块后，约定形态：
//   const session = sessions.getOrCreate(ctx.query.get('sessionId'));
//   const lastId = ctx.header('last-event-id') ?? null;
//   await ctx.sse((signal) => session.subscribe(lastId, signal));
// session.subscribe(afterEventId, signal): AsyncIterable<SseEvent>
// 内部负责 eventId replay + live 合并；signal abort 时立即 resolve done 并回收订阅。

export const createSession: Handler = (ctx) => {
  ctx.ok({ sessionId: 'mock-session' });
};

export const subscribeEvents: Handler = async (ctx) => {
  await ctx.sse(mockSseSource);
};

export const cancelTurn: Handler = (ctx) => {
  ctx.ok();
};

async function* mockSseSource(signal: AbortSignal): AsyncIterable<SseEvent> {
  let n = 0;
  while (n < 3 && !signal.aborted) {
    n += 1;
    yield { id: String(n), type: 'mock', data: { n } };
    await new Promise((r) => setTimeout(r, 100));
  }
}
