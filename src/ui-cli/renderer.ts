import type readline from 'node:readline';

import type { UiEvent } from '../session/session.js';
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

  return async function render(event: UiEvent): Promise<void> {
    switch (event.type) {
      case 'user_message':
        write(`\n> ${event.content}\n`);
        break;
      case 'assistant_message': {
        for (const seg of event.segments) {
          if (seg.type === 'text') {
            write(seg.text);
          } else if (seg.type === 'reasoning') {
            write(`\n[thinking] ${seg.text}\n`);
          } else if (seg.type === 'tool_use') {
            write(`\n[tool] ${seg.name} ${JSON.stringify(seg.args)}\n`);
          } else if (seg.type === 'llm_error') {
            write(`\n[error] ${seg.message}\n`);
          }
        }
        write('\n');
        break;
      }
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
      case 'tool_approval_decision':
        write(`[approval:${event.decision}]\n`);
        break;
      case 'turn_done':
        if (event.finishReason === 'error' && event.message) {
          write(`\n[error] ${event.message}\n`);
        }
        write(`\n[done: ${event.finishReason}]\n`);
        onTurnDone();
        break;
      default:
        break;
    }
  };
}

function promptOnce(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}
