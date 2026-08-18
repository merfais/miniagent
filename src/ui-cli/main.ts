import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { AgentClient } from './client.js';
import { createRenderer } from './renderer.js';

interface CliOptions {
  baseUrl?: string;
  cwd?: string;
}

function loadBaseUrl(cwd: string, override?: string): string {
  if (override) {
    return override;
  }
  const env = process.env.MINIAGENT_URL;
  if (env) {
    return env;
  }
  const runtimePath = path.join(cwd, '.miniagent', 'runtime.json');
  try {
    const raw = fs.readFileSync(runtimePath, 'utf8');
    const info = JSON.parse(raw) as { host?: string; port?: number };
    if (info.host && info.port) {
      return `http://${info.host}:${info.port}`;
    }
  } catch {
    // ignore
  }
  throw new Error(
    `cannot find agent server. Start it first, or set MINIAGENT_URL. Looked at ${runtimePath}.`,
  );
}

export async function startCli(opts: CliOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const baseUrl = loadBaseUrl(cwd, opts.baseUrl);
  const client = new AgentClient({ baseUrl });

  const created = await client.createSession();
  if (!created.ok || !created.data) {
    process.stderr.write(
      `failed to create session: ${!created.ok ? created.error.message : 'no data'}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const sessionId = created.data.sessionId;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const out = process.stdout;
  out.write(
    `connected to ${baseUrl}\nsession: ${sessionId}\ntype your message; /cancel to interrupt; /exit to quit.\n\n`,
  );

  let turnBusy = false;
  const render = createRenderer({
    client,
    sessionId,
    out,
    rl,
    onTurnDone: () => {
      turnBusy = false;
      promptInput();
    },
  });

  const eventsAbort = new AbortController();
  void (async () => {
    try {
      for await (const event of client.events(sessionId, eventsAbort.signal)) {
        await render(event);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      out.write(`\n[events stream closed] ${err.message}\n`);
    }
  })();

  const promptInput = (): void => {
    if (turnBusy) {
      return;
    }
    rl.question('> ', async (line) => {
      const input = line.trim();
      if (!input) {
        return promptInput();
      }
      if (input === '/exit') {
        eventsAbort.abort();
        rl.close();
        return;
      }
      if (input === '/cancel') {
        await client.cancel(sessionId);
        return promptInput();
      }
      turnBusy = true;
      const resp = await client.sendMessage(sessionId, input);
      if (!resp.ok) {
        out.write(`[send failed] ${resp.error.message}\n`);
        turnBusy = false;
        promptInput();
      }
    });
  };

  promptInput();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startCli().catch((error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}
