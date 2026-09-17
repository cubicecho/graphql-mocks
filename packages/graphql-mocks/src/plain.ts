import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import {
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLSchema,
  Kind,
  type OperationDefinitionNode,
  type SelectionSetNode,
  isAbstractType,
  isObjectType,
} from 'graphql';

/**
 * Pooled objects are wired into a graph, and with `relations: { _reciprocal: true }` that graph
 * contains cycles: `user.todos[0].user` is the user again. Anything that walks a mock generically
 * — `JSON.stringify`, a snapshot, a deep-equality assertion, `structuredClone` — needs a cycle
 * guard, and the failure (`RangeError: Maximum call stack size exceeded`) shows up far from the
 * mocking code. These two helpers are the guard, so a caller never has to write one.
 */

/** What replaces a reference back to an object already open on the current path. */
export type CycleStrategy = 'stub' | 'null' | 'omit';

export interface ToPlainOptions {
  /**
   * How a cycle (or a cut at `maxDepth`) is represented:
   *
   * - `'stub'` — `{ __typename, id }` taken from the object, keeping its identity readable;
   *   `null` when it has neither.
   * - `'null'` — the reference becomes `null`.
   * - `'omit'` — the property is dropped. Array *entries* still become `null`, since dropping
   *   one would shift every index after it.
   *
   * @default 'stub'
   */
  onCycle?: CycleStrategy;
  /**
   * Stop copying below this many levels, cutting with `onCycle`. Unlimited by default — the
   * cycle guard alone is enough to make a mock serializable.
   * @default Infinity
   */
  maxDepth?: number;
}

/** Dropped-property sentinel, distinguishable from a legitimate `undefined` value. */
const OMITTED = Symbol('omitted');

/** Only plain objects are copied; a `Date`, `RegExp` or class instance is passed through. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The identity of a cut object, as far as a mock carries one. */
function stubOf(value: Record<string, unknown>): unknown {
  const stub: Record<string, unknown> = {};
  if (typeof value.__typename === 'string') stub.__typename = value.__typename;
  if (value.id !== undefined) stub.id = value.id;
  return Object.keys(stub).length > 0 ? stub : null;
}

/**
 * Deep-copy a value, cutting every reference that points back into the path being copied — so
 * the result is a tree that `JSON.stringify` and friends can walk:
 *
 * ```ts
 * const mocks = buildMocks(schema, { relations: { _reciprocal: true } });
 * JSON.stringify(toPlain(mocks.User[0])); // no RangeError
 * ```
 *
 * Two objects that merely appear twice are both copied in full; only a genuine cycle — the same
 * object open on the current path — is cut. Non-plain values (`Date`, class instances) and
 * functions are carried over by reference rather than copied.
 *
 * The result is typed as the input, which is what the ordinary copy is. Where a cut actually
 * fires the shape narrows below that — a cycle becomes a `{ __typename, id }` stub, `null`, or
 * a dropped property — so a value you intend to cut deeply (`maxDepth`, `onCycle`) is worth
 * widening yourself.
 */
export function toPlain<T>(value: T, options: ToPlainOptions = {}): T {
  const onCycle = options.onCycle ?? 'stub';
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  // The *path*, not every object seen: a shared object that isn't an ancestor is not a cycle.
  const open = new Set<object>();

  const cut = (target: Record<string, unknown>): unknown => {
    if (onCycle === 'null') return null;
    if (onCycle === 'omit') return OMITTED;
    return stubOf(target);
  };

  const copy = (current: unknown, depth: number): unknown => {
    if (Array.isArray(current)) {
      if (open.has(current)) return cut({});
      open.add(current);
      // An omitted array entry would shift the indices after it, so a cut entry is null here.
      const result = current.map((item) => {
        const copied = copy(item, depth + 1);
        return copied === OMITTED ? null : copied;
      });
      open.delete(current);
      return result;
    }

    if (!isPlainObject(current)) return current;
    if (open.has(current)) return cut(current);
    if (depth >= maxDepth) return cut(current);

    open.add(current);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(current)) {
      const copied = copy(item, depth + 1);
      if (copied !== OMITTED) result[key] = copied;
    }
    open.delete(current);
    return result;
  };

  return copy(value, 0) as T;
}

export interface SelectOptions {
  /** Which operation to project against, when the document declares more than one. */
  operationName?: string;
  /**
   * The schema the document was written against. Only needed to resolve a fragment whose type
   * condition is an interface or union: without it, a condition matches when it equals the
   * object's own `__typename`, which covers concrete conditions but not abstract ones.
   */
  schema?: GraphQLSchema;
}

function operationFor(
  document: DocumentNode,
  operationName: string | undefined,
): OperationDefinitionNode {
  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  );
  const operation =
    operationName === undefined
      ? operations[0]
      : operations.find((candidate) => candidate.name?.value === operationName);
  if (!operation) {
    throw new TypeError(
      `[graphql-mocks] select: document has no operation${operationName ? ` named "${operationName}"` : ''}`,
    );
  }
  return operation;
}

/** Whether a fragment's type condition covers an object carrying this `__typename`. */
function conditionMatches(
  condition: string | undefined,
  typename: unknown,
  schema: GraphQLSchema | undefined,
): boolean {
  if (condition === undefined) return true;
  if (typeof typename !== 'string') return true; // nothing to discriminate on — take the fields
  if (condition === typename) return true;
  if (!schema) return false;
  const conditionType = schema.getType(condition);
  const objectType = schema.getType(typename);
  return isAbstractType(conditionType) && isObjectType(objectType)
    ? schema.isSubType(conditionType, objectType)
    : false;
}

/**
 * Project `value` onto a document's selection set: fields the query asks for, under the aliases
 * it asks for them, and nothing else. Because the shape follows the (finite) document rather
 * than the object graph, the result is always cycle-free.
 *
 * ```ts
 * const row = select(mocks.User[0], UserRowFragmentDoc);
 * expect(row).toEqual({ __typename: 'User', id: 'User-0', name: 'Ada' });
 * ```
 *
 * `@skip` / `@include` directives are not evaluated — the field is taken as written.
 *
 * With a `TypedDocumentNode` the return type is inferred from the document, the same way
 * `dataForOperation` infers it; a plain `DocumentNode` leaves it `unknown` unless you say.
 */
export function select<TData = unknown, TVars = Record<string, unknown>>(
  value: unknown,
  document: TypedDocumentNode<TData, TVars> | DocumentNode,
  options: SelectOptions = {},
): TData {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION)
      fragments.set(definition.name.value, definition);
  }

  // A bare fragment document — what codegen emits for a `...Row` fragment — has no operation,
  // so its own selection set is the projection.
  const hasOperation = document.definitions.some(
    (definition) => definition.kind === Kind.OPERATION_DEFINITION,
  );
  const root = hasOperation
    ? operationFor(document, options.operationName).selectionSet
    : [...fragments.values()][0]?.selectionSet;
  if (!root) {
    throw new TypeError('[graphql-mocks] select: document has no operation or fragment to project');
  }

  const project = (source: unknown, selectionSet: SelectionSetNode): unknown => {
    if (Array.isArray(source)) return source.map((item) => project(item, selectionSet));
    if (source === null || source === undefined) return source ?? null;
    if (typeof source !== 'object') return source;

    const record = source as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    const walk = (set: SelectionSetNode): void => {
      for (const selection of set.selections) {
        if (selection.kind === Kind.FIELD) {
          const key = selection.alias?.value ?? selection.name.value;
          const raw = record[selection.name.value];
          result[key] = selection.selectionSet
            ? project(raw, selection.selectionSet)
            : toPlain(raw);
          continue;
        }

        const fragment =
          selection.kind === Kind.FRAGMENT_SPREAD ? fragments.get(selection.name.value) : selection;
        if (!fragment) {
          throw new TypeError(
            `[graphql-mocks] select: the document spreads "${selection.kind === Kind.FRAGMENT_SPREAD ? selection.name.value : ''}" but does not define it`,
          );
        }
        if (
          conditionMatches(fragment.typeCondition?.name.value, record.__typename, options.schema)
        ) {
          walk(fragment.selectionSet);
        }
      }
    };

    walk(selectionSet);
    return result;
  };

  return project(value, root) as TData;
}
