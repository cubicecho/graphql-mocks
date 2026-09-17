# graphql-mocks

A monorepo for the `@vantreeseba/graphql-mocks` toolkit — realistic,
graph-connected mock data from a GraphQL schema.

```ts
import { buildMocks } from '@vantreeseba/graphql-mocks';

const mocks = buildMocks(schema, { seed: 42, count: 10, stableIds: true });

mocks.User;                            // 10 User objects — and mocks.Todo[0].user is one of
                                       // them: the same object, not a copy
mocks.dataForOperation(UserByIdQuery); // answered from the graph, shaped to the selection set
```

Relationships are wired as real object references rather than copies, so an
arbitrary operation can be answered from the pool: you write the query your
component already writes, and the selection set decides what comes back. Useful
for tests, Storybook stories, and demos.

## Documentation

| | |
|---|---|
| [How to use this library](./docs/getting-started.md) | The guided path — install, first pool, rendering a component against it, typing the pools, shaping the data, and the handful of things that surprise people |
| [Runtime reference](./packages/graphql-mocks/README.md) | Every option and export: argument matching, the request handler, QA mode, scenarios, the Apollo integration, typed pools |
| [Codegen plugin](./packages/graphql-mocks-codegen/README.md) | Generating a `SchemaTypeMap` so pools come back typed without a cast |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Working on the repo itself |
| [CHANGELOG.md](./CHANGELOG.md) | Release history |

## Packages

| Package | Description |
|---|---|
| [`@vantreeseba/graphql-mocks`](./packages/graphql-mocks) | The runtime: generate interconnected mock objects from a `GraphQLSchema` (or SDL) using faker, and answer operations from them. |
| [`@vantreeseba/graphql-mocks-codegen`](./packages/graphql-mocks-codegen) | A GraphQL Code Generator plugin that emits a `SchemaTypeMap` for typing mock pools. |

Both packages are released together at a single version.

## Contributing

```bash
npm install
npm test
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the rest — the full command list,
the repo layout, commit conventions, the never-rebase git workflow, and how
releases happen.

## License

[MIT](./LICENSE)
