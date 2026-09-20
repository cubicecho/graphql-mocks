import { faker as defaultFaker } from '@faker-js/faker';
import type { Faker } from '@faker-js/faker';
import {
  type GraphQLSchema,
  type GraphQLType,
  isListType,
  isNonNullType,
  isObjectType,
} from 'graphql';
import type {
  BuildMocksOptions,
  CountConfig,
  ListSizeConfig,
  ListSizeRangeConfig,
  UniqueListsConfig,
} from './types.js';

export const OPERATION_TYPE_NAMES = new Set(['Query', 'Mutation', 'Subscription']);

export function resolveCount(
  typeName: string,
  config: CountConfig | undefined,
  defaultCount = 5,
): number {
  if (config === undefined) return defaultCount;
  if (typeof config === 'number') return config;
  return config[typeName] ?? config._default ?? defaultCount;
}

export function resolveFaker(options: BuildMocksOptions): Faker {
  const f = options.faker ?? defaultFaker;
  if (options.seed !== undefined) {
    f.seed(options.seed);
  }
  return f;
}

/** Inclusive size range for a generated list field. */
export interface ListSizeRange {
  min: number;
  max: number;
}

export const DEFAULT_LIST_SIZE: ListSizeRange = { min: 1, max: 5 };

/**
 * Whether a `listSize` value is the flat size form rather than a per-type map. A numeric
 * `min` or `max` is the discriminator: a map is keyed by GraphQL type names, and those are
 * capitalized by universal convention, so neither key can be one.
 */
export function isListSizeRange(config: ListSizeConfig | undefined): config is ListSizeRangeConfig {
  if (typeof config === 'number') return true;
  if (typeof config !== 'object' || config === null) return false;
  const { min, max } = config as { min?: unknown; max?: unknown };
  return typeof min === 'number' || typeof max === 'number';
}

/**
 * Normalize a `listSize` to the catch-all `{ min, max }` range: the flat form as written, or
 * a map's top-level `_default`. A bare number means an exact length, and bounds are clamped
 * non-negative and ordered, so `{ min: 5, max: 1 }` behaves as `{ 1, 5 }`.
 *
 * Named type and field entries are deliberately not consulted here — {@link lookupListSize}
 * reads those, because they outrank a QA list profile while this catch-all does not.
 */
export function resolveListSize(
  config: ListSizeConfig | undefined,
  fallback: ListSizeRange = DEFAULT_LIST_SIZE,
): ListSizeRange {
  if (config === undefined) return fallback;
  if (!isListSizeRange(config)) return resolveListSize(config._default, fallback);
  // A half-written `{ min: 2 }` types as a map entry rather than a range, so fill the missing
  // bound from the fallback instead of letting `undefined` reach `Math.max` as NaN.
  const { min, max } = typeof config === 'number' ? { min: config, max: config } : config;
  const lo = Math.max(0, min ?? fallback.min);
  const hi = Math.max(0, max ?? fallback.max);
  return lo <= hi ? { min: lo, max: hi } : { min: hi, max: lo };
}

/**
 * The size entry naming one field, resolved `[type][field]` → `[type]._default`, with a bare
 * size under the type name covering all of its lists. `undefined` means "no opinion", which
 * leaves the QA list profile and the catch-all size to decide.
 */
export function lookupListSize(
  typeName: string,
  fieldName: string,
  config: ListSizeConfig | undefined,
): ListSizeRange | undefined {
  if (config === undefined || isListSizeRange(config)) return undefined;

  const typeEntry = config[typeName];
  if (typeEntry === undefined) return undefined;
  if (isListSizeRange(typeEntry)) return resolveListSize(typeEntry);

  const fields = typeEntry as Record<string, ListSizeRangeConfig | undefined>;
  const entry = fields[fieldName] ?? fields._default;
  return entry === undefined ? undefined : resolveListSize(entry);
}

/** Whether a field returns a list, through an optional non-null wrapper. */
function isListField(type: GraphQLType): boolean {
  return isListType(isNonNullType(type) ? type.ofType : type);
}

/**
 * Reject entries of a per-type/per-field list option that name something the schema does not
 * have, or something that is not a list. Both are silent no-ops otherwise — and an option that
 * quietly does nothing is the exact failure the map forms were added to fix.
 *
 * `isFlat` tells the option's flat form (which names nothing, so there is nothing to check)
 * from a map, at both levels; `hint` closes the "not a list" message in the option's own terms.
 */
function validateListFieldMap(
  schema: GraphQLSchema,
  config: unknown,
  option: string,
  isFlat: (value: unknown) => boolean,
  hint: string,
): void {
  if (config === undefined || isFlat(config)) return;

  for (const [typeName, entry] of Object.entries(config as Record<string, unknown>)) {
    if (typeName === '_default') continue;

    const type = schema.getType(typeName);
    if (!isObjectType(type)) {
      throw new TypeError(
        `[graphql-mocks] ${option}: unknown type "${typeName}" — no object type by that name in the schema`,
      );
    }
    // A bare value under the type name covers every list it has, so there is no field to check.
    if (isFlat(entry)) continue;

    const fields = type.getFields();
    for (const fieldName of Object.keys(entry as Record<string, unknown>)) {
      if (fieldName === '_default') continue;

      const field = fields[fieldName];
      if (!field) {
        throw new TypeError(`[graphql-mocks] ${option}: unknown field "${typeName}.${fieldName}"`);
      }
      if (!isListField(field.type)) {
        throw new TypeError(
          `[graphql-mocks] ${option}: "${typeName}.${fieldName}" is not a list (${field.type}) — ${hint}`,
        );
      }
    }
  }
}

/**
 * Reject `listSize` entries that name something the schema does not have, or something that is
 * not a list.
 *
 * Sizes themselves are not checked: {@link resolveListSize} already clamps them non-negative
 * and orders inverted bounds.
 */
export function validateListSize(schema: GraphQLSchema, config: ListSizeConfig | undefined): void {
  validateListFieldMap(
    schema,
    config,
    'listSize',
    (value) => isListSizeRange(value as ListSizeConfig),
    'listSize only sizes lists, use overrides or relations for anything else',
  );
}

/** Whether a `uniqueLists` value is the flat on/off form rather than a per-type map. */
export function isUniqueListsFlag(config: unknown): config is boolean {
  return typeof config === 'boolean';
}

/**
 * The catch-all setting: the flat form as written, or a map's top-level `_default`. Named type
 * and field entries are read by {@link lookupUniqueLists} instead, because those outrank the
 * QA-driven fallback while this catch-all does not.
 */
export function resolveUniqueLists(
  config: UniqueListsConfig | undefined,
  fallback: boolean,
): boolean {
  if (config === undefined) return fallback;
  if (isUniqueListsFlag(config)) return config;
  return config._default ?? fallback;
}

/**
 * The entry naming one field, resolved `[type][field]` → `[type]._default`, with a bare flag
 * under the type name covering all of its lists. `undefined` means "no opinion", which leaves
 * the catch-all to decide.
 */
export function lookupUniqueLists(
  typeName: string,
  fieldName: string,
  config: UniqueListsConfig | undefined,
): boolean | undefined {
  if (config === undefined || isUniqueListsFlag(config)) return undefined;

  const typeEntry = config[typeName];
  if (typeEntry === undefined) return undefined;
  if (isUniqueListsFlag(typeEntry)) return typeEntry;

  const fields = typeEntry as Record<string, boolean | undefined>;
  return fields[fieldName] ?? fields._default;
}

/** Reject `uniqueLists` entries that name an unknown type or field, or a field that is not a list. */
export function validateUniqueLists(
  schema: GraphQLSchema,
  config: UniqueListsConfig | undefined,
): void {
  validateListFieldMap(
    schema,
    config,
    'uniqueLists',
    isUniqueListsFlag,
    'uniqueLists only applies to list fields',
  );
}
