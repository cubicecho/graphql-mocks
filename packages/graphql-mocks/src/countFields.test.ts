import { faker } from '@faker-js/faker';
import { buildSchema, parse } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyCountField } from './countFields.js';
import { buildGraph } from './graphBuilder.js';

// The wrapper shape the issue is about, plus the variants the name conventions have to cover.
const schema = buildSchema(`
  type Product { id: ID!, sku: String! }
  type Facet { id: ID!, label: String! }

  type ProductSearchResult {
    results: [Product!]!
    facets: [Facet!]!
    resultCount: Int!
    facetTotal: Int!
    totalCount: Int!
    relevance: Int!
  }

  type Feed {
    items: [Product!]!
    totalCount: Int!
    numberOfItems: Int!
  }

  type Blog {
    posts: [Product!]!
    entries: [Facet!]!
    postCount: Int!
  }

  type Tagged {
    tags: [String!]!
    tagCount: Int!
    hitTotal: Int!
  }

  type Query {
    search: ProductSearchResult!
    feed: Feed!
    blog: Blog!
    tagged: Tagged!
  }
`);

const first = (pool: unknown) => (pool as Record<string, unknown>[])[0];

/** Spy on the ambiguity warning every build under a lists profile emits, and keep the calls. */
function build(options: Parameters<typeof buildGraph>[1]) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { mocks: buildGraph(schema, { faker, seed: 1, ...options }), warn };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('syncCountFields', () => {
  it('zeros a count when the list profile empties its list', () => {
    const { mocks } = build({ qa: 'emptyLists' });
    const result = first(mocks.ProductSearchResult);
    expect(result?.results).toEqual([]);
    expect(result?.resultCount).toBe(0);
    expect(result?.facetTotal).toBe(0);
  });

  it('matches a single-item list', () => {
    const { mocks } = build({ qa: 'singleItemLists' });
    const result = first(mocks.ProductSearchResult);
    expect((result?.results as unknown[]).length).toBe(1);
    expect(result?.resultCount).toBe(1);
  });

  it('matches a huge list at its configured size', () => {
    const { mocks } = build({ qa: { lists: 'huge', listSize: 12 } });
    const result = first(mocks.ProductSearchResult);
    expect((result?.results as unknown[]).length).toBe(12);
    expect(result?.resultCount).toBe(12);
  });

  it('pairs a generic count when the type has exactly one list', () => {
    const { mocks } = build({ qa: 'emptyLists' });
    const feed = first(mocks.Feed);
    expect(feed?.totalCount).toBe(0);
    expect(feed?.numberOfItems).toBe(0);
  });

  it('pairs a count with its list across singular and plural', () => {
    const { mocks } = build({ qa: 'singleItemLists' });
    // `postCount` names `posts`, so it wins over the type's other list.
    expect(first(mocks.Blog)?.postCount).toBe(1);
  });

  it('pairs a count with a scalar list', () => {
    const { mocks } = build({ qa: { lists: 'huge', listSize: 7 } });
    expect(first(mocks.Tagged)?.tagCount).toBe(7);
  });

  it('leaves a count whose name points at a list the type does not have', () => {
    // `hitTotal` names "hit", and `Tagged` has no such list — guessing `tags` from the one
    // list present is how `numberOfEmployees` would become the length of `addresses`.
    const { mocks, warn } = build({ qa: { lists: 'huge', listSize: 7 } });
    expect(first(mocks.Tagged)?.hitTotal).not.toBe(7);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Tagged.hitTotal'));
  });

  it('pairs that name explicitly when the schema means it', () => {
    const { mocks } = build({
      qa: { lists: 'huge', listSize: 7, countFields: { Tagged: { hitTotal: 'tags' } } },
    });
    expect(first(mocks.Tagged)?.hitTotal).toBe(7);
  });

  it('leaves an Int that is not a count alone', () => {
    const { mocks } = build({ qa: 'emptyLists' });
    expect(first(mocks.ProductSearchResult)?.relevance).not.toBe(0);
  });

  it('declines to guess an ambiguous pairing, and says why', () => {
    const { mocks, warn } = build({ qa: 'emptyLists' });
    expect(first(mocks.ProductSearchResult)?.totalCount).not.toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"ProductSearchResult.totalCount" looks like a count'),
    );
  });

  it('takes an explicit pairing instead of guessing', () => {
    const { mocks, warn } = build({
      qa: { lists: 'empty', countFields: { ProductSearchResult: { totalCount: 'results' } } },
    });
    expect(first(mocks.ProductSearchResult)?.totalCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns about an explicit pairing that names a field the type does not have', () => {
    const { warn } = build({
      qa: { lists: 'empty', countFields: { Feed: { nope: 'items', totalCount: 'missing' } } },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"Feed.nope" is not a field'));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"Feed.missing" is not a list field'),
    );
  });

  it('leaves everything alone when syncCounts is off', () => {
    const { mocks } = build({ qa: { lists: 'empty', syncCounts: false } });
    const feed = first(mocks.Feed);
    expect(feed?.items).toEqual([]);
    expect(feed?.totalCount).not.toBe(0);
  });

  it('does nothing without a lists profile', () => {
    const { mocks } = build({ qa: { text: 'empty' } });
    const feed = first(mocks.Feed);
    expect((feed?.items as unknown[]).length).toBeGreaterThan(0);
    expect(feed?.totalCount).not.toBe((feed?.items as unknown[]).length);
  });

  it('does not run outside QA mode', () => {
    const { mocks } = build({});
    const feed = first(mocks.Feed);
    expect(feed?.totalCount).not.toBe((feed?.items as unknown[]).length);
  });

  it('leaves a count that has an explicit overrides entry', () => {
    const { mocks } = build({
      qa: 'emptyLists',
      overrides: { Feed: { totalCount: () => 315 } },
    });
    const feed = first(mocks.Feed);
    expect(feed?.totalCount).toBe(315);
    expect(feed?.numberOfItems).toBe(0);
  });

  it('syncs the pool every operation resolves from', () => {
    const { mocks } = build({ qa: 'emptyLists' });
    const data = mocks.dataForOperation(
      parse('query { search { results { id } resultCount } }'),
    ) as {
      search: { results: unknown[]; resultCount: number };
    };
    expect(data.search.results).toEqual([]);
    expect(data.search.resultCount).toBe(0);
  });
});

describe('classifyCountField', () => {
  it('reads what a field name says it counts', () => {
    expect(classifyCountField('totalCount')).toEqual({ token: 'total', generic: true });
    expect(classifyCountField('total')).toEqual({ generic: true });
    expect(classifyCountField('postCount')).toEqual({ token: 'post', generic: false });
    expect(classifyCountField('numberOfPosts')).toEqual({ token: 'posts', generic: false });
    expect(classifyCountField('totalPosts')).toEqual({ token: 'posts', generic: false });
    expect(classifyCountField('name')).toBeUndefined();
    expect(classifyCountField('relevance')).toBeUndefined();
  });
});
