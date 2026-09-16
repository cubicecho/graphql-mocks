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
import { qaListLength } from './qa.js';
import { pickRelated, relationBounds, resolveRelation } from './relations.js';
import { type ResolvedOptions, resolveOptions } from './resolveOptions.js';
import { mockTypeScalars, unwrapType } from './typeMocker.js';
import type { BuildMocksOptions, MockResult, RelationSpec } from './types.js';

/** List sizing when nothing more specific applies — 1 to min(5, pool length) items. */
const DEFAULT_LIST_BOUNDS = { min: 1, max: 5 };
/** A singular field draws exactly one object; the QA list profile does not apply to it. */
const SINGULAR_BOUNDS = { min: 1, max: 1 };

/**
 * Everything about one relationship field that doesn't vary by instance, resolved once per
 * type rather than once per instance × field. Also dedupes each warning to one per site.
 */
interface FieldPlan {
  fieldName: string;
  isRequired: boolean;
  isList: boolean;
  /** The user's `relations` entry, or undefined for "no opinion". */
  spec: RelationSpec | undefined;
  /** How many to draw, or null for none. Unused when `spec` is a function. */
  bounds: { min: number; max: number } | null;
  /** The pool to draw from, or undefined when the field can only ever be null. */
  targetPool: Record<string, unknown>[] | undefined;
}

/** Plan every non-scalar field of `objectType`, resolving abstract types to a concrete pool. */
function planRelationFields(
  objectType: GraphQLObjectType,
  pool: Record<string, Record<string, unknown>[]>,
  resolved: ResolvedOptions,
): FieldPlan[] {
  const plans: FieldPlan[] = [];

  for (const [fieldName, field] of Object.entries(objectType.getFields())) {
    const { namedType, isRequired, isList } = unwrapType(field.type);
    // Scalars and enums were already generated in phase 1.
    if (isScalarType(namedType) || isEnumType(namedType)) continue;

    const spec = resolveRelation(objectType.name, fieldName, resolved.relations);
    const fallback = isList ? qaListLength(resolved.qa, DEFAULT_LIST_BOUNDS) : SINGULAR_BOUNDS;
    const plan = { fieldName, isRequired, isList, spec, bounds: relationBounds(spec, fallback) };

    if (isObjectType(namedType)) {
      plans.push({ ...plan, targetPool: pool[namedType.name] ?? [] });
      continue;
    }

    if (isInterfaceType(namedType) || isUnionType(namedType)) {
      if (!resolved.resolveType) {
        console.warn(
          `[graphql-mocks] Field "${objectType.name}.${fieldName}" returns abstract type "${namedType.name}" — provide resolveType option to mock it`,
        );
        plans.push({ ...plan, targetPool: undefined });
        continue;
      }
      const concreteName = resolved.resolveType(namedType.name);
      if (!(concreteName in pool)) {
        console.warn(
          `[graphql-mocks] resolveType returned unknown type "${concreteName}" for "${namedType.name}" — field will be null/empty`,
        );
      }
      plans.push({ ...plan, targetPool: pool[concreteName] ?? [] });
    }
  }

  return plans;
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
    if (instances.length === 0) continue;
    const plans = planRelationFields(objectType, pool, resolved);

    for (const [index, instance] of instances.entries()) {
      for (const plan of plans) {
        const { fieldName, isList, spec, targetPool } = plan;
        // Phase 1 and `overrides` set the field already, and both outrank relations.
        if (fieldName in instance) continue;

        // A `relations` entry is the more specific lever, so it takes the field outright
        // instead of rolling against the global null chance.
        if (
          spec === undefined &&
          !plan.isRequired &&
          nullChance > 0 &&
          faker.datatype.boolean({ probability: nullChance })
        ) {
          instance[fieldName] = null;
          continue;
        }

        // An abstract field with no way to resolve it — already warned once per site.
        if (targetPool === undefined) {
          instance[fieldName] = null;
          continue;
        }

        instance[fieldName] =
          typeof spec === 'function'
            ? spec({
                pool: targetPool,
                faker,
                index,
                instance,
                typeName: objectType.name,
                fieldName,
                isList,
              })
            : pickRelated(targetPool, plan.bounds, isList, faker);
      }
    }
  }

  return createMockResult(pool as Record<string, unknown[]>, schema, resolved);
}
