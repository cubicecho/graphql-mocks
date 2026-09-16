import { ApolloLink, Observable } from '@apollo/client';
import type { MockHandlerOptions, MockRequestHandler } from '../requestHandler.js';
import type { MockResult } from '../types.js';

/**
 * Wrap a mock graph (or an existing handler) in an `ApolloLink`, so an `ApolloClient` resolves
 * every operation from the graph with no per-operation registration:
 *
 * ```ts
 * const mocks = buildMocks(schema);
 * const client = new ApolloClient({ cache: new InMemoryCache(), link: mockLink(mocks) });
 * ```
 *
 * Pass a `MockResult` to build a handler with `options`, or a handler you already hold when you
 * need its `calls` / `reset()` surface:
 *
 * ```ts
 * const handler = mocks.toRequestHandler({ overrides: [{ match: 'Users', loading: true }] });
 * const link = mockLink(handler);
 * ```
 *
 * `ApolloLink` and `Observable` are both imported from `@apollo/client` itself, so this module
 * works on the majors that ship zen-observable and those that ship RxJS without caring which.
 */
export function mockLink(
  source: MockResult | MockRequestHandler,
  options: MockHandlerOptions = {},
): ApolloLink {
  const handler = typeof source === 'function' ? source : source.toRequestHandler(options);

  return new ApolloLink(
    (operation) =>
      new Observable((subscriber) => {
        let unsubscribed = false;
        handler({
          query: operation.query,
          variables: operation.variables,
          operationName: operation.operationName,
        }).then(
          (result) => {
            if (unsubscribed) return;
            // The handler's result is a plain GraphQL response; Apollo's own payload type
            // differs across majors, so widen through the subscriber rather than naming it.
            subscriber.next(result as Parameters<typeof subscriber.next>[0]);
            subscriber.complete();
          },
          (error: unknown) => {
            if (!unsubscribed) subscriber.error(error);
          },
        );
        // A cancelled operation must not push into a torn-down subscriber. There is no timer to
        // clear: a `loading` override never schedules one.
        return () => {
          unsubscribed = true;
        };
      }),
  );
}

export type { MockHandlerOptions, MockRequestHandler } from '../requestHandler.js';
