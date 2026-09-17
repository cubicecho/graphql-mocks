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

describe('countFields outside QA mode', () => {
  const lengthOf = (value: unknown) => (value as unknown[]).length;

  it('pairs counts by name and sizes the counted list to its pool', () => {
    const { mocks } = build({ countFields: true, count: { Product: 12 } });
    const feed = first(mocks.Feed);
    // The only size at which the count and the rows a pager can reach are totals of one thing.
    expect(lengthOf(feed?.items)).toBe(12);
    expect(feed?.totalCount).toBe(12);
    expect(feed?.numberOfItems).toBe(12);
  });

  it('collapses the two hand-wired options into one', () => {
    // What this used to take: relations to hold the whole pool, and a derive per count field,
    // with the pool size written out in both and nothing checking that they agree.
    const { mocks } = build({
      count: { Product: 9 },
      countFields: { ProductSearchResult: { totalCount: 'results' } },
    });
    const search = first(mocks.ProductSearchResult);
    expect(lengthOf(search?.results)).toBe(9);
    expect(search?.totalCount).toBe(9);
    expect(search?.resultCount).toBe(9);
  });

  it('names itself, not qa, when a pairing is ambiguous', () => {
    const { warn } = build({ countFields: true });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('countFields: "ProductSearchResult.totalCount" looks like a count'),
    );
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('qa.countFields'));
  });

  it('warns once, from the pass that sees the finished lists', () => {
    const { warn } = build({ countFields: true });
    const ambiguous = warn.mock.calls.filter(([message]) =>
      String(message).includes('ProductSearchResult.totalCount'),
    );
    expect(ambiguous).toHaveLength(1);
  });

  it('leaves the size to an explicit relations entry, and still counts it', () => {
    const { mocks } = build({
      count: { Product: 12 },
      countFields: true,
      relations: { Feed: { items: 2 } },
    });
    const feed = first(mocks.Feed);
    expect(lengthOf(feed?.items)).toBe(2);
    expect(feed?.totalCount).toBe(2);
  });

  it('lets a QA list profile own the sizing, and only syncs the counts', () => {
    const { mocks } = build({ countFields: true, qa: 'emptyLists' });
    const feed = first(mocks.Feed);
    expect(feed?.items).toEqual([]);
    expect(feed?.totalCount).toBe(0);
  });

  it('turns the pass off entirely with false, QA profile or not', () => {
    const { mocks } = build({ countFields: false, qa: 'emptyLists' });
    const feed = first(mocks.Feed);
    expect(feed?.items).toEqual([]);
    expect(feed?.totalCount).not.toBe(0);
  });

  it('still loses to a derive for the same field, which runs after it', () => {
    const { mocks } = build({
      countFields: true,
      derive: { Feed: { totalCount: () => 315 } },
    });
    const feed = first(mocks.Feed);
    expect(feed?.totalCount).toBe(315);
    expect(feed?.numberOfItems).toBe(lengthOf(feed?.items));
  });

  it('leaves a count that has an explicit overrides entry', () => {
    const { mocks } = build({ countFields: true, overrides: { Feed: { totalCount: () => 7 } } });
    const feed = first(mocks.Feed);
    expect(feed?.totalCount).toBe(7);
    expect(feed?.numberOfItems).toBe(lengthOf(feed?.items));
  });
});

describe('countFields under argument matching', () => {
  /** The issue's shape: a wrapper whose total has to survive its own pager. */
  const wrapperSchema = buildSchema(`
    type Product { id: ID!, name: String! }
    type ProductSearchResult { results: [Product!]!, totalCount: Int }
    type Query { searchProducts(search: String, skip: Int, limit: Int): ProductSearchResult }
  `);

  const SEARCH = parse(
    'query Search($limit: Int) { searchProducts(limit: $limit) { totalCount results { id } } }',
  );

  it('reports a total its own pager can page through', () => {
    const mocks = buildGraph(wrapperSchema, {
      faker,
      seed: 4,
      count: { _default: 40 },
      countFields: true,
      matchArguments: true,
    });
    const { searchProducts } = mocks.dataForOperation(SEARCH, { limit: 10 }) as {
      searchProducts: { results: unknown[]; totalCount: number };
    };
    expect(searchProducts.results).toHaveLength(10);
    expect(searchProducts.totalCount).toBe(40);
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
