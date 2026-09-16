import type { Faker } from '@faker-js/faker';
import {
  type GraphQLSchema,
  isEnumType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isUnionType,
} from 'graphql';
import { unwrapType } from './typeMocker.js';
import type { RelationSpec, RelationsConfig } from './types.js';

/**
 * The size `'all'` resolves to: unbounded, clamped to the target pool at draw time.
 * Sentinel rather than a pool length so the bound stays pure.
 */
export const UNBOUNDED = Number.POSITIVE_INFINITY;

/** A bare object is a map of keys, never a `{ min, max }` range — see {@link RelationsConfig}. */
function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The relationship spec for one field, resolved most specific first:
 * `[type][field]` → `[type]._default` → `_default` → the flat top-level form.
 *
 * `undefined` means "no opinion" — the caller falls back to the QA list profile and the
 * built-in sizing — and stays distinct from `null`, which means "explicitly none".
 */
export function resolveRelation(
  typeName: string,
  fieldName: string,
  config: RelationsConfig | undefined,
): RelationSpec | undefined {
  if (config === undefined) return undefined;
  if (!isMap(config)) return config;

  const typeEntry = config[typeName];
  if (isMap(typeEntry)) {
    const fields = typeEntry as Record<string, RelationSpec | undefined>;
    const field = fields[fieldName];
    if (field !== undefined) return field;
    if (fields._default !== undefined) return fields._default;
  }
  return config._default;
}

/**
 * Coerce a spec into the `{ min, max }` the pool sampler wants, or `null` for "none".
 *
 * `fallback` covers the two specs that carry no size of their own: `undefined` (no entry,
 * where the caller has already folded in the QA list profile) and a {@link RelationFn},
 * which computes the value itself and never consults these bounds.
 */
export function relationBounds(
  spec: RelationSpec | undefined,
  fallback: { min: number; max: number },
): { min: number; max: number } | null {
  if (spec === null) return null;
  if (spec === undefined || typeof spec === 'function') return fallback;
  if (spec === 'all') return { min: UNBOUNDED, max: UNBOUNDED };
  if (typeof spec === 'number') return { min: spec, max: spec };
  return spec;
}

/** Whether the config opts into mirroring each relationship onto its inverse field. */
export function isReciprocal(relations: RelationsConfig | undefined): boolean {
  const mode = reciprocalMode(relations);
  return mode === true || mode === 'hidden';
}

/**
 * Whether mirrored back-references are ordinary enumerable properties. `'hidden'` makes them
 * non-enumerable, so a generic walk of a pooled object never reaches the cycle they create.
 */
export function reciprocalEnumerable(relations: RelationsConfig | undefined): boolean {
  return reciprocalMode(relations) !== 'hidden';
}

function reciprocalMode(relations: RelationsConfig | undefined): boolean | 'hidden' | undefined {
  if (relations === undefined || !isMap(relations)) return undefined;
  return relations._reciprocal as boolean | 'hidden' | undefined;
}

/**
 * Draw a field's related objects from the target pool, without replacement — the same object
 * twice in one list would collapse to a single entry under Apollo cache normalization.
 *
 * Bounds wider than the pool clamp to it, so `'all'` (unbounded) takes everything.
 */
export function pickRelated(
  pool: Record<string, unknown>[],
  bounds: { min: number; max: number } | null,
  isList: boolean,
  faker: Faker,
): unknown {
  const empty = isList ? [] : null;
  if (bounds === null || bounds.max === 0 || pool.length === 0) return empty;
  if (!isList) return faker.helpers.arrayElement(pool);
  return faker.helpers.arrayElements(pool, {
    min: Math.min(bounds.min, pool.length),
    max: Math.min(bounds.max, pool.length),
  });
}

/** A spec that asks for nothing at all. Functions are dynamic, so they're never "empty" here. */
function isEmptySpec(spec: RelationSpec | undefined): boolean {
  if (spec === null || spec === 0) return true;
  return typeof spec === 'object' && spec.max === 0;
}

/** Sizes must be whole, non-negative, and ordered; anything else is a caller mistake. */
function validateSize(spec: RelationSpec | undefined, site: string): void {
  const sizes =
    typeof spec === 'number'
      ? [spec]
      : typeof spec === 'object' && spec !== null
        ? [spec.min, spec.max]
        : [];
  for (const size of sizes) {
    if (!Number.isInteger(size) || size < 0) {
      throw new RangeError(
        `[graphql-mocks] relations: "${site}" must be a non-negative integer, got ${size}`,
      );
    }
  }
  if (typeof spec === 'object' && spec !== null && spec.min > spec.max) {
    throw new RangeError(
      `[graphql-mocks] relations: "${site}" has min ${spec.min} greater than max ${spec.max}`,
    );
  }
}

/**
 * Check a `relations` config against the schema before anything is generated.
 *
 * Only the keys actually written are checked, so this is eager validation of a caller
 * argument — a typo or an impossible size throws rather than silently doing nothing. The
 * catch-all forms (`_default`, the flat form) are deliberately *not* checked field by field:
 * they are meant to sweep over a schema, and a field they cannot legally empty is simply
 * populated as usual.
 */
export function validateRelations(
  schema: GraphQLSchema,
  relations: RelationsConfig | undefined,
): void {
  if (relations === undefined || !isMap(relations)) return;

  for (const [typeName, entry] of Object.entries(relations)) {
    if (typeName === '_default') {
      validateSize(entry as RelationSpec, '_default');
      continue;
    }
    if (typeName === '_reciprocal') continue;

    const type = schema.getType(typeName);
    if (!isObjectType(type)) {
      throw new TypeError(
        `[graphql-mocks] relations: unknown type "${typeName}" — no object type by that name in the schema`,
      );
    }
    if (!isMap(entry)) {
      throw new TypeError(
        `[graphql-mocks] relations: expected a field map for "${typeName}", got ${JSON.stringify(entry)} — write a catch-all as "${typeName}: { _default: … }"`,
      );
    }

    const fields = type.getFields();
    for (const [fieldName, fieldSpec] of Object.entries(entry as Record<string, RelationSpec>)) {
      const site = `${typeName}.${fieldName}`;
      if (fieldName === '_default') {
        validateSize(fieldSpec, `${typeName}._default`);
        continue;
      }

      const field = fields[fieldName];
      if (!field) {
        throw new TypeError(`[graphql-mocks] relations: unknown field "${site}"`);
      }
      const { namedType, isRequired, isList } = unwrapType(field.type);
      if (isScalarType(namedType) || isEnumType(namedType)) {
        throw new TypeError(
          `[graphql-mocks] relations: "${site}" is a ${namedType.name} field — relations only shapes relationships, use overrides for scalar values`,
        );
      }
      validateSize(fieldSpec, site);
      // An empty list still satisfies `[Todo!]!`; an empty singular field does not, and would
      // null the whole query at execution time.
      if (isRequired && !isList && isEmptySpec(fieldSpec)) {
        throw new TypeError(
          `[graphql-mocks] relations: "${site}" is non-null (${field.type}) and cannot be emptied — make it nullable in the schema, or drop the entry`,
        );
      }
    }
  }
}

/**
 * How many instances of each type the `relations` config needs in the pool, since lists are
 * drawn without replacement and so can never be longer than the pool they draw from.
 *
 * Only sized specs count: `'all'` takes whatever exists, `null` takes nothing, and a
 * {@link RelationFn} chooses for itself. The result raises the *default* count, so an
 * explicit `count` entry still wins — the same arrangement `lists: 'huge'` already uses.
 */
export function relationDemand(
  schema: GraphQLSchema,
  relations: RelationsConfig | undefined,
  resolveType?: (abstractTypeName: string) => string,
): Record<string, number> {
  const demand: Record<string, number> = {};
  if (relations === undefined) return demand;

  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || type.name.startsWith('__')) continue;

    for (const [fieldName, field] of Object.entries(type.getFields())) {
      const { namedType, isList } = unwrapType(field.type);
      // A singular field needs one object, which the default count already covers.
      if (!isList) continue;

      const spec = resolveRelation(type.name, fieldName, relations);
      const size = typeof spec === 'number' ? spec : isMap(spec) ? Number(spec.max) : 0;
      if (!size) continue;

      const targetName = isObjectType(namedType)
        ? namedType.name
        : (isInterfaceType(namedType) || isUnionType(namedType)) && resolveType
          ? resolveType(namedType.name)
          : undefined;
      if (targetName === undefined) continue;

      demand[targetName] = Math.max(demand[targetName] ?? 0, size);
    }
  }

  return demand;
}
