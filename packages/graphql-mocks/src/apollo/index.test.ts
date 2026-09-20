import { ApolloClient, InMemoryCache, type TypedDocumentNode, gql } from '@apollo/client';
import { describe, expect, it, vi } from 'vitest';
import { buildMocks } from '../mockSchema.js';
import { schema } from '../test/schema.js';
import type { BuildMocksOptions } from '../types.js';
import {
  type CreateMockClientOptions,
  type MockApolloClient,
  type MockClientParameter,
  createMockClient,
  mockLink,
  resolveMockClient,
  withGraphqlMocks,
} from './index.js';

interface UserFields {
  id: string;
  name: string;
}

const UsersQuery: TypedDocumentNode<{ users: UserFields[] }, Record<string, never>> = gql`
  query Users {
    users {
      id
      name
    }
  }
`;

const UserByIdQuery: TypedDocumentNode<{ user: UserFields }, { id: string }> = gql`
  query UserById($id: ID!) {
    user(id: $id) {
      id
      name
    }
  }
`;

const graph = () => buildMocks(schema, { seed: 11, count: 6, stableIds: true });

const clientFor = (link: ReturnType<typeof mockLink>) =>
  new ApolloClient({ cache: new InMemoryCache(), link });

describe('mockLink', () => {
  it('answers a query through a real ApolloClient', async () => {
    const client = clientFor(mockLink(graph()));
    const result = await client.query({ query: UsersQuery });
    expect(result.data?.users.length).toBeGreaterThan(0);
    expect(result.data?.users[0]).toHaveProperty('name');
  });

  it('answers a second, unregistered operation from the same link', async () => {
    const client = clientFor(mockLink(graph(), { matchArguments: true }));
    const result = await client.query({ query: UserByIdQuery, variables: { id: 'User-2' } });
    expect(result.data?.user.id).toBe('User-2');
  });

  it('surfaces an override GraphQL error', async () => {
    const client = clientFor(
      mockLink(graph(), { overrides: [{ match: 'Users', errors: 'not allowed' }] }),
    );
    await expect(client.query({ query: UsersQuery })).rejects.toThrow('not allowed');
  });

  it('surfaces an override network error', async () => {
    const client = clientFor(
      mockLink(graph(), { overrides: [{ match: 'Users', networkError: 'offline' }] }),
    );
    await expect(client.query({ query: UsersQuery })).rejects.toThrow('offline');
  });

  it('stays loading for a loading override without scheduling a timer', async () => {
    vi.useFakeTimers();
    try {
      const client = clientFor(
        mockLink(graph(), { overrides: [{ match: 'Users', loading: true }] }),
      );
      let settled = false;
      client.query({ query: UsersQuery }).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(1_000_000);
      expect(settled).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts an existing handler so calls and reset stay observable', async () => {
    const handler = graph().toRequestHandler();
    const client = clientFor(mockLink(handler));
    await client.query({ query: UsersQuery });
    expect(handler.calls.map((c) => c.operationName)).toEqual(['Users']);
    handler.reset();
    expect(handler.calls).toHaveLength(0);
  });
});

/** v3 reports `errors` on the result, v4 a single `error`; read whichever is there. */
const errorMessage = (result: unknown): string => {
  const record = result as {
    error?: { message?: string };
    errors?: readonly { message: string }[];
  };
  if (record.error?.message) return record.error.message;
  return (record.errors ?? []).map((entry) => entry.message).join(', ');
};

const factory = (extra: BuildMocksOptions = {}) =>
  vi.fn((options: BuildMocksOptions) =>
    buildMocks(schema, { seed: 11, count: 6, stableIds: true, ...extra, ...options }),
  );

describe('createMockClient', () => {
  it('answers a query with no cache or link to assemble', async () => {
    const client = createMockClient(graph());
    const result = await client.query({ query: UsersQuery });
    expect(result.data?.users.length).toBeGreaterThan(0);
  });

  it('gives every client its own cache', () => {
    expect(createMockClient(graph()).cache).not.toBe(createMockClient(graph()).cache);
  });

  it('defaults to no-cache reads so one story cannot answer from another story rows', () => {
    const client = createMockClient(graph());
    expect(client.defaultOptions.query?.fetchPolicy).toBe('no-cache');
    expect(client.defaultOptions.watchQuery?.fetchPolicy).toBe('no-cache');
    expect(client.defaultOptions.query?.errorPolicy).toBe('all');
  });

  it('merges defaultOptions per operation kind and per key', () => {
    const client = createMockClient(graph(), {
      defaultOptions: { query: { fetchPolicy: 'cache-first' } },
    });
    expect(client.defaultOptions.query?.fetchPolicy).toBe('cache-first');
    // The key that was not named survives, as does the operation kind that was not named.
    expect(client.defaultOptions.query?.errorPolicy).toBe('all');
    expect(client.defaultOptions.watchQuery?.fetchPolicy).toBe('no-cache');
  });

  it('takes one operation kind without restating the others', () => {
    // The whole point of the deep partial: `mutate` alone, and `errorPolicy` spelled as a value
    // rather than as Apollo 4's "declare it first" sentence.
    const client = createMockClient(graph(), {
      defaultOptions: { mutate: { errorPolicy: 'all' } },
    });
    expect(client.defaultOptions.mutate?.errorPolicy).toBe('all');
    expect(client.defaultOptions.query?.fetchPolicy).toBe('no-cache');
    expect(client.defaultOptions.watchQuery?.errorPolicy).toBe('all');
  });

  it('still rejects a key or a value that is not an option', () => {
    const options: CreateMockClientOptions = {
      // @ts-expect-error not an option of `query`
      defaultOptions: { query: { nonsense: true } },
    };
    const wrongValue: CreateMockClientOptions = {
      // @ts-expect-error not a fetch policy
      defaultOptions: { query: { fetchPolicy: 'whenever' } },
    };
    expect([options, wrongValue]).toHaveLength(2);
  });

  it('accepts an explicit cache', () => {
    const cache = new InMemoryCache();
    expect(createMockClient(graph(), { cache }).cache).toBe(cache);
  });

  it('accepts an explicit link, which supersedes the handler options', async () => {
    const client = createMockClient(graph(), {
      link: mockLink(graph()),
      overrides: [{ match: 'Users', errors: 'ignored' }],
    });
    const result = await client.query({ query: UsersQuery });
    expect(errorMessage(result)).toBe('');
    expect(result.data?.users.length).toBeGreaterThan(0);
  });

  it('passes handler options through to the link', async () => {
    const client = createMockClient(graph(), { matchArguments: true });
    const result = await client.query({ query: UserByIdQuery, variables: { id: 'User-3' } });
    expect(result.data?.user.id).toBe('User-3');
  });

  it('surfaces a GraphQL error as data + errors rather than a rejection', async () => {
    const client = createMockClient(graph(), {
      overrides: [{ match: 'Users', errors: 'not allowed' }],
    });
    const result = await client.query({ query: UsersQuery });
    expect(errorMessage(result)).toContain('not allowed');
  });

  it('accepts an existing handler', async () => {
    const handler = graph().toRequestHandler();
    await createMockClient(handler).query({ query: UsersQuery });
    expect(handler.calls.map((call) => call.operationName)).toEqual(['Users']);
  });

  it('accepts a graph factory and builds it once per config', async () => {
    const build = factory();
    await createMockClient(build).query({ query: UsersQuery });
    await createMockClient(build).query({ query: UsersQuery });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('passes clientOptions through to the constructor', async () => {
    const client = createMockClient(graph(), { clientOptions: { ssrMode: true } });
    const result = await client.query({ query: UsersQuery });
    expect(result.data?.users.length).toBeGreaterThan(0);
  });
});

describe('resolveMockClient', () => {
  it('treats true and an absent parameter as the default state', async () => {
    const result = await resolveMockClient(graph(), true).query({ query: UsersQuery });
    expect(result.data?.users.length).toBeGreaterThan(0);
    expect(errorMessage(result)).toBe('');
  });

  it('resolves the errored state', async () => {
    const result = await resolveMockClient(graph(), 'errored').query({ query: UsersQuery });
    expect(errorMessage(result)).toContain('scenario error');
  });

  it('resolves the loading state to an operation that never settles', async () => {
    vi.useFakeTimers();
    try {
      const client = resolveMockClient(graph(), 'loading');
      let settled = false;
      client.query({ query: UsersQuery }).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(1_000_000);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('targets one operation, leaving the rest resolving', async () => {
    const client = resolveMockClient(graph(), { state: 'errored', target: 'Users' });
    expect(errorMessage(await client.query({ query: UsersQuery }))).toContain('scenario error');
    const other = await client.query({ query: UserByIdQuery, variables: { id: 'User-1' } });
    expect(errorMessage(other)).toBe('');
    expect(other.data?.user).toHaveProperty('name');
  });

  it('rebuilds the graph from a build parameter', async () => {
    const result = await resolveMockClient(factory(), { build: { count: 2 } }).query({
      query: UsersQuery,
    });
    // A root list draws a random slice of the pool, so assert on the pool the graph was built
    // with rather than on the slice: with `count: 2` and stable ids there are only two users.
    expect(result.data?.users.length).toBeGreaterThan(0);
    expect(result.data?.users.every((user) => user.id < 'User-2')).toBe(true);
  });

  it('treats qa as shorthand for build.qa', async () => {
    const result = await resolveMockClient(factory(), { qa: 'emptyText' }).query({
      query: UsersQuery,
    });
    expect(result.data?.users.length).toBeGreaterThan(0);
    expect(result.data?.users.every((user) => user.name === '')).toBe(true);
  });

  it('reuses a graph across states and builds a new one per config', async () => {
    const build = factory();
    await resolveMockClient(build, 'default').query({ query: UsersQuery });
    await resolveMockClient(build, { state: 'errored' }).query({ query: UsersQuery });
    expect(build).toHaveBeenCalledTimes(1);
    await resolveMockClient(build, { build: { count: 2 } }).query({ query: UsersQuery });
    expect(build).toHaveBeenCalledTimes(2);
    // Key order must not matter, or a story rebuilds on a reformat.
    await resolveMockClient(build, { build: { seed: 11, count: 2 } }).query({ query: UsersQuery });
    await resolveMockClient(build, { build: { count: 2, seed: 11 } }).query({ query: UsersQuery });
    expect(build).toHaveBeenCalledTimes(3);
  });

  it('does not share a graph between configs whose overrides differ only by a function', () => {
    const build = factory();
    const parameter = (data: () => Record<string, unknown>): MockClientParameter => ({
      build: { overrides: { User: { name: data } } } as BuildMocksOptions,
    });
    resolveMockClient(
      build,
      parameter(() => ({ name: 'a' })),
    );
    resolveMockClient(
      build,
      parameter(() => ({ name: 'b' })),
    );
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('warns when build or qa is asked of an already-built graph', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      resolveMockClient(graph(), { qa: 'emptyText' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('need a graph factory'));
    } finally {
      warn.mockRestore();
    }
  });

  it('layers a parameter over the base options, the parameter overrides matching first', async () => {
    const client = resolveMockClient(
      graph(),
      { overrides: [{ match: 'Users', data: { users: [{ id: 'story', name: 'Story' }] } }] },
      { overrides: [{ match: 'Users', data: { users: [{ id: 'base', name: 'Base' }] } }] },
    );
    const result = await client.query({ query: UsersQuery });
    expect(result.data?.users[0]?.id).toBe('story');
  });

  it('keeps base handler options the parameter does not mention', async () => {
    const client = resolveMockClient(graph(), { state: 'default' }, { matchArguments: true });
    const result = await client.query({ query: UserByIdQuery, variables: { id: 'User-4' } });
    expect(result.data?.user.id).toBe('User-4');
  });
});

describe('withGraphqlMocks', () => {
  const wrap = vi.fn((client: MockApolloClient, story: (context?: unknown) => unknown) => ({
    client,
    rendered: story(),
  }));
  const decorate = (parameters?: Record<string, unknown>) => {
    const story = vi.fn(() => 'story');
    const decorator = withGraphqlMocks(graph(), { wrap });
    return { story, result: decorator(story, { parameters }) };
  };

  it('wraps the story with a client', async () => {
    const { result } = decorate({ graphqlMocks: true });
    const wrapped = result as { client: MockApolloClient; rendered: string };
    expect(wrapped.rendered).toBe('story');
    const data = await wrapped.client.query({ query: UsersQuery });
    expect(data.data?.users.length).toBeGreaterThan(0);
  });

  it('wraps a story that sets no parameter, since a global decorator mocks everything', () => {
    expect(decorate().result).toHaveProperty('client');
    expect(decorate({}).result).toHaveProperty('client');
  });

  it('opts a story out on false', () => {
    const story = vi.fn(() => 'story');
    const decorator = withGraphqlMocks(graph(), { wrap });
    const calls = wrap.mock.calls.length;
    expect(decorator(story, { parameters: { graphqlMocks: false } })).toBe('story');
    expect(story).toHaveBeenCalledTimes(1);
    expect(wrap.mock.calls).toHaveLength(calls);
  });

  it('reads a custom parameter name', async () => {
    const decorator = withGraphqlMocks(graph(), { wrap, parameterName: 'apollo' });
    const result = decorator(() => 'story', { parameters: { apollo: 'errored' } }) as {
      client: MockApolloClient;
    };
    expect(errorMessage(await result.client.query({ query: UsersQuery }))).toContain(
      'scenario error',
    );
  });

  it('reuses one client per parameter, so a re-render does not refetch into a fresh cache', () => {
    const decorator = withGraphqlMocks(graph(), { wrap });
    const clientFrom = (parameters: Record<string, unknown>) =>
      (decorator(() => 'story', { parameters }) as { client: MockApolloClient }).client;

    expect(clientFrom({ graphqlMocks: 'loading' })).toBe(clientFrom({ graphqlMocks: 'loading' }));
    expect(clientFrom({ graphqlMocks: 'loading' })).not.toBe(
      clientFrom({ graphqlMocks: 'errored' }),
    );
  });

  it('keys the client memo on the parameter structure, not its identity', () => {
    const decorator = withGraphqlMocks(graph(), { wrap });
    const clientFrom = (parameters: Record<string, unknown>) =>
      (decorator(() => 'story', { parameters }) as { client: MockApolloClient }).client;
    const withId = (id: string) => ({
      graphqlMocks: { overrides: [{ match: 'Users', data: { users: [{ id }] } }] },
    });

    expect(clientFrom(withId('a'))).toBe(clientFrom(withId('a')));
    expect(clientFrom(withId('a'))).not.toBe(clientFrom(withId('b')));

    // A predicate cannot be compared structurally, so those stories fall back to a fresh client
    // rather than sharing one under a key that ignored the part that differs.
    const predicate = { graphqlMocks: { overrides: [{ match: () => true, loading: true }] } };
    expect(clientFrom(predicate)).not.toBe(clientFrom(predicate));
  });

  it('gives every story its own client, so no story renders from another story cache', () => {
    const decorator = withGraphqlMocks(graph(), { wrap });
    const clientForStory = (id: string) =>
      (decorator(() => 'story', { id, parameters: {} }) as { client: MockApolloClient }).client;

    // The parameter is the default for both stories, which is exactly the case that used to
    // collapse onto one client, and so onto one InMemoryCache.
    expect(clientForStory('screen--default')).not.toBe(clientForStory('screen--empty'));
    expect(clientForStory('screen--default').cache).not.toBe(clientForStory('screen--empty').cache);
    // A re-render of one story still reuses its client rather than refetching into a fresh cache.
    expect(clientForStory('screen--default')).toBe(clientForStory('screen--default'));
  });

  it('keeps one client per story per parameter, so a control knob does not reuse a stale one', () => {
    const decorator = withGraphqlMocks(graph(), { wrap });
    const clientForStory = (id: string, graphqlMocks: unknown) =>
      (
        decorator(() => 'story', { id, parameters: { graphqlMocks } }) as {
          client: MockApolloClient;
        }
      ).client;

    expect(clientForStory('screen--slow', { delay: 1 })).not.toBe(
      clientForStory('screen--slow', { delay: 2 }),
    );
    expect(clientForStory('screen--slow', { delay: 1 })).toBe(
      clientForStory('screen--slow', { delay: 1 }),
    );
  });

  it('shares one client across the stories a clientKey groups together', () => {
    const decorator = withGraphqlMocks(graph(), {
      wrap,
      clientKey: (context) => context.title,
    });
    const clientForStory = (title: string, id: string) =>
      (decorator(() => 'story', { id, title, parameters: {} }) as { client: MockApolloClient })
        .client;

    expect(clientForStory('Screen', 'screen--default')).toBe(
      clientForStory('Screen', 'screen--empty'),
    );
    expect(clientForStory('Screen', 'screen--default')).not.toBe(
      clientForStory('Other', 'other--default'),
    );
  });

  it('passes decorator options down as the base configuration', async () => {
    const decorator = withGraphqlMocks(graph(), { wrap, matchArguments: true });
    const result = decorator(() => 'story', { parameters: {} }) as { client: MockApolloClient };
    const data = await result.client.query({ query: UserByIdQuery, variables: { id: 'User-5' } });
    expect(data.data?.user.id).toBe('User-5');
  });
});
