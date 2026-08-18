import type { AgentEvent, ApprovalDecision } from '../core/events.js';

export interface AgentClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

interface ApiOk<T> {
  ok: true;
  data?: T;
}
interface ApiErr {
  ok: false;
  error: { code: string; message: string };
}

export class AgentClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AgentClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<ApiOk<T> | ApiErr> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    try {
      return (await res.json()) as ApiOk<T> | ApiErr;
    } catch {
      return { ok: false, error: { code: 'invalid_response', message: `status ${res.status}` } };
    }
  }

  createSession(): Promise<ApiOk<{ sessionId: string }> | ApiErr> {
    return this.json<{ sessionId: string }>('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  }

  sendMessage(sessionId: string, content: string): Promise<ApiOk<unknown> | ApiErr> {
    return this.json(`/messages?sessionId=${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  }

  cancel(sessionId: string): Promise<ApiOk<unknown> | ApiErr> {
    return this.json(`/cancel?sessionId=${encodeURIComponent(sessionId)}`, { method: 'POST' });
  }

  approve(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<ApiOk<unknown> | ApiErr> {
    return this.json(`/approvals?approvalId=${encodeURIComponent(approvalId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, sessionId }),
    });
  }

  async *events(sessionId: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/events?sessionId=${encodeURIComponent(sessionId)}`,
      { headers: { Accept: 'text/event-stream' }, signal },
    );
    if (!res.ok || !res.body) {
      throw new Error(`events stream failed: ${res.status}`);
    }
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) {
          continue;
        }
        try {
          yield JSON.parse(dataLine.slice(5).trim()) as AgentEvent;
        } catch {
          // ignore malformed
        }
      }
    }
  }
}
