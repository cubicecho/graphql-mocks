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
