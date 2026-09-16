import type { Faker } from '@faker-js/faker';
import type { QaConfig, QaOption, QaProfileName, ScalarMocker } from './types.js';

/**
 * Named presets, each isolating one dimension so a failing story points at one cause.
 * `kitchenSink` deliberately combines them for a worst-case smoke test.
 */
export const QA_PROFILES: Record<QaProfileName, QaConfig> = {
  emptyText: { text: 'empty' },
  whitespaceText: { text: 'whitespace' },
  longText: { text: 'long' },
  unicodeText: { text: 'unicode' },
  injectionText: { text: 'injection' },
  emptyLists: { lists: 'empty' },
  singleItemLists: { lists: 'single' },
  hugeLists: { lists: 'huge' },
  allNulls: { nulls: 'all' },
  mixedNulls: { nulls: 'mixed' },
  zeroNumbers: { numbers: 'zero' },
  negativeNumbers: { numbers: 'negative' },
  boundaryNumbers: { numbers: 'boundary' },
  extremeDates: { dates: 'mixed' },
  kitchenSink: {
    text: 'long',
    lists: 'huge',
    nulls: 'mixed',
    numbers: 'boundary',
    dates: 'mixed',
  },
};

/** Every profile name, in the order `buildQaSets` generates them by default. */
export const QA_PROFILE_NAMES = Object.keys(QA_PROFILES) as QaProfileName[];

/** Target length for `lists: 'huge'` when `listSize` isn't given. */
export const DEFAULT_HUGE_LIST_SIZE = 100;

/** A `QaConfig` with `listSize` filled in, so downstream code never re-defaults it. */
export interface ResolvedQa extends QaConfig {
  listSize: number;
}

/**
 * Normalize the `qa` option into a single config. A profile name expands to its preset;
 * an object is used as-is. Returns undefined when QA mode is off.
 */
export function resolveQa(qa: QaOption | undefined): ResolvedQa | undefined {
  if (qa === undefined || qa === false) return undefined;
  const config = typeof qa === 'string' ? QA_PROFILES[qa] : qa;
  if (!config) {
    console.warn(`[graphql-mocks] Unknown qa profile "${String(qa)}" — QA mode disabled`);
    return undefined;
  }
  return { ...config, listSize: config.listSize ?? DEFAULT_HUGE_LIST_SIZE };
}

// ---------------------------------------------------------------------------
// Corpora
// ---------------------------------------------------------------------------

const WHITESPACE_STRINGS = [' ', '   ', '\t', '\n', ' \t\n ', ' ', '　'];

// Two shapes, because they fail differently: one long word can't wrap and overflows its
// container, while long prose wraps and blows out the container's height instead.
const LONG_UNBROKEN = 'a'.repeat(1000);
const LONG_PROSE = `${'Lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(90)}`;

const UNICODE_STRINGS = [
  '👨‍👩‍👧‍👦 family ZWJ sequence',
  '🏳️‍🌈🏴‍☠️👋🏽 flags and modifiers',
  'مرحبا بالعالم', // RTL Arabic
  'שלום עולם', // RTL Hebrew
  'مرحبا mixed بالعالم bidi', // bidi mix
  '你好世界这是一个没有空格的长句子测试换行', // CJK, no spaces to wrap on
  'こんにちは世界テスト',
  'Z̸̧̈ä̴́ͅl̶̰̈g̷̰̈ö̵́ͅ  ẗ̶̰ë̵́ͅẍ̷̰ẗ̶̰', // combining diacritics
  'Ǹ̴̡̛̗͓̤̣̦̈́͐ạ̶̢̛̙̈́m̷̡̺̈́ë̸́ͅ',
  '𝕌𝕟𝕚𝕔𝕠𝕕𝕖 𝕞𝕒𝕥𝕙 𝕒𝕝𝕡𝕙𝕒𝕟𝕦𝕞𝕖𝕣𝕚𝕔𝕤',
];

// Content that must survive being rendered, not executed. If any of these "work",
// the component is interpolating instead of escaping.
const INJECTION_STRINGS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><svg/onload=alert(1)>',
  "'; DROP TABLE users; --",
  '{{7*7}}',
  '${7*7}',
  '../../../../etc/passwd',
  '%00%0a%0d',
  '&lt;already&gt;&amp;escaped&lt;/already&gt;',
  '\\u0000\\u001b[31m',
];

/** Generate a string for the active text profile. Deterministic under the seeded faker. */
export function qaText(faker: Faker, profile: NonNullable<QaConfig['text']>): string {
  switch (profile) {
    case 'empty':
      return '';
    case 'whitespace':
      return faker.helpers.arrayElement(WHITESPACE_STRINGS);
    case 'long':
      return faker.helpers.arrayElement([LONG_UNBROKEN, LONG_PROSE]);
    case 'unicode':
      return faker.helpers.arrayElement(UNICODE_STRINGS);
    case 'injection':
      return faker.helpers.arrayElement(INJECTION_STRINGS);
  }
}

// GraphQL's built-in Int only serializes 32-bit signed integers, so boundary ints stop
// there — going past it would make `dataForOperation` throw instead of returning weird
// data, which defeats the point. Float has no such limit, so it gets the wilder values.
const INT_MAX = 2_147_483_647;
const INT_MIN = -2_147_483_648;

function qaInt(faker: Faker, profile: NonNullable<QaConfig['numbers']>): number {
  switch (profile) {
    case 'zero':
      return 0;
    case 'negative':
      return faker.number.int({ min: -1000, max: -1 });
    case 'boundary':
      return faker.helpers.arrayElement([0, 1, -1, INT_MAX, INT_MIN, INT_MAX - 1]);
  }
}

function qaFloat(faker: Faker, profile: NonNullable<QaConfig['numbers']>): number {
  switch (profile) {
    case 'zero':
      return 0;
    case 'negative':
      return faker.number.float({ min: -1000, max: -0.01, fractionDigits: 2 });
    case 'boundary':
      return faker.helpers.arrayElement([
        0,
        -0,
        0.1 + 0.2, // 0.30000000000000004 — formatters that assume 2 decimals break here
        Number.MAX_SAFE_INTEGER,
        -Number.MAX_SAFE_INTEGER,
        Number.MIN_VALUE,
        1e21, // switches to exponential notation in String()
        -1e21,
      ]);
  }
}

const DATE_CORPUS: Record<NonNullable<QaConfig['dates']>, string[]> = {
  epoch: ['1970-01-01T00:00:00.000Z'],
  farPast: ['1000-01-01T00:00:00.000Z', '0001-01-01T00:00:00.000Z', '1900-01-01T00:00:00.000Z'],
  farFuture: ['9999-12-31T23:59:59.999Z', '2999-01-01T00:00:00.000Z'],
  mixed: [
    '1970-01-01T00:00:00.000Z', // epoch
    '1969-12-31T23:59:59.999Z', // one ms before epoch — negative timestamps
    '1000-01-01T00:00:00.000Z',
    '9999-12-31T23:59:59.999Z',
    '2024-02-29T12:00:00.000Z', // leap day
    '2024-03-10T07:00:00.000Z', // US DST spring-forward
    '2024-11-03T06:00:00.000Z', // US DST fall-back (ambiguous local time)
    '2024-12-31T23:59:59.999Z', // year boundary
    '2024-01-01T00:00:00.000Z',
  ],
};

function qaDate(faker: Faker, profile: NonNullable<QaConfig['dates']>): string {
  return faker.helpers.arrayElement(DATE_CORPUS[profile]) ?? '1970-01-01T00:00:00.000Z';
}

// ---------------------------------------------------------------------------
// Scalar layering
// ---------------------------------------------------------------------------

// Which built-in and graphql-scalars names each dimension claims. `ID` is deliberately
// absent from TEXT_SCALARS: ids are the graph's identity and Apollo's cache keys, so
// mangling them breaks the mock graph itself rather than testing the UI. Override `id`
// explicitly if that's what you want to exercise.
const TEXT_SCALARS = [
  'String',
  'EmailAddress',
  'URL',
  'PhoneNumber',
  'PostalCode',
  'CountryCode',
  'CountryName',
  'CityName',
  'Slug',
  'Currency',
  'HexColorCode',
  'RGB',
  'RGBA',
  'MAC',
  'IPv4',
  'IPv6',
];

const INT_SCALARS = ['Int', 'Long', 'UnsignedInt', 'Byte', 'Port', 'Rating'];
const FLOAT_SCALARS = ['Float', 'UnsignedFloat', 'Latitude', 'Longitude'];
const DATE_SCALARS = ['DateTime', 'DateTimeISO'];

/**
 * Build the scalar mockers implied by a QA config. Layered *between* the user's `scalars`
 * and the built-in defaults by {@link resolveScalarMocker}, so an explicit user mocker
 * still wins and any scalar this config doesn't claim keeps its realistic default.
 */
export function qaScalarMockers(qa: ResolvedQa): Record<string, ScalarMocker> {
  const mockers: Record<string, ScalarMocker> = {};

  if (qa.text) {
    const profile = qa.text;
    for (const name of TEXT_SCALARS) mockers[name] = (faker) => qaText(faker, profile);
  }

  if (qa.numbers) {
    const profile = qa.numbers;
    for (const name of INT_SCALARS) mockers[name] = (faker) => qaInt(faker, profile);
    for (const name of FLOAT_SCALARS) mockers[name] = (faker) => qaFloat(faker, profile);
    mockers.BigInt = (faker) => BigInt(qaInt(faker, profile));
    mockers.Decimal = (faker) => qaFloat(faker, profile).toString();
  }

  if (qa.dates) {
    const profile = qa.dates;
    for (const name of DATE_SCALARS) mockers[name] = (faker) => qaDate(faker, profile);
    mockers.Date = (faker) => qaDate(faker, profile).split('T')[0] ?? '';
    mockers.Time = (faker) => qaDate(faker, profile).split('T')[1]?.split('.')[0] ?? '00:00:00';
  }

  return mockers;
}

/**
 * Value for a scalar the schema declares but nothing provides a mocker for. Without QA
 * mode the caller falls back to `faker.lorem.word()`; with a text profile active the
 * unknown scalar should get the weird text too, since it's almost certainly a string.
 */
export function qaFallbackText(faker: Faker, qa: ResolvedQa | undefined): string | undefined {
  return qa?.text ? qaText(faker, qa.text) : undefined;
}

// ---------------------------------------------------------------------------
// Lists and nulls
// ---------------------------------------------------------------------------

/**
 * Length bounds for a generated list. Returns the caller's own defaults when no list
 * profile is active, so non-QA behavior is untouched.
 */
export function qaListLength(
  qa: ResolvedQa | undefined,
  fallback: { min: number; max: number },
): { min: number; max: number } {
  switch (qa?.lists) {
    case undefined:
      return fallback;
    case 'empty':
      return { min: 0, max: 0 };
    case 'single':
      return { min: 1, max: 1 };
    case 'huge':
      return { min: qa.listSize, max: qa.listSize };
  }
}

/**
 * Null probability implied by the QA config, or undefined to leave `nullChance` alone.
 * `mixed` sits at 0.5 so a single set contains both null and non-null instances of the
 * same field — the case that catches components handling only one of the two.
 */
export function qaNullChance(qa: ResolvedQa | undefined): number | undefined {
  switch (qa?.nulls) {
    case undefined:
      return undefined;
    case 'none':
      return 0;
    case 'all':
      return 1;
    case 'mixed':
      return 0.5;
  }
}

/**
 * Pool size needed to satisfy the list profile. `huge` lists are drawn *without*
 * replacement, so the pools have to be at least as big as the target length or the lists
 * come back short. Only raises the built-in default — an explicit `count` still wins.
 */
export function qaDefaultCount(qa: ResolvedQa | undefined, fallback: number): number {
  return qa?.lists === 'huge' ? Math.max(fallback, qa.listSize) : fallback;
}
