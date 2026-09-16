import { faker } from '@faker-js/faker';
import { parse } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { buildMocks } from './mockSchema.js';
import {
  DEFAULT_HUGE_LIST_SIZE,
  QA_PROFILES,
  QA_PROFILE_NAMES,
  qaDefaultCount,
  qaFallbackText,
  qaListLength,
  qaNullChance,
  qaScalarMockers,
  qaText,
  resolveQa,
} from './qa.js';
import { schema } from './test/schema.js';
import type { QaConfig } from './types.js';

const seeded = (qa: QaConfig | string) =>
  buildMocks(schema, { faker, seed: 7, qa: qa as QaConfig, resolveType: () => 'User' });

const users = (r: ReturnType<typeof seeded>) => r.User as Record<string, unknown>[];

describe('resolveQa', () => {
  it('returns undefined when qa is unset or false', () => {
    expect(resolveQa(undefined)).toBeUndefined();
    expect(resolveQa(false)).toBeUndefined();
  });

  it('expands a preset name into its config', () => {
    expect(resolveQa('longText')).toEqual({ text: 'long', listSize: DEFAULT_HUGE_LIST_SIZE });
  });

  it('passes an explicit config through and defaults listSize', () => {
    expect(resolveQa({ text: 'empty', lists: 'huge' })).toEqual({
      text: 'empty',
      lists: 'huge',
      listSize: DEFAULT_HUGE_LIST_SIZE,
    });
    expect(resolveQa({ lists: 'huge', listSize: 12 })?.listSize).toBe(12);
  });

  it('warns and disables QA mode for an unknown preset name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Cast: the point is to exercise the runtime guard a JS caller can still trip.
    expect(resolveQa('nope' as never)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unknown qa profile'));
    warn.mockRestore();
  });

  it('exposes every profile name in QA_PROFILE_NAMES', () => {
    expect(QA_PROFILE_NAMES).toEqual(Object.keys(QA_PROFILES));
    expect(QA_PROFILE_NAMES).toContain('kitchenSink');
  });
});

describe('qaText', () => {
  it('returns an empty string for the empty profile', () => {
    expect(qaText(faker, 'empty')).toBe('');
  });

  it('returns whitespace-only strings for the whitespace profile', () => {
    for (let i = 0; i < 20; i++) {
      const value = qaText(faker, 'whitespace');
      expect(value.length).toBeGreaterThan(0);
      expect(value.trim()).toBe('');
    }
  });

  it('returns strings long enough to overflow a layout', () => {
    for (let i = 0; i < 10; i++) {
      expect(qaText(faker, 'long').length).toBeGreaterThanOrEqual(1000);
    }
  });

  it('returns non-ASCII strings for the unicode profile', () => {
    for (let i = 0; i < 20; i++) {
      expect(/[^\x20-\x7e]/.test(qaText(faker, 'unicode'))).toBe(true);
    }
  });

  it('covers markup, template and traversal shapes in the injection profile', () => {
    const values = new Set(Array.from({ length: 200 }, () => qaText(faker, 'injection')));
    expect(values.size).toBeGreaterThan(1);
    for (const value of values) expect(value.length).toBeGreaterThan(0);
    // Each family fails a different layer, so the corpus has to keep reaching all of them.
    const all = [...values].join('\n');
    expect(all).toMatch(/<script>|<img|<svg/);
    expect(all).toMatch(/\{\{.*\}\}|\$\{.*\}/);
    expect(all).toMatch(/\.\.\//);
  });
});

describe('qaScalarMockers', () => {
  it('claims string scalars for a text profile but leaves ID alone', () => {
    const mockers = qaScalarMockers({ text: 'empty', listSize: 100 });
    expect(mockers.String).toBeDefined();
    expect(mockers.CityName).toBeDefined();
    expect(mockers.EmailAddress).toBeDefined();
    // IDs are the graph's identity and Apollo's cache keys, so QA text must not touch them.
    expect(mockers.ID).toBeUndefined();
  });

  it('claims only the dimensions the config enables', () => {
    const textOnly = qaScalarMockers({ text: 'long', listSize: 100 });
    expect(textOnly.Int).toBeUndefined();
    expect(textOnly.DateTime).toBeUndefined();

    const numbersOnly = qaScalarMockers({ numbers: 'zero', listSize: 100 });
    expect(numbersOnly.String).toBeUndefined();
    expect(numbersOnly.Int?.(faker)).toBe(0);
    expect(numbersOnly.Float?.(faker)).toBe(0);
    expect(numbersOnly.BigInt?.(faker)).toBe(0n);
    expect(numbersOnly.Decimal?.(faker)).toBe('0');
  });

  it('keeps boundary integers inside the range GraphQL Int can serialize', () => {
    const mockers = qaScalarMockers({ numbers: 'boundary', listSize: 100 });
    for (let i = 0; i < 100; i++) {
      const value = mockers.Int?.(faker) as number;
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(-2_147_483_648);
      expect(value).toBeLessThanOrEqual(2_147_483_647);
    }
  });

  it('produces parseable timestamps for every date profile', () => {
    for (const dates of ['epoch', 'farPast', 'farFuture', 'mixed'] as const) {
      const mockers = qaScalarMockers({ dates, listSize: 100 });
      for (let i = 0; i < 20; i++) {
        expect(Number.isNaN(Date.parse(mockers.DateTime?.(faker) as string))).toBe(false);
      }
      expect(mockers.Date?.(faker)).toMatch(/^-?\d{4}-\d{2}-\d{2}$/);
      expect(mockers.Time?.(faker)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    }
  });
});

describe('qaListLength / qaNullChance / qaDefaultCount', () => {
  it('returns the caller fallback when no list profile is active', () => {
    expect(qaListLength(undefined, { min: 1, max: 5 })).toEqual({ min: 1, max: 5 });
    expect(qaListLength({ text: 'long', listSize: 100 }, { min: 1, max: 3 })).toEqual({
      min: 1,
      max: 3,
    });
  });

  it('maps each list profile to concrete bounds', () => {
    expect(qaListLength({ lists: 'empty', listSize: 100 }, { min: 1, max: 5 })).toEqual({
      min: 0,
      max: 0,
    });
    expect(qaListLength({ lists: 'single', listSize: 100 }, { min: 1, max: 5 })).toEqual({
      min: 1,
      max: 1,
    });
    expect(qaListLength({ lists: 'huge', listSize: 42 }, { min: 1, max: 5 })).toEqual({
      min: 42,
      max: 42,
    });
  });

  it('maps null profiles onto a null probability', () => {
    expect(qaNullChance(undefined)).toBeUndefined();
    expect(qaNullChance({ text: 'long', listSize: 100 })).toBeUndefined();
    expect(qaNullChance({ nulls: 'none', listSize: 100 })).toBe(0);
    expect(qaNullChance({ nulls: 'all', listSize: 100 })).toBe(1);
    expect(qaNullChance({ nulls: 'mixed', listSize: 100 })).toBe(0.5);
  });

  it('only grows the default pool size for huge lists', () => {
    expect(qaDefaultCount(undefined, 5)).toBe(5);
    expect(qaDefaultCount({ lists: 'empty', listSize: 100 }, 5)).toBe(5);
    expect(qaDefaultCount({ lists: 'huge', listSize: 100 }, 5)).toBe(100);
    expect(qaDefaultCount({ lists: 'huge', listSize: 2 }, 5)).toBe(5);
  });

  it('only supplies fallback text when a text profile is active', () => {
    expect(qaFallbackText(faker, undefined)).toBeUndefined();
    expect(qaFallbackText(faker, { numbers: 'zero', listSize: 100 })).toBeUndefined();
    expect(qaFallbackText(faker, { text: 'empty', listSize: 100 })).toBe('');
  });
});

describe('buildMocks with qa', () => {
  it('leaves output realistic when qa is off', () => {
    const user = users(buildMocks(schema, { faker, seed: 7 }))[0] as Record<string, unknown>;
    expect(user.name).not.toBe('');
    expect((user.todos as unknown[]).length).toBeGreaterThan(0);
  });

  it('applies a text profile to strings and custom string scalars', () => {
    for (const user of users(seeded('emptyText'))) {
      expect(user.name).toBe('');
      expect(user.email).toBe('');
      expect(user.city).toBe('');
    }
  });

  it('leaves ids usable under a text profile', () => {
    for (const user of users(seeded('emptyText'))) {
      expect(typeof user.id).toBe('string');
      expect(user.id).not.toBe('');
    }
  });

  it('empties every list field, scalar and relationship alike', () => {
    const result = seeded('emptyLists');
    for (const user of users(result)) {
      expect(user.todos).toEqual([]);
      expect(user.posts).toEqual([]);
    }
    for (const post of result.Post as Record<string, unknown>[]) {
      expect(post.tags).toEqual([]);
      expect(post.comments).toEqual([]);
    }
  });

  it('produces exactly one item per list for the single profile', () => {
    const result = seeded('singleItemLists');
    for (const user of users(result)) {
      expect((user.todos as unknown[]).length).toBe(1);
    }
    for (const post of result.Post as Record<string, unknown>[]) {
      expect((post.tags as unknown[]).length).toBe(1);
    }
  });

  it('grows pools so huge lists actually reach their target length', () => {
    const result = seeded('hugeLists');
    expect((result.Todo as unknown[]).length).toBe(DEFAULT_HUGE_LIST_SIZE);
    for (const user of users(result)) {
      expect((user.todos as unknown[]).length).toBe(DEFAULT_HUGE_LIST_SIZE);
    }
  });

  it('honors a custom listSize', () => {
    const result = buildMocks(schema, {
      faker,
      seed: 7,
      qa: { lists: 'huge', listSize: 30 },
    });
    expect((result.Todo as unknown[]).length).toBe(30);
    expect(((result.User as Record<string, unknown>[])[0]?.todos as unknown[]).length).toBe(30);
  });

  it('lets an explicit count win over the huge-list pool growth', () => {
    const result = buildMocks(schema, { faker, seed: 7, qa: 'hugeLists', count: 4 });
    expect((result.Todo as unknown[]).length).toBe(4);
    // The list is then capped by the pool, which is the documented trade-off.
    expect(((result.User as Record<string, unknown>[])[0]?.todos as unknown[]).length).toBe(4);
  });

  it('nulls every nullable field, and nothing required, for allNulls', () => {
    const result = seeded('allNulls');
    for (const user of users(result)) {
      expect(user.phone).toBeNull();
      expect(user.city).toBeNull();
      expect(user.website).toBeNull();
      expect(user.score).toBeNull();
      // Required fields stay populated; a null here would be an invalid response, not a QA case.
      expect(user.name).not.toBeNull();
      expect(user.isActive).not.toBeNull();
      expect(user.todos).not.toBeNull();
    }
  });

  it('produces both null and non-null values for mixedNulls', () => {
    const result = buildMocks(schema, { faker, seed: 3, qa: 'mixedNulls', count: 60 });
    const scores = (result.User as Record<string, unknown>[]).map((u) => u.score);
    expect(scores.some((s) => s === null)).toBe(true);
    expect(scores.some((s) => s !== null)).toBe(true);
  });

  it('applies number profiles to int and float scalars', () => {
    const zero = seeded('zeroNumbers');
    for (const user of users(zero)) {
      expect(user.loginCount).toBe(0);
      expect(user.score).toBe(0);
    }
    const negative = seeded('negativeNumbers');
    for (const user of users(negative)) {
      expect(user.loginCount as number).toBeLessThan(0);
    }
  });

  it('applies date profiles to date scalars', () => {
    const result = buildMocks(schema, { faker, seed: 7, qa: { dates: 'epoch' } });
    for (const todo of result.Todo as Record<string, unknown>[]) {
      expect(todo.createdAt).toBe('1970-01-01T00:00:00.000Z');
    }
  });

  it('combines dimensions from an explicit config', () => {
    const result = buildMocks(schema, {
      faker,
      seed: 7,
      qa: { text: 'empty', lists: 'empty', numbers: 'zero' },
    });
    const user = (result.User as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(user.name).toBe('');
    expect(user.todos).toEqual([]);
    expect(user.loginCount).toBe(0);
  });

  it('lets explicit scalars and overrides win over the QA generator', () => {
    const result = buildMocks(schema, {
      faker,
      seed: 7,
      qa: 'emptyText',
      scalars: { CityName: () => 'Springfield' },
      overrides: { User: { name: () => 'Alice' } },
    });
    const user = (result.User as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(user.name).toBe('Alice');
    expect(user.city).toBe('Springfield');
    // Untouched by either escape hatch, so the profile still applies here.
    expect(user.email).toBe('');
  });

  it('applies a text profile to unrecognized custom scalars', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = buildMocks(
      `
        scalar Mystery
        type Thing { id: ID!, value: Mystery! }
        type Query { things: [Thing!]! }
      `,
      { faker, seed: 7, qa: 'emptyText' },
    );
    for (const thing of result.Thing as Record<string, unknown>[]) {
      expect(thing.value).toBe('');
    }
    warn.mockRestore();
  });
});

describe('dataForOperation under qa', () => {
  const query = parse(`
    query Users { users { id name todos { id title } } }
  `);

  it('reflects the text profile in operation data', () => {
    const data = seeded('emptyText').dataForOperation(query) as {
      users: { name: string }[];
    };
    expect(data.users.length).toBeGreaterThan(0);
    for (const user of data.users) expect(user.name).toBe('');
  });

  it('reflects the list profile at the root and in nested fields', () => {
    const data = seeded('emptyLists').dataForOperation(query) as {
      users: { todos: unknown[] }[];
    };
    expect(data.users).toEqual([]);

    const single = seeded('singleItemLists').dataForOperation(query) as {
      users: { todos: unknown[] }[];
    };
    expect(single.users.length).toBe(1);
    expect(single.users[0]?.todos.length).toBe(1);
  });

  it('keeps boundary numbers serializable by the schema', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const numeric = parse('query Users { users { loginCount score } }');
    const data = seeded('boundaryNumbers').dataForOperation(numeric) as {
      users: { loginCount: number }[];
    };
    expect(data.users.length).toBeGreaterThan(0);
    for (const user of data.users) expect(Number.isInteger(user.loginCount)).toBe(true);
    // No GraphQL coercion errors, which is the whole point of clamping Int to 32 bits.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('builds an Apollo mock whose data carries the profile', () => {
    const mock = seeded('emptyText').mockOperation(query as never) as {
      result: { data: { users: { name: string }[] } };
    };
    for (const user of mock.result.data.users) expect(user.name).toBe('');
  });
});
