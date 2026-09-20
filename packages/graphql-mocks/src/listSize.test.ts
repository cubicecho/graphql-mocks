import { buildSchema, parse } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { lookupListSize, resolveListSize } from './helpers.js';
import { buildMocks } from './mockSchema.js';
import { mergeScenarios } from './scenarios.js';
import type { BuildMocksOptions, ListSizeConfig } from './types.js';

const schema = buildSchema(`
  enum Colour { RED GREEN BLUE }
  type Comment { id: ID!, body: String! }
  type Post {
    id: ID!
    title: String!
    tags: [String!]!
    colours: [Colour!]!
    notes: [String!]
    comments: [Comment!]!
  }
  type Query { posts: [Post!]! }
`);

/** Stands in for a codegen `SchemaTypeMap`, so the map form's keys are checked. */
type TestTypes = { Post: { tags: string[]; colours: string[]; comments: unknown[] } };

const build = (options: BuildMocksOptions = {}) =>
  buildMocks(schema, { seed: 5, count: 3, ...options });

const lengths = (options: BuildMocksOptions, field: string) =>
  (build(options).Post as Record<string, unknown[]>[]).map((post) => post[field]?.length);

describe('resolveListSize', () => {
  it('defaults to 1–5 when nothing is given', () => {
    expect(resolveListSize(undefined)).toEqual({ min: 1, max: 5 });
  });

  it('reads a bare number as an exact length', () => {
    expect(resolveListSize(3)).toEqual({ min: 3, max: 3 });
  });

  it('passes a range through, clamped non-negative and ordered', () => {
    expect(resolveListSize({ min: 2, max: 4 })).toEqual({ min: 2, max: 4 });
    expect(resolveListSize({ min: 5, max: 1 })).toEqual({ min: 1, max: 5 });
    expect(resolveListSize({ min: -3, max: 2 })).toEqual({ min: 0, max: 2 });
  });

  it('takes the catch-all from a map _default, ignoring the named entries', () => {
    expect(resolveListSize({ _default: 2, Post: { tags: 9 } })).toEqual({ min: 2, max: 2 });
    expect(resolveListSize({ Post: { tags: 9 } })).toEqual({ min: 1, max: 5 });
  });

  it('fills a half-written range from the fallback rather than producing NaN', () => {
    // `{ min: 2 }` types as a map entry, not a range, so the missing bound has to come from
    // somewhere — a raw `Math.max(0, undefined)` would put NaN into `faker.number.int`.
    expect(resolveListSize({ min: 2 } as ListSizeConfig)).toEqual({ min: 2, max: 5 });
    expect(resolveListSize({ max: 3 } as ListSizeConfig)).toEqual({ min: 1, max: 3 });
  });
});

describe('lookupListSize', () => {
  const config: ListSizeConfig = {
    _default: 9,
    Post: { tags: 2, _default: 4 },
    Comment: 7,
  };

  it('finds the entry naming the exact field', () => {
    expect(lookupListSize('Post', 'tags', config)).toEqual({ min: 2, max: 2 });
  });

  it('falls back to the type default for that type other lists', () => {
    expect(lookupListSize('Post', 'colours', config)).toEqual({ min: 4, max: 4 });
  });

  it('reads a bare size under a type name as covering all of its lists', () => {
    expect(lookupListSize('Comment', 'anything', config)).toEqual({ min: 7, max: 7 });
  });

  it('has no opinion about a type the map does not name', () => {
    // The top-level `_default` is the catch-all, which a QA profile outranks — so it is
    // deliberately not reported here.
    expect(lookupListSize('User', 'todos', config)).toBeUndefined();
  });

  it('has no opinion for the flat forms or no config at all', () => {
    expect(lookupListSize('Post', 'tags', undefined)).toBeUndefined();
    expect(lookupListSize('Post', 'tags', 3)).toBeUndefined();
    expect(lookupListSize('Post', 'tags', { min: 1, max: 2 })).toBeUndefined();
  });
});

describe('listSize on scalar and enum lists', () => {
  it('sizes them from the flat form, which used to miss them entirely', () => {
    expect(lengths({ listSize: 4 }, 'tags')).toEqual([4, 4, 4]);
    // `Colour` has three values and lists are drawn without replacement, so the size is clamped
    // to what exists — a fourth entry could only be a repeat. `uniqueLists: false` asks for the
    // repeat back. See `uniqueLists.test.ts`.
    expect(lengths({ listSize: 4 }, 'colours')).toEqual([3, 3, 3]);
    expect(lengths({ listSize: 4, uniqueLists: false }, 'colours')).toEqual([4, 4, 4]);
  });

  it('sizes one named field, leaving the type other lists alone', () => {
    expect(lengths({ listSize: { Post: { tags: 2 } } }, 'tags')).toEqual([2, 2, 2]);
    for (const length of lengths({ listSize: { Post: { tags: 2 } } }, 'colours')) {
      expect(length).toBeGreaterThanOrEqual(1);
      expect(length).toBeLessThanOrEqual(5);
    }
  });

  it('covers a type other lists through its _default', () => {
    const config = { listSize: { Post: { tags: 1, _default: 3 } } };
    expect(lengths(config, 'tags')).toEqual([1, 1, 1]);
    expect(lengths(config, 'colours')).toEqual([3, 3, 3]);
  });

  it('takes a bare size under the type name for all of its lists', () => {
    expect(lengths({ listSize: { Post: 2 } }, 'tags')).toEqual([2, 2, 2]);
    expect(lengths({ listSize: { Post: 2 } }, 'colours')).toEqual([2, 2, 2]);
  });

  it('takes the top-level _default for a type it does not name', () => {
    expect(lengths({ listSize: { _default: 2, Query: { posts: 9 } } }, 'tags')).toEqual([2, 2, 2]);
  });

  it('empties a list for a size of zero', () => {
    expect(lengths({ listSize: { Post: { tags: 0 } } }, 'tags')).toEqual([0, 0, 0]);
  });

  it('stays within a range', () => {
    for (const length of lengths({ listSize: { Post: { tags: { min: 2, max: 3 } } } }, 'tags')) {
      expect(length).toBeGreaterThanOrEqual(2);
      expect(length).toBeLessThanOrEqual(3);
    }
  });
});

describe('listSize against a QA list profile', () => {
  it('lets a named entry win, the way a relations entry does', () => {
    const config = { qa: 'emptyLists', listSize: { Post: { tags: 2 } } } as const;
    expect(lengths(config, 'tags')).toEqual([2, 2, 2]);
    // The profile still reaches every list the entry does not name.
    expect(lengths(config, 'colours')).toEqual([0, 0, 0]);
  });

  it('lets the catch-all lose, because a broad sweep beats a broad sweep', () => {
    expect(lengths({ qa: 'emptyLists', listSize: 4 }, 'tags')).toEqual([0, 0, 0]);
    expect(lengths({ qa: 'emptyLists', listSize: { _default: 4 } }, 'tags')).toEqual([0, 0, 0]);
  });
});

describe('listSize on relationship and root lists', () => {
  it('sizes a wired relationship list', () => {
    expect(lengths({ listSize: { Post: { comments: 2 } } }, 'comments')).toEqual([2, 2, 2]);
  });

  it('loses to a relations entry for the same field, which is more specific', () => {
    const mocks = build({
      listSize: { Post: { comments: 2 } },
      relations: { Post: { comments: 1 } },
    });
    for (const post of mocks.Post as Record<string, unknown[]>[]) {
      expect(post.comments?.length).toBe(1);
    }
  });

  it('sizes a root list, keyed by the operation type', () => {
    const data = build({ listSize: { Query: { posts: 2 } } }).dataForOperation(
      parse('{ posts { id } }'),
    ) as { posts: unknown[] };
    expect(data.posts).toHaveLength(2);
  });

  it('never grows a pool, so a size above count is clamped to it', () => {
    // `relations` auto-grows the target pool; `listSize` deliberately does not, since lists
    // are sampled without replacement and the documented contract is to raise `count` too.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(lengths({ count: 3, listSize: { Post: { comments: 10 } } }, 'comments')).toEqual([
      3, 3, 3,
    ]);
    warn.mockRestore();
  });
});

describe('a listSize config error', () => {
  it('throws for a type the schema does not have', () => {
    expect(() => build({ listSize: { Postt: { tags: 2 } } })).toThrow(/unknown type "Postt"/);
  });

  it('throws for a field the type does not have', () => {
    expect(() => build({ listSize: { Post: { tagz: 2 } } })).toThrow(/unknown field "Post.tagz"/);
  });

  it('throws for a field that is not a list, which it could not size', () => {
    expect(() => build({ listSize: { Post: { title: 2 } } })).toThrow(
      /"Post.title" is not a list \(String!\)/,
    );
  });

  it('leaves the reserved keys and the bare type-level form alone', () => {
    expect(() =>
      build({ listSize: { _default: 2, Post: { _default: 1 }, Comment: 2 } }),
    ).not.toThrow();
  });

  it('accepts a nullable list, which carries no non-null wrapper', () => {
    expect(() => build({ listSize: { Post: { notes: 2 } } })).not.toThrow();
    expect(lengths({ listSize: { Post: { notes: 2 } } }, 'notes')).toEqual([2, 2, 2]);
  });

  it('has nothing to check for the flat forms', () => {
    expect(() => build({ listSize: 2 })).not.toThrow();
    expect(() => build({ listSize: { min: 1, max: 2 } })).not.toThrow();
  });
});

describe('listSize across scenario layers', () => {
  it('merges map over map, per type then per field', () => {
    expect(
      mergeScenarios([
        { listSize: { Post: { tags: 2, colours: 3 } } },
        { listSize: { Post: { colours: 1 }, Comment: { body: 4 } } },
      ]),
    ).toEqual({ listSize: { Post: { tags: 2, colours: 1 }, Comment: { body: 4 } } });
  });

  it('replaces outright when the later layer is flat', () => {
    expect(mergeScenarios([{ listSize: { Post: { tags: 2 } } }, { listSize: 1 }])).toEqual({
      listSize: 1,
    });
  });

  it('promotes an earlier flat size to _default under a later map', () => {
    expect(mergeScenarios([{ listSize: 2 }, { listSize: { Post: { tags: 7 } } }])).toEqual({
      listSize: { _default: 2, Post: { tags: 7 } },
    });
  });

  it('replaces a leaf range atomically rather than merging its bounds', () => {
    expect(
      mergeScenarios([
        { listSize: { Post: { tags: { min: 1, max: 9 } } } },
        { listSize: { Post: { tags: { min: 2, max: 2 } } } },
      ]),
    ).toEqual({ listSize: { Post: { tags: { min: 2, max: 2 } } } });
  });

  it('reaches the build through a scenario', () => {
    expect(lengths({ scenario: { listSize: { Post: { tags: 2 } } } }, 'tags')).toEqual([2, 2, 2]);
  });
});

describe('listSize typing', () => {
  it('checks type and field names against a supplied map', () => {
    const ok: ListSizeConfig<TestTypes> = { Post: { tags: 2 } };
    expect(ok).toBeTruthy();

    // @ts-expect-error — `Comment` is not a key of TestTypes, which is the point of binding it.
    const bad: ListSizeConfig<TestTypes> = { Comment: { body: 2 } };
    expect(bad).toBeTruthy();
  });

  it('still takes the flat forms when bound', () => {
    const flat: ListSizeConfig<TestTypes> = { min: 1, max: 2 };
    expect(resolveListSize(flat)).toEqual({ min: 1, max: 2 });
  });
});
