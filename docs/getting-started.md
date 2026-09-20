# How to use this library

A task-ordered walkthrough: from `npm install` to a component rendering against a
mock graph, with the options you are most likely to reach for in between. Every
section links into [the full runtime reference](../packages/graphql-mocks/README.md),
which documents each option exhaustively — this page is the path through it.

- [What it does](#what-it-does)
- [Install](#install)
- [1. Build a pool](#1-build-a-pool)
- [2. Answer an operation](#2-answer-an-operation)
- [3. Render a component against it](#3-render-a-component-against-it)
- [4. Type the pools](#4-type-the-pools)
- [5. Shape the data](#5-shape-the-data)
- [6. Cover the states that break things](#6-cover-the-states-that-break-things)
- [Things that surprise people](#things-that-surprise-people)
- [Where to go next](#where-to-go-next)

## What it does

You hand it a `GraphQLSchema` (or a string of SDL) and it hands back a **graph**:
a pool of mock objects per type, with relationship fields wired as real object
references. `todo.user` is the same object as `mocks.User[i]` — not a copy of it,
and not a fresh random `User`.

That one property is what the rest of the library is built on. Because the data
is a graph rather than a pile of unrelated fixtures, an arbitrary query can be
answered from it: you write the query your component already writes, and the
selection set decides what comes back.

What it is **not**: a server. Mutations resolve, but never write to the pool, and
there is no persistence between calls. If you need a stateful fake backend, keep
your own state and answer from it — see [override functions](../packages/graphql-mocks/README.md#a-transport-for-any-operation).

## Install

```bash
npm install --save-dev @vantreeseba/graphql-mocks
# peer deps
npm install --save-dev graphql @faker-js/faker
# optional — only for the /apollo subpath (mockLink, createMockClient, withGraphqlMocks)
npm install --save-dev @apollo/client
```

ESM only, TypeScript 5, `graphql >= 16`. The root entry never imports
`@apollo/client`, so you only need it if you use the `/apollo` exports.

## 1. Build a pool

```ts
import { buildMocks } from '@vantreeseba/graphql-mocks';
import { schema } from './schema';

const mocks = buildMocks(schema, { seed: 42, count: 10, stableIds: true });

mocks.User;                    // 10 User objects (unknown[] until you type them — see below),
                               // and mocks.Todo[0].user is one of them, not a copy
mocks.at('User', 0);
mocks.byId('User', 'User-2');
mocks.ids('User');             // ['User-0', 'User-1', …] in generation order
mocks.find<User>('User', (u) => u.name.startsWith('A'));
```

Three options are worth setting from the start:

- **`seed`** makes the whole build reproducible. Every draw — including the ones
  your own `overrides` and `scalars` functions make, since they are handed the
  library's seeded faker — comes from this one number. Without it, a snapshot
  test is a coin flip.
- **`count`** sizes the pools: a number for every type, or
  `{ User: 10, Todo: 50, _default: 5 }` per type.
- **`stableIds`** turns identifier fields into readable, collision-free values
  instead of random scalars, which is what makes `byId` and argument matching
  pleasant to write by hand. `id` becomes `User-0`, `User-1`; any other field the
  library reads as an identifier (`paymentMethodId`, or a name you list yourself
  with `stableIds: ['code']`) becomes `PaymentMethod-paymentMethodId-0`.

## 2. Answer an operation

`dataForOperation` runs a document against the graph and returns data shaped to
the selection set — root fields picked from the pools by return type, nested
fields followed through the wired references:

```ts
const data = mocks.dataForOperation(UserByIdQuery);
// { user: { id, name, todos: [{ id, title }] } } — exactly the fields queried
```

Fragments, lists, and interface/union fields all work; with a `TypedDocumentNode`
the return type is inferred from the document. Required variables are auto-filled
with placeholders just so execution succeeds — by default they do **not** select
data. See [argument matching](#arguments-do-nothing-until-you-ask) for turning
that on.

When you want one callable that answers *every* operation instead of one at a
time, take a request handler:

```ts
const handler = mocks.toRequestHandler();
const { data } = await handler({ query: UsersQuery });

handler.calls;   // every operation it saw, in order
handler.reset(); // clears the memo, the calls and consumed `once` overrides
```

Results memoize per document + variables, so a refetch returns the same rows
rather than a fresh random draw.

## 3. Render a component against it

### An Apollo client, for a test or a story

```tsx
import { ApolloProvider } from '@apollo/client';
import { createMockClient } from '@vantreeseba/graphql-mocks/apollo';

const client = createMockClient(mocks, { delay: 300 });

render(
  <ApolloProvider client={client}>
    <Screen />
  </ApolloProvider>,
);
```

`createMockClient` is `mockLink` plus the boilerplate around it: a fresh
`InMemoryCache` per call, and `fetchPolicy: 'no-cache'` / `errorPolicy: 'all'` so
you see what the mocks return and an error arrives as a state to render rather
than an unhandled rejection. `defaultOptions` merges over those as a deep
partial — `{ query: { fetchPolicy: 'cache-first' } }` keeps the rest, and
`{ mutate: { errorPolicy: 'all' } }` on its own is a whole valid value.

If you want the handler's spy surface, build one and pass it instead:
`createMockClient(mocks.toRequestHandler({ … }))`.

### `MockedProvider`, when you need per-operation mocks

```tsx
<MockedProvider mocks={[mocks.mockOperation(UserByIdQuery)]} />
```

`mocks.mockOperation(doc, options?)` resolves its result data from the graph, so
the query's own selection set selects the mocks and you write no fixture.
`mockOperationVariants` gives you the `withResults` / `withLongLoadTime` /
`withError` trio for the same document.

To assert on what a mock carries, unwrap it with `dataOf` rather than reading
`mock.result?.data?.…` — that chain's fallback turns a renamed field into an
empty result instead of an error:

```ts
const posts = dataOf(m.withResults).searchPosts.results;
```

### Storybook

```tsx
// .storybook/preview.tsx
import { withGraphqlMocks } from '@vantreeseba/graphql-mocks/apollo';

export const decorators = [
  withGraphqlMocks((options) => buildMocks(schema, { seed: 42, ...options }), {
    wrap: (client, Story) => (
      <ApolloProvider client={client}>
        <Story />
      </ApolloProvider>
    ),
  }),
];

// SomeScreen.stories.tsx
export const Loading = { parameters: { graphqlMocks: 'loading' } };
export const Empty = { parameters: { graphqlMocks: { build: { count: 0 } } } };
export const LongText = { parameters: { graphqlMocks: { qa: 'longText' } } };
```

Every story gets the default client; the `graphqlMocks` parameter picks a state,
rebuilds the graph with different options, or opts one story out with `false`.
Pass the *factory* form above rather than a built graph when stories need to
rebuild — that is what `build` and `qa` parameters act on. The decorator stays
React-free on purpose (the renderer churns across Storybook majors), so `wrap` is
yours; the parameter parsing, the scenario states and the client memo are not.

When a set of stories varies one shared base parameter, derive it with
`withState(base, 'loading')` / `withQa(base, 'longText')` rather than re-stating
a short form — those keep the base's `overrides`, `target` and `build`, which
`'loading'` on its own silently drops.

## 4. Type the pools

Pools are `unknown[]` until you say otherwise. Pass a type map:

```ts
const mocks = buildMocks<{ User: User; Todo: Todo }>(schema);
```

Writing that map by hand for a real schema is a chore, so the companion codegen
plugin emits it:

```ts
// codegen.ts
'./src/__generated__/schema-type-map.ts': {
  plugins: ['@vantreeseba/graphql-mocks-codegen'],
},
```

```ts
import type { SchemaTypeMap } from './__generated__/schema-type-map';

const mocks = buildMocks<SchemaTypeMap>(schema);
mocks.User;                        // User[], no cast
mocks.find('Todo', (t) => t.done); // Todo | undefined
```

The map is worth the setup beyond the pools themselves: with it, `count`,
`overrides`, `derive`, `relations` and `countFields` all autocomplete their type
and field keys and check their return types against the schema.

## 5. Shape the data

Realistic-but-arbitrary data gets you a rendering component. Making it say
something specific is four options, in the order you will need them:

```ts
buildMocks(schema, {
  // 1. scalars: how a scalar type is generated, everywhere it appears
  scalars: { DateTime: (f) => f.date.recent().toISOString() },

  // 2. overrides: one field of one type, while the instance is being built
  overrides: { User: { name: () => 'Alice', loginCount: (f, { index }) => index } },

  // 3. relations: how big relationship fields are, after every pool exists
  relations: { User: { todos: { min: 1, max: 3 } }, Query: { users: 3 } },

  // 4. derive: a field computed from the finished object, last of all
  derive: { User: { fullName: (self) => `${self.firstName} ${self.lastName}` } },
});
```

The ordering is the whole distinction between 2 and 4: an `overrides` function
fires while the instance is half-built and cannot see its siblings, while a
`derive` function runs after scalars, overrides, relationships and reciprocal
mirroring, so `self` is the finished object. Anything that is a function of the
rest of the object — a total, an assembled name, a difference — belongs in
`derive`.

`relations` also takes `null` (empty), `'all'` (the whole target pool), a number,
or a function that picks from `ctx.pool`; it reaches root fields through the
operation type (`{ Query: { users: 3 } }`), and pools grow to meet demand.

`relations` only reaches relationship fields. To size a list of scalars or enums
— `tags: [String!]!`, `colours: [Colour!]!` — use `listSize`, which takes the
same per-type, per-field shape and sizes *every* list in the graph:

```ts
buildMocks(schema, {
  listSize: { Post: { tags: 2, _default: 4 }, _default: { min: 1, max: 5 } },
});
```

A flat `listSize: 3` or `listSize: { min: 2, max: 4 }` still covers everything.
A named entry beats the QA `lists` profile; a `relations` entry beats both for a
relationship field. `listSize` never grows a pool — raise `count` for that.

Those lists hold **distinct** values: scalar and enum lists are drawn without
replacement, like relationship lists, so nothing a component keys by repeats. The
length gives way to that — `colours: [Colour!]!` over a three-value enum yields
at most three entries whatever `listSize` says. `uniqueLists: false`, or
`uniqueLists: { Post: { tags: false } }`, asks for the repeats back.

For wrapper and connection types, `countFields: true` pairs each count scalar
with the list it counts and sizes that list to the pool, so `totalCount` is a
total of something a pager can actually page through:

```ts
buildMocks(schema, { count: { _default: 40 }, countFields: true });
// ProductSearchResult.results    -> all 40 pooled products
// ProductSearchResult.totalCount -> 40
```

Once a combination is worth a name, make it a **scenario** — a partial config you
can pass around and layer:

```ts
export const scenarios = defineScenarios({
  newUser: { count: { User: 1 }, relations: { User: { todos: null } } },
  powerUser: { relations: { User: { todos: 200 } } },
});

buildMocks(schema, { scenario: scenarios.newUser, seed: 42 });
```

## 6. Cover the states that break things

**Loading and error**, for one operation or all of them:

```ts
import { mockScenarios } from '@vantreeseba/graphql-mocks';

const states = mockScenarios({}, 'UserById'); // omit the target for every operation
mocks.toRequestHandler(states.loading);       // never settles, schedules no timer
mocks.toRequestHandler(states.errored);       // { data: null, errors }
```

**Data that isn't nice.** Realistic data never finds the bug where a 400-character
product name blows out a flex row, or an empty list renders blank instead of an
empty state. The `qa` option swaps the generators for deliberately out-of-norm
ones across text, lists, nulls, numbers and dates:

```ts
buildMocks(schema, { seed: 42, qa: 'longText' });
buildMocks(schema, { seed: 42, qa: { text: 'unicode', lists: 'empty', nulls: 'mixed' } });
```

`buildQaSets(schema, { seed: 42 })` returns one pool per preset — a ready-made row
of Storybook variants — and `buildMatrix` crosses your scenarios with QA presets
when you want both axes at once.

## Things that surprise people

### Pooled objects are cyclic

`post.author` is a pooled `User` whose `posts` contains that same post. Anything
that walks a mock **generically** — `JSON.stringify`, a snapshot, a deep-equality
assertion, `structuredClone` — needs a cycle guard, or it ends in
`RangeError: Maximum call stack size exceeded`. Two exports are that guard:

```ts
import { select, toPlain } from '@vantreeseba/graphql-mocks';

JSON.stringify(toPlain(mocks.User[0]));      // cycle-free deep copy
select(mocks.User[0], UserRowFragmentDoc);   // shaped to a document's selection set
```

Data that came out of `dataForOperation` or a request handler is already
acyclic — only the pools themselves need this.

### Arguments do nothing until you ask

Argument matching is opt-in, because guessing what an argument means is how a
mock library starts lying to you:

```ts
buildMocks(schema, { matchArguments: true });
```

With it on, three buckets are interpreted — equality against a same-named field,
search arguments, and paging — and everything else is ignored. Arguments bound to
variables the library auto-filled are ignored too, so `mocks.mockOperation(UserByIdQuery)`
with no variables still returns a pooled item rather than nothing.

For a field whose argument only *you* can interpret — an enum like
`where: LOW_STOCK` — use `argOverrides`, which answers that one field by its
argument values while everything else still resolves from the graph.

### A mock resolver one level too deep fails silently

Apollo invokes `result` only when `result` itself is a function. A function at
`result.data` is never called: the mock matches, the component renders nothing,
and nothing warns.

```ts
{ request, result: { data: (vars) => ({ … }) } } // never invoked
{ request, result: (vars) => ({ data: { … } }) } // what Apollo calls
```

`mockOperation(Doc, (vars) => data)` builds the second shape. For mocks you wrote
by hand, point `validateMocks` at the module and let it find this and the other
quiet failures:

```ts
import * as mocks from './mocks/index.js';
import { assertValidMocks } from '@vantreeseba/graphql-mocks';

it('every mock is well formed', () => assertValidMocks(mocks));
```

It reports every problem rather than stopping at the first, and both of its walks
are cycle-safe, so a module can export a built pool alongside the mocks built
from it.

### Empty means empty

Nothing produces an empty list from a non-empty pool unless something asked for
one — `qa: { lists: 'empty' }`, or a `relations` entry of `0` or `null`. So an
empty state stays empty, including through paging and wrapper types. To empty a
type everywhere it appears, set its pool to zero instead: `count: { Product: 0 }`.

## Where to go next

- [Runtime reference](../packages/graphql-mocks/README.md) — every option, the
  argument-matching rules, the request handler, QA presets, scenarios, typed
  pools, and the full options table.
- [Codegen plugin](../packages/graphql-mocks-codegen/README.md) — generating the
  `SchemaTypeMap` and configuring the plugin.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — working on the repo itself.
