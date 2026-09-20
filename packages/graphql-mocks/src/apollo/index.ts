import { ApolloClient, ApolloLink, InMemoryCache, Observable } from '@apollo/client';
import { type ScenarioTarget, mockScenarios } from '../mockScenarios.js';
import type { MockHandlerOptions, MockRequestHandler } from '../requestHandler.js';
import type { BuildMocksOptions, MockResult, QaOption } from '../types.js';
import { toMockClientParameter } from './parameter.js';

/**
 * Wrap a mock graph (or an existing handler) in an `ApolloLink`, so an `ApolloClient` resolves
 * every operation from the graph with no per-operation registration:
 *
 * ```ts
 * const mocks = buildMocks(schema);
 * const client = new ApolloClient({ cache: new InMemoryCache(), link: mockLink(mocks) });
 * ```
 *
 * Pass a `MockResult` to build a handler with `options`, or a handler you already hold when you
 * need its `calls` / `reset()` surface:
 *
 * ```ts
 * const handler = mocks.toRequestHandler({ overrides: [{ match: 'Users', loading: true }] });
 * const link = mockLink(handler);
 * ```
 *
 * `ApolloLink` and `Observable` are both imported from `@apollo/client` itself, so this module
 * works on the majors that ship zen-observable and those that ship RxJS without caring which.
 */
export function mockLink(
  source: MockResult | MockRequestHandler,
  options: MockHandlerOptions = {},
): ApolloLink {
  const handler = typeof source === 'function' ? source : source.toRequestHandler(options);

  return new ApolloLink(
    (operation) =>
      new Observable((subscriber) => {
        let unsubscribed = false;
        handler({
          query: operation.query,
          variables: operation.variables,
          operationName: operation.operationName,
        }).then(
          (result) => {
            if (unsubscribed) return;
            // The handler's result is a plain GraphQL response; Apollo's own payload type
            // differs across majors, so widen through the subscriber rather than naming it.
            subscriber.next(result as Parameters<typeof subscriber.next>[0]);
            subscriber.complete();
          },
          (error: unknown) => {
            if (!unsubscribed) subscriber.error(error);
          },
        );
        // A cancelled operation must not push into a torn-down subscriber. There is no timer to
        // clear: a `loading` override never schedules one.
        return () => {
          unsubscribed = true;
        };
      }),
  );
}

/**
 * A function that builds a graph from build options — usually `(options) => buildMocks(schema,
 * { ...defaults, ...options })`. Passing one instead of a built graph is what lets a story
 * parameter ask for a different `qa` or `count` and get a graph built for it.
 */
export type MockGraphFactory = (options: BuildMocksOptions) => MockResult;

/** Anything `createMockClient` can draw operations from. */
export type MockClientSource = MockResult | MockRequestHandler | MockGraphFactory;

/** The client `createMockClient` returns, named without depending on Apollo's generic arity. */
export type MockApolloClient = InstanceType<typeof ApolloClient>;

/**
 * Apollo's own constructor options, read off the installed major rather than imported by name —
 * the option type has moved and changed shape between 3.x and 4.x.
 */
type ApolloClientArgs = ConstructorParameters<typeof ApolloClient>[0];

/**
 * A deep partial of Apollo's `defaultOptions`: every operation kind optional, and every key of
 * every kind optional. That is what {@link createMockClient}'s merge already does — it fills in
 * per kind and then per key — so naming one kind, or one key of one kind, is supported and
 * everything left out keeps this module's own default.
 *
 * Each kind is read off the matching client method rather than off Apollo's `defaultOptions`
 * type, for two reasons. Apollo 4 makes a kind *required* once an app declares required keys for
 * it, so a caller adding one `mutate` key would have to restate the `no-cache` /
 * `errorPolicy: 'all'` defaults below verbatim — restatements that then stop tracking the
 * defaults they copied. And Apollo 4 types `errorPolicy` on that same input as a sentence telling
 * you to declare it first, which makes the library's own documented default unwritable. The call
 * options carry the real types, and both majors have these three methods.
 */
export interface PartialDefaultOptions {
  watchQuery?: Partial<Omit<Parameters<MockApolloClient['watchQuery']>[0], 'query'>>;
  query?: Partial<Omit<Parameters<MockApolloClient['query']>[0], 'query'>>;
  mutate?: Partial<Omit<Parameters<MockApolloClient['mutate']>[0], 'mutation'>>;
}

export interface CreateMockClientOptions extends MockHandlerOptions {
  /** Replace the per-call `InMemoryCache`. Supplying one opts out of the isolation below. */
  cache?: ApolloClientArgs['cache'];
  /** Replace the link entirely — for chaining the mock link behind an auth or error link. */
  link?: ApolloLink;
  /** Merged over the defaults below, per operation kind and then per key, so one key is enough. */
  defaultOptions?: PartialDefaultOptions;
  /** Anything else the `ApolloClient` constructor takes; the three options above win over it. */
  clientOptions?: Partial<ApolloClientArgs>;
}

/**
 * `no-cache` because the point of a mock client is to see what the mocks return: a normalized
 * cache would answer the second story's query from the first story's rows, and an id collision
 * across two graphs would merge them. `errorPolicy: 'all'` because an error state is a state a
 * story wants to render, not a rejected promise nobody catches.
 */
const DEFAULT_CLIENT_DEFAULTS: PartialDefaultOptions = {
  watchQuery: { fetchPolicy: 'no-cache', errorPolicy: 'all' },
  query: { fetchPolicy: 'no-cache', errorPolicy: 'all' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeDefaultOptions(
  override: PartialDefaultOptions | undefined,
): ApolloClientArgs['defaultOptions'] {
  const merged: Record<string, unknown> = { ...DEFAULT_CLIENT_DEFAULTS };
  for (const [key, value] of Object.entries((override ?? {}) as Record<string, unknown>)) {
    const previous = merged[key];
    merged[key] = isRecord(previous) && isRecord(value) ? { ...previous, ...value } : value;
  }
  return merged as ApolloClientArgs['defaultOptions'];
}

/** A handler is a function too, so tell the two apart by the surface only a handler has. */
function isHandler(source: MockClientSource): source is MockRequestHandler {
  return typeof source === 'function' && 'calls' in source && 'reset' in source;
}

function isFactory(source: MockClientSource): source is MockGraphFactory {
  return typeof source === 'function' && !isHandler(source);
}

/**
 * A stable, order-independent key for a value, or `null` when the value contains something that
 * cannot be compared structurally (a function, a symbol, a cycle). `null` means "do not cache"
 * rather than "cache under a lossy key", because two overrides differing only in their predicate
 * must not share a graph.
 */
function stableKey(value: unknown, seen: Set<object> = new Set()): string | null {
  if (typeof value === 'function' || typeof value === 'symbol') return null;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? null;
  if (seen.has(value)) return null;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (const entry of value) {
        const part = stableKey(entry, seen);
        if (part === null) return null;
        parts.push(part);
      }
      return `[${parts.join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue;
      const part = stableKey(record[key], seen);
      if (part === null) return null;
      parts.push(`${JSON.stringify(key)}:${part}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Graphs built from a factory, keyed by the build config that produced them. Building a graph
 * is the expensive part of a story render, and a storybook re-renders the same story constantly;
 * without this, every keystroke in a control rebuilds every pool and reshuffles every row.
 *
 * Keyed by the factory itself (weakly, so an unmounted story file's graphs go with it), then by
 * the stringified config, so two states of the same story share one graph and a story that asks
 * for `qa: 'i18n'` gets its own.
 */
const graphCache = new WeakMap<MockGraphFactory, Map<string, MockResult>>();

function buildGraph(factory: MockGraphFactory, options: BuildMocksOptions): MockResult {
  const key = stableKey(options);
  if (key === null) return factory(options);
  let byConfig = graphCache.get(factory);
  if (!byConfig) {
    byConfig = new Map();
    graphCache.set(factory, byConfig);
  }
  const cached = byConfig.get(key);
  if (cached) return cached;
  const built = factory(options);
  byConfig.set(key, built);
  return built;
}

/**
 * Build an `ApolloClient` that answers every operation from a mock graph:
 *
 * ```ts
 * const client = createMockClient(buildMocks(schema));
 * render(<ApolloProvider client={client}>{story}</ApolloProvider>);
 * ```
 *
 * Handler options (`delay`, `overrides`, `memoize`, `matchArguments`, …) are passed through to
 * the link, so the common case needs no second call:
 *
 * ```ts
 * createMockClient(mocks, { delay: 300, matchArguments: true });
 * ```
 *
 * Each call gets its own `InMemoryCache` and `no-cache` fetch policies, so one story cannot
 * leak rows into the next. Pass `cache`, `link` or `defaultOptions` to override any of that.
 */
export function createMockClient(
  source: MockClientSource,
  options: CreateMockClientOptions = {},
): MockApolloClient {
  const { cache, link, defaultOptions, clientOptions, ...handlerOptions } = options;
  const graph = isFactory(source) ? buildGraph(source, {}) : source;
  return new ApolloClient({
    ...(clientOptions ?? {}),
    cache: cache ?? new InMemoryCache(),
    link: link ?? mockLink(graph, handlerOptions),
    defaultOptions: mergeDefaultOptions(defaultOptions),
  } as ApolloClientArgs);
}

/** The three states {@link mockScenarios} produces, as a story parameter would name them. */
export type MockClientState = 'default' | 'loading' | 'errored';

/** The long form of a story parameter: a state plus anything `createMockClient` accepts. */
export interface MockClientParameter extends CreateMockClientOptions {
  /** @default 'default' */
  state?: MockClientState;
  /** Narrow `loading` / `errored` to specific operations, leaving the rest resolving. */
  target?: ScenarioTarget;
  /** Rebuild the graph with these options. Needs a {@link MockGraphFactory} source. */
  build?: BuildMocksOptions;
  /** Shorthand for `build: { qa }`. Needs a {@link MockGraphFactory} source. */
  qa?: QaOption;
}

/** What a story may set the parameter to. `false` means "no mock client for this story". */
export type MockClientOption = boolean | MockClientState | MockClientParameter;

export { toMockClientParameter, withQa, withState } from './parameter.js';

function graphFor(source: MockClientSource, parameter: MockClientParameter): MockClientSource {
  const wantsBuild = parameter.build !== undefined || parameter.qa !== undefined;
  if (!isFactory(source)) {
    if (wantsBuild) {
      console.warn(
        '[graphql-mocks] apollo: "build" and "qa" need a graph factory — pass (options) => buildMocks(schema, options) instead of an already-built graph. Ignoring them.',
      );
    }
    return source;
  }
  const build = { ...parameter.build };
  if (parameter.qa !== undefined) build.qa = parameter.qa;
  return buildGraph(source, build);
}

/**
 * Turn a story parameter into a client. `true` (or an absent parameter) is the default state;
 * a string picks one of {@link mockScenarios}' three; an object carries the rest.
 *
 * ```ts
 * resolveMockClient(factory, 'loading');
 * resolveMockClient(factory, { state: 'errored', target: 'Users', qa: 'i18n' });
 * ```
 *
 * `base` is the decorator-level configuration the parameter is layered over: plain options are
 * replaced key by key, and `overrides` concatenate with the story's first, since first match
 * wins and the story is the more specific of the two.
 */
export function resolveMockClient(
  source: MockClientSource,
  parameter: MockClientOption = true,
  base: CreateMockClientOptions = {},
): MockApolloClient {
  const {
    state = 'default',
    target,
    build: _build,
    qa: _qa,
    ...options
  } = toMockClientParameter(parameter);
  const { cache, link, defaultOptions, clientOptions, ...handler } = { ...base, ...options };
  const scenario = mockScenarios(
    { ...handler, overrides: [...(options.overrides ?? []), ...(base.overrides ?? [])] },
    target,
  )[state];
  return createMockClient(graphFor(source, toMockClientParameter(parameter)), {
    ...scenario,
    cache,
    link,
    defaultOptions,
    clientOptions,
  });
}

/** The pieces of a decorator's contract this module touches — no Storybook import needed. */
export type StoryFnLike = (context?: unknown) => unknown;

export interface StoryContextLike {
  /** Storybook's id for the story being rendered — stable across that story's re-renders. */
  id?: string;
  /** The stories file's title, as {@link GraphqlMocksDecoratorOptions.clientKey} tends to use. */
  title?: string;
  parameters?: Record<string, unknown>;
}

export interface GraphqlMocksDecoratorOptions extends CreateMockClientOptions {
  /**
   * Render the story with the client in scope. Renderer-specific, so it is yours to supply —
   * this module stays free of React:
   *
   * ```ts
   * wrap: (client, Story) => <ApolloProvider client={client}><Story /></ApolloProvider>
   * ```
   */
  wrap: (client: MockApolloClient, story: StoryFnLike, context: StoryContextLike) => unknown;
  /** Story parameter to read. @default 'graphqlMocks' */
  parameterName?: string;
  /**
   * What the client memo is scoped to. Each story gets its own client — and so its own cache —
   * by default; return the same key from several stories to hand them one shared client on
   * purpose, which is the only way one story's writes reach the next:
   *
   * ```ts
   * clientKey: (context) => context.title  // one client per stories file
   * ```
   *
   * Returning `undefined` falls back to the story's own id.
   */
  clientKey?: (context: StoryContextLike) => string | undefined;
}

/**
 * A Storybook decorator that resolves the `graphqlMocks` story parameter into a client:
 *
 * ```ts
 * // .storybook/preview.tsx
 * export const decorators = [
 *   withGraphqlMocks((options) => buildMocks(schema, { count: 8, ...options }), {
 *     wrap: (client, Story) => (
 *       <ApolloProvider client={client}><Story /></ApolloProvider>
 *     ),
 *   }),
 * ];
 *
 * // a story
 * export const Loading = { parameters: { graphqlMocks: 'loading' } };
 * export const Empty = { parameters: { graphqlMocks: { build: { count: 0 } } } };
 * export const NoMocks = { parameters: { graphqlMocks: false } };
 * ```
 *
 * A story with no parameter still gets the default client, since a global decorator is added to
 * mock everything; `false` opts a single story back out.
 *
 * Clients are memoized per story and resolved parameter, so a re-render reuses the client it
 * already has instead of remounting into a fresh cache and refetching on every keystroke, while
 * two stories never answer from each other's rows. `clientKey` opts a set of stories into
 * sharing one client deliberately.
 */
export function withGraphqlMocks(
  source: MockClientSource,
  options: GraphqlMocksDecoratorOptions,
): (story: StoryFnLike, context?: StoryContextLike) => unknown {
  const { wrap, parameterName = 'graphqlMocks', clientKey, ...base } = options;
  // One entry per story rendered, rather than per parameter: a docs page renders a whole stories
  // file at once, so evicting the story that is no longer current would thrash that page.
  const clients = new Map<string, MockApolloClient>();

  return (story, context = {}) => {
    const parameter = context.parameters?.[parameterName] as MockClientOption | undefined;
    if (parameter === false) return story(context);

    // Scoping the memo to the story is what keeps one story's mutation — or its paged, filtered
    // list — out of the next story's cache: `stableKey(true)` is one string for every story that
    // takes the default parameter, so a parameter-only key made the result of a story depend on
    // which stories rendered before it.
    const scope = clientKey?.(context) ?? context.id ?? '';
    const parameterKey = stableKey(parameter ?? true);
    // Quoted so a caller-supplied scope containing the separator cannot collide with another
    // scope-and-parameter pair.
    const key = parameterKey === null ? null : `${JSON.stringify(scope)}:${parameterKey}`;
    const cached = key === null ? undefined : clients.get(key);
    const client = cached ?? resolveMockClient(source, parameter, base);
    if (key !== null && cached === undefined) clients.set(key, client);
    return wrap(client, story, context);
  };
}

export type { ScenarioTarget } from '../mockScenarios.js';

export type { MockHandlerOptions, MockRequestHandler } from '../requestHandler.js';
