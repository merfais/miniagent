import fs from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../core/logger.js';
import { runtimeRoot } from '../core/workspace.js';

export interface BaseProviderConfig {
  model?: string;
  baseURL?: string;
  apiKey?: string;
  maxTokens?: number;
}

export interface OpenAIChatProviderConfig extends BaseProviderConfig {
  type: 'openai-chat';
}

export interface OpenAIResponsesProviderConfig extends BaseProviderConfig {
  type: 'openai-responses';
}

export interface AnthropicProviderConfig extends BaseProviderConfig {
  type: 'anthropic';
}

export type ProviderConfig =
  | OpenAIChatProviderConfig
  | OpenAIResponsesProviderConfig
  | AnthropicProviderConfig;

export interface LogConfig {
  logToCli?: boolean;
  logDir?: string;
}

export interface AppConfig {
  log?: LogConfig;
  provider?: ProviderConfig;
}

interface ResolveConfigOptions {
  cwd?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

function resolveLog(log?: LogConfig): LogConfig {
  return {
    logToCli: log?.logToCli === true,
    logDir: typeof log?.logDir === 'string' && log.logDir.trim() !== '' ? log.logDir : 'logs',
  };
}

function resolveProvider(
  fileProvider: ProviderConfig | undefined,
  env: NodeJS.ProcessEnv,
): ProviderConfig | undefined {
  const openaiKey = env.OPENAI_API_KEY?.trim() || undefined;
  const openaiBase = env.OPENAI_BASE_URL?.trim() || undefined;
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  const anthropicBase = env.ANTHROPIC_BASE_URL?.trim() || undefined;
  const hasOpenAI = Boolean(openaiKey);
  const hasAnthropic = Boolean(anthropicKey);

  if (hasOpenAI && hasAnthropic) {
    logger.warn('both OPENAI_* and ANTHROPIC_* env vars are set; using openai-chat');
  }

  if (hasOpenAI) {
    const base: ProviderConfig =
      fileProvider?.type === 'openai-chat' || fileProvider?.type === 'openai-responses'
        ? fileProvider
        : { type: 'openai-chat' };
    return {
      ...base,
      ...(openaiKey ? { apiKey: openaiKey } : {}),
      ...(openaiBase ? { baseURL: openaiBase } : {}),
    };
  }

  if (hasAnthropic) {
    const base: AnthropicProviderConfig =
      fileProvider?.type === 'anthropic' ? fileProvider : { type: 'anthropic' };
    return {
      ...base,
      ...(anthropicKey ? { apiKey: anthropicKey } : {}),
      ...(anthropicBase ? { baseURL: anthropicBase } : {}),
    };
  }

  return fileProvider;
}

// boot 期由 startServer 调用 resolveConfig 填充；消费方直接引用此 live binding。
export let config: AppConfig | undefined;

export async function resolveConfig({
  cwd = runtimeRoot,
  configPath = path.join(cwd, 'miniagent.config.json'),
  env = process.env,
}: ResolveConfigOptions = {}): Promise<AppConfig> {
  if (config) {
    return config;
  }

  let raw: Partial<AppConfig> = {};
  try {
    raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as Partial<AppConfig>;
  } catch (error) {
    logger.warn(`failed to load config from ${configPath}: ${(error as Error).message}`);
  }

  config = {
    log: resolveLog(raw.log),
    provider: resolveProvider(raw.provider, env),
  };
  return config;
}

export function __resetConfigCacheForTests(): void {
  config = undefined;
}
