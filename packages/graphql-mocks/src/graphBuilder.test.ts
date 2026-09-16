import { faker } from '@faker-js/faker';
import { buildSchema } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { buildGraph } from './graphBuilder.js';
import { schema } from './test/schema.js';

describe('buildGraph', () => {
  it('returns pools for all non-operation types', () => {
    const result = buildGraph(schema, { faker, seed: 1 });
    expect(Array.isArray(result.User)).toBe(true);
    expect(Array.isArray(result.Todo)).toBe(true);
    expect(Array.isArray(result.Post)).toBe(true);
    expect(Array.isArray(result.Comment)).toBe(true);
    // Operation types should NOT be in the pool
    expect(result.Query).toBeUndefined();
  });

  it('generates the default count (5) per type', () => {
    const result = buildGraph(schema, { faker, seed: 1 });
    expect(result.User?.length).toBe(5);
    expect(result.Todo?.length).toBe(5);
  });

  it('respects flat count option', () => {
    const result = buildGraph(schema, { faker, seed: 1, count: 3 });
    expect(result.User?.length).toBe(3);
    expect(result.Todo?.length).toBe(3);
  });

  it('respects per-type count config', () => {
    const result = buildGraph(schema, {
      faker,
      seed: 1,
      count: { User: 10, Todo: 20, _default: 2 },
    });
    expect(result.User?.length).toBe(10);
    expect(result.Todo?.length).toBe(20);
    expect(result.Post?.length).toBe(2);
  });

  it('populates scalar fields on each object', () => {
    const result = buildGraph(schema, { faker, seed: 1 });
    const user = result.User?.[0] as Record<string, unknown>;
    expect(typeof user.id).toBe('string');
    expect(typeof user.name).toBe('string');
    expect(typeof user.isActive).toBe('boolean');
    expect(typeof user.loginCount).toBe('number');
  });

  it('wires relationship fields to pool objects (shared pool)', () => {
    const result = buildGraph(schema, { faker, seed: 1 });
    const todo = result.Todo?.[0] as Record<string, unknown>;

    // Todo.user should be one of the User pool objects
    expect(todo.user).toBeDefined();
    expect(todo.user).not.toBeNull();
    expect(result.User).toContain(todo.user);
  });

  it('wires list relationship fields to subset of pool objects', () => {
    const result = buildGraph(schema, { faker, seed: 1 });
    const user = result.User?.[0] as Record<string, unknown>;

    expect(Array.isArray(user.todos)).toBe(true);
    const todos = user.todos as unknown[];
    for (const todo of todos) {
      expect(result.Todo).toContain(todo);
    }
  });

  it('produces deterministic output with same seed', () => {
    const r1 = buildGraph(schema, { faker, seed: 42 });
    const r2 = buildGraph(schema, { faker, seed: 42 });
    const u1 = r1.User?.[0] as Record<string, unknown>;
    const u2 = r2.User?.[0] as Record<string, unknown>;
    expect(u1.id).toEqual(u2.id);
    expect(u1.name).toEqual(u2.name);
  });

  it('sets nullable fields to null when nullChance = 1', () => {
    const result = buildGraph(schema, { faker, seed: 1, nullChance: 1 });
    const user = result.User?.[0] as Record<string, unknown>;
    // score is Float (nullable), city is CityName (nullable), website is URL (nullable)
    expect(user.score).toBeNull();
    expect(user.city).toBeNull();
  });

  it('applies field overrides', () => {
    const result = buildGraph(schema, {
      faker,
      seed: 1,
      overrides: {
        User: { name: () => 'OverriddenName' },
      },
    });
    for (const user of (result.User ?? []) as Record<string, unknown>[]) {
      expect(user.name).toBe('OverriddenName');
    }
  });

  it('warns and sets null for abstract types without resolveType', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const abstractSchema = buildSchema(`
      interface Node { id: ID! }
      type Foo { id: ID!, node: Node }
      type Bar implements Node { id: ID!, label: String! }
    `);
    const result = buildGraph(abstractSchema, { faker, seed: 1 });
    const foo = result.Foo?.[0] as Record<string, unknown>;
    expect(foo.node).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('nulls nullable relationship fields when nullChance = 1', () => {
    // Schema with a nullable object field (not [T!]!)
    const s = buildSchema(`
      type Owner { id: ID!, name: String! }
      type Pet { id: ID!, name: String!, owner: Owner }
      type Query { pets: [Pet!]! }
    `);
    const result = buildGraph(s, { faker, seed: 1, nullChance: 1 });
    const pet = result.Pet?.[0] as Record<string, unknown>;
    // owner is nullable → should be null with nullChance 1
    expect(pet.owner).toBeNull();
  });

  it('handles empty related type pool gracefully (isList: true)', () => {
    // If a related type has count:0, list fields should be []
    const s = buildSchema(`
      type Leaf { id: ID!, label: String! }
      type Parent { id: ID!, children: [Leaf!]! }
      type Query { parents: [Parent!]! }
    `);
    const result = buildGraph(s, { faker, seed: 1, count: { Leaf: 0, _default: 2 } });
    const parent = result.Parent?.[0] as Record<string, unknown>;
    expect(Array.isArray(parent.children)).toBe(true);
    expect((parent.children as unknown[]).length).toBe(0);
  });

  it('handles empty related type pool gracefully (isList: false)', () => {
    // Nullable singular relationship to an empty pool → null
    const s = buildSchema(`
      type Leaf { id: ID!, label: String! }
      type Parent { id: ID!, child: Leaf }
      type Query { parents: [Parent!]! }
    `);
    const result = buildGraph(s, { faker, seed: 1, count: { Leaf: 0, _default: 2 } });
    const parent = result.Parent?.[0] as Record<string, unknown>;
    expect(parent.child).toBeNull();
  });

  it('toResolvers() returns items from the pool', () => {
    const result = buildGraph(schema, { faker, seed: 42 });
    const resolvers = result.toResolvers();
    expect(result.User).toContain(resolvers.User?.());
    expect(result.Todo).toContain(resolvers.Todo?.());
    expect(result.Post).toContain(resolvers.Post?.());
  });

  it('uses resolveType to wire abstract type fields', () => {
    const abstractSchema = buildSchema(`
      interface Node { id: ID! }
      type Foo { id: ID!, node: Node! }
      type Bar implements Node { id: ID!, label: String! }
    `);
    const result = buildGraph(abstractSchema, {
      faker,
      seed: 1,
      resolveType: () => 'Bar',
    });
    const foo = result.Foo?.[0] as Record<string, unknown>;
    expect(result.Bar).toContain(foo.node);
  });

  it('uses resolveType to wire abstract list type fields', () => {
    const s = buildSchema(`
      interface Node { id: ID! }
      type Foo { id: ID!, nodes: [Node!]! }
      type Bar implements Node { id: ID!, label: String! }
    `);
    const result = buildGraph(s, { faker, seed: 1, resolveType: () => 'Bar' });
    const foo = result.Foo?.[0] as Record<string, unknown>;
    expect(Array.isArray(foo.nodes)).toBe(true);
    for (const node of foo.nodes as unknown[]) {
      expect(result.Bar).toContain(node);
    }
  });

  it('warns when resolveType returns an unknown type name', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = buildSchema(`
      interface Node { id: ID! }
      type Foo { id: ID!, node: Node }
      type Bar implements Node { id: ID!, label: String! }
    `);
    const result = buildGraph(s, { faker, seed: 1, resolveType: () => 'NonExistent' });
    const foo = result.Foo?.[0] as Record<string, unknown>;
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('NonExistent'));
    // Null, not undefined: an empty pool resolves the same way for abstract and object
    // fields, and `undefined` is not a value GraphQL can serialize.
    expect(foo.node).toBeNull();
    warnSpy.mockRestore();
  });

  it('applies field overrides to relationship fields', () => {
    const customUser = { id: 'custom', name: 'Custom' };
    const result = buildGraph(schema, {
      faker,
      seed: 1,
      overrides: { Todo: { user: () => customUser } },
    });
    for (const todo of (result.Todo ?? []) as Record<string, unknown>[]) {
      expect(todo.user).toBe(customUser);
    }
  });

  it('adds __typename by default', () => {
    const result = buildGraph(schema, { faker, seed: 1 });
    for (const user of (result.User ?? []) as Record<string, unknown>[]) {
      expect(user.__typename).toBe('User');
    }
  });

  it('omits __typename when addTypename is false', () => {
    const result = buildGraph(schema, { faker, seed: 1, addTypename: false });
    for (const user of (result.User ?? []) as Record<string, unknown>[]) {
      expect('__typename' in user).toBe(false);
    }
  });

  it('assigns stable TypeName-<index> ids when stableIds is on', () => {
    const result = buildGraph(schema, { faker, seed: 1, stableIds: true });
    const users = (result.User ?? []) as Record<string, unknown>[];
    users.forEach((user, index) => {
      expect(user.id).toBe(`User-${index}`);
    });
  });

  it('lets an explicit id override win over stableIds', () => {
    const result = buildGraph(schema, {
      faker,
      seed: 1,
      stableIds: true,
      overrides: { User: { id: () => 'fixed-id' } },
    });
    for (const user of (result.User ?? []) as Record<string, unknown>[]) {
      expect(user.id).toBe('fixed-id');
    }
  });

  it('passes the seeded faker to override functions', () => {
    const seen: unknown[] = [];
    buildGraph(schema, {
      faker,
      seed: 1,
      overrides: { User: { name: (f) => f.person.firstName() } },
    });
    const a = buildGraph(schema, {
      faker,
      seed: 99,
      overrides: { User: { name: (f) => seen.push(f) && f.person.firstName() } },
    });
    // The override receives a faker instance (not undefined) and produces a string.
    expect(seen.length).toBeGreaterThan(0);
    for (const user of (a.User ?? []) as Record<string, unknown>[]) {
      expect(typeof user.name).toBe('string');
    }
  });

  it('numbers override context by the instance index, matching stableIds', () => {
    const result = buildGraph(schema, {
      faker,
      seed: 1,
      count: 3,
      stableIds: true,
      overrides: {
        User: { loginCount: (f, { index }) => (index === 0 ? 0 : f.number.int(500)) },
      },
    });
    const users = (result.User ?? []) as Record<string, unknown>[];
    expect(users.map((u) => u.id)).toEqual(['User-0', 'User-1', 'User-2']);
    expect(users[0]?.loginCount).toBe(0);
    expect(users[1]?.loginCount).not.toBe(0);
  });
});
