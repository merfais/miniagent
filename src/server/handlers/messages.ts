import type { Handler } from '../http/router.js';
import type { SessionStore } from '../sessions.js';

export function postMessage(sessionStore: SessionStore): Handler {
  return async (ctx) => {
    const sessionId = ctx.query.get('sessionId') ?? '';
    const session = sessionStore.get(sessionId);
    if (!session) {
      return ctx.fail(404, 'session_not_found', `session ${sessionId} not found`);
    }

    const body = await ctx.readJson<{ content?: unknown }>();
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) {
      return ctx.fail(400, 'invalid_content', 'body.content must be a non-empty string');
    }

    const accepted = session.startTurn(content);
    if (!accepted) {
      return ctx.ok({ queued: false, error: 'turn_in_progress' });
    }
    ctx.ok();
  };
}
