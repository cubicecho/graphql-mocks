import { Faker, base, en } from '@faker-js/faker';
import type { GraphQLSchema } from 'graphql';
import { buildMocks } from './mockSchema.js';
import { mergeScenarios } from './scenarios.js';
import type {
  BuildMocksOptions,
  MockResult,
  QaConfig,
  QaOption,
  QaProfileName,
  Scenario,
  ScenarioMap,
} from './types.js';

/** Identifies a cell to `seedPerCell`, before it is built. */
export interface MatrixCellInfo {
  /** The combined cell name, e.g. `"newUser × longText"`. */
  name: string;
  /** The scenario key, or `''` when no scenario axis was given. */
  scenario: string;
  /** The QA preset key, or `''` when no QA axis was given. */
  qa: string;
  /** Position in the returned array. */
  index: number;
}

/** One built cell of the matrix — a single scenario × QA combination. */
export interface MatrixCell<TTypes extends Record<string, unknown> = Record<string, unknown>>
  extends MatrixCellInfo {
  /** Exactly what this cell was built from, including its own faker and `idPrefix`. */
  options: BuildMocksOptions;
  /** The mocks themselves — same shape as a `buildMocks` result. */
  mocks: MockResult<TTypes>;
}

export interface BuildMatrixOptions<
  TTypes extends Record<string, unknown> = Record<string, unknown>,
> extends BuildMocksOptions<TTypes> {
  /** The scenario axis, keyed by name — typically a `defineScenarios` map. */
  scenarios?: ScenarioMap<NoInfer<TTypes>>;
  /**
   * The QA axis. A list of preset names (`false` for a no-QA baseline), or a map when you
   * want your own cell names or inline configs.
   */
  qaPresets?: (QaProfileName | false)[] | Record<string, QaConfig | QaProfileName | false>;
  /** Shared QA settings merged *under* each preset, so a preset's own dimensions still win. */
  qa?: QaConfig;
  /**
   * Vary the seed per cell instead of seeding every cell from `seed`. `true` offsets by the
   * cell's index; a function returns the seed outright.
   * @default false
   */
  seedPerCell?: boolean | ((cell: MatrixCellInfo) => number);
}

/** `''` is "this axis was not given", so a one-axis matrix isn't named `"newUser × "`. */
function cellName(scenario: string, qa: string): string {
  if (scenario && qa) return `${scenario} × ${qa}`;
  return scenario || qa || 'default';
}

/** Cell names are free text, so reduce them to something safe to read inside an id. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** One anonymous entry when an axis is absent, so the other axis still produces cells. */
function axis<T>(entries: [string, T][], fallback: T): [string, T][] {
  return entries.length > 0 ? entries : [['', fallback]];
}

function qaAxis(
  presets: BuildMatrixOptions['qaPresets'],
): [string, QaConfig | QaProfileName | false | undefined][] {
  if (presets === undefined) return [['', undefined]];
  const entries = Array.isArray(presets)
    ? presets.map((preset): [string, QaProfileName | false] => [
        preset === false ? 'noQa' : preset,
        preset,
      ])
    : Object.entries(presets);
  return axis(entries, undefined);
}

/**
 * Build one mock pool per scenario × QA-preset combination — the shape Storybook and
 * `test.each` want, where each entry becomes one story or one case.
 *
 * ```ts
 * const cells = buildMatrix(schema, {
 *   scenarios: defineScenarios({ newUser: { relations: { User: { todos: null } } } }),
 *   qaPresets: [false, 'longText', 'hugeLists'],
 *   seed: 42,
 * });
 * cells.map((cell) => ({ name: cell.name, mocks: cell.mocks }));
 * ```
 *
 * Either axis may be omitted; with neither, the result is a single `default` cell equal to
 * a plain `buildMocks`. Cell options are merged scenario → preset → the options given here,
 * so an explicit `count` always wins over a scenario's.
 *
 * Each cell is generated from its **own** Faker instance seeded with `seed`, so a cell
 * reproduces identically no matter which other cells were requested alongside it, and cells
 * stay comparable until the scenario or preset actually diverges. `seedPerCell` opts out when
 * you want the cells to differ instead. A `faker` you pass contributes its locale data only —
 * it is never drawn from or re-seeded, so reproducibility rests on `seed` alone.
 *
 * With `stableIds`, each cell's ids are prefixed with a slug of its name so pools from
 * different cells don't collide in one cache — unless there is only one cell, or you set
 * `idPrefix` yourself.
 */
export function buildMatrix<TTypes extends Record<string, unknown> = Record<string, unknown>>(
  schema: GraphQLSchema | string,
  options: BuildMatrixOptions<NoInfer<TTypes>> = {},
): MatrixCell<TTypes>[] {
  const {
    scenarios,
    qaPresets,
    qa: sharedQa,
    seedPerCell = false,
    faker,
    seed,
    idPrefix,
    ...rest
  } = options;

  const rows = axis(Object.entries(scenarios ?? {}) as [string, Scenario][], {});
  const columns = qaAxis(qaPresets);
  const multiCell = rows.length * columns.length > 1;

  const cells: MatrixCell<TTypes>[] = [];

  for (const [scenarioName, scenario] of rows) {
    for (const [qaName, preset] of columns) {
      const index = cells.length;
      const info: MatrixCellInfo = {
        name: cellName(scenarioName, qaName),
        scenario: scenarioName,
        qa: qaName,
        index,
      };

      const cellSeed =
        typeof seedPerCell === 'function'
          ? seedPerCell(info)
          : seedPerCell && seed !== undefined
            ? seed + index
            : seed;

      // A fresh instance per cell keeps each one independently reproducible; a shared one would
      // carry state from whichever cells ran before it, and seeding it would reach back into the
      // caller's own instance. A `faker` passed in contributes its locale data, nothing else.
      const cellFaker = new Faker({ locale: faker?.rawDefinitions ?? [en, base] });

      const layers: (Scenario | BuildMocksOptions)[] = [];
      if (sharedQa) layers.push({ qa: sharedQa });
      layers.push(scenario);
      if (preset !== undefined) layers.push({ qa: preset as QaOption });
      layers.push(rest as BuildMocksOptions);

      const merged = mergeScenarios(layers) as BuildMocksOptions;
      const cellOptions: BuildMocksOptions = {
        ...merged,
        faker: cellFaker,
        ...(cellSeed !== undefined ? { seed: cellSeed } : {}),
        idPrefix:
          idPrefix ??
          merged.idPrefix ??
          (merged.stableIds && multiCell ? `${slug(info.name)}-` : ''),
      };

      cells.push({
        ...info,
        options: cellOptions,
        mocks: buildMocks<TTypes>(schema, cellOptions as BuildMocksOptions<NoInfer<TTypes>>),
      });
    }
  }

  return cells;
}
