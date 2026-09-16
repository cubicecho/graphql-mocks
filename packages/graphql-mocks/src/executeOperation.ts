import type { Faker } from '@faker-js/faker';
import {
  type DocumentNode,
  type GraphQLInputType,
  type GraphQLNamedType,
  type GraphQLOutputType,
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
import { type ResolvedQa, qaFallbackText, qaListLength, qaScalarMockers, resolveQa } from './qa.js';
import { resolveScalarMocker } from './scalarMockers.js';
import type { BuildMocksOptions, ScalarMocker } from './types.js';

type Pool = Record<string, Record<string, unknown>[]>;

/**
 * Active QA settings for one operation. Root fields are generated here rather than read from
 * the pool, so the profile has to be applied again on this path or `mockOperation` output
 * would drift from the pool it claims to represent.
 */
interface QaExecContext {
  qa: ResolvedQa | undefined;
  qaScalars: Record<string, ScalarMocker> | undefined;
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
function mockLeaf(
  named: GraphQLNamedType,
  faker: Faker,
  options: BuildMocksOptions,
  qaCtx: QaExecContext,
): unknown {
  if (isEnumType(named)) return named.getValues()[0]?.value ?? null;
  const mocker = resolveScalarMocker(named.name, options.scalars, qaCtx.qaScalars);
  if (mocker) return mocker(faker);
  return qaFallbackText(faker, qaCtx.qa) ?? faker.lorem.word();
}

/** Resolve a root operation field to instances drawn from the mock pool by its return type. */
function pickFromPool(
  schema: GraphQLSchema,
  returnType: GraphQLOutputType,
  pool: Pool,
  faker: Faker,
  options: BuildMocksOptions,
  qaCtx: QaExecContext,
): unknown {
  const { named, isList } = unwrapOutput(returnType);
  const length = qaListLength(qaCtx.qa, { min: 1, max: 5 });

  // Abstract types have no pool of their own — draw from a random concrete member instead.
  if (isUnionType(named) || isInterfaceType(named)) {
    const concrete = schema.getPossibleTypes(named).filter((t) => (pool[t.name]?.length ?? 0) > 0);
    if (concrete.length === 0) return isList ? [] : null;
    const pickOne = () => {
      const items = pool[faker.helpers.arrayElement(concrete).name];
      return items ? faker.helpers.arrayElement(items) : null;
    };
    // Drawn with replacement across the concrete pools, so a huge length needs no pool growth.
    if (isList) return Array.from({ length: faker.number.int(length) }, pickOne);
    return pickOne();
  }

  const items = pool[named.name];
  if (items && items.length > 0) {
    if (isList) {
      return faker.helpers.arrayElements(items, {
        min: Math.min(length.min, items.length),
        max: Math.min(length.max, items.length),
      });
    }
    return faker.helpers.arrayElement(items);
  }
  // No pool entry: object type with zero instances, or a scalar/enum returned at the root.
  if (isScalarType(named) || isEnumType(named)) {
    const leaf = () => mockLeaf(named, faker, options, qaCtx);
    return isList ? Array.from({ length: faker.number.int(length) }, leaf) : leaf();
  }
  return isList ? [] : null;
}

/** Build a non-null input value good enough to pass coercion (args don't affect resolution). */
function mockRequiredInput(
  type: GraphQLInputType,
  faker: Faker,
  options: BuildMocksOptions,
  qaCtx: QaExecContext,
): unknown {
  if (isNonNullType(type)) return mockRequiredInput(type.ofType, faker, options, qaCtx);
  if (isListType(type)) return []; // an empty list satisfies a non-null list type
  if (isInputObjectType(type)) {
    const value: Record<string, unknown> = {};
    for (const field of Object.values(type.getFields())) {
      // Only required fields without a default must be supplied; leave the rest unset.
      if (isNonNullType(field.type) && field.defaultValue === undefined) {
        value[field.name] = mockRequiredInput(field.type, faker, options, qaCtx);
      }
    }
    return value;
  }
  return mockLeaf(type as GraphQLNamedType, faker, options, qaCtx);
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
  faker: Faker,
  options: BuildMocksOptions,
  qaCtx: QaExecContext,
): Record<string, unknown> {
  const operation = getOperationAST(document, undefined);
  const result: Record<string, unknown> = { ...provided };
  for (const varDef of operation?.variableDefinitions ?? []) {
    const name = varDef.variable.name.value;
    if (name in result) continue;
    if (varDef.defaultValue != null) continue; // a default makes it effectively optional
    if (varDef.type.kind !== 'NonNullType') continue; // nullable → leave unset
    const type = typeFromAST(schema, varDef.type);
    if (type) result[name] = mockRequiredInput(type, faker, options, qaCtx);
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
  faker: Faker,
  options: BuildMocksOptions,
  document: DocumentNode,
  variables?: Record<string, unknown>,
): unknown {
  const qa = resolveQa(options.qa);
  const qaCtx: QaExecContext = { qa, qaScalars: qa ? qaScalarMockers(qa) : undefined };

  const rootTypeNames = new Set(
    [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()]
      .filter((t): t is NonNullable<typeof t> => t != null)
      .map((t) => t.name),
  );

  const result = executeSync({
    schema,
    document,
    rootValue: {},
    variableValues: synthesizeVariables(schema, document, variables ?? {}, faker, options, qaCtx),
    // Root fields draw from the pool; nested fields read the wired references via the default.
    fieldResolver: (source, args, context, info) =>
      rootTypeNames.has(info.parentType.name)
        ? pickFromPool(schema, info.returnType, pool, faker, options, qaCtx)
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
