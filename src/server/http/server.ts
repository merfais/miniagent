import http from 'node:http';

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface HttpServer {
  port: number;
  close: () => Promise<void>;
}

export async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  opts: { host: string; port: number },
): Promise<HttpServer> {
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;

  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
