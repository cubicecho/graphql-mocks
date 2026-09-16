import type { Faker } from '@faker-js/faker';
import {
  type GraphQLObjectType,
  type GraphQLSchema,
  isEnumType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isUnionType,
} from 'graphql';
import {
  type MockOperationOptions,
  mockOperation as buildMockOperation,
  mockOperationVariants as buildMockOperationVariants,
  variablesForData,
} from './apolloMocks.js';
import { resolveOperationData } from './executeOperation.js';
import {
  type ListSizeRange,
  OPERATION_TYPE_NAMES,
  resolveCount,
  resolveFaker,
  resolveListSize,
} from './helpers.js';
import {
  type MockHandlerOptions,
  type MockRequestHandler,
  createRequestHandler,
} from './requestHandler.js';
import { mockTypeScalars, unwrapType } from './typeMocker.js';
import type { BuildMocksOptions, MockResult } from './types.js';

// The public builders are overloaded on static vs. resolver-function data; the graph-bound
// wrappers decide which applies at runtime, so they call through an unoverloaded view.
const looseMockOperation = buildMockOperation as (
  document: Parameters<typeof buildMockOperation>[0],
  data: unknown,
  options?: MockOperationOptions,
) => unknown;
const looseMockOperationVariants = buildMockOperationVariants as (
  document: Parameters<typeof buildMockOperationVariants>[0],
  data: unknown,
  options?: MockOperationOptions,
) => unknown;

/** Pick a random element from an array; returns undefined if empty. */
function pickRandom<T>(arr: T[], faker: Faker): T | undefined {
  return arr.length === 0 ? undefined : faker.helpers.arrayElement(arr);
}

/**
 * Pick a random subset of an array, without replacement. The size comes from `listSize`
 * (default 1–5) and is capped by the pool, since items are drawn without replacement.
 */
function pickSubset<T>(arr: T[], faker: Faker, size: ListSizeRange): T[] {
  if (arr.length === 0 || size.max === 0) return [];
  return faker.helpers.arrayElements(arr, {
    min: Math.min(size.min, arr.length),
    max: Math.min(size.max, arr.length),
  });
}

function createMockResult(
  pool: Record<string, unknown[]>,
  faker: Faker,
  schema: GraphQLSchema,
  options: BuildMocksOptions,
): MockResult {
  const dataForOperation = (
    document: Parameters<typeof resolveOperationData>[4],
    variables?: Record<string, unknown>,
    matchArguments?: Parameters<typeof resolveOperationData>[6],
  ) =>
    resolveOperationData(
      schema,
      pool as Record<string, Record<string, unknown>[]>,
      faker,
      options,
      document,
      variables,
      matchArguments,
    );

  /**
   * Data source for the graph-bound builders: a value resolved once by default, or a resolver
   * called per request when `dynamic` is set, so real incoming variables reach the argument
   * engine even when `request.variables` is a match-any predicate. `transform` applies to
   * whichever path runs.
   */
  const operationData = (
    document: Parameters<typeof buildMockOperation>[0],
    opOptions: MockOperationOptions,
  ): unknown => {
    const transform = opOptions.transform as
      | ((data: unknown, variables: Record<string, unknown>) => unknown)
      | undefined;
    const resolve = (variables: Record<string, unknown> | undefined) => {
      const data = dataForOperation(document, variables, opOptions.matchArguments);
      return transform ? transform(data, variables ?? {}) : data;
    };
    return opOptions.dynamic
      ? (variables: Record<string, unknown>) => resolve(variables)
      : resolve(variablesForData(opOptions.variables) as Record<string, unknown> | undefined);
  };

  const helpers = {
    find<T = unknown>(typeName: string, predicate: (item: T) => boolean): T | undefined {
      const items = pool[typeName] as T[] | undefined;
      return items?.find(predicate);
    },
    dataForOperation,
    mockOperation(
      document: Parameters<typeof buildMockOperation>[0],
      opOptions: MockOperationOptions = {},
    ) {
      return looseMockOperation(document, operationData(document, opOptions), opOptions);
    },
    mockOperationVariants(
      document: Parameters<typeof buildMockOperationVariants>[0],
      opOptions: MockOperationOptions = {},
    ) {
      return looseMockOperationVariants(document, operationData(document, opOptions), opOptions);
    },
    toRequestHandler(handlerOptions: MockHandlerOptions = {}): MockRequestHandler {
      return createRequestHandler(
        { schema, pool: pool as Record<string, Record<string, unknown>[]>, faker, options },
        handlerOptions,
      );
    },
    toResolvers(): Record<string, () => unknown> {
      const resolvers: Record<string, () => unknown> = {};
      for (const [typeName, items] of Object.entries(pool)) {
        const captured = items;
        resolvers[typeName] = () => {
          if (captured.length === 0) return null;
          return faker.helpers.arrayElement(captured);
        };
      }
      return resolvers;
    },
  };
  return Object.assign({}, pool, helpers) as MockResult;
}

export function buildGraph(schema: GraphQLSchema, options: BuildMocksOptions): MockResult {
  const faker = resolveFaker(options);
  const listSize = resolveListSize(options.listSize);

  // Collect all non-operation, non-builtin object types
  const typeMap = schema.getTypeMap();
  const objectTypes = Object.values(typeMap).filter(
    (t): t is GraphQLObjectType =>
      isObjectType(t) && !t.name.startsWith('__') && !OPERATION_TYPE_NAMES.has(t.name),
  );

  // Phase 1: generate N instances per type with scalar/enum fields only
  const addTypename = options.addTypename ?? true;
  const stableIds = options.stableIds ?? false;
  const pool: Record<string, Record<string, unknown>[]> = {};
  for (const objectType of objectTypes) {
    const count = resolveCount(objectType.name, options.count);
    const idOverridden = options.overrides?.[objectType.name]?.id !== undefined;
    pool[objectType.name] = Array.from({ length: count }, (_, index) => {
      const instance = mockTypeScalars(objectType, faker, options);
      if (addTypename) instance.__typename = objectType.name;
      if (stableIds && !idOverridden && 'id' in instance) {
        instance.id = `${objectType.name}-${index}`;
      }
      return instance;
    });
  }

  // Phase 2: wire relationship fields from the pool
  for (const objectType of objectTypes) {
    const instances = pool[objectType.name] ?? [];
    const fields = objectType.getFields();
    const nullChance = options.nullChance ?? 0;

    for (const instance of instances) {
      for (const [fieldName, field] of Object.entries(fields)) {
        // Skip fields already set in phase 1 or via overrides
        if (fieldName in instance) continue;

        const { namedType, isRequired, isList } = unwrapType(field.type);

        // Scalar/enum already handled in phase 1
        if (isScalarType(namedType) || isEnumType(namedType)) continue;

        // Apply null chance for nullable relationship fields
        if (!isRequired && nullChance > 0 && faker.datatype.boolean({ probability: nullChance })) {
          instance[fieldName] = null;
          continue;
        }

        if (isObjectType(namedType)) {
          const relatedPool = pool[namedType.name] ?? [];
          if (relatedPool.length === 0) {
            instance[fieldName] = isList ? [] : null;
            continue;
          }
          instance[fieldName] = isList
            ? pickSubset(relatedPool, faker, listSize)
            : pickRandom(relatedPool, faker);
          continue;
        }

        if (isInterfaceType(namedType) || isUnionType(namedType)) {
          if (!options.resolveType) {
            console.warn(
              `[graphql-mocks] Field "${objectType.name}.${fieldName}" returns abstract type "${namedType.name}" — provide resolveType option to mock it`,
            );
            instance[fieldName] = null;
            continue;
          }
          const concreteName = options.resolveType(namedType.name);
          if (!(concreteName in pool)) {
            console.warn(
              `[graphql-mocks] resolveType returned unknown type "${concreteName}" for "${namedType.name}" — field will be null/empty`,
            );
          }
          const concretePool = pool[concreteName] ?? [];
          instance[fieldName] = isList
            ? pickSubset(concretePool, faker, listSize)
            : pickRandom(concretePool, faker);
        }
      }
    }
  }

  return createMockResult(pool as Record<string, unknown[]>, faker, schema, options);
}
