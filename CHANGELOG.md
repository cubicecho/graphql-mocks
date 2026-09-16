# [3.0.0](https://github.com/cubicecho/graphql-mocks/compare/v2.3.0...v3.0.0) (2026-06-20)


* feat(graphql-mocks)!: resolve mockOperation data from the mock graph ([a09847e](https://github.com/cubicecho/graphql-mocks/commit/a09847e56fb65a56c78eb0794009535697879f10))


### BREAKING CHANGES

* remove `mockOperationFromPool` and
`mockOperationVariantsFromPool`; use `mocks.mockOperation(query)` and
`mocks.mockOperationVariants(query)` instead.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>

# [2.3.0](https://github.com/cubicecho/graphql-mocks/compare/v2.2.0...v2.3.0) (2026-06-20)


### Bug Fixes

* **graphql-mocks:** use optional chaining on mock pool in operation test ([8645dba](https://github.com/cubicecho/graphql-mocks/commit/8645dba87c870c91a79486e05546509d613430fb))


### Features

* **graphql-mocks:** add Apollo MockedProvider mock builders ([6bcfc3e](https://github.com/cubicecho/graphql-mocks/commit/6bcfc3ea9634974884a5d76ba69f0003e55b6976))
* **graphql-mocks:** resolve operation data from the mock graph ([cb18ba7](https://github.com/cubicecho/graphql-mocks/commit/cb18ba71097aabc12efb5c67dfc5a60ed319552d))

# [2.2.0](https://github.com/cubicecho/graphql-mocks/compare/v2.1.1...v2.2.0) (2026-06-20)


### Features

* **graphql-mocks:** type options and toResolvers against TTypes ([e0d56bc](https://github.com/cubicecho/graphql-mocks/commit/e0d56bcdbdfc5cc875d649f6d0e6f7a674bd414f))

## [2.1.1](https://github.com/cubicecho/graphql-mocks/compare/v2.1.0...v2.1.1) (2026-06-19)


### Bug Fixes

* ship CJS build so graphql-codegen can require the plugin ([dadd953](https://github.com/cubicecho/graphql-mocks/commit/dadd9533faebe770db00376e720077b5290861ed))

# [2.1.0](https://github.com/cubicecho/graphql-mocks/compare/v2.0.1...v2.1.0) (2026-06-19)


### Features

* add @vantreeseba/graphql-mocks-codegen package ([2a1a8b8](https://github.com/cubicecho/graphql-mocks/commit/2a1a8b80913b358375be37c19865bc39aba8efb2))

## [2.0.1](https://github.com/cubicecho/graphql-mocks/compare/v2.0.0...v2.0.1) (2026-06-19)


### Bug Fixes

* add repository, homepage, bugs, author, license and keywords to package.json ([456eb10](https://github.com/cubicecho/graphql-mocks/commit/456eb10c60f3e105bd4544baf2d68fe32d81eb28))

# [2.0.0](https://github.com/cubicecho/graphql-mocks/compare/v1.1.0...v2.0.0) (2026-06-19)


### chore

* flag __typename default as a breaking change ([fa34f9a](https://github.com/cubicecho/graphql-mocks/commit/fa34f9a48390240f6f82d87759bd136f45dbf4f5))


### BREAKING CHANGES

* addTypename now defaults to true, so every generated object
includes a __typename field. This is required by the Apollo cache and is the
common case, but it changes object shape — exact-shape assertions and
snapshots will now see an extra __typename key. Pass addTypename: false to
restore the previous behavior.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>

# [1.1.0](https://github.com/cubicecho/graphql-mocks/compare/v1.0.5...v1.1.0) (2026-06-19)


### Features

* typed pools + DX options (__typename, stableIds, faker in overrides) ([7c799e5](https://github.com/cubicecho/graphql-mocks/commit/7c799e564827d6d4e75f020e4d99c5692d270d6b))

# Unreleased

### Features

* typed pools via `buildMocks<TTypes>` / `MockResult<TTypes>` and type-aware `find()` ([7c799e5](https://github.com/cubicecho/graphql-mocks/commit/7c799e5))
* `stableIds` option for stable `TypeName-<index>` ids ([7c799e5](https://github.com/cubicecho/graphql-mocks/commit/7c799e5))
* override functions now receive the seeded faker instance ([7c799e5](https://github.com/cubicecho/graphql-mocks/commit/7c799e5))

### BREAKING CHANGES

* `addTypename` now defaults to `true`, so every generated object includes a `__typename` field. This is required by the Apollo cache and is the common case, but it changes object shape: exact-shape assertions and snapshots will now see an extra `__typename` key. Pass `addTypename: false` to restore the previous behavior.

## [1.0.5](https://github.com/cubicecho/graphql-mocks/compare/v1.0.4...v1.0.5) (2026-05-14)


### Bug Fixes

* **ci:** build dist before publishing; add typecheck script ([8b2ed98](https://github.com/cubicecho/graphql-mocks/commit/8b2ed988ec404b1cf0fe180d81840428965945f6))

## [1.0.4](https://github.com/cubicecho/graphql-mocks/compare/v1.0.3...v1.0.4) (2026-05-14)


### Bug Fixes

* codebase cleanup and accuracy pass ([9ac2162](https://github.com/cubicecho/graphql-mocks/commit/9ac2162349eabbc85ffcf82efd7d606555dc06a4))

## [1.0.3](https://github.com/cubicecho/graphql-mocks/compare/v1.0.2...v1.0.3) (2026-05-13)


### Bug Fixes

* **test:** trigger release to validate new CI workflow ([7ca1197](https://github.com/cubicecho/graphql-mocks/commit/7ca119775eec1791d6681a748833364380b59618))

## [1.0.2](https://github.com/cubicecho/graphql-mocks/compare/v1.0.1...v1.0.2) (2026-05-13)


### Bug Fixes

* **ci:** exclude package.json and CHANGELOG.md from biome ([89bb85f](https://github.com/cubicecho/graphql-mocks/commit/89bb85fd3b33d0163d880fd046ae0d62b5a9058d))

## [1.0.1](https://github.com/cubicecho/graphql-mocks/compare/v1.0.0...v1.0.1) (2026-05-13)


### Bug Fixes

* **release:** set publishConfig access to public for scoped package ([11c6b66](https://github.com/cubicecho/graphql-mocks/commit/11c6b6656bd1449a7e8cc8e230232390170d84bd))

# 1.0.0 (2026-05-13)


### Bug Fixes

* **ci:** bump Node to 24 — semantic-release v25 requires >=22.14 ([5d5f3d5](https://github.com/cubicecho/graphql-mocks/commit/5d5f3d578dbf6ff2dfde313d8ae59ed6c118ed0f))
* **ci:** exclude dist/ and coverage/ from biome, fix package.json format ([8e94799](https://github.com/cubicecho/graphql-mocks/commit/8e94799691adbf5df19b4380f2999c82c0f95310))


### Features

* initial implementation of @vantreeseba/graphql-mocks ([5e9b67b](https://github.com/cubicecho/graphql-mocks/commit/5e9b67bf4565da25d9dd1fbf2134fe3e5667eb65))
