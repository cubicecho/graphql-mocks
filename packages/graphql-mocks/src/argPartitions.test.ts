import { buildSchema, parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildArgPlan, partitionWindow, resolveArgMatching } from './argMatching.js';
import { buildMocks } from './mockSchema.js';
import type { ArgOverride } from './types.js';

/** The dashboard shape from the issue: one field, several aliases, one enum telling them apart. */
const schema = buildSchema(`
  enum StockFilter { IN_STOCK, LOW_STOCK, OVER_STOCK }

  type Item { id: ID!, name: String!, quantity: Int! }

  type Warehouse {
    id: ID!
    name: String!
    items(where: StockFilter): [Item!]!
  }

  type Query {
    warehouse(id: ID!): Warehouse
    items(where: StockFilter, region: String): [Item!]!
  }
`);

const DASHBOARD = `
  query Dashboard {
    warehouse(id: "w-1") {
      id
      inStock: items(where: IN_STOCK) { id }
      lowStock: items(where: LOW_STOCK) { id }
      overStock: items(where: OVER_STOCK) { id }
    }
  }
`;

const build = (options: Parameters<typeof buildMocks>[1] = {}) =>
  buildMocks(schema, {
    seed: 7,
    count: { _default: 20, Warehouse: 1 },
    stableIds: true,
    relations: { Warehouse: { items: 3 } },
    ...options,
  });

type Panels = {
  warehouse: {
    inStock: { id: string }[];
    lowStock: { id: string }[];
    overStock: { id: string }[];
  };
};

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

describe('partitionWindow', () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  it('returns a contiguous window of the requested length', () => {
    const window = partitionWindow(items, 'where=LOW_STOCK', 3);
    expect(window).toHaveLength(3);
    const start = items.indexOf(window[0] as number);
    expect(window).toEqual([items[start], items[(start + 1) % 10], items[(start + 2) % 10]]);
  });

  it('gives the same key the same window every time', () => {
    expect(partitionWindow(items, 'where=IN_STOCK', 3)).toEqual(
      partitionWindow(items, 'where=IN_STOCK', 3),
    );
  });

  it('gives different keys different windows', () => {
    const a = partitionWindow(items, 'where=IN_STOCK', 3);
    const b = partitionWindow(items, 'where=LOW_STOCK', 3);
    const c = partitionWindow(items, 'where=OVER_STOCK', 3);
    expect(new Set([a.join(), b.join(), c.join()]).size).toBe(3);
  });

  it('wraps past the end rather than running short', () => {
    expect(partitionWindow([0, 1, 2], 'k', 3)).toHaveLength(3);
  });

  it('never asks for more than there is', () => {
    expect(partitionWindow([0, 1], 'k', 5)).toHaveLength(2);
  });

  it('handles an empty source and an empty request', () => {
    expect(partitionWindow([], 'k', 3)).toEqual([]);
    expect(partitionWindow(items, 'k', 0)).toEqual([]);
  });
});

describe('partition keys', () => {
  const config = resolveArgMatching(true);
  const queryFields = schema.getQueryType()?.getFields() ?? {};
  const itemType = schema.getType('Item');
  if (!itemType) throw new Error('missing Item');
  const active = (args: Record<string, unknown>) => new Set(Object.keys(args));

  it('keeps an argument nothing else interpreted', () => {
    const args = { where: 'LOW_STOCK' };
    const plan = buildArgPlan(queryFields.items, itemType, true, args, active(args), config);
    expect(plan).toMatchObject({ partitionKey: 'where=LOW_STOCK', hasFilters: false });
  });

  it('is stable against argument order', () => {
    const a = { where: 'LOW_STOCK', region: 'eu' };
    const b = { region: 'eu', where: 'LOW_STOCK' };
    const planA = buildArgPlan(queryFields.items, itemType, true, a, active(a), config);
    const planB = buildArgPlan(queryFields.items, itemType, true, b, active(b), config);
    expect(planA?.partitionKey).toBe(planB?.partitionKey);
    expect(planA?.partitionKey).toBe('region=eu&where=LOW_STOCK');
  });

  it('leaves interpreted arguments out of the key', () => {
    const args = { id: 'Item-1', where: 'LOW_STOCK' };
    const plan = buildArgPlan(queryFields.items, itemType, true, args, active(args), config);
    expect(plan?.partitionKey).toBe('where=LOW_STOCK');
    expect(plan?.hasFilters).toBe(true);
  });

  it('is empty with partitioning off', () => {
    const off = resolveArgMatching({ partition: false });
    const args = { where: 'LOW_STOCK' };
    expect(buildArgPlan(queryFields.items, itemType, true, args, active(args), off)).toBeNull();
  });
});

describe('aliased selections that differ only by an argument', () => {
  it('hands three aliases the same rows without matching', () => {
    const mocks = build();
    const { warehouse } = mocks.dataForOperation(parse(DASHBOARD)) as Panels;
    expect(ids(warehouse.lowStock)).toEqual(ids(warehouse.inStock));
    expect(ids(warehouse.overStock)).toEqual(ids(warehouse.inStock));
  });

  it('draws a different window per argument value once matching is on', () => {
    const mocks = build({ matchArguments: true });
    const { warehouse } = mocks.dataForOperation(parse(DASHBOARD)) as Panels;
    const panels = [warehouse.inStock, warehouse.lowStock, warehouse.overStock].map(ids);
    expect(new Set(panels.map((panel) => panel.join())).size).toBe(3);
    // The wired list length is what the relation asked for — only *which* rows changed.
    expect(panels.every((panel) => panel.length === 3)).toBe(true);
  });

  it('gives the same argument value the same rows across runs', () => {
    const mocks = build({ matchArguments: true });
    const first = (mocks.dataForOperation(parse(DASHBOARD)) as Panels).warehouse;
    const second = (mocks.dataForOperation(parse(DASHBOARD)) as Panels).warehouse;
    expect(ids(second.lowStock)).toEqual(ids(first.lowStock));
    expect(ids(second.overStock)).toEqual(ids(first.overStock));
  });

  it('partitions a root list too, keeping the normal draw size', () => {
    const mocks = build({ matchArguments: true, listSize: { min: 4, max: 4 } });
    const run = (where: string) =>
      ids(
        (mocks.dataForOperation(parse(`{ items(where: ${where}) { id } }`)) as { items: [] }).items,
      );
    const a = run('IN_STOCK');
    const b = run('OVER_STOCK');
    expect(a).toHaveLength(4);
    expect(b).toHaveLength(4);
    expect(a).not.toEqual(b);
  });

  it('stays out of the way with partition off', () => {
    const mocks = build({ matchArguments: { partition: false } });
    const { warehouse } = mocks.dataForOperation(parse(DASHBOARD)) as Panels;
    expect(ids(warehouse.lowStock)).toEqual(ids(warehouse.inStock));
  });
});

describe('argOverrides', () => {
  const lowStockRows = [{ __typename: 'Item', id: 'low-1', name: 'Nearly out', quantity: 1 }];

  const withOverrides = (argOverrides: ArgOverride[]) => build({ argOverrides });

  it('answers one field by its argument value and leaves the rest to the graph', () => {
    const mocks = withOverrides([
      { match: { field: 'items', args: { where: 'LOW_STOCK' } }, data: lowStockRows },
    ]);
    const { warehouse } = mocks.dataForOperation(parse(DASHBOARD)) as Panels;
    expect(ids(warehouse.lowStock)).toEqual(['low-1']);
    expect(ids(warehouse.inStock)).not.toEqual(['low-1']);
    expect(warehouse.inStock).toHaveLength(3);
  });

  it('applies with argument matching off entirely', () => {
    const mocks = withOverrides([
      { match: { field: 'items', args: { where: 'LOW_STOCK' } }, data: lowStockRows },
    ]);
    expect(mocks.dataForOperation(parse(DASHBOARD))).toBeTruthy();
    const { warehouse } = mocks.dataForOperation(parse(DASHBOARD)) as Panels;
    expect(ids(warehouse.lowStock)).toEqual(['low-1']);
  });

  it('matches on the parent type when one is given', () => {
    const mocks = withOverrides([{ match: { type: 'Query', field: 'items' }, data: lowStockRows }]);
    // `Warehouse.items` is a different field of the same name, and is left alone.
    const { warehouse } = mocks.dataForOperation(parse(DASHBOARD)) as Panels;
    expect(ids(warehouse.lowStock)).not.toEqual(['low-1']);
    const root = mocks.dataForOperation(parse('{ items { id } }')) as { items: { id: string }[] };
    expect(ids(root.items)).toEqual(['low-1']);
  });

  it('resolves a function against the field context', () => {
    const mocks = withOverrides([
      {
        match: { field: 'items', args: { where: 'OVER_STOCK' } },
        data: ({ pool, isList, fieldName, typeName, args }) => {
          expect({ isList, fieldName, typeName, args }).toEqual({
            isList: true,
            fieldName: 'items',
            typeName: 'Warehouse',
            args: { where: 'OVER_STOCK' },
          });
          return pool.slice(0, 2);
        },
      },
    ]);
    const { warehouse } = mocks.dataForOperation(parse(DASHBOARD)) as Panels;
    expect(ids(warehouse.overStock)).toEqual(
      ids((mocks.Item ?? []).slice(0, 2) as { id: string }[]),
    );
  });

  it('takes a predicate in place of an argument map', () => {
    const mocks = withOverrides([
      {
        match: { field: 'items', predicate: (args) => args.where !== 'IN_STOCK' },
        data: lowStockRows,
      },
    ]);
    const { warehouse } = mocks.dataForOperation(parse(DASHBOARD)) as Panels;
    expect(ids(warehouse.inStock)).not.toEqual(['low-1']);
    expect(ids(warehouse.lowStock)).toEqual(['low-1']);
    expect(ids(warehouse.overStock)).toEqual(['low-1']);
  });

  it('matches every selection of a field when no arguments are named', () => {
    const mocks = withOverrides([{ match: { field: 'items' }, data: lowStockRows }]);
    const { warehouse } = mocks.dataForOperation(parse(DASHBOARD)) as Panels;
    expect(ids(warehouse.inStock)).toEqual(['low-1']);
    expect(ids(warehouse.overStock)).toEqual(['low-1']);
  });

  it('takes the first match when two entries claim the same field', () => {
    const mocks = withOverrides([
      { match: { field: 'items', args: { where: 'LOW_STOCK' } }, data: lowStockRows },
      { match: { field: 'items' }, data: [] },
    ]);
    const { warehouse } = mocks.dataForOperation(parse(DASHBOARD)) as Panels;
    expect(ids(warehouse.lowStock)).toEqual(['low-1']);
    expect(warehouse.inStock).toEqual([]);
  });

  it('can answer a root field, and with an empty list', () => {
    const mocks = withOverrides([{ match: { field: 'items', args: { region: 'eu' } }, data: [] }]);
    const data = mocks.dataForOperation(parse('{ items(region: "eu") { id } }')) as {
      items: unknown[];
    };
    expect(data.items).toEqual([]);
  });

  it('leaves a field alone when the argument value differs', () => {
    const mocks = withOverrides([{ match: { field: 'items', args: { region: 'eu' } }, data: [] }]);
    const data = mocks.dataForOperation(parse('{ items(region: "us") { id } }')) as {
      items: unknown[];
    };
    expect(data.items.length).toBeGreaterThan(0);
  });

  it('compares an input-object argument structurally', () => {
    const mocks = withOverrides([
      { match: { field: 'warehouse', args: { id: 'w-1' } }, data: { id: 'pinned', name: 'Pin' } },
    ]);
    const data = mocks.dataForOperation(parse('{ warehouse(id: "w-1") { id name } }')) as {
      warehouse: { id: string };
    };
    expect(data.warehouse.id).toBe('pinned');
  });
});
