import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { parse } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMocks } from './mockSchema.js';
import { schema } from './test/schema.js';

type UsersData = { users: { id: string }[] };
type TodosData = { todos: { id: string }[] };

const UsersDocument = parse('query Users { users { id } }') as TypedDocumentNode<
  UsersData,
  Record<string, never>
>;
const TodosDocument = parse('query Todos { todos { id } }') as TypedDocumentNode<
  TodosData,
  Record<string, never>
>;

const operations = {
  UsersDocument,
  TodosDocument,
  // The kind of non-document export codegen modules are full of.
  UsersFragmentDoc: parse('fragment U on User { id }'),
  someHelper: () => 1,
  aNumber: 4,
  nothing: null,
};

const graph = () => buildMocks(schema, { seed: 13, count: 4, stableIds: true });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mockOperationsFrom', () => {
  it('keys the map by export name, skipping non-operation exports', () => {
    const mocks = graph().mockOperationsFrom(operations);
    expect(Object.keys(mocks).sort()).toEqual(['TodosDocument', 'UsersDocument']);
  });

  it('builds a full variants trio per operation, with data from the graph', () => {
    const mocks = graph().mockOperationsFrom(operations);
    expect(mocks.UsersDocument.withResults.result?.data?.users?.length).toBeGreaterThan(0);
    expect(mocks.TodosDocument.withResults.result?.data?.todos?.length).toBeGreaterThan(0);
    expect(mocks.UsersDocument.withLongLoadTime.delay).toBe(1_000_000);
    expect(mocks.UsersDocument.withError.error?.message).toContain('Users');
  });

  it('builds nothing until an entry is read', () => {
    let resolved = 0;
    const built = graph().mockOperationsFrom(operations, {
      transform: (data) => {
        resolved += 1;
        return data;
      },
    });
    // Listing the keys must not force the entries.
    expect(Object.keys(built)).toHaveLength(2);
    expect(resolved).toBe(0);

    void built.UsersDocument;
    expect(resolved).toBe(1);
    void built.UsersDocument;
    expect(resolved).toBe(1);

    // Spreading forces the rest.
    void { ...built };
    expect(resolved).toBe(2);
  });

  it('caches an entry so repeat reads return the same object', () => {
    const mocks = graph().mockOperationsFrom(operations);
    expect(mocks.UsersDocument).toBe(mocks.UsersDocument);
  });

  it('shares one variants object between export names aliasing a document, warning once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const aliased = { UsersDocument, UsersQuery: UsersDocument, AlsoUsers: UsersDocument };
    const mocks = graph().mockOperationsFrom(aliased);
    expect(mocks.UsersQuery).toBe(mocks.UsersDocument);
    expect(mocks.AlsoUsers).toBe(mocks.UsersDocument);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('same document'))).toHaveLength(1);
  });

  it('threads options through to every entry', () => {
    const mocks = graph().mockOperationsFrom(operations, { maxUsageCount: 3, delay: 7 });
    expect(mocks.UsersDocument.withResults.maxUsageCount).toBe(3);
    expect(mocks.UsersDocument.withResults.delay).toBe(7);
    // The long-load variant still overrides delay.
    expect(mocks.UsersDocument.withLongLoadTime.delay).toBe(1_000_000);
  });

  it('returns an empty map for a module with no documents', () => {
    expect(Object.keys(graph().mockOperationsFrom({ a: 1, b: 'x' }))).toEqual([]);
  });
});
