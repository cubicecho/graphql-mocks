# AGENTS.md

## Project

An npm-workspaces monorepo for the `@vantreeseba/graphql-mocks` toolkit. Two published packages:

- **`@vantreeseba/graphql-mocks`** (`packages/graphql-mocks`) — the runtime. Generate realistic, graph-connected mock data from a GraphQL schema using faker.
- **`@vantreeseba/graphql-mocks-codegen`** (`packages/graphql-mocks-codegen`) — a GraphQL Code Generator plugin that emits a `SchemaTypeMap` (`{ TypeName: GeneratedType }`) so `buildMocks<TTypes>` returns typed mock pools without a cast.

## Purpose

The runtime takes a `GraphQLSchema` (or SDL string), introspects all object types, and produces a set of interconnected mock objects where relationships are honored — e.g. `User.todos` references actual mocked `Todo` objects, and `Todo.user` points back to a `User`. Useful for tests, demos, and Storybook mocking.

The codegen plugin closes the typing loop: it generates a `SchemaTypeMap` from the schema, which you pass as the `TTypes` parameter to `buildMocks` / `MockResult` so pools come back fully typed.

## Specifications

Each package's API contract and options are documented in its own README:
[`packages/graphql-mocks/README.md`](./packages/graphql-mocks/README.md) and
[`packages/graphql-mocks-codegen/README.md`](./packages/graphql-mocks-codegen/README.md).

## Stack

- **Language:** TypeScript 5, strict mode, ESM only
- **Monorepo:** npm workspaces (`packages/*`); shared tooling (typescript, vitest, biome, semantic-release) lives in the root `package.json`
- **Tests:** Vitest + `@vitest/coverage-v8` (`npm test`, `npm run coverage`)
- **Formatting/linting:** Biome at the repo root (`npm run check`)
- **Build:** `tsc` per package (`npm run build`) — each outputs to its own `dist/`
- **Runtime peer deps:** `graphql >=16`, `@faker-js/faker >=9`; optional `graphql-scalars ^1.23` (scalar names recognized by convention; not imported at runtime) and `@apollo/client >=3.8 <5` (only for the `./apollo` subpath — the root entry never imports it)
- **Codegen peer deps:** `graphql >=16`, `@graphql-codegen/plugin-helpers >=5`, `@graphql-codegen/visitor-plugin-common >=5`
- **No lodash** — inline any string utilities needed

## Project structure

```
packages/
  graphql-mocks/              — the runtime library
    src/
      index.ts                — public API entry point
      mockSchema.ts           — main buildMocks() function
      scalarMockers.ts        — default scalar → faker mapping
      typeMocker.ts           — per-type field mock generator
      graphBuilder.ts         — assembles cross-type relationships into a graph
      executeOperation.ts     — runs an operation against the graph (dataForOperation)
      argMatching.ts          — opt-in interpretation of field arguments
      collection.ts           — paginate/searchItems array primitives
      apolloMocks.ts          — Apollo MockedProvider mock builders (mockOperation)
      requestHandler.ts       — graph-backed handler answering any operation
      mockScenarios.ts        — default/loading/errored handler options
      operationsFrom.ts       — variants keyed by a document module's exports
      apollo/index.ts         — ./apollo subpath: mockLink (optional @apollo/client peer)
      qa.ts                   — QA mode: presets, weird-value corpora, resolution helpers
      qaSets.ts               — buildQaSets(): one mock pool per QA preset
      resolveOptions.ts       — folds every option into the one shape the generator consumes
      relations.ts            — relations config: lookup, sizing, validation, pool demand
      scenarios.ts            — scenario merge, defineScenarios(), composeScenarios()
      matrix.ts               — buildMatrix(): one pool per scenario × QA-preset cell
      helpers.ts              — utility functions
      types.ts                — all public TypeScript types
      test/schema.ts          — test GraphQL schema (rich, with custom scalars)
      *.test.ts               — tests live alongside source modules
  graphql-mocks-codegen/      — the GraphQL Code Generator plugin
    src/index.ts              — plugin + validate; emits the SchemaTypeMap
    test/plugin.test.ts       — tests live in test/

biome.json, .releaserc.json   — repo-wide config at the root
package.json                  — workspaces root (private, not published)
```

## Key conventions

- Each package's exports go through its own `src/index.ts`
- Default scalar mockers: `String → faker.lorem.word()`, `Int → faker.number.int()`, etc.
- Unknown scalars fall back to `faker.lorem.word()` and emit `console.warn`
- Custom scalar names (e.g. `CityName`, `EmailAddress`) map to semantic faker calls
- Nullable fields have a configurable chance of being `null` (default 0)
- Scalar list fields generate 1–3 items; relationship list fields generate 1–5 items, unless `relations` says otherwise
- Circular references are resolved: back-references point to already-generated objects, not new ones
- User scalar overrides merge over the default map (user wins)
- Coverage target: ≥90% lines/branches (runtime); ≥95% (codegen plugin)

## Running locally

All commands run from the repo root and fan out across workspaces.

```bash
npm install
npm test            # vitest across all packages
npm run typecheck   # tsc --noEmit across all packages
npm run coverage    # vitest with v8 coverage across all packages
npm run build       # compile every package to its own dist/
npm run check       # biome lint + format check (whole repo)
```

Scope a script to one package with `-w`:

```bash
npm run test -w packages/graphql-mocks-codegen
```

## Releases

A single, repo-wide release driven by semantic-release at the root: it derives one
version from `v*` tags and, via `@semantic-release/exec`, bumps and publishes every
workspace together at that version. Do not run `@semantic-release/npm` per-package.

## Commit conventions

Follow semantic commits: `feat:`, `fix:`, `chore:`, `test:`, `docs:`.

## Git workflow

- **Never rebase.** Always integrate remote changes with a merge commit:
  ```bash
  git pull --no-rebase   # merge, not rebase
  git push
  ```
- Fast-forward is fine when it applies naturally; use `--no-rebase` to ensure merge
  semantics when the remote has diverged.
