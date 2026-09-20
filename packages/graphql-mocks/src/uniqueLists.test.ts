import { faker } from '@faker-js/faker';
import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import { lookupUniqueLists, resolveUniqueLists } from './helpers.js';
import { buildMocks } from './mockSchema.js';
import { mergeScenarios } from './scenarios.js';
import type { BuildMocksOptions, UniqueListsConfig } from './types.js';

const schema = buildSchema(`
  enum Colour { RED GREEN BLUE }
  scalar JSON
  type Comment { id: ID!, body: String! }
  type Post {
    id: ID!
    title: String!
    tags: [String!]!
    colours: [Colour!]!
    payloads: [JSON!]!
    comments: [Comment!]!
  }
  type Query { posts: [Post!]! }
`);

/** Stands in for a codegen `SchemaTypeMap`, so the map form's keys are checked. */
type TestTypes = { Post: { tags: string[]; colours: string[]; comments: unknown[] } };

const posts = (options: BuildMocksOptions = {}) =>
  buildMocks(schema, { seed: 5, count: 3, ...options }).Post as Record<string, unknown[]>[];

const values = (options: BuildMocksOptions, field: string) =>
  posts(options).map((post) => post[field] as unknown[]);

const hasDuplicate = (list: unknown[]) =>
  new Set(list.map((v) => JSON.stringify(v))).size !== list.length;

describe('unique scalar and enum lists', () => {
  it('clamps an enum list to the values that exist instead of repeating them', () => {
    // 4–10 entries over a three-value enum has no seed that avoids a repeat, which is the case
    // this option was added for: the length gives way, not the distinctness.
    for (const colours of values({ listSize: { min: 4, max: 10 } }, 'colours')) {
      expect(colours.length).toBe(3);
      expect(new Set(colours).size).toBe(3);
      for (const colour of colours) expect(['RED', 'GREEN', 'BLUE']).toContain(colour);
    }
  });

  it('keeps an enum list within a size it can satisfy', () => {
    for (const colours of values({ listSize: { Post: { colours: 2 } } }, 'colours')) {
      expect(colours.length).toBe(2);
      expect(new Set(colours).size).toBe(2);
    }
  });

  it('draws a scalar list without replacement', () => {
    // Seed 7 is one of the seeds where the old independent draws repeated a `faker.lorem.word()`
    // — the assertion below pins that, so this stays a real regression test and not a tautology.
    const options = { seed: 7, listSize: { Post: { tags: { min: 4, max: 10 } } } };
    for (const tags of values(options, 'tags')) {
      expect(tags.length).toBeGreaterThan(0);
      expect(new Set(tags).size).toBe(tags.length);
    }
    expect(values({ ...options, uniqueLists: false }, 'tags').some(hasDuplicate)).toBe(true);
  });

  it('compares object-valued scalars by their contents', () => {
    for (const payloads of values({ listSize: { Post: { payloads: 5 } } }, 'payloads')) {
      expect(hasDuplicate(payloads)).toBe(false);
    }
  });

  it('comes back short rather than looping when a generator repeats itself', () => {
    const [tags] = values(
      { listSize: { Post: { tags: 9 } }, scalars: { String: () => 'same' } },
      'tags',
    );
    expect(tags).toEqual(['same']);
  });

  it('treats a value it cannot serialize as distinct instead of collapsing the list', () => {
    // A `JSON` scalar holding a BigInt has no JSON form to compare by. Every draw then counts
    // as its own value, which keeps the list its full length rather than truncating to one.
    const [payloads] = values(
      { listSize: { Post: { payloads: 4 } }, scalars: { JSON: () => ({ big: 1n }) } },
      'payloads',
    );
    expect(payloads).toHaveLength(4);
  });

  it('leaves relationship lists alone, which were already without replacement', () => {
    for (const comments of values({ listSize: { Post: { comments: 2 } } }, 'comments')) {
      expect(comments).toHaveLength(2);
      expect(new Set(comments).size).toBe(2);
    }
  });
});

describe('turning unique lists off', () => {
  it('restores the independent draws for every list', () => {
    for (const colours of values({ listSize: 6, uniqueLists: false }, 'colours')) {
      expect(colours.length).toBe(6);
    }
  });

  it('names one field, leaving the type other lists unique', () => {
    const options = { listSize: 6, uniqueLists: { Post: { tags: false } } };
    expect(values(options, 'tags').every((tags) => tags.length === 6)).toBe(true);
    for (const colours of values(options, 'colours')) expect(colours.length).toBe(3);
  });

  it('covers a type other lists through its _default', () => {
    const options = { listSize: 6, uniqueLists: { Post: { tags: true, _default: false } } };
    expect(values(options, 'colours').every((colours) => colours.length === 6)).toBe(true);
    expect(values(options, 'tags').every((tags) => new Set(tags).size === tags.length)).toBe(true);
  });

  it('takes a bare flag under the type name for all of its lists', () => {
    const options = { listSize: 6, uniqueLists: { Post: false } };
    expect(values(options, 'colours').every((colours) => colours.length === 6)).toBe(true);
  });

  it('takes the top-level _default for a type it does not name', () => {
    const options = { listSize: 6, uniqueLists: { _default: false, Comment: true } };
    expect(values(options, 'colours').every((colours) => colours.length === 6)).toBe(true);
  });
});

describe('uniqueLists under QA mode', () => {
  const qa = { text: 'unicode', lists: 'huge', listSize: 40 } as const;

  it('stays off by default, so a huge list still reaches its length', () => {
    // The QA corpora are a handful of strings each; deduplicating them would cap `lists: 'huge'`
    // at the size of the corpus, which is not what the profile is asking for.
    expect(values({ qa }, 'tags')[0]).toHaveLength(40);
  });

  it('applies when the caller asks for it explicitly', () => {
    const [tags = []] = values({ qa, uniqueLists: true }, 'tags');
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags.length).toBeLessThan(40);
  });

  it('applies to a field a map names, the way a named listSize outranks a QA profile', () => {
    const [tags = []] = values({ qa, uniqueLists: { Post: { tags: true } } }, 'tags');
    expect(new Set(tags).size).toBe(tags.length);
  });
});

describe('resolveUniqueLists', () => {
  it('falls back when nothing is given', () => {
    expect(resolveUniqueLists(undefined, true)).toBe(true);
    expect(resolveUniqueLists(undefined, false)).toBe(false);
  });

  it('reads the flat form as written', () => {
    expect(resolveUniqueLists(false, true)).toBe(false);
    expect(resolveUniqueLists(true, false)).toBe(true);
  });

  it('takes the catch-all from a map _default, ignoring the named entries', () => {
    expect(resolveUniqueLists({ _default: false, Post: { tags: true } }, true)).toBe(false);
    expect(resolveUniqueLists({ Post: { tags: false } }, true)).toBe(true);
  });
});

describe('lookupUniqueLists', () => {
  const config: UniqueListsConfig = {
    _default: true,
    Post: { tags: false, _default: true },
    Comment: false,
  };

  it('finds the entry naming the exact field', () => {
    expect(lookupUniqueLists('Post', 'tags', config)).toBe(false);
  });

  it('falls back to the type default for that type other lists', () => {
    expect(lookupUniqueLists('Post', 'colours', config)).toBe(true);
  });

  it('reads a bare flag under a type name as covering all of its lists', () => {
    expect(lookupUniqueLists('Comment', 'anything', config)).toBe(false);
  });

  it('has no opinion about a type the map does not name, or about the flat form', () => {
    // The top-level `_default` is the catch-all, which the QA fallback reads instead.
    expect(lookupUniqueLists('Other', 'things', config)).toBeUndefined();
    expect(lookupUniqueLists('Post', 'tags', undefined)).toBeUndefined();
    expect(lookupUniqueLists('Post', 'tags', true)).toBeUndefined();
  });
});

describe('uniqueLists validation', () => {
  const build = (uniqueLists: UniqueListsConfig) =>
    buildMocks(schema, { faker, seed: 1, count: 1, uniqueLists });

  it('rejects a type the schema does not have', () => {
    expect(() => build({ Postt: { tags: false } })).toThrow(/unknown type "Postt"/);
  });

  it('rejects a field the type does not have', () => {
    expect(() => build({ Post: { taggs: false } })).toThrow(/unknown field "Post.taggs"/);
  });

  it('rejects a field that is not a list', () => {
    expect(() => build({ Post: { title: false } })).toThrow(/is not a list/);
  });

  it('accepts the flat form and a bare flag under a type name', () => {
    expect(() => build(false)).not.toThrow();
    expect(() => build({ Post: true, _default: false })).not.toThrow();
  });
});

describe('uniqueLists across scenario layers', () => {
  it('merges maps per type and per field', () => {
    expect(
      mergeScenarios([
        { uniqueLists: { Post: { tags: false } } },
        { uniqueLists: { Post: { colours: false }, Comment: false } },
      ]),
    ).toEqual({ uniqueLists: { Post: { tags: false, colours: false }, Comment: false } });
  });

  it('lets a later flat form replace a map outright', () => {
    expect(
      mergeScenarios([{ uniqueLists: { Post: { tags: false } } }, { uniqueLists: true }]),
    ).toEqual({ uniqueLists: true });
  });

  it('promotes an earlier flat form to the catch-all of a later map', () => {
    expect(
      mergeScenarios([{ uniqueLists: false }, { uniqueLists: { Post: { tags: true } } }]),
    ).toEqual({ uniqueLists: { _default: false, Post: { tags: true } } });
  });
});

describe('uniqueLists typing', () => {
  it('checks type and field names against a supplied map', () => {
    const ok: UniqueListsConfig<TestTypes> = { Post: { tags: false } };
    expect(ok).toBeTruthy();

    // @ts-expect-error — `Comment` is not a key of TestTypes, which is the point of binding it.
    const bad: UniqueListsConfig<TestTypes> = { Comment: { body: false } };
    expect(bad).toBeTruthy();
  });

  it('still takes the flat form when bound', () => {
    const flat: UniqueListsConfig<TestTypes> = false;
    expect(resolveUniqueLists(flat, true)).toBe(false);
  });
});
