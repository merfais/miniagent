import fs from 'node:fs';
import path from 'node:path';

import { resolveConfig } from '../config/app-config.js';
import { createBootLogger, logger, stdLogger } from '../core/logger.js';
import { runtimeRoot } from '../core/workspace.js';
import { initSessionStore } from '../session/session-store.js';
import { listen } from './http/server.js';
import { createRouter } from './routes.js';

const HOST = '127.0.0.1';
const PORT = 0;

export async function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const config = await resolveConfig();
  createBootLogger(config.log);

  if (!config.provider) {
    throw new Error(
      'provider config missing; set OPENAI_API_KEY / ANTHROPIC_API_KEY or config file',
    );
  }
  initSessionStore();
  const router = createRouter();

  const server = await listen(router, { host: HOST, port: PORT });

  const runtimeDir = path.join(runtimeRoot, '.miniagent');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, 'runtime.json'),
    JSON.stringify({ host: HOST, port: server.port, pid: process.pid }, null, 2),
    'utf8',
  );

  stdLogger.info(`agent server listening on http://${HOST}:${server.port}`);
  logger.info('server.listen', { host: HOST, port: server.port });

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
