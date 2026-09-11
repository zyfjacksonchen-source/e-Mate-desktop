# @e-mate/dsh-plugin-harmony

e-Mate's owner package for [`dsh-harmony`](https://github.com/memorax-ai/dsh-harmony)
0.8.10 — the runtime patcher that rewrites other Harness packages' compiled
bundles in memory.

```
upstream/plugins/dsh-harmony → (build.mjs copy) → lib/ assets/ browser-dist/ scripts/
```

The published tarball is copied verbatim, preserving the relative layout the built
code expects (`lib/installer.js` requires `../scripts/install-shim.cjs` and
`<packageRoot>/scripts/restart.cjs`; `lib/plugin.js` serves `../assets/*`).
Provenance, tarball hashes and the upstream file inventory live in
[`../../upstream/plugins/dsh-harmony/SOURCE.md`](../../upstream/plugins/dsh-harmony/SOURCE.md).

## Status — Path C slice 1 (skeleton only)

This package **exists and builds but is not mounted**. It is deliberately absent
from `packages/dsh/profile/component-inventory.json` and from the Desktop profile
inventory list. Two upstream surfaces are deliberately **not** mounted yet:

- **`dsh.client`** — the vendored `browser-dist/client.js` registers itself as
  module id `dsh-harmony` (line 3 of that file). The client loader keys modules by
  the owning package name, so mounting it under `@e-mate/dsh-plugin-harmony`
  without rewriting that single id would register the module under the wrong name.
  The bundle stays vendored for the slice that resolves this.
- **the `dsh-harmony/settings` row** — `lib/settings.js:1` imports
  `settingsNamespace` from `@deepseek-ai/dsh-settings`, and DSH 0.1.5 **deleted**
  that helper (facts §72.1). Upstream's `harmony.patch.yml` inserts that row;
  this package's [`cordis.patch.yml`](cordis.patch.yml) inserts only the runtime
  row.

```sh
pnpm --dir packages/dsh-plugin-harmony run build          # copy + assert seams
pnpm --dir packages/dsh-plugin-harmony run verify:seams   # assert only
pnpm --dir packages/dsh-plugin-harmony run test
```

## Seam assertions (fail closed)

Harmony rewrites compiled bundles, so `scripts/build.mjs` re-runs every builtin's
selection against the pinned 0.1.5 build and fails the build when one no longer
resolves. Asserted today (2026-09-11, this worktree):

| Builtin | Target (pinned) | sha256 (first 16) | Result |
|---|---|---|---|
| `client-load-plan.patch.cjs` | `@deepseek-ai/dsh-client-modules@0.1.5-rc.1/lib/index.js` | `4a44f8cf7b61a26a` | `resolveMeta` = 1 (current `locatePkgJson` branch), `graphRow` = 1 |
| `cordis-service-index.patch.cjs` | `@deepseek-ai/cordis@4.0.2/lib/index.js` | `1729cdbf8ee40b17` | `ReflectService`/`notify`/`registry.values()`/`runtime.fibers`/`Fiber`/`uid = null`/`internal/plugin` publication all = 1 |
| `settings.patch.cjs` | `@deepseek-ai/dsh-client-ui-settings-general@0.1.5-rc.1/lib/client.js` | `489e0d80b2378762` | `SettingsPanel`/`panel className`/`navIcon`/`close`/`onSelect: setActiveId` all = 1 |
| `session-profile.patch.cjs` | `@deepseek-ai/dsh-api-session-controller@0.1.5-rc.1/lib/client.js` | `ff33d1f85a0b2f14` | `Session.open` + `this.doOpen(this.openGeneration)` = 1 |

Declared `target.version` ranges (reported, never fatal — harmony itself only
raises a status warning, `lib/runtime.js:1114`):

| Builtin | Declared range | `0.1.5-rc.1` / pinned |
|---|---|---|
| `client-load-plan` | `>=0.1.1-rc.2 <0.1.2-0 \|\| >=0.1.2-alpha.4 <0.1.3-0` | **not satisfied** |
| `cordis-service-index` | `>=4.0.1` | satisfied (4.0.2) |
| `settings` | `>=0.1.0-rc.8 <0.1.2-0 \|\| >=0.1.2-alpha.4 <0.1.3-0` | **not satisfied** |
| `session-profile` | `>=0.1.2-alpha.4 <0.1.3-0` | **not satisfied** |

`scripts/seams.mjs` evaluates those ranges with a documented semver subset that
mirrors `semver.satisfies(v, r, { includePrerelease: true })`; it was cross-checked
against `semver@7.8.5` over 105 (version, range) pairs — 105/105 agree (facts §76).

## Open dependency gaps (reported, not fixed here)

The vendored host entry (`lib/index.js` → `lib/plugin.js`) imports these at load
time. The checked list lives in `scripts/seams.mjs#LOAD_DEPENDENCIES`:

| Specifier | Sites | Pinned closure |
|---|---|---|
| `@deepseek-ai/dsh-atomic-write` | `lib/profile.js:5`, `lib/session-profile.js:3` | Harness ships `0.1.5-rc.1`, but `base-contract.json` does not declare it, so `baseImports` cannot link it |
| `@phenomnomnominal/tsquery` (+ `dist/src/traverse.js`, `dist/src/matchers/sibling.js`) | `lib/transform.js:4-6` | missing from the closure |
| `magic-string` | `lib/transform.js:2` | missing from the closure |
| `semver` | `lib/compatibility.js:1`, `lib/dsh.js:5`, `lib/runtime.js:7` | missing from the closure |
| `typescript` | `lib/transform.js:3`, `lib/runtime.js:8`, `lib/orchestrator.js:3` | only inside the pinned Harness checkout |
| `@deepseek-ai/dsh-settings` | `lib/settings.js:1` | present, but the imported `settingsNamespace()` was deleted in 0.1.5 |
| `@deepseek-ai/schemastery` | `lib/settings.js:2` | present 3.18.2 |
| `@deepseek-ai/dsh/lib/bin.js` | `lib/dsh.js:9` (launcher path only) | Harness ships `@deepseek-ai/dsh` from `apps/cli` |

This package adds **no** registry dependency. `eMate.baseImports` declares only the
two `@deepseek-ai/*` names the pinned closure can actually link
(`@deepseek-ai/dsh-settings`, `@deepseek-ai/schemastery`); the missing npm packages
above must be resolved by a dependency decision the main agent owns — not by a
silent install here.

## How the two Path C owners connect

`dsh-turn-fold` declares `dsh.harmony.patches` and `inject: [harmony]`; the
`harmony` Cordis service this package mounts is what reads that list and applies the
patches. Neither upstream is 0.1.5-aware: DSH 0.1.5 has **no** Harmony layer of its
own, which is exactly why both upstreams are vendored together.
