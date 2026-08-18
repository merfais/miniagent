import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { resolveConfig } from '../config/app-config.js';
import { createBootLogger, logger, stdLogger } from '../core/logger.js';
import { createRouter } from './routes.js';
import { SessionStore } from './sessions.js';

interface StartOptions {
  cwd?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  port?: number;
  host?: string;
}

export async function startServer(
  opts: StartOptions = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  const cwd = opts.cwd ?? process.cwd();
  const configPath = opts.configPath ?? path.join(cwd, 'miniagent.config.json');
  const env = opts.env ?? process.env;

  const config = await resolveConfig({ cwd, configPath, env });
  createBootLogger(config.log);

  const sessions = new SessionStore({ config, cwd });
  const router = createRouter(sessions);

  const server = http.createServer((req, res) => {
    void router(req, res);
  });

  const port = opts.port ?? 0;
  const host = opts.host ?? '127.0.0.1';

  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  const runtimeDir = path.join(cwd, '.miniagent');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, 'runtime.json'),
    JSON.stringify({ host, port: actualPort, pid: process.pid }, null, 2),
    'utf8',
  );

  stdLogger.info(`agent server listening on http://${host}:${actualPort}`);
  logger.info('server.listen', { host, port: actualPort });

  return {
    port: actualPort,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('server.uncaught', { error: err.message });
    stdLogger.error(err.message);
    process.exitCode = 1;
  });
}
