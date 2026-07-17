const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createAppContextFromConfig,
  createProviderFromConfig,
  loadConfig,
} = require('../src/index');

test('loadConfig reads miniagent.config.json from the workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-config-'));
  const configPath = path.join(root, 'miniagent.config.json');

  await fs.writeFile(
    configPath,
    JSON.stringify({
      provider: {
        type: 'openai-compatible',
        model: 'doubao-test-model',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'config-key',
      },
    }),
    'utf8',
  );

  const config = await loadConfig({ cwd: root });
  assert.equal(config.provider.type, 'openai-compatible');
  assert.equal(config.provider.apiKey, 'config-key');
});

test('createProviderFromConfig prefers apiKey from config file over env fallback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-provider-'));
  const configPath = path.join(root, 'miniagent.config.json');

  await fs.writeFile(
    configPath,
    JSON.stringify({
      provider: {
        type: 'openai-compatible',
        model: 'doubao-test-model',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'config-key',
      },
    }),
    'utf8',
  );

  const provider = await createProviderFromConfig({
    cwd: root,
    env: {
      OPENAI_API_KEY: 'env-key',
      ARK_MODEL: 'env-model',
    },
  });

  assert.equal(provider.apiKey, 'config-key');
  assert.equal(provider.model, 'doubao-test-model');
});

test('createProviderFromConfig supports apiKeyEnv in config file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-provider-env-'));
  const configPath = path.join(root, 'miniagent.config.json');

  await fs.writeFile(
    configPath,
    JSON.stringify({
      provider: {
        type: 'openai-compatible',
        model: 'doubao-test-model',
        apiKeyEnv: 'MY_ARK_KEY',
      },
    }),
    'utf8',
  );

  const provider = await createProviderFromConfig({
    cwd: root,
    env: {
      MY_ARK_KEY: 'env-key',
    },
  });

  assert.equal(provider.apiKey, 'env-key');
  assert.equal(provider.baseUrl, 'https://api.openai.com/v1');
});

test('loadConfig preserves logToCli and logDir from miniagent.config.json', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-log-config-'));
  const configPath = path.join(root, 'miniagent.config.json');

  await fs.writeFile(
    configPath,
    JSON.stringify({
      logToCli: true,
      logDir: '.miniagent-trace',
      provider: {
        type: 'openai-compatible',
        model: 'doubao-test-model',
        apiKey: 'config-key',
      },
    }),
    'utf8',
  );

  const config = await loadConfig({ cwd: root });
  assert.equal(config.logToCli, true);
  assert.equal(config.logDir, '.miniagent-trace');
});

test('createAppContextFromConfig creates one session logger per startup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'miniagent-app-context-'));
  const { logger } = await createAppContextFromConfig({
    cwd: root,
    config: {
      logToCli: false,
      logDir: 'logs',
      provider: {
        type: 'openai-compatible',
        model: 'doubao-test-model',
        apiKey: 'config-key',
      },
    },
  });

  await logger.log({ event: 'session.start' });
  const entries = await fs.readFile(logger.filePath, 'utf8');

  assert.match(logger.filePath, /logs\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{8}\.log$/);
  assert.match(entries, /session\.start/);
});
