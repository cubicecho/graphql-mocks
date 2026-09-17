# Contributing

Thanks for taking a look. This file covers working **on** the repo; for working
**with** the published packages, start at [How to use this library](./docs/getting-started.md).

## Setup

An npm-workspaces monorepo. One install at the root covers every package.

```bash
git clone https://github.com/cubicecho/graphql-mocks.git
cd graphql-mocks
npm install
```

Node 24 is what CI runs. TypeScript 5, strict, **ESM only** — relative imports
carry their `.js` extension because the packages compile under `NodeNext`.

## The commands

All of these run from the root and fan out across workspaces:

```bash
npm test             # vitest, every package
npm run typecheck    # tsc --noEmit, every package
npm run typecheck:tests   # the test files, which have their own tsconfig
npm run coverage     # vitest with v8 coverage
npm run build        # compile every package to its own dist/
npm run check        # biome lint + format check (whole repo)
npm run format       # biome format --write
```

Scope any of them to one package with `-w`:

```bash
npm run test -w packages/graphql-mocks-codegen
npx vitest run packages/graphql-mocks/src/qa.test.ts
```

CI runs exactly this, in this order: `biome check .`, `typecheck`,
`typecheck:tests`, `test`, `coverage`, `build`. Running `npm run check && npm run
typecheck && npm run typecheck:tests && npm test` locally covers all of it bar
the build.

## Layout

```
packages/
  graphql-mocks/            the runtime
    src/
      index.ts              the public API — an export lands here or it isn't public
      mockSchema.ts         buildMocks()
      typeMocker.ts         per-type field generation
      graphBuilder.ts       relationship wiring, reciprocal mirroring, count sync, derive
      executeOperation.ts   dataForOperation(), wrapper/connection unwrapping
      argMatching.ts        opt-in interpretation of field arguments
      countFields.ts        pairing count scalars with the lists they count
      relations.ts          relations config: lookup, sizing, validation, pool demand
      resolveOptions.ts     every option folded into the one shape the generator consumes
      scenarios.ts          scenario merge, defineScenarios(), composeScenarios()
      matrix.ts             buildMatrix(): one pool per scenario x QA-preset cell
      qa.ts / qaSets.ts     QA mode: presets, weird-value corpora, one pool per preset
      requestHandler.ts     graph-backed handler answering any operation
      apolloMocks.ts        MockedProvider mock builders
      mockScenarios.ts      default/loading/errored handler options
      operationsFrom.ts     variants keyed by a document module's exports
      validateMocks.ts      checks for mock shapes that fail silently
      plain.ts              toPlain()/select(): cycle-safe views of pooled objects
      collection.ts         paginate/searchItems array primitives
      apollo/index.ts       ./apollo subpath: mockLink, createMockClient, withGraphqlMocks
      types.ts              all public TypeScript types
      test/schema.ts        the shared test schema
  graphql-mocks-codegen/    the GraphQL Code Generator plugin
```

Tests live beside the module they cover (`qa.ts` / `qa.test.ts`), except in the
codegen package, where they live in `test/`.

## Conventions

- **Exports** go through each package's `src/index.ts`. Adding a public export
  means documenting it in that package's README, and usually in `llms.txt` and
  `context7.json` too.
- **No lodash.** Inline whatever string or array utility you need.
- **Formatting is Biome's** — 2-space indent, 100-column lines, single quotes,
  trailing commas. Don't hand-format; run `npm run check` (or
  `npx biome check --write <path>`).
- **Comments explain *why*.** The code says what it does; a comment earns its
  place by recording the constraint, trade-off or bug that shaped it.
- **Coverage floor:** runtime 90% lines/functions/statements, 85% branches;
  codegen plugin 95% and 90%. `npm run coverage` fails the build under them.
- **`@apollo/client` is an optional peer.** It may only be imported from
  `src/apollo/`; the root entry must stay importable without it.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/) — the release is
derived from them, so the prefix decides the version bump:

| Prefix | Bump | For |
|---|---|---|
| `fix:` | patch | A bug fix |
| `feat:` | minor | A new capability |
| `feat!:` / `BREAKING CHANGE:` footer | major | An incompatible change |
| `docs:` / `chore:` / `test:` / `refactor:` | none | Everything else |

Scope with the package when it's specific to one: `feat(graphql-mocks): …`,
`fix(apollo): …`.

## Git workflow

**Never rebase.** Integrate remote changes with a merge:

```bash
git pull --no-rebase
```

Fast-forward is fine when it applies naturally; `--no-rebase` is there to keep
merge semantics once the remote has diverged.

Work on a branch, open a pull request, and let CI go green before merging.
One logical change per PR — the release notes are generated from the commits, so
a PR that does two unrelated things reads as one entry that describes neither.

## Releases

You don't cut them. semantic-release runs at the root on every push to `main`
that passes CI: it derives one version from the `v*` tags, and via
`@semantic-release/exec` bumps and publishes **every** workspace together at that
version, then commits `chore(release): X.Y.Z [skip ci]` with the changelog. Both
packages always share a version number. Don't bump `package.json` by hand, and
don't add `@semantic-release/npm` per package.

## Filing an issue

A schema snippet, the `buildMocks` options, and what came back versus what you
expected is usually the whole report — the library is deterministic under `seed`,
so a seeded repro reproduces exactly. [Issues](https://github.com/cubicecho/graphql-mocks/issues).
