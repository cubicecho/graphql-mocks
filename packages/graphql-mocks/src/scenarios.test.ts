import { parse } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { buildMocks } from './mockSchema.js';
import { mockScenarios } from './scenarios.js';
import { schema } from './test/schema.js';

const UsersQuery = parse('query Users { users { id } }');
const TodosQuery = parse('query Todos { todos { id } }');

const graph = () => buildMocks(schema, { seed: 5, count: 4, stableIds: true });

describe('mockScenarios', () => {
  it('leaves the default scenario resolving from the graph', async () => {
    const { default: normal } = mockScenarios();
    const result = await graph().toRequestHandler(normal)({ query: UsersQuery });
    expect((result.data as { users: unknown[] }).users.length).toBeGreaterThan(0);
    expect(result.errors).toBeUndefined();
  });

  it('keeps every operation pending in the loading scenario', async () => {
    vi.useFakeTimers();
    try {
      const { loading } = mockScenarios();
      let settled = false;
      graph()
        .toRequestHandler(loading)({ query: UsersQuery })
        .then(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(1_000_000);
      expect(settled).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails every operation in the errored scenario', async () => {
    const { errored } = mockScenarios();
    const result = await graph().toRequestHandler(errored)({ query: UsersQuery });
    expect(result.data).toBeNull();
    expect(result.errors?.[0]?.message).toContain('scenario error');
  });

  it('carries the base options into every scenario', () => {
    const scenarios = mockScenarios({ memoize: false, matchArguments: true });
    for (const options of Object.values(scenarios)) {
      expect(options.memoize).toBe(false);
      expect(options.matchArguments).toBe(true);
    }
  });

  it('narrows to a single target, leaving other operations normal', async () => {
    const { errored } = mockScenarios({}, 'Users');
    const handler = graph().toRequestHandler(errored);
    expect((await handler({ query: UsersQuery })).errors?.[0]?.message).toContain('scenario error');
    expect((await handler({ query: TodosQuery })).errors).toBeUndefined();
  });

  it('accepts a list of targets', async () => {
    const { errored } = mockScenarios({}, ['Users', TodosQuery]);
    const handler = graph().toRequestHandler(errored);
    expect((await handler({ query: UsersQuery })).errors).toBeDefined();
    expect((await handler({ query: TodosQuery })).errors).toBeDefined();
  });

  it('accepts a predicate target', async () => {
    const { errored } = mockScenarios({}, (info) => info.operationName === 'Todos');
    const handler = graph().toRequestHandler(errored);
    expect((await handler({ query: UsersQuery })).errors).toBeUndefined();
    expect((await handler({ query: TodosQuery })).errors).toBeDefined();
  });

  it('puts the scenario override ahead of the base overrides but keeps them reachable', async () => {
    const { errored } = mockScenarios(
      { overrides: [{ match: 'Todos', data: { todos: [] } }] },
      'Users',
    );
    const handler = graph().toRequestHandler(errored);
    expect((await handler({ query: UsersQuery })).errors).toBeDefined();
    expect((await handler({ query: TodosQuery })).data).toEqual({ todos: [] });
  });
});
