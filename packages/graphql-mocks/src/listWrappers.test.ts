import { buildSchema, parse } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveArgMatching, resolveListTarget } from './argMatching.js';
import { buildMocks } from './mockSchema.js';

/**
 * The paginated shapes real APIs return: a plain `{ results, totalCount }` wrapper, a Relay
 * connection, and a wrapper with two lists that nothing should guess between.
 */
const schema = buildSchema(`
  type Product { id: ID!, name: String!, price: Int! }

  type ProductSearchResult { results: [Product!]!, totalCount: Int! }

  type ProductEdge { cursor: String!, node: Product! }
  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }
  type ProductConnection { edges: [ProductEdge!]!, pageInfo: PageInfo!, totalCount: Int! }

  type Shelf { featured: [Product!]!, clearance: [Product!]! }
  type Catalog { rows: [Product!]!, labels: [String!]! }

  type Query {
    productSearch(search: String, take: Int, skip: Int, id: ID): ProductSearchResult!
    products(first: Int, skip: Int, search: String): ProductConnection!
    shelf(take: Int): Shelf!
    catalog(take: Int): Catalog!
  }
`);

const build = () =>
  buildMocks(schema, {
    seed: 11,
    count: 20,
    stableIds: true,
    matchArguments: true,
    overrides: { Product: { name: (_f, { index }) => (index < 3 ? 'Widget' : 'Gadget') } },
    // Pinned so "the list was left alone" is a fixed length rather than a lucky draw.
    relations: { Shelf: { featured: 3, clearance: 3 }, ProductSearchResult: { results: 4 } },
  });

const mocks = build();
const products = (mocks.Product ?? []) as { id: string; name: string }[];

/** Run an operation and hand back the wrapper it produced. */
function run<T>(query: string, matchArguments?: Parameters<typeof resolveArgMatching>[0]): T {
  const data = mocks.dataForOperation(parse(query), undefined, matchArguments) as Record<
    string,
    unknown
  >;
  const [value] = Object.values(data);
  return value as T;
}

afterEach(() => vi.restoreAllMocks());

describe('resolveListTarget', () => {
  const config = resolveArgMatching(true);
  const type = (name: string) => {
    const found = schema.getType(name);
    if (!found) throw new Error(`missing ${name}`);
    return found;
  };

  it('finds the only object list on a wrapper', () => {
    expect(resolveListTarget(type('ProductSearchResult'), config)).toEqual({
      fieldName: 'results',
      entityType: type('Product'),
    });
  });

  it('resolves a Relay connection through its edges to the node type', () => {
    expect(resolveListTarget(type('ProductConnection'), config)).toEqual({
      fieldName: 'edges',
      entityType: type('Product'),
      edgeTypeName: 'ProductEdge',
    });
  });

  it('refuses to guess between two lists', () => {
    expect(resolveListTarget(type('Shelf'), config)).toBeUndefined();
  });

  it('takes an explicit field name for a wrapper it cannot read', () => {
    const configured = resolveArgMatching({ listPath: { Shelf: 'clearance' } });
    expect(resolveListTarget(type('Shelf'), configured)).toMatchObject({
      fieldName: 'clearance',
    });
  });

  it('ignores a scalar list, which is a field of the wrapper rather than its rows', () => {
    expect(resolveListTarget(type('Catalog'), config)).toEqual({
      fieldName: 'rows',
      entityType: type('Product'),
    });
  });

  it('accepts a bare field name applied to every wrapper', () => {
    const configured = resolveArgMatching({ listPath: 'rows' });
    expect(resolveListTarget(type('Catalog'), configured)).toMatchObject({ fieldName: 'rows' });
  });

  it('warns and stands down when listPath names no list field', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configured = resolveArgMatching({ listPath: { Shelf: 'nope' } });
    expect(resolveListTarget(type('Shelf'), configured)).toBeUndefined();
    expect(warn.mock.calls[0]?.[0]).toContain('"Shelf.nope"');
  });

  it('is off with unwrap false', () => {
    const configured = resolveArgMatching({ unwrap: false });
    expect(resolveListTarget(type('ProductSearchResult'), configured)).toBeUndefined();
  });

  it('leaves a type with no list field alone', () => {
    expect(resolveListTarget(type('Product'), config)).toBeUndefined();
  });
});

describe('wrapper types in execution', () => {
  it('pages the list inside a wrapper instead of ignoring the arguments', () => {
    const result = run<{ results: { id: string }[] }>(
      '{ productSearch(skip: 2, take: 3) { results { id } } }',
    );
    expect(result.results.map((p) => p.id)).toEqual(products.slice(2, 5).map((p) => p.id));
  });

  it('filters the list inside a wrapper by a search argument', () => {
    const result = run<{ results: { name: string }[] }>(
      '{ productSearch(search: "Widget") { results { id name } } }',
    );
    expect(result.results).toHaveLength(3);
    expect(result.results.every((p) => p.name === 'Widget')).toBe(true);
  });

  it('matches an equality argument against the inner type', () => {
    const target = products[4];
    const result = run<{ results: { id: string }[] }>(
      `{ productSearch(id: "${target?.id}") { results { id } } }`,
    );
    expect(result.results.map((p) => p.id)).toEqual([target?.id]);
  });

  it('empties the list when a filter matches nothing', () => {
    const result = run<{ results: unknown[] }>(
      '{ productSearch(search: "nothing-matches-this") { results { id } } }',
    );
    expect(result.results).toEqual([]);
  });

  it('leaves the wrapper alone on a miss when onMiss is fallback', () => {
    const result = run<{ results: unknown[] }>(
      '{ productSearch(search: "nothing-matches-this") { results { id } } }',
      { onMiss: 'fallback' },
    );
    expect(result.results).toHaveLength(4);
  });

  it('never mutates the pooled wrapper', () => {
    const pooled = (mocks.ProductSearchResult ?? [])[0] as { results: unknown[] };
    const before = pooled.results.length;
    run('{ productSearch(skip: 2, take: 3) { results { id } } }');
    expect(pooled.results).toHaveLength(before);
  });

  it('does nothing without an interpretable argument', () => {
    const result = run<{ results: unknown[] }>('{ productSearch { results { id } } }');
    // The wired list, untouched — matching only ever narrows what arguments actually say.
    expect(result.results).toHaveLength(4);
  });

  it('is off with unwrap false', () => {
    const result = run<{ results: unknown[] }>('{ productSearch(take: 1) { results { id } } }', {
      unwrap: false,
    });
    expect(result.results).toHaveLength(4);
  });

  it('refuses to page a wrapper with two candidate lists', () => {
    const result = run<{ featured: unknown[] }>('{ shelf(take: 1) { featured { id } } }');
    expect(result.featured).toHaveLength(3);
  });

  it('pages the ambiguous wrapper once listPath names the field', () => {
    const result = run<{ clearance: unknown[]; featured: unknown[] }>(
      '{ shelf(take: 1) { featured { id } clearance { id } } }',
      { listPath: { Shelf: 'clearance' } },
    );
    expect(result.clearance).toHaveLength(1);
  });
});

describe('Relay connections', () => {
  it('pages edges and keeps them as edges', () => {
    const result = run<{ edges: { cursor: string; node: { id: string } }[] }>(
      '{ products(skip: 1, first: 2) { edges { cursor node { id } } } }',
    );
    expect(result.edges).toHaveLength(2);
    expect(result.edges.map((e) => e.node.id)).toEqual(products.slice(1, 3).map((p) => p.id));
    expect(result.edges.every((e) => typeof e.cursor === 'string')).toBe(true);
  });

  it('filters edges by their node', () => {
    const result = run<{ edges: { node: { name: string } }[] }>(
      '{ products(search: "Widget") { edges { node { id name } } } }',
    );
    expect(result.edges).toHaveLength(3);
    expect(result.edges.every((e) => e.node.name === 'Widget')).toBe(true);
  });

  it('slices pageInfo to match the page', () => {
    const result = run<{
      edges: { cursor: string }[];
      pageInfo: {
        hasNextPage: boolean;
        hasPreviousPage: boolean;
        startCursor: string;
        endCursor: string;
      };
    }>(`{
      products(skip: 1, first: 2) {
        edges { cursor }
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      }
    }`);
    expect(result.pageInfo.hasPreviousPage).toBe(true);
    expect(result.pageInfo.hasNextPage).toBe(true);
    expect(result.pageInfo.startCursor).toBe(result.edges[0]?.cursor);
    expect(result.pageInfo.endCursor).toBe(result.edges[1]?.cursor);
  });

  it('reports the end of the list through pageInfo', () => {
    const result = run<{ pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean } }>(
      '{ products(first: 100) { pageInfo { hasNextPage hasPreviousPage } } }',
    );
    expect(result.pageInfo).toEqual({ hasNextPage: false, hasPreviousPage: false });
  });

  it('empties the connection when nothing matches', () => {
    const result = run<{ edges: unknown[]; pageInfo: { hasNextPage: boolean } }>(
      '{ products(search: "nothing-matches-this") { edges { cursor } pageInfo { hasNextPage } } }',
    );
    expect(result.edges).toEqual([]);
    expect(result.pageInfo.hasNextPage).toBe(false);
  });
});
