import type { ScalarMocker } from './types.js';

export const defaultScalarMockers: Record<string, ScalarMocker> = {
  String: (faker) => faker.lorem.word(),
  Int: (faker) => faker.number.int({ min: 1, max: 1000 }),
  Float: (faker) => faker.number.float({ min: 0, max: 1000, fractionDigits: 2 }),
  Boolean: (faker) => faker.datatype.boolean(),
  ID: (faker) => faker.string.uuid(),

  // ISO 8601
  DateTime: (faker) => faker.date.recent().toISOString(),
  DateTimeISO: (faker) => faker.date.recent().toISOString(),
  Date: (faker) => faker.date.recent().toISOString().split('T')[0] ?? '',
  Time: (faker) => {
    const iso = faker.date.recent().toISOString();
    return iso.split('T')[1]?.split('.')[0] ?? '00:00:00';
  },

  // Network / web
  EmailAddress: (faker) => faker.internet.email(),
  URL: (faker) => faker.internet.url(),
  PhoneNumber: (faker) => faker.phone.number(),
  IPv4: (faker) => faker.internet.ipv4(),
  IPv6: (faker) => faker.internet.ipv6(),
  MAC: (faker) => faker.internet.mac(),
  Port: (faker) => faker.internet.port(),

  // Geography
  PostalCode: (faker) => faker.location.zipCode(),
  CountryCode: (faker) => faker.location.countryCode(),
  CountryName: (faker) => faker.location.country(),
  CityName: (faker) => faker.location.city(),
  Latitude: (faker) => faker.location.latitude(),
  Longitude: (faker) => faker.location.longitude(),

  // Identifiers
  UUID: (faker) => faker.string.uuid(),
  GUID: (faker) => faker.string.uuid(),

  // Numeric variants
  BigInt: (faker) => BigInt(faker.number.int({ min: 0, max: 1_000_000 })),
  Long: (faker) => faker.number.int({ min: 0, max: 2_147_483_647 }),
  UnsignedInt: (faker) => faker.number.int({ min: 0, max: 1000 }),
  UnsignedFloat: (faker) => faker.number.float({ min: 0, max: 1000, fractionDigits: 2 }),
  Decimal: (faker) => faker.number.float({ min: 0, max: 1000, fractionDigits: 4 }).toString(),
  Byte: (faker) => faker.number.int({ min: 0, max: 255 }),

  // Finance / misc
  Currency: (faker) => faker.finance.currencyCode(),
  HexColorCode: (faker) => faker.color.rgb({ format: 'hex' }),
  RGB: (faker) => `rgb(${faker.number.int(255)},${faker.number.int(255)},${faker.number.int(255)})`,
  RGBA: (faker) =>
    `rgba(${faker.number.int(255)},${faker.number.int(255)},${faker.number.int(255)},${faker.number.float({ min: 0, max: 1, fractionDigits: 2 })})`,

  // JSON
  JSON: (faker) => ({ key: faker.lorem.word(), value: faker.lorem.sentence() }),
  JSONObject: (faker) => ({ key: faker.lorem.word(), value: faker.lorem.sentence() }),

  // Content / web
  Slug: (faker) => faker.helpers.slugify(faker.lorem.words(3)),
  Rating: (faker) => faker.number.int({ min: 1, max: 5 }),
  Upload: () => null,
};

/**
 * Returns the mocker to use for a given scalar name.
 * Precedence: user-supplied `scalars` > QA-mode mockers > built-in defaults — so turning QA
 * mode on never silently discards an explicit mocker, and any scalar the active QA profile
 * doesn't claim keeps its realistic default.
 * Returns undefined if none of the three provides a mocker.
 */
export function resolveScalarMocker(
  scalarName: string,
  userScalars: Record<string, ScalarMocker> | undefined,
  qaScalars?: Record<string, ScalarMocker>,
): ScalarMocker | undefined {
  return userScalars?.[scalarName] ?? qaScalars?.[scalarName] ?? defaultScalarMockers[scalarName];
}
