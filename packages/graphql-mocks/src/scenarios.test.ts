import { describe, expect, it, vi } from 'vitest';
import { buildMocks } from './mockSchema.js';
import { DEFAULT_HUGE_LIST_SIZE } from './qa.js';
import { composeScenarios, defineScenarios, mergeScenarios } from './scenarios.js';
import { schema } from './test/schema.js';
import type { Scenario } from './types.js';

// Relationship fields are skipped because the wired graph is circular, and the DateTime
// fields because `faker.date.recent()` is wall-clock relative. Same helper as qaSets.test.ts.
const CLOCK_RELATIVE = new Set(['createdAt', 'dueDate', 'publishedAt']);

const scalarFields = (items: unknown[]) =>
  JSON.stringify(
    (items as Record<string, unknown>[]).map((item) =>
      Object.fromEntries(
        Object.entries(item).filter(
          ([key, value]) => typeof value !== 'object' && !CLOCK_RELATIVE.has(key),
        ),
      ),
    ),
  );

describe('mergeScenarios', () => {
  it('returns an empty config for no layers', () => {
    expect(mergeScenarios([])).toEqual({});
  });

  it('lets a later layer win for unstructured keys', () => {
    const merged = mergeScenarios([
      { nullChance: 0.5, stableIds: true, addTypename: false },
      { nullChance: 0 },
    ]);
    expect(merged).toEqual({ nullChance: 0, stableIds: true, addTypename: false });
  });

  it('ignores an explicit undefined rather than unsetting the earlier value', () => {
    expect(mergeScenarios([{ nullChance: 0.5 }, { nullChance: undefined }])).toEqual({
      nullChance: 0.5,
    });
  });

  it('replaces count outright when the later layer is a number', () => {
    expect(mergeScenarios([{ count: { User: 3 } }, { count: 1 }])).toEqual({ count: 1 });
  });

  it('merges count map over count map, per type', () => {
    expect(mergeScenarios([{ count: { User: 3, Todo: 9 } }, { count: { Todo: 1 } }])).toEqual({
      count: { User: 3, Todo: 1 },
    });
  });

  it('promotes an earlier flat count to _default under a later map', () => {
    expect(mergeScenarios([{ count: 2 }, { count: { User: 7 } }])).toEqual({
      count: { _default: 2, User: 7 },
    });
  });

  it('merges qa dimension by dimension, expanding preset names', () => {
    expect(mergeScenarios([{ qa: 'longText' }, { qa: { lists: 'huge' } }])).toEqual({
      qa: { text: 'long', lists: 'huge' },
    });
  });

  it('resets qa on false and turns it back on for a later config', () => {
    expect(mergeScenarios([{ qa: 'longText' }, { qa: false }])).toEqual({ qa: false });
    expect(mergeScenarios([{ qa: 'longText' }, { qa: false }, { qa: { nulls: 'all' } }])).toEqual({
      qa: { nulls: 'all' },
    });
  });

  it('disables qa when a later layer names an unknown preset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mergeScenarios([{ qa: 'longText' }, { qa: 'nope' as never }])).toEqual({
      qa: undefined,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unknown qa profile'));
    warn.mockRestore();
  });

  it('merges scalars shallowly by scalar name', () => {
    const iso = () => 'iso';
    const city = () => 'city';
    expect(
      mergeScenarios([
        { scalars: { DateTime: iso, CityName: city } },
        { scalars: { CityName: iso } },
      ]),
    ).toEqual({ scalars: { DateTime: iso, CityName: iso } });
  });

  it('merges overrides two levels deep', () => {
    const alice = () => 'Alice';
    const zero = () => 0;
    const merged = mergeScenarios([
      { overrides: { User: { name: alice, loginCount: zero } } },
      { overrides: { User: { loginCount: () => 5 }, Todo: { title: alice } } },
    ]);
    expect(merged.overrides).toEqual({
      User: { name: alice, loginCount: expect.any(Function) },
      Todo: { title: alice },
    });
    expect((merged.overrides as { User: { loginCount: () => number } }).User.loginCount()).toBe(5);
  });

  it('merges relations per type and per field', () => {
    expect(
      mergeScenarios([
        { relations: { User: { todos: 3, posts: 1 } } },
        { relations: { User: { posts: 0 }, Post: { comments: 2 } } },
      ]),
    ).toEqual({ relations: { User: { todos: 3, posts: 0 }, Post: { comments: 2 } } });
  });

  it('assigns rather than merges reserved relation keys', () => {
    expect(
      mergeScenarios([
        { relations: { _default: { min: 1, max: 5 }, _reciprocal: true } },
        { relations: { _default: { min: 2, max: 2 } } },
      ]),
    ).toEqual({ relations: { _default: { min: 2, max: 2 }, _reciprocal: true } });
  });

  it('replaces a relations map with a later flat form', () => {
    expect(mergeScenarios([{ relations: { User: { todos: 3 } } }, { relations: 0 }])).toEqual({
      relations: 0,
    });
  });

  it('warns when a later qa layer cannot reach a scalar an earlier layer pinned', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mergeScenarios([{ scalars: { String: () => 'pinned' } }, { qa: 'longText' }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('a later qa layer cannot reach'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('String'));
    warn.mockRestore();
  });

  it('stays quiet when the layers do not overlap or qa came first', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Rating is a custom scalar the QA generators never claim, so there is nothing to shadow.
    mergeScenarios([{ scalars: { Rating: () => 5 } }, { qa: 'longText' }]);
    mergeScenarios([{ qa: 'longText' }, { scalars: { String: () => 'pinned' } }]);
    mergeScenarios([{ scalars: { String: () => 'pinned' }, qa: 'longText' }]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('defineScenarios', () => {
  it('returns the map it was given, keys intact', () => {
    const scenarios = defineScenarios({
      newUser: { description: 'nothing yet', relations: { User: { todos: null } } },
      powerUser: { relations: { User: { todos: 20 } } },
    });
    expect(Object.keys(scenarios)).toEqual(['newUser', 'powerUser']);
    expect(scenarios.newUser.description).toBe('nothing yet');
  });
});

describe('composeScenarios', () => {
  it('folds scenarios left to right into one', () => {
    const composed = composeScenarios(
      { count: 2, relations: { User: { todos: 3 } } },
      { relations: { User: { posts: 0 } }, nullChance: 0 },
    );
    expect(composed).toEqual({
      count: 2,
      relations: { User: { todos: 3, posts: 0 } },
      nullChance: 0,
    });
  });

  it('produces a scenario that can be composed again', () => {
    const base = composeScenarios({ count: 2 }, { relations: { User: { todos: 1 } } });
    expect(composeScenarios(base, { count: 4 })).toEqual({
      count: 4,
      relations: { User: { todos: 1 } },
    });
  });
});

describe('buildMocks scenario', () => {
  const newUser: Scenario = {
    description: 'a user who has done nothing yet',
    count: { User: 1, _default: 3 },
    relations: { User: { todos: null, posts: null } },
    overrides: { User: { loginCount: () => 0 } },
  };
  const verbose: Scenario = { qa: 'longText', relations: { Post: { comments: 2 } } };

  it('builds from a single scenario', () => {
    const mocks = buildMocks(schema, { scenario: newUser, seed: 42 });
    const users = mocks.User as Record<string, unknown>[];
    expect(users).toHaveLength(1);
    expect(users[0]?.loginCount).toBe(0);
    expect(users[0]?.todos).toEqual([]);
  });

  it('matches a hand-merged build for an array of scenarios', () => {
    const layered = buildMocks(schema, { scenario: [newUser, verbose], seed: 42, count: 2 });
    const hand = buildMocks(schema, {
      seed: 42,
      count: 2,
      qa: 'longText',
      relations: { User: { todos: null, posts: null }, Post: { comments: 2 } },
      overrides: { User: { loginCount: () => 0 } },
    });
    expect(scalarFields(layered.User)).toBe(scalarFields(hand.User));
    expect(scalarFields(layered.Post)).toBe(scalarFields(hand.Post));
    expect((layered.Post as Record<string, unknown>[])[0]?.comments).toHaveLength(2);
  });

  it('lets explicit build options win over every scenario layer', () => {
    const mocks = buildMocks(schema, { scenario: newUser, seed: 42, count: { User: 4 } });
    expect(mocks.User).toHaveLength(4);
    // The scenario's own `_default` survives the merge with the explicit User count.
    expect(mocks.Todo).toHaveLength(3);
  });

  it('resolves qa through the scenario layers, pool growth included', () => {
    const mocks = buildMocks(schema, { scenario: [{ qa: 'hugeLists' }], seed: 42 });
    expect(mocks.Todo).toHaveLength(DEFAULT_HUGE_LIST_SIZE);
    expect((mocks.User as Record<string, unknown>[])[0]?.todos).toHaveLength(
      DEFAULT_HUGE_LIST_SIZE,
    );
  });

  it('does not warn about scalar precedence for a plain scalars-plus-qa build', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildMocks(schema, { seed: 42, count: 1, scalars: { String: () => 'pinned' }, qa: 'longText' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
