import type { IncomingMessage, ServerResponse } from 'node:http';

import { logger } from '../core/logger.js';
import type { ApprovalDecision } from '../core/events.js';
import type { SessionStore } from './sessions.js';
import { attachSseSink } from './sse.js';

interface ApiOk<T = undefined> {
  ok: true;
  data?: T;
}

interface ApiErr {
  ok: false;
  error: { code: string; message: string };
}

function sendJson(res: ServerResponse, status: number, body: ApiOk<unknown> | ApiErr): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function ok<T>(res: ServerResponse, data?: T): void {
  sendJson(res, 200, { ok: true, ...(data === undefined ? {} : { data }) });
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, error: { code, message } });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) {
        return resolve({});
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

export function createRouter(sessions: SessionStore) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const path = url.pathname;

    try {
      if (method === 'POST' && path === '/sessions') {
        const session = sessions.create();
        return ok(res, { sessionId: session.id });
      }

      if (method === 'GET' && path === '/events') {
        const sessionId = url.searchParams.get('sessionId') ?? '';
        const session = sessions.get(sessionId);
        if (!session) {
          return fail(res, 404, 'session_not_found', `session ${sessionId} not found`);
        }
        const sink = attachSseSink(res);
        sessions.attachSink(sessionId, sink);
        return;
      }

      if (method === 'POST' && path === '/messages') {
        const sessionId = url.searchParams.get('sessionId') ?? '';
        const session = sessions.get(sessionId);
        if (!session) {
          return fail(res, 404, 'session_not_found', `session ${sessionId} not found`);
        }

        const body = (await readJsonBody(req)) as { content?: unknown };
        const content = typeof body.content === 'string' ? body.content.trim() : '';
        if (!content) {
          return fail(res, 400, 'invalid_content', 'body.content must be a non-empty string');
        }

        if (session.turnInProgress) {
          return ok(res, { queued: false, error: 'turn_in_progress' });
        }

        session.turnInProgress = true;
        ok(res);

        void (async () => {
          try {
            for await (const event of session.agent.sendUserMessage(content)) {
              sessions.emit(session, event);
              if (event.type === 'turn_done') {
                session.turnInProgress = false;
              }
            }
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error('messages.pump.error', { sessionId, error: err.message });
            session.turnInProgress = false;
          }
        })();
        return;
      }

      if (method === 'POST' && path === '/cancel') {
        const sessionId = url.searchParams.get('sessionId') ?? '';
        const session = sessions.get(sessionId);
        if (!session) {
          return fail(res, 404, 'session_not_found', `session ${sessionId} not found`);
        }
        session.agent.cancel();
        return ok(res);
      }

      if (method === 'POST' && path === '/approvals') {
        const approvalId = url.searchParams.get('approvalId') ?? '';
        if (!approvalId) {
          return fail(res, 400, 'invalid_approval_id', 'approvalId required');
        }
        const body = (await readJsonBody(req)) as { decision?: unknown; sessionId?: unknown };
        const decision = body.decision;
        if (decision !== 'approve' && decision !== 'deny') {
          return fail(res, 400, 'invalid_decision', 'decision must be "approve" or "deny"');
        }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        const session = sessions.get(sessionId);
        if (!session) {
          return fail(res, 404, 'session_not_found', `session ${sessionId} not found`);
        }
        session.agent.approve(approvalId, decision as ApprovalDecision);
        return ok(res);
      }

      return fail(res, 404, 'not_found', `${method} ${path}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('router.uncaught', { path, method, error: err.message });
      if (!res.headersSent) {
        fail(res, 500, 'internal_error', err.message);
      }
    }
  };
}
