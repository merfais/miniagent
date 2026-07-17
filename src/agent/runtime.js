const { createToolMessage } = require('../core/messages');
const { logEvent } = require('../core/logger');

class AgentRuntime {
  constructor({ provider, tools, logger = null, maxSteps = 8 }) {
    if (!provider || typeof provider.generate !== 'function') {
      throw new Error('provider.generate is required');
    }

    if (!tools || typeof tools.get !== 'function' || typeof tools.list !== 'function') {
      throw new Error('tools registry is required');
    }

    this.provider = provider;
    this.tools = tools;
    this.logger = logger;
    this.maxSteps = maxSteps;
  }

  async respond(messages) {
    const trace = [];
    const workingMessages = [...messages];

    for (let step = 0; step < this.maxSteps; step += 1) {
      const stepNumber = step + 1;
      await logEvent(this.logger, {
        event: 'runtime.step.start',
        step: stepNumber,
        messageCount: workingMessages.length,
      });

      await logEvent(this.logger, {
        event: 'provider.generate.start',
        step: stepNumber,
      });

      let action;
      try {
        action = await this.provider.generate({
          messages: workingMessages,
          tools: this.tools.list(),
        });
      } catch (error) {
        await logEvent(this.logger, {
          event: 'provider.generate.error',
          step: stepNumber,
          error: error.message,
        });
        throw error;
      }

      await logEvent(this.logger, {
        event: 'provider.generate.end',
        step: stepNumber,
        actionType: action.type,
      });

      if (action.type === 'tool_call') {
        const tool = this.tools.get(action.toolName);
        if (!tool) {
          throw new Error(`Unknown tool: ${action.toolName}`);
        }

        await logEvent(this.logger, {
          event: 'tool.call.start',
          step: stepNumber,
          toolName: action.toolName,
          callId: action.callId || `call_${stepNumber}`,
        });

        let result;
        try {
          if (typeof tool.validateArgs === 'function') {
            tool.validateArgs(action.args || {});
          }

          result = await tool.execute(action.args || {});
        } catch (error) {
          await logEvent(this.logger, {
            event: 'tool.call.error',
            step: stepNumber,
            toolName: action.toolName,
            callId: action.callId || `call_${stepNumber}`,
            error: error.message,
          });
          throw error;
        }

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

        await logEvent(this.logger, {
          event: 'tool.call.end',
          step: stepNumber,
          toolName: action.toolName,
          callId: action.callId || `call_${stepNumber}`,
        });
        await logEvent(this.logger, {
          event: 'runtime.step.end',
          step: stepNumber,
        });
        continue;
      }

      if (action.type === 'assistant_message' || action.type === 'final_answer') {
        await logEvent(this.logger, {
          event: 'assistant.final',
          step: stepNumber,
        });
        await logEvent(this.logger, {
          event: 'runtime.step.end',
          step: stepNumber,
        });
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
