import { describe, expect, it } from 'vitest';
import { paginate, searchItems } from './collection.js';

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
