# Computer Use: complete removal

**Ruling (user, this round, verbatim):** 「computer use 在win和mac双端都取消删除插件和对应的前端展示
-完全删除该插件和对应配套/环境/依赖等」 — on both Windows and macOS, drop the plugin, its front-end
presentation, and its supporting configuration, environment and dependencies.

Scope of this record: what was deleted, what had to be rewired, what was deliberately left alone and
why, and the evidence. Everything below is first-hand from this worktree.

## 1. What was deleted

| Path | Tracked files |
|---|---|
| `packages/dsh-plugin-computer-use/` | 30 |
| `upstream/plugins/dsh-computer-use/` (vendored copy) | 156 |
| `packages/dsh/profile/bundles/computer-use/` | generated, never tracked |
| **Total tracked deletions** | **186** |

The deleted package owned the macOS Swift helper, its signed binary and the Windows PowerShell helper,
so both platforms lose the capability and its native payload together. The vendored
`upstream/plugins/dsh-computer-use/` tree was materialised as ordinary files by an earlier ruling
(`docs/2.0.18/submodule-vendoring.md`); that document's object store under
`.git/worktrees/…/modules/upstream/plugins/` is untouched, so the bytes remain recoverable.

## 2. Profile and installer rewiring

- `packages/dsh/profile/component-inventory.json`: the component row removed (19 → 18). Both installers
  derive their managed package list from this file, so the row's removal stops the install on both
  paths at once.
- `packages/dsh/src/e-mate.ts` and `desktop/e-mate-desktop/src/e-mate-profile.ts`:
  `@e-mate/dsh-plugin-computer-use` added to `RETIRED_PROFILE_PACKAGES`. This is what makes an
  **already-installed** 2.0.17 profile drop the package and its `dsh.profile.bundles` entry on the next
  boot, instead of leaving dead files behind.
- Regenerated bundle registry: 17 → 16 bundled packages, `computer-use` count **0**; the profile bundle
  directory is not recreated by `pnpm --filter @e-mate/dsh build`.

## 3. Front-end presentation

- `packages/dsh/profile/plugins/emate-shell/src/client/composer-mentions.ts`: the whole
  `registerComputerUseTrigger` source (candidate list, capability RPC, setup action, codec) and its
  `ComputerUseCapability` type removed.
- `…/src/client/index.ts`: the import and the registration call removed.
- The naked-`@` roster is now `文件 / 目标 / 计划 / Skill`; the tests that asserted
  `电脑操控` in the roster, the candidate states and the pick/serialize round trip were removed with it
  (`composer-mentions.client.spec.tsx` 357 → 217 lines, `composer-205.client.spec.tsx`).
- `session-share.client.spec.tsx` sliced `index.ts` up to the text
  `export function registerComputerUseTrigger`, which **never lived in that file** — `indexOf` always
  returned `-1`, so the prefix was the whole source anyway. The slice is now dropped and the assertions
  read the source directly; this is behaviour-preserving, not a relaxation.
- `packages/dsh-plugin-cdp`: the browser guidance no longer names Computer Use, and its guard is now a
  negative assertion (`assert.doesNotMatch(prompts[0].text, /Computer Use|电脑操控/u)`) so the retired
  path cannot be re-promised silently. `README.md` updated in step.
- `skills/connect-wechat-bot/SKILL.md` and `skills/connect-dingtalk/SKILL.md`: both told the agent to use
  Computer Use to read an on-screen QR code; that sentence is gone. No guard asserted the sentence.

## 4. The new guard for the removal

The removal is itself guarded, following the repository's existing retired-package pattern: both profile
repair tests now seed `@e-mate/dsh-plugin-computer-use` as a stale dependency with a stale directory and
assert that the next install **deletes the directory**, drops the dependency and removes it from
`dsh.profile.bundles`.

| File | Added |
|---|---|
| `packages/dsh/test/e-mate.test.mjs` (CLI installer) | dependency seed, retired directory, bundle entry, and three assertions |
| `desktop/e-mate-desktop/tests/e-mate-profile.spec.ts` (desktop installer) | the same for the desktop path |

Negative assertions that predate this change and stay live: `e-mate-profile.spec.ts` and
`profile.spec.ts` assert `desktop-computer-use-setup` is absent from the rows and the patch;
`package.spec.ts` asserts no `./computer-use-setup` export; `composer-205.client.spec.tsx` asserts the
shell carries no `<computer-use explicit="true">` markup; `e-mate.test.mjs` keeps its
`emate-(?:office-ocr|browser-computer-use|memory|dream|learning)` patch assertion.

## 5. Deliberately not changed

| Surface | Why |
|---|---|
| `enterprise/apps/analytics-api/tests/production.test.ts:269` | `/v1/computer-use/activate` is one entry in a list of **enterprise** routes that must answer 404. The enterprise app never implemented it and the entry does not reference the deleted plugin; removing it would only drop a live negative assertion. |
| `docs/2.0.17/**`, `tests/regression/2.0.17/**` | Frozen 2.0.17 records. Their evidence lines point at files that have now been deleted; rewriting them would falsify history. |
| `docs/2.0.18/dsh-0.1.5-upgrade-facts.md`, `submodule-vendoring.md`, `work-orders.json` | Historical records of the migration and of the vendoring slice that this ruling supersedes. |
| `docs/reviews/**` | Review records. |
| `docs/2.0.18/regression-ledger.json` guard list | The list is evidence of what existed over `6a7f4b9d..3cc4be84`; it is **not** rewritten. Instead the three entries that owned the deleted guards carry a `disposition` naming this document. |

## 6. Ledger effect

Two guard files were deleted with the capability (`test/contract.test.mjs`,
`test/windows-source.test.mjs`); the third computer-use test file
(`test/capability-status.test.mjs`) was not in the ledger's guard list. Dispositions were added to the
owning entries `5f8c54db7b`, `4295c6f6d5` and `7cdc14259f`.

## 7. Evidence

Run from the worktree root on the finished tree, after regenerating every affected artifact:

| Command | Exit |
|---|---|
| `pnpm --filter @e-mate/dsh-client-shell build` / `test` | 0 / 0 |
| `pnpm --filter @e-mate/dsh-plugin-cdp build` / `test` | 0 / 0 |
| `pnpm --filter @e-mate/dsh-plugin-find-skill build` / `test` | 0 / 0 |
| `pnpm --filter @e-mate/dsh build` | 0 |
| `pnpm run test:fast` | see §8 |
| `node scripts/component-run.mjs check` | see §8 |
| `cd desktop && corepack yarn check` | see §8 |

## 8. Gate results

Run serially by the main agent on this tree, after the rebuilds in §7:

| Command | Result |
|---|---|
| `pnpm run test:fast` | **EXIT 0** — 68/68 and 38/38, 0 fail |
| `node scripts/component-run.mjs check` | **EXIT 0** — every component suite `fail 0` |
| `cd desktop && corepack yarn check` | **EXIT 0** — 517 passed / 5 skipped; `verify-runtime-closure` 247 nodes; `verify-licenses` 546 production packages; `verify:profile` boot smoke passed |

Cross-checks that moved in the expected direction: the bundle registry fell from 17 to 16 bundled
packages with zero `computer-use` rows, and `verify-licenses` reports one fewer production package than
the 547 recorded before the removal.

## 9. Not verified here

Installed acceptance on either platform was **not** re-run for this change; it belongs to the dual-platform
receipt step of the 2.0.18 release, which is still open. Nothing in this document claims an installed or
published state.
