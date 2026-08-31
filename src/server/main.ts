import fs from 'node:fs';
import path from 'node:path';

import { resolveConfig } from '../config/app-config.js';
import { createBootLogger, logger, stdLogger } from '../core/logger.js';
import { listen } from './http/server.js';
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

  const sessionStore = new SessionStore({ config, cwd });
  const router = createRouter(sessionStore);

  const host = opts.host ?? '127.0.0.1';
  const server = await listen(router, { host, port: opts.port ?? 0 });

  const runtimeDir = path.join(cwd, '.miniagent');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, 'runtime.json'),
    JSON.stringify({ host, port: server.port, pid: process.pid }, null, 2),
    'utf8',
  );

  stdLogger.info(`agent server listening on http://${host}:${server.port}`);
  logger.info('server.listen', { host, port: server.port });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('server.uncaught', { error: err.message });
    stdLogger.error(err.message);
    process.exitCode = 1;
  });
}
