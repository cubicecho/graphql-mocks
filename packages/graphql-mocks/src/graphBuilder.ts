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
import { OPERATION_TYPE_NAMES, resolveCount } from './helpers.js';
import { type ResolvedQa, qaListLength } from './qa.js';
import { type ResolvedOptions, resolveOptions } from './resolveOptions.js';
import { mockTypeScalars, unwrapType } from './typeMocker.js';
import type { BuildMocksOptions, MockResult } from './types.js';

/** Pick a random element from an array; returns undefined if empty. */
function pickRandom<T>(arr: T[], faker: Faker): T | undefined {
  return arr.length === 0 ? undefined : faker.helpers.arrayElement(arr);
}

/**
 * Pick a random subset of an array — 1 to min(5, length) items normally, or the length the
 * active QA list profile asks for. Items are drawn without replacement, so a `huge` profile
 * is capped by the pool; `ResolvedOptions.defaultCount` grows the pools to compensate.
 */
function pickSubset<T>(arr: T[], faker: Faker, qa: ResolvedQa | undefined): T[] {
  if (arr.length === 0) return [];
  const { min, max } = qaListLength(qa, { min: 1, max: 5 });
  if (max === 0) return [];
  return faker.helpers.arrayElements(arr, {
    min: Math.min(min, arr.length),
    max: Math.min(max, arr.length),
  });
}

function createMockResult(
  pool: Record<string, unknown[]>,
  schema: GraphQLSchema,
  resolved: ResolvedOptions,
): MockResult {
  const { faker } = resolved;
  const dataForOperation = (
    document: Parameters<typeof resolveOperationData>[3],
    variables?: Record<string, unknown>,
  ) =>
    resolveOperationData(
      schema,
      pool as Record<string, Record<string, unknown>[]>,
      resolved,
      document,
      variables,
    );

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
      const data = dataForOperation(
        document,
        variablesForData(opOptions.variables) as Record<string, unknown> | undefined,
      );
      return buildMockOperation(document, data, opOptions);
    },
    mockOperationVariants(
      document: Parameters<typeof buildMockOperationVariants>[0],
      opOptions: MockOperationOptions = {},
    ) {
      const data = dataForOperation(
        document,
        variablesForData(opOptions.variables) as Record<string, unknown> | undefined,
      );
      return buildMockOperationVariants(document, data, opOptions);
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
  const resolved = resolveOptions(options);
  const { faker, qa, nullChance } = resolved;

  // Collect all non-operation, non-builtin object types
  const typeMap = schema.getTypeMap();
  const objectTypes = Object.values(typeMap).filter(
    (t): t is GraphQLObjectType =>
      isObjectType(t) && !t.name.startsWith('__') && !OPERATION_TYPE_NAMES.has(t.name),
  );

  // Phase 1: generate N instances per type with scalar/enum fields only
  const { addTypename, stableIds } = resolved;
  const pool: Record<string, Record<string, unknown>[]> = {};
  for (const objectType of objectTypes) {
    // `defaultCount` already accounts for a `huge` list profile needing pools at least as
    // large as the target length, since lists are sampled without replacement.
    const count = resolveCount(objectType.name, resolved.count, resolved.defaultCount);
    const idOverridden = resolved.overrides[objectType.name]?.id !== undefined;
    pool[objectType.name] = Array.from({ length: count }, (_, index) => {
      const instance = mockTypeScalars(objectType, resolved);
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
            ? pickSubset(relatedPool, faker, qa)
            : pickRandom(relatedPool, faker);
          continue;
        }

        if (isInterfaceType(namedType) || isUnionType(namedType)) {
          if (!resolved.resolveType) {
            console.warn(
              `[graphql-mocks] Field "${objectType.name}.${fieldName}" returns abstract type "${namedType.name}" — provide resolveType option to mock it`,
            );
            instance[fieldName] = null;
            continue;
          }
          const concreteName = resolved.resolveType(namedType.name);
          if (!(concreteName in pool)) {
            console.warn(
              `[graphql-mocks] resolveType returned unknown type "${concreteName}" for "${namedType.name}" — field will be null/empty`,
            );
          }
          const concretePool = pool[concreteName] ?? [];
          instance[fieldName] = isList
            ? pickSubset(concretePool, faker, qa)
            : pickRandom(concretePool, faker);
        }
      }
    }
  }

  return createMockResult(pool as Record<string, unknown[]>, schema, resolved);
}
