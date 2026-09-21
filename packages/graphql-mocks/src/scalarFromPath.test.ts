import { Faker, en, faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import { buildMocks } from './mockSchema.js';
import type { FakerPath, ScalarPathRecords } from './scalarFromPath.js';
import { buildScalarsFromPaths, scalarFromPath } from './scalarFromPath.js';
import { schema } from './test/schema.js';

describe('scalarFromPath', () => {
  it('builds a mocker that calls the faker method the path names', () => {
    const mocker = scalarFromPath('internet.email');
    const value = mocker(faker);
    expect(typeof value).toBe('string');
    expect(value).toContain('@');
  });

  it('keeps the module as `this`, so generators that read their own state work', () => {
    // faker's generators reach for their module through `this`; a `get(faker, path)` style
    // lookup detaches them and throws. location.zipCode() reads the locale definitions.
    expect(() => scalarFromPath('location.zipCode')(faker)).not.toThrow();
    expect(typeof scalarFromPath('location.zipCode')(faker)).toBe('string');
  });

  it('passes args through to the method', () => {
    const value = scalarFromPath('number.int', { args: [{ min: 7, max: 7 }] })(faker);
    expect(value).toBe(7);
  });

  it('returns faker’s own type rather than stringifying it', () => {
    expect(typeof scalarFromPath('datatype.boolean')(faker)).toBe('boolean');
    expect(typeof scalarFromPath('number.int')(faker)).toBe('number');
  });

  it('picks a property off a generator that returns an object', () => {
    const unit = scalarFromPath('science.unit')(faker) as { symbol: string };
    const symbol = scalarFromPath('science.unit', { pick: 'symbol' });
    expect(typeof unit.symbol).toBe('string');
    expect(typeof symbol(faker)).toBe('string');
  });

  it('works with a non-default faker instance', () => {
    const custom = new Faker({ locale: [en] });
    custom.seed(1);
    const first = scalarFromPath('internet.email')(custom);
    custom.seed(1);
    const second = scalarFromPath('internet.email')(custom);
    expect(first).toBe(second);
  });

  describe('validation', () => {
    it('throws when the path has no dot', () => {
      expect(() => scalarFromPath('email' as FakerPath)).toThrow(/"module\.method" faker path/);
    });

    it('throws when the path has more than one dot', () => {
      expect(() => scalarFromPath('a.b.c' as FakerPath)).toThrow(/"module\.method" faker path/);
    });

    it('throws when either half is empty', () => {
      expect(() => scalarFromPath('.email' as FakerPath)).toThrow(/"module\.method" faker path/);
      expect(() => scalarFromPath('internet.' as FakerPath)).toThrow(/"module\.method" faker path/);
    });

    it('throws on an unknown module', () => {
      expect(() => scalarFromPath('interwebs.email' as FakerPath)).toThrow(
        /no faker module named "interwebs"/,
      );
    });

    it('throws on an unknown method', () => {
      expect(() => scalarFromPath('internet.emial' as FakerPath)).toThrow(
        /faker\.internet has no method "emial"/,
      );
    });

    it('throws on a module member that is not a module', () => {
      expect(() => scalarFromPath('seed.value' as FakerPath)).toThrow(/no faker module named/);
    });

    it('fails when the path is built, not when the mocker runs', () => {
      // The whole point of validating against the default instance: a typo surfaces while the
      // options are being assembled, not from inside a half-generated pool.
      let built: unknown;
      expect(() => {
        built = scalarFromPath('internet.emial' as FakerPath);
      }).toThrow();
      expect(built).toBeUndefined();
    });

    it('throws at generation time when the instance lacks the module', () => {
      const mocker = scalarFromPath('internet.email');
      const stripped = { internet: {} } as unknown as Faker;
      expect(() => mocker(stripped)).toThrow(/faker\.internet\.email is not a function/);
    });

    it('throws when pick is used on a value that is not an object', () => {
      const mocker = buildScalarsFromPaths([
        { name: 'Bad', path: 'internet.email', pick: 'symbol' },
      ]).Bad;
      expect(() => mocker?.(faker)).toThrow(/returned string, which has no "symbol" to pick/);
    });
  });
});

describe('buildScalarsFromPaths', () => {
  it('accepts a name → path record', () => {
    const scalars = buildScalarsFromPaths({
      EmailAddress: 'internet.email',
      PostalCode: 'location.zipCode',
    });
    expect(Object.keys(scalars).sort()).toEqual(['EmailAddress', 'PostalCode']);
    expect(String(scalars.EmailAddress?.(faker))).toContain('@');
  });

  it('accepts specs with args and pick', () => {
    const scalars = buildScalarsFromPaths({
      Seven: { path: 'number.int', args: [{ min: 7, max: 7 }] },
      UnitSymbol: { path: 'science.unit', pick: 'symbol' },
    });
    expect(scalars.Seven?.(faker)).toBe(7);
    expect(typeof scalars.UnitSymbol?.(faker)).toBe('string');
  });

  it('accepts a list of entries, the shape a scalar registry already has', () => {
    const registry: ScalarPathRecords = [
      { name: 'EmailAddress', path: 'internet.email' },
      { name: 'Slug', path: 'lorem.slug', args: [2] },
    ];
    const scalars = buildScalarsFromPaths(registry);
    expect(Object.keys(scalars).sort()).toEqual(['EmailAddress', 'Slug']);
    expect(String(scalars.Slug?.(faker)).split('-')).toHaveLength(2);
  });

  it('throws on the first path that does not resolve', () => {
    expect(() =>
      buildScalarsFromPaths({ Ok: 'internet.email', Bad: 'internet.emial' as FakerPath }),
    ).toThrow(/has no method "emial"/);
  });

  it('feeds buildMocks directly', () => {
    const mocks = buildMocks(schema, {
      seed: 42,
      count: 2,
      scalars: buildScalarsFromPaths({
        EmailAddress: 'internet.email',
        Slug: { path: 'lorem.slug', args: [2] },
      }),
    });
    const user = mocks.User?.[0] as { email: string; blogSlug?: string } | undefined;
    expect(String(user?.email)).toContain('@');
  });
});

describe('scalarFromPath types', () => {
  it('rejects a path or a pick that faker does not have, at compile time', () => {
    // The @ts-expect-error comments are the assertion: `npm run typecheck:tests` fails here if
    // any of these four stops being an error, which is what makes the casts elsewhere needless.

    // @ts-expect-error - no such faker module
    expect(() => scalarFromPath('interwebs.email')).toThrow();
    // @ts-expect-error - faker.internet has no `emial`
    expect(() => scalarFromPath('internet.emial')).toThrow();
    // @ts-expect-error - internet.email() returns a string, so there is no property to pick
    expect(() => scalarFromPath('internet.email', { pick: 'symbol' })).not.toThrow();
    // @ts-expect-error - science.unit() returns { name, symbol }, not `sybmol`
    expect(() => scalarFromPath('science.unit', { pick: 'sybmol' })).not.toThrow();
  });
});
