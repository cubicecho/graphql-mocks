import { ApolloClient, InMemoryCache, gql } from '@apollo/client';
import { describe, expect, it, vi } from 'vitest';
import { buildMocks } from '../mockSchema.js';
import { schema } from '../test/schema.js';
import { mockLink } from './index.js';

const UsersQuery = gql`
  query Users {
    users {
      id
      name
    }
  }
`;

const UserByIdQuery = gql`
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
    expect(result.data.users.length).toBeGreaterThan(0);
    expect(result.data.users[0]).toHaveProperty('name');
  });

  it('answers a second, unregistered operation from the same link', async () => {
    const client = clientFor(mockLink(graph(), { matchArguments: true }));
    const result = await client.query({ query: UserByIdQuery, variables: { id: 'User-2' } });
    expect(result.data.user.id).toBe('User-2');
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
