import type { Faker } from '@faker-js/faker';
import {
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLType,
  isEnumType,
  isListType,
  isNonNullType,
  isScalarType,
} from 'graphql';
import type { ListSizeRange } from './helpers.js';
import { qaFallbackText } from './qa.js';
import { type ResolvedOptions, listSizeFor, uniqueListFor } from './resolveOptions.js';
import { resolveScalarMocker } from './scalarMockers.js';

export interface UnwrappedType {
  namedType: GraphQLNamedType;
  isRequired: boolean;
  isList: boolean;
}

/**
 * Unwraps NonNull and List wrappers from a GraphQL type.
 * Supports: T, T!, [T], [T]!, [T!], [T!]!
 */
export function unwrapType(type: GraphQLType): UnwrappedType {
  let isRequired = false;
  let isList = false;
  let current = type;

  if (isNonNullType(current)) {
    isRequired = true;
    current = current.ofType;
  }

  if (isListType(current)) {
    isList = true;
    current = current.ofType;
  }

  // Inner NonNull inside a list: [T!]
  if (isNonNullType(current)) {
    current = current.ofType;
  }

  return { namedType: current as GraphQLNamedType, isRequired, isList };
}

/**
 * How many times a unique scalar list re-draws for one slot before giving up on it.
 *
 * A scalar generator has no enumerable set of values, so "without replacement" can only be
 * "retry on a collision" — and a generator that returns a constant (a QA text profile, a
 * caller's `scalars` entry) would spin forever against an unbounded loop. Twelve consecutive
 * collisions is already vanishingly unlikely for anything with a real corpus behind it, so in
 * practice this bound is only ever reached by generators that genuinely cannot fill the list.
 */
const UNIQUE_DRAW_ATTEMPTS = 12;

/**
 * An identity for the dedupe set. Primitives key by type and value so `1` and `'1'` stay
 * distinct; anything else keys by its JSON form, which is what makes two structurally equal
 * `JSON` scalar values count as one.
 */
function valueKey(value: unknown, fallbackIndex: number): string {
  if (value === null || typeof value !== 'object') return `${typeof value}:${String(value)}`;
  try {
    return `object:${JSON.stringify(value)}`;
  } catch {
    // Cyclic, or holding a BigInt. Nothing to compare it by, so treat it as its own value
    // rather than collapsing every such draw into one entry.
    return `unserializable:${fallbackIndex}`;
  }
}

/**
 * Draw a scalar list of the size `bounds` asks for.
 *
 * With `unique`, repeats are dropped and the list comes back short when the generator runs out
 * of distinct values — the same way a relationship list comes back short when its pool can't
 * fill it. Without it, every slot is an independent draw, which is what this always did.
 */
export function drawScalarList(
  faker: Faker,
  bounds: ListSizeRange,
  unique: boolean,
  draw: () => unknown,
): unknown[] {
  const count = faker.number.int(bounds);
  if (!unique) return Array.from({ length: count }, draw);

  const values: unknown[] = [];
  const seen = new Set<string>();
  for (let slot = 0; slot < count; slot++) {
    let filled = false;
    for (let attempt = 0; attempt < UNIQUE_DRAW_ATTEMPTS && !filled; attempt++) {
      const value = draw();
      const key = valueKey(value, slot);
      if (seen.has(key)) continue;
      seen.add(key);
      values.push(value);
      filled = true;
    }
    if (!filled) break;
  }
  return values;
}

/**
 * Phase 1: Generate a single mock object for an object type, populating
 * only scalar and enum fields. Relationship fields are left for phase 2.
 *
 * `index` is the instance's position in its own pool; it reaches overrides through their
 * context argument, so an override can vary by instance without tracking its own counter.
 */
export function mockTypeScalars(
  typeDef: GraphQLObjectType,
  resolved: ResolvedOptions,
  index = 0,
): Record<string, unknown> {
  const fields = typeDef.getFields();
  const result: Record<string, unknown> = {};
  const { faker, qa, qaScalars, nullChance } = resolved;
  const typeOverrides = resolved.overrides[typeDef.name] ?? {};

  for (const [fieldName, field] of Object.entries(fields)) {
    if (typeOverrides[fieldName]) {
      result[fieldName] = typeOverrides[fieldName]?.(faker, {
        index,
        typeName: typeDef.name,
        fieldName,
      });
      continue;
    }

    const { namedType, isRequired, isList } = unwrapType(field.type);

    // Only handle scalar and enum in phase 1
    if (!isScalarType(namedType) && !isEnumType(namedType)) continue;

    // Nullable field: apply null chance
    if (!isRequired && nullChance > 0 && faker.datatype.boolean({ probability: nullChance })) {
      result[fieldName] = null;
      continue;
    }

    // Sized per field rather than once per type: a `listSize` entry can name this exact field,
    // and the same lookup sizes relationship and root lists, so one lever reaches all three.
    const listLength = listSizeFor(typeDef.name, fieldName, resolved);
    const unique = isList && uniqueListFor(typeDef.name, fieldName, resolved);

    if (isEnumType(namedType)) {
      const values = namedType.getValues();
      if (isList) {
        // An enum has a countable set of values, so a unique list is the same without-replacement
        // sample a relationship list takes — clamped to what exists, which is why a four-value
        // `listSize` over a three-value enum yields three entries rather than repeating one.
        result[fieldName] = unique
          ? faker.helpers
              .arrayElements(values, {
                min: Math.min(listLength.min, values.length),
                max: Math.min(listLength.max, values.length),
              })
              .map((value) => value.value)
          : Array.from(
              { length: faker.number.int(listLength) },
              () => faker.helpers.arrayElement(values)?.value ?? null,
            );
      } else {
        result[fieldName] = faker.helpers.arrayElement(values)?.value ?? null;
      }
      continue;
    }

    const mocker = resolveScalarMocker(namedType.name, resolved.scalars, qaScalars);
    if (!mocker) {
      console.warn(
        `[graphql-mocks] Unknown scalar "${namedType.name}" on ${typeDef.name}.${fieldName} — falling back to faker.lorem.word()`,
      );
      // An unrecognized scalar is almost always string-shaped, so a text profile should
      // reach it too — otherwise QA mode quietly skips every custom scalar in the schema.
      const fallback = () => qaFallbackText(faker, qa) ?? faker.lorem.word();
      result[fieldName] = isList ? drawScalarList(faker, listLength, unique, fallback) : fallback();
      continue;
    }

    result[fieldName] = isList
      ? drawScalarList(faker, listLength, unique, () => mocker(faker))
      : mocker(faker);
  }

  return result;
}
