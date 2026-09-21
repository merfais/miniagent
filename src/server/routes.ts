import { Router } from './http/router.js';
import { postApproval } from './approvals.js';
import { postMessage } from './messages.js';
import { cancelTurn, createSession, subscribeEvents } from './sessions.js';

export function createRouter() {
  const router = new Router();
  router.post('/sessions', createSession);
  router.get('/events', subscribeEvents);
  router.post('/messages', postMessage);
  router.post('/cancel', cancelTurn);
  router.post('/approvals', postApproval);
  return router.handle;
}
