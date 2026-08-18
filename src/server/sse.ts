import type { ServerResponse } from 'node:http';

import type { AgentEvent } from '../core/events.js';

export interface SseSink {
  send(event: AgentEvent): void;
  close(): void;
  isOpen(): boolean;
}

export function attachSseSink(res: ServerResponse): SseSink {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': ok\n\n');

  let open = true;
  const close = (): void => {
    if (!open) {
      return;
    }
    open = false;
    try {
      res.end();
    } catch {
      // ignore
    }
  };
  res.on('close', close);

  return {
    send(event: AgentEvent): void {
      if (!open) {
        return;
      }
      try {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        open = false;
      }
    },
    close,
    isOpen: () => open,
  };
}
