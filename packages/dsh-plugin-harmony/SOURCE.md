# Source and local modifications

This package is an e-Mate adapter around a vendored third-party upstream. The
vendored tree itself lives at `upstream/plugins/dsh-harmony` and carries its own
provenance, tarball hashes and upstream file inventory
([`SOURCE.md`](../../upstream/plugins/dsh-harmony/SOURCE.md)).

## Provenance

| Field | Value |
|---|---|
| Upstream | `dsh-harmony` 0.8.10 — https://github.com/memorax-ai/dsh-harmony |
| npm `gitHead` | `44e7de03d6414c5681eb314d1d9f1cfb2e2c9428` |
| Tarball | `https://registry.npmjs.org/dsh-harmony/-/dsh-harmony-0.8.10.tgz` |
| Tarball sha256 | `a45b92a4acb9e71f97c1ab62bdb2ac79974c5429e4bd2631e8afab01af42f4c4` |
| npm integrity | `sha512-397JkAGn1rz44Mq+2f9rn9jkUbzUD/yDMicxuXhYzRe5w+NYfu7DTPnAKKKo1zoNtclNxcWAquwCG8Ok4ncJ/g==` |
| Vendored tree | `upstream/plugins/dsh-harmony` (69 published files, sha256 recorded there) |
| Copied into this package | `lib/`, `assets/`, `browser-dist/` verbatim + `scripts/install-shim.cjs`, `scripts/restart.cjs` |
| Licence | MIT (upstream `LICENSE` copied to this package) |

Only the published tarball exists upstream — `src/` and the test suites are not
published, so this is a JS (binary) vendor, not a source vendor.

## What e-Mate adds (no upstream byte is edited)

1. **`package.json`** — the e-Mate identity (`@e-mate/dsh-plugin-harmony`,
   `2.0.18`, `license: MIT`), `main: lib/index.js`, the `files` allowlist the bundle
   sync reads, `eMate.harnessVersion`/`harnessCommit`, and the `dsh.harmony.patches`
   list re-declared against the copied paths. `dsh.client` is intentionally
   **omitted** (see `README.md` § Status). No dependency or peer-dependency is added.
2. **`cordis.patch.yml`** — the e-Mate mount row `emate-harmony`
   (`name: '@e-mate/dsh-plugin-harmony'`). Upstream's `harmony.patch.yml`, which
   inserts the upstream `dsh-harmony` and `dsh-harmony/settings` rows, is **not**
   shipped.
3. **`scripts/build.mjs`** — copies the vendored trees and asserts the seams.
4. **`scripts/seams.mjs`** — the fail-closed per-builtin seam checker, the
   semver-subset range evaluator and the dependency-gap list;
   **`scripts/tsquery-subset.mjs`** — the tsquery-semantics subset it uses.
5. **`scripts/shipped.mjs`**, **`test/package.test.mjs`**, **`README.md`**,
   **`SOURCE.md`**, **`pnpm-lock.yaml`** (empty importer — no dependencies).

The copied `lib/`, `assets/` and `browser-dist/` trees are generated/vendored output
and are not tracked; root `.gitignore` ignores `packages/dsh-plugin-*/lib/`, so add
these paths to the ignore list or to the build step when this package is wired in.
