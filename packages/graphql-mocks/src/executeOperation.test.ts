import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { parse } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { buildMocks } from './mockSchema.js';
import { schema } from './test/schema.js';

const mocks = buildMocks(schema, { seed: 1, count: 5 });

describe('dataForOperation', () => {
  it('shapes a single-object query to its selection set', () => {
    const doc = parse(`
      query UserById($id: ID!) {
        user(id: $id) { __typename id name email }
      }
    `);
    const data = mocks.dataForOperation(doc) as {
      user: { __typename: string; id: string; name: string; email: string } | null;
    };
    expect(data.user).not.toBeNull();
    expect(data.user?.__typename).toBe('User');
    expect(Object.keys(data.user ?? {}).sort()).toEqual(['__typename', 'email', 'id', 'name']);
    // The picked user is a real pooled instance.
    expect(mocks.User?.some((u) => (u as { id: string }).id === data.user?.id)).toBe(true);
  });

  it('only includes selected fields, not the whole mock object', () => {
    const doc = parse('{ user(id: "x") { id } }');
    const data = mocks.dataForOperation(doc) as { user: Record<string, unknown> | null };
    expect(Object.keys(data.user ?? {})).toEqual(['id']);
    expect(data.user).not.toHaveProperty('email');
  });

  it('resolves list fields and follows wired relationships', () => {
    const doc = parse(`
      query {
        users { id posts { id author { id } } }
      }
    `);
    const data = mocks.dataForOperation(doc) as {
      users: { id: string; posts: { id: string; author: { id: string } }[] }[];
    };
    expect(Array.isArray(data.users)).toBe(true);
    expect(data.users.length).toBeGreaterThan(0);
    const withPosts = data.users.find((u) => u.posts.length > 0);
    expect(withPosts?.posts[0]?.author.id).toBeDefined();
  });

  it('resolves union fields via __typename with inline fragments', () => {
    const doc = parse(`
      query Search($query: String!) {
        search(query: $query) {
          __typename
          ... on User { id name }
          ... on Post { id title }
          ... on Comment { id body }
        }
      }
    `);
    const data = mocks.dataForOperation(doc) as {
      search: { __typename: string; id: string }[];
    };
    expect(data.search.length).toBeGreaterThan(0);
    for (const item of data.search) {
      expect(['User', 'Post', 'Comment']).toContain(item.__typename);
      expect(item.id).toBeDefined();
    }
  });

  it('infers the data type from a TypedDocumentNode', () => {
    type Data = { users: { id: string }[] };
    const doc = parse('{ users { id } }') as TypedDocumentNode<Data, Record<string, never>>;
    const data = mocks.dataForOperation(doc); // typed as Data
    expect(data.users[0]?.id).toBeDefined();
  });

  it('auto-fills required variables it is not given', () => {
    // $id: ID! is required; we pass nothing and it still resolves.
    const doc = parse('query($id: ID!) { user(id: $id) { id } }');
    const data = mocks.dataForOperation(doc) as { user: { id: string } | null };
    expect(data.user?.id).toBeDefined();
  });
});

type UserData = { user: { id: string } | null };
type UserVars = { id: string };
const UserByIdQuery = parse(
  'query UserById($id: ID!) { user(id: $id) { id } }',
) as TypedDocumentNode<UserData, UserVars>;

describe('mocks.mockOperation', () => {
  it('builds a MockedProvider entry with data resolved from the pool — no data argument', () => {
    const mock = mocks.mockOperation(UserByIdQuery);
    expect(mock.request.query).toBe(UserByIdQuery);
    expect(mock.result?.data?.user?.id).toBeDefined();
    // The resolved id is a real pooled instance.
    expect(mocks.User?.some((u) => (u as { id: string }).id === mock.result?.data?.user?.id)).toBe(
      true,
    );
  });

  it('defaults variables to a match-any predicate and maxUsageCount to Infinity', () => {
    const mock = mocks.mockOperation(UserByIdQuery);
    expect(typeof mock.request.variables).toBe('function');
    expect(mock.maxUsageCount).toBe(Number.POSITIVE_INFINITY);
  });

  it('threads delay/error/maxUsageCount options through', () => {
    const error = new Error('boom');
    const mock = mocks.mockOperation(UserByIdQuery, { delay: 50, error, maxUsageCount: 2 });
    expect(mock.delay).toBe(50);
    expect(mock.error).toBe(error);
    expect(mock.maxUsageCount).toBe(2);
  });
});

describe('mocks.mockOperationVariants', () => {
  it('returns success/long-load/error variants, success data drawn from the pool', () => {
    const variants = mocks.mockOperationVariants(UserByIdQuery);
    expect(variants.withResults.result?.data?.user?.id).toBeDefined();
    expect(variants.withLongLoadTime.delay).toBe(1_000_000);
    expect(variants.withError.error?.message).toContain('UserById');
  });
});

describe('matchArguments', () => {
  const matched = buildMocks(schema, {
    seed: 3,
    count: 12,
    stableIds: true,
    listSize: { min: 12, max: 12 },
    matchArguments: true,
  });

  it('ignores an argument bound to a synthesized variable, keeping v3 behavior', () => {
    // `$id` is non-null and the caller passes nothing, so it is synthesized — filtering on it
    // would match no pooled user and return null.
    const doc = parse('query UserById($id: ID!) { user(id: $id) { id } }');
    const data = matched.dataForOperation(doc) as { user: { id: string } | null };
    expect(data.user).not.toBeNull();
    expect(matched.User?.some((u) => (u as { id: string }).id === data.user?.id)).toBe(true);
  });

  it('matches a caller-supplied id against the pool', () => {
    const doc = parse('query UserById($id: ID!) { user(id: $id) { id name } }');
    const data = matched.dataForOperation(doc, { id: 'User-7' }) as { user: { id: string } };
    expect(data.user.id).toBe('User-7');
  });

  it('matches a literal id argument', () => {
    const doc = parse('{ user(id: "User-2") { id } }');
    const data = matched.dataForOperation(doc) as { user: { id: string } };
    expect(data.user.id).toBe('User-2');
  });

  it('falls back to a random pooled item when a nullable singular filter misses', () => {
    const doc = parse('{ user(id: "nope") { id } }');
    const data = matched.dataForOperation(doc) as { user: { id: string } | null };
    expect(data.user).not.toBeNull();
  });

  it('returns null on a nullable singular miss when onMiss is empty', () => {
    const doc = parse('{ user(id: "nope") { id } }');
    const data = matched.dataForOperation(doc, undefined, { onMiss: 'empty' }) as {
      user: { id: string } | null;
    };
    expect(data.user).toBeNull();
  });

  it('never nulls a non-null singular field on a miss, even with onMiss empty', () => {
    // `null` on a non-null field is a GraphQL execution error, which `resolveOperationData`
    // only reports as a warning — so assert on the warning too, not just the data.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = parse('mutation { updateUser(id: "nope") { id } }');
    const data = matched.dataForOperation(doc, undefined, { onMiss: 'empty' }) as {
      updateUser: { id: string } | null;
    };
    expect(data.updateUser).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('filters a list by an enum argument', () => {
    const doc = parse('{ todos(priority: HIGH) { id priority } }');
    const data = matched.dataForOperation(doc) as { todos: { priority: string }[] };
    expect(data.todos.length).toBeGreaterThan(0);
    expect(data.todos.every((t) => t.priority === 'HIGH')).toBe(true);
  });

  it('returns an empty list when a list filter matches nothing', () => {
    const doc = parse('{ posts(titleContains: "zzzznope") { id } }');
    const data = matched.dataForOperation(doc) as { posts: unknown[] };
    expect(data.posts).toEqual([]);
  });

  it('falls back to random rows on a list miss when onMiss is fallback', () => {
    const doc = parse('{ posts(titleContains: "zzzznope") { id } }');
    const data = matched.dataForOperation(doc, undefined, { onMiss: { list: 'fallback' } }) as {
      posts: unknown[];
    };
    expect(data.posts.length).toBeGreaterThan(0);
  });

  it('applies skip and limit to a root list, in stable pool order', () => {
    // Paging switches the source from a random subset to the whole pool in order — slicing a
    // random subset would be meaningless.
    const page = matched.dataForOperation(parse('{ users(skip: 2, limit: 3) { id } }')) as {
      users: { id: string }[];
    };
    const pool = (matched.User as { id: string }[]).map((u) => u.id);
    expect(page.users.map((u) => u.id)).toEqual(pool.slice(2, 5));
  });

  it('applies the offset/first dialect', () => {
    const data = matched.dataForOperation(parse('{ todos(offset: 1, first: 2) { id } }')) as {
      todos: unknown[];
    };
    expect(data.todos).toHaveLength(2);
  });

  it('applies take as a page size', () => {
    const data = matched.dataForOperation(parse('{ posts(take: 4) { id } }')) as {
      posts: unknown[];
    };
    expect(data.posts).toHaveLength(4);
  });

  it('returns an empty list when the offset is past the end', () => {
    const data = matched.dataForOperation(parse('{ users(skip: 999, limit: 5) { id } }')) as {
      users: unknown[];
    };
    expect(data.users).toEqual([]);
  });

  it('pages deterministically across repeated calls', () => {
    const doc = parse('{ users(skip: 1, limit: 3) { id } }');
    const first = matched.dataForOperation(doc) as { users: { id: string }[] };
    const second = matched.dataForOperation(doc) as { users: { id: string }[] };
    expect(first.users.map((u) => u.id)).toEqual(second.users.map((u) => u.id));
  });

  it('matches a plural list argument against the singular id field', () => {
    const doc = parse('query ByIds($ids: [ID!]!) { usersByIds(ids: $ids) { id } }');
    const data = matched.dataForOperation(doc, { ids: ['User-1', 'User-4'] }) as {
      usersByIds: { id: string }[];
    };
    expect(data.usersByIds.map((u) => u.id).sort()).toEqual(['User-1', 'User-4']);
  });

  it('filters an abstract list by a search argument', () => {
    const doc = parse('query S($query: String!) { search(query: $query) { __typename } }');
    const data = matched.dataForOperation(doc, { query: 'zzzznope' }) as { search: unknown[] };
    expect(data.search).toEqual([]);
  });

  it('applies arguments to nested list fields', () => {
    const doc = parse('{ users(limit: 1) { id todos(first: 2) { id } } }');
    const data = matched.dataForOperation(doc) as { users: { todos: unknown[] }[] };
    expect(data.users[0]?.todos).toHaveLength(2);
  });

  it('leaves nested arguments alone when nested matching is off', () => {
    const doc = parse('{ users(limit: 1) { id todos(first: 2) { id } } }');
    const data = matched.dataForOperation(doc, undefined, { nested: false }) as {
      users: { todos: unknown[] }[];
    };
    expect(data.users[0]?.todos.length).toBeGreaterThan(2);
  });

  it('resolves a mutation and ignores an input-object argument', () => {
    const doc = parse(`
      mutation Create($input: CreateTodoInput!) {
        createTodo(input: $input) { __typename id title }
      }
    `);
    const data = matched.dataForOperation(doc, { input: { title: 'anything' } }) as {
      createTodo: { __typename: string; id: string };
    };
    expect(data.createTodo.__typename).toBe('Todo');
    expect(matched.Todo?.some((t) => (t as { id: string }).id === data.createTodo.id)).toBe(true);
  });

  it('resolves a scalar-returning mutation that carries arguments', () => {
    const doc = parse('mutation { deleteTodo(id: "Todo-1") }');
    const data = matched.dataForOperation(doc) as { deleteTodo: boolean };
    expect(typeof data.deleteTodo).toBe('boolean');
  });

  it('does not mutate the pool', () => {
    const before = (matched.User as { id: string }[]).map((u) => u.id);
    matched.dataForOperation(parse('{ users(skip: 1, limit: 2) { id } }'));
    matched.dataForOperation(parse('mutation { updateUser(id: "User-1") { id } }'));
    expect((matched.User as { id: string }[]).map((u) => u.id)).toEqual(before);
  });

  it('produces the same output as the disabled default when turned off', () => {
    // The faker instance is shared and advances on every pick, so re-seed by rebuilding
    // immediately before each call rather than building both graphs up front.
    const doc = parse('{ users(skip: 2, limit: 3) { id } todos(priority: HIGH) { id } }');
    const run = (matchArguments: boolean | undefined) =>
      buildMocks(schema, { seed: 42, count: 8, stableIds: true, matchArguments }).dataForOperation(
        doc,
      );
    expect(run(undefined)).toEqual(run(false));
  });

  it('can be enabled for a single call on a graph that has it off', () => {
    const off = buildMocks(schema, { seed: 5, count: 8, stableIds: true });
    const doc = parse('{ user(id: "User-3") { id } }');
    const perCall = off.dataForOperation(doc, undefined, true) as { user: { id: string } };
    expect(perCall.user.id).toBe('User-3');
  });
});
