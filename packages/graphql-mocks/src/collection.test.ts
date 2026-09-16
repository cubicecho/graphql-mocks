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
});
