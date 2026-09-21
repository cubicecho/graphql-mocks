import type { Faker } from '@faker-js/faker';
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import type { DocumentNode } from 'graphql';
import type {
  DynamicMockOperationVariants,
  DynamicMockedResponse,
  MockOperationOptions,
  MockOperationVariants,
  MockedResponse,
} from './apolloMocks.js';
import type { ArgMatchingOptions } from './argMatching.js';
import type { OperationMocks, OperationModule } from './operationsFrom.js';
import type { MockHandlerOptions, MockRequestHandler } from './requestHandler.js';

export type ScalarMocker = (faker: Faker) => unknown;

/**
 * A list length: a bare number for an exact length, or an inclusive range.
 */
export type ListSizeRangeConfig = number | { min: number; max: number };

// Sizes for one type's list fields, keyed by field name, with a `_default` for that type's
// other lists. Degrades to a loose record when the type's shape is unknown, mirroring
// `TypeRelations`.
type TypeListSizes<T> = unknown extends T
  ? { _default?: ListSizeRangeConfig } & Record<string, ListSizeRangeConfig>
  : { _default?: ListSizeRangeConfig } & { [F in keyof T]?: ListSizeRangeConfig };

/** The untyped `listSize` map: any type name, any field name. */
export interface LooseListSizeMap {
  /** Applies to any list field without a type- or field-level entry. */
  _default?: ListSizeRangeConfig;
  [typeName: string]: TypeListSizes<unknown> | ListSizeRangeConfig | undefined;
}

/** The `listSize` map when a `TTypes` map is supplied: type and field names are checked. */
export type TypedListSizeMap<TTypes extends Record<string, unknown>> = {
  _default?: ListSizeRangeConfig;
} & { [K in keyof TTypes]?: TypeListSizes<TTypes[K]> | ListSizeRangeConfig };

/**
 * How long generated list fields are, resolved per field as
 * `[type][field]` → `[type]._default` → `_default` → the flat form.
 *
 * A bare `{ min, max }` is the flat form, not a type map — the two are told apart by those
 * numeric bounds, which no GraphQL type name can collide with under the usual capitalization.
 */
export type ListSizeConfig<TTypes extends Record<string, unknown> = Record<string, unknown>> =
  | ListSizeRangeConfig
  | (string extends keyof TTypes ? LooseListSizeMap : TypedListSizeMap<TTypes>);

// Which of one type's list fields hold distinct values, keyed by field name, with a `_default`
// for that type's other lists. Degrades to a loose record when the type's shape is unknown,
// mirroring `TypeListSizes`.
type TypeUniqueLists<T> = unknown extends T
  ? { _default?: boolean } & Record<string, boolean>
  : { _default?: boolean } & { [F in keyof T]?: boolean };

/** The untyped `uniqueLists` map: any type name, any field name. */
export interface LooseUniqueListsMap {
  /** Applies to any scalar or enum list without a type- or field-level entry. */
  _default?: boolean;
  [typeName: string]: TypeUniqueLists<unknown> | boolean | undefined;
}

/** The `uniqueLists` map when a `TTypes` map is supplied: type and field names are checked. */
export type TypedUniqueListsMap<TTypes extends Record<string, unknown>> = {
  _default?: boolean;
} & { [K in keyof TTypes]?: TypeUniqueLists<TTypes[K]> | boolean };

/**
 * Whether generated scalar and enum lists are drawn without replacement, resolved per field as
 * `[type][field]` → `[type]._default` → `_default` → the flat form.
 */
export type UniqueListsConfig<TTypes extends Record<string, unknown> = Record<string, unknown>> =
  | boolean
  | (string extends keyof TTypes ? LooseUniqueListsMap : TypedUniqueListsMap<TTypes>);

/** The untyped `stableIds` map: extra identifier field names per type. */
export interface LooseIdFieldsMap {
  /** Identifier field names for every type the map does not name. */
  _default?: readonly string[];
  [typeName: string]: readonly string[] | undefined;
}

/**
 * Which fields `stableIds` gives a stable, pool-unique value to: `true` for the ones it
 * recognizes by name (`id`, and anything ending in `Id`/`ID`), or those plus the names listed —
 * globally, or per type.
 */
export type StableIdsConfig<TTypes extends Record<string, unknown> = Record<string, unknown>> =
  | boolean
  | readonly string[]
  | (string extends keyof TTypes
      ? LooseIdFieldsMap
      : { _default?: readonly string[] } & {
          [K in keyof TTypes]?: readonly (keyof TTypes[K] & string)[];
        });

/** Where an override is firing — the instance's position in its pool, and the field's site. */
export interface OverrideContext {
  /** The owning instance's index in its own pool, the same index `stableIds` numbers with. */
  index: number;
  typeName: string;
  fieldName: string;
}

/**
 * Per-field override. Receives the same (seeded) faker instance the generator uses, so
 * overrides stay deterministic under `seed` without importing a separate faker, plus the
 * site it is firing at — which makes per-instance cohorts a one-liner:
 *
 * ```ts
 * overrides: { User: { loginCount: (f, { index }) => (index === 0 ? 0 : f.number.int(500)) } }
 * ```
 *
 * @typeParam T - The field's value type. When `BuildMocksOptions` is parameterized with a
 * `TTypes` map (e.g. the codegen `SchemaTypeMap`), the return type is bound to the field's
 * own type, so `overrides: { User: { id: () => 5 } }` errors when `id` is a string.
 */
export type FieldOverrideFn<T = unknown> = (faker: Faker, ctx: OverrideContext) => T;

/**
 * Which count scalars track which lists. `true` pairs them by name alone; a map pairs the ones
 * the naming convention misses, keyed by type, then by count field, with the list field as the
 * value. `false` turns the pass off, including under a QA list profile.
 */
export type CountFieldsConfig<TTypes extends Record<string, unknown> = Record<string, unknown>> =
  | boolean
  | { [K in keyof TTypes]?: Record<string, string> };

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
// pre-`TTypes` behavior; when concrete, each mapped field name is checked and its override
// return type is bound to the field's type.
//
// The trailing index signature is what makes the map a hint rather than a closed contract: a
// field the map does not carry — one a fragment did not select, or one that exists only in the
// mock — is still accepted, with an `unknown` return. Without it, writing a single such field
// forced the whole options object back to the untyped default, which gave up the typing on
// every field that *was* in the map. It also switches excess-property checking off for these
// objects, so a misspelled field name no longer errors here; that is the trade.
type FieldOverrides<T> = unknown extends T
  ? Record<string, FieldOverrideFn>
  : { [F in keyof T]?: FieldOverrideFn<T[F]> } & Record<string, FieldOverrideFn>;

/**
 * Per-type, per-field override map. With a `TTypes` map, both the type name and field name
 * autocomplete and each override's return type is bound to the field's type; without it, any
 * type/field name is accepted with an `unknown` return.
 *
 * Type names are checked against the map; field names are a hint. A field the map does not
 * carry is accepted with an `unknown` return, so one mock-only field does not cost the typing
 * on all the others.
 */
export type OverridesConfig<TTypes extends Record<string, unknown> = Record<string, unknown>> = {
  [K in keyof TTypes]?: FieldOverrides<TTypes[K]>;
};

/**
 * Overrides keyed by **field name**, applied to every type that carries a field by that name.
 * The conventional names a schema repeats — `imageUrl`, `slug`, `avatarUrl`, `externalId` —
 * otherwise need the same one-line override written once per type, and a new type carrying the
 * same field quietly gets the default mock until someone notices the rendering is off.
 *
 * ```ts
 * fieldOverrides: {
 *   imageUrl: (f) => f.image.url(),
 *   '/Url$/': (f) => f.image.url(),  // a key wrapped in slashes is a pattern
 * }
 * ```
 *
 * A key wrapped in slashes (`'/Url$/'`, `'/^is[A-Z]/i'`) is a regular expression tested against
 * the field name — unambiguous, since a GraphQL field name can never contain a slash. An exact
 * name beats a pattern, earlier patterns beat later ones, and an {@link OverridesConfig} entry
 * for the same type and field beats both. A key that matches nothing in the schema warns.
 *
 * Not schema-checked against `TTypes`: one field name spans types whose field types may differ,
 * and the pattern form takes keys that are not field names at all. The unmatched-key warning is
 * what catches a typo here.
 */
export type FieldOverridesConfig = Record<string, FieldOverrideFn>;

/**
 * Expose a field under one or more extra names, per type: `{ User: { addresses: 'locations' } }`
 * reads as "on every `User`, also expose `addresses` as `locations`".
 *
 * The key is the field the schema has; the value is the name (or names) to expose it under.
 */
export type AliasesConfig<TTypes extends Record<string, unknown> = Record<string, unknown>> = {
  [K in keyof TTypes]?: Record<string, string | readonly string[]>;
};

/** Where a derive is firing, plus the tools the function may need. */
export interface DeriveContext {
  /** The owning instance's index in its own pool, the same index `stableIds` numbers with. */
  index: number;
  typeName: string;
  fieldName: string;
  /** The same seeded faker the generator drew with, so a derive stays deterministic. */
  faker: Faker;
}

/**
 * Compute a field from the object that owns it. Unlike {@link FieldOverrideFn}, which fires
 * while the instance is still being built, a derive runs once the instance is complete and
 * every relationship is wired — so `self` carries the type's scalars, its relationship fields,
 * and any reciprocal back-references:
 *
 * ```ts
 * derive: { User: { fullName: (self) => `${self.firstName} ${self.lastName}` } }
 * ```
 *
 * `self` is deliberately **bivariant**. TypeScript checks function parameters
 * contravariantly, so a derive written against a precise map entry (`self: Order`) is not
 * assignable to the erased `FieldDeriveFn<Record<string, unknown>>` that an unparameterized
 * `DeriveConfig` holds — which made a precisely typed, separately declared derive block
 * impossible to pass anywhere. The library is the only caller and always supplies the instance
 * the map describes, so the soundness contravariance protects is not at stake here; declaring
 * the signature in method position is how that is asked for. The cost is that an unrelated but
 * *wider* `self` annotation is accepted; the return type stays checked either way.
 *
 * @typeParam TSelf - The owning object's type. @typeParam T - The field's value type.
 */
export type FieldDeriveFn<TSelf = Record<string, unknown>, T = unknown> = {
  derive(self: TSelf, ctx: DeriveContext): T;
}['derive'];

// Derives for a single type, degrading to a loose record when the shape is unknown, and
// treating the map as a hint for the rest, the same way `FieldOverrides` does. The fallback
// keeps `self` bound to the owning type and only loosens the return, which is the case a
// derive is usually reaching for: a total rolled up from fields that *are* in the map.
type FieldDerives<T> = unknown extends T
  ? Record<string, FieldDeriveFn>
  : { [F in keyof T]?: FieldDeriveFn<T, T[F]> } & Record<string, FieldDeriveFn<T>>;

/**
 * Per-type, per-field derive map. With a `TTypes` map, type and field names autocomplete,
 * `self` is the owning type, and each derive's return type is bound to the field's type.
 *
 * Type names are checked against the map; field names are a hint. A derive may write a field
 * the map does not carry — a rolled-up total, a display string no query selects — and `self`
 * stays typed while that field's return falls back to `unknown`.
 */
export type DeriveConfig<TTypes extends Record<string, unknown> = Record<string, unknown>> = {
  [K in keyof TTypes]?: FieldDerives<TTypes[K]>;
};

/**
 * Where an object derive is firing. {@link DeriveContext} without `fieldName`, because an
 * object derive writes as many fields as it returns rather than one named one.
 */
export type ObjectDeriveContext = Omit<DeriveContext, 'fieldName'>;

// What an object derive may return: the mapped fields bound to their own types, plus anything
// else. Unlike `FieldDerives`, the intersection is in the *return* position only, so it never
// reaches the contextual typing of `self` and `ctx`.
type DerivedObject<T> = unknown extends T
  ? Record<string, unknown>
  : Partial<T> & Record<string, unknown>;

/**
 * Compute several fields of one instance from a single draw. Runs once per instance, sees the
 * same finished object a {@link FieldDeriveFn} does, and returns a partial merged over it:
 *
 * ```ts
 * deriveObject: {
 *   Order: (_self, { faker }) => {
 *     const subtotal = faker.number.float({ min: 10, max: 500 });
 *     const tax = subtotal * 0.08;
 *     return { subtotal, tax, total: subtotal + tax };
 *   },
 * }
 * ```
 *
 * A key the returned object does not carry is left as generated, so a partial really is partial.
 *
 * @typeParam TSelf - The owning object's type.
 */
export type ObjectDeriveFn<TSelf = Record<string, unknown>> = (
  self: TSelf,
  ctx: ObjectDeriveContext,
) => DerivedObject<TSelf>;

// Degrade to a loosely-typed `self` when the map carries no shape for the type, the same way
// `FieldDerives` does — otherwise `self` would arrive as `unknown` and read nothing.
type TypeObjectDerive<T> = unknown extends T ? ObjectDeriveFn : ObjectDeriveFn<T>;

/**
 * Per-type object derive map: one function per type, returning the fields that have to be
 * drawn together. With a `TTypes` map, type names autocomplete, `self` is the owning type,
 * and a returned field the map carries is bound to that field's type.
 */
export type ObjectDeriveConfig<TTypes extends Record<string, unknown> = Record<string, unknown>> = {
  [K in keyof TTypes]?: TypeObjectDerive<TTypes[K]>;
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

/**
 * Which pooled objects a relationship field may draw from. Returns a truthy value to keep one.
 *
 * The item is a pooled instance, typed loosely because `relations` keys fields by name and
 * carries no per-field element type — narrow it yourself where the schema types are to hand.
 */
export type RelationPredicate = (item: Record<string, unknown>, ctx: RelationContext) => unknown;

/**
 * Draw the related objects from only the pooled ones a predicate keeps — the shape that
 * otherwise drops straight to a {@link RelationFn} and re-implements the sizing along with it:
 *
 * ```ts
 * relations: {
 *   Order: { shippingMethod: { where: (m) => m.isActive } },
 *   Post: { comments: { size: 3, where: (c) => !c.isSpam } },
 * }
 * ```
 *
 * A predicate that matches nothing throws: an empty candidate set is a statement the pool
 * cannot satisfy, and left alone it surfaces much later as an unexplained null. Where "none"
 * is a legitimate answer, say so with a {@link RelationFn}.
 */
export interface RelationFilter {
  /** How many to draw from the candidates. Sized like any other relation when omitted. */
  size?: RelationSize;
  /** Keeps the pooled objects this field may draw from. */
  where: RelationPredicate;
}

/** A size, a filtered draw, or a function that computes the field value outright. */
export type RelationSpec = RelationSize | RelationFilter | RelationFn;

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
   *
   * `'hidden'` wires the same references but defines them non-enumerable, so `JSON.stringify`
   * and `Object.entries`-based walks skip them while `todo.user` still reads normally. Forward
   * relationship fields can form cycles of their own, so this narrows the problem rather than
   * removing it — `toPlain` is the general answer.
   *
   * @default false
   */
  _reciprocal?: boolean | 'hidden';
  [typeName: string]: TypeRelations<unknown> | RelationSpec | boolean | 'hidden' | undefined;
}

/** The `relations` map when a `TTypes` map is supplied: type and field names are checked. */
export type TypedRelationsMap<TTypes extends Record<string, unknown>> = {
  _default?: RelationSpec;
  _reciprocal?: boolean | 'hidden';
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
  /**
   * With a `lists` profile active, rewrite companion count scalars to the length of the list
   * they count, so an emptied list no longer reports a total of 315. A count is paired by name
   * — `totalCount`/`total`/`resultCount` and friends on a type with one list field, or
   * `postCount`/`numberOfPosts`/`totalPosts` naming the list directly — and a field with an
   * explicit `overrides` entry is left alone. Set `false` for a schema where the convention
   * doesn't hold.
   * @default true
   */
  syncCounts?: boolean;
  /**
   * Pair a count field with its list explicitly, for the schemas the convention misses:
   *
   * ```ts
   * qa: { lists: 'empty', countFields: { ProductSearchResult: { hitTotal: 'results' } } }
   * ```
   *
   * Keyed by type name, then by count field name, with the list field name as the value.
   * Applied verbatim, ahead of any name matching.
   */
  countFields?: Record<string, Record<string, string>>;
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

/** What an {@link ArgOverride}'s `data` function is handed. */
export interface ArgOverrideContext {
  /** The type that declares the field — `Query`, or the parent type for a nested field. */
  typeName: string;
  /** The schema field name, never the alias it was selected under. */
  fieldName: string;
  /** The field's coerced argument values. */
  args: Record<string, unknown>;
  /** The pool for the field's return type, empty for a scalar or an unpooled type. */
  pool: Record<string, unknown>[];
  /** Whether the field returns a list, so one function can serve both shapes. */
  isList: boolean;
  faker: Faker;
}

/** Which field selection an {@link ArgOverride} answers. */
export interface ArgOverrideMatch {
  /** Restrict to one parent type. Any type when omitted. */
  type?: string;
  /** The schema field name, never the alias. */
  field: string;
  /**
   * Argument values that must all be present and equal for the override to apply. Compared by
   * value, so an input object matches structurally. Omitted (with no `predicate`) matches the
   * field whatever its arguments are.
   */
  args?: Record<string, unknown>;
  /** Full control over the argument test, in place of `args`. */
  predicate?: (args: Record<string, unknown>) => boolean;
}

/**
 * What an override answers with: a value, or a function of the field's context. Spelled out as
 * a union of value shapes rather than `unknown` so a `data: ({ pool }) => …` arrow gets its
 * context typed — `unknown | Fn` collapses to `unknown` and loses the signature.
 */
export type ArgOverrideData =
  | ((ctx: ArgOverrideContext) => unknown)
  | Record<string, unknown>
  | readonly unknown[]
  | string
  | number
  | boolean
  | null;

/** A field-level, argument-matched answer — see {@link BuildMocksOptions.argOverrides}. */
export interface ArgOverride {
  match: ArgOverrideMatch;
  /** The value the field resolves to, or a function of the field's context. */
  data: ArgOverrideData;
}

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
   * Size of generated list fields — scalar and enum lists, wired relationship lists, and root
   * list fields resolved by `dataForOperation`. A flat size covers every list; a map sizes one
   * type, or one field:
   *
   * ```ts
   * buildMocks(schema, { listSize: { min: 2, max: 4 } });   // every list
   * buildMocks(schema, { listSize: { Post: { tags: 3 } } }); // just Post.tags
   * buildMocks(schema, { listSize: { Query: { users: 10 } } }); // a root list
   * ```
   *
   * Resolved most specific first — `[type][field]` → `[type]._default` → `_default` → the flat
   * form. An entry naming a type is a deliberate statement about that type, so it wins over a
   * QA `lists` profile; the catch-all forms lose to one. A `relations` entry is more specific
   * still and wins over both for a relationship field.
   *
   * Unlike `relations`, this never grows a pool: relationship lists are sampled without
   * replacement, so a size above the target type's `count` is clamped to the pool.
   *
   * @default { min: 1, max: 5 }
   */
  listSize?: ListSizeConfig<TTypes>;
  /**
   * Draw scalar and enum list fields **without replacement**, so a generated list holds no
   * duplicate values — the treatment relationship lists have always had. On by default,
   * because a list a consumer keys by (`tags.map(tag => <Chip key={tag}>)`) containing the
   * same value twice is a defect wherever it surfaces.
   *
   * The length is clamped to the number of distinct values available, so a `[Status!]!` over a
   * three-value enum yields at most three entries however large `listSize` is. A scalar
   * generator has no countable set of values, so the draw is retried a bounded number of times
   * per slot and the list comes back short if the generator keeps repeating itself.
   *
   * Turn it off globally with `false`, or per type and field with a map shaped like
   * `listSize`:
   *
   * ```ts
   * buildMocks(schema, { uniqueLists: false });                    // draw with replacement
   * buildMocks(schema, { uniqueLists: { Post: { tags: false } } }); // just Post.tags
   * ```
   *
   * QA mode turns this off by default: its corpora are deliberately tiny, so deduplicating
   * would silently cap a `lists: 'huge'` profile at the size of the corpus. An explicit
   * `uniqueLists` still applies under QA.
   *
   * @default true (false under `qa`)
   */
  uniqueLists?: UniqueListsConfig<TTypes>;
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
   * Override functions keyed by field name rather than by type, so one entry covers every type
   * carrying that field. A key wrapped in slashes is a pattern. A type-keyed `overrides` entry
   * for the same field still wins, so the general rule stays overridable per type.
   *
   * ```ts
   * fieldOverrides: { imageUrl: (f) => f.image.url(), '/Url$/': (f) => f.image.url() }
   * ```
   *
   * Where you control the schema, a semantic scalar is the better fix; this is for the field
   * names you cannot retype, which in a stitched or generated schema is most of them.
   */
  fieldOverrides?: FieldOverridesConfig;
  /**
   * Also expose a field under the name a fragment aliases it to:
   *
   * ```ts
   * // fragment UserCard on User { id, locations: addresses { city } }
   * buildMocks(schema, { aliases: { User: { addresses: 'locations' } } });
   * ```
   *
   * A component typed by that fragment reads `locations`, which a pooled `User` does not have —
   * so it renders an empty section, with no type error anywhere to say why. The alias holds the
   * same reference as the field it mirrors, not a clone, so identity comparisons and the wired
   * graph keep working through it.
   *
   * Applied last, after relationships, counts and derives, so an alias carries the finished
   * value. An unknown type or field, or an alias that collides with a real field, throws.
   */
  aliases?: AliasesConfig<TTypes>;
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
   * Per-type, per-field functions that compute a field **from the finished object**. They run
   * last — after scalars, after `overrides`, after relationships are wired and mirrored — so
   * every sibling and every related object is already there to read:
   *
   * ```ts
   * buildMocks(schema, {
   *   derive: {
   *     User: { fullName: (self) => `${self.firstName} ${self.lastName}` },
   *     ProductSearchResult: { totalCount: (self) => self.results.length },
   *   },
   * });
   * ```
   *
   * This is the lever for any field that must agree with its siblings — a total over a list,
   * a name assembled from its parts, a balance that is a difference of two others. `overrides`
   * structurally cannot do it: it fires per field while the instance is half-built, so a derive
   * always wins over an `overrides` entry for the same field. Within one type, derives run in
   * the order they are written, so one may read another's result.
   *
   * Applies to pooled instances, which is what every operation draws from.
   */
  derive?: DeriveConfig<TTypes>;
  /**
   * One function per type, returning an object merged over the generated instance — for the
   * fields that come from a **single** draw and so cannot be written one at a time:
   *
   * ```ts
   * buildMocks(schema, {
   *   deriveObject: {
   *     Order: (_self, { faker }) => {
   *       const subtotal = faker.number.float({ min: 10, max: 500 });
   *       const tax = subtotal * 0.08;
   *       return { subtotal, tax, total: subtotal + tax };
   *     },
   *   },
   * });
   * ```
   *
   * A per-field `derive` runs once per field against a faker stream it shares with every other
   * field, so three numbers that must add up have no way to agree without a memo keyed on the
   * instance. Here they are one expression.
   *
   * Runs in the same phase as `derive` and sees the same finished object — every scalar, every
   * wired relationship, every reciprocal back-reference. Within a type the object derive runs
   * **first** and a `derive` for a key it returned wins, being the more specific entry; a
   * `derive` therefore reads the correlated values off `self`. Both beat `overrides`, which
   * fires while the instance is half-built. A key the returned object omits is left as
   * generated, and a nullish return leaves the instance untouched.
   */
  deriveObject?: ObjectDeriveConfig<TTypes>;
  /**
   * Keep count scalars in step with the lists they count, and size those lists to the whole pool
   * of what they hold — the one size at which a wrapper's total and its pageable rows agree:
   *
   * ```ts
   * buildMocks(schema, {
   *   count: { _default: 40 },
   *   countFields: true, // ProductSearchResult.totalCount -> results.length, results -> all 40
   * });
   * ```
   *
   * `true` pairs by name: `totalCount`/`total`/`resultCount` and friends on a type with one list
   * field, or `postCount`/`numberOfPosts`/`totalPosts` naming the list directly. A Relay
   * connection pairs the same way — `totalCount` against `edges`. Pass a map for the pairings the
   * convention misses, which also turns the pass on:
   *
   * ```ts
   * countFields: { ProductSearchResult: { hitTotal: 'results' } }
   * ```
   *
   * A field with an explicit `overrides` entry is left alone, a `derive` for the same field still
   * wins (it runs after), and an explicit `relations` size for the list still decides its length.
   * Under a QA `lists` profile the profile owns the sizing and this only syncs the counts, so an
   * emptied list reports zero. `false` turns the whole pass off.
   */
  countFields?: CountFieldsConfig<TTypes>;
  /**
   * One or more {@link Scenario} layers to build on. Applied left to right, with these
   * options merged last — so an explicit `count` here always wins over a scenario's.
   *
   * ```ts
   * buildMocks(schema, { scenario: [scenarios.newUser, scenarios.offline], seed: 42 });
   * ```
   *
   * Maps merge key by key (`count`, `overrides`, `derive`, `relations`, `scalars`, and the QA
   * dimensions); everything else is last-one-wins.
   */
  scenario?: Scenario<TTypes> | Scenario<TTypes>[];
  /**
   * Required when the schema has interface or union fields.
   * Return the concrete type name to use when mocking a field of that abstract type.
   */
  resolveType?: (abstractTypeName: string) => keyof TTypes & string;
  /**
   * Interpret operation arguments when resolving fields instead of ignoring them: match pooled
   * items by scalar equality, apply `skip`/`limit` paging to list fields, and apply substring
   * filters from search-style arguments. Pass an {@link ArgMatchingOptions} object to tune it.
   *
   * Off by default, so existing output is unchanged. Turning it on is safe for operations that
   * supply no variables — an argument bound to a variable this package synthesized (because the
   * operation declares it non-null and the caller didn't pass one) is ignored, so
   * `mocks.mockOperation(UserByIdQuery)` still returns a random pooled user.
   *
   * Arguments are matched only by exact field name; there is no `authorId` -> `author.id`
   * traversal. When a root field returns a wrapper type (`{ totalCount, results }`) the entity
   * list sits below the arguments and cannot be reached — use `mockOperation(doc, (vars) => …)`
   * with the exported `paginate`/`searchItems` there instead.
   *
   * @default false
   */
  matchArguments?: boolean | ArgMatchingOptions;
  /**
   * Answer a field with specific data when its *arguments* say so, leaving the rest of the
   * operation to resolve from the graph. First match wins.
   *
   * ```ts
   * argOverrides: [
   *   { match: { field: 'items', args: { where: 'LOW_STOCK' } }, data: lowStockRows },
   *   { match: { type: 'Query', field: 'users' }, data: ({ pool }) => pool.slice(0, 2) },
   * ];
   * ```
   *
   * A dashboard selects one field several times under different aliases, differing only by an
   * argument value the matcher can't interpret (`items(where: LOW_STOCK)`). Only the caller
   * knows what `LOW_STOCK` implies, and pinning the whole operation with a handler override
   * gives up graph resolution for every other field on the screen. This is the narrow lever:
   * one field, chosen by its arguments.
   *
   * Independent of {@link matchArguments} — an override is an instruction, not an inference,
   * so it applies whether or not argument matching is on.
   */
  argOverrides?: readonly ArgOverride[];
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
   * Give every object's identifier fields a stable, pool-unique value instead of a random
   * scalar. Keeps cache keys distinct and output readable. An explicit `overrides` entry for
   * the field still wins.
   *
   * `true` covers every field the library recognizes as an identifier by name: `id` (in any
   * casing) and anything ending in `Id` or `ID` — `id` keeps the `TypeName-<index>` form, and
   * any other field carries its own name too (`PaymentMethod-paymentMethodId-0`) so two
   * identifier fields on one object never land on the same string.
   *
   * A schema whose identifier is named something else (`Currency.code`) can say so, either for
   * every type or per type. Those names are covered *in addition* to the recognized ones:
   *
   * ```ts
   * buildMocks(schema, { stableIds: ['code'] });
   * buildMocks(schema, { stableIds: { Currency: ['code'], _default: [] } });
   * ```
   *
   * Only string-valued scalar fields are replaced (`id` itself aside, which is assigned
   * whatever it holds): writing `Currency-code-0` over an `Int` or an enum would produce data
   * the schema rejects. Keep a recognized field random with an `overrides` entry for it.
   *
   * @default false
   */
  stableIds?: StableIdsConfig<TTypes>;
  /**
   * Prefix stable ids with this string, giving `<prefix>User-0` instead of `User-0`. Only
   * meaningful with `stableIds`, and there only to keep ids from colliding across pools
   * built in the same run — which is what {@link buildMatrix} uses it for.
   * @default ''
   */
  idPrefix?: string;
}

/**
 * A named, reusable bundle of build options — "a new user with nothing", "a workspace at
 * scale". Everything `buildMocks` takes except the reproducibility controls: `faker` and
 * `seed` stay with the call site, so a scenario can be reused under any seed.
 */
export type Scenario<TTypes extends Record<string, unknown> = Record<string, unknown>> = Omit<
  BuildMocksOptions<TTypes>,
  'faker' | 'seed' | 'scenario'
> & {
  /** What this scenario is for. Carried through composition; ignored by the generator. */
  description?: string;
};

/** Scenarios by name, as `defineScenarios` returns them. */
export type ScenarioMap<TTypes extends Record<string, unknown> = Record<string, unknown>> = Record<
  string,
  Scenario<TTypes>
>;

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
   * The pooled item of `typeName` at `index`, in generation order — the same order `stableIds`
   * numbers them in. Returns undefined when the index is out of range.
   */
  at<K extends keyof TTypes & string>(typeName: K, index: number): TTypes[K] | undefined;
  at<T = unknown>(typeName: string, index: number): T | undefined;
  /**
   * The pooled item of `typeName` with this id. Ids are compared as strings, so a numeric id
   * from a variable matches a string id in the pool.
   */
  byId<K extends keyof TTypes & string>(typeName: K, id: string | number): TTypes[K] | undefined;
  byId<T = unknown>(typeName: string, id: string | number): T | undefined;
  /**
   * The ids of every pooled item of `typeName`, in generation order; items without an id are
   * skipped. Unlike `at(...)?.id`, this needs no `TTypes` map to come back typed:
   *
   * ```ts
   * const id = mocks.ids('User')[0] as string;
   * mocks.mockOperation(UserByIdQuery, { variables: { id }, matchArguments: true });
   * ```
   *
   * Pair it with `stableIds` for readable, stable values.
   */
  ids(typeName: string): string[];
  /**
   * Resolve a query or mutation against the mock graph and return its data shaped to the
   * selection set — no need to assemble the result by hand. Root fields are drawn from the
   * pools by their return type; nested fields follow the already-wired object references.
   * With a `TypedDocumentNode` the return type is inferred from the document.
   *
   * Variables affect which mocks are chosen only when
   * {@link BuildMocksOptions.matchArguments} is on (globally or via the third argument here);
   * otherwise pass them only if your schema requires them for execution — required variables
   * are auto-filled with placeholders when omitted.
   *
   * **Not idempotent.** Each call re-resolves against the pool and draws from the shared seeded
   * faker, so two identical calls return different rows — and, for a root list, a different
   * number of them. It reads like a pure accessor and is not one. To get the rows a *mock* will
   * hand Apollo, build the mock and read it back with `dataOf`.
   */
  dataForOperation<TData = unknown, TVars = Record<string, unknown>>(
    document: TypedDocumentNode<TData, TVars> | DocumentNode,
    variables?: TVars extends Record<string, unknown> ? Partial<TVars> : Record<string, unknown>,
    matchArguments?: boolean | ArgMatchingOptions,
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
   * Pass `dynamic: true` to resolve per request from the incoming variables instead of once
   * up front — `result` then becomes a function, which is why it is opt-in.
   */
  mockOperation<TData = unknown, TVars = Record<string, unknown>>(
    operation: TypedDocumentNode<TData, TVars>,
    options: MockOperationOptions<TVars, TData> & { dynamic: true },
  ): DynamicMockedResponse<TData, TVars>;
  mockOperation<TData = unknown, TVars = Record<string, unknown>>(
    operation: TypedDocumentNode<TData, TVars>,
    options?: MockOperationOptions<TVars, TData>,
  ): MockedResponse<TData, TVars>;
  /**
   * Like {@link MockHelpers.mockOperation}, but returns the success / long-load / error trio at
   * once, with the success data resolved from this graph.
   */
  mockOperationVariants<TData = unknown, TVars = Record<string, unknown>>(
    operation: TypedDocumentNode<TData, TVars>,
    options: MockOperationOptions<TVars, TData> & { dynamic: true },
  ): DynamicMockOperationVariants<TData, TVars>;
  mockOperationVariants<TData = unknown, TVars = Record<string, unknown>>(
    operation: TypedDocumentNode<TData, TVars>,
    options?: MockOperationOptions<TVars, TData>,
  ): MockOperationVariants<TData, TVars>;
  /**
   * Turn a codegen document module into a keyed map of {@link MockHelpers.mockOperationVariants}
   * results, replacing a file of per-operation re-exports with one call:
   *
   * ```ts
   * import * as operations from './queries.generated.js';
   * const opMocks = mocks.mockOperationsFrom(operations);
   * // opMocks.UserByIdDocument.withResults | .withLongLoadTime | .withError
   * ```
   *
   * Keys are the module's **export names**, not operation names, so each entry's
   * `withResults.result.data` is typed to that operation. Non-document exports are skipped.
   * Entries are built lazily on first access, so a fifty-document module costs nothing at
   * import time — but spreading the map, or `Object.values`, forces every entry.
   */
  mockOperationsFrom<TModule extends OperationModule>(
    module: TModule,
    options?: MockOperationOptions,
  ): OperationMocks<TModule>;
  /**
   * Build a handler that answers **any** operation from this graph — no per-operation
   * registration, so one handler covers a whole screen's queries and mutations:
   *
   * ```ts
   * const handler = mocks.toRequestHandler();
   * const { data } = await handler({ query: SomeQuery, variables: { id } });
   * ```
   *
   * Results are memoized per document + variables by default, so a refetch or a second
   * identical query returns the same rows. `overrides` force a specific operation into an
   * error, loading or fixed-data state, and `calls` records what was asked for.
   *
   * Pair it with the `@vantreeseba/graphql-mocks/apollo` export to get an `ApolloLink`.
   */
  toRequestHandler(options?: MockHandlerOptions): MockRequestHandler;
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
