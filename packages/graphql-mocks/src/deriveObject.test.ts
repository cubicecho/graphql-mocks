import { faker } from '@faker-js/faker';
import { buildSchema } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { buildGraph } from './graphBuilder.js';
import { mergeScenarios } from './scenarios.js';
import { schema } from './test/schema.js';

/** Cast past the untyped `MockResult` index signature — pools are `unknown[]` without `TTypes`. */
const rows = (pool: unknown): Record<string, unknown>[] => pool as Record<string, unknown>[];

/**
 * The case the option exists for: three numbers that have to add up. The shared test schema has
 * no such type, and a money-shaped one reads the way the report of this does.
 */
const orderSchema = buildSchema(`
  type Order {
    id: ID!
    subtotal: Float!
    tax: Float!
    total: Float!
    note: String
  }

  type Query {
    order(id: ID!): Order
  }
`);

/** One correlated draw: every number below comes from the same `subtotal`. */
const orderTotals = (_self: Record<string, unknown>, ctx: { faker: typeof faker }) => {
  const subtotal = ctx.faker.number.float({ min: 10, max: 500, fractionDigits: 2 });
  const tax = Number((subtotal * 0.08).toFixed(2));
  return { subtotal, tax, total: Number((subtotal + tax).toFixed(2)) };
};

describe('deriveObject', () => {
  it('correlates the fields of one draw on every pooled instance', () => {
    const mocks = buildGraph(orderSchema, {
      faker,
      seed: 1,
      count: 10,
      deriveObject: { Order: orderTotals },
    });

    const orders = rows(mocks.Order);
    expect(orders).toHaveLength(10);
    for (const order of orders) {
      const { subtotal, tax, total } = order as { subtotal: number; tax: number; total: number };
      expect(tax).toBeCloseTo(subtotal * 0.08, 2);
      expect(total).toBeCloseTo(subtotal + tax, 2);
    }
    // Correlated, not constant — a single draw reused for every instance would pass the above.
    expect(new Set(orders.map((order) => order.subtotal)).size).toBeGreaterThan(1);
  });

  it('leaves the fields it does not return as generated', () => {
    const derived = buildGraph(orderSchema, {
      faker,
      seed: 2,
      deriveObject: { Order: orderTotals },
    });
    const plain = buildGraph(orderSchema, { faker, seed: 2 });

    // `id` and `note` were generated before the derive ran and it named neither, so they still
    // match a build without the option; only the three correlated fields moved.
    expect(rows(derived.Order).map((order) => order.id)).toEqual(
      rows(plain.Order).map((order) => order.id),
    );
    expect(rows(derived.Order).map((order) => order.note)).toEqual(
      rows(plain.Order).map((order) => order.note),
    );
    expect(rows(derived.Order)[0]?.subtotal).not.toBe(rows(plain.Order)[0]?.subtotal);
  });

  it('stays deterministic under seed', () => {
    const build = () =>
      rows(
        buildGraph(orderSchema, { faker, seed: 3, count: 4, deriveObject: { Order: orderTotals } })
          .Order,
      ).map((order) => order.total);

    expect(build()).toEqual(build());
  });

  it('receives the instance index, the type name and the seeded faker', () => {
    const seen: { index: number; typeName: string }[] = [];
    buildGraph(schema, {
      faker,
      seed: 4,
      count: { User: 3 },
      deriveObject: {
        User: (_self, ctx) => {
          seen.push({ index: ctx.index, typeName: ctx.typeName });
          return { loginCount: ctx.faker.number.int({ min: 1, max: 9 }) };
        },
      },
    });

    expect(seen).toEqual([
      { index: 0, typeName: 'User' },
      { index: 1, typeName: 'User' },
      { index: 2, typeName: 'User' },
    ]);
  });

  it('sees the finished object, relationships and all', () => {
    const mocks = buildGraph(schema, {
      faker,
      seed: 5,
      count: { User: 1, Todo: 2 },
      relations: { _reciprocal: true, User: { todos: 'all' } },
      deriveObject: {
        User: (self) => ({ loginCount: (self.todos as unknown[]).length }),
        Todo: (self) => ({ title: `todo for ${String((self.user as { id: string }).id)}` }),
      },
    });

    const user = rows(mocks.User)[0];
    expect(user?.loginCount).toBe(2);
    for (const todo of rows(mocks.Todo)) {
      expect(todo.title).toBe(`todo for ${String(user?.id)}`);
    }
  });

  it('wins over an overrides entry for the same field', () => {
    const mocks = buildGraph(schema, {
      faker,
      seed: 6,
      overrides: { User: { loginCount: () => 999 } },
      deriveObject: { User: () => ({ loginCount: 7 }) },
    });

    expect(rows(mocks.User).every((user) => user.loginCount === 7)).toBe(true);
  });

  it('runs before a field derive, which wins on a key both write', () => {
    const mocks = buildGraph(schema, {
      faker,
      seed: 7,
      deriveObject: { User: () => ({ name: 'from deriveObject', loginCount: 3 }) },
      derive: { User: { name: (self) => `${String(self.loginCount)} logins` } },
    });

    const user = rows(mocks.User)[0];
    // The field derive both overwrote `name` and read the object derive's `loginCount` off
    // `self`, which is only possible if the object derive ran first.
    expect(user?.name).toBe('3 logins');
    expect(user?.loginCount).toBe(3);
  });

  it('reaches every operation result, since operations draw from the pool', () => {
    const mocks = buildGraph(schema, {
      faker,
      seed: 8,
      deriveObject: { User: () => ({ name: 'Derived' }) },
    });

    expect(rows(mocks.User).every((user) => user.name === 'Derived')).toBe(true);
  });

  it('leaves the instance untouched when it returns nothing', () => {
    const withOption = buildGraph(schema, {
      faker,
      seed: 9,
      deriveObject: { User: () => undefined as unknown as Record<string, unknown> },
    });
    const without = buildGraph(schema, { faker, seed: 9 });

    expect(rows(withOption.User).map((user) => user.name)).toEqual(
      rows(without.User).map((user) => user.name),
    );
  });

  it('warns once about a value it cannot merge', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildGraph(schema, {
      faker,
      seed: 10,
      count: { User: 3 },
      deriveObject: { User: () => 42 as unknown as Record<string, unknown> },
    });

    const merges = warn.mock.calls.filter((call) => String(call[0]).includes('deriveObject'));
    expect(merges).toHaveLength(1);
    expect(String(merges[0]?.[0])).toContain('"User" returned a number');
    warn.mockRestore();
  });

  it('warns once about an array, which would merge as index keys', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mocks = buildGraph(schema, {
      faker,
      seed: 11,
      deriveObject: { User: () => ['a'] as unknown as Record<string, unknown> },
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"User" returned an array'));
    expect(rows(mocks.User)[0]?.['0']).toBeUndefined();
    warn.mockRestore();
  });

  it('warns once about a key the type does not declare, but still writes it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mocks = buildGraph(schema, {
      faker,
      seed: 12,
      count: { User: 3 },
      deriveObject: { User: () => ({ nickname: 'Ace' }) },
    });

    const unknownKey = warn.mock.calls.filter((call) =>
      String(call[0]).includes('"User.nickname" is not a field'),
    );
    expect(unknownKey).toHaveLength(1);
    expect(rows(mocks.User).every((user) => user.nickname === 'Ace')).toBe(true);
    warn.mockRestore();
  });

  it('warns about a type that has no pool', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildGraph(schema, { faker, seed: 13, deriveObject: { Userr: () => ({ name: 'x' }) } });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown type "Userr"'));
    warn.mockRestore();
  });

  it('ignores a non-function entry rather than calling it', () => {
    const mocks = buildGraph(schema, {
      faker,
      seed: 14,
      deriveObject: { User: 'Ada' as unknown as () => Record<string, unknown> },
    });

    expect(rows(mocks.User)[0]?.name).not.toBe('Ada');
  });

  it('changes nothing when the option is absent', () => {
    const withOption = buildGraph(schema, { faker, seed: 15, deriveObject: {} });
    const without = buildGraph(schema, { faker, seed: 15 });

    expect(rows(withOption.User).map((user) => user.id)).toEqual(
      rows(without.User).map((user) => user.id),
    );
  });

  it('merges per type across scenario layers, last one winning', () => {
    const order = () => ({ total: 1 });
    expect(
      mergeScenarios([
        { deriveObject: { Order: () => ({ total: 0 }), User: order } },
        { deriveObject: { Order: () => ({ total: 2 }) } },
      ]).deriveObject,
    ).toEqual({ Order: expect.any(Function), User: order });
  });

  it('lets build options override a scenario layer type by type', () => {
    const mocks = buildGraph(schema, {
      faker,
      seed: 16,
      scenario: {
        deriveObject: {
          User: () => ({ name: 'from scenario' }),
          Post: () => ({ title: 'from scenario' }),
        },
      },
      deriveObject: { User: () => ({ name: 'from options' }) },
    });

    expect(rows(mocks.User)[0]?.name).toBe('from options');
    expect(rows(mocks.Post)[0]?.title).toBe('from scenario');
  });
});
