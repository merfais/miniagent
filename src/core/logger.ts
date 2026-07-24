import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { SessionLogger } from './types.js';

interface ResolveLogFilePathOptions {
  workspaceRoot: string;
  logDir?: string;
  sessionId: string;
  now?: Date;
}

interface RenderLogEntry {
  sessionId: string;
  event: string;
  step?: unknown;
  toolName?: unknown;
}

interface CreateSessionLoggerOptions {
  workspaceRoot: string;
  sessionId: string;
  logDir?: string;
  logToCli?: boolean;
  cliWriter?: (line: string) => void;
  now?: Date;
}

export function createSessionId(): string {
  return crypto.randomBytes(4).toString('hex');
}

export function formatDateForLogDir(now: Date = new Date()): string {
  const value = new Date(now);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

export function resolveLogFilePath({
  workspaceRoot,
  logDir = 'logs',
  sessionId,
  now = new Date(),
}: ResolveLogFilePathOptions): string {
  const baseDir = path.isAbsolute(logDir) ? logDir : path.join(workspaceRoot, logDir);
  return path.join(baseDir, formatDateForLogDir(now), `${sessionId}.log`);
}

export function renderLogLine(entry: RenderLogEntry): string {
  const parts = ['[log]', `session=${entry.sessionId}`, `event=${entry.event}`];

  if (entry.step !== undefined) {
    parts.push(`step=${String(entry.step)}`);
  }

  if (entry.toolName) {
    parts.push(`tool=${String(entry.toolName)}`);
  }

  return `${parts.join(' ')}\n`;
}

export function createSessionLogger({
  workspaceRoot,
  sessionId,
  logDir = 'logs',
  logToCli = false,
  cliWriter = () => {},
  now = new Date(),
}: CreateSessionLoggerOptions): SessionLogger {
  const filePath = resolveLogFilePath({ workspaceRoot, logDir, sessionId, now });
  let ensureDirectoryPromise: Promise<void> | undefined;

  async function ensureDirectory(): Promise<void> {
    if (!ensureDirectoryPromise) {
      ensureDirectoryPromise = fs
        .mkdir(path.dirname(filePath), { recursive: true })
        .then(() => undefined);
    }

    return ensureDirectoryPromise;
  }

  return {
    sessionId,
    filePath,
    async log(event: Record<string, unknown>): Promise<Record<string, unknown>> {
      const entry = {
        timestamp: new Date().toISOString(),
        sessionId,
        ...event,
      };

      await ensureDirectory();
      await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');

      if (logToCli) {
        cliWriter(
          renderLogLine({
            sessionId,
            event: String(event.event),
            step: event.step,
            toolName: event.toolName,
          }),
        );
      }

      return entry;
    },
  };
}

export async function logEvent(
  logger: Pick<SessionLogger, 'log'> | null | undefined,
  event: Record<string, unknown>,
): Promise<void> {
  if (!logger || typeof logger.log !== 'function') {
    return;
  }

  try {
    await logger.log(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    try {
      process.stderr.write(`[log-error] ${message}\n`);
    } catch {
      // Intentionally ignore stderr failures so logging never masks the real error path.
    }
  }
}
