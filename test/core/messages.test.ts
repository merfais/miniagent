import test from 'node:test';
import assert from 'node:assert/strict';

import { createMessage, createToolMessage } from '../../src/core/messages';

test('createMessage preserves role, content, and extras', () => {
  const message = createMessage('assistant', 'done', { callId: 'call_1' });

  assert.deepEqual(message, {
    role: 'assistant',
    content: 'done',
    callId: 'call_1',
  });
});

test('createToolMessage creates a tool-role message', () => {
  assert.deepEqual(
    createToolMessage('web_search', '{"ok":true}', 'call_1'),
    {
      role: 'tool',
      toolName: 'web_search',
      callId: 'call_1',
      content: '{"ok":true}',
    },
  );
});
