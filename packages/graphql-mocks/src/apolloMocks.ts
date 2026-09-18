import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { type DocumentNode, Kind } from 'graphql';
import type { ArgMatchingOptions } from './argMatching.js';
import { warnOnEnvelopeData } from './validateMocks.js';

/**
 * Reduce `options.variables` to concrete variables for pool-based data resolution: a matcher
 * function decides which mock *matches*, but it can't drive which mocks are *selected*, so it
 * resolves to `undefined` (required variables are auto-filled during execution).
 */
export function variablesForData<TVars>(
  variables: TVars | VariableMatcher<TVars> | undefined,
): TVars | undefined {
  return typeof variables === 'function' ? undefined : variables;
}

/**
 * Predicate form of `request.variables` — Apollo invokes it with the incoming
 * variables and uses the boolean to decide whether the mock matches.
 */
export type VariableMatcher<TVars> = (variables: TVars) => boolean;

/**
 * A single entry in Apollo's `MockedProvider` `mocks` array (Apollo Client v4's
 * `MockLink.MockedResponse`), reproduced structurally so this package keeps a
 * type-only relationship to `@apollo/client` — there is no runtime dependency on
 * Apollo. The returned objects are assignable straight into `mocks={[...]}`.
 */
export interface MockedResponse<TData = unknown, TVars = unknown> {
  request: {
    query: DocumentNode;
    variables?: TVars | VariableMatcher<TVars>;
  };
  result?: { data?: TData };
  error?: Error;
  delay?: number;
  maxUsageCount?: number;
}

/**
 * Like {@link MockedResponse}, but `result` is a function of the incoming variables — Apollo
 * calls it per request, so one mock can answer many variable combinations. Kept as a sibling
 * type instead of widening `MockedResponse['result']` to a union, because a union would break
 * every existing `mock.result?.data` read.
 */
export interface DynamicMockedResponse<TData = unknown, TVars = unknown> {
  request: {
    query: DocumentNode;
    variables?: TVars | VariableMatcher<TVars>;
  };
  result?: (variables: TVars) => { data?: TData };
  error?: Error;
  delay?: number;
  maxUsageCount?: number;
}

/** Either response shape — useful when a value's staticness isn't known at the type level. */
export type AnyMockedResponse<TData = unknown, TVars = unknown> =
  | MockedResponse<TData, TVars>
  | DynamicMockedResponse<TData, TVars>;

/** The `data` argument of {@link mockOperation}: a value, or a function of the variables. */
export type MockOperationData<TData, TVars> = TData | ((variables: TVars) => TData);

export interface MockOperationOptions<TVars = unknown, TData = unknown> {
  /**
   * Variables to match: concrete variables for an exact match, or a predicate.
   * Defaults to a predicate that matches any variables, so a mock satisfies the
   * operation regardless of the variables it is called with.
   */
  variables?: TVars | VariableMatcher<TVars>;
  /** Artificial delay in milliseconds before the result resolves. */
  delay?: number;
  /** Resolve with this error instead of data. */
  error?: Error;
  /**
   * How many times the mock may be matched before Apollo warns on an extra use.
   * Defaults to `Infinity` so one mock covers any number of renders/refetches.
   */
  maxUsageCount?: number;
  /**
   * Graph-bound forms only (`mocks.mockOperation` / `mocks.mockOperationVariants`).
   * Resolve the data per request from the incoming variables instead of once up front, which
   * lets a single mock answer many variable combinations — pair it with `matchArguments` so
   * the variables actually select the data.
   *
   * Off by default: flipping `result` to a function would break `mock.result?.data` reads.
   * @default false
   */
  dynamic?: boolean;
  /**
   * Graph-bound forms only. Post-process the resolved data before it becomes the result —
   * for slicing, filtering or patching a field the generator can't know about.
   */
  transform?: (data: TData, variables: TVars) => TData;
  /**
   * Graph-bound forms only. Per-call override of `BuildMocksOptions.matchArguments`, so one
   * operation can honor its arguments without turning matching on for the whole graph.
   */
  matchArguments?: boolean | ArgMatchingOptions;
}

/** Delay (ms) used by the `withLongLoadTime` variant to keep a query pending. */
const LONG_LOAD_DELAY_MS = 1_000_000;

/** Default `request.variables` matcher: accept whatever variables the query is called with. */
const matchAnyVariables: VariableMatcher<unknown> = () => true;

/** Pull the operation name out of a document for diagnostics; undefined if anonymous. */
function operationName(document: DocumentNode): string | undefined {
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION && definition.name) {
      return definition.name.value;
    }
  }
  return undefined;
}

/**
 * Build a single Apollo `MockedProvider` mock for a query or mutation.
 *
 * @param operation - A `TypedDocumentNode` (query or mutation) — the result/variables
 * types are inferred from it, so `data` is checked against the operation's result type.
 * @param data - The mocked result data returned for the operation.
 * @param options - Optional `variables`/`delay`/`error`/`maxUsageCount` overrides.
 *
 * ```ts
 * import { MockedProvider } from '@apollo/client/testing';
 * import { mockOperation } from '@vantreeseba/graphql-mocks';
 *
 * const mocks = [mockOperation(AwardByIdQuery, { award: mockAwards[0], __typename: 'Query' })];
 * <MockedProvider mocks={mocks}>…</MockedProvider>
 * ```
 */
export function mockOperation<TData, TVars>(
  operation: TypedDocumentNode<TData, TVars>,
  data: TData,
  options?: MockOperationOptions<TVars, TData>,
): MockedResponse<TData, TVars>;
export function mockOperation<TData, TVars>(
  operation: TypedDocumentNode<TData, TVars>,
  data: (variables: TVars) => TData,
  options?: MockOperationOptions<TVars, TData>,
): DynamicMockedResponse<TData, TVars>;
export function mockOperation<TData, TVars>(
  operation: TypedDocumentNode<TData, TVars>,
  data: MockOperationData<TData, TVars>,
  options: MockOperationOptions<TVars, TData> = {},
): AnyMockedResponse<TData, TVars> {
  warnOnEnvelopeData(data, 'mockOperation', operationName(operation));
  const envelope = {
    request: {
      query: operation,
      variables: options.variables ?? (matchAnyVariables as VariableMatcher<TVars>),
    },
    error: options.error,
    delay: options.delay,
    maxUsageCount: options.maxUsageCount ?? Number.POSITIVE_INFINITY,
  };
  // Discriminate at runtime, not on the declared type: the static overload is listed first so a
  // plain data object never selects the dynamic signature.
  if (typeof data === 'function') {
    const resolve = data as (variables: TVars) => TData;
    return { ...envelope, result: (variables: TVars) => ({ data: resolve(variables) }) };
  }
  return { ...envelope, result: { data } };
}

export interface MockOperationVariants<TData, TVars, TResponse = MockedResponse<TData, TVars>> {
  /** Resolves immediately with `data`. */
  withResults: TResponse;
  /** Stays pending (very long delay) — drive loading states. */
  withLongLoadTime: TResponse;
  /** Rejects with an error — drive error states. */
  withError: TResponse;
}

/** The trio in its resolver-function form, produced when `data` is a function. */
export type DynamicMockOperationVariants<TData, TVars> = MockOperationVariants<
  TData,
  TVars,
  DynamicMockedResponse<TData, TVars>
>;

/**
 * Build the common trio of mocks for one operation: a success, a perpetually-loading,
 * and an error variant. Mirrors the typical hand-rolled `MockQueries` helper so a test
 * can pick the state it needs:
 *
 * ```ts
 * const m = mockOperationVariants(AwardByIdQuery, awardData);
 * // <MockedProvider mocks={[m.withResults]} /> | m.withLongLoadTime | m.withError
 * ```
 *
 * `withError` uses `options.error` when provided, otherwise a generated error naming the
 * operation. The same applies to queries and mutations.
 */
export function mockOperationVariants<TData, TVars>(
  operation: TypedDocumentNode<TData, TVars>,
  data: TData,
  options?: MockOperationOptions<TVars, TData>,
): MockOperationVariants<TData, TVars>;
export function mockOperationVariants<TData, TVars>(
  operation: TypedDocumentNode<TData, TVars>,
  data: (variables: TVars) => TData,
  options?: MockOperationOptions<TVars, TData>,
): DynamicMockOperationVariants<TData, TVars>;
export function mockOperationVariants<TData, TVars>(
  operation: TypedDocumentNode<TData, TVars>,
  data: MockOperationData<TData, TVars>,
  options: MockOperationOptions<TVars, TData> = {},
): MockOperationVariants<TData, TVars, AnyMockedResponse<TData, TVars>> {
  const build = (extra: MockOperationOptions<TVars, TData>) =>
    (
      mockOperation as (
        operation: TypedDocumentNode<TData, TVars>,
        data: MockOperationData<TData, TVars>,
        options?: MockOperationOptions<TVars, TData>,
      ) => AnyMockedResponse<TData, TVars>
    )(operation, data, { ...options, ...extra });

  return {
    withResults: build({}),
    withLongLoadTime: build({ delay: LONG_LOAD_DELAY_MS }),
    withError: build({
      error:
        options.error ??
        new Error(
          `[graphql-mocks] mock error for operation "${operationName(operation) ?? 'anonymous'}"`,
        ),
    }),
  };
}

/**
 * The data inside a mock envelope, non-optionally.
 *
 * `MockedResponse` types `result` and `result.data` as optional, because the error and loading
 * variants exist — so reading the rows back out of a mock means
 * `mock.result?.data?.searchPosts?.results ?? []`, a chain whose fallback turns a renamed field
 * into "empty" rather than a type error. And `dataForOperation` is no substitute: it re-resolves
 * against the pool on every call, so it does not return the rows *this mock* will hand Apollo.
 *
 * ```ts
 * const mocks = mockOperationVariants(PostsQuery, data);
 * const posts = dataOf(mocks.withResults).searchPosts.results;  // typed, no `?.`, no `?? []`
 * ```
 *
 * Throws when there is no data to return — the `withError` variant, or an envelope assembled
 * without a `result`. `withLongLoadTime` carries the same data as `withResults` (only a long
 * delay separates them), so it returns rather than throws.
 *
 * For the resolver form — `mockOperationVariants(Doc, (variables) => data)` — pass the
 * variables to resolve with; they default to `{}`, which is what a resolver ignoring its
 * argument would see anyway.
 */
export function dataOf<TData, TVars>(
  mock: AnyMockedResponse<TData, TVars>,
  variables?: TVars,
): TData {
  const site = `"${operationName(mock.request.query) ?? 'anonymous'}"`;
  if (mock.error) {
    throw new TypeError(
      `[graphql-mocks] dataOf: the mock for ${site} is an error variant (${mock.error.message}), so it has no data`,
    );
  }
  if (mock.result === undefined) {
    throw new TypeError(
      `[graphql-mocks] dataOf: the mock for ${site} has no result — only an error or a hand-assembled envelope should be missing one`,
    );
  }

  const resolved =
    typeof mock.result === 'function' ? mock.result(variables ?? ({} as TVars)) : mock.result;
  if (resolved.data === undefined) {
    throw new TypeError(
      `[graphql-mocks] dataOf: the mock for ${site} resolved to a result with no data`,
    );
  }
  return resolved.data;
}
