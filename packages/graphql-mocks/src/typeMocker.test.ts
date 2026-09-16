import { faker } from '@faker-js/faker';
import { buildSchema, isObjectType } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { type ResolvedOptions, resolveOptions } from './resolveOptions.js';
import { mockTypeScalars, unwrapType } from './typeMocker.js';
import type { BuildMocksOptions } from './types.js';

const simpleSchema = buildSchema(`
  enum Status { ACTIVE INACTIVE }
  type Widget {
    id: ID!
    name: String!
    count: Int!
    ratio: Float!
    active: Boolean!
    status: Status!
    tags: [String!]!
    maybeNull: String
  }
`);

// mockTypeScalars consumes the same resolved bundle buildGraph builds, so these tests run
// through the real resolution path instead of a hand-assembled context.
const opts = (options: BuildMocksOptions = {}): ResolvedOptions =>
  resolveOptions({ faker, ...options });

function getType(name: string) {
  const t = simpleSchema.getType(name);
  if (!t || !isObjectType(t)) throw new Error(`Type ${name} not found`);
  return t;
}

describe('mockTypeScalars', () => {
  const widgetType = getType('Widget');

  it('generates all required scalar fields', () => {
    const result = mockTypeScalars(widgetType, opts());
    expect(typeof result.id).toBe('string');
    expect(typeof result.name).toBe('string');
    expect(typeof result.count).toBe('number');
    expect(Number.isInteger(result.count)).toBe(true);
    expect(typeof result.ratio).toBe('number');
    expect(typeof result.active).toBe('boolean');
  });

  it('generates enum field from schema enum values', () => {
    const result = mockTypeScalars(widgetType, opts());
    expect(['ACTIVE', 'INACTIVE']).toContain(result.status);
  });

  it('generates list scalar fields as arrays', () => {
    const result = mockTypeScalars(widgetType, opts());
    expect(Array.isArray(result.tags)).toBe(true);
    expect((result.tags as string[]).length).toBeGreaterThan(0);
    for (const tag of result.tags as string[]) {
      expect(typeof tag).toBe('string');
    }
  });

  it('populates nullable fields by default (nullChance = 0)', () => {
    // Run many times; with nullChance 0, should always populate
    for (let i = 0; i < 20; i++) {
      const result = mockTypeScalars(widgetType, opts());
      expect(result.maybeNull).not.toBeNull();
    }
  });

  it('can null nullable fields when nullChance = 1', () => {
    const result = mockTypeScalars(widgetType, opts({ nullChance: 1 }));
    expect(result.maybeNull).toBeNull();
  });

  it('applies field-level overrides', () => {
    const result = mockTypeScalars(
      widgetType,
      opts({
        overrides: { Widget: { name: () => 'fixed-name' } },
      }),
    );
    expect(result.name).toBe('fixed-name');
  });

  it('generates list enum fields as arrays of enum values', () => {
    const listEnumSchema = buildSchema(`
      enum Color { RED GREEN BLUE }
      type Paint { id: ID!, colors: [Color!]! }
    `);
    const paintType = listEnumSchema.getType('Paint');
    if (!paintType || !isObjectType(paintType)) throw new Error();
    const result = mockTypeScalars(paintType, opts());
    expect(Array.isArray(result.colors)).toBe(true);
    const colors = result.colors as string[];
    expect(colors.length).toBeGreaterThan(0);
    for (const c of colors) {
      expect(['RED', 'GREEN', 'BLUE']).toContain(c);
    }
  });

  it('falls back for unknown scalar in a list field', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unknownListSchema = buildSchema(`
      scalar Mystery
      type Foo { id: ID!, things: [Mystery!]! }
    `);
    const fooType = unknownListSchema.getType('Foo');
    if (!fooType || !isObjectType(fooType)) throw new Error();
    const result = mockTypeScalars(fooType, opts());
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Mystery'));
    expect(Array.isArray(result.things)).toBe(true);
    warnSpy.mockRestore();
  });

  it('warns and falls back for unknown scalars', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unknownSchema = buildSchema(`
      scalar Mystery
      type Foo { id: ID!, x: Mystery! }
    `);
    const fooType = unknownSchema.getType('Foo');
    if (!fooType || !isObjectType(fooType)) throw new Error();
    const result = mockTypeScalars(fooType, opts());
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Mystery'));
    expect(typeof result.x).toBe('string');
    warnSpy.mockRestore();
  });

  it('uses user-provided scalar mocker over default', () => {
    const result = mockTypeScalars(
      widgetType,
      opts({
        scalars: { String: () => 'custom-string' },
      }),
    );
    expect(result.name).toBe('custom-string');
  });
});

describe('unwrapType', () => {
  it('handles NonNull named type', () => {
    const schema = buildSchema('type Q { field: String! }');
    const field = schema.getType('Q');
    if (!field || !isObjectType(field)) throw new Error();
    const fieldDef = field.getFields().field;
    if (!fieldDef) throw new Error('field not found');
    const { isRequired, isList, namedType } = unwrapType(fieldDef.type);
    expect(isRequired).toBe(true);
    expect(isList).toBe(false);
    expect(namedType.name).toBe('String');
  });

  it('handles nullable named type', () => {
    const schema = buildSchema('type Q { field: String }');
    const field = schema.getType('Q');
    if (!field || !isObjectType(field)) throw new Error();
    const fieldDef = field.getFields().field;
    if (!fieldDef) throw new Error('field not found');
    const { isRequired, isList, namedType } = unwrapType(fieldDef.type);
    expect(isRequired).toBe(false);
    expect(isList).toBe(false);
    expect(namedType.name).toBe('String');
  });

  it('handles NonNull List of NonNull types', () => {
    const schema = buildSchema('type Q { field: [String!]! }');
    const field = schema.getType('Q');
    if (!field || !isObjectType(field)) throw new Error();
    const fieldDef = field.getFields().field;
    if (!fieldDef) throw new Error('field not found');
    const { isRequired, isList, namedType } = unwrapType(fieldDef.type);
    expect(isRequired).toBe(true);
    expect(isList).toBe(true);
    expect(namedType.name).toBe('String');
  });

  it('handles nullable List', () => {
    const schema = buildSchema('type Q { field: [String] }');
    const field = schema.getType('Q');
    if (!field || !isObjectType(field)) throw new Error();
    const fieldDef = field.getFields().field;
    if (!fieldDef) throw new Error('field not found');
    const { isRequired, isList, namedType } = unwrapType(fieldDef.type);
    expect(isRequired).toBe(false);
    expect(isList).toBe(true);
    expect(namedType.name).toBe('String');
  });
});
