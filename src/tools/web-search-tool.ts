interface RelatedTopicLeaf {
  Text?: string;
  FirstURL?: string;
}

interface RelatedTopicGroup {
  Topics?: Array<RelatedTopicLeaf | RelatedTopicGroup>;
}

interface SearchResponseLike {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
}

type FetchLike = (url: URL) => Promise<SearchResponseLike>;

function flattenRelatedTopics(
  items: Array<RelatedTopicLeaf | RelatedTopicGroup> | undefined,
  collected: Array<{ title: string; url: string }>,
): void {
  for (const item of items || []) {
    if ('Topics' in item && item.Topics) {
      flattenRelatedTopics(item.Topics, collected);
      continue;
    }

    if ('Text' in item && item.Text && item.FirstURL) {
      collected.push({
        title: item.Text,
        url: item.FirstURL,
      });
    }
  }
}

export function createWebSearchTool({
  fetchImpl = global.fetch as unknown as FetchLike,
}: { fetchImpl?: FetchLike } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function');
  }

  return {
    async web_search({ query }: { query: string }) {
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

      const payload = (await response.json()) as {
        AbstractText?: string;
        AbstractURL?: string;
        Heading?: string;
        RelatedTopics?: Array<RelatedTopicLeaf | RelatedTopicGroup>;
      };
      const results: Array<{ title: string; url: string; snippet?: string }> = [];

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
