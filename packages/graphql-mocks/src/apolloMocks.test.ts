import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import { dataOf, mockOperation, mockOperationVariants } from './apolloMocks.js';

type AwardData = { award: { id: string } | null };
type AwardVars = { id: string };

const AwardByIdQuery = parse(
  'query AwardById($id: ID!) { award(id: $id) { id } }',
) as TypedDocumentNode<AwardData, AwardVars>;

const AnonymousQuery = parse('{ award { id } }') as TypedDocumentNode<AwardData, AwardVars>;

const data: AwardData = { award: { id: 'Award-0' } };

type Expect<T extends true> = T;
type Equals<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
  ? true
  : false;

describe('mockOperation', () => {
  it('produces a MockedProvider entry with the query and data', () => {
    const mock = mockOperation(AwardByIdQuery, data);
    expect(mock.request.query).toBe(AwardByIdQuery);
    expect(mock.result).toEqual({ data });
    expect(mock.error).toBeUndefined();
    expect(mock.delay).toBeUndefined();
  });

  it('defaults maxUsageCount to Infinity so one mock covers any number of uses', () => {
    expect(mockOperation(AwardByIdQuery, data).maxUsageCount).toBe(Number.POSITIVE_INFINITY);
  });

  it('defaults variables to a matcher that accepts any variables', () => {
    const { variables } = mockOperation(AwardByIdQuery, data).request;
    expect(typeof variables).toBe('function');
    if (typeof variables === 'function') {
      expect(variables({ id: 'anything' })).toBe(true);
    }
  });

  it('passes through concrete variables, delay, error, and maxUsageCount', () => {
    const error = new Error('boom');
    const mock = mockOperation(AwardByIdQuery, data, {
      variables: { id: 'Award-0' },
      delay: 50,
      error,
      maxUsageCount: 2,
    });
    expect(mock.request.variables).toEqual({ id: 'Award-0' });
    expect(mock.delay).toBe(50);
    expect(mock.error).toBe(error);
    expect(mock.maxUsageCount).toBe(2);
  });
});

describe('mockOperationVariants', () => {
  it('returns success, long-load, and error variants', () => {
    const variants = mockOperationVariants(AwardByIdQuery, data);

    expect(variants.withResults.result).toEqual({ data });
    expect(variants.withResults.delay).toBeUndefined();

    expect(variants.withLongLoadTime.delay).toBe(1_000_000);

    expect(variants.withError.error).toBeInstanceOf(Error);
    expect(variants.withError.error?.message).toContain('AwardById');
  });

  it('uses a provided error for the error variant', () => {
    const error = new Error('custom');
    const variants = mockOperationVariants(AwardByIdQuery, data, { error });
    expect(variants.withError.error).toBe(error);
  });

  it('labels the generated error "anonymous" for unnamed operations', () => {
    const variants = mockOperationVariants(AnonymousQuery, data);
    expect(variants.withError.error?.message).toContain('anonymous');
  });

  it('threads options into every variant', () => {
    const variants = mockOperationVariants(AwardByIdQuery, data, { maxUsageCount: 3 });
    expect(variants.withResults.maxUsageCount).toBe(3);
    expect(variants.withLongLoadTime.maxUsageCount).toBe(3);
    expect(variants.withError.maxUsageCount).toBe(3);
  });
});

describe('mockOperation with a resolver function', () => {
  const resolver = (vars: AwardVars): AwardData => ({ award: { id: vars.id } });

  it('produces a result function that is called with the incoming variables', () => {
    const mock = mockOperation(AwardByIdQuery, resolver);
    expect(typeof mock.result).toBe('function');
    expect(mock.result?.({ id: 'Award-7' })).toEqual({ data: { award: { id: 'Award-7' } } });
  });

  it('keeps the same envelope options as the static form', () => {
    const mock = mockOperation(AwardByIdQuery, resolver, { delay: 5, maxUsageCount: 2 });
    expect(mock.request.query).toBe(AwardByIdQuery);
    expect(mock.delay).toBe(5);
    expect(mock.maxUsageCount).toBe(2);
  });

  it('calls the resolver once per request rather than once up front', () => {
    let calls = 0;
    const mock = mockOperation(AwardByIdQuery, (vars: AwardVars) => {
      calls += 1;
      return { award: { id: vars.id } };
    });
    expect(calls).toBe(0);
    mock.result?.({ id: 'a' });
    mock.result?.({ id: 'b' });
    expect(calls).toBe(2);
  });

  it('keeps the static overload for plain data, even when data has function-valued fields', () => {
    // A plain object must never select the dynamic signature.
    const mock = mockOperation(AwardByIdQuery, data);
    expect(mock.result).toEqual({ data });
  });

  it('produces resolver-form variants', () => {
    const variants = mockOperationVariants(AwardByIdQuery, resolver);
    expect(variants.withResults.result?.({ id: 'x' })).toEqual({ data: { award: { id: 'x' } } });
    expect(variants.withLongLoadTime.delay).toBe(1_000_000);
    expect(variants.withError.error?.message).toContain('AwardById');
    // The same resolver backs every variant.
    expect(variants.withError.result?.({ id: 'y' })).toEqual({ data: { award: { id: 'y' } } });
  });
});

describe('mockOperation overload types', () => {
  // Compile-time guards, enforced by `npm run typecheck:tests`: adding the resolver form must
  // not widen `result` into a union, because consumers read `mock.result?.data` directly.
  it('keeps result.data typed on the static overload', () => {
    const mock = mockOperation(AwardByIdQuery, data);
    const isStatic: Expect<Equals<typeof mock.result, { data?: AwardData } | undefined>> = true;
    expect(isStatic).toBe(true);
  });

  it('types the resolver overload result as a function of the variables', () => {
    const mock = mockOperation(AwardByIdQuery, (vars: AwardVars) => ({ award: { id: vars.id } }));
    const isDynamic: Expect<
      Equals<typeof mock.result, ((variables: AwardVars) => { data?: AwardData }) | undefined>
    > = true;
    expect(isDynamic).toBe(true);
  });
});

describe('dataOf', () => {
  it('returns the data a static mock carries, without an optional chain', () => {
    const mock = mockOperation(AwardByIdQuery, data);
    expect(dataOf(mock)).toBe(data);
    // The point of the helper: `award` is reachable without `?.` and without a `?? null`.
    const unwrapped = dataOf(mock);
    const isData: Expect<Equals<typeof unwrapped, AwardData>> = true;
    expect(isData).toBe(true);
  });

  it('reads the success and long-load variants, which carry the same data', () => {
    const variants = mockOperationVariants(AwardByIdQuery, data);
    expect(dataOf(variants.withResults)).toBe(data);
    expect(dataOf(variants.withLongLoadTime)).toBe(data);
  });

  it('resolves the dynamic form against the variables it is given', () => {
    const mock = mockOperation(AwardByIdQuery, (vars: AwardVars) => ({ award: { id: vars.id } }));
    expect(dataOf(mock, { id: 'Award-7' })).toEqual({ award: { id: 'Award-7' } });
  });

  it('defaults the variables to an empty object for a resolver that ignores them', () => {
    const mock = mockOperation(AwardByIdQuery, () => data);
    expect(dataOf(mock)).toBe(data);
  });

  it('re-resolves on every call, the way Apollo would', () => {
    let calls = 0;
    const mock = mockOperation(AwardByIdQuery, () => {
      calls += 1;
      return data;
    });
    dataOf(mock);
    dataOf(mock);
    expect(calls).toBe(2);
  });

  it('throws for the error variant, naming the operation and the error', () => {
    const variants = mockOperationVariants(AwardByIdQuery, data);
    expect(() => dataOf(variants.withError)).toThrow(/"AwardById"/);
    expect(() => dataOf(variants.withError)).toThrow(/is an error variant/);
  });

  it('throws for an envelope assembled without a result', () => {
    expect(() => dataOf({ request: { query: AwardByIdQuery } })).toThrow(/has no result/);
  });

  it('throws when the result resolves without data', () => {
    expect(() => dataOf({ request: { query: AwardByIdQuery }, result: {} })).toThrow(
      /resolved to a result with no data/,
    );
  });

  it('says "anonymous" for an unnamed operation', () => {
    expect(() => dataOf({ request: { query: AnonymousQuery } })).toThrow(/"anonymous"/);
  });
});
