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
import { applyAliases, validateAliases } from './aliases.js';
import {
  type MockOperationOptions,
  mockOperation as buildMockOperation,
  mockOperationVariants as buildMockOperationVariants,
  variablesForData,
} from './apolloMocks.js';
import { countedListFields, syncCountFields } from './countFields.js';
import { resolveOperationData } from './executeOperation.js';
import { expandFieldOverrides } from './fieldOverrides.js';
import {
  OPERATION_TYPE_NAMES,
  resolveCount,
  validateListSize,
  validateUniqueLists,
} from './helpers.js';
import {
  type OperationMocks,
  type OperationModule,
  buildOperationMocks,
} from './operationsFrom.js';
import {
  isReciprocal,
  isRelationFilter,
  pickFiltered,
  pickRelated,
  reciprocalEnumerable,
  relationBounds,
  relationDemand,
  resolveRelation,
  validateRelations,
} from './relations.js';
import {
  type MockHandlerOptions,
  type MockRequestHandler,
  createRequestHandler,
} from './requestHandler.js';
import {
  type ResolvedOptions,
  isStableIdField,
  listSizeFor,
  resolveOptions,
} from './resolveOptions.js';
import { mockTypeScalars, unwrapType } from './typeMocker.js';
import type { BuildMocksOptions, FieldDeriveFn, MockResult, RelationSpec } from './types.js';

/** A singular field draws exactly one object; the QA list profile does not apply to it. */
const SINGULAR_BOUNDS = { min: 1, max: 1 };

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
  /** Name of the type this field points at, after resolving abstract types. */
  targetName: string;
  /** Set once a {@link RelationFn} has been warned about, to keep warnings one per site. */
  fnWarned?: boolean;
}

/**
 * Keep a {@link RelationFn}'s return value executable. A function can't be checked ahead of
 * time the way a literal spec can, so a non-null field it empties is repaired here — the
 * engine never emits a graph that would null a whole query at execution time.
 */
function coerceFnValue(
  value: unknown,
  plan: FieldPlan,
  pool: Record<string, unknown>[],
  faker: Faker,
  site: string,
): unknown {
  if (plan.isList) return value === undefined || (value === null && plan.isRequired) ? [] : value;
  if (value != null || !plan.isRequired || pool.length === 0) return value;

  if (!plan.fnWarned) {
    plan.fnWarned = true;
    console.warn(
      `[graphql-mocks] relations: the function for "${site}" returned nothing for a non-null field — using a pooled object instead`,
    );
  }
  return pickRelated(pool, SINGULAR_BOUNDS, false, faker);
}

/** Plan every non-scalar field of `objectType`, resolving abstract types to a concrete pool. */
function planRelationFields(
  objectType: GraphQLObjectType,
  pool: Record<string, Record<string, unknown>[]>,
  resolved: ResolvedOptions,
): FieldPlan[] {
  const plans: FieldPlan[] = [];
  const overrides = resolved.overrides[objectType.name] ?? {};
  // A list some count scalar counts holds the whole pool of what it points at, so the count and
  // the rows an argument-matched query pages through are totals of the same thing.
  const counted = countedListFields(objectType, resolved);

  /** Finish a plan against the pool it draws from, warning once per site about the result. */
  const commit = (
    plan: Omit<FieldPlan, 'targetPool' | 'targetName'>,
    targetPool: Record<string, unknown>[] | undefined,
    targetName: string,
  ) => {
    const emptied = plan.bounds === null || plan.bounds.max === 0;
    // A catch-all can't empty a non-null singular field — `[]` satisfies `[Todo!]!`, but
    // `null` satisfies nothing. An explicit entry that tries already threw in validation.
    const bounds = plan.isRequired && !plan.isList && emptied ? SINGULAR_BOUNDS : plan.bounds;

    // Asking for more than exists is silent otherwise: the draw is without replacement, so
    // the list simply comes back short. `'all'` and functions size themselves, so they can't.
    if (
      plan.isList &&
      plan.spec !== undefined &&
      plan.spec !== 'all' &&
      typeof plan.spec !== 'function' &&
      targetPool !== undefined &&
      bounds !== null &&
      bounds.max > targetPool.length
    ) {
      console.warn(
        `[graphql-mocks] relations: "${objectType.name}.${plan.fieldName}" asks for up to ${bounds.max} but the "${targetName}" pool holds ${targetPool.length} — raise count.${targetName} to get more`,
      );
    }

    // An empty pool nulls a non-null field just as surely, and that nulls the whole query.
    if (
      plan.isRequired &&
      !plan.isList &&
      targetPool?.length === 0 &&
      overrides[plan.fieldName] === undefined
    ) {
      console.warn(
        `[graphql-mocks] Field "${objectType.name}.${plan.fieldName}" is non-null but the "${targetName}" pool is empty — the field will be null, which nulls any query selecting it`,
      );
    }

    plans.push({ ...plan, bounds, targetPool, targetName });
  };

  for (const [fieldName, field] of Object.entries(objectType.getFields())) {
    const { namedType, isRequired, isList } = unwrapType(field.type);
    // Scalars and enums were already generated in phase 1.
    if (isScalarType(namedType) || isEnumType(namedType)) continue;

    // An explicit `relations` entry is the more specific lever and still decides the size.
    const relation = resolveRelation(objectType.name, fieldName, resolved.relations);
    const spec = relation === undefined && isList && counted.has(fieldName) ? 'all' : relation;
    const fallback = isList ? listSizeFor(objectType.name, fieldName, resolved) : SINGULAR_BOUNDS;
    const plan = { fieldName, isRequired, isList, spec, bounds: relationBounds(spec, fallback) };

    if (isObjectType(namedType)) {
      commit(plan, pool[namedType.name] ?? [], namedType.name);
      continue;
    }

    if (isInterfaceType(namedType) || isUnionType(namedType)) {
      if (!resolved.resolveType) {
        console.warn(
          `[graphql-mocks] Field "${objectType.name}.${fieldName}" returns abstract type "${namedType.name}" — provide resolveType option to mock it`,
        );
        commit(plan, undefined, namedType.name);
        continue;
      }
      const concreteName = resolved.resolveType(namedType.name);
      if (!(concreteName in pool)) {
        console.warn(
          `[graphql-mocks] resolveType returned unknown type "${concreteName}" for "${namedType.name}" — field will be null/empty`,
        );
      }
      commit(plan, pool[concreteName] ?? [], concreteName);
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
    matchArguments?: Parameters<typeof resolveOperationData>[5],
  ) =>
    resolveOperationData(
      schema,
      pool as Record<string, Record<string, unknown>[]>,
      resolved,
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
    at<T = unknown>(typeName: string, index: number): T | undefined {
      return (pool[typeName] as T[] | undefined)?.[index];
    },
    byId<T = unknown>(typeName: string, id: string | number): T | undefined {
      const wanted = String(id);
      return (pool[typeName] as { id?: unknown }[] | undefined)?.find(
        (item) => item != null && String(item.id) === wanted,
      ) as T | undefined;
    },
    ids(typeName: string): string[] {
      const items = pool[typeName] as { id?: unknown }[] | undefined;
      if (!items) return [];
      const result: string[] = [];
      for (const item of items) {
        if (item != null && item.id != null) result.push(String(item.id));
      }
      return result;
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
        { schema, pool: pool as Record<string, Record<string, unknown>[]>, resolved },
        handlerOptions,
      );
    },
    mockOperationsFrom<TModule extends OperationModule>(
      module: TModule,
      opOptions: MockOperationOptions = {},
    ): OperationMocks<TModule> {
      return buildOperationMocks(
        module,
        (document, docOptions) =>
          looseMockOperationVariants(
            document as Parameters<typeof buildMockOperationVariants>[0],
            operationData(document as Parameters<typeof buildMockOperation>[0], docOptions ?? {}),
            docOptions,
          ),
        opOptions,
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

/**
 * The field on `targetType` that points back at `ownerName`, or why there isn't one. The
 * inverse has to be unique to be unambiguous — two fields of the same type give no way to
 * know which one owns the relationship.
 */
function findInverseField(
  targetType: GraphQLObjectType,
  ownerName: string,
): { fieldName: string; isList: boolean } | 'ambiguous' | undefined {
  const matches = Object.entries(targetType.getFields())
    .map(([fieldName, field]) => ({ fieldName, ...unwrapType(field.type) }))
    .filter(({ namedType }) => namedType.name === ownerName);

  if (matches.length > 1) return 'ambiguous';
  const [match] = matches;
  return match && { fieldName: match.fieldName, isList: match.isList };
}

/**
 * Mirror every wired relationship back onto its inverse field, so `user.todos[i].user` is
 * that same user. Opt-in via `relations: { _reciprocal: true }`, and inherently lossy in one
 * direction: a Todo in two users' lists can only point at one owner, so the last write wins.
 *
 * `enumerable` is false under `_reciprocal: 'hidden'`: the back-reference still reads normally,
 * but a generic walk never enumerates it, so the cycle it creates stays out of the way of
 * `JSON.stringify` and friends.
 */
function wireReciprocal(
  schema: GraphQLSchema,
  objectTypes: GraphQLObjectType[],
  pool: Record<string, Record<string, unknown>[]>,
  plansByType: Map<string, FieldPlan[]>,
  enumerable: boolean,
): void {
  /** Assign the inverse field, hiding it from enumeration when that's what was asked for. */
  const write = (target: Record<string, unknown>, fieldName: string, value: unknown) => {
    if (enumerable) {
      target[fieldName] = value;
      return;
    }
    // Phase 2 already wrote the field as an ordinary property, so redefine rather than assign.
    Object.defineProperty(target, fieldName, {
      value,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  };

  for (const objectType of objectTypes) {
    for (const plan of plansByType.get(objectType.name) ?? []) {
      const targetType = schema.getType(plan.targetName);
      if (!isObjectType(targetType)) continue;

      const site = `${objectType.name}.${plan.fieldName}`;
      const inverse = findInverseField(targetType, objectType.name);
      if (inverse === undefined) {
        console.warn(
          `[graphql-mocks] relations: "${site}" has no inverse field on "${plan.targetName}" — nothing to mirror it onto`,
        );
        continue;
      }
      if (inverse === 'ambiguous') {
        console.warn(
          `[graphql-mocks] relations: "${plan.targetName}" has more than one field of type "${objectType.name}", so the inverse of "${site}" is ambiguous — skipped`,
        );
        continue;
      }

      for (const instance of pool[objectType.name] ?? []) {
        const value = instance[plan.fieldName];
        const related = (Array.isArray(value) ? value : [value]).filter(
          (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
        );

        for (const target of related) {
          if (!inverse.isList) {
            write(target, inverse.fieldName, instance);
            continue;
          }
          const existing = target[inverse.fieldName];
          if (!Array.isArray(existing)) {
            write(target, inverse.fieldName, [instance]);
          } else if (!existing.includes(instance)) {
            existing.push(instance);
          }
        }
      }
    }
  }
}

/**
 * Run `derive` over every pooled instance. Last phase by design: an instance is only complete
 * once relationships are wired, and a derived field is exactly the one that needs to read them.
 * A typo'd type or field name is worth saying out loud — a derive that never fires looks the
 * same as one whose value was overwritten.
 */
function applyDerive(
  objectTypes: GraphQLObjectType[],
  pool: Record<string, Record<string, unknown>[]>,
  resolved: ResolvedOptions,
): void {
  const { derive, faker } = resolved;
  if (!derive) return;

  const known = new Set(objectTypes.map((objectType) => objectType.name));
  for (const typeName of Object.keys(derive)) {
    if (!known.has(typeName)) {
      console.warn(`[graphql-mocks] derive: unknown type "${typeName}" — no pool to derive onto`);
    }
  }

  for (const objectType of objectTypes) {
    const fields = derive[objectType.name];
    if (!fields) continue;

    const schemaFields = objectType.getFields();
    // Object.entries order is the order the config was written, so one derive can read
    // another's result; hold the pairs once rather than re-walking per instance.
    const entries: [string, FieldDeriveFn][] = [];
    for (const [fieldName, fn] of Object.entries(fields)) {
      if (typeof fn !== 'function') continue;
      if (!(fieldName in schemaFields)) {
        console.warn(
          `[graphql-mocks] derive: "${objectType.name}.${fieldName}" is not a field on that type — the value will be in the pool but no query can select it`,
        );
      }
      entries.push([fieldName, fn as FieldDeriveFn]);
    }

    for (const [index, instance] of (pool[objectType.name] ?? []).entries()) {
      for (const [fieldName, fn] of entries) {
        instance[fieldName] = fn(instance, {
          index,
          typeName: objectType.name,
          fieldName,
          faker,
        });
      }
    }
  }
}

/**
 * Give one instance's identifier fields a stable, pool-unique value.
 *
 * `id` keeps the `TypeName-<index>` form it has always had. Any other identifier field carries
 * its own name as well, so an object with both `id` and `paymentMethodId` doesn't get the same
 * string twice — two fields that are supposed to identify different things, holding one value,
 * is the confusion this option exists to remove.
 *
 * Only string-valued scalars are replaced beyond `id` itself: the widened set is matched by
 * name, and writing `Order-externalId-0` over an `Int` or an enum would hand back data the
 * schema rejects. An `overrides` entry for the field still wins, and is the way to keep a
 * recognized field random.
 */
function applyStableIds(
  instance: Record<string, unknown>,
  objectType: GraphQLObjectType,
  index: number,
  resolved: ResolvedOptions,
): void {
  const { idPrefix } = resolved;
  const overrides = resolved.overrides[objectType.name] ?? {};

  for (const [fieldName, field] of Object.entries(objectType.getFields())) {
    if (!(fieldName in instance) || overrides[fieldName] !== undefined) continue;

    if (fieldName === 'id') {
      instance.id = `${idPrefix}${objectType.name}-${index}`;
      continue;
    }
    if (!isStableIdField(objectType.name, fieldName, resolved)) continue;

    const { namedType, isList } = unwrapType(field.type);
    if (isList || !isScalarType(namedType) || typeof instance[fieldName] !== 'string') continue;
    instance[fieldName] = `${idPrefix}${objectType.name}-${fieldName}-${index}`;
  }
}

export function buildGraph(schema: GraphQLSchema, options: BuildMocksOptions): MockResult {
  const resolved = expandFieldOverrides(schema, resolveOptions(options));
  validateRelations(schema, resolved.relations);
  validateListSize(schema, resolved.listSizes);
  validateUniqueLists(schema, resolved.uniqueListsConfig);
  validateAliases(schema, resolved.aliases);
  const { faker, qa, nullChance } = resolved;

  // Collect all non-operation, non-builtin object types
  const typeMap = schema.getTypeMap();
  const objectTypes = Object.values(typeMap).filter(
    (t): t is GraphQLObjectType =>
      isObjectType(t) && !t.name.startsWith('__') && !OPERATION_TYPE_NAMES.has(t.name),
  );

  // Phase 1: generate N instances per type with scalar/enum fields only
  const { addTypename, stableIds } = resolved;
  const demand = relationDemand(schema, resolved.relations, resolved.resolveType);
  const pool: Record<string, Record<string, unknown>[]> = {};
  for (const objectType of objectTypes) {
    // `defaultCount` already accounts for a `huge` list profile needing pools at least as
    // large as the target length, since lists are sampled without replacement; `demand` does
    // the same for the sizes `relations` asks for. An explicit `count` still wins over both.
    const count = resolveCount(
      objectType.name,
      resolved.count,
      Math.max(resolved.defaultCount, demand[objectType.name] ?? 0),
    );
    pool[objectType.name] = Array.from({ length: count }, (_, index) => {
      const instance = mockTypeScalars(objectType, resolved, index);
      if (addTypename) instance.__typename = objectType.name;
      if (stableIds) applyStableIds(instance, objectType, index, resolved);
      return instance;
    });
  }

  // Phase 2: wire relationship fields from the pool
  const plansByType = new Map<string, FieldPlan[]>();
  for (const objectType of objectTypes) {
    const instances = pool[objectType.name] ?? [];
    if (instances.length === 0) continue;
    const plans = planRelationFields(objectType, pool, resolved);
    plansByType.set(objectType.name, plans);

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

        if (typeof spec !== 'function' && !isRelationFilter(spec)) {
          instance[fieldName] = pickRelated(targetPool, plan.bounds, isList, faker);
          continue;
        }

        const relationCtx = {
          pool: targetPool,
          faker,
          index,
          instance,
          typeName: objectType.name,
          fieldName,
          isList,
        };
        const site = `${objectType.name}.${fieldName}`;

        if (isRelationFilter(spec)) {
          instance[fieldName] = pickFiltered(
            targetPool,
            spec,
            plan.bounds,
            relationCtx,
            site,
            faker,
          );
          continue;
        }

        const value = spec(relationCtx);
        instance[fieldName] = coerceFnValue(value, plan, targetPool, faker, site);
      }
    }
  }

  // Phase 3: mirror relationships onto their inverse fields, when asked to.
  if (isReciprocal(resolved.relations)) {
    wireReciprocal(
      schema,
      objectTypes,
      pool,
      plansByType,
      reciprocalEnumerable(resolved.relations),
    );
  }

  // Phase 4: bring count scalars in step with the lists they count — the lists a QA profile
  // resized, or the ones phase 2 sized to their pool for `countFields`.
  syncCountFields(objectTypes, pool, resolved);

  // Phase 5: compute fields that are a function of the finished object. Last, so a derive that
  // names a count field wins over phase 4's inference — it was written, the other was guessed.
  applyDerive(objectTypes, pool, resolved);

  // Phase 6: expose aliased fields under their alias names, once the values are final.
  applyAliases(objectTypes, pool, resolved.aliases);

  return createMockResult(pool as Record<string, unknown[]>, schema, resolved);
}
