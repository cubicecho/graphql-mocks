import type { Faker } from '@faker-js/faker';
import {
  type DocumentNode,
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
  isScalarType,
  isUnionType,
  typeFromAST,
} from 'graphql';
import { qaFallbackText, qaListLength } from './qa.js';
import { UNBOUNDED, pickRelated, relationBounds, resolveRelation } from './relations.js';
import type { ResolvedOptions } from './resolveOptions.js';
import { resolveScalarMocker } from './scalarMockers.js';

type Pool = Record<string, Record<string, unknown>[]>;

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

/** Default sizing for a root list field, before any QA profile or `relations` entry. */
const DEFAULT_ROOT_BOUNDS = { min: 1, max: 5 };
/** A singular root field resolves to exactly one object; list sizing does not apply. */
const SINGULAR_BOUNDS = { min: 1, max: 1 };

/** The parts of the resolver info a root field needs — its own site, and what it returns. */
type RootFieldInfo = Pick<GraphQLResolveInfo, 'fieldName' | 'parentType' | 'returnType'>;

/**
 * Resolve a root operation field to instances drawn from the mock pool by its return type.
 *
 * Root fields have no owning instance, so `relations` reaches them through the root type:
 * `relations: { Query: { users: 3 } }`. Everything below the root follows the already-wired
 * references instead, so it was shaped in phase 2.
 */
function pickFromPool(
  schema: GraphQLSchema,
  info: RootFieldInfo,
  pool: Pool,
  resolved: ResolvedOptions,
): unknown {
  const { faker } = resolved;
  const { named, isList } = unwrapOutput(info.returnType);
  const empty = isList ? [] : null;

  const fallback = isList ? qaListLength(resolved.qa, DEFAULT_ROOT_BOUNDS) : SINGULAR_BOUNDS;
  const spec = resolveRelation(info.parentType.name, info.fieldName, resolved.relations);
  const bounds = relationBounds(spec, fallback);
  if (bounds === null || bounds.max === 0) return empty;

  const isAbstract = isUnionType(named) || isInterfaceType(named);
  const concretePools = () =>
    isAbstract ? schema.getPossibleTypes(named).flatMap((t) => pool[t.name] ?? []) : [];

  // A function picks the value outright, from whichever pool backs the field.
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

  // Abstract types have no pool of their own — draw from a random concrete member instead.
  if (isAbstract) {
    const concrete = schema.getPossibleTypes(named).filter((t) => (pool[t.name]?.length ?? 0) > 0);
    if (concrete.length === 0) return empty;
    // This branch draws with replacement, so `'all'` has to hand back the pools themselves.
    if (spec === 'all' && isList) return concretePools();
    const pickOne = () => {
      const items = pool[faker.helpers.arrayElement(concrete).name];
      return items ? faker.helpers.arrayElement(items) : null;
    };
    // Drawn with replacement across the concrete pools, so a huge length needs no pool growth.
    if (isList) return Array.from({ length: faker.number.int(bounds) }, pickOne);
    return pickOne();
  }

  const items = pool[named.name];
  if (items && items.length > 0) return pickRelated(items, bounds, isList, faker);

  // No pool entry: object type with zero instances, or a scalar/enum returned at the root.
  if (isScalarType(named) || isEnumType(named)) {
    const leaf = () => mockLeaf(named, resolved);
    // Nothing to take "all" of without a pool, so an unbounded request keeps normal sizing.
    const length = bounds.max === UNBOUNDED ? fallback : bounds;
    return isList ? Array.from({ length: faker.number.int(length) }, leaf) : leaf();
  }
  return empty;
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
 */
function synthesizeVariables(
  schema: GraphQLSchema,
  document: DocumentNode,
  provided: Record<string, unknown>,
  resolved: ResolvedOptions,
): Record<string, unknown> {
  const operation = getOperationAST(document, undefined);
  const result: Record<string, unknown> = { ...provided };
  for (const varDef of operation?.variableDefinitions ?? []) {
    const name = varDef.variable.name.value;
    if (name in result) continue;
    if (varDef.defaultValue != null) continue; // a default makes it effectively optional
    if (varDef.type.kind !== 'NonNullType') continue; // nullable → leave unset
    const type = typeFromAST(schema, varDef.type);
    if (type) result[name] = mockRequiredInput(type, resolved);
  }
  return result;
}

/**
 * Execute an operation against the mock graph and return the shaped result data. Root
 * fields are resolved from the pool by their return type; everything below uses the
 * already-wired object references, so the output matches the query's selection set.
 */
export function resolveOperationData(
  schema: GraphQLSchema,
  pool: Pool,
  resolved: ResolvedOptions,
  document: DocumentNode,
  variables?: Record<string, unknown>,
): unknown {
  const rootTypeNames = new Set(
    [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()]
      .filter((t): t is NonNullable<typeof t> => t != null)
      .map((t) => t.name),
  );

  const result = executeSync({
    schema,
    document,
    rootValue: {},
    variableValues: synthesizeVariables(schema, document, variables ?? {}, resolved),
    // Root fields draw from the pool; nested fields read the wired references via the default.
    fieldResolver: (source, args, context, info) =>
      rootTypeNames.has(info.parentType.name)
        ? pickFromPool(schema, info, pool, resolved)
        : defaultFieldResolver(source, args, context, info),
    // Abstract types (interface/union) resolve via the __typename carried by every mock.
    typeResolver: (value) =>
      value && typeof value === 'object' && '__typename' in value
        ? (value as { __typename?: string }).__typename
        : undefined,
  });

  if (result.errors?.length) {
    console.warn(
      `[graphql-mocks] dataForOperation: ${result.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return result.data ?? null;
}
