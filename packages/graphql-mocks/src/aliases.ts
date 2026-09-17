import { type GraphQLObjectType, type GraphQLSchema, isObjectType } from 'graphql';
import type { AliasesConfig } from './types.js';

/**
 * A fragment that aliases a field produces a result type whose keys the pooled objects do not
 * have:
 *
 * ```graphql
 * fragment UserCard on User { id, locations: addresses { city } }
 * ```
 *
 * The pool has `addresses`; the generated `UserCardFragment` type has `locations`. Handing a
 * pooled object to a component typed by that fragment is then a field short — silently, because
 * the object still type-checks as the fragment's shape nowhere it matters, and the component
 * reads `undefined` and renders an empty section.
 *
 * The fix is mechanical and the same every time (copy the source field onto the alias name), but
 * it has to be remembered and maintained alongside the fragments, with no signal when a new alias
 * is added. `aliases` is that pass, declared once.
 */

/** The root types, which name operations rather than anything the generator pools. */
function operationTypes(schema: GraphQLSchema): Set<string> {
  return new Set(
    [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()]
      .filter((type) => type != null)
      .map((type) => type.name),
  );
}

/** Every alias a type asks for, as `[sourceField, aliasName]`, in declaration order. */
function aliasPairs(entry: Record<string, string | readonly string[]>): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [sourceField, names] of Object.entries(entry)) {
    for (const alias of typeof names === 'string' ? [names] : names) {
      pairs.push([sourceField, alias]);
    }
  }
  return pairs;
}

/**
 * Check an `aliases` config against the schema before anything is generated — a typo in a source
 * field would otherwise copy `undefined` onto the alias, which is the exact bug the option
 * exists to prevent.
 */
export function validateAliases(schema: GraphQLSchema, aliases: AliasesConfig | undefined): void {
  if (aliases === undefined) return;

  for (const [typeName, entry] of Object.entries(aliases)) {
    if (entry === undefined) continue;
    const type = schema.getType(typeName);
    if (!isObjectType(type)) {
      throw new TypeError(
        type
          ? `[graphql-mocks] aliases: "${typeName}" is not an object type — aliases are copied onto pooled instances, and only object types have any`
          : `[graphql-mocks] aliases: unknown type "${typeName}" — no object type by that name in the schema`,
      );
    }
    if (operationTypes(schema).has(typeName)) {
      throw new TypeError(
        `[graphql-mocks] aliases: "${typeName}" is an operation type, which has no pooled instances to alias onto — alias the type the root field returns instead`,
      );
    }

    const fields = type.getFields();
    for (const [sourceField, alias] of aliasPairs(entry)) {
      if (!(sourceField in fields)) {
        throw new TypeError(
          `[graphql-mocks] aliases: unknown field "${typeName}.${sourceField}" — the key is the field being aliased, the value is the name to expose it under`,
        );
      }
      if (alias in fields) {
        throw new TypeError(
          `[graphql-mocks] aliases: "${typeName}.${alias}" is already a field on that type, so aliasing "${sourceField}" onto it would replace real data`,
        );
      }
    }
  }
}

/**
 * Expose each aliased field under its alias name on every pooled instance of the type.
 *
 * Runs last, so an alias carries the finished value — after relationships are wired, counts are
 * synced and derives have run. The alias holds **the same reference**, not a clone, so identity
 * comparisons and the wired graph keep working through it.
 */
export function applyAliases(
  objectTypes: GraphQLObjectType[],
  pool: Record<string, Record<string, unknown>[]>,
  aliases: AliasesConfig | undefined,
): void {
  if (aliases === undefined) return;

  for (const objectType of objectTypes) {
    const entry = aliases[objectType.name];
    if (entry === undefined) continue;
    const pairs = aliasPairs(entry);
    if (pairs.length === 0) continue;

    for (const instance of pool[objectType.name] ?? []) {
      for (const [sourceField, alias] of pairs) {
        // A field the generator never set at all (an abstract relation with no concrete pool)
        // stays absent rather than becoming an enumerable `undefined` under a second name.
        if (sourceField in instance) instance[alias] = instance[sourceField];
      }
    }
  }
}
