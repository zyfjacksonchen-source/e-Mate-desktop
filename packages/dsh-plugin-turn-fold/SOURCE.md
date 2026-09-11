# Source and local modifications

This package is an e-Mate adapter around a vendored third-party upstream. The
vendored tree itself lives at `upstream/plugins/dsh-turn-fold` and carries its own
provenance, upstream file hashes and modification log
([`SOURCE.md`](../../upstream/plugins/dsh-turn-fold/SOURCE.md)).

## Provenance

| Field | Value |
|---|---|
| Upstream | `@ch4acko3/dsh-turn-fold` 0.6.0 — https://github.com/CH4ACKO3/dsh-turn-fold |
| Upstream commit | `69867494627d58da4d17f5842bda7d1c36fa34d2` (`release: v0.6.0`) |
| Vendored tree | `upstream/plugins/dsh-turn-fold` (17 files, sha256 recorded there) |
| Copied into `lib/` | `index.cjs`, `settings.cjs`, `patch.cjs`, `inline-source.cjs`, `locales.cjs`, `locales/{en,zh}.json` — verbatim |
| Licence | MIT (upstream `LICENSE` copied to this package) |

## What e-Mate adds (no upstream byte is edited)

1. **`package.json`** — the e-Mate identity (`@e-mate/dsh-plugin-turn-fold`,
   `2.0.18`, `license: MIT`), `main: lib/index.cjs`, the `files` allowlist the
   bundle sync reads, `eMate.harnessVersion`/`harnessCommit`, and the
   `dsh.harmony.patches` list pointing at the copied `./lib/patch.cjs`. No
   dependency or peer-dependency is added.
2. **`cordis.patch.yml`** — the e-Mate mount row (`emate-turn-fold`,
   `name: '@e-mate/dsh-plugin-turn-fold'`, `inject: [harmony]`), replacing
   upstream's `ch4acko3-dsh-turn-fold` row.
3. **`scripts/build.mjs`** — copies the vendored files and then asserts the seams.
4. **`scripts/seams.mjs`** — the fail-closed seam checker against the pinned 0.1.5
   build; **`scripts/tsquery-subset.mjs`** — the tsquery-semantics subset it uses.
5. **`scripts/shipped.mjs`**, **`test/package.test.mjs`**, **`README.md`**,
   **`SOURCE.md`**, **`pnpm-lock.yaml`** (empty importer — this package has no
   dependencies).

`lib/` is generated build output and is not tracked (root `.gitignore`:
`packages/dsh-plugin-*/lib/`).
