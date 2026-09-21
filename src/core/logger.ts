import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { LogConfig } from '../config/app-config.js';
import { runtimeRoot } from './workspace.js';

export type LogLevel = 'error' | 'warn' | 'info';

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  message: string;
  meta?: Record<string, unknown>;
}

export interface Sink {
  write(record: LogRecord): void;
}

function formatText(record: LogRecord): string {
  const parts = [record.timestamp, record.level.toUpperCase(), record.message];
  if (record.meta && Object.keys(record.meta).length > 0) {
    try {
      parts.push(JSON.stringify(record.meta));
    } catch {
      parts.push(String(record.meta));
    }
  }
  return parts.join(' ');
}

function formatJson(record: LogRecord): string {
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({
      timestamp: record.timestamp,
      level: record.level,
      message: record.message,
    });
  }
}

function stdoutSink(): Sink {
  return {
    write(record) {
      const line = `${formatText(record)}\n`;
      if (record.level === 'error') {
        process.stderr.write(line);
      } else {
        process.stdout.write(line);
      }
    },
  };
}

function fileSink(filePath: string): Sink {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return {
    write(record) {
      try {
        fs.appendFileSync(filePath, `${formatJson(record)}\n`, 'utf8');
      } catch (error) {
        process.stderr.write(
          `[logger] failed to append log to ${filePath}: ${(error as Error).message}\n`,
        );
      }
    },
  };
}

function errorMirrorSink(): Sink {
  return {
    write(record) {
      if (record.level === 'error') {
        process.stderr.write(`${formatText(record)}\n`);
      }
    },
  };
}

function memorySink(buffer: LogRecord[]): Sink {
  return {
    write(record) {
      buffer.push(record);
    },
  };
}

export class Logger {
  private sinks: Sink[];

  constructor(sinks: Sink[]) {
    this.sinks = sinks;
  }

  setSinks(sinks: Sink[]): void {
    this.sinks = sinks;
  }

  private emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      message,
      meta,
    };
    for (const sink of this.sinks) {
      sink.write(record);
    }
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.emit('error', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.emit('warn', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.emit('info', message, meta);
  }
}

const pendingRecords: LogRecord[] = [];

export const logger = new Logger([memorySink(pendingRecords)]);

export const stdLogger = new Logger([stdoutSink()]);

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function dateSegment(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function hmsSegment(now: Date): string {
  return `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function randomSuffix(): string {
  return crypto.randomBytes(2).toString('hex');
}

interface LoggerState {
  baseDir: string;
  date: string;
  n: number;
}

let state: LoggerState | undefined;

function resolveBaseDir(log?: LogConfig): string {
  const logDir = log?.logDir;
  if (!logDir) {
    return path.join(runtimeRoot, 'logs');
  }
  return path.isAbsolute(logDir) ? logDir : path.join(runtimeRoot, logDir);
}

function metaPath(baseDir: string, date: string): string {
  return path.join(baseDir, date, 'meta.json');
}

function readMetaN(baseDir: string, date: string): number {
  try {
    const raw = fs.readFileSync(metaPath(baseDir, date), 'utf8');
    const parsed = JSON.parse(raw) as { n?: unknown };
    return typeof parsed.n === 'number' && Number.isFinite(parsed.n) ? parsed.n : 0;
  } catch {
    return 0;
  }
}

function writeMetaN(baseDir: string, date: string, n: number): void {
  const dir = path.join(baseDir, date);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(metaPath(baseDir, date), JSON.stringify({ n }), 'utf8');
  } catch (error) {
    process.stderr.write(`[logger] failed to write meta.json: ${(error as Error).message}\n`);
  }
}

function rollingSysFileSink(baseDir: string): Sink {
  const perDay = new Map<string, string>();
  return {
    write(record) {
      const date = record.timestamp.slice(0, 10);
      let fileName = perDay.get(date);
      if (!fileName) {
        const d = new Date(record.timestamp);
        fileName = `sys-${hmsSegment(d)}-${randomSuffix()}.log`;
        perDay.set(date, fileName);
      }
      const filePath = path.join(baseDir, date, fileName);
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, `${formatJson(record)}\n`, 'utf8');
      } catch (error) {
        process.stderr.write(
          `[logger] failed to append sys log to ${filePath}: ${(error as Error).message}\n`,
        );
      }
    },
  };
}

export function createBootLogger(log?: LogConfig): void {
  const baseDir = resolveBaseDir(log);
  const now = new Date();
  const date = dateSegment(now);
  const n = readMetaN(baseDir, date);
  state = { baseDir, date, n };

  const sinks: Sink[] = [rollingSysFileSink(baseDir), errorMirrorSink()];
  logger.setSinks(sinks);

  for (const record of pendingRecords) {
    for (const sink of sinks) {
      sink.write(record);
    }
  }
  pendingRecords.length = 0;
}

export interface SessionLoggerHandle {
  sessionId: string;
  logger: Logger;
  filePath: string;
}

export function createSessionLogger(): SessionLoggerHandle {
  if (!state) {
    throw new Error('logger not initialized; call createBootLogger first');
  }
  const now = new Date();
  const date = dateSegment(now);
  if (date !== state.date) {
    state.date = date;
    state.n = 0;
  }
  state.n += 1;
  writeMetaN(state.baseDir, state.date, state.n);

  const sessionId = `${state.n}-${hmsSegment(now)}-${randomSuffix()}`;
  const filePath = path.join(state.baseDir, state.date, `${sessionId}.log`);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '', 'utf8');
  } catch (error) {
    process.stderr.write(
      `[logger] failed to create session log ${filePath}: ${(error as Error).message}\n`,
    );
  }
  const sessionLogger = new Logger([fileSink(filePath), errorMirrorSink()]);
  return { sessionId, logger: sessionLogger, filePath };
}
