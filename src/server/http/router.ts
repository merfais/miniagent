import type { IncomingMessage, ServerResponse } from 'node:http';

import { logger } from '../../core/logger.js';
import { createContext, type Context, type Method } from './context.js';

export type { Context } from './context.js';

export type Handler = (ctx: Context) => Promise<void> | void;

export class Router {
  private readonly routes = new Map<string, Handler>();

  private register(method: Method, path: string, handler: Handler): this {
    this.routes.set(`${method} ${path}`, handler);
    return this;
  }

  get(path: string, handler: Handler): this {
    return this.register('GET', path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.register('POST', path, handler);
  }

  handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET') as Method;
    const ctx = createContext(req, res, url, method);

    try {
      const handler = this.routes.get(`${method} ${url.pathname}`);
      if (!handler) {
        return ctx.fail(404, 'not_found', `${method} ${url.pathname}`);
      }
      await handler(ctx);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('router.uncaught', { path: url.pathname, method, error: err.message });
      if (!res.headersSent) {
        ctx.fail(500, 'internal_error', err.message);
      }
    }
  };
}
