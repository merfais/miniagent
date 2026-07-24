#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { startCli } from './cli/chat-cli.js';
import { createSessionId, createSessionLogger, logEvent } from './core/logger.js';
import { createSessionStore } from './core/session-store.js';
import { OpenAiCompatibleProvider } from './providers/openai-compatible.js';

interface ProviderConfig {
  type: 'openai-compatible';
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
}

interface AppConfig {
  logToCli?: boolean;
  logDir?: string;
  provider?: ProviderConfig;
}

interface LoadConfigOptions {
  cwd?: string;
  configPath?: string;
}

interface CreateProviderOptions {
  cwd?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

interface CreateLoggerOptions {
  cwd?: string;
  config?: AppConfig;
  output?: NodeJS.WritableStream;
  sessionId?: string;
}

interface CreateAppContextOptions extends CreateProviderOptions {
  config?: AppConfig | null;
  output?: NodeJS.WritableStream;
}

interface MainOptions extends CreateProviderOptions {
  output?: NodeJS.WritableStream;
}

export interface AppContext {
  config: AppConfig;
  logger: ReturnType<typeof createLoggerFromConfig>;
  provider: OpenAiCompatibleProvider;
  sessionId: string;
  sessionStore: ReturnType<typeof createSessionStore>;
}

export async function loadConfig({
  cwd = process.cwd(),
  configPath = path.join(cwd, 'miniagent.config.json'),
}: LoadConfigOptions = {}): Promise<AppConfig> {
  const raw = await fs.readFile(configPath, 'utf8');
  return JSON.parse(raw) as AppConfig;
}

export function createProviderFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAiCompatibleProvider {
  const apiKey = env.OPENAI_API_KEY || env.OPENAI_API_KEY;
  const model = env.ARK_MODEL;

  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY (or OPENAI_API_KEY)');
  }

  if (!model) {
    throw new Error('Missing ARK_MODEL');
  }

  return new OpenAiCompatibleProvider({
    apiKey,
    model,
    baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  });
}

export function createProviderFromObject(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): OpenAiCompatibleProvider {
  const providerConfig = config && config.provider;
  if (!providerConfig || typeof providerConfig !== 'object') {
    throw new Error('Missing provider config in miniagent.config.json');
  }

  if (providerConfig.type !== 'openai-compatible') {
    throw new Error(`Unsupported provider type: ${providerConfig.type}`);
  }

  const apiKey =
    providerConfig.apiKey ||
    (providerConfig.apiKeyEnv ? env[providerConfig.apiKeyEnv] : undefined) ||
    env.OPENAI_API_KEY ||
    env.OPENAI_API_KEY;
  const model = providerConfig.model || env.ARK_MODEL;

  if (!apiKey) {
    throw new Error('Missing provider apiKey or apiKeyEnv in miniagent.config.json');
  }

  if (!model) {
    throw new Error('Missing provider.model in miniagent.config.json');
  }

  return new OpenAiCompatibleProvider({
    apiKey,
    model,
    baseUrl: providerConfig.baseUrl || 'https://api.openai.com/v1',
  });
}

export async function createProviderFromConfig({
  cwd = process.cwd(),
  configPath = path.join(cwd, 'miniagent.config.json'),
  env = process.env,
}: CreateProviderOptions = {}): Promise<OpenAiCompatibleProvider> {
  try {
    const config = await loadConfig({ cwd, configPath });
    return createProviderFromObject(config, env);
  } catch (error) {
    const configError = error as NodeJS.ErrnoException;
    if (configError && configError.code === 'ENOENT') {
      return createProviderFromEnv(env);
    }

    throw error;
  }
}

export function normalizeLoggingConfig(config: AppConfig = {}): {
  logToCli: boolean;
  logDir: string;
} {
  return {
    logToCli: config.logToCli === true,
    logDir:
      typeof config.logDir === 'string' && config.logDir.trim() !== '' ? config.logDir : 'logs',
  };
}

export function createLoggerFromConfig({
  cwd = process.cwd(),
  config = {},
  output = process.stdout,
  sessionId = createSessionId(),
}: CreateLoggerOptions = {}) {
  const { logToCli, logDir } = normalizeLoggingConfig(config);

  return createSessionLogger({
    workspaceRoot: cwd,
    sessionId,
    logDir,
    logToCli,
    cliWriter: (line: string) => output.write(line),
  });
}

export async function createAppContextFromConfig({
  cwd = process.cwd(),
  configPath = path.join(cwd, 'miniagent.config.json'),
  config,
  env = process.env,
  output = process.stdout,
}: CreateAppContextOptions = {}): Promise<AppContext> {
  const sessionId = createSessionId();
  let logger:
    | ReturnType<typeof createLoggerFromConfig>
    | undefined;

  try {
    let resolvedConfig = config;

    if (resolvedConfig === undefined) {
      try {
        resolvedConfig = await loadConfig({ cwd, configPath });
      } catch (error) {
        const configError = error as NodeJS.ErrnoException;
        if (configError && configError.code === 'ENOENT') {
          resolvedConfig = null;
        } else {
          throw error;
        }
      }
    }

    logger = createLoggerFromConfig({
      cwd,
      config: resolvedConfig || {},
      output,
      sessionId,
    });

    const provider = resolvedConfig
      ? createProviderFromObject(resolvedConfig, env)
      : createProviderFromEnv(env);

    return {
      config: resolvedConfig || {},
      logger,
      provider,
      sessionId,
      sessionStore: createSessionStore({ workspaceRoot: cwd }),
    };
  } catch (error) {
    const appError = error instanceof Error ? error : new Error(String(error));
    if (!logger) {
      logger = createLoggerFromConfig({
        cwd,
        config: {},
        output,
        sessionId,
      });
    }

    await logEvent(logger, { event: 'process.error', error: appError.message });
    throw appError;
  }
}

export async function main({
  cwd = process.cwd(),
  configPath = path.join(cwd, 'miniagent.config.json'),
  env = process.env,
  output = process.stdout,
}: MainOptions = {}): Promise<void> {
  const { provider, logger, sessionStore } = await createAppContextFromConfig({
    cwd,
    configPath,
    env,
    output,
  });

  try {
    await startCli({ provider, logger, output, workspaceRoot: cwd, sessionStore });
  } catch (error) {
    const mainError = error as Error & { loggedToSession?: boolean };
    if (!mainError.loggedToSession) {
      await logEvent(logger, { event: 'process.error', error: mainError.message });
    }
    throw mainError;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const mainError = error instanceof Error ? error : new Error(String(error));
    console.error(mainError.message);
    process.exitCode = 1;
  });
}
