import { expandQaOption, qaScalarMockers, resolveQa } from './qa.js';
import type { BuildMocksOptions, CountConfig, QaOption, Scenario, ScenarioMap } from './types.js';

/** Anything merged here is a partial build config; `description` rides along untouched. */
type Layer = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A flat number replaces outright; a map merges per type, promoting a number to `_default`. */
function mergeCount(base: CountConfig | undefined, next: CountConfig): CountConfig {
  if (typeof next === 'number' || base === undefined) return next;
  if (typeof base === 'number') return { _default: base, ...next };
  return { ...base, ...next };
}

/**
 * QA dimensions merge the way `buildQaSets` already merges a shared config under a preset:
 * per dimension, later wins. `false` resets QA mode, and a later config turns it back on.
 */
function mergeQa(base: QaOption | undefined, next: QaOption): QaOption | undefined {
  const expanded = expandQaOption(next);
  // An unknown name already warned; treat it as "QA off" rather than silently keeping the base.
  if (expanded === undefined || expanded === false) return expanded;
  const baseConfig = expandQaOption(base);
  return baseConfig ? { ...baseConfig, ...expanded } : expanded;
}

/**
 * Merge a two-level map (`overrides`, `derive`, `relations`, `countFields`) — per type, then per
 * field. Reserved keys (`_default`, `_reciprocal`), the flat forms and the boolean form of
 * `countFields` carry no per-field structure, so they assign.
 */
function mergeTwoLevel(base: unknown, next: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(next)) return next;

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(next)) {
    const previous = merged[key];
    merged[key] =
      key.startsWith('_') || !isPlainObject(previous) || !isPlainObject(value)
        ? value
        : { ...previous, ...value };
  }
  return merged;
}

/**
 * `scalars` always outranks the QA scalar map (`user ?? qa ?? default`), no matter which
 * layer each came from — so a QA layer applied *after* a scenario's `scalars` still loses.
 * That's the documented precedence, not a merge bug, so make the surprise audible.
 */
function warnScalarInversion(merged: Layer, qaAfterScalars: boolean): void {
  const scalars = merged.scalars as Record<string, unknown> | undefined;
  if (!qaAfterScalars || !scalars) return;

  const qa = resolveQa(merged.qa as QaOption | undefined);
  if (!qa) return;

  const overlap = Object.keys(qaScalarMockers(qa)).filter((name) => name in scalars);
  if (overlap.length === 0) return;

  console.warn(
    `[graphql-mocks] scenario: a later qa layer cannot reach ${overlap.join(', ')} — an explicit "scalars" entry always wins over the QA generator, whichever layer it came from`,
  );
}

/**
 * Fold partial build configs left to right, later layers winning. Structured options merge
 * key by key so a scenario can add to one without discarding the rest; everything else is
 * last-one-wins.
 */
export function mergeScenarios(layers: readonly (Scenario | BuildMocksOptions)[]): Layer {
  const merged: Layer = {};
  let scalarsAt = -1;
  let qaAt = -1;

  layers.forEach((layer, index) => {
    for (const [key, value] of Object.entries(layer as Layer)) {
      if (value === undefined) continue;
      switch (key) {
        case 'count':
          merged.count = mergeCount(merged.count as CountConfig | undefined, value as CountConfig);
          break;
        case 'qa':
          merged.qa = mergeQa(merged.qa as QaOption | undefined, value as QaOption);
          qaAt = index;
          break;
        case 'scalars':
          merged.scalars = { ...(merged.scalars as Layer), ...(value as Layer) };
          scalarsAt = index;
          break;
        // One level deep: the key *is* the field name, so there is no per-type level to merge.
        case 'fieldOverrides':
          merged.fieldOverrides = { ...(merged.fieldOverrides as Layer), ...(value as Layer) };
          break;
        case 'countFields':
        case 'derive':
        case 'overrides':
        case 'relations':
          merged[key] = mergeTwoLevel(merged[key], value);
          break;
        default:
          merged[key] = value;
      }
    }
  });

  warnScalarInversion(merged, scalarsAt >= 0 && qaAt > scalarsAt);
  return merged;
}

/**
 * Fold `options.scenario` under the options themselves, which always win. Returns the
 * options unchanged when no scenario is in play, so the common path allocates nothing.
 */
export function applyScenarios(options: BuildMocksOptions): BuildMocksOptions {
  const { scenario, ...rest } = options;
  if (scenario === undefined) return options;
  const layers = Array.isArray(scenario) ? scenario : [scenario];
  return mergeScenarios([...layers, rest]) as BuildMocksOptions;
}

/**
 * Declare a set of named scenarios. An identity function at runtime — it exists to keep the
 * literal key names while still checking each scenario's shape.
 *
 * ```ts
 * export const scenarios = defineScenarios({
 *   newUser: { description: 'nothing yet', relations: { User: { todos: null } } },
 *   powerUser: { relations: { User: { todos: 200 } } },
 * });
 * buildMocks(schema, { scenario: scenarios.newUser, seed: 42 });
 * ```
 *
 * For schema-checked type and field names, add `satisfies ScenarioMap<SchemaTypeMap>`.
 */
export function defineScenarios<const T extends ScenarioMap>(scenarios: T): T {
  return scenarios;
}

/**
 * Combine scenarios into one, applied left to right. The result is an ordinary scenario, so
 * it can be composed further or passed straight to `buildMocks`.
 */
export function composeScenarios(...scenarios: Scenario[]): Scenario {
  return mergeScenarios(scenarios) as Scenario;
}
