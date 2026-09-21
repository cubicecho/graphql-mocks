# @vantreeseba/graphql-mocks

Generate realistic, graph-connected mock data from a GraphQL schema using faker.

Relationships are wired as actual object references — `todo.user` is the same object as `mocks.User[i]`, not a copy. Useful for tests, Storybook stories, and demos.

This README is the reference: every option, every export, in full. For the guided
path through it — install, first pool, rendering a component against it, typing the
pools — start with [How to use this library](https://github.com/cubicecho/graphql-mocks/blob/main/docs/getting-started.md).

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

#### By field name: `fieldOverrides`

`overrides` is keyed type-first, so a conventional field name — `imageUrl`, `slug`, `avatarUrl`,
`externalId` — means the same one-line override written once per type that carries it, and a new
type carrying the same field quietly gets the default mock until someone notices the rendering is
off. `fieldOverrides` is keyed by the field name instead, and applies to every type that has one:

```ts
const mocks = buildMocks(schema, {
  fieldOverrides: {
    imageUrl: (faker) => faker.image.url(),
    '/Url$/': (faker) => faker.image.url(),   // a key wrapped in slashes is a pattern
  },
  overrides: {
    Avatar: { imageUrl: () => '/static/avatar.png' },  // still wins, for this type
  },
});
```

The function is the same `(faker, { index, typeName, fieldName })` an `overrides` entry takes —
`typeName` is how one rule tells apart the types it fires on.

- **A key wrapped in slashes is a regular expression** (`'/Url$/'`, `'/^is[A-Z]/i'`), tested
  against the field name. Unambiguous: a GraphQL field name is letters, digits and underscores,
  so it can never contain a slash.
- **Precedence**: an `overrides` entry for that type and field beats everything; then an exact
  name; then patterns, earlier ones first.
- It fires on relationship fields too, exactly as a type-keyed override does — the value is taken
  as given, and `relations` never touches the field.
- **A key that matches no field on any mocked type warns**, which is the only typo check a
  name-keyed map can have. Root fields (`Query.users`) are not mocked per type and so warn here;
  shape those with `relations` or `argOverrides`.
- Keys are not checked against a `TTypes` map: one field name spans types whose field types may
  differ, and a pattern isn't a field name at all.

Where you control the schema, a semantic scalar (`scalar URL`) is the better fix — this is for
the names you can't retype, which in a stitched or generated schema is most of them.

### Derived fields

An override fires while the instance is half-built, so it cannot see its siblings. Any field whose value is a function of the rest of the object — a total over a list, a name assembled from its parts, a balance that is a difference of two others — belongs in `derive` instead:

```ts
const mocks = buildMocks(schema, {
  relations: { ProductSearchResult: { results: 3 } },
  derive: {
    ProductSearchResult: { totalCount: (self) => self.results.length },
    User: { fullName: (self) => `${self.firstName} ${self.lastName}` },
    StockLevel: { available: (self) => self.onHand - self.reserved },
  },
});
```

`derive` runs last — after scalars, after `overrides`, after relationships are wired and mirrored — so `self` is the finished object: every scalar, every relationship field, and every reciprocal back-reference is already there to read. Because it runs last it also **wins** over an `overrides` entry for the same field.

The second argument is `{ index, typeName, fieldName, faker }`, with the same seeded faker the generator drew with. Within one type, derives run in the order they are written, so one may read another's result. Derives apply to pooled instances, which is what every operation resolves from — so `dataForOperation` and every Apollo mock see the derived values too.

Merging follows the same two-level rule as `overrides`: a scenario layer and the build options combine per type and per field.

### Fields from one draw (`deriveObject`)

`derive` fires once per field, and every field draws from the same faker stream as it comes — so a set of numbers that have to *agree* has no way to see what the others drew. `deriveObject` is one function per type, run once per instance, returning an object merged over the generated one:

```ts
const mocks = buildMocks(schema, {
  deriveObject: {
    Order: (_self, { faker }) => {
      const subtotal = faker.number.float({ min: 10, max: 500 });
      const tax = subtotal * 0.08;
      return { subtotal, tax, total: subtotal + tax };
    },
  },
});
```

Every `Order` in the pool now adds up, from one draw, with no memo keyed on the instance and no re-seeding of the shared faker. A key the returned object omits is left exactly as generated, so a partial really is partial, and returning nothing at all leaves the instance untouched — which is how an object derive fires for only some instances.

The second argument is `{ index, typeName, faker }` — the same context a `derive` gets, minus `fieldName`, since an object derive writes as many fields as it returns.

It runs in the same phase as `derive` and sees the same finished object: every scalar, every wired relationship, every reciprocal back-reference. Within one type the order is **`deriveObject`, then `derive`**, so:

- a `derive` for a key the object derive returned **wins** — naming one field is the more specific statement of the two;
- a `derive` reads the correlated draw off `self` rather than racing it — a label over the total the object derive just set is an ordinary field derive.

Both still win over an `overrides` entry for the same field, which fires while the instance is half-built. Merging is one level: a scenario layer and the build options combine per type, and the later function replaces the earlier one outright.

### Aliased fields

A fragment that aliases a field produces a result type whose keys the pooled objects don't have:

```graphql
fragment UserCard on User {
  id
  locations: addresses { city }
}
```

The pool has `addresses`; `UserCardFragment` has `locations`. A component typed by that fragment reads `locations`, gets `undefined` and renders an empty section — with no type error anywhere to say why. `aliases` declares the copy once:

```ts
const mocks = buildMocks(schema, {
  aliases: {
    User: { addresses: 'locations' },
    Post: { comments: ['replies', 'discussion'] },  // several names for one field
  },
});
```

The key is the field the schema has, the value is the name (or names) to expose it under. The alias holds **the same reference**, not a clone, so identity comparisons and the wired graph keep working through it. It's applied last — after relationships, counts and derives — so an alias always carries the finished value, and it works on scalars as readily as on relationships.

Config errors throw before anything is generated: an unknown type or field, a non-object or operation type (root fields have no pooled instances — alias what the field returns instead), or an alias that would land on a field the type really has. Merging is the same two-level rule as `overrides`.

### `__typename` and stable ids

Every object gets a `__typename` by default (the Apollo cache needs it). Turn it off with `addTypename: false`. Enable `stableIds` to give each object's **identifier fields** readable, collision-free values instead of random scalars:

```ts
const mocks = buildMocks(schema, { stableIds: true });
mocks.User[0]; // { __typename: 'User', id: 'User-0', ... }
```

`stableIds: true` covers every field the library recognizes as an identifier by name: `id` in any
casing, and anything ending in `Id` or `ID`. `id` keeps the bare `TypeName-<index>` form; any
other field carries its own name too, so an object with both never gets one value twice:

```ts
// type PaymentMethod { id: ID!, paymentMethodId: String! }
mocks.PaymentMethod[0]; // { id: 'PaymentMethod-0', paymentMethodId: 'PaymentMethod-paymentMethodId-0', ... }
```

A schema whose identifier is named something the convention can't see (`Currency.code`) names it,
globally or per type. Those are covered **in addition** to the recognized ones:

```ts
buildMocks(schema, { stableIds: ['code'] });                        // any type's `code`
buildMocks(schema, { stableIds: { Currency: ['code'], _default: [] } }); // just Currency's
```

Beyond `id` itself, only string-valued scalar fields are replaced — writing `Order-externalId-0`
over an `Int`, an enum or a list would hand back data the schema rejects, so those are left as
generated. An explicit `overrides` entry still wins over `stableIds`, and is how you keep a
recognized field random.

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

It is **not idempotent**: each call re-resolves against the pool and draws from the shared seeded faker, so two identical calls return different rows — and, for a root list, a different number of them. It reads like a pure accessor and isn't one. To read the rows a *mock* will hand Apollo, build the mock and unwrap it with [`dataOf`](#reading-a-mock-back).

When you want *the* rows a document stands for — an id or a name to read out of, or to assert against — use `resolveOnce`, which is the same call memoized on the graph:

```ts
const { user } = mocks.resolveOnce(UserByIdQuery); // resolved once
mocks.resolveOnce(UserByIdQuery);                  // the same object, not a fresh draw
```

The memo is keyed by document **identity** (a re-`parse` of the same source is a different document) and by the `variables` and `matchArguments` passed with it, so two different questions still get two different answers. It replaces the hand-rolled `Map<DocumentNode, …>` — and the risk of two reads quietly disagreeing.

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

### Reading a mock back

`MockedResponse` types `result` and `result.data` as optional, because the error and loading variants exist. So asserting on what a mock carries means `mock.result?.data?.searchPosts?.results ?? []` — a chain whose fallback turns a renamed field into "empty" rather than a type error. `dataOf` unwraps the envelope and returns `TData` non-optionally:

```ts
import { dataOf } from '@vantreeseba/graphql-mocks';

const m = mocks.mockOperationVariants(PostsQuery);
const posts = dataOf(m.withResults).searchPosts.results; // typed, no `?.`, no `?? []`
```

It throws when there is no data to return — the `withError` variant, or an envelope assembled without a `result`. `withLongLoadTime` carries the same data as `withResults`, so it returns rather than throws. For a [resolver-form mock](#resolver-function-mocks), pass the variables to resolve with: `dataOf(mock, { id: 'User-1' })`; they default to `{}`.

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
    flattenInputs: true,        // look inside input objects — on by default
    flattenDepth: 1,
    echoOnMiss: true,
    partition: true,            // uninterpretable arguments still separate results
  },
});
```

### Nested input objects

Generated schemas rarely put the interesting argument at the top level. `where: { id: $id }` and `data: { title: $title }` are the normal shapes, and matching against the wrapper name alone would find nothing — `user(id: $id)` would resolve correctly while `account(where: { id: $id })` returned a random account.

So input objects are flattened one level before matching, and their fields are matched under their own names:

```ts
// where: { id: "Account-2" }        → equality on Account.id
// where: { id: { equals: "…" } }    → the ORM operator form, unwrapped
// where: { id: { in: ["a", "b"] } } → an `in` match
// data:  { name: "Acme", tier: 2 }  → equality on both fields
```

`equals` / `eq` / `is` / `_eq` and `in` / `_in` are recognized as operator objects and stand in for their inner value; a comparison that isn't one of those (`gte`, `contains`, `not`) is left alone rather than guessed at. Depth stops at 1 by default, so `where: { owner: { id } }` does **not** reach through — that `id` names the *owner*, not the returned type. Raise `flattenDepth`, or turn the whole thing off with `flattenInputs: false`. `ignoreArgs` applies to nested names too, so `ignoreArgs: ['tier']` skips `data.tier` and `ignoreArgs: ['where']` skips the wrapper whole.

Authorship still travels with the values: a `where: { id: $id }` whose `$id` was invented to satisfy execution counts as *not* stated, the same as a top-level `id: $id`, and the field falls back to its random pick.

### Mutations echo what they were handed

A mutation has no pooled instance carrying the values it was just given, so `createTodo(input: { title: "Ship the release" })` always misses — and a random todo with somebody else's title is the one thing a test just asserted on. On a **singular** miss the stated values are stamped back over a copy of the fallback instance:

```ts
mocks.dataForOperation(
  parse('mutation { createTodo(input: { title: "Ship the release", priority: HIGH }) { … } }'),
);
// { createTodo: { title: 'Ship the release', priority: 'HIGH', id: 'Todo-3', completed: false, … } }
```

Only fields the caller actually named are replaced; everything else stays generated, and the pooled instance itself is never mutated. `echoOnMiss: false` restores the plain random fallback.

**Variables you didn't supply are ignored.** Required variables are auto-filled so execution can run, and any argument bound to one of those invented values is dropped — so `mocks.mockOperation(UserByIdQuery)` with no variables still returns a random pooled user, exactly as with matching off. A variable you pass, a literal, or a schema/document default counts as intent and is applied.

**When nothing matches:**

- A **list** returns `[]`. An empty result is a wanted state — the most common empty-state story — and falling back would return rows that visibly contradict the filter.
- A **nullable singular** field falls back to the random pick. A miss means "you named an id we never generated"; `null` would turn a working screen into an unrequested not-found path. Set `onMiss: { singular: 'empty' }` if you want the not-found path.
- A **non-null singular** field always falls back, whatever `onMiss` says — `null` there is a GraphQL error plus a warning, which is strictly worse than a random item.
- **Paging** never falls back: `skip: 100` over 5 items legitimately yields `[]`.

Paging switches the source from a random subset to the whole pool in stable order, so pages line up. Pools hold `count` items (default 5) and lists draw [`listSize`](#listsize) items (default 1–5) — raise both when you need more than one page:

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

One length is not a sample: a wrapper whose list is **empty** holds nothing, and paging it returns nothing. Nothing draws `[]` from a non-empty pool unless something asked for nothing — `qa: { lists: 'empty' }`, or a `relations` entry of `0` or `null` — so an empty state stays an empty state here.

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

A wrapper's own count scalars (`totalCount`) are left as generated — they reflect the pool, not the page. `countFields` makes them reflect something a pager can actually page through, and keeps them in step when an argument narrows the list.

### Counts that agree with their lists

A wrapper's total is only meaningful next to a list holding the whole pool it is a total of. `countFields` pairs each count scalar with the list it counts, and sizes that list to the pool of what it holds:

```ts
buildMocks(schema, { count: { _default: 40 }, countFields: true });
// ProductSearchResult.results    -> all 40 pooled products
// ProductSearchResult.totalCount -> 40, which `limit: 10` can page through four times
```

Without it, the same coherence takes two options that have to agree on a number written twice — a `relations` size to make `results` hold the pool, and a `derive` per count field to read its length — repeated for every wrapper in the schema.

Pairing is by name, the same convention the [QA list profiles](#count-fields-stay-in-step-with-their-lists) use:

- a name that points at a list wins — `postCount`, `numberOfPosts`, `totalPosts` all pair with `posts`
- a name that points nowhere — `total`, `count`, `totalCount`, `resultCount` — pairs with the type's list field when it has exactly one, and warns rather than guessing when it has more. A Relay connection pairs the same way: `totalCount` against `edges`
- a name that points at a list the type doesn't have is left alone

Pass a map for the pairings the convention misses, which also turns the pass on:

```ts
buildMocks(schema, { countFields: { ProductSearchResult: { hitTotal: 'results' } } });
```

An explicit `relations` size still decides the list's length, an `overrides` entry for a count is never touched, and a `derive` for the same field still wins — it runs after. Under a QA `lists` profile the profile owns the sizing and this only syncs the counts, so an emptied list reports zero; `countFields: false` turns the pass off either way.

A paired count follows the narrowing, so a filtered list doesn't report the unfiltered pool:

```ts
// search: matched 2 of 40                    limit alone: page 1 of 40
{ results: [ /* 2 */ ], totalCount: 2 }       { results: [ /* 10 */ ], totalCount: 40 }
```

The count is what the filters left, before paging — the same number a Relay `pageInfo` is built from. Paging alone leaves it at the pool size, which is what a pager pages through. Only the pairing does this: with `countFields` off, a count scalar is ordinary generated data that happens to be an `Int`, and nothing says it was ever about that list.

This reaches the count on a *wrapper* type, next to the list the arguments narrowed. A count sitting beside a plain list field (`user { posts(search: "x") { id } postCount }`) is resolved from the wired object and still reports what was wired.

### Selections that differ only by an argument

A dashboard selects one schema field several times, aliased, with a different argument value each time:

```graphql
query Dashboard {
  warehouse(id: $id) {
    inStock: items(where: IN_STOCK) { ...Row }
    lowStock: items(where: LOW_STOCK) { ...Row }
    overStock: items(where: OVER_STOCK) { ...Row }
  }
}
```

One field, three selections, told apart only by an enum nothing can interpret. Without help all three panels render byte-identical rows, which reads as a bug.

**Partitioning** is the cheap default. Any active argument that no bucket could interpret becomes a partition key, and each distinct value deterministically draws a *different* window of the pool — same list lengths, different rows, stable across re-renders:

```ts
buildMocks(schema, { matchArguments: true });
// the three panels now show three different sets of items
```

It does not make the rows *mean* `LOW_STOCK` — nothing here could know what that implies. It makes the gap visible instead of silent. Turn it off with `matchArguments: { partition: false }`.

**`argOverrides`** is the part that actually answers the question, because only you know what the argument means:

```ts
buildMocks(schema, {
  argOverrides: [
    { match: { field: 'items', args: { where: 'LOW_STOCK' } }, data: lowStockRows },
    { match: { type: 'Query', field: 'items' }, data: ({ pool }) => pool.slice(0, 2) },
  ],
});
```

First match wins. `match.field` is the **schema** field name, never the alias; `match.type` narrows to one parent type; `match.args` compares by value (an input object matches structurally), and `match.predicate` replaces it for anything more involved. `data` is a value, or a function handed `{ typeName, fieldName, args, pool, isList, faker }`.

Every *other* field of the operation still resolves from the graph — which is what an operation-level override on a handler cannot do, and why this exists next to it. `argOverrides` are instructions rather than inferences, so they apply whether or not `matchArguments` is on.

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

### The shape that never runs

Apollo invokes `result` only when **`result` itself** is a function. A function one level down, at `result.data`, is never called — the mock matches, the link resolves, and the cache is handed a function where the data should be. The component renders nothing, with no error and no warning:

```ts
{ request: { query: Doc }, result: { data: (vars) => ({ … }) } } // never invoked
{ request: { query: Doc }, result: (vars) => ({ data: { … } }) } // what Apollo calls
```

`mockOperation(Doc, (vars) => data)` produces the second shape, so pass the resolver as the `data` argument rather than wrapping it — and if an envelope does slip through, `mockOperation` warns about it at construction time.

### Validating mocks

`validateMocks` checks hand-written mocks for that trap and the other shapes that fail quietly. Point it at one mock, an array, a `mockOperationVariants` trio, or a whole module of any of those:

```ts
import * as mocks from './mocks/index.js';
import { assertValidMocks, validateMocks } from '@vantreeseba/graphql-mocks';

it('every mock is well formed', () => assertValidMocks(mocks));

const issues = validateMocks(mocks);
// [{ kind: 'invalid', path: 'mocks.userMock.result.data', operationName: 'User', message: 'result.data is a function, …' }]
```

It reports every problem rather than stopping at the first, so one run fixes a directory. Checks: `request.query` is a parsed document declaring an operation, `request.variables` is an object or a predicate, `error` is an `Error`, `delay`/`maxUsageCount` are numbers, the mock carries a `result` or an `error`, and the resolved `data` is a non-empty object with no functions anywhere inside it. Both walks — the one that finds the mocks and the one that inspects their `data` — are cycle-safe, so a module can export a built pool alongside the mocks built from it. Pass `requireData: false` to allow empty payloads, or `probeVariables` to call a resolver-form `result` and validate what it returns.

Finding *nothing* is reported too, as the single issue `kind: 'empty'` — a module that quietly stops exporting mocks otherwise looks exactly like one whose mocks are all fine. Every other issue carries `kind: 'invalid'`, so a fixture module that legitimately holds no mocks can filter the empty report out without matching on message text. The keyed map `mockOperationsFrom` returns is walked like any other module, to the same depth; its entries are lazy, so validating one forces every operation in it. That is what validation is for, but it is the opposite of what the map is optimised for — keep the check in a test rather than in the module itself.

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

#### `createMockClient`

The three lines above are the same three lines in every story file and every test helper, so
there's a factory for them:

```tsx
import { createMockClient } from '@vantreeseba/graphql-mocks/apollo';

const client = createMockClient(mocks, { delay: 300, matchArguments: true });
```

It takes everything `mockLink` takes, plus `cache`, `link`, `defaultOptions` and `clientOptions`
for the client itself. Two defaults are worth knowing about, both overridable:

- **A fresh `InMemoryCache` per call.** Story isolation shouldn't be something you have to know
  to ask for.
- **`fetchPolicy: 'no-cache'` and `errorPolicy: 'all'`** for `query` and `watchQuery`. The point
  of a mock client is to see what the mocks return, and an error state is a state to render, not
  a rejected promise nobody catches. `defaultOptions` merges over these per operation kind and
  then per key, so `{ query: { fetchPolicy: 'cache-first' } }` keeps the rest — it is a deep
  partial, and `{ mutate: { errorPolicy: 'all' } }` on its own is a whole valid value.

Pass a *factory* — `(options) => buildMocks(schema, { ...defaults, ...options })` — instead of a
built graph when something downstream needs to rebuild the graph with different options. Graphs
built that way are memoized per config, so re-renders reuse them rather than reshuffling every
pool.

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

### The Storybook decorator

`withGraphqlMocks` is that trio wired to a story parameter. It stays React-free — the renderer
churns across Storybook majors, so `wrap` is yours — but the parameter parsing, the scenarios and
the client memo are not yours to write:

```tsx
// .storybook/preview.tsx
import { ApolloProvider } from '@apollo/client';
import { buildMocks } from '@vantreeseba/graphql-mocks';
import { withGraphqlMocks } from '@vantreeseba/graphql-mocks/apollo';
import { schema } from './schema';

export const decorators = [
  withGraphqlMocks(
    (options) => buildMocks(schema, { seed: 1, stableIds: true, matchArguments: true, ...options }),
    {
      wrap: (client, Story) => (
        <ApolloProvider client={client}>
          <Story />
        </ApolloProvider>
      ),
    },
  ),
];
```

```tsx
// SomeScreen.stories.tsx
export const Default = {};                                              // no parameter needed
export const Loading = { parameters: { graphqlMocks: 'loading' } };
export const Errored = { parameters: { graphqlMocks: 'errored' } };
export const OnePanelFailing = {
  parameters: { graphqlMocks: { state: 'errored', target: 'UserById' } },
};
export const Empty = { parameters: { graphqlMocks: { build: { count: 0 } } } };
export const LongText = { parameters: { graphqlMocks: { qa: 'longText' } } };
export const Slow = { parameters: { graphqlMocks: { delay: 2000 } } };
export const Unmocked = { parameters: { graphqlMocks: false } };
```

The parameter is `true | 'loading' | 'errored' | { state, target, build, qa, ...handler options }`,
or `false` to opt one story out. Options passed to `withGraphqlMocks` itself are the base every
story is layered over — plain options key by key, `overrides` concatenated with the story's first.

`build` and `qa` need the factory form of the source (as above); with an already-built graph
there's nothing to rebuild and they warn.

Clients are memoized per story (`context.id`) and resolved parameter, so a control knob
re-rendering a story reuses its client instead of remounting into a fresh cache, while every
story still gets its own `InMemoryCache` — one story's mutation or paged list never answers the
next story's query. Where a set of stories genuinely wants one shared client, say so with
`clientKey`, which replaces the story identity in that memo key:

```tsx
withGraphqlMocks(factory, {
  wrap,
  clientKey: (context) => context.title, // one client per stories file
});
```

`resolveMockClient(source, parameter, base)` is the same resolution without the decorator, for
a renderer `wrap` doesn't fit.

#### Deriving one parameter from another

A set of stories usually shares one base parameter and varies it. Because the parameter is a
union, a helper that re-states a short form drops whatever the base set — silently:

```ts
const base = { overrides: [orderFixture], target: 'OrderById' };

// `'loading'` on its own would drop the base's overrides and target: the story still renders,
// just not the data the rest of the set is built on.
export const Loading = { parameters: { graphqlMocks: withState(base, 'loading') } };
```

`withState(parameter, state)` and `withQa(parameter, qa)` are parameter-in / parameter-out and
keep every other field — `overrides`, `target`, `build` and the handler options — so a derived
story differs from its base in exactly the one thing it names. `false` (a story opted out of
mocking) comes back as `false`, since it has no state to be in.

`toMockClientParameter(parameter)` is the primitive under both: the long form of any accepted
parameter, reading each short form exactly as the decorator does (`true` and an absent parameter
are `{ state: 'default' }`, a string is that state, a long form is copied through). Reach for it
when a helper layers on something these two don't cover:

```ts
import { type MockClientOption, toMockClientParameter } from '@vantreeseba/graphql-mocks/apollo';

const slow = (parameter: MockClientOption) => ({
  ...toMockClientParameter(parameter),
  delay: 2000,
});
```

The same shape works in component tests:

```tsx
import { buildMocks } from '@vantreeseba/graphql-mocks';
import { type MockHandlerOptions, createMockClient } from '@vantreeseba/graphql-mocks/apollo';

function renderWithMocks(ui: React.ReactElement, options: MockHandlerOptions = {}) {
  const mocks = buildMocks(schema, { seed: 1, stableIds: true, matchArguments: true });
  const handler = mocks.toRequestHandler(options);
  const client = createMockClient(handler);
  return { mocks, handler, ...render(<ApolloProvider client={client}>{ui}</ApolloProvider>) };
}
```

## Addressing pooled data

```ts
mocks.ids('User');                  // ['User-0', 'User-1', …] in generation order
mocks.at('User', 0);                // the first pooled User
mocks.byId('User', 'User-2');       // looked up by id, compared as strings
mocks.byIdOrIndex('User', someKey); // an id, else an index, else element 0 — never undefined
```

`byIdOrIndex` is the "either" lookup: a key that might be a real pooled id, might be a numeric index, and might be missing. It tries the id first, then the key as an index when it reads as a whole one in range, then falls back to element 0 — and because it always returns an element, the return type is **not** optional:

```ts
const user = mocks.byIdOrIndex('User', routeParam); // TTypes['User'], no `??` chain, no cast
```

That is the difference from writing `byId(…) ?? at(…, Number(key) || 0) ?? at(…, 0)` by hand: the chain widens to include `undefined` even though its last arm cannot be, so the call site ends up asserting what the library already knows. An **empty pool throws** a `RangeError` — with no element 0 there is nothing to fall back to, and a non-optional return would be a lie. Use `at`/`byId` where "no such item" is a legitimate answer.

`ids` needs no `TTypes` map to come back typed, which `at('User', 0)?.id` does under `noUncheckedIndexedAccess`:

```ts
const id = mocks.ids('User')[0] as string;
mocks.mockOperation(UserByIdQuery, { variables: { id }, matchArguments: true });
```

Pair it with `stableIds: true` for readable, stable values.

## Pooled objects are cyclic

Pooled objects are wired into a graph, not a tree: `post.author` is a pooled `User` whose `posts`
list contains that same post. With `relations: { _reciprocal: true }` the back-references make it
worse. Anything that walks a mock **generically** therefore needs a cycle guard — a validation
pass, a snapshot, `JSON.stringify` for a fixture, a deep-equality assertion, `structuredClone`
across a worker boundary — or it ends in `RangeError: Maximum call stack size exceeded`.

Two exports save you writing that guard:

```ts
import { select, toPlain } from '@vantreeseba/graphql-mocks';

JSON.stringify(toPlain(mocks.User[0]));      // cycle-free deep copy
select(mocks.User[0], UserRowFragmentDoc);   // shaped to a document's selection set
```

`toPlain(value, options?)` deep-copies, cutting any reference that points back into the path it is
copying. `onCycle` says what the cut looks like — `'stub'` (the default) leaves
`{ __typename, id }`, `'null'` leaves `null`, `'omit'` drops the property (array *entries* still
become `null`, since dropping one would shift the indices after it). `maxDepth` cuts at a fixed
depth with the same strategy. An object that merely appears twice is copied twice; only a real
cycle is cut. The result is typed as the input — true of the ordinary copy, though a cut narrows
the shape below that, so widen it yourself when you cut deliberately.

`select(value, document, options?)` projects onto a query, mutation or bare fragment document:
the fields it asks for, under the aliases it asks for them, and nothing else. Because the shape
follows the document rather than the object graph, the result is cycle-free by construction —
which is usually what you wanted anyway. Pass `{ schema }` when a fragment's type condition is an
interface or union, and `{ operationName }` to pick between operations. `@skip` / `@include` are
not evaluated. Hand it a `TypedDocumentNode` and the return type comes from the document, the
same way `dataForOperation` infers it.

There is also `relations: { _reciprocal: 'hidden' }`, which wires the mirrored back-references as
**non-enumerable** properties: `todo.user` still reads normally, but `JSON.stringify` and
`Object.entries` walks skip it. That narrows the problem rather than removing it — forward
relationship fields still form cycles of their own — so reach for `toPlain` when you need a
guarantee.

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
searchItems(mocks.User, 'ana');                // every own string field
searchItems(mocks.User, 'ana', ['name']);      // named fields only
```

Absent or null arguments are no-ops, so they're safe to apply unconditionally.

A `searchItems` field is a key, a **dotted path**, or an accessor. Because relations are wired
into the pool, a path reaches them — and steps through a list on the way, so a post matches when
any of its comments does:

```ts
searchItems(mocks.Post, 'ana', ['title', 'author.name', 'comments.text']);
searchItems(mocks.Post, 'ana', [(post) => post.author?.email]);
```

A missing link is a non-match, not a throw, so `author.email` is safe on posts with no author.
Leaving `fields` off keeps the shallow default — every own string-valued property, relations not
followed — so name the paths when a related object is what you're filtering on.

### `paginateArgs`: the same thing from a field's arguments

In an `argOverrides` handler the values arrive as untyped args, and `paginate`/`searchItems` take
already-coerced ones — so every handler writes the same preamble, and it's subtly easy to get
wrong (a `limit` defaulting to `0` empties the list; a `skip` defaulting to `undefined` pages
differently from one defaulting to `0`). `paginateArgs` closes over the arg-reading:

```ts
import { paginateArgs } from '@vantreeseba/graphql-mocks';

argOverrides: [
  {
    match: { type: 'Query', field: 'searchPosts' },
    data: (ctx) => {
      const { items, matchedCount } = paginateArgs(ctx.pool, ctx, { searchFields: ['title'] });
      return { results: items, totalCount: matchedCount };
    },
  },
];
```

It returns `{ items, matchedCount, totalCount, skip, limit, search }` — the page, how many the
search left, how many there were to begin with, and the values it actually used — so the caller
shapes its own envelope.

The argument names are the ones the argument matcher reads, exported as `DEFAULT_OFFSET_ARGS`
(`skip`, `offset`), `DEFAULT_LIMIT_ARGS` (`limit`, `first`, `take`) and `DEFAULT_SEARCH_ARGS`
(`search`, `query`, `q`, `filter`, `searchTerm`, `term`), so a hand-written handler and the engine
stay in step rather than each guessing at the same list. Override them — plus `searchFields`, a
`defaultLimit` for a field whose arguments carry no page size, and `flattenInputs` — per call:

```ts
paginateArgs(ctx.pool, ctx, { limitArgs: ['pageSize'], defaultLimit: 25 });
```

Arguments one level inside an input object are found too (`where: { search: "ada" }`), matching
the matcher's default, with a top-level name beating a nested one. A null or wrongly typed
argument reads as absent, and with no page size at all the result is unpaged rather than empty.
It takes the override context, or any `{ args }` object.

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

`emptyLists` empties the lists the graph already wired, and stays empty under [argument matching](#argument-matching): a wrapper whose list holds nothing is a wrapper that holds nothing, so paging it returns nothing rather than reaching past it to the entity pool. To empty a type everywhere it appears — rather than emptying the lists that point at it — set its pool to zero instead, which is coherent through every path on its own:

```ts
buildMocks(schema, { count: { Product: 0 } });
```

### With Storybook + Apollo

```ts
const sets = buildQaSets(schema, { seed: 42, profiles: ['emptyText', 'longText', 'emptyLists'] });

export const QaVariants = sets.map((set) => ({
  name: set.name,
  parameters: { apolloClient: { mocks: [set.mocks.mockOperation(UsersQuery)] } },
}));
```

For a single story, the [decorator](#the-storybook-decorator) takes a profile directly —
`parameters: { graphqlMocks: { qa: 'emptyText' } }` — and builds that graph once.

Each set is generated from its own faker instance seeded with `seed`, so a set reproduces
identically no matter which other presets ran alongside it — when one variant breaks, rerunning
just that preset gives you the same data back. That holds even when you hand it the same options
object you hand `buildMocks`: a `faker` in there contributes its locale data and is never drawn
from or re-seeded, so there is nothing to strip out first.

### Count fields stay in step with their lists

A list profile resizes list fields; on the wrapper shape most paginated APIs use, that would leave the total behind:

```jsonc
{ "results": [], "totalCount": 315 }   // an empty state with a footer reading "315 of 315"
```

So with a `lists` profile active, companion count scalars are rewritten to the length of the list they count. A count is paired by name:

- a name that points at a list wins — `postCount`, `numberOfPosts`, `totalPosts` all pair with `posts` (singular and plural match)
- a name that points nowhere in particular — `total`, `count`, `totalCount`, `itemCount`, `resultCount`, `numberOfItems` — pairs with the type's list field when it has exactly one, and warns when it has more than one rather than guessing
- a name that points at a list the type doesn't have is left alone, so `numberOfEmployees` never becomes the length of `addresses`

Only integer scalars are considered, and a field with an explicit `overrides` entry is never touched. Point at a pairing the convention misses, or turn the whole thing off:

```ts
buildMocks(schema, {
  qa: { lists: 'empty', countFields: { ProductSearchResult: { hitTotal: 'results' } } },
});

buildMocks(schema, { qa: { lists: 'empty', syncCounts: false } });
```

The same pairing works outside QA mode, where it also sizes the counted list to its pool — see [Counts that agree with their lists](#counts-that-agree-with-their-lists).

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
pool), a `{ size, where }` filter (below), or a function that picks the value outright:

```ts
relations: { User: { todos: ({ pool, index }) => pool.filter((t) => t.ownerIndex === index) } }
```

The function receives `{ pool, faker, index, instance, typeName, fieldName, isList }`, where
`pool` is the *target* type's pool and `instance` is the owner as built so far.

#### Drawing from part of the pool: `{ size, where }`

A function is the sledgehammer — it has to re-implement the sizing along with the picking. When
all you want is to *narrow which* objects the field may draw from, give the spec a `where`
predicate and let the usual sizing do the rest:

```ts
const mocks = buildMocks(schema, {
  relations: {
    Team: { members: { size: { min: 2, max: 4 }, where: (user) => user.isActive === true } },
    Post: { author: { where: (user) => user.role === 'AUTHOR' } },   // size left to the default
  },
});
```

`where` is called as `(item, ctx)` with the same `ctx` a relation function gets, and anything
truthy keeps the object. With a [`TTypes` map](#typed-pools) the candidate is typed from the
related field itself — `Post.author` hands the predicate a `User`, `Post.comments` a `Comment` —
so neither predicate above needs an annotation or a cast. A predicate declared away from the
config names it once, as `RelationPredicate<User>`; with no type argument the candidate stays the
loose pooled record it has always been. `size` is an ordinary spec — a number, a range, `'all'` or `null` — and
when it's absent the field is sized exactly as it would have been with no entry at all. Pools
still grow to meet a `size`, since the filtered draw comes out of the same pool.

- **A `where` that matches nothing throws.** An empty match is nearly always a predicate that
  doesn't say what its author meant, and wiring `null` for it hands the mistake back much later
  as an unexplained missing relationship. Where "none" is a legitimate answer, say so with a
  relation function.
- **A singular field cycles by the owner's index** (`candidates[index % candidates.length]`)
  rather than drawing at random, so each owner's assignment is stable across a rebuild and
  spread across the candidates instead of clustering on one.
- **On a root field, `where` narrows the pool** rather than picking from it: argument matching,
  paging and the random pick all then run against the objects the predicate kept. So
  `relations: { Query: { users: { where: (u) => u.isActive === true } } }` makes the whole
  `users` field serve active users only, and `users(isActive: false)` matches nothing.
- An object is only a filter when its `where` is a function; `{ where: 'active' }` is a
  `TypeError` rather than a range with no bounds.

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
  only point at one owner, and the last write wins. `'hidden'` instead of `true` defines those
  back-references non-enumerable — see [Pooled objects are cyclic](#pooled-objects-are-cyclic).

### `listSize`

`relations` only reaches relationship fields. `listSize` sizes **every** generated list — a
`[String!]!` of tags, a `[Colour!]!` of enums, a relationship list, a root list — and takes the
same per-type, per-field shape:

```ts
const mocks = buildMocks(schema, {
  listSize: {
    Post: { tags: 2, colours: { min: 1, max: 2 }, _default: 4 }, // exact size, or a range
    Query: { posts: 3 },                                         // root fields too
    _default: { min: 1, max: 5 },                                // everything else
  },
});
```

The flat form is still there and still means "every list in the graph": `listSize: 3` or
`listSize: { min: 2, max: 4 }`. **A bare `{ min, max }` is a range, not a map** — the two are told
apart by those numeric bounds, which no GraphQL type name collides with under the usual
capitalization.

Lookup goes most specific first: `[type][field]` → `[type]._default` → `_default` → the flat form.

Notes:

- **A named entry beats the QA `lists` profile**; the catch-all (`_default`, or the flat form)
  loses to it. Same rule as `relations`: the per-field lever is the more specific one.
- **`relations` is more specific still** and wins outright for a relationship field — it can do
  things `listSize` can't (`'all'`, `where`, a picker function, `null`).
- **`listSize` never grows a pool.** A relationship or root list is drawn without replacement from
  a pool of `count` objects, so `{ Query: { posts: 50 } }` against the default `count: 5` yields
  five. Raise `count` too. (`relations` *does* grow pools; that asymmetry is deliberate.)
- Config errors throw rather than silently doing nothing: an unknown type, an unknown field, or an
  entry on a field that isn't a list is a `TypeError`.

### `uniqueLists`

Generated lists hold **distinct** values. Object lists have always been drawn without replacement
from their pool; scalar and enum lists are too, so `tags.map(tag => <Chip key={tag}>)` — the
obvious thing to write for a tag list — can't warn about duplicate keys on the seed where two
`faker.lorem.word()` calls happened to collide.

The length gives way, not the distinctness. An enum list is clamped to the number of values the
enum has, so a three-value `Status` yields at most three entries however large `listSize` is:

```ts
// enum Status { OPEN CLOSED CANCELLED }
buildMocks(schema, { listSize: { Order: { statuses: { min: 4, max: 10 } } } });
// order.statuses → 3 entries, all distinct — there is no fourth value to draw
```

A scalar generator has no countable set of values, so "without replacement" is a bounded retry: a
draw that repeats an earlier one is re-drawn, and after twelve consecutive collisions the list
comes back short rather than looping — the same way a relationship list comes back short when its
pool can't fill it.

Turn it off with the flat form, or per type and field with a map shaped like `listSize`:

```ts
buildMocks(schema, { uniqueLists: false });                     // draw with replacement again
buildMocks(schema, { uniqueLists: { Post: { tags: false } } }); // just Post.tags
buildMocks(schema, { uniqueLists: { Post: false, _default: true } });
```

Notes:

- **QA mode turns it off by default.** The QA corpora are a handful of values each, so
  deduplicating would silently cap a `lists: 'huge'` profile at the size of the corpus. An
  explicit `uniqueLists` — flat or per field — still applies under `qa`.
- **A named entry beats that default**, the same way a named `listSize` beats a QA `lists`
  profile.
- Scenario layers merge it per type then per field, like `listSize`.
- Config errors throw rather than silently doing nothing: an unknown type, an unknown field, or an
  entry on a field that isn't a list is a `TypeError`.

### Named scenarios

A scenario is a named partial `buildMocks` config. `defineScenarios` is an identity function that
keeps the literal keys. To check type and field names against a schema too, bind it to a type map
first — `defineScenarios<SchemaTypeMap>()({ … })` — or write the same check the other way round
with `satisfies ScenarioMap<SchemaTypeMap>`. The currying is what keeps both halves: TypeScript
can't infer the scenario map while you supply the type map by hand.

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
be composed further. `composeScenarios<SchemaTypeMap>(a, b)` checks every piece against that map
and stays bound to it, so a scenario written for another schema can't quietly join the fold; the
map is never inferred from the arguments, since inferring it from the first scenario would make
every later one conform to whatever types that one happened to mention. Maps merge key by key — `count` per type, `overrides` and `relations` per
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
opts out when you'd rather the cells differ. A `faker` you pass contributes its locale data only;
it is never drawn from or re-seeded, so reproducibility rests on `seed`. With `stableIds`, each cell's ids are prefixed with a
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
| `fieldOverrides` | `Record<field, (faker, ctx) => unknown>` | — | [Overrides keyed by field name](#by-field-name-fieldoverrides), applied to every type carrying it. A key wrapped in slashes is a pattern; a type-keyed `overrides` entry wins |
| `aliases` | `Record<type, Record<field, string \| string[]>>` | — | [Expose a field under extra names](#aliased-fields), for fragments that alias it. Same reference, applied last |
| `derive` | `Record<type, Record<field, (self, ctx) => unknown>>` | — | Per-field functions computed from the **finished** object, after relationships are wired. Wins over `overrides` for the same field |
| `deriveObject` | `Record<type, (self, ctx) => object>` | — | [One function per type](#fields-from-one-draw-deriveobject) returning a partial merged over the instance, for fields that come from a single correlated draw. Runs just before `derive`, which wins on a key both write |
| `resolveType` | `(abstractType: string) => string` | — | Concrete type for interface/union fields. With a `TTypes` map, the return is constrained to the map's type names |
| `addTypename` | `boolean` | `true` | Add `__typename` to every object (Apollo cache needs it) |
| `stableIds` | `boolean \| string[] \| { [type]: string[] }` | `false` | Give identifier fields stable values — `id` as `TypeName-<index>`, any other recognized or named field as `TypeName-<field>-<index>`. See [stable ids](#__typename-and-stable-ids) |
| `idPrefix` | `string` | `''` | Prefix for `stableIds` ids (`<prefix>User-0`), so pools built in one run don't collide |
| `listSize` | `number \| { min, max } \| { [type]: { [field]: size } }` | `{ min: 1, max: 5 }` | How many items every generated list field holds — scalar, enum, relationship and root alike. Per-type/per-field entries beat a QA `lists` profile; a `relations` entry beats both. See [`listSize`](#listsize) |
| `uniqueLists` | `boolean \| { [type]: { [field]: boolean } }` | `true` (`false` under `qa`) | Draw scalar and enum lists without replacement, clamping the length to the distinct values available. See [`uniqueLists`](#uniquelists) |
| `qa` | `QaProfileName \| QaConfig \| false` | — | [QA mode](#qa-mode) — generate deliberately out-of-norm data (empty/long/unicode text, empty/huge lists, nulls, boundary numbers and dates) |
| `relations` | `RelationsConfig` | — | [Shape relationships](#relations) — sizes, ranges, `null`, `'all'`, a `{ size, where }` filter, or a function picking the related objects |
| `countFields` | `boolean \| { [type]: { [countField]: listField } }` | — | [Pair count scalars with the lists they count](#counts-that-agree-with-their-lists) and size those lists to the pool. A map adds the pairings the name convention misses, and turns the pass on |
| `scenario` | `Scenario \| Scenario[]` | — | [Scenario layers](#named-scenarios) to build on, applied left to right with these options last |
| `matchArguments` | `boolean \| ArgMatchingOptions` | `false` | Let field arguments select data — see [Argument matching](#argument-matching) |
| `argOverrides` | `ArgOverride[]` | `[]` | Answer one field by its argument values — see [Selections that differ only by an argument](#selections-that-differ-only-by-an-argument) |

Each structured option's shape is exported as a type, so a config can be declared
away from the `buildMocks` call and still be checked — `CountConfig`,
`OverridesConfig`, `DeriveConfig`, `ObjectDeriveConfig`, `RelationsConfig`,
`CountFieldsConfig`, `QaConfig`, `UniqueListsConfig`, `StableIdsConfig`,
`ArgOverride`, `Scenario`, and `ScenarioMap`. Each takes the same
optional `TTypes` map as `buildMocks`, which is what binds its keys to the schema:

```ts
import type { DeriveConfig } from '@vantreeseba/graphql-mocks';

const derive: DeriveConfig<SchemaTypeMap> = {
  User: { fullName: (self) => `${self.firstName} ${self.lastName}` },
};

buildMocks<SchemaTypeMap>(schema, { derive });
```

The map is a **hint, not a closed contract**. Type names are checked against it, but a field it
does not carry — one the fragment behind the generated type never selected, or one that exists
only in the mock — is still accepted, with an `unknown` return:

```ts
const derive: DeriveConfig<SchemaTypeMap> = {
  User: {
    fullName: (self) => `${self.firstName} ${self.lastName}`,  // mapped: bound to its type
    todoCount: (self) => self.todos.length,                    // not in the map: `unknown`
  },
};
```

`self` stays typed either way, so a rolled-up total reads its inputs with autocomplete even
though the field it writes is unmapped. Before this, writing one such field meant dropping
`TTypes` from the whole options object, at which point `self` degraded to
`Record<string, unknown>` and nothing was typed at all. The trade is that a *misspelled* field
name no longer errors in these two options — it reads as an unmapped field. Type names still
catch their own typos, and `MockResult` is unchanged: a pooled instance is typed by the map
alone, so reading a mock-only field back is an explicit cast.
