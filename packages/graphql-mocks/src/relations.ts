import type { RelationSpec, RelationsConfig } from './types.js';

/**
 * The size `'all'` resolves to: unbounded, clamped to the target pool at draw time.
 * Sentinel rather than a pool length so the bound stays pure.
 */
export const UNBOUNDED = Number.POSITIVE_INFINITY;

/** A bare object is a map of keys, never a `{ min, max }` range — see {@link RelationsConfig}. */
function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The relationship spec for one field, resolved most specific first:
 * `[type][field]` → `[type]._default` → `_default` → the flat top-level form.
 *
 * `undefined` means "no opinion" — the caller falls back to the QA list profile and the
 * built-in sizing — and stays distinct from `null`, which means "explicitly none".
 */
export function resolveRelation(
  typeName: string,
  fieldName: string,
  config: RelationsConfig | undefined,
): RelationSpec | undefined {
  if (config === undefined) return undefined;
  if (!isMap(config)) return config;

  const typeEntry = config[typeName];
  if (isMap(typeEntry)) {
    const field = typeEntry[fieldName];
    if (field !== undefined) return field as RelationSpec;
    if (typeEntry._default !== undefined) return typeEntry._default as RelationSpec;
  }
  return config._default as RelationSpec | undefined;
}

/**
 * Coerce a spec into the `{ min, max }` the pool sampler wants, or `null` for "none".
 *
 * `fallback` covers the two specs that carry no size of their own: `undefined` (no entry,
 * where the caller has already folded in the QA list profile) and a {@link RelationFn},
 * which computes the value itself and never consults these bounds.
 */
export function relationBounds(
  spec: RelationSpec | undefined,
  fallback: { min: number; max: number },
): { min: number; max: number } | null {
  if (spec === null) return null;
  if (spec === undefined || typeof spec === 'function') return fallback;
  if (spec === 'all') return { min: UNBOUNDED, max: UNBOUNDED };
  if (typeof spec === 'number') return { min: spec, max: spec };
  return spec;
}
