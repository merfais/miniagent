import { postApproval } from './handlers/approvals.js';
import { postMessage } from './handlers/messages.js';
import { cancelTurn, createSession, subscribeEvents } from './handlers/sessions.js';
import { Router } from './http/router.js';
import type { SessionStore } from './sessions.js';

export function createRouter(sessionStore: SessionStore) {
  const router = new Router();
  router.post('/sessions', createSession(sessionStore));
  router.get('/events', subscribeEvents(sessionStore));
  router.post('/messages', postMessage(sessionStore));
  router.post('/cancel', cancelTurn(sessionStore));
  router.post('/approvals', postApproval(sessionStore));
  return router.handle;
}
