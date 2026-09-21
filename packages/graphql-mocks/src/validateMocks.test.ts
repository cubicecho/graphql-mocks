import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { buildSchema, parse } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockOperation, mockOperationVariants } from './apolloMocks.js';
import { buildMocks } from './mockSchema.js';
import { buildOperationMocks } from './operationsFrom.js';
import { assertValidMocks, containsMocks, validateMocks } from './validateMocks.js';

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

  it('tags the empty report so a caller can tell it from a real defect', () => {
    // Without the tag, "this fixture module holds no mocks on purpose" and "this module stopped
    // exporting its mocks" are the same string, and filtering one drops the other silently.
    const empty = validateMocks({ SOME_CONSTANT: 'unrelated' });
    expect(empty).toHaveLength(1);
    expect(empty[0]?.kind).toBe('empty');

    const broken = validateMocks({ request: { query: UserQuery }, result: {} });
    expect(broken.every((issue) => issue.kind === 'invalid')).toBe(true);
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

describe('cyclic exports', () => {
  /** The arrangement the docs recommend: the pool a module builds, next to the mocks built from it. */
  const schema = buildSchema(`
    type Category { id: ID!, name: String!, products: [Product!]! }
    type Product { id: ID!, name: String!, category: Category! }
    type Query { products: [Product!]! }
  `);

  const moduleNamespace = () => {
    const mocks = buildMocks(schema, { seed: 3, count: 4, stableIds: true });
    return {
      productPool: mocks.Product,
      ProductListMocks: mockOperationVariants(UserQuery, { user: { id: '1', name: 'Ada' } }),
    };
  };

  it('walks a module that also exports built mock data', () => {
    const namespace = moduleNamespace();
    const pool = namespace.productPool as { category: { products: unknown[] } }[];
    // The cycle the walk used to fall into, asserted so the test still means something if the
    // builder ever stops mirroring relationships.
    expect(pool[0]?.category.products).toContain(pool[0]);

    const issues = validateMocks(namespace);
    expect(issues).toEqual([]);
  });

  it('finds the mocks in that module rather than skipping the export wholesale', () => {
    const namespace = {
      ...moduleNamespace(),
      BrokenMocks: { request: { query: UserQuery }, result: { data: () => ({}) } },
    };
    const issues = validateMocks(namespace);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('mocks.BrokenMocks.result.data');
  });

  it('reports a mock reachable at two paths once', () => {
    const shared = validMock();
    expect(validateMocks({ a: shared, b: shared })).toEqual([]);
    const broken = { request: { query: UserQuery }, result: {} };
    const issues = validateMocks({ a: broken, b: broken });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('mocks.a.result');
  });
});

describe('a mockOperationsFrom map', () => {
  const schema = buildSchema(`
    type User { id: ID!, name: String! }
    type Query { users: [User!]! }
  `);
  const documents = {
    UsersDocument: parse('query Users { users { id name } }'),
    NOT_A_DOCUMENT: 'ignore me',
  };

  it('is walked to the same depth as a hand-written module', () => {
    // Three levels, not the two a hand-written module nests: module → keyed map → export name
    // → variants trio → mock. Forcing the map's lazy entries is the point of validating it.
    const mocks = buildMocks(schema, { seed: 2, count: 2, stableIds: true });
    const module = { userMocks: mocks.mockOperationsFrom(documents as never) };

    expect(validateMocks(module)).toEqual([]);
  });

  it('still reports a problem reached through the map', () => {
    const mocks = buildMocks(schema, { seed: 2, count: 2, stableIds: true });
    const module = {
      userMocks: mocks.mockOperationsFrom(documents as never),
      handWritten: { BrokenMocks: { request: { query: UserQuery }, result: {} } },
    };

    const issues = validateMocks(module);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('mocks.handWritten.BrokenMocks.result');
  });

  it('reports a map with no documents in it as empty', () => {
    const mocks = buildMocks(schema, { seed: 2, count: 2 });
    const issues = validateMocks({ userMocks: mocks.mockOperationsFrom({ NOPE: 1 } as never) });
    expect(issues[0]?.kind).toBe('empty');
  });
});

describe('validateMocks with allowEmpty', () => {
  it('drops the empty report, so a fixture module passes a glob-wide check', () => {
    expect(validateMocks({ tableRows: [{ id: 1 }], title: 'x' }, { allowEmpty: true })).toEqual([]);
  });

  it('still reports the real problems in a module that does hold mocks', () => {
    const issues = validateMocks(
      { m: { request: { query: UserQuery }, result: {} } },
      {
        allowEmpty: true,
      },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('invalid');
  });

  it('reports empty by default, which is what catches a module losing its mocks', () => {
    expect(validateMocks({ tableRows: [{ id: 1 }] })[0]?.kind).toBe('empty');
  });
});

describe('containsMocks', () => {
  const graphSchema = buildSchema(`
    type User { id: ID!, name: String! }
    type Category { id: ID!, name: String!, products: [Product!]! }
    type Product { id: ID!, name: String!, category: Category! }
    type Query { users: [User!]!, products: [Product!]! }
  `);
  const documents = {
    UsersDocument: parse('query Users { users { id name } }'),
    TodosDocument: parse('query Users2 { users { id } }'),
    NOT_A_DOCUMENT: 'ignore me',
  };

  it('is true for one mock, an array, a variants trio and a module namespace', () => {
    expect(containsMocks(validMock())).toBe(true);
    expect(containsMocks([validMock()])).toBe(true);
    expect(containsMocks(mockOperationVariants(UserQuery, { user: { id: '1', name: 'A' } }))).toBe(
      true,
    );
    expect(containsMocks({ userMocks: { byName: [validMock()] } })).toBe(true);
  });

  it('is false for a fixture-only module, which is what a glob picks up', () => {
    expect(containsMocks({ series: [{ x: 1, y: 2 }], title: 'Sales', render: () => null })).toBe(
      false,
    );
    expect(containsMocks({})).toBe(false);
    expect(containsMocks(undefined)).toBe(false);
    expect(containsMocks('mocks')).toBe(false);
  });

  it('is true for a mock that is broken but present, so filtering never hides a defect', () => {
    // The whole point of filtering by this before validating: an invalid mock must stay in.
    const broken = { brokenMocks: { request: { query: UserQuery }, result: {} } };
    expect(containsMocks(broken)).toBe(true);
    expect(validateMocks(broken)).toHaveLength(1);
  });

  it('survives a module that also exports a built pool, whose objects are cyclic', () => {
    const mocks = buildMocks(graphSchema, { seed: 3, count: 4, stableIds: true });
    const pool = mocks.Product as { category: { products: unknown[] } }[];
    expect(pool[0]?.category.products).toContain(pool[0]); // the cycle, asserted

    expect(containsMocks({ productPool: pool })).toBe(false);
    expect(containsMocks({ productPool: pool, ProductMocks: validMock() })).toBe(true);
  });

  it('answers for a mockOperationsFrom map without building a single entry', () => {
    let built = 0;
    const lazy = buildOperationMocks(documents, (document) => {
      built += 1;
      return mockOperationVariants(document as never, { users: [] } as never);
    });

    expect(containsMocks({ operationMocks: lazy })).toBe(true);
    expect(built).toBe(0);

    // Proof the entries really were reachable — and that reaching them costs what we avoided.
    expect(validateMocks({ operationMocks: lazy }, { requireData: false })).toEqual([]);
    expect(built).toBe(2);
  });

  it('never reads an entry, even one that would throw on access', () => {
    const exploding = buildOperationMocks(documents, () => {
      throw new Error('an entry was forced');
    });

    expect(() => containsMocks({ operationMocks: exploding })).not.toThrow();
    expect(containsMocks({ operationMocks: exploding })).toBe(true);
  });

  it('is false for a map whose module held no documents', () => {
    const empty = buildOperationMocks({ NOPE: 1 }, () => ({}));
    expect(containsMocks({ operationMocks: empty })).toBe(false);
  });

  it('is true for a map built from the graph, with nothing resolved', () => {
    let resolved = 0;
    const mocks = buildMocks(graphSchema, { seed: 2, count: 2, stableIds: true });
    const lazy = mocks.mockOperationsFrom(documents as never, {
      transform: (data) => {
        resolved += 1;
        return data;
      },
    });

    expect(containsMocks(lazy)).toBe(true);
    expect(containsMocks({ userMocks: lazy })).toBe(true);
    expect(resolved).toBe(0);
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
