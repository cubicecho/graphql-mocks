import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import { buildMocks } from './mockSchema.js';
import { schema } from './test/schema.js';
import type {
  BuildMocksOptions,
  DeriveConfig,
  DeriveContext,
  FieldDeriveFn,
  ObjectDeriveConfig,
  OverridesConfig,
} from './types.js';

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

describe('a precisely typed derive block (#68)', () => {
  // A generic helper makes the arrow that calls it context-sensitive: its parameter types have
  // to be inferred from the contextual type rather than checked against it, which is the shape
  // an intersection is most likely to defeat.
  const count = <T>(items: readonly T[]) => items.length;

  it('binds `self` on derives written inline in parameterized options', () => {
    const options: BuildMocksOptions<TestTypes> = {
      derive: {
        User: {
          loginCount: (self) => count(self.todos),
          name: (self, ctx: DeriveContext) => `${self.name.trim()}-${ctx.index}`,
        },
      },
    };

    expect(Object.keys(options.derive?.User ?? {})).toEqual(['loginCount', 'name']);
  });

  it('still binds a mapped field to its own type', () => {
    const derive: DeriveConfig<TestTypes> = {
      // @ts-expect-error — `loginCount` is a number in the map, and the map still rules there.
      User: { loginCount: (self) => self.name },
    };

    expect(derive.User).toBeDefined();
  });

  it('accepts a derive for a field name the map does not carry', () => {
    const derive: DeriveConfig<TestTypes> = {
      // `todoCount` is not in the map; `self` stays typed and the return falls back to unknown.
      User: { todoCount: (self) => count(self.todos) },
    };
    const loose: BuildMocksOptions = { derive };

    expect(Object.keys(loose.derive?.User ?? {})).toEqual(['todoCount']);
  });

  it('flows a separately declared block into options carrying no map', () => {
    // The route that used to force a cast: declare the block precisely, then hand it to an
    // option whose `self` is erased to `Record<string, unknown>`.
    const userDerives: NonNullable<DeriveConfig<TestTypes>['User']> = {
      loginCount: (self) => count(self.todos),
    };
    const options: BuildMocksOptions = { derive: { User: userDerives } };

    const whole: DeriveConfig<TestTypes> = { User: userDerives };
    const erased: DeriveConfig = whole;

    expect(options.derive?.User).toBe(userDerives);
    expect(erased.User).toBe(userDerives);
  });

  it('still takes a derive with no map at all, `self` loose', () => {
    const derive: DeriveConfig = {
      Anything: { headline: (self) => String(self.name ?? '').trim() },
    };
    const fn: FieldDeriveFn = (self) => count(Object.keys(self));

    expect(typeof derive.Anything?.headline).toBe('function');
    expect(fn({ a: 1 }, { index: 0, typeName: 'X', fieldName: 'y', faker })).toBe(1);
  });

  it('runs a separately declared block through buildMocks', () => {
    const userDerives: NonNullable<DeriveConfig<TestTypes>['User']> = {
      todoCount: (self) => count(self.todos),
    };
    const mocks = buildMocks<TestTypes>(schema, {
      seed: 5,
      count: 2,
      derive: { User: userDerives },
    });

    const user = mocks.User[0] as Record<string, unknown>;
    expect(user.todoCount).toBe(mocks.User[0]?.todos.length);
  });
});

describe('a TTypes map on an object derive', () => {
  it('binds `self` even when the body is context-sensitive', () => {
    // The shape that defeats contextual typing in `derive` (#68): an arrow whose body calls a
    // generic helper, so its parameter types have to be inferred rather than checked.
    const count = <T>(items: readonly T[]) => items.length;
    const deriveObject: ObjectDeriveConfig<TestTypes> = {
      User: (self) => ({ loginCount: count(self.todos), name: self.name.trim() }),
    };

    expect(typeof deriveObject.User).toBe('function');
  });

  it('binds a returned field the map carries to its own type', () => {
    const deriveObject: ObjectDeriveConfig<TestTypes> = {
      // @ts-expect-error — `loginCount` is a number in the map, and the map still rules there.
      User: () => ({ loginCount: 'many' }),
    };

    expect(deriveObject.User).toBeDefined();
  });

  it('accepts a returned field the map does not carry', () => {
    const deriveObject: ObjectDeriveConfig<TestTypes> = {
      User: (self) => ({ name: self.name, headline: `${self.name}, engineer` }),
    };

    expect(deriveObject.User).toBeDefined();
  });

  it('still checks type names', () => {
    const options: BuildMocksOptions<TestTypes> = {
      // @ts-expect-error — `Post` is not a key of the map.
      deriveObject: { Post: () => ({ title: 'Hello' }) },
    };

    expect(options.deriveObject).toBeDefined();
  });

  it('types the option inline on a parameterized buildMocks call', () => {
    const mocks = buildMocks<TestTypes>(schema, {
      seed: 5,
      count: 2,
      deriveObject: { User: (self) => ({ name: 'Ada', todoCount: self.todos.length }) },
    });

    expect(mocks.User[0]?.name).toBe('Ada');
    const user = mocks.User[0] as Record<string, unknown>;
    expect(user.todoCount).toBe(mocks.User[0]?.todos.length);
  });
});
