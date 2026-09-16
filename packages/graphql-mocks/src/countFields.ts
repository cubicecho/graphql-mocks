import { type GraphQLObjectType, isEnumType, isScalarType } from 'graphql';
import type { ResolvedQa } from './qa.js';
import type { ResolvedOptions } from './resolveOptions.js';
import { unwrapType } from './typeMocker.js';

/**
 * A QA `lists` profile resizes list fields and leaves everything else alone, which on the
 * wrapper shape most paginated APIs use produces a self-contradictory object:
 *
 * ```jsonc
 * { "results": [], "totalCount": 315 }
 * ```
 *
 * An empty-state story then renders its empty message *and* a footer reading "315 of 315" —
 * the one screen the profile exists to exercise is the one it gets wrong. `single` and `huge`
 * fail the same way in the other direction.
 *
 * This module pairs a count scalar with the list it counts and rewrites it to that list's
 * actual length, so all three profiles stay internally consistent.
 */

/**
 * Count names that name nothing in particular. These are the only ones allowed to pair with
 * "the type's one list field" — a name that *does* point somewhere has to actually reach it,
 * or `numberOfEmployees` would silently become the length of whatever list happened to be
 * nearby.
 */
const GENERIC_COUNT_NAMES = new Set([
  'count',
  'total',
  'totalcount',
  'totalitems',
  'totalresults',
  'itemcount',
  'resultcount',
  'numitems',
  'numberofitems',
]);

/** Affixes that mark a field as a count and leave the counted thing's name behind. */
const COUNT_SUFFIXES = ['count', 'total'];
const COUNT_PREFIXES = ['numberof', 'numof', 'num', 'count', 'total'];

/** Integer scalars a count can plausibly be. Deliberately not `Rating`, `Port` or `Byte`. */
const COUNT_SCALARS = new Set(['Int', 'Long', 'UnsignedInt', 'BigInt', 'NonNegativeInt']);

/** Just enough singularization to match `postCount` to `posts`; no lookup table, no lodash. */
function singular(word: string): string {
  if (word.endsWith('ies') && word.length > 3) return `${word.slice(0, -3)}y`;
  for (const ending of ['ses', 'xes', 'zes', 'ches', 'shes']) {
    if (word.endsWith(ending)) return word.slice(0, -2);
  }
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Compare field names the way a reader does: case-insensitively, and singular ≈ plural. */
function nameKey(word: string): string {
  return singular(word.toLowerCase());
}

/**
 * What a field name says about itself: `token` is the name of the thing it counts, when the
 * name carries one, and `generic` marks a count that names nothing. Undefined when the field
 * isn't a count at all.
 *
 * Both can be true at once — `totalCount` leaves `total` behind, which names nothing either —
 * which is why the caller tries the token against the type's lists first and only then falls
 * back to genericity.
 */
export function classifyCountField(
  fieldName: string,
): { token?: string; generic: boolean } | undefined {
  const lower = fieldName.toLowerCase();
  const generic = GENERIC_COUNT_NAMES.has(lower);

  for (const suffix of COUNT_SUFFIXES) {
    if (lower.endsWith(suffix) && lower.length > suffix.length) {
      return { token: lower.slice(0, -suffix.length), generic };
    }
  }
  for (const prefix of COUNT_PREFIXES) {
    if (lower.startsWith(prefix) && lower.length > prefix.length) {
      return { token: lower.slice(prefix.length), generic };
    }
  }
  return generic ? { generic } : undefined;
}

/** `[countFieldName, listFieldName]` pairs for one type, most specific source first. */
export function pairCountFields(
  objectType: GraphQLObjectType,
  qa: ResolvedQa,
  overrides: Record<string, unknown>,
): [string, string][] {
  const listFields: string[] = [];
  const countCandidates: string[] = [];

  for (const [fieldName, field] of Object.entries(objectType.getFields())) {
    const { namedType, isList } = unwrapType(field.type);
    if (isList) {
      listFields.push(fieldName);
      continue;
    }
    const isIntScalar =
      !isEnumType(namedType) && isScalarType(namedType) && COUNT_SCALARS.has(namedType.name);
    if (isIntScalar) countCandidates.push(fieldName);
  }

  const explicit = qa.countFields?.[objectType.name] ?? {};
  const pairs: [string, string][] = [];
  const claimed = new Set<string>();

  // An explicit pairing is the whole point of the option: take it verbatim, and say so when
  // it names a field that isn't there rather than quietly doing nothing.
  for (const [countField, listField] of Object.entries(explicit)) {
    if (!(countField in objectType.getFields())) {
      console.warn(
        `[graphql-mocks] qa.countFields: "${objectType.name}.${countField}" is not a field on that type`,
      );
      continue;
    }
    if (!listFields.includes(listField)) {
      console.warn(
        `[graphql-mocks] qa.countFields: "${objectType.name}.${listField}" is not a list field, so "${countField}" has nothing to count`,
      );
      continue;
    }
    pairs.push([countField, listField]);
    claimed.add(countField);
  }

  if (listFields.length === 0) return pairs;

  for (const countField of countCandidates) {
    if (claimed.has(countField)) continue;
    // An explicit `overrides` entry is a deliberate value; the QA profile doesn't outrank it.
    if (overrides[countField] !== undefined) continue;

    const classified = classifyCountField(countField);
    if (!classified) continue;

    if (classified.token !== undefined) {
      const key = nameKey(classified.token);
      const matches = listFields.filter((listField) => nameKey(listField) === key);
      if (matches.length === 1 && matches[0]) {
        pairs.push([countField, matches[0]]);
        continue;
      }
    }

    // A name that points nowhere can still be paired when there's only one list to mean.
    if (!classified.generic) continue;
    if (listFields.length === 1 && listFields[0]) {
      pairs.push([countField, listFields[0]]);
      continue;
    }

    console.warn(
      `[graphql-mocks] qa: "${objectType.name}.${countField}" looks like a count but ${objectType.name} has ${listFields.length} list fields, so the pairing is ambiguous — set qa.countFields to pair it, or qa.syncCounts: false to silence this`,
    );
  }

  return pairs;
}

/**
 * Rewrite every paired count scalar to the length of the list it counts. Runs after
 * relationships are wired (and mirrored), because that's when the lists are final.
 */
export function syncCountFields(
  objectTypes: GraphQLObjectType[],
  pool: Record<string, Record<string, unknown>[]>,
  resolved: ResolvedOptions,
): void {
  const { qa } = resolved;
  // Only a list profile creates the contradiction, so only a list profile repairs it.
  if (!qa?.lists || qa.syncCounts === false) return;

  for (const objectType of objectTypes) {
    const instances = pool[objectType.name] ?? [];
    if (instances.length === 0) continue;

    const pairs = pairCountFields(objectType, qa, resolved.overrides[objectType.name] ?? {});
    if (pairs.length === 0) continue;

    for (const instance of instances) {
      for (const [countField, listField] of pairs) {
        const value = instance[listField];
        // A nulled list says nothing about its count; leave the generated value alone.
        if (Array.isArray(value)) instance[countField] = value.length;
      }
    }
  }
}
