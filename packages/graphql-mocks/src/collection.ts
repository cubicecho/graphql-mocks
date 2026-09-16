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
 * Case-insensitive substring filter. A null, undefined or empty term is a no-op and returns
 * every item. `fields` restricts which properties are searched; omitted, every own
 * string-valued property of each item is searched.
 *
 * ```ts
 * searchItems(users, 'ann');            // any string field contains "ann"
 * searchItems(users, 'ann', ['name']);  // only `name`
 * ```
 */
export function searchItems<T>(
  items: readonly T[],
  term: string | null | undefined,
  fields?: readonly string[],
): T[] {
  if (term == null || term === '') return items.slice();
  const needle = term.toLowerCase();
  return items.filter((item) => {
    if (item == null || typeof item !== 'object') return false;
    const record = item as Record<string, unknown>;
    const keys = fields ?? Object.keys(record);
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.toLowerCase().includes(needle)) return true;
    }
    return false;
  });
}
