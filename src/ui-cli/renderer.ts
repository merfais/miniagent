import type readline from 'node:readline';

import type { AgentEvent } from '../core/events.js';
import type { AgentClient } from './client.js';

export interface RendererDeps {
  client: AgentClient;
  sessionId: string;
  out: NodeJS.WritableStream;
  rl: readline.Interface;
  onTurnDone: () => void;
}

export function createRenderer(deps: RendererDeps) {
  const { client, sessionId, out, rl, onTurnDone } = deps;

  const write = (s: string): void => {
    out.write(s);
  };

  return async function render(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'text_delta':
        write(event.text);
        break;
      case 'reasoning_delta':
        write(`\n[thinking] ${event.text}\n`);
        break;
      case 'tool_call':
        write(`\n[tool] ${event.name} ${JSON.stringify(event.args)}\n`);
        break;
      case 'tool_result': {
        const preview =
          typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
        const trimmed = preview.length > 500 ? `${preview.slice(0, 500)}…` : preview;
        write(`[tool:${event.isError ? 'error' : 'ok'}] ${trimmed}\n`);
        break;
      }
      case 'tool_approval_request': {
        write(`\n[approval] tool "${event.name}" args=${JSON.stringify(event.args)}\n`);
        const answer = await promptOnce(rl, 'approve? (y/N): ');
        const decision = answer.trim().toLowerCase() === 'y' ? 'approve' : 'deny';
        const resp = await client.approve(sessionId, event.approvalId, decision);
        if (!resp.ok) {
          write(`[approval] failed: ${resp.error.message}\n`);
        }
        break;
      }
      case 'notice':
        write(`\n[${event.level}] ${event.message}\n`);
        break;
      case 'error':
        write(`\n[error] ${event.message}\n`);
        break;
      case 'turn_done':
        write(`\n[done: ${event.finishReason}]\n`);
        onTurnDone();
        break;
      default:
        // unknown event types: silently ignore for forward compatibility
        break;
    }
  };
}

function promptOnce(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}
