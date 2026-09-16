import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildMocks } from './mockSchema.js';
import { UNBOUNDED, relationBounds, resolveRelation } from './relations.js';
import { schema } from './test/schema.js';
import type { RelationContext, RelationSpec, RelationsConfig } from './types.js';

const fn: RelationSpec = ({ pool }) => pool[0];

describe('resolveRelation', () => {
  const config: RelationsConfig = {
    User: { todos: 3, posts: { min: 1, max: 2 }, _default: 0 },
    Post: { comments: 'all' },
    _default: 7,
    _reciprocal: true,
  };

  const cases: [string, string, RelationsConfig | undefined, RelationSpec | undefined][] = [
    ['no config at all', 'User.todos', undefined, undefined],
    ['field entry wins over every default', 'User.todos', config, 3],
    ['a range reads as a size, not a map', 'User.posts', config, { min: 1, max: 2 }],
    ['the type default covers the type other fields', 'User.friends', config, 0],
    ['the top-level default covers other types', 'Comment.author', config, 7],
    ['a type entry without a default falls through', 'Post.author', config, 7],
    ['the flat form applies everywhere', 'User.todos', 2, 2],
    ['the flat form can be explicitly empty', 'User.todos', null, null],
    ['the flat form can be a function', 'User.todos', fn, fn],
  ];

  for (const [name, site, cfg, expected] of cases) {
    it(name, () => {
      const [typeName, fieldName] = site.split('.') as [string, string];
      expect(resolveRelation(typeName, fieldName, cfg)).toEqual(expected);
    });
  }

  it('keeps an explicit none distinct from no opinion', () => {
    const cfg: RelationsConfig = { User: { todos: null } };
    expect(resolveRelation('User', 'todos', cfg)).toBeNull();
    expect(resolveRelation('User', 'posts', cfg)).toBeUndefined();
  });

  it('ignores the reserved keys when looking up a type', () => {
    expect(resolveRelation('_reciprocal', 'todos', { _reciprocal: true })).toBeUndefined();
  });
});

describe('relationBounds', () => {
  const fallback = { min: 1, max: 5 };

  it('falls back for specs that carry no size', () => {
    expect(relationBounds(undefined, fallback)).toEqual(fallback);
    expect(relationBounds(fn, fallback)).toEqual(fallback);
  });

  it('reads null as none', () => {
    expect(relationBounds(null, fallback)).toBeNull();
  });

  it('pins a number to an exact size', () => {
    expect(relationBounds(3, fallback)).toEqual({ min: 3, max: 3 });
    expect(relationBounds(0, fallback)).toEqual({ min: 0, max: 0 });
  });

  it('passes a range through', () => {
    expect(relationBounds({ min: 2, max: 4 }, fallback)).toEqual({ min: 2, max: 4 });
  });

  it('leaves all unbounded for the sampler to clamp', () => {
    expect(relationBounds('all', fallback)).toEqual({ min: UNBOUNDED, max: UNBOUNDED });
  });
});

describe('buildMocks relations', () => {
  const users = (relations: RelationsConfig, options = {}) =>
    buildMocks(schema, { seed: 1, count: 3, relations, ...options }).User as Record<
      string,
      unknown
    >[];

  it('gives a field exactly the size it asks for', () => {
    for (const user of users({ User: { todos: 2 } })) {
      expect((user.todos as unknown[]).length).toBe(2);
    }
  });

  it('sizes a field within a range', () => {
    for (const user of users({ User: { todos: { min: 1, max: 2 } } })) {
      expect((user.todos as unknown[]).length).toBeGreaterThanOrEqual(1);
      expect((user.todos as unknown[]).length).toBeLessThanOrEqual(2);
    }
  });

  it('empties every list under a flat zero', () => {
    for (const user of users(0)) {
      expect(user.todos).toEqual([]);
      expect(user.posts).toEqual([]);
    }
  });

  it('takes the whole pool for all', () => {
    const mocks = buildMocks(schema, {
      seed: 1,
      count: 4,
      relations: { Post: { comments: 'all' } },
    });
    for (const post of mocks.Post as Record<string, unknown>[]) {
      expect((post.comments as unknown[]).length).toBe((mocks.Comment as unknown[]).length);
    }
  });

  it('falls back to the type default, then the top-level one', () => {
    for (const user of users({ User: { todos: 1, _default: 2 }, _default: 3 })) {
      expect((user.todos as unknown[]).length).toBe(1);
      expect((user.posts as unknown[]).length).toBe(2);
    }
    for (const user of users({ Post: { comments: 1 }, _default: 3 })) {
      expect((user.todos as unknown[]).length).toBe(3);
    }
  });

  it('lets a function choose which entities are connected', () => {
    const mocks = buildMocks(schema, {
      seed: 1,
      count: 3,
      stableIds: true,
      relations: {
        Post: { author: ({ pool }) => pool[0], comments: ({ pool }) => pool.slice(0, 1) },
      },
    });
    for (const post of mocks.Post as Record<string, unknown>[]) {
      expect((post.author as Record<string, unknown>).id).toBe('User-0');
      expect((post.comments as Record<string, unknown>[])[0]?.id).toBe('Comment-0');
    }
  });

  it('hands the function the site it is wiring', () => {
    const seen: Omit<RelationContext, 'pool' | 'faker' | 'instance'>[] = [];
    buildMocks(schema, {
      seed: 1,
      count: 2,
      relations: {
        User: {
          todos: (ctx) => {
            const { index, typeName, fieldName, isList } = ctx;
            seen.push({ index, typeName, fieldName, isList });
            expect(ctx.instance.name).toEqual(expect.any(String));
            return ctx.pool.slice(0, 1);
          },
        },
      },
    });
    expect(seen).toEqual([
      { index: 0, typeName: 'User', fieldName: 'todos', isList: true },
      { index: 1, typeName: 'User', fieldName: 'todos', isList: true },
    ]);
  });

  it('beats the QA list profile, which is the less specific lever', () => {
    for (const user of users({ User: { todos: 2 } }, { qa: 'emptyLists' })) {
      expect((user.todos as unknown[]).length).toBe(2);
      expect(user.posts).toEqual([]);
    }
  });

  it('beats nullChance for the fields it names', () => {
    const nullable = buildSchema(`
      type Owner { id: ID!, pet: Pet, pets: [Pet!] }
      type Pet { id: ID!, name: String! }
      type Query { owners: [Owner!]! }
    `);
    const mocks = buildMocks(nullable, {
      seed: 1,
      count: 2,
      nullChance: 1,
      relations: { Owner: { pets: 2 } },
    });
    for (const owner of mocks.Owner as Record<string, unknown>[]) {
      expect((owner.pets as unknown[]).length).toBe(2);
      expect(owner.pet).toBeNull();
    }
  });

  it('loses to an overrides entry for the same field', () => {
    for (const user of users(
      { User: { todos: 3 } },
      { overrides: { User: { todos: () => [] } } },
    )) {
      expect(user.todos).toEqual([]);
    }
  });
});
