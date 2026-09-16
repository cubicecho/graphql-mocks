import {
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLType,
  isEnumType,
  isListType,
  isNonNullType,
  isScalarType,
} from 'graphql';
import { qaFallbackText, qaListLength } from './qa.js';
import type { ResolvedOptions } from './resolveOptions.js';
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
 * Phase 1: Generate a single mock object for an object type, populating
 * only scalar and enum fields. Relationship fields are left for phase 2.
 */
export function mockTypeScalars(
  typeDef: GraphQLObjectType,
  resolved: ResolvedOptions,
): Record<string, unknown> {
  const fields = typeDef.getFields();
  const result: Record<string, unknown> = {};
  const { faker, qa, qaScalars, nullChance } = resolved;
  const typeOverrides = resolved.overrides[typeDef.name] ?? {};
  const listLength = qaListLength(qa, { min: 1, max: 3 });

  for (const [fieldName, field] of Object.entries(fields)) {
    if (typeOverrides[fieldName]) {
      result[fieldName] = typeOverrides[fieldName]?.(faker);
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

    if (isEnumType(namedType)) {
      const values = namedType.getValues();
      if (isList) {
        const count = faker.number.int(listLength);
        result[fieldName] = Array.from(
          { length: count },
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
      result[fieldName] = isList
        ? Array.from({ length: faker.number.int(listLength) }, fallback)
        : fallback();
      continue;
    }

    result[fieldName] = isList
      ? Array.from({ length: faker.number.int(listLength) }, () => mocker(faker))
      : mocker(faker);
  }

  return result;
}
