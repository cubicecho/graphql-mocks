import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { parse } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockOperation, mockOperationVariants } from './apolloMocks.js';
import { assertValidMocks, validateMocks } from './validateMocks.js';

const UserQuery = parse('query User($id: ID!) { user(id: $id) { id name } }') as TypedDocumentNode<
  { user: { id: string; name: string } },
  { id: string }
>;
const FragmentOnly = parse('fragment UserFields on User { id name }');

/** The shape every check starts from: valid, so a test can break exactly one thing. */
function validMock() {
  return {
    request: { query: UserQuery, variables: { id: '1' } },
    result: { data: { user: { id: '1', name: 'Ada' } } },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validateMocks', () => {
  it('passes a well-formed mock', () => {
    expect(validateMocks(validMock())).toEqual([]);
  });

  it('flags a resolver parked at result.data, which Apollo never invokes', () => {
    const issues = validateMocks({
      request: { query: UserQuery },
      result: { data: () => ({ user: { id: '1' } }) },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('mocks.result.data');
    expect(issues[0]?.message).toContain('never invokes');
    expect(issues[0]?.operationName).toBe('User');
  });

  it('accepts the resolver form Apollo does invoke', () => {
    expect(
      validateMocks({
        request: { query: UserQuery },
        result: () => ({ data: { user: { id: '1', name: 'Ada' } } }),
      }),
    ).toEqual([]);
  });

  it('flags a function buried deeper inside data', () => {
    const issues = validateMocks({
      request: { query: UserQuery },
      result: { data: { user: { id: '1', name: () => 'Ada' } } },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('mocks.result.data.user.name');
  });

  it('finds a function inside a list', () => {
    const issues = validateMocks({
      request: { query: UserQuery },
      result: { data: { users: [{ id: '1' }, { id: () => '2' }] } },
    });
    expect(issues[0]?.path).toBe('mocks.result.data.users[1].id');
  });

  it('walks cyclic data without overflowing', () => {
    const user: Record<string, unknown> = { id: '1' };
    const post: Record<string, unknown> = { id: 'p1', author: user };
    user.posts = [post];
    expect(validateMocks({ request: { query: UserQuery }, result: { data: { user } } })).toEqual(
      [],
    );
  });

  it('reports every problem rather than stopping at the first', () => {
    const issues = validateMocks([
      { request: { query: UserQuery }, result: { data: { user: () => null } } },
      { request: { query: 'query { user { id } }' }, result: { data: { user: { id: '1' } } } },
    ]);
    expect(issues.map((issue) => issue.path)).toEqual([
      'mocks[0].result.data.user',
      'mocks[1].request.query',
    ]);
  });

  it('flags an unparsed query string', () => {
    const issues = validateMocks({
      request: { query: 'query { user { id } }' },
      result: { data: { user: { id: '1' } } },
    });
    expect(issues[0]?.message).toContain('not a parsed document');
    expect(issues[0]?.operationName).toBeUndefined();
  });

  it('flags a document that declares no operation', () => {
    const issues = validateMocks({
      request: { query: FragmentOnly },
      result: { data: { user: { id: '1' } } },
    });
    expect(issues[0]?.message).toContain('no operation');
  });

  it('flags a missing request', () => {
    const issues = validateMocks({ result: { data: { user: { id: '1' } } }, request: undefined });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('mocks.request');
  });

  it('accepts a variables predicate but rejects a variables scalar', () => {
    expect(
      validateMocks({ ...validMock(), request: { query: UserQuery, variables: () => true } }),
    ).toEqual([]);
    const issues = validateMocks({
      ...validMock(),
      request: { query: UserQuery, variables: 'id' },
    });
    expect(issues[0]?.path).toBe('mocks.request.variables');
  });

  it('checks error, delay and maxUsageCount types', () => {
    const issues = validateMocks({
      ...validMock(),
      error: 'boom',
      delay: '100',
      maxUsageCount: 'many',
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      'mocks.error',
      'mocks.delay',
      'mocks.maxUsageCount',
    ]);
  });

  it('accepts a mock that resolves with an error and no result', () => {
    expect(validateMocks({ request: { query: UserQuery }, error: new Error('nope') })).toEqual([]);
  });

  it('flags a mock with neither result nor error', () => {
    const issues = validateMocks({ request: { query: UserQuery } });
    expect(issues[0]?.message).toContain('neither `result` nor `error`');
  });

  it('flags a result that is neither object nor function', () => {
    const issues = validateMocks({ request: { query: UserQuery }, result: 'data' });
    expect(issues[0]?.message).toContain('must be an object or a function');
  });

  it('flags a result carrying neither data nor errors', () => {
    const issues = validateMocks({ request: { query: UserQuery }, result: {} });
    expect(issues[0]?.message).toContain('neither `data` nor `errors`');
  });

  it('accepts a GraphQL-errors result and an explicitly null data', () => {
    expect(
      validateMocks({ request: { query: UserQuery }, result: { errors: [{ message: 'nope' }] } }),
    ).toEqual([]);
    expect(validateMocks({ request: { query: UserQuery }, result: { data: null } })).toEqual([]);
  });

  it('flags non-object data', () => {
    const issues = validateMocks({ request: { query: UserQuery }, result: { data: 'user' } });
    expect(issues[0]?.message).toContain('must be an object');
  });

  it('flags empty data unless requireData is off', () => {
    const mock = { request: { query: UserQuery }, result: { data: {} } };
    expect(validateMocks(mock)[0]?.message).toContain('empty');
    expect(validateMocks(mock, { requireData: false })).toEqual([]);
  });

  it('checks every variant of a mockOperationVariants trio', () => {
    const variants = mockOperationVariants(UserQuery, { user: { id: '1', name: 'Ada' } });
    expect(validateMocks(variants)).toEqual([]);

    const broken = { ...variants, withResults: { request: { query: UserQuery }, result: {} } };
    expect(validateMocks(broken)[0]?.path).toBe('mocks.withResults.result');
  });

  it('walks a module namespace of mocks and ignores non-mock exports', () => {
    const module = {
      userMock: validMock(),
      SOME_CONSTANT: 'unrelated',
      nested: { broken: { request: { query: UserQuery }, result: { data: { user: () => null } } } },
    };
    const issues = validateMocks(module);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('mocks.nested.broken.result.data.user');
  });

  it('reports finding nothing rather than passing silently', () => {
    expect(validateMocks([])[0]?.message).toContain('no mocks found');
    expect(validateMocks(undefined)[0]?.message).toContain('no mocks found');
  });

  it('leaves a resolver result alone unless probe variables are supplied', () => {
    const mock = {
      request: { query: UserQuery },
      result: (variables: { id: string }) => ({ data: { user: { id: variables.id } } }),
    };
    expect(validateMocks(mock)).toEqual([]);
    expect(validateMocks(mock, { probeVariables: { id: '1' } })).toEqual([]);
  });

  it('probes a resolver result and reports what comes back', () => {
    const issues = validateMocks(
      { request: { query: UserQuery }, result: () => ({ data: {} }) },
      { probeVariables: {} },
    );
    expect(issues[0]?.path).toBe('mocks.result().data');
  });

  it('reports a resolver that throws on the probe variables', () => {
    const issues = validateMocks(
      {
        request: { query: UserQuery },
        result: (variables: { id: string }) => ({ data: { id: variables.id.trim() } }),
      },
      { probeVariables: {} },
    );
    expect(issues[0]?.message).toContain('threw when called');
  });
});

describe('assertValidMocks', () => {
  it('returns quietly for valid mocks', () => {
    expect(() => assertValidMocks(validMock())).not.toThrow();
  });

  it('throws listing every problem, with operation names', () => {
    expect(() =>
      assertValidMocks([
        { request: { query: UserQuery }, result: { data: () => null } },
        { request: { query: UserQuery }, result: {} },
      ]),
    ).toThrow(/2 invalid mocks[\s\S]*\(User\)[\s\S]*neither `data` nor `errors`/);
  });

  it('counts a single problem in the singular', () => {
    expect(() => assertValidMocks({ request: { query: UserQuery }, result: {} })).toThrow(
      /1 invalid mock:/,
    );
  });
});

describe('mockOperation warning', () => {
  it('warns when the data argument is an envelope wrapping a resolver', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockOperation(UserQuery, { data: () => ({ user: { id: '1' } }) } as never);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('mockOperation(User)');
    expect(warn.mock.calls[0]?.[0]).toContain('never invokes');
  });

  it('warns once for the three mocks a variants trio builds', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockOperationVariants(UserQuery, { data: () => ({ user: { id: '1' } }) } as never);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('stays quiet for both correct shapes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockOperation(UserQuery, { user: { id: '1', name: 'Ada' } });
    mockOperation(UserQuery, () => ({ user: { id: '1', name: 'Ada' } }));
    expect(warn).not.toHaveBeenCalled();
  });
});
