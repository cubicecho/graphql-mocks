import { Faker, base, en } from '@faker-js/faker';
import type { GraphQLSchema } from 'graphql';
import { buildMocks } from './mockSchema.js';
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
 * Unless you pass your own `faker`, each set is generated from its **own** Faker instance
 * seeded with `seed`, so a set reproduces identically no matter which other profiles were
 * requested alongside it — drop one from `profiles` and the rest are unchanged. Sharing a
 * single instance (by passing `faker`) gives up that property, because every draw advances
 * the same stream.
 */
export function buildQaSets<TTypes extends Record<string, unknown> = Record<string, unknown>>(
  schema: GraphQLSchema | string,
  options: BuildQaSetsOptions<NoInfer<TTypes>> = {},
): QaSet<TTypes>[] {
  const { profiles = QA_PROFILE_NAMES, qa: sharedQa, faker, seed, ...rest } = options;

  return profiles.map((name) => {
    const preset = QA_PROFILES[name];
    if (!preset) {
      throw new RangeError(
        `[graphql-mocks] buildQaSets: unknown profile "${name}". Known profiles: ${QA_PROFILE_NAMES.join(', ')}`,
      );
    }
    // The preset's dimensions win over the shared base, so `qa: { listSize: 500 }` tunes
    // hugeLists without silently overriding what any preset is there to test.
    const qa: QaConfig = { ...sharedQa, ...preset };

    // A fresh instance per set keeps each one independently reproducible; the shared
    // module-level faker would carry state from whichever sets ran before it.
    const setFaker = faker ?? new Faker({ locale: [en, base] });
    if (seed !== undefined) setFaker.seed(seed);

    const mocks = buildMocks<TTypes>(schema, {
      ...rest,
      faker: setFaker,
      qa,
    } as BuildMocksOptions<NoInfer<TTypes>>);

    return { name, qa, mocks };
  });
}
