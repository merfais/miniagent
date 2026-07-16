const { createToolMessage } = require('../core/messages');

class AgentRuntime {
  constructor({ provider, tools, maxSteps = 8 }) {
    if (!provider || typeof provider.generate !== 'function') {
      throw new Error('provider.generate is required');
    }

    if (!tools || typeof tools.get !== 'function' || typeof tools.list !== 'function') {
      throw new Error('tools registry is required');
    }

    this.provider = provider;
    this.tools = tools;
    this.maxSteps = maxSteps;
  }

  async respond(messages) {
    const trace = [];
    const workingMessages = [...messages];

    for (let step = 0; step < this.maxSteps; step += 1) {
      const action = await this.provider.generate({
        messages: workingMessages,
        tools: this.tools.list(),
      });

      if (action.type === 'tool_call') {
        const tool = this.tools.get(action.toolName);
        if (!tool) {
          throw new Error(`Unknown tool: ${action.toolName}`);
        }

        if (typeof tool.validateArgs === 'function') {
          tool.validateArgs(action.args || {});
        }

        const result = await tool.execute(action.args || {});
        trace.push({
          toolName: action.toolName,
          args: action.args || {},
          result,
        });

        workingMessages.push(
          createToolMessage(
            action.toolName,
            JSON.stringify(result),
            action.callId || `call_${step + 1}`,
          ),
        );
        continue;
      }

      if (action.type === 'assistant_message' || action.type === 'final_answer') {
        return {
          output: action,
          trace,
          messages: workingMessages,
        };
      }

      throw new Error(`Unknown action type: ${action.type}`);
    }

    throw new Error(`Agent exceeded max steps (${this.maxSteps})`);
  }
}

module.exports = {
  AgentRuntime,
};
