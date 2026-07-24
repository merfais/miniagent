import { logEvent } from '../core/logger.js';
import { createToolMessage } from '../core/messages.js';
import type {
  Message,
  ProviderAction,
  RegisteredTool,
  SessionLogger,
  ToolCallTrace,
} from '../core/types.js';

interface ProviderLike {
  generate(args: { messages: Message[]; tools: RegisteredTool[] }): Promise<ProviderAction>;
}

interface ToolRegistryLike {
  get(name: string): RegisteredTool | undefined;
  list(): RegisteredTool[];
}

interface AgentRuntimeOptions {
  provider: ProviderLike;
  tools: ToolRegistryLike;
  logger?: Pick<SessionLogger, 'log'> | null;
  maxSteps?: number;
}

export class AgentRuntime {
  readonly provider: ProviderLike;
  readonly tools: ToolRegistryLike;
  readonly logger: Pick<SessionLogger, 'log'> | null;
  readonly maxSteps: number;

  constructor({ provider, tools, logger = null, maxSteps = 8 }: AgentRuntimeOptions) {
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

  async respond(messages: Message[]) {
    const trace: ToolCallTrace[] = [];
    const workingMessages = [...messages];

    for (let step = 0; step < this.maxSteps; step += 1) {
      const stepNumber = step + 1;
      await logEvent(this.logger, {
        event: 'runtime.step.start',
        step: stepNumber,
        messageCount: workingMessages.length,
      });

      try {
        await logEvent(this.logger, {
          event: 'provider.generate.start',
          step: stepNumber,
        });

        let action: ProviderAction;
        try {
          action = await this.provider.generate({
            messages: workingMessages,
            tools: this.tools.list(),
          });
        } catch (error) {
          const providerError = error instanceof Error ? error : new Error(String(error));
          await logEvent(this.logger, {
            event: 'provider.generate.error',
            step: stepNumber,
            error: providerError.message,
          });
          throw providerError;
        }

        await logEvent(this.logger, {
          event: 'provider.generate.end',
          step: stepNumber,
          actionType: action.type,
        });

        if (action.type === 'tool_call') {
          const callId = action.callId || `call_${stepNumber}`;
          await logEvent(this.logger, {
            event: 'tool.call.start',
            step: stepNumber,
            toolName: action.toolName,
            callId,
          });

          const tool = this.tools.get(action.toolName);
          if (!tool) {
            const error = new Error(`Unknown tool: ${action.toolName}`);
            await logEvent(this.logger, {
              event: 'tool.call.error',
              step: stepNumber,
              toolName: action.toolName,
              callId,
              error: error.message,
            });
            throw error;
          }

          try {
            if (typeof tool.validateArgs === 'function') {
              tool.validateArgs(action.args || {});
            }

            const result = await tool.execute(action.args || {});

            trace.push({
              callId,
              toolName: action.toolName,
              args: action.args || {},
              result,
            });

            workingMessages.push(
              createToolMessage(action.toolName, JSON.stringify(result), callId),
            );

            await logEvent(this.logger, {
              event: 'tool.call.end',
              step: stepNumber,
              toolName: action.toolName,
              callId,
            });
          } catch (error) {
            const toolError = error instanceof Error ? error : new Error(String(error));
            await logEvent(this.logger, {
              event: 'tool.call.error',
              step: stepNumber,
              toolName: action.toolName,
              callId,
              error: toolError.message,
            });
            throw toolError;
          }
          continue;
        }

        if (action.type === 'assistant_message' || action.type === 'final_answer') {
          await logEvent(this.logger, {
            event: 'assistant.final',
            step: stepNumber,
          });
          return {
            output: action,
            trace,
            messages: workingMessages,
          };
        }

        throw new Error(`Unknown action type: ${(action as { type?: string }).type}`);
      } finally {
        await logEvent(this.logger, {
          event: 'runtime.step.end',
          step: stepNumber,
        });
      }
    }

    throw new Error(`Agent exceeded max steps (${this.maxSteps})`);
  }
}
