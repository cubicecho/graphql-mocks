import type { GraphQLSchema } from 'graphql';
import { type BuildMatrixOptions, buildMatrix } from './matrix.js';
import { QA_PROFILES, QA_PROFILE_NAMES } from './qa.js';
import type { BuildMocksOptions, MockResult, QaConfig, QaProfileName } from './types.js';

/** One generated QA pool, tagged with the profile that produced it. */
export interface QaSet<TTypes extends Record<string, unknown> = Record<string, unknown>> {
  /** The preset this set came from — use it as the story/test name. */
  name: QaProfileName;
  /** The resolved config, handy for rendering "what's weird about this set" in a story. */
  qa: QaConfig;
  /** The mocks themselves — same shape as a `buildMocks` result. */
  mocks: MockResult<TTypes>;
}

export interface BuildQaSetsOptions<
  TTypes extends Record<string, unknown> = Record<string, unknown>,
> extends BuildMocksOptions<TTypes> {
  /**
   * Which presets to generate, in order.
   * @default every profile in {@link QA_PROFILE_NAMES}
   */
  profiles?: QaProfileName[];
  /**
   * Shared QA settings merged *under* each preset, so a preset's own dimensions still win.
   * Useful for pinning `listSize` across the whole run.
   */
  qa?: QaConfig;
}

/**
 * Build one mock pool per QA preset in a single call — the shape Storybook and Apollo's
 * `MockedProvider` want, where each entry becomes one story or one test case.
 *
 * ```ts
 * export const QaVariants = buildQaSets(schema, { seed: 42 }).map((set) => ({
 *   name: set.name,
 *   parameters: { apolloClient: { mocks: [set.mocks.mockOperation(UserQuery)] } },
 * }));
 * ```
 *
 * Each set is generated from its **own** Faker instance seeded with `seed`, so a set reproduces
 * identically no matter which other profiles were requested alongside it — drop one from
 * `profiles` and the rest are unchanged. That holds whether or not the options carry a `faker`:
 * one passed in contributes its locale data and is never drawn from or re-seeded, so the same
 * options object you hand `buildMocks` can come straight here without stripping anything out.
 *
 * A thin wrapper over {@link buildMatrix}' QA axis — reach for that one when you also want
 * a scenario axis.
 */
export function buildQaSets<TTypes extends Record<string, unknown> = Record<string, unknown>>(
  schema: GraphQLSchema | string,
  options: BuildQaSetsOptions<NoInfer<TTypes>> = {},
): QaSet<TTypes>[] {
  const { profiles = QA_PROFILE_NAMES, ...rest } = options;

  for (const name of profiles) {
    if (!QA_PROFILES[name]) {
      throw new RangeError(
        `[graphql-mocks] buildQaSets: unknown profile "${name}". Known profiles: ${QA_PROFILE_NAMES.join(', ')}`,
      );
    }
  }

  // One preset per cell on the QA axis, with no scenario axis — so `idPrefix` stays empty
  // and each set's output is exactly what a plain `buildMocks` with that preset produces.
  return buildMatrix<TTypes>(schema, {
    ...rest,
    qaPresets: profiles,
    idPrefix: '',
  } as BuildMatrixOptions<NoInfer<TTypes>>).map((cell, index) => ({
    name: profiles[index] as QaProfileName,
    qa: cell.options.qa as QaConfig,
    mocks: cell.mocks,
  }));
}
