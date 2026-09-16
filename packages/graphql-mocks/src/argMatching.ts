import {
  type FieldNode,
  type GraphQLField,
  type GraphQLNamedType,
  Kind,
  isEnumType,
  isInterfaceType,
  isObjectType,
  isScalarType,
} from 'graphql';
import { type PageArgs, paginate, searchItems } from './collection.js';
import { unwrapType } from './typeMocker.js';

/** What to do when a filter matches nothing. */
export type ArgMissBehavior = 'fallback' | 'empty';

/**
 * Fine-grained control over {@link BuildMocksOptions.matchArguments}. Every dimension can be
 * turned off independently; anything left unset keeps the default described on each field.
 */
export interface ArgMatchingOptions {
  /** Match pooled items whose field equals the argument value. @default true */
  equality?: boolean;
  /** Apply substring filters from search-style arguments. @default true */
  search?: boolean;
  /** Apply offset/limit arguments to list fields. @default true */
  paging?: boolean;
  /** Also interpret arguments on non-root fields (`user { posts(first: 2) }`). @default true */
  nested?: boolean;
  /** Argument names that supply a list offset. @default ['skip', 'offset'] */
  offsetArgs?: readonly string[];
  /** Argument names that supply a page size. @default ['limit', 'first', 'take'] */
  limitArgs?: readonly string[];
  /**
   * Argument names treated as a free-text search across every string field.
   * @default ['search', 'query', 'q', 'filter', 'searchTerm', 'term']
   */
  searchArgs?: readonly string[];
  /** Argument names never interpreted, whatever they look like. */
  ignoreArgs?: readonly string[];
  /**
   * What to do when a filter matches nothing. A singular field falls back to the normal random
   * pick, because a miss usually means an id that was never generated; a list returns `[]`,
   * because an empty result is a real state and returning rows that contradict the filter reads
   * as a bug. A non-null singular field always falls back regardless of this setting, since
   * `null` there is a GraphQL execution error.
   * @default { singular: 'fallback', list: 'empty' }
   */
  onMiss?: ArgMissBehavior | { singular?: ArgMissBehavior; list?: ArgMissBehavior };
  /**
   * Let an argument nothing else could interpret still *separate* the results. Three aliased
   * selections of one field differing only by `where: IN_STOCK | LOW_STOCK | OVER_STOCK` would
   * otherwise render three identical panels, which reads as a bug; with this on, each argument
   * value deterministically draws a different window of the pool.
   *
   * It does not make the rows *mean* the right thing — only the caller knows what `LOW_STOCK`
   * implies, which is what {@link BuildMocksOptions.argOverrides} is for. It makes the gap
   * visible instead of silent.
   * @default true
   */
  partition?: boolean;
}

export interface ResolvedArgMatching {
  enabled: boolean;
  equality: boolean;
  search: boolean;
  paging: boolean;
  nested: boolean;
  offsetArgs: readonly string[];
  limitArgs: readonly string[];
  searchArgs: readonly string[];
  ignoreArgs: ReadonlySet<string>;
  onMissSingular: ArgMissBehavior;
  onMissList: ArgMissBehavior;
  partition: boolean;
}

const DEFAULT_OFFSET_ARGS = ['skip', 'offset'] as const;
const DEFAULT_LIMIT_ARGS = ['limit', 'first', 'take'] as const;
const DEFAULT_SEARCH_ARGS = ['search', 'query', 'q', 'filter', 'searchTerm', 'term'] as const;

/** Normalize `matchArguments` into a fully-populated config. Disabled unless explicitly on. */
export function resolveArgMatching(
  option: boolean | ArgMatchingOptions | undefined,
): ResolvedArgMatching {
  const enabled = option !== undefined && option !== false;
  const config: ArgMatchingOptions = typeof option === 'object' ? option : {};
  const onMiss = config.onMiss;
  const missFor = (key: 'singular' | 'list', fallback: ArgMissBehavior): ArgMissBehavior => {
    if (typeof onMiss === 'string') return onMiss;
    return onMiss?.[key] ?? fallback;
  };
  return {
    enabled,
    equality: config.equality ?? true,
    search: config.search ?? true,
    paging: config.paging ?? true,
    nested: config.nested ?? true,
    offsetArgs: config.offsetArgs ?? DEFAULT_OFFSET_ARGS,
    limitArgs: config.limitArgs ?? DEFAULT_LIMIT_ARGS,
    searchArgs: config.searchArgs ?? DEFAULT_SEARCH_ARGS,
    ignoreArgs: new Set(config.ignoreArgs ?? []),
    onMissSingular: missFor('singular', 'fallback'),
    onMissList: missFor('list', 'empty'),
    partition: config.partition ?? true,
  };
}

/**
 * Argument names that carry authored intent — a literal, a schema or document default, or a
 * caller-supplied variable.
 *
 * `synthesizeVariables` invents values for required variables the caller didn't provide, so
 * `mockOperation(UserByIdQuery)` executes with a random `$id` that matches nothing. Filtering on
 * it would turn today's "a random user" into `null`. Any argument whose every AST occurrence is
 * such a synthesized variable is therefore dropped. Arguments present in the coerced values but
 * absent from the AST come from a schema-level default, which the schema author did write, so
 * they count as authored.
 */
export function activeArgNames(
  fieldNodes: readonly FieldNode[],
  argValues: Record<string, unknown>,
  synthesized: ReadonlySet<string>,
): Set<string> {
  const inAst = new Set<string>();
  const authored = new Set<string>();
  for (const node of fieldNodes) {
    for (const arg of node.arguments ?? []) {
      const name = arg.name.value;
      inAst.add(name);
      const isSynthesized =
        arg.value.kind === Kind.VARIABLE && synthesized.has(arg.value.name.value);
      if (!isSynthesized) authored.add(name);
    }
  }
  const active = new Set<string>();
  for (const name of Object.keys(argValues)) {
    if (!inAst.has(name) || authored.has(name)) active.add(name);
  }
  return active;
}

interface EqualityMatch {
  field: string;
  values: unknown[];
  /** Compare as strings too — `ID` is `"1"` in one place and `1` in another often enough. */
  coerce: boolean;
}

interface ContainsMatch {
  /** `null` means "search every string field". */
  field: string | null;
  term: string;
}

export interface ArgPlan {
  equality: EqualityMatch[];
  contains: ContainsMatch[];
  page: PageArgs;
  hasFilters: boolean;
  hasPaging: boolean;
  /**
   * The active arguments nothing else could interpret, as a stable `name=value` string. Empty
   * when there are none. It selects *which* window of the pool the field draws from — see
   * {@link partitionWindow} — rather than filtering anything.
   */
  partitionKey: string;
}

/** Scalar/enum, non-list fields of a type, which are the only ones equality can match on. */
function comparableFields(named: GraphQLNamedType): Map<string, { isId: boolean }> {
  const result = new Map<string, { isId: boolean }>();
  if (!isObjectType(named) && !isInterfaceType(named)) return result;
  for (const [fieldName, field] of Object.entries(named.getFields())) {
    const { namedType, isList } = unwrapType(field.type);
    if (isList) continue;
    if (!isScalarType(namedType) && !isEnumType(namedType)) continue;
    result.set(fieldName, { isId: namedType.name === 'ID' });
  }
  return result;
}

/** String-typed, non-list fields — the only targets for a `<field>Contains` argument. */
function stringFields(named: GraphQLNamedType): Set<string> {
  const result = new Set<string>();
  if (!isObjectType(named) && !isInterfaceType(named)) return result;
  for (const [fieldName, field] of Object.entries(named.getFields())) {
    const { namedType, isList } = unwrapType(field.type);
    if (!isList && isScalarType(namedType) && namedType.name === 'String') result.add(fieldName);
  }
  return result;
}

/** `titleContains` / `title_contains` → `title`, when `title` is a String field on the type. */
function containsTarget(argName: string, strings: ReadonlySet<string>): string | undefined {
  for (const suffix of ['Contains', '_contains']) {
    if (!argName.endsWith(suffix)) continue;
    const base = argName.slice(0, -suffix.length);
    if (strings.has(base)) return base;
  }
  return undefined;
}

/**
 * Classify a field's arguments into an executable plan. Returns `null` when no argument is
 * interpretable, so the caller takes the untouched random-pick path.
 *
 * Matching is deliberately narrow: an argument name must *exactly* equal a scalar or enum field
 * on the return type, be a recognized search or paging argument, or be `<field>Contains`. There
 * is no `authorId` -> `author.id` traversal and no snake/camel bridging, because a wrong guess
 * produces a silently empty result far from the query rather than an error.
 */
export function buildArgPlan(
  field: GraphQLField<unknown, unknown> | undefined,
  namedReturnType: GraphQLNamedType,
  isListReturn: boolean,
  argValues: Record<string, unknown>,
  active: ReadonlySet<string>,
  config: ResolvedArgMatching,
): ArgPlan | null {
  if (!field || active.size === 0) return null;
  const comparable = comparableFields(namedReturnType);
  const strings = stringFields(namedReturnType);

  const equality: EqualityMatch[] = [];
  const contains: ContainsMatch[] = [];
  const page: PageArgs = {};
  const partitions: string[] = [];
  let hasPaging = false;

  for (const argName of Object.keys(argValues)) {
    if (!active.has(argName) || config.ignoreArgs.has(argName)) continue;
    const value = argValues[argName];
    if (value === undefined) continue;

    if (config.paging && isListReturn && typeof value === 'number') {
      if (config.offsetArgs.includes(argName)) {
        page.skip = value;
        hasPaging = true;
        continue;
      }
      if (config.limitArgs.includes(argName)) {
        page.limit = value;
        hasPaging = true;
        continue;
      }
    }

    if (config.search && typeof value === 'string') {
      if (config.searchArgs.includes(argName)) {
        contains.push({ field: null, term: value });
        continue;
      }
      const target = containsTarget(argName, strings);
      if (target !== undefined) {
        contains.push({ field: target, term: value });
        continue;
      }
    }

    if (config.equality) {
      const direct = comparable.get(argName);
      if (direct && !Array.isArray(value)) {
        equality.push({ field: argName, values: [value], coerce: direct.isId });
        continue;
      }

      // `ids: [ID!]` -> an `in` match against the singular `id` field. One character of
      // tolerance, on an established convention; nothing looser than this.
      if (Array.isArray(value) && argName.endsWith('s')) {
        const singular = argName.slice(0, -1);
        const target = comparable.get(singular);
        if (target) {
          equality.push({ field: singular, values: value, coerce: target.isId });
          continue;
        }
      }
    }

    // Nothing interpreted this argument. If it is a single scalar or enum, it still says the
    // caller meant *these* rows rather than those, so it becomes a partition key.
    if (config.partition && isPartitionValue(value)) partitions.push(`${argName}=${value}`);
  }

  const hasFilters = equality.length > 0 || contains.length > 0;
  // Sorted so argument order in the document can't change which window a value draws.
  const partitionKey = partitions.sort().join('&');
  if (!hasFilters && !hasPaging && partitionKey === '') return null;
  return { equality, contains, page, hasFilters, hasPaging, partitionKey };
}

/** Values that can stand for a partition: a single scalar or enum, not a structure. */
function isPartitionValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** FNV-1a over the key. Any stable, well-spread string hash would do; this one is short. */
function hashKey(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * The slice of `items` a partition key draws: a rotation by a hash of the key, then `length`
 * items from there, wrapping.
 *
 * Rotating rather than hashing each item keeps every item reachable and keeps the result
 * contiguous, so a paged or ordered pool still reads as a page. Two different keys land on
 * different offsets; the same key always lands on the same one, so a re-render doesn't reshuffle
 * the panel.
 */
export function partitionWindow<T>(items: readonly T[], key: string, length: number): T[] {
  if (items.length === 0 || length <= 0) return [];
  const offset = hashKey(key) % items.length;
  const size = Math.min(length, items.length);
  const window: T[] = [];
  for (let i = 0; i < size; i++) window.push(items[(offset + i) % items.length] as T);
  return window;
}

function matchesEquality(item: Record<string, unknown>, match: EqualityMatch): boolean {
  const actual = item[match.field];
  return match.values.some(
    (expected) =>
      expected === actual || (match.coerce && String(expected) === String(actual ?? '')),
  );
}

/**
 * Run a plan over a list of pooled items. `filterMissed` is true when filters were present and
 * eliminated everything, which is what drives the miss ladder at the call site; paging is
 * applied after filtering and never counts as a miss.
 */
export function applyArgPlan(
  items: readonly Record<string, unknown>[],
  plan: ArgPlan,
): { items: Record<string, unknown>[]; filterMissed: boolean } {
  let current = items.slice();
  for (const match of plan.equality) {
    current = current.filter((item) => matchesEquality(item, match));
  }
  for (const match of plan.contains) {
    current = searchItems(current, match.term, match.field === null ? undefined : [match.field]);
  }
  const filterMissed = plan.hasFilters && current.length === 0;
  if (plan.hasPaging) current = paginate(current, plan.page);
  return { items: current, filterMissed };
}
