import {
  type FieldNode,
  type GraphQLField,
  type GraphQLNamedType,
  Kind,
  isEnumType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isUnionType,
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
   * When a field returns a wrapper around a list (`{ results, totalCount }`, a Relay
   * connection), match the arguments against the *list's* type instead of the wrapper's, which
   * has no field named `search` or `take` to match on.
   * @default true
   */
  unwrap?: boolean;
  /**
   * Which field holds the list, for a wrapper the heuristics can't read: a field name used for
   * every wrapper, or a map from wrapper type name to field name
   * (`{ ProductSearchResult: 'results' }`).
   */
  listPath?: string | Record<string, string>;
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
  unwrap: boolean;
  listPath: string | Record<string, string> | undefined;
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
    unwrap: config.unwrap ?? true,
    listPath: config.listPath,
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

    if (!config.equality) continue;

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
      if (target) equality.push({ field: singular, values: value, coerce: target.isId });
    }
  }

  const hasFilters = equality.length > 0 || contains.length > 0;
  if (!hasFilters && !hasPaging) return null;
  return { equality, contains, page, hasFilters, hasPaging };
}

/** Where a wrapper type keeps the list its field's arguments are really about. */
export interface ListTarget {
  /** The wrapper field holding the list. */
  fieldName: string;
  /** The type the arguments are matched against — the list's element type, or a Relay node. */
  entityType: GraphQLNamedType;
  /**
   * Set when the list is a Relay edge list. The elements are edges wrapping the entity, so the
   * caller has to rebuild them rather than dropping matched entities straight in.
   */
  edgeTypeName?: string;
}

/** Object-typed list fields of `named`, in declaration order. */
function objectListFields(
  named: GraphQLNamedType,
): { fieldName: string; namedType: GraphQLNamedType }[] {
  if (!isObjectType(named) && !isInterfaceType(named)) return [];
  const found: { fieldName: string; namedType: GraphQLNamedType }[] = [];
  for (const [fieldName, field] of Object.entries(named.getFields())) {
    const { namedType, isList } = unwrapType(field.type);
    if (!isList) continue;
    if (!isObjectType(namedType) && !isInterfaceType(namedType) && !isUnionType(namedType)) {
      continue;
    }
    found.push({ fieldName, namedType });
  }
  return found;
}

/** The `node` field's type on a Relay edge, or undefined when this isn't one. */
function relayNodeType(edgeType: GraphQLNamedType): GraphQLNamedType | undefined {
  if (!isObjectType(edgeType) && !isInterfaceType(edgeType)) return undefined;
  const node = edgeType.getFields().node;
  return node ? unwrapType(node.type).namedType : undefined;
}

/**
 * Find the list a wrapper type's arguments are actually about.
 *
 * `products(take: Int, search: String): ProductSearchResult!` puts the arguments on the root
 * field but the rows one level down, under `results`. Matching against `ProductSearchResult`
 * finds nothing — it has no `take` or `search` field — and silently returns the wrapper
 * untouched, which is what makes paging controls in a story do nothing.
 *
 * Resolution order is explicit config, then the Relay shape, then a wrapper with exactly one
 * object-typed list. "Exactly one" is the whole safeguard: with two lists there is no way to
 * tell which one `take` refers to, so nothing is guessed and the old behavior stands.
 */
export function resolveListTarget(
  named: GraphQLNamedType,
  config: ResolvedArgMatching,
): ListTarget | undefined {
  if (!config.unwrap) return undefined;
  const lists = objectListFields(named);

  const configured =
    typeof config.listPath === 'string' ? config.listPath : config.listPath?.[named.name];
  if (configured !== undefined) {
    const match = lists.find((entry) => entry.fieldName === configured);
    if (!match) {
      const where = `"${named.name}.${configured}"`;
      const hint = 'is not an object list field, so the arguments were left on the wrapper';
      console.warn(`[graphql-mocks] matchArguments.listPath: ${where} ${hint}`);
      return undefined;
    }
    return asTarget(match);
  }

  const edges = lists.find((entry) => entry.fieldName === 'edges');
  if (edges && relayNodeType(edges.namedType)) return asTarget(edges);

  const [only] = lists;
  if (lists.length === 1 && only) return asTarget(only);
  return undefined;
}

/** Turn a located list field into a target, resolving the Relay indirection if there is one. */
function asTarget(entry: { fieldName: string; namedType: GraphQLNamedType }): ListTarget {
  const node = relayNodeType(entry.namedType);
  if (node) {
    return { fieldName: entry.fieldName, entityType: node, edgeTypeName: entry.namedType.name };
  }
  return { fieldName: entry.fieldName, entityType: entry.namedType };
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
