import type { IncomingMessage, ServerResponse } from 'node:http';

import { writeSse, type SseSource } from './sse.js';

const MAX_JSON_BODY_BYTES = 1_000_000;

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

interface ApiOk<T = undefined> {
  ok: true;
  data?: T;
}

interface ApiErr {
  ok: false;
  error: { code: string; message: string };
}

export interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: Method;
  query: URLSearchParams;
  header(name: string): string | undefined;
  readJson<T = unknown>(): Promise<T>;
  ok<T>(data?: T): void;
  fail(status: number, code: string, message: string): void;
  sse(source: SseSource): Promise<void>;
  abort(): void;
  readonly signal: AbortSignal;
}

export function createContext(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: Method,
): Context {
  const controller = new AbortController();

  const sendJson = (status: number, body: ApiOk<unknown> | ApiErr): void => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  return {
    req,
    res,
    url,
    method,
    query: url.searchParams,
    signal: controller.signal,
    header(name) {
      const v = req.headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    },
    readJson: <T>() => readJsonBody(req) as Promise<T>,
    ok<T>(data?: T): void {
      sendJson(200, { ok: true, ...(data === undefined ? {} : { data }) });
    },
    fail(status, code, message): void {
      sendJson(status, { ok: false, error: { code, message } });
    },
    sse: (source) => writeSse(req, res, source, controller.signal),
    abort(): void {
      controller.abort();
    },
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_JSON_BODY_BYTES) {
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
