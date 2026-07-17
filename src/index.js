#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

const { startCli } = require('./cli/chat-cli');
const { createSessionId, createSessionLogger } = require('./core/logger');
const { OpenAiCompatibleProvider } = require('./providers/openai-compatible');

async function loadConfig({
  cwd = process.cwd(),
  configPath = path.join(cwd, 'miniagent.config.json'),
} = {}) {
  const raw = await fs.readFile(configPath, 'utf8');
  return JSON.parse(raw);
}

function createProviderFromEnv(env = process.env) {
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

function createProviderFromObject(config, env = process.env) {
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

async function createProviderFromConfig({
  cwd = process.cwd(),
  configPath = path.join(cwd, 'miniagent.config.json'),
  env = process.env,
} = {}) {
  try {
    const config = await loadConfig({ cwd, configPath });
    return createProviderFromObject(config, env);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return createProviderFromEnv(env);
    }

    throw error;
  }
}

function normalizeLoggingConfig(config = {}) {
  return {
    logToCli: config.logToCli === true,
    logDir: typeof config.logDir === 'string' && config.logDir.trim() !== '' ? config.logDir : 'logs',
  };
}

function createLoggerFromConfig({
  cwd = process.cwd(),
  config = {},
  output = process.stdout,
  sessionId = createSessionId(),
} = {}) {
  const { logToCli, logDir } = normalizeLoggingConfig(config);

  return createSessionLogger({
    workspaceRoot: cwd,
    sessionId,
    logDir,
    logToCli,
    cliWriter: (line) => output.write(line),
  });
}

async function createAppContextFromConfig({
  cwd = process.cwd(),
  configPath = path.join(cwd, 'miniagent.config.json'),
  config,
  env = process.env,
  output = process.stdout,
} = {}) {
  const sessionId = createSessionId();
  let logger;

  try {
    let resolvedConfig = config;

    if (resolvedConfig === undefined) {
      try {
        resolvedConfig = await loadConfig({ cwd, configPath });
      } catch (error) {
        if (error && error.code === 'ENOENT') {
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
    };
  } catch (error) {
    if (!logger) {
      logger = createLoggerFromConfig({
        cwd,
        config: {},
        output,
        sessionId,
      });
    }

    await logger.log({ event: 'process.error', error: error.message });
    throw error;
  }
}

async function main({
  cwd = process.cwd(),
  configPath = path.join(cwd, 'miniagent.config.json'),
  env = process.env,
  output = process.stdout,
} = {}) {
  const { provider, logger } = await createAppContextFromConfig({
    cwd,
    configPath,
    env,
    output,
  });

  try {
    await startCli({ provider, logger, output, workspaceRoot: cwd });
  } catch (error) {
    await logger.log({ event: 'process.error', error: error.message });
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createAppContextFromConfig,
  createLoggerFromConfig,
  createProviderFromConfig,
  createProviderFromEnv,
  createProviderFromObject,
  loadConfig,
  normalizeLoggingConfig,
  main,
};
