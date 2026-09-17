import { type DocumentNode, Kind } from 'graphql';

/**
 * Apollo's `MockLink` invokes `result` only when **`result` itself** is a function. A function
 * one level down, at `result.data`, is never called: the mock matches, the link resolves, and
 * the cache is handed a function where the data should be. The component renders nothing, with
 * no error and no warning.
 *
 * ```ts
 * { request: { query: Doc }, result: { data: (vars) => ({ … }) } } // never invoked
 * { request: { query: Doc }, result: (vars) => ({ data: { … } }) } // what Apollo calls
 * ```
 *
 * The two read alike and type-check in plenty of setups, so the only thing that keeps the broken
 * shape out is a guard that runs over every mock in a codebase.
 */

/** One problem found with one mock. */
export interface MockIssue {
  /** Where the offending value sat in what was handed in, e.g. `[3].result.data.user`. */
  path: string;
  message: string;
  /** The mock's operation name, when its document carries one. */
  operationName?: string;
}

export interface ValidateMocksOptions {
  /**
   * Require each mock's resolved `result.data` to be a non-empty object. Turn it off for a
   * codebase that deliberately mocks empty payloads.
   * @default true
   */
  requireData?: boolean;
  /**
   * Call a resolver-form `result` with these variables and validate what it returns. Off by
   * default: a resolver is free to require variables this function cannot know.
   */
  probeVariables?: Record<string, unknown>;
}

/** Anything that isn't an array and has an ordinary object prototype. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Documents are plain AST objects, so check the shape rather than the constructor. */
function isDocumentNode(value: unknown): value is DocumentNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === Kind.DOCUMENT &&
    Array.isArray((value as { definitions?: unknown }).definitions)
  );
}

function operationNameOf(document: unknown): string | undefined {
  if (!isDocumentNode(document)) return undefined;
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION && definition.name) {
      return definition.name.value;
    }
  }
  return undefined;
}

/** A value that is trying to be a mock — enough to validate rather than to skip. */
function isMockLike(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && 'request' in value;
}

/** The `withResults` / `withLongLoadTime` / `withError` trio, as `mockOperationVariants` builds it. */
const VARIANT_KEYS = ['withResults', 'withLongLoadTime', 'withError'] as const;

function isVariants(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && VARIANT_KEYS.every((key) => key in value);
}

/**
 * Flatten whatever was handed in — one mock, an array, a variants trio, or a module namespace
 * full of any of those — into mocks paired with the path they were found at.
 *
 * `seen` is what keeps a module that exports built mock data alongside its mocks from running the
 * stack out: a pooled object is a plain object, so the walk descends into it, and
 * `pool[0].category.products[0].category` comes back round. Visiting each object once stops that
 * without skipping anything a depth cap would skip.
 */
function collect(
  value: unknown,
  path: string,
  into: { path: string; mock: unknown }[],
  seen: WeakSet<object>,
): void {
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) return; // pooled objects are cyclic by design
    seen.add(value);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collect(entry, `${path}[${index}]`, into, seen));
    return;
  }
  if (isMockLike(value)) {
    into.push({ path, mock: value });
    return;
  }
  if (isVariants(value)) {
    for (const key of VARIANT_KEYS) collect(value[key], `${path}.${key}`, into, seen);
    return;
  }
  // A module namespace or a keyed map: recurse, skipping exports that aren't mocks at all.
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      collect(entry, `${path}.${key}`, into, seen);
    }
  }
}

/** Walk a resolved `data` payload for function values, guarding against the graph's cycles. */
function findFunctions(value: unknown, path: string, seen: WeakSet<object>, into: string[]): void {
  if (typeof value === 'function') {
    into.push(path);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  if (seen.has(value)) return; // pooled objects are cyclic by design
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findFunctions(entry, `${path}[${index}]`, seen, into));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    findFunctions(entry, `${path}.${key}`, seen, into);
  }
}

/** Check one `result` payload — the object Apollo hands to the cache. */
function checkResult(
  result: unknown,
  path: string,
  options: ValidateMocksOptions,
  report: (path: string, message: string) => void,
): void {
  if (!isPlainObject(result)) {
    report(path, `result must be an object or a function, got ${describe(result)}`);
    return;
  }

  const { data } = result;

  if (typeof data === 'function') {
    report(
      `${path}.data`,
      'result.data is a function, which Apollo never invokes — only `result` itself is called. ' +
        'Move the function up one level: `result: (variables) => ({ data: … })`, or use ' +
        '`mockOperation(document, (variables) => …)`, which produces that shape.',
    );
    return;
  }

  if (data === undefined) {
    if ('errors' in result) return; // a GraphQL-error mock legitimately carries no data
    report(path, 'result has neither `data` nor `errors`');
    return;
  }

  if (data === null) return; // `{ data: null }` is a real GraphQL response

  if (!isPlainObject(data)) {
    report(`${path}.data`, `result.data must be an object, got ${describe(data)}`);
    return;
  }

  if ((options.requireData ?? true) && Object.keys(data).length === 0) {
    report(`${path}.data`, 'result.data is empty, so the operation resolves with nothing');
  }

  const functions: string[] = [];
  findFunctions(data, `${path}.data`, new WeakSet(), functions);
  for (const at of functions) {
    report(at, 'result.data contains a function, which serializes to nothing through the cache');
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/**
 * Check Apollo mocks for the shapes that fail silently. Point it at one mock, an array of them,
 * a `mockOperationVariants` trio, or a whole module namespace of any of those:
 *
 * ```ts
 * import * as mocks from './mocks/index.js';
 * it('every mock is well formed', () => assertValidMocks(mocks));
 * ```
 *
 * Returns every problem found rather than stopping at the first, so one run fixes a directory.
 * {@link assertValidMocks} is the same check as a throwing assertion.
 */
export function validateMocks(input: unknown, options: ValidateMocksOptions = {}): MockIssue[] {
  const issues: MockIssue[] = [];
  const found: { path: string; mock: unknown }[] = [];
  collect(input, 'mocks', found, new WeakSet());

  if (found.length === 0) {
    issues.push({ path: 'mocks', message: 'no mocks found — nothing was checked' });
    return issues;
  }

  for (const { path, mock } of found) {
    const entry = mock as Record<string, unknown>;
    const request = entry.request;
    const operationName = isPlainObject(request) ? operationNameOf(request.query) : undefined;
    const report = (at: string, message: string) =>
      issues.push(
        operationName === undefined ? { path: at, message } : { path: at, message, operationName },
      );

    if (!isPlainObject(request)) {
      report(`${path}.request`, `request must be an object, got ${describe(request)}`);
      continue;
    }

    if (!isDocumentNode(request.query)) {
      report(
        `${path}.request.query`,
        'request.query is not a parsed document — wrap the operation in `gql` or `parse`',
      );
    } else if (!request.query.definitions.some((d) => d.kind === Kind.OPERATION_DEFINITION)) {
      report(`${path}.request.query`, 'request.query declares no operation, only fragments');
    }

    const variables = request.variables;
    if (variables !== undefined && typeof variables !== 'function' && !isPlainObject(variables)) {
      report(
        `${path}.request.variables`,
        `request.variables must be an object or a predicate function, got ${describe(variables)}`,
      );
    }

    if (entry.error !== undefined && !(entry.error instanceof Error)) {
      report(`${path}.error`, `error must be an Error, got ${describe(entry.error)}`);
    }
    if (entry.delay !== undefined && typeof entry.delay !== 'number') {
      report(`${path}.delay`, `delay must be a number, got ${describe(entry.delay)}`);
    }
    if (entry.maxUsageCount !== undefined && typeof entry.maxUsageCount !== 'number') {
      report(
        `${path}.maxUsageCount`,
        `maxUsageCount must be a number, got ${describe(entry.maxUsageCount)}`,
      );
    }

    if (entry.result === undefined) {
      if (entry.error === undefined) {
        report(path, 'mock has neither `result` nor `error`, so it resolves with nothing');
      }
      continue;
    }

    if (typeof entry.result === 'function') {
      // The correct dynamic shape. Only probe it when the caller supplied variables to probe with.
      if (options.probeVariables === undefined) continue;
      const resolve = entry.result as (variables: Record<string, unknown>) => unknown;
      try {
        checkResult(resolve(options.probeVariables), `${path}.result()`, options, report);
      } catch (error) {
        report(
          `${path}.result`,
          `result threw when called with the probe variables: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }

    checkResult(entry.result, `${path}.result`, options, report);
  }

  return issues;
}

/**
 * {@link validateMocks} as an assertion: throws an `Error` listing every problem, or returns
 * quietly when there are none.
 */
export function assertValidMocks(input: unknown, options: ValidateMocksOptions = {}): void {
  const issues = validateMocks(input, options);
  if (issues.length === 0) return;
  const lines = issues.map(
    (issue) =>
      `  ${issue.path}${issue.operationName ? ` (${issue.operationName})` : ''}: ${issue.message}`,
  );
  throw new Error(
    `[graphql-mocks] ${issues.length} invalid mock${issues.length === 1 ? '' : 's'}:\n${lines.join('\n')}`,
  );
}

const warned = new WeakSet<object>();

/**
 * Catch the broken shape where it is written, rather than in a test later: a `data` argument
 * that is itself an envelope with a resolver at `.data` is the mistake this whole module exists
 * for, and at construction time the fix is one line away.
 */
export function warnOnEnvelopeData(data: unknown, site: string, operationName?: string): void {
  if (typeof data === 'function' || !isPlainObject(data)) return;
  if (typeof data.data !== 'function') return;
  // `mockOperationVariants` builds three mocks from one `data` object; warn once per object.
  if (warned.has(data)) return;
  warned.add(data);
  const hint = [
    'the data argument is an envelope with a function at ".data", which Apollo never invokes.',
    'Pass the resolver itself — `mockOperation(document, (variables) => data)` —',
    'so it becomes `result: (variables) => ({ data })`.',
  ].join(' ');
  console.warn(`[graphql-mocks] ${site}(${operationName ?? 'anonymous'}): ${hint}`);
}
