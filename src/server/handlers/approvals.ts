import type { ApprovalDecision } from '../../core/events.js';
import type { Handler } from '../http/router.js';
import type { SessionStore } from '../sessions.js';

export function postApproval(sessionStore: SessionStore): Handler {
  return async (ctx) => {
    const approvalId = ctx.query.get('approvalId') ?? '';
    if (!approvalId) {
      return ctx.fail(400, 'invalid_approval_id', 'approvalId required');
    }
    const body = await ctx.readJson<{ decision?: unknown; sessionId?: unknown }>();
    const decision = body.decision;
    if (decision !== 'approve' && decision !== 'deny') {
      return ctx.fail(400, 'invalid_decision', 'decision must be "approve" or "deny"');
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const session = sessionStore.get(sessionId);
    if (!session) {
      return ctx.fail(404, 'session_not_found', `session ${sessionId} not found`);
    }
    session.agent.approve(approvalId, decision as ApprovalDecision);
    ctx.ok();
  };
}
