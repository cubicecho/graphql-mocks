import { type TypedDocumentNode, gql } from '@apollo/client';
import { describe, expect, it, vi } from 'vitest';
import { buildMocks } from '../mockSchema.js';
import { schema } from '../test/schema.js';
import type { BuildMocksOptions } from '../types.js';
import {
  type MockClientOption,
  type MockClientParameter,
  resolveMockClient,
  toMockClientParameter,
  withQa,
  withState,
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

/** v3 reports `errors` on the result, v4 a single `error`; read whichever is there. */
const errorMessage = (result: unknown): string => {
  const record = result as {
    error?: { message?: string };
    errors?: readonly { message: string }[];
  };
  if (record.error?.message) return record.error.message;
  return (record.errors ?? []).map((entry) => entry.message).join(', ');
};

const usersOverride = { match: 'Users', data: { users: [{ id: 'base', name: 'Base' }] } };

/** A long form setting every field a naive normalizer would drop. */
const longForm: MockClientParameter = {
  state: 'default',
  target: 'UserById',
  build: { count: 2 },
  qa: 'longText',
  overrides: [usersOverride],
  delay: 5,
};

const factory = () =>
  vi.fn((options: BuildMocksOptions) =>
    buildMocks(schema, { seed: 3, stableIds: true, ...options }),
  );

describe('toMockClientParameter', () => {
  it('reads each short form the way the decorator does', () => {
    expect(toMockClientParameter(undefined)).toEqual({ state: 'default' });
    expect(toMockClientParameter(true)).toEqual({ state: 'default' });
    expect(toMockClientParameter('default')).toEqual({ state: 'default' });
    expect(toMockClientParameter('loading')).toEqual({ state: 'loading' });
    expect(toMockClientParameter('errored')).toEqual({ state: 'errored' });
  });

  it('reads false as the default state, since "off" has no long form', () => {
    expect(toMockClientParameter(false)).toEqual({ state: 'default' });
  });

  it('round-trips a long form unchanged, as a copy', () => {
    const normalized = toMockClientParameter(longForm);
    expect(normalized).toEqual(longForm);
    expect(normalized).not.toBe(longForm);
  });
});

describe('withState', () => {
  it('sets the state on a short form', () => {
    expect(withState(true, 'loading')).toEqual({ state: 'loading' });
    expect(withState('errored', 'loading')).toEqual({ state: 'loading' });
    expect(withState(undefined, 'errored')).toEqual({ state: 'errored' });
  });

  it('keeps every field of a long-form base, without mutating it', () => {
    const derived = withState(longForm, 'loading');
    expect(derived).toEqual({ ...longForm, state: 'loading' });
    expect(longForm.state).toBe('default');
  });

  it('leaves a story that opted out of mocking opted out', () => {
    expect(withState(false, 'loading')).toBe(false);
  });

  it('keeps the union type usable without a branch', () => {
    const parameter = { overrides: [usersOverride] } as MockClientOption;
    expect(withState(parameter, 'errored')).toEqual({
      overrides: [usersOverride],
      state: 'errored',
    });
  });
});

describe('withQa', () => {
  it('sets qa on a short form', () => {
    expect(withQa('loading', 'emptyText')).toEqual({ state: 'loading', qa: 'emptyText' });
  });

  it('keeps every field of a long-form base, including its other build options', () => {
    const derived = withQa(longForm, 'emptyText');
    expect(derived).toEqual({ ...longForm, qa: 'emptyText' });
    expect((derived as MockClientParameter).build).toEqual({ count: 2 });
    expect(longForm.qa).toBe('longText');
  });

  it('leaves a story that opted out of mocking opted out', () => {
    expect(withQa(false, 'emptyText')).toBe(false);
  });
});

describe('derived parameters resolve like the base they came from', () => {
  it('keeps the base overrides and target when putting it in another state', async () => {
    const base: MockClientParameter = { target: 'UserById', overrides: [usersOverride] };
    const client = resolveMockClient(
      buildMocks(schema, { seed: 3, stableIds: true }),
      withState(base, 'errored'),
    );

    // The target narrows the error to UserById, and Users still answers from the base override —
    // both of which a `'errored'` short form would have thrown away.
    const users = await client.query({ query: UsersQuery });
    expect(users.data?.users[0]?.id).toBe('base');
    const user = await client.query({ query: UserByIdQuery, variables: { id: 'User-1' } });
    expect(errorMessage(user)).toContain('scenario error');
  });

  it('keeps the base build options when layering a qa preset over it', async () => {
    const build = factory();
    const base: MockClientParameter = { build: { count: 2 }, overrides: [usersOverride] };
    const client = resolveMockClient(build, withQa(base, 'emptyText'));

    const result = await client.query({ query: UsersQuery });
    expect(result.data?.users[0]?.id).toBe('base');
    expect(build).toHaveBeenCalledWith({ count: 2, qa: 'emptyText' });
  });
});
