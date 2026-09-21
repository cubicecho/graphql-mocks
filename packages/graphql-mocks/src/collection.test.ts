import { parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMIT_ARGS,
  DEFAULT_OFFSET_ARGS,
  DEFAULT_SEARCH_ARGS,
  type PaginateArgsOptions,
  paginate,
  paginateArgs,
  searchItems,
} from './collection.js';
import { buildMocks } from './mockSchema.js';
import { schema } from './test/schema.js';

const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

describe('paginate', () => {
  it('returns a copy of the whole list when no arguments are given', () => {
    const result = paginate(items, {});
    expect(result).toEqual(items);
    expect(result).not.toBe(items);
  });

  it('slices by skip and limit', () => {
    expect(paginate(items, { skip: 2, limit: 3 })).toEqual([2, 3, 4]);
  });

  it('accepts the offset/first dialect', () => {
    expect(paginate(items, { offset: 5, first: 2 })).toEqual([5, 6]);
  });

  it('accepts take as a page size', () => {
    expect(paginate(items, { take: 4 })).toEqual([0, 1, 2, 3]);
  });

  it('prefers skip over offset and limit over first and take', () => {
    expect(paginate(items, { skip: 1, offset: 8, limit: 2, first: 9, take: 9 })).toEqual([1, 2]);
  });

  it('treats null and undefined arguments as absent', () => {
    expect(paginate(items, { skip: null, limit: undefined })).toEqual(items);
  });

  it('clamps a negative offset to the start', () => {
    expect(paginate(items, { skip: -5, limit: 2 })).toEqual([0, 1]);
  });

  it('returns an empty list for a non-positive page size', () => {
    expect(paginate(items, { limit: 0 })).toEqual([]);
    expect(paginate(items, { limit: -3 })).toEqual([]);
  });

  it('returns an empty list when the offset is past the end', () => {
    expect(paginate(items, { skip: 100, limit: 5 })).toEqual([]);
  });

  it('ignores non-finite page arguments', () => {
    expect(paginate(items, { skip: Number.NaN, limit: Number.POSITIVE_INFINITY })).toEqual(items);
  });
});

describe('searchItems', () => {
  const users = [
    { name: 'Ann Lee', city: 'Boston', age: 30 },
    { name: 'Bob Ray', city: 'Annapolis', age: 40 },
    { name: 'Cid Fox', city: 'Denver', age: 50 },
  ];

  it('returns a copy of the whole list for a null, undefined or empty term', () => {
    for (const term of [null, undefined, '']) {
      const result = searchItems(users, term);
      expect(result).toEqual(users);
      expect(result).not.toBe(users);
    }
  });

  it('matches any string field case-insensitively', () => {
    expect(searchItems(users, 'ann').map((u) => u.name)).toEqual(['Ann Lee', 'Bob Ray']);
  });

  it('restricts the search to the given fields', () => {
    expect(searchItems(users, 'ann', ['name']).map((u) => u.name)).toEqual(['Ann Lee']);
  });

  it('ignores non-string field values', () => {
    expect(searchItems(users, '30')).toEqual([]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(searchItems(users, 'zzz')).toEqual([]);
  });

  it('skips null and non-object items', () => {
    expect(searchItems([null, 'Ann', { name: 'Ann' }], 'ann')).toEqual([{ name: 'Ann' }]);
  });

  it('ignores field names the item does not have', () => {
    expect(searchItems(users, 'ann', ['nope'])).toEqual([]);
  });

  describe('nested fields', () => {
    interface Post {
      title: string;
      tags: string[];
      author?: { name: string; email?: string } | null;
      comments?: { text: string }[];
    }

    const posts: Post[] = [
      {
        title: 'Release notes',
        tags: ['news'],
        author: { name: 'Ann Lee', email: 'ann@example.com' },
        comments: [{ text: 'nice' }, { text: 'thanks Ann' }],
      },
      { title: 'Roadmap', tags: ['planning', 'announcement'], author: { name: 'Bob Ray' } },
      { title: 'Postmortem', tags: [], author: null },
    ];

    const titles = (result: Post[]) => result.map((post) => post.title);

    it('follows a dotted path through a related object', () => {
      expect(titles(searchItems(posts, 'ann', ['author.name']))).toEqual(['Release notes']);
    });

    it('searches several paths at once', () => {
      expect(titles(searchItems(posts, 'ray', ['title', 'author.name']))).toEqual(['Roadmap']);
    });

    it('steps through a list on the way, matching if any entry does', () => {
      expect(titles(searchItems(posts, 'thanks', ['comments.text']))).toEqual(['Release notes']);
    });

    it('searches the entries of a string list', () => {
      expect(titles(searchItems(posts, 'announce', ['tags']))).toEqual(['Roadmap']);
    });

    it('treats a missing link as a non-match rather than throwing', () => {
      // `author` is null on one post and `author.email` absent on another: neither may throw.
      expect(titles(searchItems(posts, 'example.com', ['author.email']))).toEqual([
        'Release notes',
      ]);
    });

    it('stops at a path that runs through a non-object', () => {
      expect(searchItems(posts, 'release', ['title.length'])).toEqual([]);
    });

    it('takes an accessor for anything a path cannot express', () => {
      const result = searchItems(posts, 'ANN', [(post) => post.author?.email?.split('@')[0]]);
      expect(titles(result)).toEqual(['Release notes']);
    });

    it('ignores an accessor that returns a non-string', () => {
      expect(searchItems(posts, '3', [(post) => post.tags.length])).toEqual([]);
    });
  });
});

describe('paginateArgs', () => {
  const posts = Array.from({ length: 12 }, (_, index) => ({
    id: `Post-${index}`,
    title: index % 2 === 0 ? `Ada ${index}` : `Grace ${index}`,
  }));
  const page = (args: Record<string, unknown>, options?: PaginateArgsOptions) =>
    paginateArgs(posts, { args }, options);

  it('reads the offset and page size out of the arguments', () => {
    const result = page({ skip: 2, limit: 3 });

    expect(result.items.map((post) => post.id)).toEqual(['Post-2', 'Post-3', 'Post-4']);
    expect(result.skip).toBe(2);
    expect(result.limit).toBe(3);
  });

  it('accepts every dialect the argument matcher does, first name winning', () => {
    expect(page({ offset: 4, take: 2 }).items.map((post) => post.id)).toEqual(['Post-4', 'Post-5']);
    expect(page({ first: 1 }).items).toHaveLength(1);
    expect(page({ skip: 1, offset: 5, limit: 1 }).items[0]?.id).toBe('Post-1');
  });

  it('searches on the named fields before paging', () => {
    const result = page({ search: 'ada', limit: 2 }, { searchFields: ['title'] });

    expect(result.items.map((post) => post.title)).toEqual(['Ada 0', 'Ada 2']);
    expect(result.matchedCount).toBe(6);
    expect(result.totalCount).toBe(12);
    expect(result.search).toBe('ada');
  });

  it('is unpaged when no page size is given, rather than empty', () => {
    const result = page({});

    expect(result.items).toHaveLength(12);
    expect(result.limit).toBeUndefined();
  });

  it('falls back to defaultLimit, which an argument still beats', () => {
    expect(page({}, { defaultLimit: 5 }).items).toHaveLength(5);
    expect(page({ limit: 2 }, { defaultLimit: 5 }).items).toHaveLength(2);
  });

  it('treats a null or wrongly typed argument as absent', () => {
    const result = page({ skip: null, limit: '3', search: 42 });

    expect(result.items).toHaveLength(12);
    expect(result.skip).toBe(0);
    expect(result.search).toBeUndefined();
  });

  it('clamps a negative offset and empties on a zero page size', () => {
    expect(page({ skip: -5, limit: 2 }).items.map((post) => post.id)).toEqual(['Post-0', 'Post-1']);
    expect(page({ limit: 0 }).items).toEqual([]);
  });

  it('finds arguments one level inside an input object', () => {
    const result = page(
      { where: { search: 'grace' }, page: { limit: 2 } },
      {
        searchFields: ['title'],
      },
    );

    expect(result.items.map((post) => post.title)).toEqual(['Grace 1', 'Grace 3']);
    expect(result.matchedCount).toBe(6);
  });

  it('prefers a top-level argument to a nested one of the same name', () => {
    const result = page({ limit: 1, where: { limit: 9 } });

    expect(result.items).toHaveLength(1);
  });

  it('leaves nested arguments alone when flattening is off', () => {
    const result = page({ where: { limit: 2 } }, { flattenInputs: false });

    expect(result.items).toHaveLength(12);
  });

  it('takes the argument names the caller names instead', () => {
    const result = page(
      // The offset applies to what the search left: six "Ada" posts, so 5 is the last of them.
      { cursorAt: 5, pageSize: 1, needle: 'ada' },
      {
        offsetArgs: ['cursorAt'],
        limitArgs: ['pageSize'],
        searchArgs: ['needle'],
        searchFields: ['title'],
      },
    );

    expect(result.items.map((post) => post.title)).toEqual(['Ada 10']);
    expect(result.skip).toBe(5);
  });

  it('answers an argOverrides handler from the field context', () => {
    const mocks = buildMocks(schema, {
      seed: 2,
      count: { Post: 8 },
      stableIds: true,
      matchArguments: true,
      argOverrides: [
        {
          match: { type: 'Query', field: 'posts' },
          data: (ctx) => paginateArgs(ctx.pool, ctx, { defaultLimit: 2 }).items,
        },
      ],
    });

    const data = mocks.dataForOperation(
      parse('query Posts($take: Int) { posts(take: $take) { id } }'),
      { take: 3 },
    ) as { posts: { id: string }[] };

    expect(data.posts).toHaveLength(3);
  });

  describe('totalField', () => {
    const rows = [
      { status: 'OPEN', count: 3, totalCount: 999 },
      { status: 'CLOSED', count: 2, totalCount: 999 },
      { status: 'OPEN_LATE', count: 1, totalCount: 999 },
    ];

    it('stamps the matched count on every row of the page', () => {
      const result = paginateArgs(
        rows,
        { args: { search: 'open', limit: 1 } },
        {
          searchFields: ['status'],
          totalField: 'totalCount',
        },
      );

      expect(result.items).toEqual([{ status: 'OPEN', count: 3, totalCount: 2 }]);
      // The page holds one row; the number on it is what the search left, not what it returned.
      expect(result.matchedCount).toBe(2);
    });

    it('copies each row instead of writing into the pooled object', () => {
      const result = paginateArgs(rows, { args: {} }, { totalField: 'totalCount' });

      expect(result.items[0]).not.toBe(rows[0]);
      expect(rows[0]?.totalCount).toBe(999);
    });

    it('overwrites the mocked value already sitting under that name', () => {
      const result = paginateArgs(rows, { args: {} }, { totalField: 'totalCount' });

      expect(result.items.map((row) => row.totalCount)).toEqual([3, 3, 3]);
    });

    it('adds a name the row does not have yet', () => {
      const result = paginateArgs(rows, { args: { skip: 2 } }, { totalField: 'pageTotal' });

      expect(result.items).toEqual([
        { status: 'OPEN_LATE', count: 1, totalCount: 999, pageTotal: 3 },
      ]);
      // Typed, not just present: the stamped name is on the element type.
      expect(result.items[0]?.pageTotal).toBe(3);
    });

    it('passes a row that is not an object through untouched', () => {
      const result = paginateArgs(['a', 'b'], { args: {} }, { totalField: 'totalCount' });

      expect(result.items).toEqual(['a', 'b']);
    });

    it('leaves the rows alone when no name is given', () => {
      const result = paginateArgs(rows, { args: {} });

      expect(result.items[0]).toBe(rows[0]);
    });

    it('answers a flattened aggregate field end to end', () => {
      const mocks = buildMocks(schema, {
        seed: 4,
        matchArguments: true,
        argOverrides: [
          {
            match: { type: 'Query', field: 'posts' },
            data: (ctx) =>
              paginateArgs(ctx.pool as { id: string }[], ctx, { totalField: 'viewCount' }).items,
          },
        ],
        count: { Post: 5 },
      });

      const data = mocks.dataForOperation(
        parse('query Posts($take: Int) { posts(take: $take) { id viewCount } }'),
        { take: 2 },
      ) as { posts: { id: string; viewCount: number }[] };

      expect(data.posts).toHaveLength(2);
      // The mocked viewCount on each pooled post is replaced by the unpaged total.
      expect(data.posts.map((post) => post.viewCount)).toEqual([5, 5]);
    });
  });

  it('shares the argument names the matcher uses', () => {
    expect(DEFAULT_OFFSET_ARGS).toContain('skip');
    expect(DEFAULT_LIMIT_ARGS).toContain('take');
    expect(DEFAULT_SEARCH_ARGS).toContain('q');
  });
});
