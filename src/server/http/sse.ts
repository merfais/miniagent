import type { IncomingMessage, ServerResponse } from 'node:http';

const SSE_RETRY_MS = 3_000;
const SSE_HEARTBEAT_MS = 15_000;
const SSE_MAX_BUFFERED_BYTES = 1_000_000;
const SSE_FIELD_CTRL = /[\r\n\0]/g;

export interface SseEvent {
  id: string;
  type: string;
  data: unknown;
}

// 上游必须感知 signal：signal abort 后，next() 应尽快 resolve 成 { done: true }，
// 由此释放 pending 的 promise 和上游持有的资源（订阅、缓冲等）。
export type SseSource = (signal: AbortSignal) => AsyncIterable<SseEvent>;

// SSE 字段值不能包含 \r \n \0：\r\n 会伪造出新字段行（SSE 版响应拆分），
// \0 会让客户端把整个 id 丢弃。上游正常时不会出现，做一层兜底。
function sanitizeField(v: string): string {
  return v.replace(SSE_FIELD_CTRL, '');
}

export async function writeSse(
  req: IncomingMessage,
  res: ServerResponse,
  source: SseSource,
  signal: AbortSignal,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`retry: ${SSE_RETRY_MS}\n\n`);

  const iter = source(signal)[Symbol.asyncIterator]();
  let closed = false;

  const shutdown = (destroy: boolean): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (destroy) {
      res.destroy();
    } else {
      res.end();
    }
  };

  const onClientClose = (): void => shutdown(false);
  const onAbort = (): void => shutdown(true);
  req.on('close', onClientClose);
  signal.addEventListener('abort', onAbort);

  const heartbeat = setInterval(() => {
    if (closed || !res.writable) {
      return;
    }
    res.write(':hb\n\n');
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();

  try {
    while (!closed && res.writable) {
      const r = await iter.next();
      if (r.done || closed || !res.writable) {
        break;
      }
      const e = r.value;
      const chunk = `id: ${sanitizeField(e.id)}\nevent: ${sanitizeField(e.type)}\ndata: ${JSON.stringify(e.data)}\n\n`;
      res.write(chunk);
      if (res.writableLength > SSE_MAX_BUFFERED_BYTES) {
        shutdown(true);
      }
    }
  } finally {
    clearInterval(heartbeat);
    req.off('close', onClientClose);
    signal.removeEventListener('abort', onAbort);
    if (!closed) {
      closed = true;
      res.end();
    }
  }
}
