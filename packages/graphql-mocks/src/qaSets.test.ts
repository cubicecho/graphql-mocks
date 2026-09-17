import { Faker, base, en, faker } from '@faker-js/faker';
import { parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import { QA_PROFILE_NAMES } from './qa.js';
import { buildQaSets } from './qaSets.js';
import { schema } from './test/schema.js';

// Compare the scalar fields of each instance. Relationship fields are skipped because the
// wired graph is circular (User.todos[0].user points back at a User), and the DateTime fields
// are skipped because `faker.date.recent()` is relative to the wall clock, so two otherwise
// identical runs disagree by a few milliseconds. The date profiles are what pin timestamps.
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

describe('buildQaSets', () => {
  it('generates one set per profile by default, in order', () => {
    const sets = buildQaSets(schema, { seed: 1, count: 2 });
    expect(sets.map((s) => s.name)).toEqual(QA_PROFILE_NAMES);
  });

  it('limits generation to the requested profiles', () => {
    const sets = buildQaSets(schema, { seed: 1, count: 2, profiles: ['emptyText', 'allNulls'] });
    expect(sets.map((s) => s.name)).toEqual(['emptyText', 'allNulls']);
  });

  it('tags each set with the config that produced it', () => {
    const [set] = buildQaSets(schema, { seed: 1, count: 2, profiles: ['longText'] });
    expect(set?.qa).toEqual({ text: 'long' });
  });

  it('applies the profile to the generated pools', () => {
    const [empty, huge] = buildQaSets(schema, {
      seed: 1,
      profiles: ['emptyText', 'hugeLists'],
    });
    const user = (empty?.mocks.User as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(user.name).toBe('');
    expect((huge?.mocks.Todo as unknown[]).length).toBe(100);
  });

  it('merges shared qa settings under each profile', () => {
    const [set] = buildQaSets(schema, {
      seed: 1,
      profiles: ['hugeLists'],
      qa: { listSize: 20 },
    });
    expect(set?.qa).toEqual({ listSize: 20, lists: 'huge' });
    expect((set?.mocks.Todo as unknown[]).length).toBe(20);
  });

  it('lets a profile win over a conflicting shared setting', () => {
    const [set] = buildQaSets(schema, {
      seed: 1,
      count: 2,
      profiles: ['emptyLists'],
      // A shared `lists` would otherwise defeat the one thing this profile exists to test.
      qa: { lists: 'huge' },
    });
    expect(set?.qa.lists).toBe('empty');
    const user = (set?.mocks.User as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(user.todos).toEqual([]);
  });

  it('forwards other build options to every set', () => {
    const sets = buildQaSets(schema, {
      seed: 1,
      count: 3,
      stableIds: true,
      profiles: ['emptyText', 'zeroNumbers'],
    });
    for (const set of sets) {
      expect((set.mocks.User as unknown[]).length).toBe(3);
      expect((set.mocks.User as Record<string, unknown>[])[0]?.id).toBe('User-0');
    }
  });

  it('reproduces a set identically regardless of which profiles ran alongside it', () => {
    const together = buildQaSets(schema, {
      seed: 42,
      count: 3,
      profiles: ['longText', 'emptyLists'],
    });
    const alone = buildQaSets(schema, { seed: 42, count: 3, profiles: ['emptyLists'] });
    expect(scalarFields(together[1]?.mocks.User as unknown[])).toBe(
      scalarFields(alone[0]?.mocks.User as unknown[]),
    );
  });

  it('is deterministic across repeated calls with the same seed', () => {
    const a = buildQaSets(schema, { seed: 9, count: 3, profiles: ['unicodeText'] });
    const b = buildQaSets(schema, { seed: 9, count: 3, profiles: ['unicodeText'] });
    expect(scalarFields(a[0]?.mocks.User as unknown[])).toBe(
      scalarFields(b[0]?.mocks.User as unknown[]),
    );
  });

  it('isolates each set from a faker the options happen to carry', () => {
    // The reported trap: reusing the options object a `buildMocks` call already uses meant every
    // set drew from that one instance, so adding a profile shifted every set after it.
    const shared = { faker, seed: 5, count: 3 };
    const together = buildQaSets(schema, { ...shared, profiles: ['longText', 'emptyLists'] });
    const alone = buildQaSets(schema, { ...shared, profiles: ['emptyLists'] });
    expect(scalarFields(together[1]?.mocks.User as unknown[])).toBe(
      scalarFields(alone[0]?.mocks.User as unknown[]),
    );
  });

  it('leaves the caller-supplied faker unseeded and unadvanced', () => {
    const mine = new Faker({ locale: [en, base] });
    mine.seed(3);
    const expected = mine.number.int();

    mine.seed(3);
    buildQaSets(schema, { faker: mine, seed: 99, count: 2, profiles: ['emptyText', 'longText'] });
    expect(mine.number.int()).toBe(expected);
  });

  it('throws on an unknown profile name', () => {
    expect(() => buildQaSets(schema, { seed: 1, profiles: ['nope' as never] })).toThrow(
      /unknown profile "nope"/,
    );
  });

  it('produces Apollo mocks ready for MockedProvider, one per profile', () => {
    const query = parse('query Users { users { id name } }');
    const mocks = buildQaSets(schema, {
      seed: 1,
      count: 2,
      profiles: ['emptyText', 'emptyLists'],
    }).map((set) => ({ name: set.name, mock: set.mocks.mockOperation(query as never) }));

    expect(mocks.map((m) => m.name)).toEqual(['emptyText', 'emptyLists']);
    const [emptyText, emptyLists] = mocks as {
      mock: { result: { data: { users: { name: string }[] } } };
    }[];
    for (const user of emptyText?.mock.result.data.users ?? []) expect(user.name).toBe('');
    expect(emptyLists?.mock.result.data.users).toEqual([]);
  });
});
