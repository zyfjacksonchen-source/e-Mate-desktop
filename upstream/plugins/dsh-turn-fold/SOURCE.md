# Vendored: dsh-turn-fold

Third-party source copy, vendored by e-Mate following the same spirit as
`upstream/deepseek-harness/vendor/README.md`: the copied tree is auditable and
pinned, divergence from upstream is logged here, and every file hash is recorded
so a later sync can prove what changed.

## Provenance

| Field | Value |
|---|---|
| npm / package name | `@ch4acko3/dsh-turn-fold` |
| Version | `0.6.0` |
| Repository | https://github.com/CH4ACKO3/dsh-turn-fold |
| Commit | `69867494627d58da4d17f5842bda7d1c36fa34d2` |
| Commit subject / date | `release: v0.6.0` — 2026-09-03 01:11:04 +0800 |
| Fetch method | `git clone https://github.com/CH4ACKO3/dsh-turn-fold` then `git archive HEAD \| tar -x` into this directory |
| Vendored by | e-Mate 2.0.18, Path C slice 1 (`docs/2.0.18/dsh-0.1.5-upgrade-facts.md` §76) |

The vendored tree contains **tracked upstream content only**: no `.git`, no
`node_modules`. `.github/`, `.gitignore` and `package-lock.json` are kept so the
snapshot stays a faithful copy of the pinned revision (the nested
`.github/workflows` do not run under this repository).

Owning e-Mate package: `packages/dsh-plugin-turn-fold` (`@e-mate/dsh-plugin-turn-fold`).

## Why it is vendored rather than depended on

The upstream peer ranges are written for the 0.1.2-alpha line
(`@deepseek-ai/dsh-client-ui-chat >=0.1.2-alpha.5 <0.1.3-0`,
`ui-conversation`/`dsh-settings >=0.1.0-rc.8 <=0.1.1-rc.2 || >=0.1.2-alpha.5 <0.1.3-0`)
and it hard-peers `dsh-harmony ^0.8.10`. The pinned e-Mate baseline is
`@deepseek-ai/dsh@0.1.5-rc.1` (commit `d1d095bee770c3e9d302f844083e02f0b74576ee`),
which satisfies none of those ranges, and DSH 0.1.5 has no `dsh.harmony.patches`
consumer of its own — the consumer is the vendored `dsh-harmony` runtime. Vendoring
both is what makes a 0.1.5-compatible port possible without touching the pinned
Harness submodule.

## Local modifications vs upstream

None yet. Slice 1 vendors the tree verbatim; the e-Mate side keeps its own
manifest, `cordis.patch.yml`, build script, seam assertions and README under
`packages/dsh-plugin-turn-fold`, and copies the upstream files into `lib/` at
build time instead of editing them in place. Every divergence added later must be
logged here.

## File inventory (sha256 of the vendored content)

```
2f68eb35ef5ba7e10f760ded73d053518caa503aa86adeb6bf693acffb08f2da  .github/workflows/ci.yml
354a15062727898e67e599b342052bd00572e2d00889563fca69260d5c63289f  .github/workflows/release.yml
ba79bbc25fa8951489e77f28f1561c2e9388115cb33f1c606424f8e08169f96b  .gitignore
4931aba59ec933d025050c57b79a68c1c8918a3868082bc19a032e931fe85468  LICENSE
924d083633ee51c2eb62f872adea5de0d0565ef153b3bc4cb25c1dc53028cfed  README.md
980aa8fab4ffea5428b79fdcd9a03778c0e7ece503d4307ce6cbf81e1e5549aa  README.zh-CN.md
b8980daf64ebc92318e47df46adbea20a97cd75c365d8fec27483a2359141f21  harmony.patch.yml
885c9cafb0cbbf720ded02ea49fccbf37d44a45fe4ecdc89d209130342cffd2b  index.cjs
4be1a988e36f237f3a5a9810bb3234a963c2b58a3d57f78ca997ae13cddaaca6  inline-source.cjs
bca7ec672d062b59e90624f2cc7bc1b6e6b62c54c5f22d5f74788d859900ad9a  locales.cjs
cf6e5c30d377f7f07a719d871259e5e94086775f27278372e4994fd08c51e2a7  locales/en.json
3a19a807be3b98582e8e773245be6f071be10050056398aef895ed0d7d988241  locales/zh.json
2b3dc3c233223def5c2db22e3a80adda61feeeac633611124714b056bc7b0cca  package-lock.json
46b2d997f1f2cfb46877d8acf553e3d7bd6748927f11e0b1b0734ac99911532e  package.json
c14763a1824c55733e4f47c505f40fc9e97bad4785717d5b06a614fbbd3f7dd9  patch.cjs
bbf07d4a81c9b2741fc520a93e58078865e2cd7570c4235ce5f3c36c5fa793d8  settings.cjs
5e5e74d7751bc41a7146efdc0446155ddba2e9c42c05176e7ec96e10b51d47fe  test/run.cjs
```

## Runtime dependency of the vendored code

The upstream bundle needs `@deepseek-ai/schemastery` at Host runtime
(`settings.cjs` requires it lazily inside `createSettingsSchema()`). The pinned
Harness vendors that package as `@deepseek-ai/schemastery@3.18.2`, declared in
`desktop/e-mate-desktop/base-contract.json` `runtime_imports`, so the owning
package declares it in `eMate.baseImports` instead of adding a registry
dependency. See `packages/dsh-plugin-turn-fold/README.md`.
