import {
  type GraphQLNamedType,
  type GraphQLObjectType,
  isEnumType,
  isObjectType,
  isScalarType,
} from 'graphql';
import { pinnedFields } from './fixtures.js';
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
 *
 * The same pairing is worth having outside QA mode, which is what the top-level `countFields`
 * option turns on: a wrapper type's `totalCount` is only meaningful next to a `results` that
 * holds the whole pool it is a total of, and hand-wiring that takes a `relations` size and a
 * `derive` that have to agree on a number written twice.
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

/**
 * The count-syncing pass in force for a build, or `null` when it is off. The top-level option
 * decides outright when it is set — including `false`, which turns the pass off under a QA list
 * profile too — and otherwise a `lists` profile turns it on to repair what it resized.
 */
export interface CountSync {
  /** Explicit `count field -> list field` pairings, per type. */
  explicit: Record<string, Record<string, string>>;
  /** What to call the option in a warning, since two of them reach this code. */
  option: 'countFields' | 'qa.countFields';
  /** How to turn the pass off, for the same warnings. */
  disable: string;
  /**
   * Whether a paired list should be sized to its element pool. A QA list profile owns list
   * sizing — that is the whole point of the profile — so this is only true outside one.
   */
  sizeLists: boolean;
}

export function resolveCountSync(resolved: ResolvedOptions): CountSync | null {
  const { countFields, qa } = resolved;

  const explicit: Record<string, Record<string, string>> = {};
  for (const [typeName, pairs] of Object.entries(qa?.countFields ?? {})) {
    explicit[typeName] = { ...pairs };
  }
  if (typeof countFields === 'object') {
    for (const [typeName, pairs] of Object.entries(countFields)) {
      explicit[typeName] = { ...explicit[typeName], ...pairs };
    }
  }

  // The top-level option decides outright, whichever way it points.
  if (countFields === false) return null;
  if (countFields !== undefined) {
    return {
      explicit,
      option: 'countFields',
      disable: 'countFields: false',
      sizeLists: !qa?.lists,
    };
  }

  // Only a list profile creates the contradiction, so only a list profile repairs it.
  if (!qa?.lists || qa.syncCounts === false) return null;
  return { explicit, option: 'qa.countFields', disable: 'qa.syncCounts: false', sizeLists: false };
}

/** `[countFieldName, listFieldName]` pairs for one type, most specific source first. */
export function pairCountFields(
  objectType: GraphQLObjectType,
  sync: CountSync,
  /** The fields a caller pinned by hand — an `overrides` entry, or a `fixtures` row's key. */
  overrides: Record<string, unknown>,
  /** Off for the phase 2 pass, which walks the same pairings before the lists exist. */
  warn = true,
): [string, string][] {
  const report = warn ? (message: string) => console.warn(message) : () => {};
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

  const explicit = sync.explicit[objectType.name] ?? {};
  const pairs: [string, string][] = [];
  const claimed = new Set<string>();

  // An explicit pairing is the whole point of the option: take it verbatim, and say so when
  // it names a field that isn't there rather than quietly doing nothing.
  for (const [countField, listField] of Object.entries(explicit)) {
    if (!(countField in objectType.getFields())) {
      report(
        `[graphql-mocks] ${sync.option}: "${objectType.name}.${countField}" is not a field on that type`,
      );
      continue;
    }
    if (!listFields.includes(listField)) {
      report(
        `[graphql-mocks] ${sync.option}: "${objectType.name}.${listField}" is not a list field, so "${countField}" has nothing to count`,
      );
      continue;
    }
    pairs.push([countField, listField]);
    claimed.add(countField);
  }

  if (listFields.length === 0) return pairs;

  for (const countField of countCandidates) {
    if (claimed.has(countField)) continue;
    // A hand-written value — an `overrides` entry or a `fixtures` row's key — is deliberate;
    // an inferred pairing doesn't outrank it.
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

    report(
      `[graphql-mocks] ${sync.option}: "${objectType.name}.${countField}" looks like a count but ${objectType.name} has ${listFields.length} list fields, so the pairing is ambiguous — pair it explicitly, or set ${sync.disable} to silence this`,
    );
  }

  return pairs;
}

/**
 * The list fields of `objectType` that some count scalar counts, and so should hold the whole
 * pool of what they point at. Read during phase 2, before anything is wired — a count over a
 * six-item sample of a forty-item pool is a number no pager can page through.
 *
 * Silent here: phase 4 walks the same pairings and warns there, once the lists are final.
 */
export function countedListFields(
  objectType: GraphQLObjectType,
  resolved: ResolvedOptions,
): Set<string> {
  const sync = resolveCountSync(resolved);
  if (!sync?.sizeLists) return new Set();
  const pairs = pairCountFields(objectType, sync, pinnedFields(objectType.name, resolved), false);
  return new Set(pairs.map(([, listField]) => listField));
}

/**
 * The count fields of a wrapper type that count `listField`, rewritten to `length` — the patch
 * to spread over a wrapper whose list an operation's arguments have just narrowed.
 *
 * Phase 4 synced these counts against the *pooled* list, which holds the whole pool. That is
 * still the right answer for a paged query — `totalCount` is what the pager pages through, not
 * how many rows this page happens to carry — but a filter changes what is being totalled, and
 * a count left at the pool size renders two matched rows under a "40 results" pager. Callers
 * therefore pass the length *before* paging, which is the same number `pageInfo` is built from.
 *
 * Empty unless the build asked for count syncing at all: with it off, a count scalar is ordinary
 * generated data that happens to be an `Int`, and nothing says it was ever about that list.
 */
export function countsForList(
  objectType: GraphQLNamedType,
  listField: string,
  length: number,
  resolved: ResolvedOptions,
): Record<string, number> {
  if (!isObjectType(objectType)) return {};
  const sync = resolveCountSync(resolved);
  if (!sync) return {};

  const patch: Record<string, number> = {};
  // Silent: phase 4 already walked these same pairings and warned about the ambiguous ones.
  const pairs = pairCountFields(objectType, sync, pinnedFields(objectType.name, resolved), false);
  for (const [countField, paired] of pairs) {
    if (paired === listField) patch[countField] = length;
  }
  return patch;
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
  const sync = resolveCountSync(resolved);
  if (!sync) return;

  for (const objectType of objectTypes) {
    const instances = pool[objectType.name] ?? [];
    if (instances.length === 0) continue;

    const pairs = pairCountFields(objectType, sync, pinnedFields(objectType.name, resolved));
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
