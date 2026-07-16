const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
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

