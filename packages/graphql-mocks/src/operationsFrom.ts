import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { type DocumentNode, Kind } from 'graphql';
import type { MockOperationOptions, MockOperationVariants } from './apolloMocks.js';

/**
 * The document exports of a module, keyed by **export name**. Operation names live only in the
 * runtime AST and are invisible to the type system, so keying by them would make the mapped
 * type unsound; export names give exact keys and per-entry data types.
 */
export type OperationModule = Record<string, unknown>;

/** Only the document-valued exports of `TModule`, each mapped to its variants trio. */
export type OperationMocks<TModule extends OperationModule> = {
  [K in keyof TModule as TModule[K] extends TypedDocumentNode<infer _D, infer _V>
    ? K
    : never]: TModule[K] extends TypedDocumentNode<infer TData, infer TVars>
    ? MockOperationVariants<TData, TVars>
    : never;
};

/**
 * Brands the map {@link buildOperationMocks} returns. Its entries are lazy getters, so the only
 * way to answer "does this module hold mocks?" without building every operation in it is to
 * recognise the map itself and read its key list — a structural test would have to read a value,
 * which is the one thing the map is built to avoid.
 *
 * `Symbol.for` so two copies of the package in one dependency tree still recognise each other's
 * maps, and non-enumerable where it is set, so spreading or walking a map never sees it.
 */
export const OPERATION_MOCKS = Symbol.for('@vantreeseba/graphql-mocks.operationMocks');

/** A map built by {@link buildOperationMocks}, recognised without reading a single entry. */
export function isOperationMocks(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && OPERATION_MOCKS in value;
}

/** Builds the variants for one document — supplied by the graph. */
export type VariantsBuilder = (document: DocumentNode, options?: MockOperationOptions) => unknown;

function isOperationDocument(value: unknown): value is DocumentNode {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { kind?: unknown; definitions?: unknown };
  if (candidate.kind !== Kind.DOCUMENT || !Array.isArray(candidate.definitions)) return false;
  return candidate.definitions.some(
    (definition: { kind?: unknown }) => definition?.kind === Kind.OPERATION_DEFINITION,
  );
}

/**
 * Turn a codegen document module into a keyed map of mock variants, so a file of per-operation
 * re-exports collapses into one call. Non-document exports are skipped silently — codegen
 * modules are full of them.
 *
 * Entries are **lazy**: each is built on first access and then cached, so importing a module
 * with fifty documents does not run fifty executions at import time. Spreading the map (or
 * `Object.values`) forces every entry; `Object.keys` does not, and neither does `containsMocks`,
 * which recognises the map by its brand and answers from those keys.
 *
 * Two export names aliasing the same document share one variants object, so their mocks stay
 * identical instead of drawing separately.
 */
export function buildOperationMocks<TModule extends OperationModule>(
  module: TModule,
  build: VariantsBuilder,
  options: MockOperationOptions = {},
): OperationMocks<TModule> {
  const result = {} as Record<string, unknown>;
  const byDocument = new Map<DocumentNode, unknown>();
  const firstNameFor = new Map<DocumentNode, string>();
  let warnedAboutAliases = false;

  for (const [name, value] of Object.entries(module)) {
    if (!isOperationDocument(value)) continue;
    const document = value;
    const firstName = firstNameFor.get(document);
    if (firstName === undefined) {
      firstNameFor.set(document, name);
    } else if (!warnedAboutAliases) {
      warnedAboutAliases = true;
      console.warn(
        `[graphql-mocks] "${name}" and "${firstName}" export the same document — they share one set of mocks`,
      );
    }
    Object.defineProperty(result, name, {
      enumerable: true,
      configurable: true,
      get() {
        let variants = byDocument.get(document);
        if (variants === undefined) {
          variants = build(document, options);
          byDocument.set(document, variants);
        }
        // Replace the getter so repeat reads cost nothing.
        Object.defineProperty(result, name, {
          value: variants,
          enumerable: true,
          configurable: true,
          writable: false,
        });
        return variants;
      },
    });
  }

  // Non-enumerable, so it stays out of `Object.keys`, spreads and every walk over the map.
  Object.defineProperty(result, OPERATION_MOCKS, { value: true });

  return result as OperationMocks<TModule>;
}
