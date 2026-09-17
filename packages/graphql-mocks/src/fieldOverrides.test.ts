import { describe, expect, it, vi } from 'vitest';
import { fieldOverridePattern } from './fieldOverrides.js';
import { buildMocks } from './mockSchema.js';
import { schema } from './test/schema.js';
import type { BuildMocksOptions } from './types.js';

/**
 * The pools these tests read from. Naming them keeps `mocks.User[0]` typed: the bare
 * `MockResult` only carries an index signature, which `noUncheckedIndexedAccess` widens to
 * `unknown[] | undefined`.
 */
type Pools = Record<'User' | 'Todo' | 'Post' | 'Comment', Record<string, unknown>>;

const build = (options: BuildMocksOptions<Pools> = {}) =>
  buildMocks<Pools>(schema, { seed: 3, count: 2, ...options });

describe('fieldOverrides', () => {
  it('applies one entry to every type carrying that field name', () => {
    const mocks = build({ fieldOverrides: { createdAt: () => 'FIXED' } });

    expect(mocks.User[0]?.createdAt).toBe('FIXED');
    expect(mocks.Todo[0]?.createdAt).toBe('FIXED');
    expect(mocks.Comment[0]?.createdAt).toBe('FIXED');
  });

  it('leaves every other field to the usual generator', () => {
    const mocks = build({ fieldOverrides: { createdAt: () => 'FIXED' } });

    expect(mocks.User[0]?.name).not.toBe('FIXED');
    expect(mocks.Todo[0]?.dueDate).not.toBe('FIXED');
  });

  it('hands the override the seeded faker and the site it fires at', () => {
    const sites: string[] = [];
    build({
      count: 2,
      fieldOverrides: {
        title: (faker, { index, typeName, fieldName }) => {
          sites.push(`${typeName}.${fieldName}#${index}`);
          return faker.string.alpha(4);
        },
      },
    });

    expect(sites).toContain('Todo.title#0');
    expect(sites).toContain('Todo.title#1');
    expect(sites).toContain('Post.title#0');
  });

  it('loses to a type-keyed overrides entry for the same field, and only there', () => {
    const mocks = build({
      fieldOverrides: { createdAt: () => 'BY-NAME' },
      overrides: { Todo: { createdAt: () => 'BY-TYPE' } },
    });

    expect(mocks.Todo[0]?.createdAt).toBe('BY-TYPE');
    expect(mocks.User[0]?.createdAt).toBe('BY-NAME');
  });

  it('takes a relationship field, the way a type-keyed override does', () => {
    const mocks = build({
      fieldOverrides: { author: () => ({ __typename: 'User', id: 'AUTHOR' }) },
    });

    expect((mocks.Post[0]?.author as { id: string }).id).toBe('AUTHOR');
    expect((mocks.Comment[0]?.author as { id: string }).id).toBe('AUTHOR');
  });

  it('is applied before stable ids, so an id entry is not overwritten', () => {
    const mocks = build({
      stableIds: true,
      fieldOverrides: { id: (_f, { typeName, index }) => `${typeName}!${index}` },
    });

    expect(mocks.User[0]?.id).toBe('User!0');
    expect(mocks.Todo[1]?.id).toBe('Todo!1');
  });
});

describe('a fieldOverrides pattern', () => {
  it('covers every field name it matches', () => {
    const mocks = build({ fieldOverrides: { '/At$/': () => 'DATE' } });

    expect(mocks.User[0]?.createdAt).toBe('DATE');
    expect(mocks.Post[0]?.publishedAt).toBe('DATE');
    expect(mocks.User[0]?.name).not.toBe('DATE');
  });

  it('takes flags', () => {
    const mocks = build({ fieldOverrides: { '/^TITLE$/i': () => 'CASELESS' } });

    expect(mocks.Todo[0]?.title).toBe('CASELESS');
  });

  it('matches every field even when the pattern is global', () => {
    const mocks = build({ fieldOverrides: { '/At$/g': () => 'DATE' } });

    expect(mocks.User[0]?.createdAt).toBe('DATE');
    expect(mocks.Todo[0]?.createdAt).toBe('DATE');
    expect(mocks.Comment[0]?.createdAt).toBe('DATE');
  });

  it('loses to an exact name, whichever order they are written in', () => {
    const mocks = build({
      fieldOverrides: { '/At$/': () => 'PATTERN', createdAt: () => 'EXACT' },
    });

    expect(mocks.User[0]?.createdAt).toBe('EXACT');
    expect(mocks.Post[0]?.publishedAt).toBe('PATTERN');
  });

  it('loses to an earlier pattern', () => {
    const mocks = build({
      fieldOverrides: { '/^created/': () => 'FIRST', '/At$/': () => 'SECOND' },
    });

    expect(mocks.User[0]?.createdAt).toBe('FIRST');
    expect(mocks.Post[0]?.publishedAt).toBe('SECOND');
  });

  it('reads a slash-wrapped key as a pattern and anything else as a name', () => {
    expect(fieldOverridePattern('imageUrl')).toBeUndefined();
    expect(fieldOverridePattern('/Url$/i')?.flags).toBe('i');
    expect(fieldOverridePattern('/Url$/')?.source).toBe('Url$');
  });

  it('throws on a key that looks like a pattern but cannot compile', () => {
    expect(() => build({ fieldOverrides: { '/(/': () => 'x' } })).toThrow(
      /looks like a pattern but is not a valid regular expression/,
    );
  });
});

describe('an unmatched fieldOverrides key', () => {
  it('warns, naming the key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    build({ fieldOverrides: { imagUrl: () => 'x' } });

    // `mockRestore` clears the recorded calls too, so assert first.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"imagUrl" matches no field'));
    warn.mockRestore();
  });

  it('stays quiet for a name every type-keyed entry happens to shadow', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    build({
      fieldOverrides: { slug: () => 'by-name' },
      overrides: { Post: { slug: () => 'by-type' } },
    });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns for a pattern that matches nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    build({ fieldOverrides: { '/Nope$/': () => 'x' } });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"/Nope$/" matches no field'));
    warn.mockRestore();
  });

  it('warns for a root field, which overrides do not reach', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    build({ fieldOverrides: { usersByIds: () => [] } });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"usersByIds" matches no field'));
    warn.mockRestore();
  });
});

describe('fieldOverrides in a scenario', () => {
  it('merges key by key, with the explicit options winning', () => {
    const mocks = build({
      scenario: { fieldOverrides: { createdAt: () => 'SCENARIO', title: () => 'KEPT' } },
      fieldOverrides: { createdAt: () => 'EXPLICIT' },
    });

    expect(mocks.User[0]?.createdAt).toBe('EXPLICIT');
    expect(mocks.Todo[0]?.title).toBe('KEPT');
  });
});
