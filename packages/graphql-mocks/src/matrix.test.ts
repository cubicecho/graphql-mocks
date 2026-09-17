import { type Faker, faker, fakerDE } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import { buildMatrix } from './matrix.js';
import { buildMocks } from './mockSchema.js';
import { DEFAULT_HUGE_LIST_SIZE } from './qa.js';
import { defineScenarios } from './scenarios.js';
import { schema } from './test/schema.js';

// Relationship fields are circular and the DateTime fields are wall-clock relative, so
// compare only the stable scalars — same helper as qaSets.test.ts.
const CLOCK_RELATIVE = new Set(['createdAt', 'dueDate', 'publishedAt']);

const scalarFields = (items: unknown[] | undefined) =>
  JSON.stringify(
    ((items ?? []) as Record<string, unknown>[]).map((item) =>
      Object.fromEntries(
        Object.entries(item).filter(
          ([key, value]) => typeof value !== 'object' && !CLOCK_RELATIVE.has(key),
        ),
      ),
    ),
  );

const scenarios = defineScenarios({
  newUser: { relations: { User: { todos: null, posts: null } } },
  powerUser: { relations: { User: { todos: 8 } } },
});

const ids = (items: unknown[] | undefined) =>
  ((items ?? []) as Record<string, unknown>[]).map((item) => item.id);

describe('buildMatrix', () => {
  it('builds one cell per scenario and preset, scenarios outermost', () => {
    const cells = buildMatrix(schema, {
      scenarios,
      qaPresets: [false, 'longText', 'hugeLists'],
      seed: 1,
      count: 2,
    });
    expect(cells.map((c) => c.name)).toEqual([
      'newUser × noQa',
      'newUser × longText',
      'newUser × hugeLists',
      'powerUser × noQa',
      'powerUser × longText',
      'powerUser × hugeLists',
    ]);
    expect(cells.map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(cells[0]?.scenario).toBe('newUser');
    expect(cells[0]?.qa).toBe('noQa');
  });

  it('applies both axes to the cell it built', () => {
    // Only User is pinned: the Todo pool has to grow to meet the powerUser relation demand.
    const cells = buildMatrix(schema, {
      scenarios,
      qaPresets: ['longText'],
      seed: 1,
      count: { User: 2 },
    });
    const [newUser, powerUser] = cells;
    expect((newUser?.mocks.User as Record<string, unknown>[])[0]?.todos).toEqual([]);
    expect((powerUser?.mocks.User as Record<string, unknown>[])[0]?.todos).toHaveLength(8);
    // The preset reached both cells: `longText` pads every string scalar out.
    for (const cell of cells) {
      const name = (cell.mocks.User as Record<string, unknown>[])[0]?.name as string;
      expect(name.length).toBeGreaterThan(100);
    }
  });

  it('names a single-axis matrix after that axis alone', () => {
    expect(buildMatrix(schema, { scenarios, count: 1, seed: 1 }).map((c) => c.name)).toEqual([
      'newUser',
      'powerUser',
    ]);
    expect(
      buildMatrix(schema, { qaPresets: ['emptyText'], count: 1, seed: 1 }).map((c) => c.name),
    ).toEqual(['emptyText']);
  });

  it('produces a single default cell equal to a plain buildMocks when neither axis is given', () => {
    const [cell] = buildMatrix(schema, { seed: 42, count: 3, stableIds: true });
    const plain = buildMocks(schema, { faker, seed: 42, count: 3, stableIds: true });
    expect(cell?.name).toBe('default');
    expect(cell?.scenario).toBe('');
    expect(scalarFields(cell?.mocks.User ?? [])).toBe(scalarFields(plain.User));
  });

  it('merges a shared qa base under each preset', () => {
    const cells = buildMatrix(schema, {
      qaPresets: ['hugeLists', 'longText'],
      qa: { listSize: 7, numbers: 'zero' },
      seed: 1,
    });
    expect(cells[0]?.options.qa).toEqual({ lists: 'huge', listSize: 7, numbers: 'zero' });
    expect((cells[0]?.mocks.User as Record<string, unknown>[])[0]?.todos).toHaveLength(7);
    // The shared base still applies where the preset has nothing to say.
    expect((cells[1]?.mocks.User as Record<string, unknown>[])[0]?.loginCount).toBe(0);
  });

  it('lets explicit options win over a scenario layer', () => {
    const [cell] = buildMatrix(schema, {
      scenarios: { powerUser: { count: 9, relations: { User: { todos: 8 } } } },
      count: 2,
      seed: 1,
    });
    expect(cell?.mocks.User).toHaveLength(2);
    expect(cell?.options.count).toBe(2);
  });

  it('seeds every cell from the same seed so cells stay comparable', () => {
    const cells = buildMatrix(schema, { qaPresets: ['emptyLists', 'singleItemLists'], seed: 5 });
    expect(scalarFields(cells[0]?.mocks.User ?? [])).toBe(scalarFields(cells[1]?.mocks.User ?? []));
  });

  it('varies the seed per cell on request', () => {
    const offset = buildMatrix(schema, {
      qaPresets: ['emptyLists', 'singleItemLists'],
      seed: 5,
      seedPerCell: true,
    });
    expect(scalarFields(offset[0]?.mocks.User ?? [])).not.toBe(
      scalarFields(offset[1]?.mocks.User ?? []),
    );
    expect(offset.map((c) => c.options.seed)).toEqual([5, 6]);

    const chosen = buildMatrix(schema, {
      qaPresets: ['emptyLists', 'singleItemLists'],
      seed: 5,
      seedPerCell: (cell) => cell.index * 100,
    });
    expect(chosen.map((c) => c.options.seed)).toEqual([0, 100]);
  });

  it('reproduces a cell independently of which other cells were requested', () => {
    const all = buildMatrix(schema, { scenarios, qaPresets: ['longText'], seed: 3, count: 2 });
    const one = buildMatrix(schema, {
      scenarios: { powerUser: scenarios.powerUser },
      qaPresets: ['longText'],
      seed: 3,
      count: 2,
    });
    expect(scalarFields(one[0]?.mocks.User ?? [])).toBe(scalarFields(all[1]?.mocks.User ?? []));
  });

  it('prefixes stable ids per cell so pools from different cells do not collide', () => {
    const cells = buildMatrix(schema, {
      scenarios,
      qaPresets: [false, 'longText'],
      seed: 1,
      count: 2,
      stableIds: true,
    });
    expect(ids(cells[0]?.mocks.User ?? [])).toEqual(['newuser-noqa-User-0', 'newuser-noqa-User-1']);
    expect(ids(cells[3]?.mocks.User ?? [])).toEqual([
      'poweruser-longtext-User-0',
      'poweruser-longtext-User-1',
    ]);
    const unique = new Set(cells.flatMap((cell) => ids(cell.mocks.User ?? [])));
    expect(unique.size).toBe(8);
  });

  it('leaves ids unprefixed for a single cell or an explicit idPrefix', () => {
    const [single] = buildMatrix(schema, { qaPresets: ['emptyText'], count: 1, stableIds: true });
    expect(ids(single?.mocks.User ?? [])).toEqual(['User-0']);

    const [pinned] = buildMatrix(schema, {
      scenarios,
      qaPresets: ['emptyText'],
      count: 1,
      stableIds: true,
      idPrefix: 'x-',
    });
    expect(ids(pinned?.mocks.User ?? [])).toEqual(['x-User-0']);
  });

  it('records the options each cell was actually built from', () => {
    const [cell] = buildMatrix(schema, {
      scenarios: { newUser: scenarios.newUser },
      qaPresets: ['emptyText'],
      seed: 4,
      count: 1,
    });
    expect(cell?.options).toMatchObject({
      count: 1,
      seed: 4,
      qa: { text: 'empty' },
      relations: { User: { todos: null, posts: null } },
      idPrefix: '',
    });
    expect(cell?.options.faker).toBeDefined();
  });

  it('gives every cell its own faker even when the caller supplies one', () => {
    const cells = buildMatrix(schema, { faker, qaPresets: ['emptyLists', 'emptyText'], seed: 2 });
    expect(cells[0]?.options.faker).not.toBe(faker);
    expect(cells[0]?.options.faker).not.toBe(cells[1]?.options.faker);
  });

  it('takes the locale from a caller-supplied faker', () => {
    const [cell] = buildMatrix(schema, { faker: fakerDE, seed: 2, count: 1 });
    expect((cell?.options.faker as Faker).getMetadata().language).toBe('de');
  });

  it('keeps cells reproducible when the options carry a faker', () => {
    const shared = { faker, seed: 7, count: 3 };
    const together = buildMatrix(schema, { ...shared, qaPresets: ['longText', 'emptyLists'] });
    const alone = buildMatrix(schema, { ...shared, qaPresets: ['emptyLists'] });
    expect(scalarFields(together[1]?.mocks.User as unknown[])).toBe(
      scalarFields(alone[0]?.mocks.User as unknown[]),
    );
  });

  it('accepts a named qa map for custom cell names and inline configs', () => {
    const cells = buildMatrix(schema, {
      qaPresets: { baseline: false, huge: { lists: 'huge', listSize: 3 } },
      seed: 1,
    });
    expect(cells.map((c) => c.name)).toEqual(['baseline', 'huge']);
    expect((cells[1]?.mocks.User as Record<string, unknown>[])[0]?.todos).toHaveLength(3);
  });

  it('treats an empty axis as absent rather than producing no cells', () => {
    expect(buildMatrix(schema, { scenarios: {}, qaPresets: [], count: 1 })).toHaveLength(1);
  });

  it('grows pools for a huge list preset just as buildMocks does', () => {
    const [cell] = buildMatrix(schema, { qaPresets: ['hugeLists'], seed: 1 });
    expect(cell?.mocks.Todo).toHaveLength(DEFAULT_HUGE_LIST_SIZE);
  });
});
