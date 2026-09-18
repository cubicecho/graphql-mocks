import { describe, expect, it } from 'vitest';
import { buildMocks } from './mockSchema.js';
import { schema } from './test/schema.js';
import type { BuildMocksOptions, DeriveConfig, OverridesConfig } from './types.js';

/**
 * Stands in for a codegen `SchemaTypeMap` built from fragment types: it carries `User`, and it
 * carries only the fields a fragment happened to select. `headline` and `todoCount` below are
 * the fields a real map is missing — one the fragment skipped, one that exists only in the mock.
 *
 * A type alias rather than an interface, for the same reason `scenarios.test.ts` uses one: an
 * interface has no implicit index signature and so would not satisfy `Record<string, unknown>`.
 */
type TestTypes = { User: { name: string; loginCount: number; todos: unknown[] } };

describe('a TTypes map as a hint', () => {
  it('still binds a mapped field to its own type', () => {
    const overrides: OverridesConfig<TestTypes> = {
      User: {
        name: () => 'Ada',
        // @ts-expect-error — `loginCount` is a number in the map, and the map still rules there.
        loginCount: () => 'many',
      },
    };

    expect(Object.keys(overrides.User ?? {})).toEqual(['name', 'loginCount']);
  });

  it('accepts a field the map does not carry, with an unknown return', () => {
    const overrides: OverridesConfig<TestTypes> = {
      User: { name: () => 'Ada', headline: () => 'Ada L, engineer' },
    };

    expect(Object.keys(overrides.User ?? {})).toEqual(['name', 'headline']);
  });

  it('keeps `self` bound on a derive for an unmapped field', () => {
    const derive: DeriveConfig<TestTypes> = {
      // `todoCount` is not in the map; `self.todos` is, and stays typed through it.
      User: { todoCount: (self) => self.todos.length },
    };

    expect(Object.keys(derive.User ?? {})).toEqual(['todoCount']);
  });

  it('still checks type names, which is where a typo is a typo', () => {
    const options: BuildMocksOptions<TestTypes> = {
      // @ts-expect-error — `Post` is not a key of the map.
      overrides: { Post: { title: () => 'Hello' } },
    };

    expect(options.overrides).toBeDefined();
  });

  it('generates the unmapped fields it was given', () => {
    const mocks = buildMocks<TestTypes>(schema, {
      seed: 5,
      count: 2,
      overrides: { User: { name: () => 'Ada' } },
      derive: { User: { todoCount: (self) => self.todos.length } },
    });

    expect(mocks.User[0]?.name).toBe('Ada');
    // The hint is on the options, not on `MockResult`: a pooled instance is still typed by the
    // map alone, so reading a mock-only field back is a deliberate cast.
    const user = mocks.User[0] as Record<string, unknown>;
    expect(user.todoCount).toBe(mocks.User[0]?.todos.length);
  });
});
