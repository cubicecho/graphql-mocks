# @vantreeseba/graphql-mocks-codegen

A [GraphQL Code Generator](https://the-guild.dev/graphql/codegen) plugin that
emits a `SchemaTypeMap` — a `{ TypeName: GeneratedType }` map of every object type
in your schema — so you can hand it to
[`@vantreeseba/graphql-mocks`](../graphql-mocks)'s `buildMocks<TTypes>` and get
typed mock pools back without a cast.

New to the runtime? [How to use this library](https://github.com/cubicecho/graphql-mocks/blob/main/docs/getting-started.md)
covers where the type map fits in.

## Install

```bash
npm install -D @vantreeseba/graphql-mocks-codegen
# peer deps you already have for codegen
npm install -D @graphql-codegen/cli @graphql-codegen/typescript
# the runtime the type map is used with
npm install @vantreeseba/graphql-mocks
```

## Usage

Point the plugin at the same generated types file your `typescript` plugin (or
the `client` preset) emits — by default it imports from `./graphql`.

```ts
// codegen.ts
import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: './schema.graphql',
  generates: {
    // your existing typed output
    './src/__generated__/graphql.ts': {
      plugins: ['typescript'],
    },
    // the type map, emitted alongside it
    './src/__generated__/schema-type-map.ts': {
      plugins: ['@vantreeseba/graphql-mocks-codegen'],
    },
  },
};

export default config;
```

Then type your mock pools straight off the generated map:

```ts
import { buildMocks } from '@vantreeseba/graphql-mocks';
import type { SchemaTypeMap } from './__generated__/schema-type-map';

const mocks = buildMocks<SchemaTypeMap>(schema);

mocks.User;                          // User[] — typed, no cast
mocks.find('Todo', (t) => t.done);   // Todo | undefined — predicate item typed
```

### Generated output

For a schema with `User` and `Todo` object types, the plugin emits:

```ts
import type * as Types from './graphql';

export type SchemaTypeMap = {
  Todo: Types.Todo;
  User: Types.User;
};
```

The map KEY is the raw GraphQL type name (what the mock pools are keyed by at
runtime); the VALUE references the generated TS type via codegen's own naming
convention, so it stays correct even if you change `namingConvention`. Root
operation types (`Query`/`Mutation`/`Subscription`) and introspection types are
excluded; entries are sorted for deterministic output.

## Configuration

All options are optional strings:

| Option | Default | Description |
|---|---|---|
| `typeMapName` | `SchemaTypeMap` | Name of the generated type-map type. |
| `typesImportPath` | `./graphql` | Module the generated TS types are imported from. |
| `typesNamespace` | `Types` | Namespace alias the generated types are imported under. |

```ts
'./src/__generated__/schema-type-map.ts': {
  plugins: ['@vantreeseba/graphql-mocks-codegen'],
  config: { typeMapName: 'MockTypes', typesImportPath: '../gen/types' },
},
```
