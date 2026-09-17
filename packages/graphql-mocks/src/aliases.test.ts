import { parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildMocks } from './mockSchema.js';
import { select } from './plain.js';
import { schema } from './test/schema.js';
import type { BuildMocksOptions } from './types.js';

/**
 * The pools these tests read from. Naming them keeps `mocks.User[0]` typed: the bare
 * `MockResult` only carries an index signature, which `noUncheckedIndexedAccess` widens to
 * `unknown[] | undefined`.
 */
type Pools = Record<'User' | 'Todo' | 'Post' | 'Comment', Record<string, unknown>>;

const build = (options: BuildMocksOptions<Pools> = {}) =>
  buildMocks<Pools>(schema, { seed: 7, count: 3, stableIds: true, ...options });

/** The error cases name types on purpose that `Pools` does not have, so they build untyped. */
const buildUntyped = (options: BuildMocksOptions = {}) =>
  buildMocks(schema, { seed: 7, count: 3, stableIds: true, ...options });

describe('aliases', () => {
  it('exposes the field under its alias on every instance of the type', () => {
    const mocks = build({ aliases: { User: { todos: 'tasks' } } });

    for (const user of mocks.User) {
      expect(user.tasks).toEqual(user.todos);
    }
  });

  it('aliases the same reference, not a clone', () => {
    const mocks = build({ aliases: { User: { todos: 'tasks' }, Todo: { user: 'owner' } } });
    const user = mocks.User[0] as Record<string, unknown>;

    expect(user.tasks).toBe(user.todos);
    expect((mocks.Todo[0] as Record<string, unknown>).owner).toBe(mocks.Todo[0]?.user);
  });

  it('aliases scalars as readily as relationships', () => {
    const mocks = build({ aliases: { Post: { title: 'headline', slug: 'permalink' } } });

    expect(mocks.Post[0]?.headline).toBe(mocks.Post[0]?.title);
    expect(mocks.Post[0]?.permalink).toBe(mocks.Post[0]?.slug);
  });

  it('takes several names for one field', () => {
    const mocks = build({ aliases: { Post: { comments: ['replies', 'discussion'] } } });

    expect(mocks.Post[0]?.replies).toBe(mocks.Post[0]?.comments);
    expect(mocks.Post[0]?.discussion).toBe(mocks.Post[0]?.comments);
  });

  it('leaves types it does not name alone', () => {
    const mocks = build({ aliases: { User: { todos: 'tasks' } } });

    expect(mocks.Todo[0]).not.toHaveProperty('tasks');
  });

  it('carries the finished value, after counts and derives have run', () => {
    const mocks = build({
      relations: { User: { todos: 2 } },
      derive: { User: { name: () => 'DERIVED' } },
      aliases: { User: { name: 'displayName', todos: 'tasks' } },
    });

    expect(mocks.User[0]?.displayName).toBe('DERIVED');
    expect(mocks.User[0]?.tasks).toHaveLength(2);
  });

  it('answers the aliased selection a fragment asks for', () => {
    const mocks = build({ aliases: { User: { todos: 'tasks' } } });
    const fragment = parse('fragment UserCard on User { id tasks { id title } }');

    const card = select<{ id: string; tasks: { id: string }[] }>(mocks.User[0], fragment);
    expect(card.tasks).toHaveLength((mocks.User[0]?.todos as unknown[]).length);
  });

  it('merges per type and per field across a scenario', () => {
    const mocks = build({
      scenario: { aliases: { User: { todos: 'tasks' }, Post: { title: 'headline' } } },
      aliases: { User: { email: 'contact' } },
    });

    expect(mocks.User[0]?.tasks).toBe(mocks.User[0]?.todos);
    expect(mocks.User[0]?.contact).toBe(mocks.User[0]?.email);
    expect(mocks.Post[0]?.headline).toBe(mocks.Post[0]?.title);
  });
});

describe('an aliases config error', () => {
  it('throws for a type the schema does not have', () => {
    expect(() => buildUntyped({ aliases: { Userr: { todos: 'tasks' } } })).toThrow(
      /unknown type "Userr"/,
    );
  });

  it('throws for a field the type does not have, naming which side is which', () => {
    expect(() => buildUntyped({ aliases: { User: { todoss: 'tasks' } } })).toThrow(
      /unknown field "User.todoss" — the key is the field being aliased/,
    );
  });

  it('throws for a root type, which has no pooled instances', () => {
    expect(() => buildUntyped({ aliases: { Query: { users: 'people' } } })).toThrow(
      /"Query" is an operation type/,
    );
  });

  it('throws for a type that is not an object type', () => {
    expect(() => buildUntyped({ aliases: { Node: { id: 'key' } } })).toThrow(
      /"Node" is not an object type/,
    );
  });

  it('throws when the alias would land on a real field', () => {
    expect(() => buildUntyped({ aliases: { User: { name: 'email' } } })).toThrow(
      /"User.email" is already a field on that type/,
    );
  });

  it('throws before anything is generated', () => {
    let overrideRan = false;
    expect(() =>
      buildUntyped({
        overrides: {
          User: {
            name: () => {
              overrideRan = true;
              return 'x';
            },
          },
        },
        aliases: { Userr: { todos: 'tasks' } },
      }),
    ).toThrow();
    expect(overrideRan).toBe(false);
  });
});
