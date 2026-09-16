import { faker as defaultFaker } from '@faker-js/faker';
import type { Faker } from '@faker-js/faker';
import type { BuildMocksOptions, CountConfig, ListSizeConfig } from './types.js';

export const OPERATION_TYPE_NAMES = new Set(['Query', 'Mutation', 'Subscription']);

export function resolveCount(
  typeName: string,
  config: CountConfig | undefined,
  defaultCount = 5,
): number {
  if (config === undefined) return defaultCount;
  if (typeof config === 'number') return config;
  return config[typeName] ?? config._default ?? defaultCount;
}

export function resolveFaker(options: BuildMocksOptions): Faker {
  const f = options.faker ?? defaultFaker;
  if (options.seed !== undefined) {
    f.seed(options.seed);
  }
  return f;
}

/** Inclusive size range for a generated list field. */
export interface ListSizeRange {
  min: number;
  max: number;
}

export const DEFAULT_LIST_SIZE: ListSizeRange = { min: 1, max: 5 };

/**
 * Normalize `listSize` to a `{ min, max }` range. A bare number means an exact length.
 * Bounds are clamped non-negative and ordered, so `{ min: 5, max: 1 }` behaves as `{ 1, 5 }`.
 */
export function resolveListSize(
  config: ListSizeConfig | undefined,
  fallback: ListSizeRange = DEFAULT_LIST_SIZE,
): ListSizeRange {
  if (config === undefined) return fallback;
  const { min, max } = typeof config === 'number' ? { min: config, max: config } : config;
  const lo = Math.max(0, min);
  const hi = Math.max(0, max);
  return lo <= hi ? { min: lo, max: hi } : { min: hi, max: lo };
}
