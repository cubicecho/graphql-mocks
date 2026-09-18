import type { Faker } from '@faker-js/faker';
import type { ArgMatchingOptions } from './argMatching.js';
import { type ListSizeRange, lookupListSize, resolveFaker, resolveListSize } from './helpers.js';
import {
  type ResolvedQa,
  qaDefaultCount,
  qaListLength,
  qaNullChance,
  qaScalarMockers,
  resolveQa,
} from './qa.js';
import { applyScenarios } from './scenarios.js';
import type {
  AliasesConfig,
  ArgOverride,
  BuildMocksOptions,
  CountConfig,
  CountFieldsConfig,
  DeriveConfig,
  FieldOverridesConfig,
  ListSizeConfig,
  OverridesConfig,
  RelationsConfig,
  ScalarMocker,
} from './types.js';

/**
 * Every option folded into the single shape the generator actually consumes — defaults
 * applied, QA resolved, faker seeded.
 *
 * This exists because the build path and the operation path used to resolve the same options
 * independently: `buildGraph` built a QA context for phase 1/2 while `resolveOperationData`
 * called `resolveQa` again for root fields. Two resolutions meant every new option had to be
 * threaded twice and could drift between the pool and the data `dataForOperation` returns.
 * Resolving once, here, makes that structurally impossible.
 */
export interface ResolvedOptions {
  /**
   * Seeded exactly once, when this object is built. Every downstream draw — both phases and
   * the operation path — uses this instance, so `seed` reproduces the whole result.
   */
  faker: Faker;
  count: CountConfig | undefined;
  /** Pool size to use for any type without an explicit `count`. */
  defaultCount: number;
  /** Probability a nullable field is null. A QA `nulls` profile overrides `nullChance`. */
  nullChance: number;
  addTypename: boolean;
  stableIds: boolean;
  /**
   * Catch-all sizing for every generated list: the flat `listSize` form, or the map's
   * top-level `_default`. A QA list profile and a `relations` entry are both more specific
   * and win over it.
   */
  listSize: ListSizeRange;
  /**
   * The `listSize` config as written, kept so {@link listSizeFor} can read the entries that
   * name a type or a field — unlike the catch-all above, those outrank a QA list profile.
   */
  listSizes: ListSizeConfig | undefined;
  /**
   * Left unresolved: `dataForOperation` and the request handler can override it per call, and
   * `resolveArgMatching` is what folds the two together at the point of use.
   */
  matchArguments: boolean | ArgMatchingOptions | undefined;
  /** Argument-matched field answers, in declaration order — first match wins. */
  argOverrides: readonly ArgOverride[];
  /** Prepended to every stable id. Empty unless the caller (or `buildMatrix`) sets it. */
  idPrefix: string;
  scalars: Record<string, ScalarMocker> | undefined;
  overrides: OverridesConfig;
  /**
   * Left unexpanded here: turning "every `imageUrl`" into per-type entries needs the schema,
   * which `resolveOptions` has no access to. `expandFieldOverrides` folds it into `overrides`
   * before anything reads them.
   */
  fieldOverrides: FieldOverridesConfig | undefined;
  /** Extra names to expose fields under, applied after everything else has run. */
  aliases: AliasesConfig | undefined;
  /** Field functions run after the graph is complete, so they see the finished object. */
  derive: DeriveConfig | undefined;
  /**
   * Pair count scalars with the lists they count outside QA mode. Left as given: `countFields.ts`
   * folds it together with `qa.countFields` at the point of use, since either can turn the pass
   * on and they merge per type.
   */
  countFields: CountFieldsConfig | undefined;
  relations: RelationsConfig | undefined;
  resolveType: ((abstractTypeName: string) => string) | undefined;
  qa: ResolvedQa | undefined;
  /** Derived from `qa` once, rather than per instance. Undefined when QA mode is off. */
  qaScalars: Record<string, ScalarMocker> | undefined;
}

/** Normalize caller options into the resolved shape. Seeds `faker` as a side effect. */
export function resolveOptions(rawOptions: BuildMocksOptions): ResolvedOptions {
  // Scenario layers first, so everything below reads one already-merged config.
  const options = applyScenarios(rawOptions);
  const faker = resolveFaker(options);
  const qa = resolveQa(options.qa);

  return {
    faker,
    count: options.count,
    defaultCount: qaDefaultCount(qa, 5),
    nullChance: qaNullChance(qa) ?? options.nullChance ?? 0,
    addTypename: options.addTypename ?? true,
    stableIds: options.stableIds ?? false,
    listSize: resolveListSize(options.listSize),
    listSizes: options.listSize,
    matchArguments: options.matchArguments,
    argOverrides: options.argOverrides ?? [],
    idPrefix: options.idPrefix ?? '',
    scalars: options.scalars,
    overrides: options.overrides ?? {},
    fieldOverrides: options.fieldOverrides,
    aliases: options.aliases,
    derive: options.derive,
    countFields: options.countFields,
    relations: options.relations,
    resolveType: options.resolveType,
    qa,
    qaScalars: qa ? qaScalarMockers(qa) : undefined,
  };
}

/**
 * Length bounds for one list field, wherever it is generated — a scalar or enum list in phase
 * 1, a wired relationship list in phase 2, or a root list `dataForOperation` resolves.
 *
 * A `listSize` entry naming this type (and optionally this field) is a deliberate statement
 * about one field, so it outranks a QA `lists` profile, which is a broad sweep. Everything
 * else falls through to the profile, and then to the catch-all size. A `relations` entry is
 * more specific still; the two relationship callers apply it on top of what this returns.
 */
export function listSizeFor(
  typeName: string,
  fieldName: string,
  resolved: ResolvedOptions,
): ListSizeRange {
  return (
    lookupListSize(typeName, fieldName, resolved.listSizes) ??
    qaListLength(resolved.qa, resolved.listSize)
  );
}
