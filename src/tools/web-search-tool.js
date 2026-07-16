function flattenRelatedTopics(items, collected) {
  for (const item of items || []) {
    if (item.Topics) {
      flattenRelatedTopics(item.Topics, collected);
      continue;
    }

    if (item.Text && item.FirstURL) {
      collected.push({
        title: item.Text,
        url: item.FirstURL,
      });
    }
  }
}

function createWebSearchTool({ fetchImpl = global.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function');
  }

  return {
    async web_search({ query }) {
      if (typeof query !== 'string' || query.trim() === '') {
        throw new Error('Search query is required');
      }

      const url = new URL('https://api.duckduckgo.com/');
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('no_html', '1');
      url.searchParams.set('skip_disambig', '1');

      const response = await fetchImpl(url);
      if (!response.ok) {
        throw new Error(`Web search failed with status ${response.status || 'unknown'}`);
      }

      const payload = await response.json();
      const results = [];

      if (payload.AbstractText && payload.AbstractURL) {
        results.push({
          title: payload.Heading || payload.AbstractText,
          url: payload.AbstractURL,
          snippet: payload.AbstractText,
        });
      }

      flattenRelatedTopics(payload.RelatedTopics, results);

      return {
        query,
        results,
      };
    },
  };
}

module.exports = {
  createWebSearchTool,
};

