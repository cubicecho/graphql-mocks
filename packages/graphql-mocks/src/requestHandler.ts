import type { Faker } from '@faker-js/faker';
import {
  type DocumentNode,
  type GraphQLFormattedError,
  type GraphQLSchema,
  getOperationAST,
  print,
} from 'graphql';
import type { ArgMatchingOptions } from './argMatching.js';
import { resolveOperationResult } from './executeOperation.js';
import type { BuildMocksOptions } from './types.js';

/** What the handler was asked for — the spy record and the input to every override matcher. */
export interface MockOperationInfo {
  /** The document's operation name, or null for an anonymous operation. */
  operationName: string | null;
  operationType: 'query' | 'mutation' | 'subscription';
  variables: Record<string, unknown>;
  document: DocumentNode;
}

/**
 * A GraphQL request. Structurally compatible with Apollo's `Operation`, so an Apollo link can
 * hand one straight over without this package importing any Apollo type.
 */
export interface MockRequest<TVars = Record<string, unknown>> {
  query: DocumentNode;
  variables?: TVars;
  operationName?: string | null;
}

/** A GraphQL response: data, errors, or both. */
export interface MockExecutionResult<TData = unknown> {
  data?: TData | null;
  errors?: readonly GraphQLFormattedError[];
}

/**
 * Selects which operations an override applies to: an operation name, a `DocumentNode`
 * (compared by identity), or a predicate. Omit it to match every operation.
 */
export type MockOverrideMatcher = string | DocumentNode | ((info: MockOperationInfo) => boolean);

/** An error to return, as a message or a formatted GraphQL error. */
export type MockErrorInput = string | GraphQLFormattedError;

export interface MockOverride<TData extends Record<string, unknown> = Record<string, unknown>> {
  /** Which operations this entry answers. Omit to match every operation. */
  match?: MockOverrideMatcher;
  /**
   * Replacement data: a value, or a function receiving the operation and the data the graph
   * resolved for it (so an override can patch rather than replace).
   *
   * `TData` defaults to a plain object rather than `unknown` because `unknown` would absorb
   * the function arm of the union, leaving a `data` callback's parameters implicitly `any`.
   */
  data?: TData | ((info: MockOperationInfo, graphData: unknown) => TData);
  /** Resolve with GraphQL errors — `{ data: null, errors }`, the GraphQL error path. */
  errors?: MockErrorInput | readonly MockErrorInput[];
  /** Reject with a network error — the transport error path, distinct from `errors`. */
  networkError?: Error | string;
  /** Never settle, so the operation stays loading. Schedules no timer. */
  loading?: boolean;
  /** Delay for this operation only, overriding the handler-wide `delay`. */
  delay?: number | { min: number; max: number };
  /** Apply at most once, then fall through to the next match. Cleared by `reset()`. */
  once?: boolean;
}

export interface MockHandlerOptions {
  /** Delay before every result settles, as a fixed value or a random range. */
  delay?: number | { min: number; max: number };
  /** Ordered overrides; the first whose `match` accepts the operation wins. */
  overrides?: readonly MockOverride[];
  /**
   * Cache the result per document + variables, so two identical queries in one render tree —
   * or a refetch — get the same rows instead of a fresh random draw.
   * @default true
   */
  memoize?: boolean;
  /** Called for every operation before it resolves. */
  onOperation?: (info: MockOperationInfo) => void;
  /**
   * What to do when execution against the graph produces GraphQL errors. The errors are always
   * returned on the result; this only controls the diagnostic.
   * @default 'warn'
   */
  onExecutionError?: 'warn' | 'silent' | 'throw';
  /** Per-handler override of `BuildMocksOptions.matchArguments`. */
  matchArguments?: boolean | ArgMatchingOptions;
}

/**
 * Answers any operation from the mock graph. Callable as a function, with a `calls` spy list
 * and a `reset()` that clears the memo, the calls, and any consumed `once` overrides.
 */
export interface MockRequestHandler {
  <TData = unknown>(request: MockRequest): Promise<MockExecutionResult<TData>>;
  readonly calls: readonly MockOperationInfo[];
  reset(): void;
}

/** Everything the handler needs from the graph it was built from. */
export interface RequestHandlerDeps {
  schema: GraphQLSchema;
  pool: Record<string, Record<string, unknown>[]>;
  faker: Faker;
  options: BuildMocksOptions;
}

/** A promise that never settles, and — unlike a very long delay — schedules no timer. */
const neverSettles = <T>(): Promise<T> => new Promise<T>(() => {});

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function delayMs(delay: number | { min: number; max: number } | undefined, faker: Faker): number {
  if (delay === undefined) return 0;
  return typeof delay === 'number' ? delay : faker.number.int(delay);
}

function toFormattedErrors(
  input: MockErrorInput | readonly MockErrorInput[],
): readonly GraphQLFormattedError[] {
  const list = Array.isArray(input) ? input : [input as MockErrorInput];
  return list.map((entry) => (typeof entry === 'string' ? { message: entry } : entry));
}

/** Stable stringify so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce the same memo key. */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(',')}}`;
}

function matches(match: MockOverrideMatcher | undefined, info: MockOperationInfo): boolean {
  if (match === undefined) return true;
  if (typeof match === 'string') return match === info.operationName;
  if (typeof match === 'function') return match(info);
  return match === info.document;
}

/**
 * Build a handler that answers any operation from the graph, with no per-operation
 * registration. Used directly in tests, and wrapped by the `./apollo` link export.
 */
export function createRequestHandler(
  deps: RequestHandlerDeps,
  options: MockHandlerOptions = {},
): MockRequestHandler {
  const memoize = options.memoize ?? true;
  const onExecutionError = options.onExecutionError ?? 'warn';
  const overrides = options.overrides ?? [];

  const memo = new Map<string, MockExecutionResult>();
  const consumed = new Set<number>();
  const calls: MockOperationInfo[] = [];
  let warnedAboutSubscriptions = false;

  const execute = (info: MockOperationInfo): MockExecutionResult => {
    const { data, errors } = resolveOperationResult(
      deps.schema,
      deps.pool,
      deps.faker,
      deps.options,
      info.document,
      info.variables,
      options.matchArguments,
    );
    if (errors?.length) {
      const message = `[graphql-mocks] ${info.operationName ?? 'anonymous'}: ${errors
        .map((e) => e.message)
        .join('; ')}`;
      if (onExecutionError === 'throw') throw new Error(message);
      if (onExecutionError === 'warn') console.warn(message);
      return { data, errors };
    }
    return { data };
  };

  const handler = (<TData>(request: MockRequest): Promise<MockExecutionResult<TData>> => {
    const document = request.query;
    const operationName = request.operationName ?? null;
    const operation = getOperationAST(document, operationName);
    const variables = (request.variables ?? {}) as Record<string, unknown>;

    if (!operation) {
      return Promise.resolve({
        data: null,
        errors: [{ message: '[graphql-mocks] request contains no executable operation' }],
      });
    }

    const info: MockOperationInfo = {
      operationName: operation.name?.value ?? operationName,
      operationType: operation.operation,
      variables,
      document,
    };
    calls.push(info);
    options.onOperation?.(info);

    if (info.operationType === 'subscription' && !warnedAboutSubscriptions) {
      warnedAboutSubscriptions = true;
      console.warn(
        '[graphql-mocks] subscriptions resolve a single payload and complete; streams are not mocked',
      );
    }

    let override: MockOverride | undefined;
    for (const [index, candidate] of overrides.entries()) {
      if (consumed.has(index) || !matches(candidate.match, info)) continue;
      override = candidate;
      if (candidate.once) consumed.add(index);
      break;
    }

    if (override?.loading) return neverSettles();

    const wait = sleep(delayMs(override?.delay ?? options.delay, deps.faker));

    if (override?.networkError !== undefined) {
      const error =
        typeof override.networkError === 'string'
          ? new Error(override.networkError)
          : override.networkError;
      return wait.then(() => Promise.reject(error));
    }

    if (override?.errors !== undefined) {
      const errors = toFormattedErrors(override.errors);
      return wait.then(() => ({ data: null, errors }) as MockExecutionResult<TData>);
    }

    const key = memoize ? `${print(document)}|${stableKey(variables)}` : undefined;
    const cached = key !== undefined ? memo.get(key) : undefined;
    // Resolve eagerly so an `onExecutionError: 'throw'` surfaces synchronously, matching
    // `dataForOperation`, rather than turning into an unhandled rejection.
    let result: MockExecutionResult;
    if (cached !== undefined) {
      result = cached;
    } else {
      result = override?.data === undefined ? execute(info) : applyDataOverride(override, info);
      if (key !== undefined) memo.set(key, result);
    }

    return wait.then(() => result as MockExecutionResult<TData>);
  }) as MockRequestHandler;

  function applyDataOverride(entry: MockOverride, info: MockOperationInfo): MockExecutionResult {
    if (typeof entry.data !== 'function') return { data: entry.data };
    // Only execute against the graph when the override actually wants the resolved data.
    const resolve = entry.data as (info: MockOperationInfo, graphData: unknown) => unknown;
    return { data: resolve(info, execute(info).data) };
  }

  Object.defineProperty(handler, 'calls', { get: () => calls as readonly MockOperationInfo[] });
  handler.reset = () => {
    memo.clear();
    consumed.clear();
    calls.length = 0;
  };

  return handler;
}
