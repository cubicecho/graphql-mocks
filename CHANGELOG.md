# [3.3.0](https://github.com/cubicecho/graphql-mocks/compare/v3.2.0...v3.3.0) (2026-09-17)


### Bug Fixes

* **apollo:** type createMockClient's defaultOptions as a deep partial ([163524f](https://github.com/cubicecho/graphql-mocks/commit/163524fd67a2fad0aef535e0a769673cb4402dbf)), closes [#28](https://github.com/cubicecho/graphql-mocks/issues/28)
* **graphql-mocks:** keep an emptied wrapper list empty under argument matching ([f598e5b](https://github.com/cubicecho/graphql-mocks/commit/f598e5b6f07b891f3c02bba0f1210258a896232b)), closes [#14](https://github.com/cubicecho/graphql-mocks/issues/14) [#26](https://github.com/cubicecho/graphql-mocks/issues/26)
* **graphql-mocks:** walk mock namespaces cycle-safely ([855b7c3](https://github.com/cubicecho/graphql-mocks/commit/855b7c37df253194d048779711e2e5a87a79285d)), closes [#25](https://github.com/cubicecho/graphql-mocks/issues/25)


### Features

* **graphql-mocks:** make countFields a build option, not a QA-only one ([b4030f6](https://github.com/cubicecho/graphql-mocks/commit/b4030f69111cae2aa81ab90b5c44315b8cc65080)), closes [#27](https://github.com/cubicecho/graphql-mocks/issues/27)

# [3.2.0](https://github.com/cubicecho/graphql-mocks/compare/v3.1.0...v3.2.0) (2026-09-16)


### Features

* **apollo:** add createMockClient and a Storybook decorator ([8d878a9](https://github.com/cubicecho/graphql-mocks/commit/8d878a950f94861780e820d08defd708673d686c)), closes [#9](https://github.com/cubicecho/graphql-mocks/issues/9)
* **graphql-mocks:** add a derive phase for fields computed from the object ([dd633bc](https://github.com/cubicecho/graphql-mocks/commit/dd633bcd10d3f419e87513eabcb22c08899b3da3)), closes [#13](https://github.com/cubicecho/graphql-mocks/issues/13)
* **graphql-mocks:** apply arguments to the list inside a wrapper type ([de71d7b](https://github.com/cubicecho/graphql-mocks/commit/de71d7b362a7d618c5cedccdb503dd644cdbe108)), closes [#10](https://github.com/cubicecho/graphql-mocks/issues/10)
* **graphql-mocks:** keep count scalars in step with QA list profiles ([ca223bd](https://github.com/cubicecho/graphql-mocks/commit/ca223bd390ec4cfe84dc18b8beb88da9a1be0357)), closes [#14](https://github.com/cubicecho/graphql-mocks/issues/14)
* **graphql-mocks:** make cyclic mock data safe to traverse ([d22a9ac](https://github.com/cubicecho/graphql-mocks/commit/d22a9ac2f06aaa0570a017a8ecc508223e758506)), closes [#16](https://github.com/cubicecho/graphql-mocks/issues/16)
* **graphql-mocks:** match arguments inside nested input objects ([8ec97ad](https://github.com/cubicecho/graphql-mocks/commit/8ec97adc93fcc757252c2b2675c3025f8011992a)), closes [#11](https://github.com/cubicecho/graphql-mocks/issues/11)
* **graphql-mocks:** tell apart selections that differ only by an argument ([8bfc39b](https://github.com/cubicecho/graphql-mocks/commit/8bfc39b9233580fb250d922910db45ddd554e25c)), closes [#12](https://github.com/cubicecho/graphql-mocks/issues/12)
* **graphql-mocks:** validate Apollo mock shapes that fail silently ([cfb44b8](https://github.com/cubicecho/graphql-mocks/commit/cfb44b83e4bc632994489b650e12fe758cab5662)), closes [#15](https://github.com/cubicecho/graphql-mocks/issues/15)

# [3.1.0](https://github.com/cubicecho/graphql-mocks/compare/v3.0.0...v3.1.0) (2026-09-16)


### Bug Fixes

* **ci:** point the repository URLs at cubicecho/graphql-mocks ([e1d7e56](https://github.com/cubicecho/graphql-mocks/commit/e1d7e56f58a289337bc96b771791b3e8cfdcdef0))
* **graphql-mocks:** keep the test suite typechecking ([4258180](https://github.com/cubicecho/graphql-mocks/commit/4258180b0af2474c16c0fcfbd3c084bb7b7554bb))


### Features

* **graphql-mocks:** accept a resolver function as mockOperation data ([0e0a661](https://github.com/cubicecho/graphql-mocks/commit/0e0a661004a6ed10d162e10454c3c510da998172))
* **graphql-mocks:** add @vantreeseba/graphql-mocks/apollo link export ([c168d63](https://github.com/cubicecho/graphql-mocks/commit/c168d632d601c3b076fbaff6e21476d2f6fc1280))
* **graphql-mocks:** add graph-backed request handler ([0185364](https://github.com/cubicecho/graphql-mocks/commit/0185364da951a0d01cd46419c7b291cd4ac6533c))
* **graphql-mocks:** add ids/at/byId pool accessors ([a7d157c](https://github.com/cubicecho/graphql-mocks/commit/a7d157c116cc7785bbf8286c9dd9cdb9572a4561))
* **graphql-mocks:** add mockScenarios factory ([3368e93](https://github.com/cubicecho/graphql-mocks/commit/3368e93fef8c415c078f748e3fda3d0114e2a9ad))
* **graphql-mocks:** add opt-in argument-aware root field resolution ([bc65e6f](https://github.com/cubicecho/graphql-mocks/commit/bc65e6fa5e06eaac8836ad2630abd448ddafb1b0))
* **graphql-mocks:** add opt-in reciprocal relationship wiring ([d08addb](https://github.com/cubicecho/graphql-mocks/commit/d08addbb397c8989419e158a625bcfa54b4de3f8))
* **graphql-mocks:** add paginate/searchItems helpers and listSize option ([14bf99b](https://github.com/cubicecho/graphql-mocks/commit/14bf99b527c264b3ac00c3ecc5879fa7073f2c07))
* **graphql-mocks:** add QA mode for out-of-norm mock data ([0d9d750](https://github.com/cubicecho/graphql-mocks/commit/0d9d75030513d88e5f1234c2b87e380dd1fd4d91)), closes [#3](https://github.com/cubicecho/graphql-mocks/issues/3)
* **graphql-mocks:** add relation spec types and lookup ([5467ce6](https://github.com/cubicecho/graphql-mocks/commit/5467ce65f6f2772f5cf0bbd7b3f16d59498d6b87))
* **graphql-mocks:** build a scenario × QA matrix in one call ([89e9b40](https://github.com/cubicecho/graphql-mocks/commit/89e9b408bc124986eea8b50d5ff2712e44fa5332))
* **graphql-mocks:** derive operation mocks from a document module ([da5ce52](https://github.com/cubicecho/graphql-mocks/commit/da5ce527eb86264eeeef04f3ad243d93bd3cc8a2))
* **graphql-mocks:** give field overrides their site and index ([cd3cc0e](https://github.com/cubicecho/graphql-mocks/commit/cd3cc0eeb02e21b4f6762a87153eeb735127bbb7))
* **graphql-mocks:** grow pools to meet relation demand ([ae77587](https://github.com/cubicecho/graphql-mocks/commit/ae775874d50e503726bf8d1c3aae762ca685a0fa))
* **graphql-mocks:** merge scenario layers into build options ([013b98c](https://github.com/cubicecho/graphql-mocks/commit/013b98cdaf0642be88ec538d4c005927d7cbf1bf))
* **graphql-mocks:** shape root fields with relations ([b70a2fa](https://github.com/cubicecho/graphql-mocks/commit/b70a2fa019668171286bc4163f819cdb1fc04cb6))
* **graphql-mocks:** validate relations and keep graphs executable ([2261527](https://github.com/cubicecho/graphql-mocks/commit/22615276ff90d7887684fe42540c11c3938c9406))
* **graphql-mocks:** wire relations into relationship building ([0145f20](https://github.com/cubicecho/graphql-mocks/commit/0145f2018d28deed3df91af818acf5be16fc8b7c))

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
