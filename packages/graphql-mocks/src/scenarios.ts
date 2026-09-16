import type { DocumentNode } from 'graphql';
import type { MockHandlerOptions, MockOverride, MockOverrideMatcher } from './requestHandler.js';

/**
 * The three handler configurations a component is usually exercised with. Keys are lowercase
 * and `errored` rather than `error`, so they map onto `Default` / `Loading` / `Errored` without
 * a rename and without colliding with the `error` option name.
 */
export interface MockScenarios {
  /** Resolves normally from the graph. */
  default: MockHandlerOptions;
  /** Stays pending, so the loading state renders. */
  loading: MockHandlerOptions;
  /** Fails with a GraphQL error, so the error state renders. */
  errored: MockHandlerOptions;
}

/** Which operations a scenario targets: names, documents, a predicate, or a list of those. */
export type ScenarioTarget = MockOverrideMatcher | readonly (string | DocumentNode)[];

function overridesFor(target: ScenarioTarget | undefined, state: MockOverride): MockOverride[] {
  if (target === undefined) return [state];
  if (Array.isArray(target)) {
    return (target as readonly (string | DocumentNode)[]).map((match) => ({ ...state, match }));
  }
  return [{ ...state, match: target as MockOverrideMatcher }];
}

/**
 * Build the default / loading / errored trio of handler options for one base configuration,
 * so a story file declares three states instead of three hand-assembled mock arrays:
 *
 * ```ts
 * const scenarios = mockScenarios({ matchArguments: true });
 * // handler: mocks.toRequestHandler(scenarios.loading)
 * ```
 *
 * `target` narrows the loading/error states to specific operations, leaving everything else
 * resolving normally — which is what a screen with one failing panel needs. Omit it to put
 * every operation into the state.
 *
 * The scenario overrides are prepended to any in `base`, since first match wins; `base`
 * overrides still apply to operations the scenario does not target.
 */
export function mockScenarios(
  base: MockHandlerOptions = {},
  target?: ScenarioTarget,
): MockScenarios {
  const withOverrides = (state: MockOverride): MockHandlerOptions => ({
    ...base,
    overrides: [...overridesFor(target, state), ...(base.overrides ?? [])],
  });

  return {
    default: { ...base },
    loading: withOverrides({ loading: true }),
    errored: withOverrides({ errors: '[graphql-mocks] scenario error' }),
  };
}
