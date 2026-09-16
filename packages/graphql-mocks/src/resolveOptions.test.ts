import { Faker, base, en } from '@faker-js/faker';
import { parse } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { buildMocks } from './mockSchema.js';
import { DEFAULT_HUGE_LIST_SIZE } from './qa.js';
import { resolveOptions } from './resolveOptions.js';
import { schema } from './test/schema.js';

describe('resolveOptions', () => {
  it('fills in the defaults the generator relies on', () => {
    const resolved = resolveOptions({});
    expect(resolved.addTypename).toBe(true);
    expect(resolved.stableIds).toBe(false);
    expect(resolved.nullChance).toBe(0);
    expect(resolved.defaultCount).toBe(5);
    expect(resolved.overrides).toEqual({});
    expect(resolved.qa).toBeUndefined();
    expect(resolved.qaScalars).toBeUndefined();
  });

  it('passes explicit options through untouched', () => {
    const resolveType = () => 'User';
    const resolved = resolveOptions({
      count: { User: 3 },
      nullChance: 0.25,
      addTypename: false,
      stableIds: true,
      resolveType,
      scalars: { DateTime: () => 'x' },
    });
    expect(resolved.count).toEqual({ User: 3 });
    expect(resolved.nullChance).toBe(0.25);
    expect(resolved.addTypename).toBe(false);
    expect(resolved.stableIds).toBe(true);
    expect(resolved.resolveType).toBe(resolveType);
    expect(resolved.scalars?.DateTime).toBeDefined();
  });

  it('seeds the supplied faker so the same seed reproduces', () => {
    const a = new Faker({ locale: [en, base] });
    const b = new Faker({ locale: [en, base] });
    resolveOptions({ faker: a, seed: 99 });
    resolveOptions({ faker: b, seed: 99 });
    expect(a.number.int()).toBe(b.number.int());
  });

  it('lets a QA nulls profile override nullChance', () => {
    expect(resolveOptions({ nullChance: 0.1, qa: 'allNulls' }).nullChance).toBe(1);
    expect(resolveOptions({ nullChance: 0.1, qa: 'emptyText' }).nullChance).toBe(0.1);
  });

  it('raises defaultCount to feed a huge list profile', () => {
    expect(resolveOptions({ qa: 'hugeLists' }).defaultCount).toBe(DEFAULT_HUGE_LIST_SIZE);
    expect(resolveOptions({ qa: { lists: 'huge', listSize: 12 } }).defaultCount).toBe(12);
  });

  it('derives the QA scalar map once, only when QA mode is on', () => {
    expect(resolveOptions({ qa: 'longText' }).qaScalars?.String).toBeDefined();
    expect(resolveOptions({ qa: false }).qaScalars).toBeUndefined();
  });

  // The regression this module exists to prevent: the build path and the operation path used
  // to resolve `qa` independently, so every option had to be threaded twice and could drift.
  // A bad profile name warning once per build — not once more per query — proves one pass.
  it('resolves once per build, not again per operation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mocks = buildMocks(schema, { seed: 1, count: 2, qa: 'nope' as never });
    expect(warn).toHaveBeenCalledTimes(1);

    const query = parse('query Users { users { id name } }');
    mocks.dataForOperation(query);
    mocks.dataForOperation(query);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
