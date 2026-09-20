import { buildSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildMocks } from './mockSchema.js';
import type { BuildMocksOptions } from './types.js';

const schema = buildSchema(`
  enum Status { OPEN CLOSED }
  type PaymentMethod {
    id: ID!
    paymentMethodId: String!
    externalID: String!
    accountNumber: Int!
    statusId: Status!
    tagIds: [ID!]!
    label: String!
  }
  type Currency {
    code: String!
    label: String!
  }
  type Country {
    code: String!
  }
  type Query { methods: [PaymentMethod!]! }
`);

const pool = (name: string, options: BuildMocksOptions = {}) =>
  buildMocks(schema, { seed: 3, count: 3, ...options })[name] as Record<string, unknown>[];

const column = (name: string, field: string, options: BuildMocksOptions = {}) =>
  pool(name, options).map((item) => item[field]);

describe('stableIds beyond `id`', () => {
  it('keeps the TypeName-<index> form for id itself', () => {
    expect(column('PaymentMethod', 'id', { stableIds: true })).toEqual([
      'PaymentMethod-0',
      'PaymentMethod-1',
      'PaymentMethod-2',
    ]);
  });

  it('numbers any field whose name reads as an identifier', () => {
    const options = { stableIds: true };
    // The field name rides along so two identifier fields on one object never share a value.
    expect(column('PaymentMethod', 'paymentMethodId', options)).toEqual([
      'PaymentMethod-paymentMethodId-0',
      'PaymentMethod-paymentMethodId-1',
      'PaymentMethod-paymentMethodId-2',
    ]);
    expect(column('PaymentMethod', 'externalID', options)[0]).toBe('PaymentMethod-externalID-0');
  });

  it('leaves everything that is not an identifier alone', () => {
    const labels = column('PaymentMethod', 'label', { stableIds: true });
    for (const label of labels) expect(label).not.toContain('PaymentMethod-');
  });

  it('skips an identifier-shaped field it cannot write a string to', () => {
    const options = { stableIds: true };
    // An Int, an enum and a list all end in `Id`/`ID` here, and a stable id is a string — so
    // writing one would hand back data the schema rejects.
    for (const value of column('PaymentMethod', 'accountNumber', options)) {
      expect(typeof value).toBe('number');
    }
    for (const value of column('PaymentMethod', 'statusId', options)) {
      expect(['OPEN', 'CLOSED']).toContain(value);
    }
    for (const value of column('PaymentMethod', 'tagIds', options)) {
      expect(Array.isArray(value)).toBe(true);
    }
  });

  it('applies idPrefix to every identifier field', () => {
    const options = { stableIds: true, idPrefix: 'a-' };
    expect(column('PaymentMethod', 'id', options)[0]).toBe('a-PaymentMethod-0');
    expect(column('PaymentMethod', 'paymentMethodId', options)[0]).toBe(
      'a-PaymentMethod-paymentMethodId-0',
    );
  });

  it('lets an overrides entry keep a recognized field random', () => {
    const options: BuildMocksOptions = {
      stableIds: true,
      overrides: { PaymentMethod: { paymentMethodId: () => 'mine' } },
    };
    expect(column('PaymentMethod', 'paymentMethodId', options)).toEqual(['mine', 'mine', 'mine']);
    expect(column('PaymentMethod', 'id', options)[0]).toBe('PaymentMethod-0');
  });
});

describe('stableIds naming the identifier field', () => {
  it('covers a field the convention does not recognize', () => {
    expect(column('Currency', 'code', { stableIds: ['code'] })).toEqual([
      'Currency-code-0',
      'Currency-code-1',
      'Currency-code-2',
    ]);
  });

  it('still covers the recognized fields, which a list adds to rather than replaces', () => {
    const options = { stableIds: ['code'] };
    expect(column('PaymentMethod', 'id', options)[0]).toBe('PaymentMethod-0');
    expect(column('PaymentMethod', 'paymentMethodId', options)[0]).toBe(
      'PaymentMethod-paymentMethodId-0',
    );
  });

  it('names the field per type, leaving the same name on another type alone', () => {
    const options = { stableIds: { Currency: ['code'] } };
    expect(column('Currency', 'code', options)[0]).toBe('Currency-code-0');
    expect(column('Country', 'code', options)[0]).not.toContain('Country-code-');
  });

  it('covers the types the map does not name through _default', () => {
    const options = { stableIds: { _default: ['code'], Currency: [] } };
    expect(column('Country', 'code', options)[0]).toBe('Country-code-0');
    expect(column('Currency', 'code', options)[0]).not.toContain('Currency-code-');
  });

  it('is off entirely without stableIds', () => {
    for (const id of column('PaymentMethod', 'id')) expect(id).not.toContain('PaymentMethod-');
    expect(column('PaymentMethod', 'id', { stableIds: false })[0]).not.toBe('PaymentMethod-0');
  });
});
