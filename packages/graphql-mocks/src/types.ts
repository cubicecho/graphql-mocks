import type { Faker } from '@faker-js/faker';
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import type { DocumentNode } from 'graphql';
import type { MockOperationOptions, MockOperationVariants, MockedResponse } from './apolloMocks.js';

export type ScalarMocker = (faker: Faker) => unknown;
/**
 * Per-field override. Receives the same (seeded) faker instance the generator uses, so
 * overrides stay deterministic under `seed` without importing a separate faker.
 *
 * @typeParam T - The field's value type. When `BuildMocksOptions` is parameterized with a
 * `TTypes` map (e.g. the codegen `SchemaTypeMap`), the return type is bound to the field's
 * own type, so `overrides: { User: { id: () => 5 } }` errors when `id` is a string.
 */
export type FieldOverrideFn<T = unknown> = (faker: Faker) => T;

/**
 * Per-type instance counts. When `TTypes` is supplied, the keys autocomplete to the schema's
 * type names and typos are caught; otherwise any type name is accepted. `_default` applies to
 * any type without an explicit entry.
 */
export type CountConfig<TTypes extends Record<string, unknown> = Record<string, unknown>> =
  | number
  | ({ _default?: number } & { [K in keyof TTypes]?: number });

// Field-level overrides for a single type. When the type's shape is `unknown` (the default,
// untyped case) this degrades to a loose `Record<string, FieldOverrideFn>`, preserving the
// pre-`TTypes` behavior; when concrete, each field name is checked and its override return
// type is bound to the field's type.
type FieldOverrides<T> = unknown extends T
  ? Record<string, FieldOverrideFn>
  : { [F in keyof T]?: FieldOverrideFn<T[F]> };

/**
 * Per-type, per-field override map. With a `TTypes` map, both the type name and field name
 * autocomplete and each override's return type is bound to the field's type; without it, any
 * type/field name is accepted with an `unknown` return.
 */
export type OverridesConfig<TTypes extends Record<string, unknown> = Record<string, unknown>> = {
  [K in keyof TTypes]?: FieldOverrides<TTypes[K]>;
};

/** How string-shaped scalars behave under QA mode. */
export type QaTextProfile = 'empty' | 'whitespace' | 'long' | 'unicode' | 'injection';
/** How numeric scalars behave under QA mode. */
export type QaNumberProfile = 'zero' | 'negative' | 'boundary';
/** How date/time scalars behave under QA mode. */
export type QaDateProfile = 'epoch' | 'farPast' | 'farFuture' | 'mixed';
/** How list-valued fields are sized under QA mode. */
export type QaListProfile = 'empty' | 'single' | 'huge';
/** How nullable fields behave under QA mode. */
export type QaNullProfile = 'none' | 'all' | 'mixed';

/**
 * Per-dimension QA settings. Every dimension is independent and optional — anything left
 * unset keeps its normal, realistic generator, so a set can isolate exactly one variable.
 */
export interface QaConfig {
  /** Weird strings for `String` and the string-shaped custom scalars. `ID` is left alone. */
  text?: QaTextProfile;
  /** Zero / negative / boundary values for integer and float scalars. */
  numbers?: QaNumberProfile;
  /** Epoch, far-past, far-future and calendar-edge timestamps for date scalars. */
  dates?: QaDateProfile;
  /** Force list fields to be empty, single-item, or very long. */
  lists?: QaListProfile;
  /** Force nullable fields to be null, never null, or a mix. Maps onto `nullChance`. */
  nulls?: QaNullProfile;
  /**
   * Target length for `lists: 'huge'`. Pools are grown to match unless `count` says otherwise.
   * @default 100
   */
  listSize?: number;
}

/**
 * Names of the built-in QA presets. Each isolates one dimension, except `kitchenSink`
 * which combines them for a worst-case smoke test.
 */
export type QaProfileName =
  | 'emptyText'
  | 'whitespaceText'
  | 'longText'
  | 'unicodeText'
  | 'injectionText'
  | 'emptyLists'
  | 'singleItemLists'
  | 'hugeLists'
  | 'allNulls'
  | 'mixedNulls'
  | 'zeroNumbers'
  | 'negativeNumbers'
  | 'boundaryNumbers'
  | 'extremeDates'
  | 'kitchenSink';

/** A preset name, an explicit per-dimension config, or `false` to disable QA mode. */
export type QaOption = QaProfileName | QaConfig | false;

export interface BuildMocksOptions<
  TTypes extends Record<string, unknown> = Record<string, unknown>,
> {
  /**
   * Number of instances to generate per type. Either a flat number or a per-type map.
   * @default 5
   */
  count?: CountConfig<TTypes>;
  /** Provide a custom Faker instance (e.g. with a specific locale). */
  faker?: Faker;
  /** Seed the faker instance for deterministic output. Applied to `options.faker` if provided. */
  seed?: number;
  /**
   * Probability (0–1) that a nullable field will be set to null.
   * @default 0
   */
  nullChance?: number;
  /**
   * Custom scalar mockers. Merged over the built-in defaults; user wins on conflicts.
   * Key is the scalar name as it appears in the schema.
   */
  scalars?: Record<string, ScalarMocker>;
  /**
   * Per-type, per-field override functions. The function is called once per object instance.
   * Return value replaces the generated value for that field entirely.
   */
  overrides?: OverridesConfig<TTypes>;
  /**
   * Required when the schema has interface or union fields.
   * Return the concrete type name to use when mocking a field of that abstract type.
   */
  resolveType?: (abstractTypeName: string) => keyof TTypes & string;
  /**
   * Add a `__typename` field (set to the type name) to every generated object.
   * Required by the Apollo cache, so it's on by default.
   * @default true
   */
  addTypename?: boolean;
  /**
   * Generate deliberately out-of-norm data instead of realistic data — empty or very long
   * strings, emoji and RTL text, empty or huge lists, all-null fields, boundary numbers and
   * extreme dates. Pass a preset name or a per-dimension {@link QaConfig}:
   *
   * ```ts
   * buildMocks(schema, { qa: 'longText' });
   * buildMocks(schema, { qa: { text: 'unicode', lists: 'empty', nulls: 'all' } });
   * ```
   *
   * QA values stay serializable by the built-in scalars so `dataForOperation` keeps working,
   * but they are not guaranteed to satisfy custom scalar constraints — an empty
   * `NonEmptyString` is the point, not a bug. An explicit `scalars` or `overrides` entry
   * still wins over the QA generator.
   *
   * Use `buildQaSets` to get one pool per preset in a single call.
   */
  qa?: QaOption;
  /**
   * Give every object with an `id` field a stable, unique id of the form `TypeName-<index>`
   * instead of a random scalar value. Keeps cache keys distinct and output readable.
   * An explicit `overrides` entry for `id` still wins.
   * @default false
   */
  stableIds?: boolean;
}

export interface MockHelpers<TTypes extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Find the first pooled item of `typeName` matching the predicate. When `typeName` is a key
   * of the declared `TTypes` map, the predicate item is typed automatically; otherwise pass an
   * explicit type argument (`find<User>('User', …)`).
   */
  find<K extends keyof TTypes & string>(
    typeName: K,
    predicate: (item: TTypes[K]) => boolean,
  ): TTypes[K] | undefined;
  find<T = unknown>(typeName: string, predicate: (item: T) => boolean): T | undefined;
  /**
   * Resolve a query or mutation against the mock graph and return its data shaped to the
   * selection set — no need to assemble the result by hand. Root fields are drawn from the
   * pools by their return type; nested fields follow the already-wired object references.
   * With a `TypedDocumentNode` the return type is inferred from the document.
   *
   * Variables don't affect which mocks are chosen; pass them only if your schema requires
   * them for execution (required variables are otherwise auto-filled with placeholders).
   */
  dataForOperation<TData = unknown, TVars = Record<string, unknown>>(
    document: TypedDocumentNode<TData, TVars> | DocumentNode,
    variables?: TVars extends Record<string, unknown> ? Partial<TVars> : Record<string, unknown>,
  ): TData;
  /**
   * Build an Apollo `MockedProvider` entry for the operation with **no data argument** — the
   * result is resolved straight from this graph via {@link MockHelpers.dataForOperation}, so the
   * query's own selection set decides which mocks come back. The pool is captured, so you only
   * pass the document (and optional `variables`/`delay`/`error`/`maxUsageCount` overrides).
   *
   * ```ts
   * const mocks = buildMocks(schema);
   * <MockedProvider mocks={[mocks.mockOperation(AwardByIdQuery)]}>…</MockedProvider>
   * ```
   *
   * To supply the data yourself instead, use the standalone `mockOperation(operation, data)`.
   */
  mockOperation<TData = unknown, TVars = Record<string, unknown>>(
    operation: TypedDocumentNode<TData, TVars>,
    options?: MockOperationOptions<TVars>,
  ): MockedResponse<TData, TVars>;
  /**
   * Like {@link MockHelpers.mockOperation}, but returns the success / long-load / error trio at
   * once, with the success data resolved from this graph.
   */
  mockOperationVariants<TData = unknown, TVars = Record<string, unknown>>(
    operation: TypedDocumentNode<TData, TVars>,
    options?: MockOperationOptions<TVars>,
  ): MockOperationVariants<TData, TVars>;
  /**
   * Build a resolver map keyed by type name, each returning a random pooled instance.
   * Type names declared in `TTypes` come back typed (`resolvers.User()` is `TTypes['User']`)
   * with key autocomplete; any other object type in the schema is still resolvable as
   * `() => unknown`.
   */
  toResolvers(): { [K in keyof TTypes]: () => TTypes[K] } & Record<string, () => unknown>;
}

// MockResult exposes the pool data directly (mocks.User) plus helper methods.
// TypeScript index signatures conflict with named methods, so we use an intersection
// and cast at the creation site.
//
// The optional `TTypes` parameter lets callers declare the shape per type name so the
// pools come back typed instead of `unknown[]`:
//
//   const mocks = buildMocks<{ User: UserFragment }>(schema, opts);
//   mocks.User // UserFragment[] — no cast needed
//
// Any type name not listed in `TTypes` still falls back to `unknown[]` (use the
// `unknown[]` value directly or `find<T>()` for typed access).
export type MockResult<TTypes extends Record<string, unknown> = Record<string, unknown>> = {
  [K in keyof TTypes]: TTypes[K][];
} & Record<string, unknown[]> &
  MockHelpers<TTypes>;
