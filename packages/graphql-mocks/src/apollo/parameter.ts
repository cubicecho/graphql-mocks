import type { QaOption } from '../types.js';
import type { MockClientOption, MockClientParameter, MockClientState } from './index.js';

// The parameter types live in ./index.ts beside the options they extend; importing them back here
// is type-only, so nothing of this module's runtime depends on that module loading first.

/**
 * The long form of any story parameter, so a helper can layer onto it instead of branching on
 * which form it was handed:
 *
 * ```ts
 * toMockClientParameter('loading');            // { state: 'loading' }
 * toMockClientParameter(true);                 // { state: 'default' }
 * toMockClientParameter({ target: 'Users' });  // { target: 'Users' }
 * ```
 *
 * This is the same reading {@link resolveMockClient} gives a parameter, so a derived parameter
 * resolves to the client the original would have: an absent parameter and `true` are the default
 * state, a string is that state, and a long form is copied through untouched — an object is
 * returned as a shallow copy rather than as itself, so layering never mutates the base.
 *
 * `false` means "no client for this story" and has no long form; it reads as the default state
 * here, which is what `resolveMockClient` has always done with it. To derive from a parameter
 * that may be `false`, use {@link withState} or {@link withQa}, which preserve it.
 */
export function toMockClientParameter(
  parameter: MockClientOption | undefined,
): MockClientParameter {
  if (parameter === undefined || typeof parameter === 'boolean') return { state: 'default' };
  if (typeof parameter === 'string') return { state: parameter };
  return { ...parameter };
}

/**
 * The same parameter in another state, keeping everything else it carried:
 *
 * ```ts
 * const base = { overrides: [orderFixture], target: 'OrderById' };
 * export const Loading = { parameters: { graphqlMocks: withState(base, 'loading') } };
 * ```
 *
 * Writing that as `'loading'` — the obvious first version, since the short forms are what the
 * docs show — drops the base's `overrides`, `target` and `build` silently: the story still
 * renders, just not the data the rest of the set is built on.
 *
 * `false` is returned as `false`: a story that opted out of mocking has no state to be in.
 */
export function withState(parameter: false, state: MockClientState): false;
export function withState(
  parameter: Exclude<MockClientOption, false> | undefined,
  state: MockClientState,
): MockClientParameter;
export function withState(
  parameter: MockClientOption | undefined,
  state: MockClientState,
): MockClientOption;
export function withState(
  parameter: MockClientOption | undefined,
  state: MockClientState,
): MockClientOption {
  if (parameter === false) return false;
  return { ...toMockClientParameter(parameter), state };
}

/**
 * The same parameter built with a QA preset, keeping everything else it carried:
 *
 * ```ts
 * export const LongText = { parameters: { graphqlMocks: withQa(base, 'longText') } };
 * ```
 *
 * `qa` is the shorthand for `build: { qa }`, so a base that also sets `build` keeps its other
 * build options. Like every `build` option it needs a {@link MockGraphFactory} source.
 *
 * `false` is returned as `false`, for the same reason as in {@link withState}.
 */
export function withQa(parameter: false, qa: QaOption): false;
export function withQa(
  parameter: Exclude<MockClientOption, false> | undefined,
  qa: QaOption,
): MockClientParameter;
export function withQa(parameter: MockClientOption | undefined, qa: QaOption): MockClientOption;
export function withQa(parameter: MockClientOption | undefined, qa: QaOption): MockClientOption {
  if (parameter === false) return false;
  return { ...toMockClientParameter(parameter), qa };
}
