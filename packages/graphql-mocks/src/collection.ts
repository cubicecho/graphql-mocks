/**
 * Array primitives shared by the argument-matching engine and exported for hand-written
 * resolver-function mocks, so paging and filtering are expressed the same way in both places.
 */

/**
 * Offset/limit arguments in the dialects this package understands. `skip`/`offset` supply the
 * offset and `limit`/`first`/`take` the page size; the first one present in that order wins.
 * Cursor pagination (`after`/`before`) is deliberately not covered — there is no cursor concept
 * here to derive one from.
 */
export interface PageArgs {
  skip?: number | null;
  offset?: number | null;
  limit?: number | null;
  first?: number | null;
  take?: number | null;
}

/** First defined, non-null, finite number in the list; undefined when there is none. */
function firstNumber(values: readonly (number | null | undefined)[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Slice `items` by offset and page size. Absent or null arguments are no-ops, so
 * `paginate(items, {})` returns a copy of the whole list. A negative offset is clamped to 0
 * and a negative page size yields an empty list.
 *
 * ```ts
 * paginate(users, { skip: 10, limit: 5 }); // users.slice(10, 15)
 * ```
 */
export function paginate<T>(items: readonly T[], args: PageArgs): T[] {
  const offset = Math.max(0, firstNumber([args.skip, args.offset]) ?? 0);
  const size = firstNumber([args.limit, args.first, args.take]);
  if (size === undefined) return items.slice(offset);
  if (size <= 0) return [];
  return items.slice(offset, offset + size);
}

/**
 * One searchable field: a key, a dotted path through related objects (`'author.name'`), or an
 * accessor for anything a path can't express. A path may cross lists — `'comments.text'` on a
 * post searches every comment.
 */
export type SearchField<T> = string | ((item: T) => unknown);

/**
 * Collect every string a dotted path reaches. A nullish link ends that branch rather than
 * throwing, and a list is stepped through, so one path can yield several candidates.
 */
function stringsAtPath(value: unknown, path: readonly string[], found: string[]): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const entry of value) stringsAtPath(entry, path, found);
    return;
  }
  const [head, ...tail] = path;
  if (head === undefined) {
    if (typeof value === 'string') found.push(value);
    return;
  }
  if (typeof value !== 'object') return;
  stringsAtPath((value as Record<string, unknown>)[head], tail, found);
}

/** The strings one field contributes: an accessor's return value, or whatever its path reaches. */
function stringsForField<T>(item: T, field: SearchField<T>): string[] {
  if (typeof field === 'function') {
    const value = field(item);
    return typeof value === 'string' ? [value] : [];
  }
  const found: string[] = [];
  stringsAtPath(item, field.split('.'), found);
  return found;
}

/**
 * Case-insensitive substring filter. A null, undefined or empty term is a no-op and returns
 * every item.
 *
 * `fields` restricts which properties are searched. Each entry is a key, a dotted path into a
 * related object, or an accessor function; a path steps through lists and treats a missing link
 * as a non-match rather than throwing. Omit `fields` and every own string-valued property of
 * each item is searched — that shallow default never follows relations, so name the paths you
 * want when a related object is what you're filtering on.
 *
 * ```ts
 * searchItems(users, 'ann');                        // any own string field contains "ann"
 * searchItems(users, 'ann', ['name']);              // only `name`
 * searchItems(posts, 'ann', ['author.name']);       // through a relation
 * searchItems(posts, 'ann', ['comments.text']);     // through a list relation
 * searchItems(posts, 'ann', [(p) => p.author?.email]);
 * ```
 */
export function searchItems<T>(
  items: readonly T[],
  term: string | null | undefined,
  fields?: readonly SearchField<T>[],
): T[] {
  if (term == null || term === '') return items.slice();
  const needle = term.toLowerCase();
  const matches = (value: string) => value.toLowerCase().includes(needle);

  return items.filter((item) => {
    if (item == null || typeof item !== 'object') return false;
    if (fields === undefined) {
      return Object.values(item as Record<string, unknown>).some(
        (value) => typeof value === 'string' && matches(value),
      );
    }
    return fields.some((field) => stringsForField(item, field).some(matches));
  });
}

/**
 * Argument names this package reads a list's offset, page size and search term from, in
 * precedence order. Exported so a hand-written handler reads the same dialects the argument
 * matcher does, instead of each consumer guessing at the same list separately.
 *
 * `matchArguments: { offsetArgs, limitArgs, searchArgs }` replaces them for the matcher, and
 * {@link paginateArgs} takes the same three options.
 */
export const DEFAULT_OFFSET_ARGS = ['skip', 'offset'] as const;
export const DEFAULT_LIMIT_ARGS = ['limit', 'first', 'take'] as const;
export const DEFAULT_SEARCH_ARGS = [
  'search',
  'query',
  'q',
  'filter',
  'searchTerm',
  'term',
] as const;

export interface PaginateArgsOptions {
  /**
   * Which properties the search term filters on. Every own string-valued property when
   * omitted — the same rule {@link searchItems} follows.
   */
  searchFields?: readonly string[];
  /** Argument names carrying the offset, first present wins. @default DEFAULT_OFFSET_ARGS */
  offsetArgs?: readonly string[];
  /** Argument names carrying the page size. @default DEFAULT_LIMIT_ARGS */
  limitArgs?: readonly string[];
  /** Argument names carrying the search term. @default DEFAULT_SEARCH_ARGS */
  searchArgs?: readonly string[];
  /**
   * Page size when the arguments carry none. Unpaged when omitted, which is what a field with
   * no limit argument means — not an empty page.
   */
  defaultLimit?: number;
  /**
   * Read arguments nested one level inside an input object, so `where: { search: "ada" }` is
   * found. Matches the argument matcher's own default.
   * @default true
   */
  flattenInputs?: boolean;
}

/** What {@link paginateArgs} worked out, so the caller can shape its own envelope. */
export interface PaginatedArgs<T> {
  /** The page: what the search left, sliced by offset and page size. */
  items: T[];
  /** How many items the search left, before paging — what a `totalCount` is a total of. */
  matchedCount: number;
  /** How many were there to begin with, before the search. */
  totalCount: number;
  /** The values actually used, after defaults — handy in an assertion or a log line. */
  skip: number;
  limit: number | undefined;
  search: string | undefined;
}

/** Anything with an ordinary object prototype: an input object, not a Date or an array. */
function isInputObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Argument values by name, with an outer name beating a nested one, so the lookups below can
 * treat `where: { search: "ada" }` as if `search` had been passed at the top.
 */
function argLookup(args: Record<string, unknown>, flattenInputs: boolean): Map<string, unknown> {
  const flat = new Map<string, unknown>();
  const nested: Record<string, unknown>[] = [];

  const take = (record: Record<string, unknown>, collect: boolean): void => {
    for (const [name, value] of Object.entries(record)) {
      if (value === undefined || value === null) continue;
      if (isInputObject(value)) {
        if (collect) nested.push(value);
        continue;
      }
      // Never overwritten: the shallower name is the one the caller actually wrote.
      if (!flat.has(name)) flat.set(name, value);
    }
  };

  take(args, flattenInputs);
  // One level of nesting, the same budget `flattenDepth` defaults to.
  for (const record of nested) take(record, false);
  return flat;
}

function firstOf<T>(
  lookup: Map<string, unknown>,
  names: readonly string[],
  accept: (value: unknown) => value is T,
): T | undefined {
  for (const name of names) {
    const value = lookup.get(name);
    if (value !== undefined && accept(value)) return value;
  }
  return undefined;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * Search and page a list straight from a field's arguments — the preamble every `argOverrides`
 * handler otherwise writes by hand, and gets subtly wrong (a `limit` defaulting to `0` empties
 * the list; a `skip` defaulting to `undefined` pages differently from one defaulting to `0`):
 *
 * ```ts
 * argOverrides: [
 *   {
 *     match: { type: 'Query', field: 'searchPosts' },
 *     data: (ctx) => {
 *       const { items, matchedCount } = paginateArgs(ctx.pool, ctx, { searchFields: ['title'] });
 *       return { results: items, totalCount: matchedCount };
 *     },
 *   },
 * ]
 * ```
 *
 * The argument names come from the same lists the argument matcher uses, so a handler and the
 * matcher read `skip`/`offset`, `limit`/`first`/`take` and `search`/`query`/`q` alike.
 *
 * Takes the override context itself, or any `{ args }` object — including a bare
 * `{ args: variables }` when the values come from somewhere else.
 */
export function paginateArgs<T>(
  items: readonly T[],
  ctx: { args: Record<string, unknown> },
  options: PaginateArgsOptions = {},
): PaginatedArgs<T> {
  const lookup = argLookup(ctx.args ?? {}, options.flattenInputs ?? true);

  const search = firstOf(lookup, options.searchArgs ?? DEFAULT_SEARCH_ARGS, isString);
  const skip = Math.max(
    0,
    firstOf(lookup, options.offsetArgs ?? DEFAULT_OFFSET_ARGS, isFiniteNumber) ?? 0,
  );
  const limit =
    firstOf(lookup, options.limitArgs ?? DEFAULT_LIMIT_ARGS, isFiniteNumber) ??
    options.defaultLimit;

  const matched = searchItems(items, search, options.searchFields);
  return {
    items: paginate(matched, { skip, limit }),
    matchedCount: matched.length,
    totalCount: items.length,
    skip,
    limit,
    search,
  };
}
