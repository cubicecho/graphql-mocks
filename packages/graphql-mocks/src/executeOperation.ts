import type { Faker } from '@faker-js/faker';
import {
  type DocumentNode,
  type GraphQLField,
  type GraphQLFormattedError,
  type GraphQLInputType,
  type GraphQLNamedType,
  type GraphQLOutputType,
  type GraphQLResolveInfo,
  type GraphQLSchema,
  defaultFieldResolver,
  executeSync,
  getOperationAST,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  typeFromAST,
} from 'graphql';
import {
  type ArgMatchingOptions,
  type ArgPlan,
  type ResolvedArgMatching,
  activeArgNames,
  applyArgPlan,
  buildArgPlan,
  echoFromPlan,
  partitionWindow,
  resolveArgMatching,
  resolveListTarget,
} from './argMatching.js';
import { paginate } from './collection.js';
import { qaFallbackText, qaListLength } from './qa.js';
import { UNBOUNDED, pickRelated, relationBounds, resolveRelation } from './relations.js';
import type { ResolvedOptions } from './resolveOptions.js';
import { resolveScalarMocker } from './scalarMockers.js';
import type { ArgOverride, ArgOverrideContext } from './types.js';

type Pool = Record<string, Record<string, unknown>[]>;

/** Everything the field resolvers need, bundled so the helper signatures stay readable. */
interface ResolveContext {
  schema: GraphQLSchema;
  pool: Pool;
  resolved: ResolvedOptions;
  arg: ResolvedArgMatching;
  /** Variable names invented by `synthesizeVariables`; arguments bound to them are ignored. */
  synthesized: ReadonlySet<string>;
}

/** Strip NonNull/List wrappers off an output type, tracking whether a list was present. */
function unwrapOutput(type: GraphQLOutputType): { named: GraphQLNamedType; isList: boolean } {
  let current: GraphQLOutputType = type;
  let isList = false;
  if (isNonNullType(current)) current = current.ofType;
  if (isListType(current)) {
    isList = true;
    current = current.ofType;
    if (isNonNullType(current)) current = current.ofType;
  }
  return { named: current as GraphQLNamedType, isList };
}

/** Mock a scalar/enum value for a root field or input that has no pool to draw from. */
function mockLeaf(named: GraphQLNamedType, resolved: ResolvedOptions): unknown {
  if (isEnumType(named)) return named.getValues()[0]?.value ?? null;
  const { faker } = resolved;
  const mocker = resolveScalarMocker(named.name, resolved.scalars, resolved.qaScalars);
  if (mocker) return mocker(faker);
  return qaFallbackText(faker, resolved.qa) ?? faker.lorem.word();
}

/** A singular root field resolves to exactly one object; list sizing does not apply. */
const SINGULAR_BOUNDS = { min: 1, max: 1 };

/**
 * The parts of the resolver info a root field needs — its own site, what it returns, and the
 * argument AST, which is what distinguishes an argument the caller wrote from one synthesized
 * to satisfy a required variable.
 */
type RootFieldInfo = Pick<
  GraphQLResolveInfo,
  'fieldName' | 'parentType' | 'returnType' | 'fieldNodes'
>;

/** The field definition backing the current resolver call, if the parent type has one. */
function fieldDefinition(info: RootFieldInfo): GraphQLField<unknown, unknown> | undefined {
  const parent = info.parentType;
  return isObjectType(parent) || isInterfaceType(parent)
    ? parent.getFields()[info.fieldName]
    : undefined;
}

/** Build the argument plan for the field being resolved, or null when nothing is interpretable. */
function planFor(
  ctx: ResolveContext,
  named: GraphQLNamedType,
  isList: boolean,
  args: Record<string, unknown>,
  info: RootFieldInfo,
): ArgPlan | null {
  if (!ctx.arg.enabled) return null;
  const active = activeArgNames(info.fieldNodes, args, ctx.synthesized);
  return buildArgPlan(fieldDefinition(info), named, isList, args, active, ctx.arg);
}

/** Structural equality, enough for comparing coerced argument values. */
function sameArgValue(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if (typeof expected !== 'object' || typeof actual !== 'object') return false;
  if (expected === null || actual === null) return false;
  return JSON.stringify(expected) === JSON.stringify(actual);
}

/** Whether one override's `match` describes this field selection. */
function overrideMatches(
  override: ArgOverride,
  parentTypeName: string,
  fieldName: string,
  args: Record<string, unknown>,
): boolean {
  const { match } = override;
  if (match.field !== fieldName) return false;
  if (match.type !== undefined && match.type !== parentTypeName) return false;
  if (match.predicate) return match.predicate(args);
  if (!match.args) return true;
  return Object.entries(match.args).every(([name, value]) => sameArgValue(value, args[name]));
}

/**
 * The first `argOverrides` entry that claims this field, resolved to its value. Wrapped in an
 * object so an override can legitimately answer with `undefined` or `null`.
 *
 * This runs ahead of everything else and ignores `matchArguments` entirely: an override is an
 * instruction about one field, not an inference from its arguments, and it leaves every other
 * field of the operation resolving from the graph — which is the whole point of it existing
 * next to the operation-level overrides a handler takes.
 */
function argOverrideFor(
  ctx: ResolveContext,
  info: GraphQLResolveInfo,
  args: Record<string, unknown>,
): { value: unknown } | undefined {
  const overrides = ctx.resolved.argOverrides;
  if (overrides.length === 0) return undefined;
  const parentTypeName = info.parentType.name;
  const found = overrides.find((entry) =>
    overrideMatches(entry, parentTypeName, info.fieldName, args),
  );
  if (!found) return undefined;
  if (typeof found.data !== 'function') return { value: found.data };

  const { named, isList } = unwrapOutput(info.returnType);
  const resolve = found.data as (context: ArgOverrideContext) => unknown;
  return {
    value: resolve({
      typeName: parentTypeName,
      fieldName: info.fieldName,
      args,
      pool: ctx.pool[named.name] ?? [],
      isList,
      faker: ctx.resolved.faker,
    }),
  };
}

/** Take a normally-sized draw off the front of an already-ordered list. */
function sizedWindow<T>(
  items: readonly T[],
  bounds: { min: number; max: number },
  faker: Faker,
): T[] {
  if (items.length === 0) return [];
  const max = bounds.max === UNBOUNDED ? items.length : Math.min(bounds.max, items.length);
  return items.slice(0, faker.number.int({ min: Math.min(bounds.min, max), max }));
}

/** A pooled instance, as opposed to a scalar or null the pool may also hold. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a plan matched on a field of the type it was built for, rather than a free-text term. */
function namesOwnField(plan: ArgPlan): boolean {
  return plan.equality.length > 0 || plan.contains.some((match) => match.field !== null);
}

/**
 * Rebuild a Relay edge list around matched nodes. The edges themselves carry cursors and a
 * `__typename`, so they are taken from the edge type's own pool and have their `node` replaced —
 * building `{ node }` from nothing would drop every other field the selection might ask for.
 */
function buildEdges(
  ctx: ResolveContext,
  edgeTypeName: string,
  nodes: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const edges = ctx.pool[edgeTypeName] ?? [];
  return nodes.map((node, index) => {
    const template = edges.length > 0 ? edges[index % edges.length] : undefined;
    return { ...(template ?? { __typename: edgeTypeName }), node };
  });
}

/**
 * Bring a Relay `pageInfo` in line with the page that was just produced. Only keys the pooled
 * `pageInfo` already has are touched, so a partial or custom shape keeps whatever it had.
 */
function syncPageInfo(
  wrapper: Record<string, unknown>,
  edges: readonly Record<string, unknown>[],
  skip: number,
  total: number,
): Record<string, unknown> | undefined {
  const pageInfo = wrapper.pageInfo;
  if (!isRecord(pageInfo)) return undefined;
  const cursorOf = (edge: Record<string, unknown> | undefined) => edge?.cursor;
  const updated: Record<string, unknown> = { ...pageInfo };
  if ('hasPreviousPage' in pageInfo) updated.hasPreviousPage = skip > 0;
  if ('hasNextPage' in pageInfo) updated.hasNextPage = skip + edges.length < total;
  if ('startCursor' in pageInfo) updated.startCursor = cursorOf(edges[0]) ?? null;
  if ('endCursor' in pageInfo) updated.endCursor = cursorOf(edges[edges.length - 1]) ?? null;
  return updated;
}

/**
 * Apply a field's arguments to the list *inside* the wrapper type it returns, and hand back a
 * copy of a pooled wrapper with that list replaced. Undefined means "not a wrapper this can
 * read", and the caller falls through to the ordinary draw.
 *
 * The replacement list is drawn from the entity's own pool rather than from whatever the wrapper
 * happened to be wired with in phase 2 — the same switch a direct list field makes when it is
 * paged, so `skip: 10` has more than a handful of rows to page through. The pooled wrapper is
 * copied, never mutated: it is shared with every other operation resolved from this graph.
 */
function unwrapListArgs(
  ctx: ResolveContext,
  named: GraphQLNamedType,
  args: Record<string, unknown>,
  info: RootFieldInfo,
  items: Record<string, unknown>[],
  outerPlan: ArgPlan | null,
): unknown {
  if (!ctx.arg.enabled) return undefined;
  // An argument that names a field on the returned type itself is about *that* object, not
  // about a list hanging off it: `warehouse(id: "w-1")` asks for one warehouse even though
  // `Warehouse.items` is the only object list on it. Only arguments that name nothing there —
  // a free-text search, paging — can be about the rows one level down.
  if (outerPlan && namesOwnField(outerPlan)) return undefined;
  const target = resolveListTarget(named, ctx.arg);
  if (!target) return undefined;

  const active = activeArgNames(info.fieldNodes, args, ctx.synthesized);
  // Matched as a list: `take`/`skip` only mean anything against one.
  const plan = buildArgPlan(fieldDefinition(info), target.entityType, true, args, active, ctx.arg);
  if (!plan) return undefined;

  const wrapper = pickRelated(items, SINGULAR_BOUNDS, false, ctx.resolved.faker);
  if (!isRecord(wrapper)) return undefined;

  // An emptied list is the one size that cannot be a sample. Every other length is a draw from
  // the pool, which is why paging reaches past it to the pool itself — but no draw returns `[]`
  // from a non-empty pool unless something asked for nothing: a `lists: 'empty'` profile, a
  // `relations` entry of 0 or null. Reaching past *that* answers an empty-state story with rows
  // sitting next to a total of zero, the one screen the profile exists to produce.
  const wired = wrapper[target.fieldName];
  if (Array.isArray(wired) && wired.length === 0) {
    if (target.edgeTypeName === undefined) return { ...wrapper };
    const emptyPageInfo = syncPageInfo(wrapper, [], 0, 0);
    return {
      ...wrapper,
      [target.fieldName]: [],
      ...(emptyPageInfo ? { pageInfo: emptyPageInfo } : {}),
    };
  }

  const entities = ctx.pool[target.entityType.name] ?? [];
  const rotated = plan.partitionKey
    ? partitionWindow(entities, plan.partitionKey, entities.length)
    : entities;
  // Paging is applied separately so the pre-paging count is available for `pageInfo`.
  const { items: filtered, filterMissed } = applyArgPlan(rotated, { ...plan, hasPaging: false });
  if (filterMissed && ctx.arg.onMissList === 'fallback') return undefined;
  const skip = plan.hasPaging ? (plan.page.skip ?? 0) : 0;
  // A partition selects nothing, it only says *which* rows — so the list stays the length the
  // wrapper was wired with and only its window moves. Without this, an argument that nothing
  // could interpret would swap a four-row panel for the entire pool.
  const windowed =
    !plan.hasFilters && !plan.hasPaging && Array.isArray(wired)
      ? filtered.slice(0, wired.length)
      : filtered;
  const paged = plan.hasPaging ? paginate(windowed, plan.page) : windowed;

  if (target.edgeTypeName === undefined) {
    return { ...wrapper, [target.fieldName]: paged };
  }
  const edges = buildEdges(ctx, target.edgeTypeName, paged);
  const pageInfo = syncPageInfo(wrapper, edges, skip, windowed.length);
  return {
    ...wrapper,
    [target.fieldName]: edges,
    ...(pageInfo ? { pageInfo } : {}),
  };
}

/**
 * Resolve a root operation field to instances drawn from the mock pool by its return type.
 *
 * Root fields have no owning instance, so `relations` reaches them through the root type:
 * `relations: { Query: { users: 3 } }`. Everything below the root follows the already-wired
 * references instead, so it was shaped in phase 2.
 *
 * When argument matching is on and the field's arguments are interpretable, the pool is
 * filtered and paged first; otherwise this is the plain sized draw.
 */
function pickFromPool(ctx: ResolveContext, info: RootFieldInfo, args: Record<string, unknown>) {
  const { schema, pool, resolved } = ctx;
  const { faker } = resolved;
  const { named, isList } = unwrapOutput(info.returnType);
  const empty = isList ? [] : null;
  // A non-null singular field must never resolve to null from a filter miss: that is a GraphQL
  // execution error, which is strictly worse than the random item the caller would have got.
  const isNonNullSingular = !isList && isNonNullType(info.returnType);

  const fallback = isList ? qaListLength(resolved.qa, resolved.listSize) : SINGULAR_BOUNDS;
  const spec = resolveRelation(info.parentType.name, info.fieldName, resolved.relations);
  const bounds = relationBounds(spec, fallback);
  if (bounds === null || bounds.max === 0) return empty;

  const isAbstract = isUnionType(named) || isInterfaceType(named);
  const concretePools = () =>
    isAbstract ? schema.getPossibleTypes(named).flatMap((t) => pool[t.name] ?? []) : [];

  // A function picks the value outright, from whichever pool backs the field. It is the most
  // specific lever there is, so argument matching leaves what it returns alone.
  if (typeof spec === 'function') {
    const value = spec({
      pool: isAbstract ? concretePools() : (pool[named.name] ?? []),
      faker,
      index: 0,
      instance: {},
      typeName: info.parentType.name,
      fieldName: info.fieldName,
      isList,
    });
    return isList && value === undefined ? [] : value;
  }

  const plan = planFor(ctx, named, isList, args, info);

  // Abstract types have no pool of their own — draw from a random concrete member instead.
  if (isAbstract) {
    const possible = schema.getPossibleTypes(named);
    /** Draw from a list of non-empty pools, with replacement across them. */
    const draw = (pools: Record<string, unknown>[][]): unknown => {
      // This branch draws with replacement, so `'all'` has to hand back the pools themselves.
      if (spec === 'all' && isList) return pools.flat();
      const pickOne = () => {
        const items = faker.helpers.arrayElement(pools);
        return items.length > 0 ? faker.helpers.arrayElement(items) : null;
      };
      // Drawn with replacement across the concrete pools, so a huge length needs no pool growth.
      if (isList) return Array.from({ length: faker.number.int(bounds) }, pickOne);
      return pickOne();
    };

    const candidates = possible
      .map((type) => {
        const items = pool[type.name] ?? [];
        // Each concrete type gets its own plan: an argument may name a field on one member
        // and not another, and a member matching nothing simply drops out of the draw.
        const typePlan =
          plan && items.length > 0
            ? buildArgPlan(
                fieldDefinition(info),
                type,
                isList,
                args,
                activeArgNames(info.fieldNodes, args, ctx.synthesized),
                ctx.arg,
              )
            : null;
        return typePlan ? applyArgPlan(items, typePlan).items : items;
      })
      .filter((items) => items.length > 0);

    if (candidates.length === 0) {
      if (plan?.hasFilters) {
        if (isList && ctx.arg.onMissList === 'empty') return [];
        if (!isList && !isNonNullSingular && ctx.arg.onMissSingular === 'empty') return null;
      }
      // Fall back to the unfiltered draw so a miss still produces something plausible.
      const unfiltered = possible
        .map((t) => pool[t.name] ?? [])
        .filter((items) => items.length > 0);
      return unfiltered.length === 0 ? empty : draw(unfiltered);
    }

    // What the arguments select is the answer; sizing only governs an unconstrained draw.
    if (isList && (plan?.hasFilters || plan?.hasPaging)) return candidates.flat();
    return draw(candidates);
  }

  const items = pool[named.name];
  if (items && items.length > 0) {
    // A field returning a wrapper describes the collection inside it, not the container: its
    // `take`/`search`/`id` are about the rows. So when the wrapper has a list this can read,
    // the inner match wins over anything the arguments happened to say about the wrapper —
    // a free-text `search` matches no string field on a `{ results, totalCount }` anyway, and
    // would only empty it.
    if (!isList && isObjectType(named)) {
      const unwrapped = unwrapListArgs(ctx, named, args, info, items, plan);
      if (unwrapped !== undefined) return unwrapped;
    }
    if (plan) {
      const source = plan.partitionKey
        ? partitionWindow(items, plan.partitionKey, items.length)
        : items;
      const { items: matched, filterMissed } = applyArgPlan(source, plan);
      if (!filterMissed) {
        // A partition on its own doesn't select rows, it only says *which* ones — so the draw
        // is still sized the way an unfiltered one would be, just from a different offset.
        if (isList && !plan.hasFilters && !plan.hasPaging) {
          return sizedWindow(matched, bounds, faker);
        }
        if (isList) return matched;
        // Equality on an id is unique, so the first match is the match; randomizing is noise.
        if (matched.length > 0) return matched[0];
      }
      if (isList && ctx.arg.onMissList === 'empty') return [];
      if (!isList && !isNonNullSingular && ctx.arg.onMissSingular === 'empty') return null;
      // A singular miss falls back to a random instance below. Stamp the values the caller
      // actually stated back over a *copy* of it, so a mutation reads back what it was handed
      // instead of somebody else's record. The pooled instance itself is never touched.
      if (!isList) {
        const echo = ctx.arg.echoOnMiss ? echoFromPlan(plan) : null;
        const picked = pickRelated(items, bounds, isList, faker);
        if (echo && isRecord(picked)) return { ...picked, ...echo };
        return picked;
      }
    }
    return pickRelated(items, bounds, isList, faker);
  }

  // No pool entry: object type with zero instances, or a scalar/enum returned at the root.
  if (isScalarType(named) || isEnumType(named)) {
    const leaf = () => mockLeaf(named, resolved);
    // Nothing to take "all" of without a pool, so an unbounded request keeps normal sizing.
    const length = bounds.max === UNBOUNDED ? fallback : bounds;
    return isList ? Array.from({ length: faker.number.int(length) }, leaf) : leaf();
  }
  return empty;
}

/**
 * Apply argument matching to an already-wired nested list (`user { posts(first: 2) }`). The
 * value comes from the default resolver, so this only ever narrows what was already there.
 */
function applyNestedArgs(
  ctx: ResolveContext,
  value: unknown,
  args: Record<string, unknown>,
  info: RootFieldInfo,
): unknown {
  if (!ctx.arg.enabled || !ctx.arg.nested || !Array.isArray(value)) return value;
  const { named, isList } = unwrapOutput(info.returnType);
  const plan = planFor(ctx, named, isList, args, info);
  if (!plan) return value;
  const objects = value.filter(
    (item): item is Record<string, unknown> => item != null && typeof item === 'object',
  );
  if (objects.length !== value.length) return value;
  // A partition redraws from the type's pool rather than reordering what phase 2 wired, because
  // reordering three aliases of one field still shows the same rows in three panels. The list
  // keeps the length it was wired with, so only *which* rows changes.
  const source = plan.partitionKey
    ? partitionWindow(
        (ctx.pool[named.name]?.length ?? 0) >= objects.length
          ? (ctx.pool[named.name] ?? objects)
          : objects,
        plan.partitionKey,
        objects.length,
      )
    : objects;
  const { items, filterMissed } = applyArgPlan(source, plan);
  if (filterMissed && ctx.arg.onMissList === 'fallback') return value;
  return items;
}

/** Build a non-null input value good enough to pass coercion (args don't affect resolution). */
function mockRequiredInput(type: GraphQLInputType, resolved: ResolvedOptions): unknown {
  if (isNonNullType(type)) return mockRequiredInput(type.ofType, resolved);
  if (isListType(type)) return []; // an empty list satisfies a non-null list type
  if (isInputObjectType(type)) {
    const value: Record<string, unknown> = {};
    for (const field of Object.values(type.getFields())) {
      // Only required fields without a default must be supplied; leave the rest unset.
      if (isNonNullType(field.type) && field.defaultValue === undefined) {
        value[field.name] = mockRequiredInput(field.type, resolved);
      }
    }
    return value;
  }
  return mockLeaf(type as GraphQLNamedType, resolved);
}

/**
 * Fill in variable values the operation requires so execution doesn't fail on missing
 * required variables. User-provided values win; required variables without a default get a
 * synthesized placeholder; nullable variables are left unset (coerced to null).
 *
 * The names of the synthesized variables are returned alongside the values: they are
 * placeholders that match nothing in the pool, so argument matching has to ignore any argument
 * bound to one of them.
 */
function synthesizeVariables(
  schema: GraphQLSchema,
  document: DocumentNode,
  provided: Record<string, unknown>,
  resolved: ResolvedOptions,
): { values: Record<string, unknown>; synthesized: Set<string> } {
  const operation = getOperationAST(document, undefined);
  const values: Record<string, unknown> = { ...provided };
  const synthesized = new Set<string>();
  for (const varDef of operation?.variableDefinitions ?? []) {
    const name = varDef.variable.name.value;
    if (name in values) continue;
    if (varDef.defaultValue != null) continue; // a default makes it effectively optional
    if (varDef.type.kind !== 'NonNullType') continue; // nullable → leave unset
    const type = typeFromAST(schema, varDef.type);
    if (type) {
      values[name] = mockRequiredInput(type, resolved);
      synthesized.add(name);
    }
  }
  return { values, synthesized };
}

/** The raw execution outcome: data plus any GraphQL errors, both left for the caller to handle. */
export interface OperationResult {
  data: unknown;
  errors?: readonly GraphQLFormattedError[];
}

/**
 * Execute `document` against the mock graph and return both data and errors. Root fields are
 * resolved from the pool by their return type; everything below uses the already-wired object
 * references, so the output matches the query's selection set.
 *
 * Callers that only want data use {@link resolveOperationData}; a transport needs the errors to
 * build a GraphQL error response instead of silently dropping them.
 */
export function resolveOperationResult(
  schema: GraphQLSchema,
  pool: Pool,
  resolved: ResolvedOptions,
  document: DocumentNode,
  variables?: Record<string, unknown>,
  argOverrides?: boolean | ArgMatchingOptions,
): OperationResult {
  const { values, synthesized } = synthesizeVariables(schema, document, variables ?? {}, resolved);
  const ctx: ResolveContext = {
    schema,
    pool,
    resolved,
    arg: resolveArgMatching(argOverrides ?? resolved.matchArguments),
    synthesized,
  };

  const rootTypeNames = new Set(
    [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()]
      .filter((t): t is NonNullable<typeof t> => t != null)
      .map((t) => t.name),
  );

  const result = executeSync({
    schema,
    document,
    rootValue: {},
    variableValues: values,
    // Root fields draw from the pool; nested fields read the wired references via the default.
    fieldResolver: (source, args, context, info) => {
      const override = argOverrideFor(ctx, info, args);
      if (override) return override.value;
      return rootTypeNames.has(info.parentType.name)
        ? pickFromPool(ctx, info, args)
        : applyNestedArgs(ctx, defaultFieldResolver(source, args, context, info), args, info);
    },
    // Abstract types (interface/union) resolve via the __typename carried by every mock.
    typeResolver: (value) =>
      value && typeof value === 'object' && '__typename' in value
        ? (value as { __typename?: string }).__typename
        : undefined,
  });

  return result.errors?.length
    ? { data: result.data ?? null, errors: result.errors.map((e) => e.toJSON()) }
    : { data: result.data ?? null };
}

/**
 * Execute `document` against the mock graph and return its data, warning on any GraphQL errors.
 */
export function resolveOperationData(
  schema: GraphQLSchema,
  pool: Pool,
  resolved: ResolvedOptions,
  document: DocumentNode,
  variables?: Record<string, unknown>,
  argOverrides?: boolean | ArgMatchingOptions,
): unknown {
  const { data, errors } = resolveOperationResult(
    schema,
    pool,
    resolved,
    document,
    variables,
    argOverrides,
  );
  if (errors?.length) {
    console.warn(`[graphql-mocks] dataForOperation: ${errors.map((e) => e.message).join('; ')}`);
  }
  return data;
}
