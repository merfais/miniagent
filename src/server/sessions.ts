import type { AppConfig } from '../config/app-config.js';
import { createAgent } from '../core/agent.js';
import type { Agent, AgentEvent } from '../core/events.js';
import { createSessionLogger, logger, type Logger } from '../core/logger.js';
import type { SseSink } from './sse.js';

export interface Session {
  id: string;
  agent: Agent;
  logger: Logger;
  sink?: SseSink;
  turnInProgress: boolean;
}

export interface SessionsOptions {
  config: AppConfig;
  cwd: string;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly opts: SessionsOptions) {}

  create(): Session {
    const { sessionId, logger: sessionLogger } = createSessionLogger();
    const agent = createAgent({
      config: this.opts.config,
      cwd: this.opts.cwd,
      logger: sessionLogger,
    });
    const session: Session = { id: sessionId, agent, logger: sessionLogger, turnInProgress: false };
    this.sessions.set(sessionId, session);
    logger.info('session.create', { sessionId });
    sessionLogger.info('session.create', { sessionId });
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  attachSink(id: string, sink: SseSink): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    if (session.sink && session.sink.isOpen()) {
      session.sink.close();
    }
    session.sink = sink;
    return true;
  }

  emit(session: Session, event: AgentEvent): void {
    if (session.sink && session.sink.isOpen()) {
      session.sink.send(event);
    }
  }
}
