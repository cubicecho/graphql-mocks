import type { GraphQLSchema } from 'graphql';
import { isObjectType } from 'graphql';
import { OPERATION_TYPE_NAMES } from './helpers.js';
import type { ResolvedOptions } from './resolveOptions.js';

/**
 * Every schema has a handful of small, closed, enum-like types — currencies, statuses, roles,
 * plan tiers. Generated values for those are worse than useless: a `Currency` whose `code` is
 * `"eaque"` and whose `rate` is `613.47` turns every screen that formats money into noise.
 *
 * Pinning one used to mean an override per field, each reading the same cycled record — four
 * callbacks wrapped around three rows of data, and a field added to the data but not to the
 * overrides stays silently generated. `fixtures` says it the other way round: *this type's pool
 * **is** these objects*. The rows are the declaration, and the generator fills in whatever they
 * leave out.
 */

/** One pinned instance. Keys are field names; a field a row omits is generated as usual. */
export type FixtureRow = Record<string, unknown>;

/** The resolved, untyped form of `fixtures`: any type name, any field name. */
export type LooseFixturesMap = Record<string, readonly FixtureRow[] | undefined>;

/**
 * The row instance `index` of a type is pinned to, cycled over the list.
 *
 * Cycling is what the hand-written override form was already doing with `% length`, and it is
 * the only sensible answer when the pool is larger than the list — which `count` or a
 * `relations` size can both ask for. {@link validateFixtures} has already rejected an empty
 * list, so the modulo always lands on a row.
 */
export function fixtureRowAt(rows: readonly FixtureRow[], index: number): FixtureRow | undefined {
  return rows[index % rows.length];
}

/**
 * The fields a caller pinned for one type, by either lever: an `overrides` entry, or a key one
 * of the type's fixture rows carries. The passes that have to leave a deliberate value alone —
 * `stableIds`, the count-field pairing, the `fieldOverrides` expansion — care that a field was
 * claimed, not which lever claimed it.
 *
 * The union is taken across rows rather than per row, because those passes run once per type
 * rather than once per instance. A key only some rows carry therefore shadows them on every row
 * of that type, and the rows that omit it fall through to the generator.
 */
export function pinnedFields(typeName: string, resolved: ResolvedOptions): Record<string, unknown> {
  const overrides: Record<string, unknown> = resolved.overrides[typeName] ?? {};
  const rows = resolved.fixtures?.[typeName];
  if (rows === undefined) return overrides;

  const pinned: Record<string, unknown> = { ...overrides };
  for (const row of rows) {
    for (const key of Object.keys(row)) pinned[key] ??= true;
  }
  return pinned;
}

/**
 * Check a `fixtures` config against the schema before anything is generated.
 *
 * Throws rather than warns, the way `relations` and `aliases` do: a fixture is a literal
 * statement about one type's data, every key it carries is meant to reach a query, and a key
 * that names no field is unreachable — which is the exact mistake the option exists to catch.
 */
export function validateFixtures(
  schema: GraphQLSchema,
  fixtures: LooseFixturesMap | undefined,
): void {
  if (fixtures === undefined) return;

  for (const [typeName, rows] of Object.entries(fixtures)) {
    if (rows === undefined) continue;

    const type = schema.getType(typeName);
    if (!isObjectType(type) || OPERATION_TYPE_NAMES.has(typeName)) {
      throw new TypeError(
        type
          ? `[graphql-mocks] fixtures: "${typeName}" has no pool to pin — a fixture replaces the instances of a mocked object type, and operation, interface, union, enum and scalar types have none`
          : `[graphql-mocks] fixtures: unknown type "${typeName}" — no object type by that name in the schema`,
      );
    }
    if (!Array.isArray(rows)) {
      throw new TypeError(
        `[graphql-mocks] fixtures: expected a list of objects for "${typeName}", got ${JSON.stringify(rows)} — a fixture is the pool, so it is written as an array even for one instance`,
      );
    }
    if (rows.length === 0) {
      throw new TypeError(
        `[graphql-mocks] fixtures: "${typeName}" has an empty list, which says nothing about the pool — write "count: { ${typeName}: 0 }" to empty it`,
      );
    }

    const fields = type.getFields();
    for (const [index, row] of rows.entries()) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        throw new TypeError(
          `[graphql-mocks] fixtures: "${typeName}" row ${index} is ${JSON.stringify(row)} — each row is an object whose keys are the fields it pins`,
        );
      }
      for (const key of Object.keys(row)) {
        if (key in fields) continue;
        throw new TypeError(
          `[graphql-mocks] fixtures: unknown field "${typeName}.${key}" in row ${index} — a row's keys are the fields it pins, and a key the schema does not carry can never be selected`,
        );
      }
    }
  }
}

/**
 * How many instances of a fixtured type the pool holds, before an explicit `count` is consulted.
 *
 * The list's own length, because a fixture *is* the pool — which is also why `defaultCount` (and
 * with it a QA `lists: 'huge'` profile, a sweep the named type outranks) does not raise it. A
 * `relations` demand does: a relationship list is drawn without replacement and so can never be
 * longer than the pool it draws from, and the instances past the end of the list cycle back
 * through it.
 */
export function fixturePoolSize(rows: readonly FixtureRow[], demand: number): number {
  return Math.max(rows.length, demand);
}
