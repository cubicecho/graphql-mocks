import type { Faker } from '@faker-js/faker';
import { resolveFaker } from './helpers.js';
import { type ResolvedQa, qaDefaultCount, qaNullChance, qaScalarMockers, resolveQa } from './qa.js';
import { applyScenarios } from './scenarios.js';
import type {
  BuildMocksOptions,
  CountConfig,
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
  /** Prepended to every stable id. Empty unless the caller (or `buildMatrix`) sets it. */
  idPrefix: string;
  scalars: Record<string, ScalarMocker> | undefined;
  overrides: OverridesConfig;
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
    idPrefix: options.idPrefix ?? '',
    scalars: options.scalars,
    overrides: options.overrides ?? {},
    relations: options.relations,
    resolveType: options.resolveType,
    qa,
    qaScalars: qa ? qaScalarMockers(qa) : undefined,
  };
}
