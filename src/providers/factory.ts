import type { ProviderConfig } from '../config/app-config.js';
import { logger } from '../core/logger.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIChatProvider } from './openai-chat.js';
import { OpenAIResponsesProvider } from './openai-responses.js';
import type { Provider, ProviderConstructorConfig, UTool } from './types.js';

export interface CreateProviderOptions {
  system?: string;
  tools?: UTool[];
}

export function createProvider(
  config: ProviderConfig | undefined,
  options: CreateProviderOptions = {},
): Provider | undefined {
  if (!config) {
    logger.error('missing provider config');
    return undefined;
  }
  if (!config.apiKey) {
    logger.error('missing provider.apiKey');
    return undefined;
  }
  if (!config.model) {
    logger.error('missing provider.model');
    return undefined;
  }

  const ctor: ProviderConstructorConfig = {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: config.model,
    system: options.system,
    tools: options.tools,
    ...(config.type === 'anthropic' && config.maxTokens !== undefined
      ? { maxTokens: config.maxTokens }
      : {}),
  };

  switch (config.type) {
    case 'openai-chat':
      return new OpenAIChatProvider(ctor);
    case 'openai-responses':
      return new OpenAIResponsesProvider(ctor);
    case 'anthropic':
      return new AnthropicProvider(ctor);
    default:
      logger.error(`unsupported provider type: ${(config as { type?: string }).type}`);
      return undefined;
  }
}
