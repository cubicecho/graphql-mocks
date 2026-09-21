import { faker as defaultFaker } from '@faker-js/faker';
import type { Faker } from '@faker-js/faker';
import type { ScalarMocker } from './types.js';

/** The callable members of one faker module (`lorem`, `internet`, …). */
type MethodNamesOf<TModule> = {
  [K in keyof TModule]-?: TModule[K] extends (...args: never[]) => unknown ? K : never;
}[keyof TModule];

/**
 * Every `module.method` pair faker exposes, as a string union — `'internet.email'`,
 * `'lorem.slug'`, `'science.unit'`, … Non-module members of `Faker` (`seed`, `definitions`)
 * contribute no methods, and a template literal over `never` collapses to `never`, so they
 * drop out of the union on their own.
 */
export type FakerPath = {
  [TModule in keyof Faker]: `${TModule & string}.${MethodNamesOf<Faker[TModule]> & string}`;
}[keyof Faker];

/** The faker method a path points at, or `never` when the path names no method. */
type MethodAt<TPath extends FakerPath> = TPath extends `${infer TModule}.${infer TMethod}`
  ? TModule extends keyof Faker
    ? TMethod extends keyof Faker[TModule]
      ? Faker[TModule][TMethod] extends (...args: never[]) => unknown
        ? Faker[TModule][TMethod]
        : never
      : never
    : never
  : never;

/**
 * The properties `pick` may name for a path: the string keys of the generated value when the
 * generator returns a plain object, and nothing at all when it returns a string, a number or
 * an array — picking a property off one of those is always a mistake, so it fails to
 * typecheck.
 */
type PickableOf<TPath extends FakerPath> = ReturnType<MethodAt<TPath>> extends infer TResult
  ? TResult extends readonly unknown[]
    ? never
    : TResult extends object
      ? Extract<keyof TResult, string>
      : never
  : never;

export interface ScalarFromPathOptions<TPath extends FakerPath> {
  /**
   * Arguments passed to the faker method. Deliberately untyped: most faker generators are
   * overloaded, and `Parameters<>` only ever sees the last overload, so deriving the tuple
   * from the path would reject arguments faker itself accepts.
   */
  args?: readonly unknown[];
  /**
   * Property to take from the generated value, for generators that return an object rather
   * than a single value — `scalarFromPath('science.unit', { pick: 'symbol' })`.
   */
  pick?: PickableOf<TPath>;
}

/**
 * One entry of the batch form: a path plus how to call it. `pick` is a plain `string` here
 * rather than the per-path union {@link ScalarFromPathOptions} uses, because a record's
 * entries are only known collectively; the single-scalar form is where `pick` is checked
 * against the one path it belongs to.
 */
export interface ScalarPathSpec {
  path: FakerPath;
  args?: readonly unknown[];
  pick?: string;
}

/**
 * The batch form's input: scalar name → path, or → a spec carrying `args`/`pick`. An array of
 * `{ name, path, … }` entries works too, for a registry that already keeps its scalars in a
 * list.
 */
export type ScalarPathRecords =
  | Record<string, FakerPath | ScalarPathSpec>
  | readonly (ScalarPathSpec & { name: string })[];

/** Faker seen as data: the one place the library owns the cast, so consumers don't have to. */
type FakerModules = Record<string, Record<string, ((...args: unknown[]) => unknown) | undefined>>;

function buildMocker(path: string, args: readonly unknown[], pick: string | undefined) {
  const parts = path.split('.');
  const [moduleName, methodName] = parts;
  if (parts.length !== 2 || !moduleName || !methodName) {
    throw new TypeError(
      `scalarFromPath: expected a "module.method" faker path, received ${JSON.stringify(path)}.`,
    );
  }

  // Validated here rather than at generation time: every faker instance has the same module
  // layout, so the default instance can answer whether a path resolves, and a typo fails while
  // the options are being built instead of somewhere inside a half-generated mock pool.
  const referenceModule = (defaultFaker as unknown as FakerModules)[moduleName];
  if (typeof referenceModule !== 'object' || referenceModule === null) {
    throw new TypeError(`scalarFromPath: no faker module named ${JSON.stringify(moduleName)}.`);
  }
  if (typeof referenceModule[methodName] !== 'function') {
    throw new TypeError(
      `scalarFromPath: faker.${moduleName} has no method ${JSON.stringify(methodName)}.`,
    );
  }

  const mocker: ScalarMocker = (faker: Faker) => {
    const fakerModule = (faker as unknown as FakerModules)[moduleName];
    const method = fakerModule?.[methodName];
    if (typeof method !== 'function') {
      // The instance passed to the mocker isn't the one the path was validated against.
      throw new TypeError(`scalarFromPath: faker.${moduleName}.${methodName} is not a function.`);
    }
    // Invoked on its module rather than pulled out of it: faker's generators read their own
    // module off `this`, and throw once detached.
    const value = method.apply(fakerModule, [...args]);
    if (pick === undefined) return value;
    if (typeof value !== 'object' || value === null) {
      throw new TypeError(
        `scalarFromPath: faker.${moduleName}.${methodName}() returned ${typeof value}, which has no ${JSON.stringify(pick)} to pick.`,
      );
    }
    return (value as Record<string, unknown>)[pick];
  };
  return mocker;
}

/**
 * Builds a scalar mocker from a dotted faker path, so a schema's custom scalars can be
 * declared as data instead of one closure each:
 *
 * ```ts
 * scalars: {
 *   EmailAddress: scalarFromPath('internet.email'),
 *   Slug: scalarFromPath('lorem.slug', { args: [2] }),
 *   UnitSymbol: scalarFromPath('science.unit', { pick: 'symbol' }),
 * }
 * ```
 *
 * The value is whatever faker returns — a number generator still yields a number, matching
 * the built-in mockers — narrowed by `pick` when the generator returns an object.
 *
 * @throws TypeError if the path is not `module.method`, or names no faker generator.
 */
export function scalarFromPath<TPath extends FakerPath>(
  path: TPath,
  options: ScalarFromPathOptions<TPath> = {},
): ScalarMocker {
  return buildMocker(path, options.args ?? [], options.pick);
}

/**
 * The batch form of {@link scalarFromPath}: turns a whole registry of scalar-name → path
 * declarations into the `scalars` option in one call.
 *
 * ```ts
 * scalars: buildScalarsFromPaths({
 *   EmailAddress: 'internet.email',
 *   Slug: { path: 'lorem.slug', args: [2] },
 * });
 * ```
 *
 * @throws TypeError, as {@link scalarFromPath} does, on the first path that doesn't resolve.
 */
export function buildScalarsFromPaths(records: ScalarPathRecords): Record<string, ScalarMocker> {
  const entries: (ScalarPathSpec & { name: string })[] = Array.isArray(records)
    ? records
    : Object.entries(records as Record<string, FakerPath | ScalarPathSpec>).map(([name, spec]) =>
        typeof spec === 'string' ? { name, path: spec } : { name, ...spec },
      );

  const scalars: Record<string, ScalarMocker> = {};
  for (const entry of entries) {
    scalars[entry.name] = buildMocker(entry.path, entry.args ?? [], entry.pick);
  }
  return scalars;
}
