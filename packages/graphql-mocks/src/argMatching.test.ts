import { type FieldNode, Kind, parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import { activeArgNames, applyArgPlan, buildArgPlan, resolveArgMatching } from './argMatching.js';
import { schema } from './test/schema.js';

const config = resolveArgMatching(true);
// Partitioning turns any leftover scalar argument into a plan of its own, so the tests that
// assert "nothing was interpreted" opt out of it and the partition tests assert it directly.
const noPartition = resolveArgMatching({ partition: false });
const queryType = schema.getQueryType();
if (!queryType) throw new Error('test schema has no Query type');
const queryFields = queryType.getFields();

const userType = schema.getType('User');
const postType = schema.getType('Post');
const todoType = schema.getType('Todo');
if (!userType || !postType || !todoType) throw new Error('test schema is missing a type');

/** Pull the first field node out of a query so `activeArgNames` has real AST to read. */
function fieldNodes(query: string): readonly FieldNode[] {
  const definition = parse(query).definitions[0];
  if (!definition || definition.kind !== Kind.OPERATION_DEFINITION) throw new Error('bad query');
  const node = definition.selectionSet.selections[0];
  if (!node || node.kind !== Kind.FIELD) throw new Error('bad selection');
  return [node];
}

describe('resolveArgMatching', () => {
  it('is disabled when the option is absent or false', () => {
    expect(resolveArgMatching(undefined).enabled).toBe(false);
    expect(resolveArgMatching(false).enabled).toBe(false);
  });

  it('enables every dimension for `true`', () => {
    const resolved = resolveArgMatching(true);
    expect(resolved).toMatchObject({
      enabled: true,
      equality: true,
      search: true,
      paging: true,
      nested: true,
      onMissSingular: 'fallback',
      onMissList: 'empty',
    });
  });

  it('is enabled by an options object and keeps per-dimension defaults', () => {
    const resolved = resolveArgMatching({ paging: false });
    expect(resolved.enabled).toBe(true);
    expect(resolved.paging).toBe(false);
    expect(resolved.equality).toBe(true);
  });

  it('applies a scalar onMiss to both singular and list', () => {
    const resolved = resolveArgMatching({ onMiss: 'empty' });
    expect(resolved.onMissSingular).toBe('empty');
    expect(resolved.onMissList).toBe('empty');
  });

  it('applies a per-shape onMiss and keeps the other default', () => {
    const resolved = resolveArgMatching({ onMiss: { list: 'fallback' } });
    expect(resolved.onMissList).toBe('fallback');
    expect(resolved.onMissSingular).toBe('fallback');
  });

  it('accepts custom argument-name lists', () => {
    const resolved = resolveArgMatching({ offsetArgs: ['from'], ignoreArgs: ['id'] });
    expect(resolved.offsetArgs).toEqual(['from']);
    expect(resolved.ignoreArgs.has('id')).toBe(true);
  });
});

describe('activeArgNames', () => {
  it('treats a literal argument as authored', () => {
    const nodes = fieldNodes('{ user(id: "u-1") { id } }');
    expect([...activeArgNames(nodes, { id: 'u-1' }, new Set())]).toEqual(['id']);
  });

  it('treats a caller-supplied variable as authored', () => {
    const nodes = fieldNodes('query Q($id: ID!) { user(id: $id) { id } }');
    expect([...activeArgNames(nodes, { id: 'u-1' }, new Set())]).toEqual(['id']);
  });

  it('drops an argument bound to a synthesized variable', () => {
    const nodes = fieldNodes('query Q($id: ID!) { user(id: $id) { id } }');
    expect([...activeArgNames(nodes, { id: 'made-up' }, new Set(['id']))]).toEqual([]);
  });

  it('keeps an argument absent from the AST, which came from a schema default', () => {
    const nodes = fieldNodes('{ todos { id } }');
    expect([...activeArgNames(nodes, { first: 10 }, new Set())]).toEqual(['first']);
  });

  it('keeps an argument authored in any one of several merged field nodes', () => {
    const nodes = [
      ...fieldNodes('query Q($id: ID!) { user(id: $id) { id } }'),
      ...fieldNodes('{ user(id: "real") { name } }'),
    ];
    expect([...activeArgNames(nodes, { id: 'real' }, new Set(['id']))]).toEqual(['id']);
  });
});

describe('buildArgPlan', () => {
  const allActive = (args: Record<string, unknown>) => new Set(Object.keys(args));

  it('returns null when there are no active arguments', () => {
    expect(
      buildArgPlan(queryFields.user, userType, false, { id: 'x' }, new Set(), config),
    ).toBeNull();
  });

  it('returns null when there is no field definition', () => {
    expect(
      buildArgPlan(undefined, userType, false, { id: 'x' }, allActive({ id: 'x' }), config),
    ).toBeNull();
  });

  it('matches a scalar argument against the same-named field', () => {
    const args = { id: 'u-1' };
    const plan = buildArgPlan(queryFields.user, userType, false, args, allActive(args), config);
    expect(plan?.equality).toEqual([{ field: 'id', values: ['u-1'], coerce: true }]);
    expect(plan?.hasFilters).toBe(true);
  });

  it('matches an enum argument', () => {
    const args = { priority: 'HIGH' };
    const plan = buildArgPlan(queryFields.todos, todoType, true, args, allActive(args), config);
    expect(plan?.equality).toEqual([{ field: 'priority', values: ['HIGH'], coerce: false }]);
  });

  it('matches a custom-scalar argument', () => {
    const args = { slug: 'a-b-c' };
    const plan = buildArgPlan(
      queryFields.postBySlug,
      postType,
      false,
      args,
      allActive(args),
      config,
    );
    expect(plan?.equality).toEqual([{ field: 'slug', values: ['a-b-c'], coerce: false }]);
  });

  it('turns a plural list argument into an `in` match on the singular field', () => {
    const args = { ids: ['a', 'b'] };
    const plan = buildArgPlan(
      queryFields.usersByIds,
      userType,
      true,
      args,
      allActive(args),
      config,
    );
    expect(plan?.equality).toEqual([{ field: 'id', values: ['a', 'b'], coerce: true }]);
  });

  it('reads a search-style argument as a match across every string field', () => {
    const args = { search: 'ann' };
    const plan = buildArgPlan(queryFields.users, userType, true, args, allActive(args), config);
    expect(plan?.contains).toEqual([{ field: null, term: 'ann' }]);
  });

  it('reads `<field>Contains` as a match on that field', () => {
    const args = { titleContains: 'hi' };
    const plan = buildArgPlan(queryFields.posts, postType, true, args, allActive(args), config);
    expect(plan?.contains).toEqual([{ field: 'title', term: 'hi' }]);
  });

  it('reads paging arguments on a list field', () => {
    const args = { skip: 2, limit: 3 };
    const plan = buildArgPlan(queryFields.users, userType, true, args, allActive(args), config);
    expect(plan?.page).toEqual({ skip: 2, limit: 3 });
    expect(plan?.hasPaging).toBe(true);
    expect(plan?.hasFilters).toBe(false);
  });

  it('reads the offset/first and take dialects', () => {
    const args = { offset: 1, first: 2 };
    const plan = buildArgPlan(queryFields.todos, todoType, true, args, allActive(args), config);
    expect(plan?.page).toEqual({ skip: 1, limit: 2 });
    const take = { take: 4 };
    expect(
      buildArgPlan(queryFields.posts, postType, true, take, allActive(take), config)?.page,
    ).toEqual({ limit: 4 });
  });

  it('ignores paging arguments on a singular field', () => {
    const args = { limit: 2 };
    expect(
      buildArgPlan(queryFields.user, userType, false, args, allActive(args), noPartition),
    ).toBeNull();
  });

  it('ignores an input-object argument', () => {
    const mutationFields = schema.getMutationType()?.getFields() ?? {};
    const args = { input: { title: 'x' } };
    expect(
      buildArgPlan(mutationFields.createTodo, todoType, false, args, allActive(args), config),
    ).toBeNull();
  });

  it('ignores an argument that names no field on the return type', () => {
    const args = { nonsense: 'x' };
    expect(
      buildArgPlan(queryFields.users, userType, true, args, allActive(args), noPartition),
    ).toBeNull();
  });

  it('ignores a plural list argument whose singular is not a comparable field', () => {
    const args = { tags: ['a'] };
    expect(
      buildArgPlan(queryFields.posts, postType, true, args, allActive(args), config),
    ).toBeNull();
  });

  it('honors ignoreArgs', () => {
    const args = { id: 'u-1' };
    const ignoring = resolveArgMatching({ ignoreArgs: ['id'] });
    expect(
      buildArgPlan(queryFields.user, userType, false, args, allActive(args), ignoring),
    ).toBeNull();
  });

  it('honors a disabled equality dimension', () => {
    const args = { id: 'u-1' };
    const noEquality = resolveArgMatching({ equality: false, partition: false });
    expect(
      buildArgPlan(queryFields.user, userType, false, args, allActive(args), noEquality),
    ).toBeNull();
  });

  it('honors a disabled paging dimension', () => {
    const args = { skip: 1, limit: 2 };
    const noPaging = resolveArgMatching({ paging: false, partition: false });
    expect(
      buildArgPlan(queryFields.users, userType, true, args, allActive(args), noPaging),
    ).toBeNull();
  });

  it('honors a disabled search dimension', () => {
    const args = { search: 'x' };
    const noSearch = resolveArgMatching({ search: false, partition: false });
    expect(
      buildArgPlan(queryFields.users, userType, true, args, allActive(args), noSearch),
    ).toBeNull();
  });

  it('skips arguments whose coerced value is undefined', () => {
    const args = { id: undefined };
    expect(
      buildArgPlan(queryFields.user, userType, false, args, allActive(args), config),
    ).toBeNull();
  });

  it('builds no plan against a scalar return type', () => {
    const mutationFields = schema.getMutationType()?.getFields() ?? {};
    const booleanType = schema.getType('Boolean');
    if (!booleanType) throw new Error('missing Boolean');
    const args = { id: 'x' };
    expect(
      buildArgPlan(
        mutationFields.deleteTodo,
        booleanType,
        false,
        args,
        allActive(args),
        noPartition,
      ),
    ).toBeNull();
  });
});

describe('applyArgPlan', () => {
  const items = [
    { id: '1', name: 'Ann', priority: 'HIGH' },
    { id: '2', name: 'Bob', priority: 'LOW' },
    { id: '3', name: 'Cid', priority: 'HIGH' },
  ];
  const plan = (over: Partial<ReturnType<typeof makePlan>> = {}) => ({ ...makePlan(), ...over });
  function makePlan() {
    return {
      equality: [] as { field: string; values: unknown[]; coerce: boolean }[],
      contains: [] as { field: string | null; term: string }[],
      page: {},
      hasFilters: false,
      hasPaging: false,
      partitionKey: '',
    };
  }

  it('filters by equality', () => {
    const result = applyArgPlan(
      items,
      plan({
        equality: [{ field: 'priority', values: ['HIGH'], coerce: false }],
        hasFilters: true,
      }),
    );
    expect(result.items.map((i) => i.id)).toEqual(['1', '3']);
    expect(result.filterMissed).toBe(false);
  });

  it('matches an `in` list', () => {
    const result = applyArgPlan(
      items,
      plan({ equality: [{ field: 'id', values: ['1', '3'], coerce: true }], hasFilters: true }),
    );
    expect(result.items.map((i) => i.id)).toEqual(['1', '3']);
  });

  it('compares ID values across string and number forms when coercing', () => {
    const result = applyArgPlan(
      [{ id: 1 }, { id: 2 }],
      plan({ equality: [{ field: 'id', values: ['1'], coerce: true }], hasFilters: true }),
    );
    expect(result.items).toEqual([{ id: 1 }]);
  });

  it('does not coerce when the field is not an ID', () => {
    const result = applyArgPlan(
      [{ rating: 1 }],
      plan({ equality: [{ field: 'rating', values: ['1'], coerce: false }], hasFilters: true }),
    );
    expect(result.items).toEqual([]);
    expect(result.filterMissed).toBe(true);
  });

  it('filters by a substring across every string field', () => {
    const result = applyArgPlan(
      items,
      plan({ contains: [{ field: null, term: 'an' }], hasFilters: true }),
    );
    expect(result.items.map((i) => i.id)).toEqual(['1']);
  });

  it('filters by a substring on one field', () => {
    const result = applyArgPlan(
      items,
      plan({ contains: [{ field: 'name', term: 'b' }], hasFilters: true }),
    );
    expect(result.items.map((i) => i.id)).toEqual(['2']);
  });

  it('reports a miss when filters eliminate everything', () => {
    const result = applyArgPlan(
      items,
      plan({ contains: [{ field: null, term: 'zzz' }], hasFilters: true }),
    );
    expect(result.items).toEqual([]);
    expect(result.filterMissed).toBe(true);
  });

  it('pages after filtering', () => {
    const result = applyArgPlan(
      items,
      plan({
        equality: [{ field: 'priority', values: ['HIGH'], coerce: false }],
        hasFilters: true,
        page: { skip: 1 },
        hasPaging: true,
      }),
    );
    expect(result.items.map((i) => i.id)).toEqual(['3']);
  });

  it('never reports a miss for paging alone', () => {
    const result = applyArgPlan(items, plan({ page: { skip: 99 }, hasPaging: true }));
    expect(result.items).toEqual([]);
    expect(result.filterMissed).toBe(false);
  });

  it('leaves the source array untouched', () => {
    const source = items.slice();
    applyArgPlan(source, plan({ page: { limit: 1 }, hasPaging: true }));
    expect(source).toHaveLength(3);
  });
});
