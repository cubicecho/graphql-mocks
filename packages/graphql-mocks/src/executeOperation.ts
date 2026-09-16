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
  resolveArgMatching,
} from './argMatching.js';
import { type ListSizeRange, resolveListSize } from './helpers.js';
import { resolveScalarMocker } from './scalarMockers.js';
import type { BuildMocksOptions } from './types.js';

type Pool = Record<string, Record<string, unknown>[]>;

/** Everything the field resolvers need, bundled so the helper signatures stay readable. */
interface ResolveContext {
  schema: GraphQLSchema;
  pool: Pool;
  faker: Faker;
  options: BuildMocksOptions;
  listSize: ListSizeRange;
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
function mockLeaf(named: GraphQLNamedType, faker: Faker, options: BuildMocksOptions): unknown {
  if (isEnumType(named)) return named.getValues()[0]?.value ?? null;
  const mocker = resolveScalarMocker(named.name, options.scalars);
  return mocker ? mocker(faker) : faker.lorem.word();
}

/** The field definition backing the current resolver call, if the parent type has one. */
function fieldDefinition(info: GraphQLResolveInfo): GraphQLField<unknown, unknown> | undefined {
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
  info: GraphQLResolveInfo,
): ArgPlan | null {
  if (!ctx.arg.enabled) return null;
  const active = activeArgNames(info.fieldNodes, args, ctx.synthesized);
  return buildArgPlan(fieldDefinition(info), named, isList, args, active, ctx.arg);
}

/** Random subset of a pool, sized by `listSize` and capped by what the pool actually holds. */
function randomSubset(
  items: readonly Record<string, unknown>[],
  faker: Faker,
  listSize: ListSizeRange,
): Record<string, unknown>[] {
  if (items.length === 0 || listSize.max === 0) return [];
  return faker.helpers.arrayElements(items as Record<string, unknown>[], {
    min: Math.min(listSize.min, items.length),
    max: Math.min(listSize.max, items.length),
  });
}

/**
 * Resolve a root operation field to instances drawn from the mock pool by its return type.
 * When argument matching is on and the field's arguments are interpretable, the pool is
 * filtered and paged first; otherwise this is the plain random pick.
 */
function pickFromPool(
  ctx: ResolveContext,
  returnType: GraphQLOutputType,
  args: Record<string, unknown>,
  info: GraphQLResolveInfo,
): unknown {
  const { schema, pool, faker, options, listSize } = ctx;
  const { named, isList } = unwrapOutput(returnType);
  // A non-null singular field must never resolve to null from a filter miss: that is a GraphQL
  // execution error, which is strictly worse than the random item the caller would have got.
  const isNonNullSingular = !isList && isNonNullType(returnType);
  const plan = planFor(ctx, named, isList, args, info);

  // Abstract types have no pool of their own — draw from a random concrete member instead.
  if (isUnionType(named) || isInterfaceType(named)) {
    const candidates = schema
      .getPossibleTypes(named)
      .map((type) => {
        const items = pool[type.name] ?? [];
        if (items.length === 0) return { name: type.name, items, missed: false };
        // Each concrete type gets its own plan: an argument may name a field on one member
        // and not another, and a member matching nothing simply drops out of the draw.
        const typePlan = plan
          ? buildArgPlan(
              fieldDefinition(info),
              type,
              isList,
              args,
              activeArgNames(info.fieldNodes, args, ctx.synthesized),
              ctx.arg,
            )
          : null;
        if (!typePlan) return { name: type.name, items, missed: false };
        const applied = applyArgPlan(items, typePlan);
        return { name: type.name, items: applied.items, missed: applied.filterMissed };
      })
      .filter((candidate) => candidate.items.length > 0);

    if (candidates.length === 0) {
      if (plan?.hasFilters) {
        if (isList) return ctx.arg.onMissList === 'empty' ? [] : null;
        if (!isNonNullSingular && ctx.arg.onMissSingular === 'empty') return null;
      }
      // Fall back to the unfiltered draw so a miss still produces something plausible.
      const unfiltered = schema
        .getPossibleTypes(named)
        .filter((t) => (pool[t.name]?.length ?? 0) > 0);
      if (unfiltered.length === 0) return isList ? [] : null;
      const pickAny = () => {
        const items = pool[faker.helpers.arrayElement(unfiltered).name];
        return items ? faker.helpers.arrayElement(items) : null;
      };
      return isList ? Array.from({ length: faker.number.int(listSize) }, pickAny) : pickAny();
    }

    const pickOne = () => {
      const items = faker.helpers.arrayElement(candidates).items;
      return items.length > 0 ? faker.helpers.arrayElement(items) : null;
    };
    if (isList) {
      if (plan?.hasFilters || plan?.hasPaging) {
        return candidates.flatMap((candidate) => candidate.items);
      }
      return Array.from({ length: faker.number.int(listSize) }, pickOne);
    }
    return pickOne();
  }

  const items = pool[named.name];
  if (items && items.length > 0) {
    if (plan) {
      const { items: matched, filterMissed } = applyArgPlan(items, plan);
      if (!filterMissed) {
        if (isList) return matched;
        // Equality on an id is unique, so the first match is the match; randomizing is noise.
        if (matched.length > 0) return matched[0];
      }
      if (isList) return ctx.arg.onMissList === 'empty' ? [] : randomSubset(items, faker, listSize);
      if (!isNonNullSingular && ctx.arg.onMissSingular === 'empty') return null;
      // else: fall through to the plain random pick below
    }
    if (isList) return randomSubset(items, faker, listSize);
    return faker.helpers.arrayElement(items);
  }
  // No pool entry: object type with zero instances, or a scalar/enum returned at the root.
  if (isScalarType(named) || isEnumType(named)) {
    return isList ? [mockLeaf(named, faker, options)] : mockLeaf(named, faker, options);
  }
  return isList ? [] : null;
}

/**
 * Apply argument matching to an already-wired nested list (`user { posts(first: 2) }`). The
 * value comes from the default resolver, so this only ever narrows what was already there.
 */
function applyNestedArgs(
  ctx: ResolveContext,
  value: unknown,
  args: Record<string, unknown>,
  info: GraphQLResolveInfo,
): unknown {
  if (!ctx.arg.enabled || !ctx.arg.nested || !Array.isArray(value)) return value;
  const { named, isList } = unwrapOutput(info.returnType);
  const plan = planFor(ctx, named, isList, args, info);
  if (!plan) return value;
  const objects = value.filter(
    (item): item is Record<string, unknown> => item != null && typeof item === 'object',
  );
  if (objects.length !== value.length) return value;
  const { items, filterMissed } = applyArgPlan(objects, plan);
  if (filterMissed && ctx.arg.onMissList === 'fallback') return value;
  return items;
}

/** Build a non-null input value good enough to pass coercion (args don't affect resolution). */
function mockRequiredInput(
  type: GraphQLInputType,
  faker: Faker,
  options: BuildMocksOptions,
): unknown {
  if (isNonNullType(type)) return mockRequiredInput(type.ofType, faker, options);
  if (isListType(type)) return []; // an empty list satisfies a non-null list type
  if (isInputObjectType(type)) {
    const value: Record<string, unknown> = {};
    for (const field of Object.values(type.getFields())) {
      // Only required fields without a default must be supplied; leave the rest unset.
      if (isNonNullType(field.type) && field.defaultValue === undefined) {
        value[field.name] = mockRequiredInput(field.type, faker, options);
      }
    }
    return value;
  }
  return mockLeaf(type as GraphQLNamedType, faker, options);
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
  faker: Faker,
  options: BuildMocksOptions,
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
      values[name] = mockRequiredInput(type, faker, options);
      synthesized.add(name);
    }
  }
  return { values, synthesized };
}

/**
 * Execute an operation against the mock graph and return the shaped result data. Root
 * fields are resolved from the pool by their return type; everything below uses the
 * already-wired object references, so the output matches the query's selection set.
 */
/** The raw execution outcome: data plus any GraphQL errors, both left for the caller to handle. */
export interface OperationResult {
  data: unknown;
  errors?: readonly GraphQLFormattedError[];
}

/**
 * Execute `document` against the mock graph and return both data and errors. Callers that only
 * want data use {@link resolveOperationData}; a transport needs the errors to build a GraphQL
 * error response instead of silently dropping them.
 */
export function resolveOperationResult(
  schema: GraphQLSchema,
  pool: Pool,
  faker: Faker,
  options: BuildMocksOptions,
  document: DocumentNode,
  variables?: Record<string, unknown>,
  argOverrides?: boolean | ArgMatchingOptions,
): OperationResult {
  const { values, synthesized } = synthesizeVariables(
    schema,
    document,
    variables ?? {},
    faker,
    options,
  );
  const ctx: ResolveContext = {
    schema,
    pool,
    faker,
    options,
    listSize: resolveListSize(options.listSize),
    arg: resolveArgMatching(argOverrides ?? options.matchArguments),
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
    fieldResolver: (source, args, context, info) =>
      rootTypeNames.has(info.parentType.name)
        ? pickFromPool(ctx, info.returnType, args, info)
        : applyNestedArgs(ctx, defaultFieldResolver(source, args, context, info), args, info),
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
  faker: Faker,
  options: BuildMocksOptions,
  document: DocumentNode,
  variables?: Record<string, unknown>,
  argOverrides?: boolean | ArgMatchingOptions,
): unknown {
  const { data, errors } = resolveOperationResult(
    schema,
    pool,
    faker,
    options,
    document,
    variables,
    argOverrides,
  );
  if (errors?.length) {
    console.warn(`[graphql-mocks] dataForOperation: ${errors.map((e) => e.message).join('; ')}`);
  }
  return data;
}
