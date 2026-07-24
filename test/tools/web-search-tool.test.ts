import test from 'node:test';
import assert from 'node:assert/strict';

import { createWebSearchTool } from '../../src/tools/web-search-tool.js';

test('web_search normalizes instant answer search results', async () => {
  const tool = createWebSearchTool({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        AbstractText: '',
        RelatedTopics: [
          {
            Text: 'Example result',
            FirstURL: 'https://example.com',
          },
        ],
      }),
    }),
  });

  const result = await tool.web_search({ query: 'example' });

  assert.equal(result.query, 'example');
  assert.equal(result.results[0]?.title, 'Example result');
  assert.equal(result.results[0]?.url, 'https://example.com');
});
