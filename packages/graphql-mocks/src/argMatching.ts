import {
  type FieldNode,
  type GraphQLField,
  type GraphQLNamedType,
  Kind,
  type ValueNode,
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
  /** Argument names never interpreted, whatever they look like. Applies to nested names too. */
  ignoreArgs?: readonly string[];
  /**
   * Look inside input objects, so `where: { id: $id }` matches the `id` field on the returned
   * type exactly as a top-level `id: $id` does. Operator objects are unwrapped on the way —
   * `where: { id: { equals: $id } }` reads as `id: $id`, and `{ in: [...] }` as a set match.
   *
   * Turn it off for a schema where a nested field name collides with an unrelated field on the
   * return type.
   * @default true
   */
  flattenInputs?: boolean;
  /**
   * How many levels of input object to flatten. One level covers `where: { … }` and
   * `data: { … }`; raise it for schemas that nest filters further.
   * @default 1
   */
  flattenDepth?: number;
  /**
   * When an equality filter matches nothing and a singular field falls back to a random pooled
   * object, stamp the filtered values onto a copy of it — so a by-id query still answers with
   * the id it was asked about, and a cache normalizing the result agrees with the request.
   *
   * The pooled object itself is never touched. Only single-valued equality matches are echoed,
   * and only onto a singular field: echoing onto every row of a list would invent a set of
   * identical objects.
   * @default true
   */
  echoOnMiss?: boolean;
  /**
   * What to do when a filter matches nothing. A singular field falls back to the normal random
   * pick, because a miss usually means an id that was never generated; a list returns `[]`,
   * because an empty result is a real state and returning rows that contradict the filter reads
   * as a bug. A non-null singular field always falls back regardless of this setting, since
   * `null` there is a GraphQL execution error.
   * @default { singular: 'fallback', list: 'empty' }
   */
  onMiss?: ArgMissBehavior | { singular?: ArgMissBehavior; list?: ArgMissBehavior };
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
  flattenInputs: boolean;
  flattenDepth: number;
  echoOnMiss: boolean;
  onMissSingular: ArgMissBehavior;
  onMissList: ArgMissBehavior;
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
    flattenInputs: config.flattenInputs ?? true,
    flattenDepth: config.flattenDepth ?? 1,
    echoOnMiss: config.echoOnMiss ?? true,
    onMissSingular: missFor('singular', 'fallback'),
    onMissList: missFor('list', 'empty'),
  };
}

/**
 * Argument *paths* that carry authored intent — a literal, a schema or document default, or a
 * caller-supplied variable. A path is an argument name, then the input-object field names under
 * it: `id`, `where`, `where.id`, `where.id.equals`.
 *
 * `synthesizeVariables` invents values for required variables the caller didn't provide, so
 * `mockOperation(UserByIdQuery)` executes with a random `$id` that matches nothing. Filtering on
 * it would turn today's "a random user" into `null`. Any path whose every AST occurrence is
 * such a synthesized variable is therefore dropped — including a `where: { id: $id }` whose only
 * content is one, which is why authorship propagates up from the leaves rather than stopping at
 * the object literal. Paths present in the coerced values but absent from the AST come from a
 * schema-level default, which the schema author did write, so they count as authored.
 */
export function activeArgNames(
  fieldNodes: readonly FieldNode[],
  argValues: Record<string, unknown>,
  synthesized: ReadonlySet<string>,
): Set<string> {
  const inAst = new Set<string>();
  const authored = new Set<string>();

  /** Record one AST value at `path`, returning whether anything under it was authored. */
  const walk = (node: ValueNode, path: string): boolean => {
    inAst.add(path);
    if (node.kind === Kind.VARIABLE) {
      const isAuthored = !synthesized.has(node.name.value);
      if (isAuthored) authored.add(path);
      return isAuthored;
    }
    if (node.kind === Kind.OBJECT || node.kind === Kind.LIST) {
      const children =
        node.kind === Kind.OBJECT
          ? node.fields.map((field) => [field.value, `${path}.${field.name.value}`] as const)
          : node.values.map((value) => [value, path] as const);
      // An empty object or list is a written-out value in its own right.
      let isAuthored = children.length === 0;
      for (const [child, childPath] of children) {
        if (walk(child, childPath)) isAuthored = true;
      }
      if (isAuthored) authored.add(path);
      return isAuthored;
    }
    authored.add(path);
    return true;
  };

  for (const node of fieldNodes) {
    for (const arg of node.arguments ?? []) walk(arg.value, arg.name.value);
  }

  const active = new Set<string>();
  const visit = (value: unknown, path: string): void => {
    if (!inAst.has(path) || authored.has(path)) active.add(path);
    if (isInputObject(value)) {
      for (const [key, inner] of Object.entries(value)) visit(inner, `${path}.${key}`);
    }
  };
  for (const [name, value] of Object.entries(argValues)) visit(value, name);
  return active;
}

/** A coerced input-object value: a plain object, as GraphQL coercion produces. */
function isInputObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Operator objects, as ORM-generated schemas emit them. `equals`/`eq`/`is` carry one value,
 * `in` carries a set — both of which the equality matcher already understands. A comparison
 * this list doesn't cover (`gte`, `contains`, `not`) is left for flattening to walk into,
 * where it simply won't name a field on the return type.
 */
const SINGLE_VALUE_OPERATORS = ['equals', 'eq', 'is', '_eq'];
const SET_OPERATORS = ['in', '_in'];

/** The value an operator object stands for, or undefined when it isn't one. */
function unwrapOperator(
  value: Record<string, unknown>,
): { value: unknown; set: boolean } | undefined {
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  const [key] = keys;
  if (key === undefined) return undefined;
  if (SINGLE_VALUE_OPERATORS.includes(key)) return { value: value[key], set: false };
  if (SET_OPERATORS.includes(key)) return { value: value[key], set: true };
  return undefined;
}

/** One argument to interpret: the name matching is done against, and the value to match on. */
interface ArgEntry {
  name: string;
  value: unknown;
  /** The value is a set of alternatives (`{ in: [...] }`) rather than one value. */
  set?: boolean;
}

/**
 * Flatten the coerced arguments into the (name, value) pairs matching actually works on, so
 * `where: { id: $id }` arrives as `id: $id`. Inactive paths and ignored names drop out here,
 * which is why the matching loop below doesn't repeat those checks.
 */
function flattenArgs(
  argValues: Record<string, unknown>,
  active: ReadonlySet<string>,
  config: ResolvedArgMatching,
): ArgEntry[] {
  const entries: ArgEntry[] = [];

  const visit = (name: string, value: unknown, path: string, depth: number): void => {
    if (value === undefined || config.ignoreArgs.has(name)) return;

    if (isInputObject(value)) {
      // An operator object stands for its inner value, at whatever depth it's found: it renames
      // nothing, so it doesn't spend a level of the flattening budget.
      const operator = unwrapOperator(value);
      if (operator) {
        if (active.has(path)) entries.push({ name, value: operator.value, set: operator.set });
        return;
      }
      if (!config.flattenInputs || depth <= 0) return;
      for (const [key, inner] of Object.entries(value)) {
        visit(key, inner, `${path}.${key}`, depth - 1);
      }
      return;
    }

    if (active.has(path)) entries.push({ name, value });
  };

  for (const [name, value] of Object.entries(argValues)) {
    visit(name, value, name, config.flattenDepth);
  }
  return entries;
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

  for (const { name: argName, value, set } of flattenArgs(argValues, active, config)) {
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

    // `{ id: { in: [...] } }` already names its field; the values are the alternatives.
    if (set) {
      const target = comparable.get(argName);
      if (target && Array.isArray(value)) {
        equality.push({ field: argName, values: value, coerce: target.isId });
      }
      continue;
    }

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

/**
 * The single-valued equality matches of a plan, as a patch to stamp onto a fallback instance.
 * Null when there is nothing to echo.
 *
 * A mutation like `createUser(data: { name: $name })` has no pooled instance carrying that name,
 * so matching always misses and the caller gets a random user whose name is somebody else's —
 * the one thing the test just asserted on. Echoing the arguments that missed back over a copy of
 * that instance keeps the rest of the shape generated while the fields the caller *stated* read
 * back as stated. Only equality matches qualify: a substring or paging argument doesn't name a
 * value the field should hold.
 */
export function echoFromPlan(plan: ArgPlan): Record<string, unknown> | null {
  const echo: Record<string, unknown> = {};
  let any = false;
  for (const match of plan.equality) {
    const [value] = match.values;
    if (match.values.length !== 1) continue;
    echo[match.field] = value;
    any = true;
  }
  return any ? echo : null;
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
