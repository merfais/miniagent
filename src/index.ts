#!/usr/bin/env node

import { logger } from './core/logger.js';
import { startServer } from './server/main.js';
import { startCli } from './ui-cli/main.js';

const arg = process.argv[2];

async function main(): Promise<void> {
  if (arg === 'server') {
    await startServer();
    return;
  }
  if (arg === 'cli') {
    await startCli();
    return;
  }
  process.stderr.write(
    'Usage:\n  miniagent server   # start Agent HTTP server\n  miniagent cli      # start CLI UI (connects to running server)\n',
  );
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('main.uncaught', { error: err.message });
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}
