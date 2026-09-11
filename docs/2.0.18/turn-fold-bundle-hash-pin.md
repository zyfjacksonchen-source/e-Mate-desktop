# Turn-fold bundle hash pin — the fourth exemption condition, implemented

**中文摘要**：AGENTS.md 给 dsh-turn-fold 的四条豁免条件里，"bundle hash must be verified" 此前**只有打印、没有校验**。
现在 `packages/dsh-plugin-turn-fold/scripts/seams.mjs` 导出常量 `TARGET_BUNDLE_SHA256`（`cf53ae8f…ba97`），
`assertSeams()` **先**校验哈希再评估选择器：不匹配时在评估任何选择器**之前**拒绝（`evaluated: false`、`seams: []`、
`symbols: []`），同时把两个哈希都报出来；错误与报告沿用既有的 result shape。已用"把常量改成近似错误哈希"实测变红、
还原后变绿。**仍是构建/校验闸门**：运行时加载器（vendored `patch.cjs`，不在本次写集内）并不自己查哈希——见 §6。

Scope: `packages/dsh-plugin-turn-fold/scripts/seams.mjs` and `test/seams.test.mjs` only (both tracked; diff
`+227/-12`). Nothing in `upstream/**`, `desktop/**`, the profile, manifests or lockfiles was touched, and no
compiled Harness artifact was written.

## 1. What was missing

`AGENTS.md` (Current release direction) grants one exemption: *"the patches must stay in memory (never written to
disk), each selector must still match exactly once or the patch is refused, **the bundle hash must be verified**, and
no other plugin may parse sources or rewrite a Harness artifact."*

After this change all four hold:

| # | Condition | Enforced by |
|---|---|---|
| 1 | patches stay in memory, never written to disk | `scripts/no-core-rewrite-guard.mjs` rule `harness-artifact-write` (never exempt, even inside the provider roots) + the new `NEVER WRITES` test in §4 |
| 2 | each selector matches exactly once or the patch is refused | `SEAMS[].expect === 1` in `seams.mjs` (harness-runtime `expect` is the load-time refusal) |
| 3 | **the bundle hash must be verified** | **new: `TARGET_BUNDLE_SHA256` + the gate in `assertSeams()`** |
| 4 | no other plugin parses sources or rewrites a Harness artifact | `scripts/no-core-rewrite-guard.mjs` rules 1–2, exemption limited to `EXEMPT_PROVIDER_ROOTS` |

## 2. The pin

```js
export const TARGET_BUNDLE_SHA256 = 'cf53ae8f5978901504286189a64506febf09cd237d097db3abf3f39b3953ba97'
```

* Target: `@deepseek-ai/dsh-client-ui-chat/lib/client.js` in the pinned checkout
  (`upstream/deepseek-harness`, submodule HEAD `f9e0f1190e4021e63db579ef36b67484028e8c53`).
* Measured on this checkout: `shasum -a 256` → `cf53ae8f…ba97`; `wc -c` → **370637** bytes.
* **Byte-count discrepancy (report, do not decide):** the work order recorded "369607 bytes" for this bundle; the
  file measures **370637** bytes with exactly that digest. The digest is pinned as instructed; the size is only
  reported (`report.fileBytes`) and deliberately **not** asserted, so a wrong size cannot become a second pin.
* It is a deliberate constant, never computed at run time: a Harness rebuild must re-verify the selectors by hand
  and then move this value on purpose.

## 3. Enforcement order and result shape

`assertSeams()` now runs the hash gate **first**:

1. resolve harness root → compiler → target, compute `fileBytes`, `fileSha256`;
2. `evaluateBundleHash(fileSha256, pinnedSha256)` — pure, same result shape as the selector checks:
   `{ id: 'verify-bundle-hash', ok, found: 0|1, expect: 1, detail }`, with `failures` carrying the same string
   style the selector failures use;
3. on mismatch **throw before evaluating anything**: `report.evaluated === false`, `report.seams === []`,
   `report.symbols === []`, and the message names **both** hashes plus the byte count and path;
4. only on a match are the three selectors and the six host symbols evaluated.

Report additions (purely additive — `build.mjs` and the existing `test/package.test.mjs` keep working):
`pinnedSha256`, `fileBytes`, `hash`, `bundleVerified`, `evaluated`. `formatReport` prints the new
`pinned:` line and the hash row, and on a refused bundle prints no seam/symbol rows at all:

```
  FAIL verify-bundle-hash             0/1  resolved sha256 cf53ae8f…ba97 is not the verified target (pinned cf53ae8f…ba90)
  SKIP seam selectors and host symbols: the hash gate refused this bundle first
  REFUSED: no patch is applied to a bundle that is not the verified target
```

The pure layer stays pure by design: `evaluateSeams` / `evaluateHostSymbols` take text and carry no file identity,
so the existing negative controls (renamed `ChatView` → `found 0`, duplicated node-list call → `found 2`, six host
symbols) keep driving deliberately mutated copies of the pinned bundle. The gate that owns the file is
`assertSeams` — the only place a pin can refuse a patch. `assertSeams({ pinnedSha256 })` exists solely so the test
can drive the mismatch path; `build.mjs` and the CLI call it with no argument, so the shipped gate always uses the
constant.

## 4. Evidence (commands, exit codes)

| # | Command | Result |
|---|---|---|
| 1 | `pnpm --dir packages/dsh-plugin-turn-fold run verify:seams` | **exit 0**, `OK verify-bundle-hash 1/1` + 3 selectors + 6 host symbols |
| 2 | `pnpm --dir packages/dsh-plugin-turn-fold run test` | **exit 0**, tests 14 / pass 14 / fail 0 |
| 3 | same as 1, with the constant temporarily set to `cf53ae8f…ba90` (last hex digit flipped) | **exit 1**, `Error: turn-fold seams failed against @deepseek-ai/dsh-client-ui-chat@0.1.5-rc.1:` + `verify-bundle-hash: … is not the verified target (pinned …ba90)` + `no patch is authorized for this bundle: the hash gate refused it (370637 bytes at …lib/client.js) before any selector was evaluated.`; `report.evaluated: false`, `seams: []`, `symbols: []` |
| 4 | same as 2, with the wrong constant | **exit 1**, `fail 3` — including the untouched pre-existing test `resolves every seam against the pinned 0.1.5 build`, and `AssertionError: the pin must name the very bundle this checker reads` |
| 5 | `node packages/dsh-plugin-turn-fold/scripts/seams.mjs` with the wrong constant | **exit 1**, prints the refused report (FAIL row + SKIP + REFUSED) and then the message naming both hashes |
| 6 | constant restored, then 1 and 2 re-run | **exit 0** both, pin back to `cf53ae8f…ba97` (single definition, `seams.mjs:51`) |
| 7 | `pnpm run test:fast` (repo root) | **exit 0** — 68 pass / 0 fail and 38 pass / 0 fail, including `no e-Mate plugin rewrites the core or owns the native transcript` |

New tests (4): `PIN` (the exported pin equals the digest of the bundle the checker actually reads; the runner
verifies it end to end and renders both digests), `RED` (wrong pin → refusal, exact message regexes, both hashes,
`evaluated === false`, empty seam/symbol lists, printed refusal), `CONTROL` (`evaluateBundleHash` purity, shape and
failure string), `NEVER WRITES` (bytes, sha256, size, mtime and the directory listing of the bundle are identical
before and after a passing run **and** a refused run).

## 5. Residual gap — reported, not decided

The pin is enforced at the **build/verify gate** (`build.mjs`, `verify:seams`, this package's `test`, and therefore
`pnpm build`/the component check): a mismatched bundle makes the owning package fail, so no artifact is produced
from it. The **runtime** application path is upstream code — the harmony runtime loads `lib/patch.cjs` (declared in
`package.json` `dsh.harmony.patches`), which selects with `expect: 1` but never hashes the bundle it rewrites.
Both that file and the loader are outside this work order's write set (`upstream/**`, `lib/**`), so this document
reports rather than fixes it. Options for the main agent, with cost:

* **A. Leave as is** — the gate is the only place a patch is authorized, and the shipped bundle cannot regress
  silently because the package build fails. Cost 0; residual risk: an already-installed tree whose Harness bundle is
  swapped out underneath it would be patched if the selectors still match.
* **B. Have the patch application path verify the hash too.** Cost is dropping as the provider moves: a parallel
  writer landed `packages/dsh-plugin-turn-fold/src/select.cjs` at 17:53 (an e-Mate-owned shared selector engine,
  with `lib/transform.cjs` announced as its runtime driver but not present yet). If that driver becomes the applying
  owner, it is e-Mate code rather than vendored upstream, so it can import `evaluateBundleHash`/`TARGET_BUNDLE_SHA256`
  directly instead of duplicating a constant. Doing it inside vendored `patch.cjs` instead would touch
  `upstream/**` + its `SOURCE.md` modification log and must be re-applied on every vendor bump.
* **C. Set `DSH_HARMONY_*`-style enforcement at the loader** — out of scope for this package and not evidenced here.

Also note: the shipped bundle copy `packages/dsh/profile/bundles/turn-fold/` contains no `scripts/` (only
`lib/` + manifests), so the pin lives in the build-side checker only; that copy needs no change.

## 6. Inconsistencies found while pinning (for the main agent to rule on)

1. The work order's byte count (369607) does not match this checkout (370637) for the pinned digest — §2.
2. `packages/dsh-plugin-turn-fold/package.json` `eMate.harnessCommit` still says `d1d095bee770…` (asserted by
   `test/package.test.mjs`) while `AGENTS.md` and submodule HEAD now say `f9e0f1190e4021e63db579ef36b67484028e8c53`.
   The compiled bundle digest is unchanged, so the pin is still correct; the recorded commit is stale. That manifest
   is outside this write set.
3. `docs/2.0.18/turn-fold-feature-parity.md` (line 213) still lists "bundle hash must be verified" as unmet; it is
   now implemented (that row is stale, the file is another writer's).
4. `pnpm run test:fast` does not run this package's tests — the narrow owner gate is
   `pnpm --dir packages/dsh-plugin-turn-fold run test`, and the seam runner itself is
   `pnpm --dir packages/dsh-plugin-turn-fold run verify:seams`.
5. **The provider was being edited by another writer while this pin was added** (mtimes and `git status` at
   17:53): `upstream/plugins/dsh-turn-fold/patch.cjs` (+13) and `inline-source.cjs` (45 lines, 0.1.5 token
   accounting and the removal of the 0.1.2-era playback clock), plus a refactor that moved the selector engine into
   the new `packages/dsh-plugin-turn-fold/src/select.cjs` with `scripts/tsquery-subset.mjs` now a 9-line ESM entry
   point. That left `lib/` (gitignored build output) stale relative to the vendored source, which made the
   pre-existing `copies the vendored bytes unchanged` test red for reasons unrelated to this pin; running the
   package's own `build` re-copied the 7 vendored files and the package returned to green. **The pin gate passes
   against that adapted runtime as well** (hash 1/1, three selectors, six host symbols), so it is not passing only
   on the pre-change bytes. This pin touches neither of those files; if the provider slice moves the applying owner
   to a new runtime driver, §5 option B should be re-read.
