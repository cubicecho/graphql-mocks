import { type GraphQLObjectType, type GraphQLSchema, isObjectType } from 'graphql';
import type { ResolvedOptions } from './resolveOptions.js';
import type { FieldOverrideFn, OverridesConfig } from './types.js';

/**
 * `fieldOverrides` says "every `imageUrl`, wherever it appears", which the generator has no
 * notion of: it reads overrides per type, per field. Rather than teach four call sites a second
 * lookup, this expands the name-keyed form against the schema once, into exactly the type-keyed
 * map the rest of the code already consumes.
 *
 * Doing it against the schema (rather than lazily, per field) is also what makes the
 * unmatched-key warning possible, which is the only typo check a name-keyed map can have.
 */

/** A key wrapped in slashes is a pattern: `/Url$/`, `/^is[A-Z]/i`. */
const PATTERN_KEY = /^\/(.+)\/([gimsuy]*)$/;

/**
 * The regular expression a key stands for, or `undefined` when the key is a plain field name.
 *
 * Unambiguous either way: a GraphQL field name is letters, digits and underscores only, so it
 * can never contain a slash and never be mistaken for a pattern.
 */
export function fieldOverridePattern(key: string): RegExp | undefined {
  const match = PATTERN_KEY.exec(key);
  if (!match?.[1]) return undefined;
  try {
    return new RegExp(match[1], match[2]);
  } catch (error) {
    throw new TypeError(
      `[graphql-mocks] fieldOverrides: "${key}" looks like a pattern but is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The object types a pooled instance is ever built for — the only place overrides can fire. */
function pooledTypes(schema: GraphQLSchema) {
  const operations = new Set(
    [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()]
      .filter((type): type is GraphQLObjectType => type != null)
      .map((type) => type.name),
  );
  return Object.values(schema.getTypeMap()).filter(
    (type) => isObjectType(type) && !type.name.startsWith('__') && !operations.has(type.name),
  );
}

/**
 * Fold `fieldOverrides` into `overrides`, resolving each field to the one function that owns it:
 * an exact name beats a pattern, an earlier pattern beats a later one, and a type-keyed entry
 * for the same field beats both — so the general rule stays overridable for a single type.
 *
 * Returns `resolved` untouched when there is nothing to expand, so the common path allocates
 * nothing.
 */
export function expandFieldOverrides(
  schema: GraphQLSchema,
  resolved: ResolvedOptions,
): ResolvedOptions {
  const config = resolved.fieldOverrides;
  if (config === undefined) return resolved;

  const exact = new Map<string, FieldOverrideFn>();
  const patterns: { key: string; test: RegExp; fn: FieldOverrideFn }[] = [];
  for (const [key, fn] of Object.entries(config)) {
    const test = fieldOverridePattern(key);
    if (test) patterns.push({ key, test, fn });
    else exact.set(key, fn);
  }

  const matched = new Set<string>();
  const find = (fieldName: string): FieldOverrideFn | undefined => {
    const byName = exact.get(fieldName);
    if (byName) {
      matched.add(fieldName);
      return byName;
    }
    for (const pattern of patterns) {
      // `lastIndex` would make a /g pattern skip every other field it is tested against.
      pattern.test.lastIndex = 0;
      if (pattern.test.test(fieldName)) {
        matched.add(pattern.key);
        return pattern.fn;
      }
    }
    return undefined;
  };

  const overrides: OverridesConfig = { ...resolved.overrides };
  for (const type of pooledTypes(schema)) {
    if (!isObjectType(type)) continue;
    const typeEntry = resolved.overrides[type.name];
    let expanded: Record<string, FieldOverrideFn> | undefined;

    for (const fieldName of Object.keys(type.getFields())) {
      const fn = find(fieldName);
      // Still "matched" when a type-keyed entry shadows it: a name the schema carries is not
      // the typo the warning below is looking for.
      if (!fn || typeEntry?.[fieldName] !== undefined) continue;
      expanded ??= {};
      expanded[fieldName] = fn;
    }

    if (expanded) overrides[type.name] = { ...expanded, ...typeEntry };
  }

  for (const key of Object.keys(config)) {
    if (matched.has(key)) continue;
    console.warn(
      `[graphql-mocks] fieldOverrides: "${key}" matches no field on any mocked type — check the spelling, or move it under "overrides" if it names a root field`,
    );
  }

  return { ...resolved, overrides };
}
