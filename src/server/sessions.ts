import type { AppConfig } from '../config/app-config.js';
import { createAgent } from '../core/agent.js';
import type { Agent, AgentEvent } from '../core/events.js';
import { createSessionLogger, logger, type Logger } from '../core/logger.js';

export type EventListener = (event: AgentEvent) => void;

export interface Session {
  id: string;
  agent: Agent;
  logger: Logger;
  turnInProgress: boolean;
  subscribe(listener: EventListener): () => void;
  startTurn(content: string): boolean;
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
    const listeners = new Set<EventListener>();
    const session: Session = {
      id: sessionId,
      agent,
      logger: sessionLogger,
      turnInProgress: false,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startTurn(content) {
        if (this.turnInProgress) {
          return false;
        }
        this.turnInProgress = true;
        void (async () => {
          try {
            for await (const event of agent.sendUserMessage(content)) {
              for (const l of listeners) {
                l(event);
              }
              if (event.type === 'turn_done') {
                this.turnInProgress = false;
              }
            }
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            sessionLogger.error('session.turn.error', { sessionId, error: err.message });
            this.turnInProgress = false;
          }
        })();
        return true;
      },
    };
    this.sessions.set(sessionId, session);
    logger.info('session.create', { sessionId });
    sessionLogger.info('session.create', { sessionId });
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }
}
