# @vantreeseba/graphql-mocks

Generate realistic, graph-connected mock data from a GraphQL schema using faker.

Relationships are wired as actual object references — `todo.user` is the same object as `mocks.User[i]`, not a copy. Useful for tests, Storybook stories, and demos.

## Install

```bash
npm install @vantreeseba/graphql-mocks
# peer deps
npm install graphql @faker-js/faker
# optional — only for the /apollo link export
npm install @apollo/client
```

## Usage

### Basic

```ts
import { buildMocks } from '@vantreeseba/graphql-mocks';
import { schema } from './schema'; // your GraphQLSchema

const mocks = buildMocks(schema);

mocks.User   // unknown[] — 5 User objects
mocks.Todo   // unknown[] — 5 Todo objects, each .user points into mocks.User
```

### SDL string input

```ts
const mocks = buildMocks(`
  type User { id: ID!, name: String!, email: String! }
  type Todo { id: ID!, title: String!, user: User! }
  type Query { users: [User!]! }
`);
```

### Count, seed, nullChance

```ts
const mocks = buildMocks(schema, {
  seed: 42,                                   // deterministic output
  count: { User: 10, Todo: 50, _default: 5 }, // per-type counts
  nullChance: 0.1,                            // 10% chance nullable fields are null
});
```

### Custom scalar mockers

```ts
import { faker } from '@faker-js/faker';

const mocks = buildMocks(schema, {
  faker,
  scalars: {
    DateTime: (f) => f.date.recent().toISOString(),
    CityName: (f) => f.location.city(),
    Rating:   (f) => f.number.int({ min: 1, max: 5 }),
  },
});
```

### Field overrides

```ts
const mocks = buildMocks(schema, {
  seed: 42,
  overrides: {
    User: {
      name:   () => 'Alice',
      avatar: (faker) => faker.image.avatar(), // receives the same seeded faker
    },
  },
});
```

Override functions are passed the generator's faker instance, so they stay deterministic under `seed` without importing a separate faker, plus the site they're firing at — `{ index, typeName, fieldName }`, where `index` is the instance's position in its own pool (the same number `stableIds` uses). That makes per-instance cohorts a one-liner:

```ts
const mocks = buildMocks(schema, {
  overrides: {
    User: { loginCount: (faker, { index }) => (index === 0 ? 0 : faker.number.int(500)) },
  },
});
```

### `__typename` and stable ids

Every object gets a `__typename` by default (the Apollo cache needs it). Turn it off with `addTypename: false`. Enable `stableIds` to give each object with an `id` field a readable, collision-free `TypeName-<index>` id instead of a random scalar:

```ts
const mocks = buildMocks(schema, { stableIds: true });
mocks.User[0]; // { __typename: 'User', id: 'User-0', ... }
```

An explicit `overrides` entry for `id` still wins over `stableIds`.

### Interfaces / unions

```ts
const mocks = buildMocks(schema, {
  resolveType: (abstractTypeName) => {
    if (abstractTypeName === 'SearchResult') return 'Post';
    return 'User';
  },
});
```

### Helpers

```ts
// Find a specific item. With a typed map (see Typed pools) the item is inferred:
const user = mocks.find('User', (u) => u.id === targetId);
// Without a typed map, pass the type explicitly:
const user2 = mocks.find<User>('User', (u) => u.id === targetId);

// Apollo Server / GraphQL Yoga mock resolvers
const resolvers = mocks.toResolvers();
// { User: () => <random User from pool>, Todo: () => <random Todo>, ... }
addMocksToSchema({ schema, mocks: resolvers });

// Resolve a query/mutation against the graph — data is shaped to the selection set.
// Root fields are picked from the pools by return type; nested fields follow the
// already-wired references. No need to assemble the response by hand.
const data = mocks.dataForOperation(UserByIdQuery);
// { user: { id, name, posts: [{ id, author: { id } }] } } — exactly the fields queried
```

`dataForOperation` understands lists, fragments, and interface/union fields (resolved via each mock's `__typename`). Variables are optional — any required ones are auto-filled with placeholders just so execution succeeds. By default they don't influence which mocks are chosen; turn on [argument matching](#argument-matching) to make them select data. With a `TypedDocumentNode` the return type is inferred from the document.

## Apollo `MockedProvider`

These helpers turn a `TypedDocumentNode` into an entry for Apollo's `MockedProvider` `mocks` array — no hand-written `request`/`result` boilerplate.

Call them off the `mocks` graph (`mocks.mockOperation`) and you need **no data argument at all**: the result is resolved straight from the graph (via `dataForOperation`), so the query's own selection set decides which mocks come back. The pool is already captured, so you just pass the document:

```tsx
import { MockedProvider } from '@apollo/client/testing';
import { buildMocks } from '@vantreeseba/graphql-mocks';
import { AwardByIdQuery } from './graphql';

const mocks = buildMocks<SchemaTypeMap>(schema);

render(
  <MockedProvider mocks={[mocks.mockOperation(AwardByIdQuery)]}>
    <AwardCard />
  </MockedProvider>,
);
```

Prefer to supply the data yourself? The standalone `mockOperation` takes the result data directly; the result/variables types are inferred from the document, so `data` is type-checked against the operation's result type:

```ts
import { mockOperation } from '@vantreeseba/graphql-mocks';

mockOperation(AwardByIdQuery, { award: mockAwards[0], __typename: 'Query' });
```

By default a mock matches **any** variables and may be used any number of times (`maxUsageCount: Infinity`). Override per call when you need exact matching, a delay, or an error (the same `options` apply to every helper here):

```ts
mocks.mockOperation(AwardByIdQuery, {
  variables: { id: 'Award-0' }, // exact match (or a predicate (vars) => boolean)
  delay: 50,
  maxUsageCount: 1,
});
```

For the common "success / loading / error" trio, `mockOperationVariants` returns all three at once — `mocks.mockOperationVariants` resolves the success data from the graph, while the standalone `mockOperationVariants(operation, data)` takes it directly:

```ts
const m = mocks.mockOperationVariants(AwardByIdQuery);
m.withResults;      // resolves with data drawn from the pool
m.withLongLoadTime; // stays pending — drive loading states
m.withError;        // rejects with an error naming the operation
```

`@graphql-typed-document-node/core` (bundled with Apollo Client and graphql-codegen) provides the `TypedDocumentNode` type; it's an optional peer, only needed if you use these helpers.

## Argument matching

By default arguments don't influence which mocks come back — `user(id: "abc")` returns a random pooled user. Set `matchArguments` (on `buildMocks`, on a handler, or per call) and arguments that land in one of three narrow buckets start selecting data:

```ts
const mocks = buildMocks(schema, { matchArguments: true, stableIds: true });

mocks.dataForOperation(parse('{ user(id: "User-2") { id name } }'));
// { user: { id: 'User-2', … } }

mocks.dataForOperation(parse('{ users(skip: 10, limit: 5) { id } }'));
// the 11th–15th pooled users, in stable order

mocks.dataForOperation(parse('{ posts(titleContains: "graph") { id title } }'));
// only posts whose title contains "graph"
```

| Bucket | Matches | Example |
|--------|---------|---------|
| Equality | An argument named **exactly** like a scalar/enum field on the return type | `todos(priority: HIGH)`, `user(id: …)` |
| Search | `search`, `query`, `q`, `filter`, `searchTerm`, `term`, or `<field>Contains` / `<field>_contains` | `users(search: "ana")` |
| Paging | `skip`/`offset` plus `limit`/`first`/`take`, on list return types | `users(skip: 10, limit: 5)` |

There is deliberately **no fuzzy matching** — no `authorId → author.id`, no snake/camel bridging, no suffix stripping. One inference is allowed: a list argument whose name minus a trailing `s` names a non-list scalar field (`ids: [ID!]` → `id`) becomes an `in` match. Anything else is ignored, exactly as with the flag off, because a wrong guess produces a silently empty screen.

Every list name is configurable, and matching can be narrowed by bucket:

```ts
buildMocks(schema, {
  matchArguments: {
    paging: true,
    search: true,
    equality: false,
    nested: true,               // user { posts(first: 2) } — on by default
    limitArgs: ['limit', 'pageSize'],
    ignoreArgs: ['locale'],
    onMiss: { singular: 'fallback', list: 'empty' },
  },
});
```

**Variables you didn't supply are ignored.** Required variables are auto-filled so execution can run, and any argument bound to one of those invented values is dropped — so `mocks.mockOperation(UserByIdQuery)` with no variables still returns a random pooled user, exactly as with matching off. A variable you pass, a literal, or a schema/document default counts as intent and is applied.

**When nothing matches:**

- A **list** returns `[]`. An empty result is a wanted state — the most common empty-state story — and falling back would return rows that visibly contradict the filter.
- A **nullable singular** field falls back to the random pick. A miss means "you named an id we never generated"; `null` would turn a working screen into an unrequested not-found path. Set `onMiss: { singular: 'empty' }` if you want the not-found path.
- A **non-null singular** field always falls back, whatever `onMiss` says — `null` there is a GraphQL error plus a warning, which is strictly worse than a random item.
- **Paging** never falls back: `skip: 100` over 5 items legitimately yields `[]`.

Paging switches the source from a random subset to the whole pool in stable order, so pages line up. Pools hold `count` items (default 5) and lists draw `listSize` items (default 1–5) — raise both when you need more than one page:

```ts
buildMocks(schema, { count: 50, listSize: { min: 10, max: 20 }, matchArguments: true });
```

### Wrapper and connection types

Most paginated APIs don't return the list directly — they wrap it:

```graphql
type Query { products(take: Int, skip: Int, search: String): ProductSearchResult! }
type ProductSearchResult { results: [Product!]!, totalCount: Int! }
```

The arguments are on the root field, but the rows to page are under `results`. So when a field returns an object that holds a list, matching is applied to the **list's** type and a copy of the wrapper comes back with that list replaced:

```ts
mocks.dataForOperation(parse('{ products(skip: 10, take: 5) { results { id } } }'));
// { products: { results: [ …the 11th–15th pooled products… ], totalCount: … } }
```

The list is drawn from the entity's own pool, in stable order — the same switch a direct list field makes when it is paged, so `skip: 10` has more than a handful of rows to page through. The pooled wrapper itself is never mutated.

Relay connections are recognized too: `edges` are filtered and paged by their `node`, rebuilt as edges (cursors and all), and `pageInfo` is brought in line with the page — `hasNextPage`, `hasPreviousPage`, `startCursor`, `endCursor`, but only the keys the schema actually declares.

The list is found by explicit config first, then the Relay shape, then **exactly one** object-typed list field. "Exactly one" is the safeguard: with two lists there is no way to tell which one `take` refers to, so nothing is guessed and the wrapper comes back as before. Scalar lists (`tags: [String!]`) are fields of the wrapper, not its rows, and don't count.

```ts
buildMocks(schema, {
  matchArguments: {
    unwrap: true,                              // on by default
    listPath: { ShelfResult: 'clearance' },    // or a bare 'results' for every wrapper
  },
});
```

A wrapper's own count scalars (`totalCount`) are left as generated — they reflect the pool, not the page.

## Resolver-function mocks

`mockOperation` and `mockOperationVariants` also take a function of the incoming variables, so one mock answers many variable combinations instead of one envelope per case:

```ts
mockOperation(UserByIdQuery, (vars) => ({ user: usersById[vars.id] }));
// → { request, result: (vars) => ({ data }) }
```

The static overload is unchanged: passing plain data still yields `result: { data }`, so existing `mock.result?.data` reads keep working and keep their types.

On the graph-bound form, pass `dynamic: true` to resolve from the graph **per request** — which is what lets real incoming variables reach argument matching even though `request.variables` matches anything:

```ts
mocks.mockOperation(SearchUsersQuery, { dynamic: true, matchArguments: true });
```

`transform: (data, variables) => data` post-processes whichever path runs, and `matchArguments` overrides the graph-wide setting for this operation only.

## A transport for any operation

`mocks.toRequestHandler()` answers **any** operation from the graph — no per-operation registration, so one handler covers a whole screen:

```ts
const handler = mocks.toRequestHandler();

const { data } = await handler({ query: UsersQuery });
const { data: one } = await handler({ query: UserByIdQuery, variables: { id } });
```

Results are memoized per document + variables, so a refetch or a second identical query in the same render tree returns the same rows instead of a fresh random draw (`memoize: false` to opt out). Only values produced by execution are returned — never a pooled object or anything reachable from one — so results are acyclic and safe to clone.

Overrides force specific operations into a state, first match wins:

```ts
const handler = mocks.toRequestHandler({
  delay: { min: 20, max: 80 },
  overrides: [
    { match: 'UserById', loading: true },                  // never settles, schedules no timer
    { match: TodosQuery, errors: 'Something went wrong' }, // { data: null, errors }
    { match: (op) => op.operationType === 'mutation', networkError: 'offline' }, // rejects
    { match: 'Users', data: (op, fromGraph) => ({ users: fromGraph.users.slice(0, 1) }) },
    { match: 'Users', errors: 'first time only', once: true },
  ],
});

handler.calls;  // every operation seen, in order: name, type, variables, document
handler.reset(); // clears the memo, the calls, and consumed `once` overrides
```

Mutations run through the same path and **never mutate the pool** — that would make stories order-dependent across re-renders and HMR, and real write semantics are app-specific. Close an override's `data` function over your own state when you need a write to stick.

### Apollo

`@vantreeseba/graphql-mocks/apollo` wraps a graph (or a handler) in an `ApolloLink`. `@apollo/client` is an **optional peer** (`>=3.8 <5`), so the root entry stays dependency-free:

```tsx
import { ApolloClient, ApolloProvider, InMemoryCache } from '@apollo/client';
import { buildMocks } from '@vantreeseba/graphql-mocks';
import { mockLink } from '@vantreeseba/graphql-mocks/apollo';

const mocks = buildMocks(schema, { seed: 1, stableIds: true });
const client = new ApolloClient({ cache: new InMemoryCache(), link: mockLink(mocks) });

render(
  <ApolloProvider client={client}>
    <Screen />
  </ApolloProvider>,
);
```

Pass a handler instead of a graph when you want its spy surface:

```ts
const handler = mocks.toRequestHandler({ overrides: [{ match: 'Users', loading: true }] });
const client = new ApolloClient({ cache: new InMemoryCache(), link: mockLink(handler) });
// …assert on handler.calls
```

## Story states

`mockScenarios` builds the three states a component is usually exercised in, from one base config:

```ts
import { mockScenarios } from '@vantreeseba/graphql-mocks';

const states = mockScenarios({ matchArguments: true });
// states.default | states.loading | states.errored — each MockHandlerOptions
```

Pass a target to put only some operations into the loading/error state, leaving the rest resolving normally — what a screen with one failing panel needs:

```ts
mockScenarios({}, 'UserById');              // one operation
mockScenarios({}, ['UserById', TodosQuery]); // several
mockScenarios({}, (op) => op.operationType === 'mutation');
```

There's no Storybook dependency and no CSF types here — the parameter key and the spread into a story belong to your Storybook addon, which churns across majors. A decorator is a few lines:

```tsx
// .storybook/preview.tsx
import { ApolloClient, ApolloProvider, InMemoryCache } from '@apollo/client';
import { buildMocks } from '@vantreeseba/graphql-mocks';
import { mockLink } from '@vantreeseba/graphql-mocks/apollo';
import { schema } from './schema';

export const decorators = [
  (Story, context) => {
    const mocks = buildMocks(schema, { seed: 1, stableIds: true, matchArguments: true });
    const client = new ApolloClient({
      cache: new InMemoryCache(),
      link: mockLink(mocks, context.parameters.graphqlMocks ?? {}),
    });
    return (
      <ApolloProvider client={client}>
        <Story />
      </ApolloProvider>
    );
  },
];
```

```tsx
// SomeScreen.stories.tsx
const states = mockScenarios({}, 'UserById');

export const Default = { parameters: { graphqlMocks: states.default } };
export const Loading = { parameters: { graphqlMocks: states.loading } };
export const Errored = { parameters: { graphqlMocks: states.errored } };
```

The same shape works in component tests:

```tsx
import { type MockHandlerOptions, buildMocks } from '@vantreeseba/graphql-mocks';

function renderWithMocks(ui: React.ReactElement, options: MockHandlerOptions = {}) {
  const mocks = buildMocks(schema, { seed: 1, stableIds: true, matchArguments: true });
  const handler = mocks.toRequestHandler(options);
  const client = new ApolloClient({ cache: new InMemoryCache(), link: mockLink(handler) });
  return { mocks, handler, ...render(<ApolloProvider client={client}>{ui}</ApolloProvider>) };
}
```

## Addressing pooled data

```ts
mocks.ids('User');            // ['User-0', 'User-1', …] in generation order
mocks.at('User', 0);          // the first pooled User
mocks.byId('User', 'User-2'); // looked up by id, compared as strings
```

`ids` needs no `TTypes` map to come back typed, which `at('User', 0)?.id` does under `noUncheckedIndexedAccess`:

```ts
const id = mocks.ids('User')[0] as string;
mocks.mockOperation(UserByIdQuery, { variables: { id }, matchArguments: true });
```

Pair it with `stableIds: true` for readable, stable values.

## Deriving mocks from a document module

```ts
import * as operations from './queries.generated';

const opMocks = mocks.mockOperationsFrom(operations);
opMocks.UserByIdDocument.withResults;
opMocks.TodosDocument.withError;
```

Keys are the module's **export names**, not operation names — operation names live only in the runtime AST, so keying by them would make the type unsound. Non-document exports are skipped. Entries are built lazily on first read, so a fifty-document module costs nothing at import time; spreading the map forces all of them, `Object.keys` does not.

## Collection helpers

The same primitives the argument engine uses, exported for the cases it can't reach:

```ts
import { paginate, searchItems } from '@vantreeseba/graphql-mocks';

paginate(mocks.User, { skip: 10, limit: 5 });  // also offset/first/take
searchItems(mocks.User, 'ana');                // every string field
searchItems(mocks.User, 'ana', ['name']);      // named fields only
```

Absent or null arguments are no-ops, so they're safe to apply unconditionally.
## QA mode

Mocks are realistic by default, and realistic data never finds the bug where a 400-character
product name blows out a flex row, or an empty list renders a blank panel instead of an empty
state. The `qa` option swaps the generators for deliberately out-of-norm ones, so the same
`buildMocks` call your story already makes can produce the data that breaks it.

```ts
// a named preset
const mocks = buildMocks(schema, { seed: 42, qa: 'longText' });

// or tune the dimensions yourself
const mocks = buildMocks(schema, {
  qa: { text: 'unicode', lists: 'huge', nulls: 'mixed', numbers: 'boundary' },
});
```

### Presets

`buildQaSets` generates one mock pool per preset — the shape Storybook and `MockedProvider`
want, one variant per row:

```ts
import { buildQaSets } from '@vantreeseba/graphql-mocks';

const sets = buildQaSets(schema, { seed: 42 });
// [{ name: 'emptyText', qa: { text: 'empty' }, mocks }, { name: 'whitespaceText', ... }, ...]

// or just the ones you care about
const sets = buildQaSets(schema, { seed: 42, profiles: ['emptyText', 'hugeLists'] });
```

| Preset | Config | What it stresses |
|---------|--------|------------------|
| `emptyText` | `{ text: 'empty' }` | Empty strings — labels, headings, alt text |
| `whitespaceText` | `{ text: 'whitespace' }` | Spaces, tabs, newlines, non-breaking spaces |
| `longText` | `{ text: 'long' }` | 1k-char unbroken tokens and long prose — overflow, truncation |
| `unicodeText` | `{ text: 'unicode' }` | ZWJ emoji, RTL, bidi, CJK, combining marks, zalgo |
| `injectionText` | `{ text: 'injection' }` | `<script>`, template syntax, path traversal — escaping |
| `emptyLists` | `{ lists: 'empty' }` | Empty states |
| `singleItemLists` | `{ lists: 'single' }` | "1 item" grammar, single-row layouts |
| `hugeLists` | `{ lists: 'huge' }` | 100-item lists — virtualization, pagination, perf |
| `allNulls` | `{ nulls: 'all' }` | Every nullable field null |
| `mixedNulls` | `{ nulls: 'mixed' }` | Partial nulls — the realistic failure mode |
| `zeroNumbers` | `{ numbers: 'zero' }` | `0` everywhere — division, percentages, empty totals |
| `negativeNumbers` | `{ numbers: 'negative' }` | Negative counts, prices, durations |
| `boundaryNumbers` | `{ numbers: 'boundary' }` | Int 32-bit limits, `MAX_SAFE_INTEGER`, `-0`, `0.1 + 0.2` |
| `extremeDates` | `{ dates: 'mixed' }` | Epoch, far past/future, leap day, DST transitions |
| `kitchenSink` | all of the above | Everything at once |

`QA_PROFILE_NAMES` and `QA_PROFILES` are exported if you want to build the list yourself.

### With Storybook + Apollo

```ts
const sets = buildQaSets(schema, { seed: 42, profiles: ['emptyText', 'longText', 'emptyLists'] });

export const QaVariants = sets.map((set) => ({
  name: set.name,
  parameters: { apolloClient: { mocks: [set.mocks.mockOperation(UsersQuery)] } },
}));
```

Each set is generated from its own faker instance seeded with `seed`, so a set reproduces
identically no matter which other presets ran alongside it — when one variant breaks, rerunning
just that preset gives you the same data back.

### Notes

- `scalars` and `overrides` still win. QA only replaces the generators you haven't defined
  yourself, so a field you pinned stays pinned.
- `ID` is left alone. Ids are graph identity and Apollo cache keys; mangling them would break
  wiring rather than test it.
- Values stay serializable by the built-in scalars (`Int` is clamped to its 32-bit range, for
  instance), but custom scalar *constraints* are deliberately not respected — a negative
  `NonNegativeInt` is the point, not a bug.
- `lists: 'huge'` raises the default `count` to `listSize` (100), because relationship lists are
  sampled from the pools without replacement. An explicit `count` still wins, which caps how long
  those lists can get.
- `qa: false` disables QA, handy when the preset comes from a variable.
- Pair it with a [scenario](#scenarios) to vary the state as well as the kind of data;
  `buildMatrix` crosses the two axes for you.

## Scenarios

QA mode varies the *kind* of data. Scenarios vary the *state*: a user who just signed up and has
nothing, a power user with 200 todos, an empty workspace. That's about amounts and about which
things are connected to which — so alongside `count` and `overrides`, there's `relations`.

### `relations`

`relations` shapes relationship fields after every pool exists, which is what `overrides`
structurally cannot do (overrides run before the other pools are built).

```ts
const mocks = buildMocks(schema, {
  relations: {
    User: { todos: 0, posts: { min: 1, max: 2 } },  // exact size, or a range
    Post: { comments: 'all', author: ({ pool }) => pool[0] },
    Query: { users: 3 },                            // root fields too
    _default: { min: 1, max: 5 },                   // fallback for everything else
  },
});
```

A spec is a number, a `{ min, max }` range, `null` (empty the field), `'all'` (the whole target
pool), or a function that picks the value outright:

```ts
relations: { User: { todos: ({ pool, index }) => pool.filter((t) => t.ownerIndex === index) } }
```

The function receives `{ pool, faker, index, instance, typeName, fieldName, isList }`, where
`pool` is the *target* type's pool and `instance` is the owner as built so far.

Lookup goes most specific first: `[type][field]` → `[type]._default` → `_default` → the flat
top-level form (`relations: 0` empties every relationship in the graph). **Ranges live under a
key; a bare object is always a map** — so a top-level range is written `_default: { min, max }`.

Notes:

- An explicit spec beats both `nullChance` and the QA `lists` profile — the per-field lever is
  the more specific one. An `overrides` entry for the same field still wins over `relations`.
- The pools grow to meet demand: `{ User: { todos: 20 } }` mocks at least 20 todos, since lists
  are sampled without replacement. An explicit `count` still wins, and caps the list.
- Config errors throw rather than producing a broken graph: an unknown type or field, a spec on
  a scalar field, or emptying a non-null singular field (`Todo: { user: null }` against
  `user: User!`) is a `TypeError`; a negative or non-integer size is a `RangeError`. A catch-all
  that *would* empty a non-null singular field is coerced back to one instead, so `relations: 0`
  means "as empty as the schema allows" and never yields an unexecutable graph.
- Wiring is one-directional by default: `user.todos[0].user` is some other user. Set
  `relations: { _reciprocal: true }` to have each reference written back into its inverse field
  where one exists unambiguously. It's lossy in one direction — a todo in two users' lists can
  only point at one owner, and the last write wins.

### Named scenarios

A scenario is a named partial `buildMocks` config. `defineScenarios` is an identity function that
keeps the literal keys; `satisfies ScenarioMap<SchemaTypeMap>` adds schema-checked type and field
names.

```ts
import { buildMocks, defineScenarios } from '@vantreeseba/graphql-mocks';

export const scenarios = defineScenarios({
  newUser: {
    description: 'signed up, has done nothing yet',
    count: { User: 1 },
    relations: { User: { todos: null, posts: null } },
    overrides: { User: { loginCount: () => 0 } },
  },
  powerUser: {
    relations: { User: { todos: 200, posts: { min: 20, max: 40 } } },
  },
});

const mocks = buildMocks(schema, { scenario: scenarios.newUser, seed: 42 });
```

`scenario` also takes an array, applied left to right with the explicit options merged last:

```ts
buildMocks(schema, { scenario: [scenarios.newUser, scenarios.offline], count: 3, seed: 42 });
```

`composeScenarios(a, b)` does the same fold eagerly and hands back an ordinary scenario, so it can
be composed further. Maps merge key by key — `count` per type, `overrides` and `relations` per
type then per field, `scalars` by scalar name, `qa` per dimension — and everything else is
last-one-wins. `faker` and `seed` are build-level only; reproducibility stays the caller's.

One precedence wrinkle: a `scalars` entry always outranks the QA generator for that scalar,
whichever layer each came from. A later `qa` layer therefore can't reach a scalar an earlier
layer pinned — the merge warns when that happens rather than silently doing the surprising thing.

### `buildMatrix`

Cross the scenarios with the QA presets and get one flat array of cells — one story, one test
case, one row each:

```ts
import { buildMatrix } from '@vantreeseba/graphql-mocks';

const cells = buildMatrix(schema, {
  scenarios,
  qaPresets: [false, 'longText', 'hugeLists'],
  seed: 42,
});
// [{ name: 'newUser × noQa', scenario: 'newUser', qa: 'noQa', options, mocks }, ...]

export const Variants = cells.map((cell) => ({
  name: cell.name,
  parameters: { apolloClient: { mocks: [cell.mocks.mockOperation(UsersQuery)] } },
}));
```

Either axis may be omitted; `qaPresets` also takes a map (`{ baseline: false, huge: { lists:
'huge' } }`) when you want your own cell names. Each cell gets its own faker seeded from `seed`,
so a cell reproduces identically no matter which other cells were requested — `seedPerCell: true`
opts out when you'd rather the cells differ. With `stableIds`, each cell's ids are prefixed with a
slug of its name so pools from different cells don't collide; set `idPrefix` yourself to override.

`buildQaSets` is the QA-only shorthand for the same engine.

## Typed pools

Pools are `unknown[]` by default — the type names and shapes only exist at runtime (in the schema), so they can't be inferred from the `schema` argument. Pass an optional `TTypes` map to declare them and the matching pools come back typed, no cast needed:

```ts
const mocks = buildMocks<{ User: User; Todo: Todo }>(schema);

mocks.User // User[]
mocks.Todo // Todo[]
mocks.Other // still unknown[] — any type not in the map falls back
```

### Auto-typing with GraphQL Code Generator

Rather than hand-maintaining the map, generate it from the schema so every type is typed automatically. Add a tiny custom plugin that emits a `name → type` map alongside the standard `typescript` plugin:

```js
// codegen/type-map-plugin.cjs
const { isObjectType } = require('graphql');

module.exports.plugin = (schema) => {
  // Exclude root operation types — you don't mock Query/Mutation/Subscription as pools.
  const roots = new Set(
    [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()]
      .filter(Boolean)
      .map((t) => t.name),
  );

  const names = Object.values(schema.getTypeMap())
    .filter((t) => isObjectType(t) && !t.name.startsWith('__') && !roots.has(t.name))
    .map((t) => t.name)
    .sort();

  return {
    content: `export type SchemaTypeMap = {\n${names
      .map((n) => `  ${n}: ${n};`)
      .join('\n')}\n};\n`,
  };
};
```

Run it right after `typescript` so the referenced types are defined in the same file:

```ts
// codegen.ts
import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: './schema.graphql',
  generates: {
    './src/generated/graphql.ts': {
      plugins: ['typescript', './codegen/type-map-plugin.cjs'],
    },
  },
};

export default config;
```

This produces:

```ts
export type SchemaTypeMap = {
  Todo: Todo;
  User: User;
  // ...every object type
};
```

Use it as the default type parameter on your own wrapper so callers get typed pools with zero annotation:

```ts
import { buildMocks, type BuildMocksOptions, type MockResult } from '@vantreeseba/graphql-mocks';
import type { SchemaTypeMap } from './generated/graphql';

export function getMocks<
  TTypes extends Record<string, unknown> = SchemaTypeMap,
>(options?: BuildMocksOptions<TTypes>): MockResult<TTypes> {
  return buildMocks<TTypes>(schemaSDL, options);
}

getMocks().User // User[] — no generic, no cast
getMocks<{ User: UserFragment }>().User // override per-call when you want a fragment shape
```

The generated `typescript` types add `__typename?: 'User'` by default and wrap nullable fields as `Maybe<T>`, which lines up with the mock output (with `nullChance: 0`, nothing is null). For typed one-off lookups without the map, `find<User>('User', …)` also works.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `count` | `number \| { [type]: number, _default?: number }` | `5` | Instances per type |
| `faker` | `Faker` | internal | Custom faker instance (e.g. locale) |
| `seed` | `number` | — | Seed faker for deterministic output |
| `nullChance` | `number` | `0` | Probability (0–1) nullable fields are `null` |
| `scalars` | `Record<string, (faker) => unknown>` | — | Custom scalar mockers (merged over defaults) |
| `overrides` | `Record<type, Record<field, (faker, ctx) => unknown>>` | — | Per-field replacement functions (receive the seeded faker and `{ index, typeName, fieldName }`). With a `TTypes` map, type/field keys autocomplete and each return type is bound to the field's type |
| `resolveType` | `(abstractType: string) => string` | — | Concrete type for interface/union fields. With a `TTypes` map, the return is constrained to the map's type names |
| `addTypename` | `boolean` | `true` | Add `__typename` to every object (Apollo cache needs it) |
| `stableIds` | `boolean` | `false` | Give `id` fields stable `TypeName-<index>` values |
| `idPrefix` | `string` | `''` | Prefix for `stableIds` ids (`<prefix>User-0`), so pools built in one run don't collide |
| `listSize` | `number \| { min: number, max: number }` | `{ min: 1, max: 5 }` | How many items generated list fields hold, unless a QA `lists` profile or a `relations` entry says otherwise |
| `qa` | `QaProfileName \| QaConfig \| false` | — | [QA mode](#qa-mode) — generate deliberately out-of-norm data (empty/long/unicode text, empty/huge lists, nulls, boundary numbers and dates) |
| `relations` | `RelationsConfig` | — | [Shape relationships](#relations) — sizes, ranges, `null`, `'all'`, or a function picking the related objects |
| `scenario` | `Scenario \| Scenario[]` | — | [Scenario layers](#named-scenarios) to build on, applied left to right with these options last |
| `matchArguments` | `boolean \| ArgMatchingOptions` | `false` | Let field arguments select data — see [Argument matching](#argument-matching) |
