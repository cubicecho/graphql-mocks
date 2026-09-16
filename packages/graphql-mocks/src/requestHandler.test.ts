import { type DocumentNode, parse } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMocks } from './mockSchema.js';
import { schema } from './test/schema.js';

const UsersQuery = parse('query Users { users { id name } }');
const TodosQuery = parse('query Todos { todos { id title } }');
const UserByIdQuery = parse('query UserById($id: ID!) { user(id: $id) { id name } }');
const CreateTodoMutation = parse(
  'mutation CreateTodo($input: CreateTodoInput!) { createTodo(input: $input) { id title } }',
);

const graph = () => buildMocks(schema, { seed: 3, count: 6, stableIds: true });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('toRequestHandler', () => {
  it('answers unrelated operations with no registration', async () => {
    const handler = graph().toRequestHandler();
    const users = (await handler({ query: UsersQuery })) as {
      data: { users: { id: string; name: string }[] };
    };
    const todos = (await handler({ query: TodosQuery })) as {
      data: { todos: { id: string; title: string }[] };
    };
    expect(users.data.users.length).toBeGreaterThan(0);
    expect(todos.data.todos.length).toBeGreaterThan(0);
    expect(users.data.users[0]).toHaveProperty('name');
    expect(todos.data.todos[0]).toHaveProperty('title');
  });

  it('shapes the result to the selection set, with no extra fields', async () => {
    const handler = graph().toRequestHandler();
    const { data } = (await handler({ query: UsersQuery })) as {
      data: { users: Record<string, unknown>[] };
    };
    expect(Object.keys(data.users[0] ?? {}).sort()).toEqual(['id', 'name']);
  });

  it('executes mutations through the same path', async () => {
    const handler = graph().toRequestHandler();
    const { data } = (await handler({
      query: CreateTodoMutation,
      variables: { input: { title: 'x' } },
    })) as { data: { createTodo: { id: string; title: string } } };
    expect(data.createTodo.id).toBeDefined();
  });

  it('does not mutate the pool when a mutation runs', async () => {
    const mocks = graph();
    const before = (mocks.Todo as { id: string; title: string }[]).map((t) => ({ ...t }));
    await mocks.toRequestHandler()({
      query: CreateTodoMutation,
      variables: { input: { title: 'x' } },
    });
    const after = (mocks.Todo as { id: string; title: string }[]).map((t) => ({ ...t }));
    expect(after).toEqual(before);
  });

  it('returns no value reachable from the pool graph', async () => {
    const mocks = graph();
    const pooled = new Set<unknown>();
    for (const items of Object.values(mocks)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) if (item && typeof item === 'object') pooled.add(item);
    }
    const { data } = await mocks.toRequestHandler()({
      query: parse('{ users { id name todos { id posts { id } } } }'),
    });

    const seen: unknown[] = [];
    const walk = (value: unknown, depth: number) => {
      expect(depth).toBeLessThan(20);
      if (!value || typeof value !== 'object') return;
      expect(pooled.has(value)).toBe(false);
      seen.push(value);
      for (const child of Object.values(value as Record<string, unknown>)) walk(child, depth + 1);
    };
    walk(data, 0);
    expect(seen.length).toBeGreaterThan(0);
    // Acyclic: the pool's live back-references never reach the result.
    expect(() => JSON.stringify(data)).not.toThrow();
  });

  it('accepts an Apollo Operation-shaped request with no Apollo import', async () => {
    const operation = {
      query: UsersQuery,
      variables: {},
      operationName: 'Users',
      extensions: {},
      getContext: () => ({}),
      setContext: () => ({}),
    };
    const { data } = (await graph().toRequestHandler()(operation)) as {
      data: { users: unknown[] };
    };
    expect(data.users.length).toBeGreaterThan(0);
  });

  it('reports a request with no executable operation instead of throwing', async () => {
    const fragmentOnly = parse('fragment F on User { id }') as DocumentNode;
    const result = await graph().toRequestHandler()({ query: fragmentOnly });
    expect(result.data).toBeNull();
    expect(result.errors?.[0]?.message).toContain('no executable operation');
  });
});

describe('toRequestHandler memoization', () => {
  it('returns the same result for the same document and variables', async () => {
    const handler = graph().toRequestHandler();
    const first = await handler({ query: UsersQuery });
    const second = await handler({ query: UsersQuery });
    expect(second).toEqual(first);
  });

  it('keys on variables regardless of their order', async () => {
    const doc = parse(
      'query Two($a: ID!, $b: ID!) { x: user(id: $a) { id } y: user(id: $b) { id } }',
    );
    const handler = graph().toRequestHandler();
    const first = await handler({ query: doc, variables: { a: '1', b: '2' } });
    const second = await handler({ query: doc, variables: { b: '2', a: '1' } });
    expect(second).toEqual(first);
  });

  it('draws fresh data for different variables', async () => {
    const handler = graph().toRequestHandler({ matchArguments: true });
    const first = (await handler({ query: UserByIdQuery, variables: { id: 'User-1' } })) as {
      data: { user: { id: string } };
    };
    const second = (await handler({ query: UserByIdQuery, variables: { id: 'User-4' } })) as {
      data: { user: { id: string } };
    };
    expect(first.data.user.id).toBe('User-1');
    expect(second.data.user.id).toBe('User-4');
  });

  it('re-resolves every call when memoize is false', async () => {
    const handler = graph().toRequestHandler({ memoize: false });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => handler({ query: UsersQuery })),
    );
    const shapes = results.map((r) => JSON.stringify(r.data));
    expect(new Set(shapes).size).toBeGreaterThan(1);
  });

  it('clears the memo, the calls and consumed once-overrides on reset', async () => {
    const handler = graph().toRequestHandler({
      overrides: [{ match: 'Users', errors: 'gone', once: true }],
    });
    expect((await handler({ query: UsersQuery })).errors?.[0]?.message).toBe('gone');
    expect((await handler({ query: UsersQuery })).errors).toBeUndefined();
    expect(handler.calls).toHaveLength(2);

    handler.reset();
    expect(handler.calls).toHaveLength(0);
    expect((await handler({ query: UsersQuery })).errors?.[0]?.message).toBe('gone');
  });
});

describe('toRequestHandler overrides', () => {
  it('matches by operation name, document identity and predicate', async () => {
    const handler = graph().toRequestHandler({
      overrides: [
        { match: 'Users', data: { users: [] } },
        { match: TodosQuery, data: { todos: [{ id: 'fixed' }] } },
        { match: (info) => info.operationType === 'mutation', errors: 'no writes' },
      ],
    });
    expect((await handler({ query: UsersQuery })).data).toEqual({ users: [] });
    expect((await handler({ query: TodosQuery })).data).toEqual({ todos: [{ id: 'fixed' }] });
    const mutation = await handler({
      query: CreateTodoMutation,
      variables: { input: { title: 'x' } },
    });
    expect(mutation.errors?.[0]?.message).toBe('no writes');
  });

  it('lets the first matching override win', async () => {
    const handler = graph().toRequestHandler({
      overrides: [{ data: { users: ['first'] } }, { match: 'Users', data: { users: ['second'] } }],
    });
    expect((await handler({ query: UsersQuery })).data).toEqual({ users: ['first'] });
  });

  it('passes the operation and the graph data to a data function', async () => {
    const handler = graph().toRequestHandler({
      overrides: [
        {
          match: 'Users',
          data: (info, graphData) => ({
            users: (graphData as { users: unknown[] }).users.slice(0, 1),
            name: info.operationName,
          }),
        },
      ],
    });
    const { data } = (await handler({ query: UsersQuery })) as {
      data: { users: unknown[]; name: string };
    };
    expect(data.users).toHaveLength(1);
    expect(data.name).toBe('Users');
  });

  it('resolves GraphQL errors with null data', async () => {
    const handler = graph().toRequestHandler({
      overrides: [{ match: 'Users', errors: [{ message: 'boom', path: ['users'] }] }],
    });
    const result = await handler({ query: UsersQuery });
    expect(result.data).toBeNull();
    expect(result.errors).toEqual([{ message: 'boom', path: ['users'] }]);
  });

  it('rejects for a network error', async () => {
    const handler = graph().toRequestHandler({
      overrides: [{ match: 'Users', networkError: 'offline' }],
    });
    await expect(handler({ query: UsersQuery })).rejects.toThrow('offline');
  });

  it('rejects with a provided Error instance', async () => {
    const error = new Error('down');
    const handler = graph().toRequestHandler({ overrides: [{ networkError: error }] });
    await expect(handler({ query: UsersQuery })).rejects.toBe(error);
  });

  it('stays pending for loading, with no timer scheduled', async () => {
    vi.useFakeTimers();
    const handler = graph().toRequestHandler({ overrides: [{ match: 'Users', loading: true }] });
    let settled = false;
    handler({ query: UsersQuery }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('toRequestHandler delay', () => {
  it('waits a fixed delay before settling', async () => {
    vi.useFakeTimers();
    const handler = graph().toRequestHandler({ delay: 500 });
    let settled = false;
    const pending = handler({ query: UsersQuery }).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it('accepts a random range and lets an override replace it', async () => {
    vi.useFakeTimers();
    const handler = graph().toRequestHandler({
      delay: { min: 10, max: 20 },
      overrides: [{ match: 'Todos', delay: 0 }],
    });
    const fast = handler({ query: TodosQuery });
    await vi.advanceTimersByTimeAsync(0);
    await expect(fast).resolves.toBeDefined();

    const slow = handler({ query: UsersQuery });
    await vi.advanceTimersByTimeAsync(20);
    await expect(slow).resolves.toBeDefined();
  });
});

describe('toRequestHandler diagnostics', () => {
  const Invalid = parse('{ users { id } }');

  it('records every call in order', async () => {
    const handler = graph().toRequestHandler();
    await handler({ query: UsersQuery });
    await handler({ query: UserByIdQuery, variables: { id: 'User-2' } });
    expect(handler.calls.map((c) => c.operationName)).toEqual(['Users', 'UserById']);
    expect(handler.calls[1]?.variables).toEqual({ id: 'User-2' });
    expect(handler.calls[1]?.document).toBe(UserByIdQuery);
    expect(handler.calls[0]?.operationType).toBe('query');
  });

  it('reports an anonymous operation with a null name', async () => {
    const handler = graph().toRequestHandler();
    await handler({ query: Invalid });
    expect(handler.calls[0]?.operationName).toBeNull();
  });

  it('calls onOperation before resolving', async () => {
    const onOperation = vi.fn();
    const handler = graph().toRequestHandler({ onOperation });
    await handler({ query: UsersQuery });
    expect(onOperation).toHaveBeenCalledTimes(1);
    expect(onOperation.mock.calls[0]?.[0]).toMatchObject({ operationName: 'Users' });
  });

  it('warns once that subscriptions resolve a single payload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = graph().toRequestHandler();
    const doc = parse('subscription OnTodo { todoAdded { id } }');
    await handler({ query: doc }).catch(() => {});
    await handler({ query: doc }).catch(() => {});
    expect(warn.mock.calls.filter(([m]) => String(m).includes('subscriptions'))).toHaveLength(1);
  });
});

describe('toRequestHandler execution errors', () => {
  // Variable coercion failure: `id` is declared `ID!` but handed an object, so execution
  // produces GraphQL errors before any resolver runs.
  const badVariables = { query: UserByIdQuery, variables: { id: { nope: true } } };

  it('warns and still returns the errors by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await graph().toRequestHandler()(badVariables);
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('UserById'))).toHaveLength(1);
  });

  it('stays quiet when silent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await graph().toRequestHandler({ onExecutionError: 'silent' })(badVariables);
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('UserById'))).toHaveLength(0);
  });

  it('throws synchronously when asked to, rather than rejecting later', () => {
    const handler = graph().toRequestHandler({ onExecutionError: 'throw' });
    expect(() => handler(badVariables)).toThrow('UserById');
  });
});
