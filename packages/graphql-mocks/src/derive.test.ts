import { faker } from '@faker-js/faker';
import { parse } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { buildGraph } from './graphBuilder.js';
import { mergeScenarios } from './scenarios.js';
import { schema } from './test/schema.js';

/** Cast past the untyped `MockResult` index signature — pools are `unknown[]` without `TTypes`. */
const rows = (pool: unknown): Record<string, unknown>[] => pool as Record<string, unknown>[];

describe('derive', () => {
  it('sees relationship fields, so a count agrees with the list it counts', () => {
    const mocks = buildGraph(schema, {
      faker,
      seed: 1,
      relations: { Post: { comments: 3 } },
      derive: { Post: { viewCount: (self) => (self.comments as unknown[]).length } },
    });
    for (const post of rows(mocks.Post)) {
      expect(post.viewCount).toBe(3);
      expect(post.viewCount).toBe((post.comments as unknown[]).length);
    }
  });

  it('assembles a field from its siblings', () => {
    const mocks = buildGraph(schema, {
      faker,
      seed: 2,
      overrides: { User: { name: () => 'placeholder' } },
      derive: { User: { name: (self) => `User ${String(self.id)} <${String(self.email)}>` } },
    });
    const user = rows(mocks.User)[0];
    expect(user?.name).toBe(`User ${String(user?.id)} <${String(user?.email)}>`);
  });

  it('wins over an overrides entry for the same field', () => {
    const mocks = buildGraph(schema, {
      faker,
      seed: 3,
      overrides: { User: { loginCount: () => 999 } },
      derive: { User: { loginCount: () => 7 } },
    });
    expect(rows(mocks.User).every((user) => user.loginCount === 7)).toBe(true);
  });

  it('runs derives in the order they are written, so one can read another', () => {
    const mocks = buildGraph(schema, {
      faker,
      seed: 4,
      derive: {
        User: {
          name: () => 'Ada',
          email: (self) => `${String(self.name).toLowerCase()}@example.com`,
        },
      },
    });
    expect(rows(mocks.User)[0]?.email).toBe('ada@example.com');
  });

  it('receives the instance index, the site, and the seeded faker', () => {
    const seen: { index: number; typeName: string; fieldName: string }[] = [];
    const mocks = buildGraph(schema, {
      faker,
      seed: 5,
      count: { User: 3 },
      derive: {
        User: {
          loginCount: (_self, ctx) => {
            seen.push({ index: ctx.index, typeName: ctx.typeName, fieldName: ctx.fieldName });
            return ctx.faker.number.int({ min: 100, max: 200 });
          },
        },
      },
    });
    expect(seen.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(seen[0]).toMatchObject({ typeName: 'User', fieldName: 'loginCount' });
    for (const user of rows(mocks.User)) {
      expect(user.loginCount).toBeGreaterThanOrEqual(100);
      expect(user.loginCount).toBeLessThanOrEqual(200);
    }
  });

  it('stays deterministic under seed when it draws from ctx.faker', () => {
    const build = () =>
      buildGraph(schema, {
        faker,
        seed: 6,
        derive: { User: { name: (_self, { faker: f }) => f.person.fullName() } },
      });
    expect(rows(build().User).map((user) => user.name)).toEqual(
      rows(build().User).map((user) => user.name),
    );
  });

  it('sees reciprocal back-references, because it runs after they are wired', () => {
    // Phase 2 points every todo at the *second* user; phase 3 mirrors User[0]'s list back over
    // it. A derive reading the first user is therefore only possible after the mirroring.
    const mocks = buildGraph(schema, {
      faker,
      seed: 7,
      count: { User: 2, Todo: 2 },
      relations: {
        _reciprocal: true,
        User: { todos: ({ pool, index }) => (index === 0 ? pool : []) },
        Todo: { user: ({ pool }) => pool[1] },
      },
      derive: { Todo: { title: (self) => `todo for ${String((self.user as { id: string }).id)}` } },
    });
    const first = rows(mocks.User)[0];
    for (const todo of rows(mocks.Todo)) {
      expect(todo.user).toBe(first);
      expect(todo.title).toBe(`todo for ${String(first?.id)}`);
    }
  });

  it('reaches every operation result, since operations draw from the pool', () => {
    const mocks = buildGraph(schema, {
      faker,
      seed: 8,
      derive: { User: { name: () => 'Derived' } },
    });
    const data = mocks.dataForOperation(parse('query { user(id: "1") { name } }')) as {
      user: { name: string };
    };
    expect(data.user.name).toBe('Derived');
  });

  it('warns about a type that has no pool', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildGraph(schema, { faker, seed: 9, derive: { Userr: { name: () => 'x' } } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown type "Userr"'));
    warn.mockRestore();
  });

  it('warns about a field the type does not declare, but still writes it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mocks = buildGraph(schema, {
      faker,
      seed: 10,
      derive: { User: { nickname: () => 'Ace' } },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"User.nickname" is not a field'));
    expect(rows(mocks.User)[0]?.nickname).toBe('Ace');
    warn.mockRestore();
  });

  it('ignores a non-function entry rather than calling it', () => {
    const mocks = buildGraph(schema, {
      faker,
      seed: 11,
      derive: { User: { name: 'Ada' as unknown as () => string } },
    });
    expect(rows(mocks.User)[0]?.name).not.toBe('Ada');
  });

  it('changes nothing when the option is absent', () => {
    const withOption = buildGraph(schema, { faker, seed: 12, derive: {} });
    const without = buildGraph(schema, { faker, seed: 12 });
    expect(rows(withOption.User).map((user) => user.id)).toEqual(
      rows(without.User).map((user) => user.id),
    );
  });

  it('merges per type and per field across scenario layers', () => {
    const name = () => 'Ada';
    expect(
      mergeScenarios([
        { derive: { User: { name, loginCount: () => 1 } } },
        { derive: { User: { loginCount: () => 2 }, Post: { viewCount: () => 3 } } },
      ]).derive,
    ).toEqual({
      User: { name, loginCount: expect.any(Function) },
      Post: { viewCount: expect.any(Function) },
    });
  });

  it('lets build options override a scenario layer field by field', () => {
    const mocks = buildGraph(schema, {
      faker,
      seed: 13,
      scenario: { derive: { User: { name: () => 'from scenario', loginCount: () => 1 } } },
      derive: { User: { name: () => 'from options' } },
    });
    const user = rows(mocks.User)[0];
    expect(user?.name).toBe('from options');
    expect(user?.loginCount).toBe(1);
  });
});
