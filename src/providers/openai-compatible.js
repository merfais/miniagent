function normalizeTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || {
        type: 'object',
        properties: {},
      },
    },
  };
}

function normalizeActionFromResponse(payload) {
  const choice = payload && payload.choices && payload.choices[0];
  const message = choice && choice.message;

  if (!message) {
    throw new Error('Provider response does not contain a message');
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    const toolCall = message.tool_calls[0];
    return {
      type: 'tool_call',
      callId: toolCall.id,
      toolName: toolCall.function.name,
      args: JSON.parse(toolCall.function.arguments || '{}'),
    };
  }

  if (typeof message.content === 'string' && message.content.trim() !== '') {
    return {
      type: 'final_answer',
      content: message.content,
    };
  }

  throw new Error('Provider response does not contain content or tool calls');
}

function normalizeMessage(message) {
  if (message && message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.tool_call_id || message.callId,
      content: message.content,
    };
  }

  return message;
}

class OpenAiCompatibleProvider {
  constructor({
    apiKey,
    baseUrl,
    model,
    fetchImpl = global.fetch,
    systemPrompt = '',
  }) {
    if (!apiKey) {
      throw new Error('apiKey is required');
    }

    if (!baseUrl) {
      throw new Error('baseUrl is required');
    }

    if (!model) {
      throw new Error('model is required');
    }

    if (typeof fetchImpl !== 'function') {
      throw new Error('fetchImpl must be a function');
    }

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.systemPrompt = systemPrompt;
  }

  buildMessages(messages) {
    const providerMessages = messages.map(normalizeMessage);

    if (!this.systemPrompt) {
      return providerMessages;
    }

    return [
      {
        role: 'system',
        content: this.systemPrompt,
      },
      ...providerMessages,
    ];
  }

  async generate({ messages, tools }) {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: this.buildMessages(messages),
        tools: (tools || []).map(normalizeTool),
      }),
    });

    if (!response.ok) {
      const body = typeof response.text === 'function' ? await response.text() : '';
      throw new Error(`Provider request failed: ${response.status || 'unknown'} ${body}`.trim());
    }

    return normalizeActionFromResponse(await response.json());
  }
}

module.exports = {
  OpenAiCompatibleProvider,
  normalizeActionFromResponse,
  normalizeMessage,
  normalizeTool,
};
