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

/**
 * How many related objects a relationship field gets. A number is an exact size, a
 * `{ min, max }` range picks a random size in between, `'all'` takes the whole target pool,
 * and `null` means none — `[]` for a list field, `null` for a singular one.
 */
export type RelationSize = number | { min: number; max: number } | null | 'all';

/** What a {@link RelationFn} is handed when it computes a relationship field's value. */
export interface RelationContext {
  /** The target type's pool, already fully populated — relationships wire after every
   * instance exists, which is what `overrides` cannot do. */
  pool: readonly unknown[];
  /** The same seeded faker the generator draws with, so the function stays deterministic. */
  faker: Faker;
  /** The owning instance's index in its own pool — 0-based, and 0 at an operation root. */
  index: number;
  /** The owning instance so far: its own scalar fields, before relationships are wired. */
  instance: Record<string, unknown>;
  /** The owning type's name (or the root operation type on the operation path). */
  typeName: string;
  /** The field being wired. */
  fieldName: string;
  /** Whether the field is a list — return an array when true, one object or null otherwise. */
  isList: boolean;
}

/**
 * Full control over a single relationship field. Returns the field's **value**, not a size,
 * so it can choose *which* entities are connected rather than just how many:
 *
 * ```ts
 * relations: { Post: { author: ({ pool }) => pool[0] } }
 * ```
 */
export type RelationFn = (ctx: RelationContext) => unknown;

/** A size, or a function that computes the field value outright. */
export type RelationSpec = RelationSize | RelationFn;

// Relationship specs for one type, keyed by field name, with a `_default` for that type's
// other relationship fields. Degrades to a loose record when the type's shape is unknown,
// mirroring `FieldOverrides`.
type TypeRelations<T> = unknown extends T
  ? { _default?: RelationSpec } & Record<string, RelationSpec>
  : { _default?: RelationSpec } & { [F in keyof T]?: RelationSpec };

/** The untyped `relations` map: any type name, any field name. */
export interface LooseRelationsMap {
  /** Applies to any relationship field without a type- or field-level entry. */
  _default?: RelationSpec;
  /**
   * Also write each wired relationship back onto its inverse field, so `user.todos[i].user`
   * is that same user. Lossy where an object is shared by two owners — last writer wins.
   * @default false
   */
  _reciprocal?: boolean;
  [typeName: string]: TypeRelations<unknown> | RelationSpec | boolean | undefined;
}

/** The `relations` map when a `TTypes` map is supplied: type and field names are checked. */
export type TypedRelationsMap<TTypes extends Record<string, unknown>> = {
  _default?: RelationSpec;
  _reciprocal?: boolean;
} & { [K in keyof TTypes]?: TypeRelations<TTypes[K]> };

/**
 * How relationship fields are wired, resolved per field as
 * `[type][field]` → `[type]._default` → `_default` → the flat form.
 *
 * A bare object is **always** a type map, never a `{ min, max }` range — ranges live under a
 * key, so the catch-all range is written `relations: { _default: { min: 1, max: 5 } }`.
 */
export type RelationsConfig<TTypes extends Record<string, unknown> = Record<string, unknown>> =
  | number
  | null
  | 'all'
  | RelationFn
  | (string extends keyof TTypes ? LooseRelationsMap : TypedRelationsMap<TTypes>);

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
   * Shape relationship fields: how many related objects each one gets, or exactly which ones.
   * Applied after every pool exists, which is what `overrides` structurally cannot do.
   *
   * ```ts
   * buildMocks(schema, { relations: { User: { todos: 0, posts: { min: 1, max: 2 } } } });
   * buildMocks(schema, { relations: { Post: { author: ({ pool }) => pool[0] } } });
   * ```
   *
   * Resolved most specific first — `[type][field]` → `[type]._default` → `_default` → the
   * flat form. An `overrides` entry for the same field still wins; an explicit entry beats
   * both `nullChance` and the QA `lists` profile, which are deliberately less specific.
   */
  relations?: RelationsConfig<TTypes>;
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
