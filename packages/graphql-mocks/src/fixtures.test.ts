import { describe, expect, it, vi } from 'vitest';
import { buildMocks } from './mockSchema.js';
import { mergeScenarios } from './scenarios.js';
import { schema } from './test/schema.js';
import type { BuildMocksOptions } from './types.js';

/**
 * Naming the pools keeps `mocks.Todo[0]` typed: a bare `MockResult` only carries an index
 * signature, which `noUncheckedIndexedAccess` widens to `unknown[] | undefined`.
 */
type Pools = Record<'User' | 'Todo' | 'Post' | 'Comment', Record<string, unknown>>;

const build = (options: BuildMocksOptions<Pools> = {}) =>
  buildMocks<Pools>(schema, { seed: 7, count: 3, ...options });

/** The error cases name types on purpose that `Pools` does not have, so they build untyped. */
const buildUntyped = (options: BuildMocksOptions = {}) =>
  buildMocks(schema, { seed: 7, ...options });

const TODOS = [
  { title: 'Write the RFC', priority: 'HIGH' },
  { title: 'Review the RFC', priority: 'MEDIUM' },
  { title: 'Ship it', priority: 'LOW' },
];

describe('fixtures', () => {
  it('makes the list the pool, when count says nothing about the type', () => {
    const mocks = buildMocks<Pools>(schema, { seed: 7, fixtures: { Todo: TODOS } });

    expect(mocks.Todo).toHaveLength(3);
    expect(mocks.Todo.map((todo) => todo.title)).toEqual(TODOS.map((todo) => todo.title));
    // Only the type the fixture names is resized; everything else keeps the default count.
    expect(mocks.User).toHaveLength(5);
  });

  it('generates the fields a row omits', () => {
    const mocks = build({ fixtures: { Todo: [{ title: 'Write the RFC' }] } });

    expect(mocks.Todo[0]?.title).toBe('Write the RFC');
    expect(typeof mocks.Todo[0]?.completed).toBe('boolean');
    expect(typeof mocks.Todo[0]?.createdAt).toBe('string');
  });

  it('cycles the rows when count asks for a bigger pool', () => {
    const mocks = build({ count: { Todo: 7 }, fixtures: { Todo: TODOS } });

    expect(mocks.Todo.map((todo) => todo.title)).toEqual([
      'Write the RFC',
      'Review the RFC',
      'Ship it',
      'Write the RFC',
      'Review the RFC',
      'Ship it',
      'Write the RFC',
    ]);
  });

  it('takes a count smaller than the list at its word', () => {
    const mocks = build({ count: { Todo: 2 }, fixtures: { Todo: TODOS } });

    expect(mocks.Todo.map((todo) => todo.title)).toEqual(['Write the RFC', 'Review the RFC']);
  });

  it('lets a flat count and a _default win over the list length', () => {
    expect(
      buildMocks<Pools>(schema, { seed: 7, count: 4, fixtures: { Todo: TODOS } }).Todo,
    ).toHaveLength(4);
    expect(
      buildMocks<Pools>(schema, { seed: 7, count: { _default: 4 }, fixtures: { Todo: TODOS } })
        .Todo,
    ).toHaveLength(4);
  });

  it('grows the pool when a relations size demands more than the list carries', () => {
    // No `count`, so the fixture length is the default the relation demand has to raise.
    const mocks = buildMocks<Pools>(schema, {
      seed: 7,
      fixtures: { Todo: TODOS },
      relations: { User: { todos: 5 } },
    });

    // Drawn without replacement, so the list can only be five long if the pool is.
    expect(mocks.Todo).toHaveLength(5);
    expect(mocks.User[0]?.todos).toHaveLength(5);
    expect(mocks.Todo[3]?.title).toBe('Write the RFC');
  });

  it('wires relationships to the fixture objects themselves', () => {
    const mocks = build({ fixtures: { Todo: TODOS } });
    const todos = mocks.User[0]?.todos as Record<string, unknown>[];

    for (const todo of todos) {
      expect(mocks.Todo).toContain(todo);
      expect(TODOS.map((row) => row.title)).toContain(todo.title);
    }
  });

  it('is not raised by a QA huge-list profile, which the named type outranks', () => {
    const mocks = build({ qa: 'hugeLists', fixtures: { Todo: TODOS } });

    expect(mocks.Todo).toHaveLength(3);
    expect(mocks.Todo[0]?.title).toBe('Write the RFC');
  });

  it('pins a field a QA corpus would otherwise rewrite', () => {
    const mocks = build({ qa: 'emptyText', fixtures: { Todo: [{ title: 'Write the RFC' }] } });

    expect(mocks.Todo[0]?.title).toBe('Write the RFC');
    expect(mocks.User[0]?.name).toBe('');
  });

  it('pins a nullable field a nulls profile would otherwise empty', () => {
    const mocks = build({ nullChance: 1, fixtures: { Todo: [{ dueDate: '2024-01-01' }] } });

    expect(mocks.Todo[0]?.dueDate).toBe('2024-01-01');
  });
});

describe('fixtures precedence', () => {
  it('loses to an overrides entry for the same field', () => {
    const mocks = build({
      fixtures: { Todo: TODOS },
      overrides: { Todo: { title: (_f, { index }) => `todo-${index}` } },
    });

    expect(mocks.Todo.map((todo) => todo.title)).toEqual(['todo-0', 'todo-1', 'todo-2']);
    // The fields the override does not name are still the fixture's.
    expect(mocks.Todo[0]?.priority).toBe('HIGH');
  });

  it('beats a fieldOverrides sweep, being the more specific statement', () => {
    const mocks = build({
      fixtures: { Todo: [{ title: 'Write the RFC' }] },
      fieldOverrides: { title: () => 'swept' },
    });

    expect(mocks.Todo[0]?.title).toBe('Write the RFC');
    // The sweep still reaches every other type carrying the field.
    expect(mocks.Post[0]?.title).toBe('swept');
  });

  it('loses to derive and deriveObject, which run over the finished object', () => {
    const mocks = build({
      fixtures: { Todo: [{ title: 'Write the RFC', completed: false }] },
      deriveObject: { Todo: () => ({ completed: true }) },
      derive: { Todo: { title: (self) => `${self.title as string}!` } },
    });

    expect(mocks.Todo[0]?.title).toBe('Write the RFC!');
    expect(mocks.Todo[0]?.completed).toBe(true);
  });

  it('keeps a pinned id out of stableIds reach', () => {
    const mocks = build({
      stableIds: true,
      fixtures: { Todo: [{ id: 'todo-usd' }, { id: 'todo-eur' }] },
    });

    // Three instances over two rows, so the third cycles back to the first row's id.
    expect(mocks.Todo.map((todo) => todo.id)).toEqual(['todo-usd', 'todo-eur', 'todo-usd']);
    // Untouched types still get their stable ids, and so do the fields the row leaves alone.
    expect(mocks.User[0]?.id).toBe('User-0');
  });

  it('keeps a pinned non-id identifier field out of stableIds reach', () => {
    const mocks = build({
      stableIds: { Post: ['slug'] },
      fixtures: { Post: [{ slug: 'hello-world' }] },
    });

    expect(mocks.Post[0]?.slug).toBe('hello-world');
    expect(mocks.Post[0]?.id).toBe('Post-0');
  });

  it('keeps a pinned count scalar out of the countFields pass', () => {
    const mocks = build({ countFields: true, fixtures: { Post: [{ viewCount: 42 }] } });

    expect(mocks.Post[0]?.viewCount).toBe(42);
  });

  it('takes a relationship field it pins, leaving phase 2 nothing to wire', () => {
    const pinned = { id: 'ghost', name: 'Ghost' };
    const mocks = build({ fixtures: { Todo: [{ user: pinned }, { title: 'wired' }] } });

    expect(mocks.Todo[0]?.user).toBe(pinned);
    // The row that says nothing about `user` is wired from the pool as usual.
    expect(mocks.User).toContain(mocks.Todo[1]?.user);
  });
});

describe('fixtures validation', () => {
  it('throws on an unknown type name', () => {
    expect(() => buildUntyped({ fixtures: { Currency: [{ code: 'USD' }] } })).toThrow(
      /unknown type "Currency"/,
    );
  });

  it('throws on a type that has no pool', () => {
    expect(() => buildUntyped({ fixtures: { Query: [{ user: null }] } })).toThrow(
      /"Query" has no pool to pin/,
    );
    expect(() => buildUntyped({ fixtures: { Node: [{ id: '1' }] } })).toThrow(
      /"Node" has no pool to pin/,
    );
  });

  it('throws on a key that is not a field on the type', () => {
    expect(() =>
      buildUntyped({ fixtures: { Todo: [{ title: 'ok' }, { titel: 'typo' }] } }),
    ).toThrow(/unknown field "Todo.titel" in row 1/);
  });

  it('throws on an empty list, pointing at count', () => {
    expect(() => buildUntyped({ fixtures: { Todo: [] } })).toThrow(/count: { Todo: 0 }/);
  });

  it('throws when the entry is not a list at all', () => {
    expect(() =>
      buildUntyped({
        fixtures: { Todo: { title: 'one' } } as unknown as BuildMocksOptions['fixtures'],
      }),
    ).toThrow(/expected a list of objects for "Todo"/);
  });

  it('throws on a row that is not an object', () => {
    const rows = [{ title: 'ok' }, 'Ship it'] as unknown as BuildMocksOptions['fixtures'];
    expect(() =>
      buildUntyped({ fixtures: { Todo: rows } as BuildMocksOptions['fixtures'] }),
    ).toThrow(/"Todo" row 1 is "Ship it"/);
  });

  it('ignores a type whose entry is undefined', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => buildUntyped({ fixtures: { Todo: undefined } })).not.toThrow();
    warn.mockRestore();
  });
});

describe('fixtures in scenario layers', () => {
  it("merges per type, a later layer replacing that type's whole list", () => {
    const merged = mergeScenarios([
      { fixtures: { Todo: TODOS, Post: [{ title: 'Hello' }] } },
      { fixtures: { Todo: [{ title: 'Only this' }] } },
    ]);

    expect(merged.fixtures).toEqual({
      Todo: [{ title: 'Only this' }],
      Post: [{ title: 'Hello' }],
    });
  });

  it('is applied through a scenario, with the build options winning', () => {
    const mocks = build({
      scenario: { fixtures: { Todo: TODOS } },
      fixtures: { Todo: [{ title: 'Ship it' }] },
    });

    expect(mocks.Todo.map((todo) => todo.title)).toEqual(['Ship it', 'Ship it', 'Ship it']);
  });
});
