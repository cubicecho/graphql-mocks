import { buildSchema, parse } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
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

describe('validateRelations', () => {
  const build = (relations: RelationsConfig) => () =>
    buildMocks(schema, { seed: 1, count: 2, relations });

  it('rejects an entry for a type the schema does not have', () => {
    expect(build({ Nope: { todos: 1 } })).toThrow(TypeError);
    expect(build({ Nope: { todos: 1 } })).toThrow(/unknown type "Nope"/);
  });

  it('rejects a field the type does not have', () => {
    expect(build({ User: { nope: 1 } })).toThrow(/unknown field "User.nope"/);
  });

  it('rejects a spec on a scalar or enum field', () => {
    expect(build({ User: { name: 1 } })).toThrow(/"User.name" is a String field/);
    expect(build({ Todo: { priority: 1 } })).toThrow(/"Todo.priority" is a Priority field/);
  });

  it('rejects emptying a non-null singular field', () => {
    expect(build({ Todo: { user: null } })).toThrow(/"Todo.user" is non-null \(User!\)/);
    expect(build({ Todo: { user: 0 } })).toThrow(/cannot be emptied/);
    expect(build({ Todo: { user: { min: 0, max: 0 } } })).toThrow(/cannot be emptied/);
  });

  it('allows emptying a non-null list, since [] satisfies it', () => {
    const mocks = buildMocks(schema, { seed: 1, count: 2, relations: { User: { todos: null } } });
    expect((mocks.User as Record<string, unknown>[])[0]?.todos).toEqual([]);
  });

  it('rejects sizes that are negative, fractional or inverted', () => {
    expect(build({ User: { todos: -1 } })).toThrow(RangeError);
    expect(build({ User: { todos: 1.5 } })).toThrow(/non-negative integer/);
    expect(build({ User: { todos: { min: 3, max: 1 } } })).toThrow(/min 3 greater than max 1/);
    expect(build({ _default: -2 })).toThrow(/"_default" must be a non-negative integer/);
    expect(build({ User: { _default: -2 } })).toThrow(/"User._default"/);
  });

  it('rejects a bare spec where a field map belongs', () => {
    expect(build({ User: 3 } as never)).toThrow(/expected a field map for "User"/);
  });

  it('ignores the flat form, which has no keys to check', () => {
    expect(build(null)).not.toThrow();
  });
});

describe('relations non-null policy', () => {
  it('populates a non-null singular field a catch-all tried to empty', () => {
    const mocks = buildMocks(schema, { seed: 1, count: 2, relations: 0 });
    for (const todo of mocks.Todo as Record<string, unknown>[]) {
      expect(todo.user).toMatchObject({ __typename: 'User' });
    }
  });

  it('keeps a query executable when relations empty the graph', () => {
    const mocks = buildMocks(schema, { seed: 1, count: 2, relations: 0 });
    const data = mocks.dataForOperation(parse('{ todos { id user { name } } }')) as {
      todos: { user: { name: string } | null }[];
    };
    expect(data.todos.length).toBeGreaterThan(0);
    for (const todo of data.todos) expect(todo.user?.name).toEqual(expect.any(String));
  });

  it('repairs a function that empties a non-null field, warning once per site', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mocks = buildMocks(schema, {
      seed: 1,
      count: 3,
      relations: { Todo: { user: () => null } },
    });
    for (const todo of mocks.Todo as Record<string, unknown>[]) {
      expect(todo.user).toMatchObject({ __typename: 'User' });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"Todo.user" returned nothing'));
    warn.mockRestore();
  });

  it('reads an empty list from a function as an empty list, not a repair', () => {
    const mocks = buildMocks(schema, {
      seed: 1,
      count: 2,
      relations: { User: { todos: () => undefined } },
    });
    expect((mocks.User as Record<string, unknown>[])[0]?.todos).toEqual([]);
  });

  it('warns once when an empty pool leaves a non-null field null', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildMocks(schema, { seed: 1, count: { _default: 2, User: 0 } });
    const messages = warn.mock.calls.map(([m]) => m as string);
    expect(messages).toContainEqual(expect.stringContaining('"Todo.user" is non-null'));
    expect(messages.filter((m) => m.includes('"Todo.user"'))).toHaveLength(1);
    warn.mockRestore();
  });
});
