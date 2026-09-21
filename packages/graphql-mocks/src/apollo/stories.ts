import type { MockClientOption, MockClientState } from './index.js';
import { toMockClientParameter, withQa, withState } from './parameter.js';

// Like ./parameter.ts, this module names the parameter types from ./index.ts type-only, so the
// factory never pulls @apollo/client in behind it — a stories file imports it at module scope.

/**
 * A story object as this factory writes one: nothing but the parameter bag the decorator reads.
 *
 * It is deliberately not Storybook's `StoryObj`. The `Story` type in a stories file is derived
 * from that file's own `meta`, so it cannot come from here, and adding a Storybook dependency to
 * a mocking library would tie it to a major that churns. Assignment does the checking instead:
 * Storybook types `parameters` as an open bag, so `export const Default: Story = stories.Default`
 * is an ordinary structural assignment. A `Story` that requires `args` — a component whose meta
 * doesn't set them — takes them the way it always would: `{ ...stories.Default, args }`.
 */
export interface GraphStory {
  parameters: Record<string, MockClientOption>;
}

/** The three states every set has. */
export interface GraphStorySet {
  /** The graph as the base describes it. */
  Default: GraphStory;
  /** Every matched operation stays pending. */
  Loading: GraphStory;
  /** Every matched operation answers with a GraphQL error. */
  Errored: GraphStory;
}

/** {@link GraphStorySet} plus the two QA shapes a list screen is worth checking against. */
export interface GraphListStorySet extends GraphStorySet {
  /** Built with `qa: 'emptyLists'`, so every list comes back empty. */
  NoResults: GraphStory;
  /** Built with `qa: 'longText'`, so every string is long enough to break a layout. */
  LongNames: GraphStory;
}

export interface GraphStoriesOptions {
  /**
   * The parameter every story in the set is layered on — the set's fixture, target, delay and
   * handler options. Each member then names exactly one thing: its state, or its QA shape.
   *
   * `false` ("no mock client for this story") is not accepted: a set of stories that all opted
   * out of mocking is five aliases of each other, which is the failure this factory exists to
   * make unrepresentable.
   */
  graph?: Exclude<MockClientOption, false>;
  /** The decorator's `parameterName`, if it was renamed there. @default 'graphqlMocks' */
  parameterName?: string;
}

/**
 * The QA members are dropped from the type when the options carry an override that answers with
 * its own rows — see {@link graphListStories}. Expressed as a conditional rather than as two
 * overloads so the reason shows up at the call site: `stories.NoResults` fails to compile with
 * "Property 'NoResults' does not exist", instead of resolving to a story that lies.
 *
 * `Extract` is asked for `data` as a *required* property, which is exactly the question the
 * runtime asks: an entry that only sets `errors` or `delay` leaves the graph answering, and an
 * `overrides` array whose element type has `data` optional — a base annotated
 * `MockClientParameter` rather than written inline — cannot be decided here at all, so it keeps
 * the members and lets the runtime check settle it.
 */
export type GraphListStoriesResult<TOptions extends GraphStoriesOptions> = TOptions extends {
  graph: { overrides: readonly (infer TOverride)[] };
}
  ? [Extract<TOverride, { data: unknown }>] extends [never]
    ? GraphListStorySet
    : GraphStorySet
  : GraphListStorySet;

function story(
  parameterName: string,
  base: Exclude<MockClientOption, false> | undefined,
  state: MockClientState,
  qa?: 'emptyLists' | 'longText',
): GraphStory {
  // Every member is pinned to its own state, even the QA ones: a base carrying `state:
  // 'loading'` would otherwise hand `NoResults` a story that never resolves, so "no results"
  // and "still loading" would render the same empty screen.
  const stated = withState(base, state);
  return { parameters: { [parameterName]: qa === undefined ? stated : withQa(stated, qa) } };
}

/**
 * The `Default` / `Loading` / `Errored` family every consumer of {@link withGraphqlMocks} writes
 * by hand, built from one base parameter:
 *
 * ```ts
 * const stories = graphStories({ graph: { overrides: [orderFixture] } });
 *
 * export const Default: Story = stories.Default;
 * export const Loading: Story = stories.Loading;
 * export const Errored: Story = stories.Errored;
 * ```
 *
 * `graph` is what makes this more than a snippet: the fixture, `target`, `delay` and handler
 * options survive into every member, which re-stating `'loading'` by hand would silently drop.
 *
 * For a list screen, {@link graphListStories} adds the two QA members.
 */
export function graphStories(options: GraphStoriesOptions = {}): GraphStorySet {
  const { graph, parameterName = 'graphqlMocks' } = options;
  return {
    Default: story(parameterName, graph, 'default'),
    Loading: story(parameterName, graph, 'loading'),
    Errored: story(parameterName, graph, 'errored'),
  };
}

/** Does the base answer any operation with rows of its own, ahead of the graph? */
function hasRowOverride(graph: Exclude<MockClientOption, false> | undefined): boolean {
  return (toMockClientParameter(graph).overrides ?? []).some(
    (override) => override.data !== undefined,
  );
}

/**
 * {@link graphStories} plus the two QA members a list screen wants — `NoResults` built with
 * `qa: 'emptyLists'` and `LongNames` with `qa: 'longText'`:
 *
 * ```ts
 * const stories = graphListStories();
 *
 * export const NoResults: Story = stories.NoResults;
 * export const LongNames: Story = stories.LongNames;
 * ```
 *
 * **The QA members are omitted when the base supplies rows of its own.** An `overrides` entry
 * with `data` answers ahead of the graph, so rebuilding the graph with `emptyLists` would not
 * empty anything: `NoResults` would render the fixture's rows and pass every review, which is
 * the stale story this factory exists to prevent. A set built on such a base therefore comes
 * back as a plain {@link GraphStorySet}, and `stories.NoResults` does not compile.
 *
 * Type and runtime ask the same question, and agree wherever the options are written inline: an
 * override that only sets `errors` or `delay` keeps the QA members. They can part only over a
 * base whose type has been widened (`const base: MockClientParameter = …`), where `data` is
 * merely optional and no type can tell — the members stay in the type and the runtime omits
 * them, so the omission also warns.
 *
 * To check an empty list against a set built on a fixture, point the fixture's own override at
 * the empty case — `withQa` on a base with the list override removed is the honest version.
 * Overrides configured on the decorator itself are invisible here and mask the QA shape the
 * same way.
 */
export function graphListStories<TOptions extends GraphStoriesOptions = GraphStoriesOptions>(
  options?: TOptions,
): GraphListStoriesResult<TOptions> {
  const { graph, parameterName = 'graphqlMocks' } = options ?? {};
  const set = graphStories(options ?? {});
  if (hasRowOverride(graph)) {
    console.warn(
      '[graphql-mocks] apollo: graphListStories omitted NoResults and LongNames — an "overrides" entry with "data" answers ahead of the graph, so a QA build would not change what renders.',
    );
    // The cast carries the conditional return type, which no implementation can prove: the
    // branch is chosen by a value and reported by a type. Both branches are real members of the
    // union, so nothing here is widened beyond what the signature already promises.
    return set as GraphListStoriesResult<TOptions>;
  }
  return {
    ...set,
    NoResults: story(parameterName, graph, 'default', 'emptyLists'),
    LongNames: story(parameterName, graph, 'default', 'longText'),
  } as GraphListStoriesResult<TOptions>;
}
