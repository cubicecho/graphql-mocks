import { Kind, parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildMocks } from './mockSchema.js';
import { select, toPlain } from './plain.js';
import { schema } from './test/schema.js';

/** A minimal two-object cycle, the shape `_reciprocal` produces. */
function cyclicPair() {
  const user: Record<string, unknown> = { __typename: 'User', id: 'User-0', name: 'Ada' };
  const todo: Record<string, unknown> = { __typename: 'Todo', id: 'Todo-0', title: 'write', user };
  user.todos = [todo];
  return { user, todo };
}

describe('toPlain', () => {
  it('cuts a cycle so the result serializes', () => {
    const { user } = cyclicPair();
    expect(() => JSON.stringify(user)).toThrow(TypeError);
    expect(() => JSON.stringify(toPlain(user))).not.toThrow();
  });

  it('replaces a cycle with a __typename/id stub by default', () => {
    const { user } = cyclicPair();
    const plain = toPlain(user) as { todos: { user: unknown }[] };
    expect(plain.todos[0]?.user).toEqual({ __typename: 'User', id: 'User-0' });
  });

  it('stubs to null when the cut object has neither __typename nor id', () => {
    const node: Record<string, unknown> = { label: 'root' };
    node.self = node;
    expect(toPlain(node)).toEqual({ label: 'root', self: null });
  });

  it('nulls a cycle on request', () => {
    const { user } = cyclicPair();
    const plain = toPlain(user, { onCycle: 'null' }) as { todos: { user: unknown }[] };
    expect(plain.todos[0]?.user).toBeNull();
  });

  it('omits a cyclic property on request', () => {
    const { user } = cyclicPair();
    const plain = toPlain(user, { onCycle: 'omit' }) as { todos: Record<string, unknown>[] };
    expect(plain.todos[0]).not.toHaveProperty('user');
    expect(plain.todos[0]).toHaveProperty('title', 'write');
  });

  it('nulls an omitted array entry rather than shifting the indices', () => {
    const list: unknown[] = [{ a: 1 }];
    list.push(list);
    const plain = toPlain({ list }, { onCycle: 'omit' }) as { list: unknown[] };
    expect(plain.list).toHaveLength(2);
    expect(plain.list[1]).toBeNull();
  });

  it('copies a repeated but non-cyclic reference in full', () => {
    const shared = { __typename: 'Tag', id: 'Tag-0' };
    const plain = toPlain({ a: shared, b: shared }) as { a: unknown; b: unknown };
    expect(plain.a).toEqual(shared);
    expect(plain.b).toEqual(shared);
    expect(plain.a).not.toBe(plain.b);
  });

  it('deep-copies rather than aliasing the source', () => {
    const source = { nested: { n: 1 }, list: [{ n: 2 }] };
    const plain = toPlain(source) as typeof source;
    expect(plain).toEqual(source);
    expect(plain.nested).not.toBe(source.nested);
    expect(plain.list[0]).not.toBe(source.list[0]);
  });

  it('cuts at maxDepth with the same strategy as a cycle', () => {
    const source = { a: { b: { __typename: 'Deep', id: '1', c: 2 } } };
    expect(toPlain(source, { maxDepth: 2 })).toEqual({ a: { b: { __typename: 'Deep', id: '1' } } });
    expect(toPlain(source, { maxDepth: 2, onCycle: 'null' })).toEqual({ a: { b: null } });
  });

  it('passes non-plain values through by reference', () => {
    const date = new Date(0);
    const plain = toPlain({ date, n: 1, s: 'x', nil: null }) as Record<string, unknown>;
    expect(plain.date).toBe(date);
    expect(plain).toMatchObject({ n: 1, s: 'x', nil: null });
  });

  it('handles a self-referential array at the root', () => {
    const list: unknown[] = [1];
    list.push(list);
    expect(toPlain(list)).toEqual([1, null]);
  });

  it('makes a reciprocally wired graph serializable', () => {
    const mocks = buildMocks(schema, {
      seed: 3,
      count: 4,
      stableIds: true,
      relations: { _reciprocal: true },
    });
    expect(() => JSON.stringify(mocks.at('User', 0))).toThrow();
    expect(() => JSON.stringify(toPlain(mocks.at('User', 0)))).not.toThrow();
  });
});

describe('select', () => {
  const { user } = cyclicPair();

  it('nulls a field the value does not carry', () => {
    const document = parse('query U { missing { id } }');
    expect(select(user, document)).toEqual({ missing: null });
  });

  it('follows the selection set from the value itself', () => {
    const document = parse('query U { id name todos { id title } }');
    expect(select(user, document)).toEqual({
      id: 'User-0',
      name: 'Ada',
      todos: [{ id: 'Todo-0', title: 'write' }],
    });
  });

  it('honors aliases', () => {
    const document = parse('query U { who: name }');
    expect(select(user, document)).toEqual({ who: 'Ada' });
  });

  it('includes __typename when asked for', () => {
    const document = parse('query U { __typename id }');
    expect(select(user, document)).toEqual({ __typename: 'User', id: 'User-0' });
  });

  it('expands a named fragment', () => {
    const document = parse('query U { ...Row } fragment Row on User { id name }');
    expect(select(user, document)).toEqual({ id: 'User-0', name: 'Ada' });
  });

  it('projects a bare fragment document', () => {
    const document = parse('fragment Row on User { id name }');
    expect(select(user, document)).toEqual({ id: 'User-0', name: 'Ada' });
  });

  it('applies an inline fragment whose condition matches __typename', () => {
    const document = parse('query U { id ... on User { name } ... on Todo { title } }');
    expect(select(user, document)).toEqual({ id: 'User-0', name: 'Ada' });
  });

  it('resolves an abstract type condition when given the schema', () => {
    const document = parse('query S { ... on SearchResult { id } }');
    expect(select(user, document, { schema })).toEqual({ id: 'User-0' });
    // Without the schema there is no way to know `SearchResult` covers `User`.
    expect(select(user, document)).toEqual({});
  });

  it('skips a fragment whose concrete condition does not match', () => {
    const document = parse('query S { id ... on Todo { title } }');
    expect(select(user, document, { schema })).toEqual({ id: 'User-0' });
  });

  it('takes the fields when the value carries no __typename', () => {
    const document = parse('query U { ... on Whatever { id } }');
    expect(select({ id: 7 }, document)).toEqual({ id: 7 });
  });

  it('picks an operation by name', () => {
    const document = parse('query A { id } query B { name }');
    expect(select(user, document, { operationName: 'B' })).toEqual({ name: 'Ada' });
  });

  it('maps over a list value', () => {
    const document = parse('query T { id }');
    expect(select([user, user], document)).toEqual([{ id: 'User-0' }, { id: 'User-0' }]);
  });

  it('keeps null and scalar sources as they are', () => {
    const document = parse('query T { id }');
    expect(select(null, document)).toBeNull();
    expect(select(undefined, document)).toBeNull();
    expect(select(7, document)).toBe(7);
  });

  it('throws when the document has nothing to project against', () => {
    expect(() => select(user, parse('query A { id }'), { operationName: 'Nope' })).toThrow(
      /no operation/,
    );
    expect(() => select(user, { kind: Kind.DOCUMENT, definitions: [] })).toThrow(/no operation/);
  });

  it('throws when a spread names a fragment the document does not define', () => {
    expect(() => select(user, parse('query A { ...Missing }'))).toThrow(/does not define/);
  });

  it('shapes real graph data to a query', () => {
    const mocks = buildMocks(schema, { seed: 5, count: 3, stableIds: true });
    const document = parse('query U { id name todos { id title } }');
    const projected = select(mocks.at('User', 0), document) as Record<string, unknown>;
    expect(Object.keys(projected).sort()).toEqual(['id', 'name', 'todos']);
    expect(() => JSON.stringify(projected)).not.toThrow();
  });
});

describe('relations: { _reciprocal: "hidden" }', () => {
  const hidden = () =>
    buildMocks(schema, {
      seed: 7,
      count: 4,
      stableIds: true,
      relations: { _reciprocal: 'hidden' },
    });

  it('still wires the back-reference', () => {
    const mocks = hidden();
    const user = mocks.at('User', 0) as { todos: { user: unknown }[] };
    expect(user.todos[0]?.user).toBeDefined();
  });

  it('keeps the mirrored field out of enumeration', () => {
    const mocks = hidden();
    const user = mocks.at('User', 0) as { todos: Record<string, unknown>[] };
    const todo = user.todos[0];
    if (!todo) throw new Error('expected a wired todo');
    expect(Object.keys(todo)).not.toContain('user');
    expect(JSON.parse(JSON.stringify(todo))).not.toHaveProperty('user');
  });

  it('leaves the reference enumerable under plain `true`', () => {
    const mocks = buildMocks(schema, {
      seed: 7,
      count: 4,
      stableIds: true,
      relations: { _reciprocal: true },
    });
    const user = mocks.at('User', 0) as { todos: Record<string, unknown>[] };
    const todo = user.todos[0];
    if (!todo) throw new Error('expected a wired todo');
    expect(Object.keys(todo)).toContain('user');
  });

  it('still resolves an operation that selects the hidden field', () => {
    const mocks = hidden();
    const data = mocks.dataForOperation(
      parse('query U { users { id todos { id user { id } } } }'),
    ) as { users: { todos: { user: { id: string } }[] }[] };
    expect(data.users[0]?.todos[0]?.user.id).toMatch(/^User-/);
  });
});
