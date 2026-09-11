# Native transcript owner: retiring dsh-plugin-tidychat (2.0.18)

Ruling applied (governs this change): **where the pinned Harness already owns a
capability, the native owner is used and no plugin duplicates it.** 0.1.5-rc.1 already
ships message-process folding (the compact transcript) and conversation navigation (the
native turn navigator), so `dsh-plugin-tidychat` gives both up. A plugin exists only for
a capability the pinned Harness genuinely lacks.

Baseline: `@deepseek-ai/dsh@0.1.5-rc.1`, Harness commit
`ff9a977890dafc4fe9b05634470db9a33bc9a3ef`. Every native path below is quoted from the
pinned submodule `upstream/deepseek-harness`.

## 1. Capability inventory and classification

Classification: **(a)** already owned natively by the pinned Harness, or **(b)** genuinely
not available natively. Paths under `packages/dsh-plugin-tidychat/` are the retired plugin;
paths under `packages/client/ui-chat/` are the pinned Harness.

| # | tidychat capability | tidychat evidence (file:line) | pinned native owner | Class |
|---|---|---|---|---|
| 1 | Fold finished turns (hide thinking / tool calls / intermediate text, keep the final answer) | `src/client/index.ts:519-712` (`applySurgery`: row classification `:556-709`), `:714-760` (`applyFold`: `data-tidychat-folded`), CSS `:94-102`, `MutationObserver` `:1084-1104`, 5 s fallback scan `:1122-1131` | `ui-chat/src/chat-settings.ts:18` (`DEFAULT_TRANSCRIPT_VIEW_MODE = 'compact'`), `ui-chat/src/client/apply.ts:78-95` (`TranscriptViewPolicy` + `settings.general.item` row), `ui-chat/src/client/chat/ChatNodeSeat.tsx:62-101` (`foldable` / `processMember` / `compactAnswer` / `processHidden`), `ui-chat/src/client/chat/TurnProcessNodeView.tsx:6-58` (native disclosure row, `data-turn-process`) | (a) |
| 2 | Fold control label with elapsed time ("用时 …") | `:491-502` (`cleanTiming` scrapes `用时` out of the native tail text), `:746-759` (label write) | `ui-chat/src/client/chat/TurnTailNodeView.tsx:26-31` (`runMs` from turn start/end), `:52-64` (`TurnUsagePanel` / `TurnTimePanel` with `runMs`, `tokensPerSecond`, `ttftMs`) | (a) |
| 3 | Divider between thinking and answer text | `:533-553` (inserts `data-tidychat-divider` nodes into native rows), `:724-745` (inserts `data-tidychat-answer-divider`) | native rows render their own reasoning/content structure: `ui-chat/src/client/chat/AssistantMarkdown.tsx:87-93` (`ProcessReasoning` + `ReasoningRow`) | (a) |
| 4 | Conversation navigation rail (canvas minimap, hover summary, click / keyboard jump) | `:1157-1438` (rail component), `:1168-1169` registers `{ name: 'conversation.session.header.utilities', id: 'tidychat-nav' }`, `:1230-1264` canvas draw, `:1340-1349` `jumpTo` | `ui-chat/src/client/chat/TurnNavigator.tsx:1-60` rendered by `ui-chat/src/client/chat/ChatView.tsx:763` inside the chat view (not through a slot) | (a) |
| 5 | Rail colour modes / theme adaptation | `:897-1045` (`NAV_HUE_PALETTE`, `resolveNavColors`, `applyTipContrast`), settings fields `navColor…` | native rail owns its own theming (`TurnNavigator.module.css`) | (a) |
| 6 | Rail anchoring / gutter measurement | `:1133-1149` (`measurePos` on `[data-conversation-scroll]`) | native layout owns it | (a) |
| 7 | Diagnostic report + GitHub issue button | `:453` (`REPORT_TAGS`), `:839-895` (`detectIssues` / `buildReport` / `reportAndOpenIssue`, opens `BananaSoldier01/dsh-tidychat/issues/new`) | none (not a native capability) — but it only reports on the deleted scanner (`lastScanMs` / `peakScanMs` / `scanCount`, `:478-481`, `:783-795`) and the deleted switches, and routes users to the third-party upstream repository | (a)-support |
| 8 | Perf debug hook `window.__tidychatReport` + 10 s interval | `:797-823` | none — instruments the deleted scanner only | (a)-support |
| 9 | Settings namespace + card (`fold` / `divider` / `navigator`) | `src/index.ts:14-63` (namespace + schema), `src/client/index.ts:1440-1618` (card registered at `:1615-1617`) | none — configures rows 1-6 | (a)-support |
| 10 | Artifact / image-terminal preservation while folding (`hasArtifact`) | `:514-517`, `:609`, `:617` | native folding keeps independent node kinds visible: `ui-chat/src/client/contract/turn-process.ts:31` (`TURN_PROCESS_INDEPENDENT_KINDS`) applied at `ChatNodeSeat.tsx:71`; the guard only decided which native rows the plugin's own surgery hid | (a)-support |
| 11 | Automatic older-history loading removed, native manual load kept | not present in the source (no `autoLoad` / `.click()`; asserted by the deleted `test/folding.test.mjs:69-81`) | native "load older" control: `ui-chat/src/client/chat/ChatView.tsx:777-782` (`chat.loadOlder`) | not a capability (absence) |

**Class (b) = none.** Every capability is either the native owner's or support for the
plugin's own duplication. Nothing survives, so the plugin is retired instead of being kept
as an empty shell.

## 2. What was deleted

The whole package `packages/dsh-plugin-tidychat/` (14 tracked files, 2744 lines) plus its
generated, untracked `lib/` output (ignored by `.gitignore:19`, `packages/dsh-plugin-*/lib/`):

| file | lines |
|---|---|
| `src/client/index.ts` | 1619 |
| `src/index.ts` | 63 |
| `test/no-core-rewrite.mjs` (relocated, see §3) | 227 |
| `test/no-core-rewrite.test.mjs` (relocated, see §3) | 124 |
| `test/navigation.client.spec.tsx` | 126 |
| `test/folding.test.mjs` | 82 |
| `package.json` | 53 |
| `tsconfig.json` | 36 |
| `vitest.config.ts` | 30 |
| `LICENSE` | 21 |
| `README.md` | 9 |
| `tsdown.config.ts` | 5 |
| `cordis.patch.yml` | 3 |
| `pnpm-lock.yaml` | 346 |
| generated `lib/{client.js,client.js.map,index.js}` | untracked, deleted with the tree |

No replacement mechanism was added: folding and navigation now have exactly one owner, the
pinned native one.

## 3. Guard relocated and extended (fail-closed)

The existing executable rule lived at `packages/dsh-plugin-tidychat/test/no-core-rewrite.mjs`
and would have died with the plugin, so it was moved inside this change's write set and
extended rather than duplicated:

- `scripts/no-core-rewrite-guard.mjs` (309 lines at the time of this retirement; moved out of
  `docs/2.0.18/` into `scripts/` and made load-bearing in facts §85, where the turn-folding exemption is
  now recorded) — same scanner, same rule family 1
  (no plugin parses, patches, injects into or writes a compiled Harness artifact), plus a
  new rule family 2: a **shipped** plugin surface may not
  - address a private native transcript hook (`native-transcript-hook`):
    `data-chat-anchor-key`, `data-chat-flow-kind`, `data-chat-turn`, `data-chat-flow`,
    `data-conversation-scroll` — the exact hooks the fold surgery and the retired rail
    were built on (`src/client/index.ts:523,536,565,571,605,703,762,808,1140,1185`);
  - emit the retired owner marker `data-tidychat-` (`retired-owner-marker`);
  - name the retired navigation owner identity `tidychat-nav` (`retired-owner-identity`).
  Test surfaces stay exempt (they replay the native DOM with fixtures and ship nothing).
- `scripts/no-core-rewrite-guard.test.mjs` (172 lines then, 19 cases after facts §85) — the previous 12 assertions
  (with the tidychat-specific coverage assertions replaced by the retirement tombstone
  "no tidychat surface is scanned / the retired plugin package is deleted") plus 4 new ones
  for family 2.

Negative control, same command before and after the deletion:

```
# BEFORE (plugin present): the new rules fire on the plugin's own surgery
node --test scripts/no-core-rewrite-guard.test.mjs
  ✖ the retired tidychat owner is gone from the plugin surfaces
  ✖ no e-Mate plugin rewrites the core or owns the native transcript
    native-transcript-hook packages/dsh-plugin-tidychat/src/client/index.ts:523; …
    retired-owner-marker  packages/dsh-plugin-tidychat/src/client/index.ts:23; …
    retired-owner-identity packages/dsh-plugin-tidychat/src/client/index.ts:1169 (tidychat-nav)

# AFTER (plugin retired)
node --test scripts/no-core-rewrite-guard.test.mjs
  ℹ tests 16   ℹ pass 16   ℹ fail 0        (exit 0)
```

## 4. Required companion changes (outside this write set — reported, not applied)

| file | change | why |
|---|---|---|
| `packages/dsh/profile/component-inventory.json:112-117` | remove the `@e-mate/dsh-plugin-tidychat` row | `scripts/component-run.mjs:52-58` reads `component.root/package.json` for every row; the tree is gone |
| `packages/dsh/profile/bundles/registry.json:88-92` | remove the `@e-mate/dsh-plugin-tidychat` / `"directory": "tidychat"` entry | `desktop/e-mate-desktop/src/e-mate-profile.ts:837` reads this registry |
| `packages/dsh/profile/bundles/tidychat/**` | delete and re-sync with `node scripts/sync-emate-plugin-bundles.mjs` | the shipped profile bundle is a generated copy of the plugin's `lib/`; until it is removed the app still ships the retired code |
| `desktop/e-mate-desktop/src/e-mate-profile.ts` | drop it from `PROFILE_PLUGIN_PACKAGES`, add it to `RETIRED_PROFILE_PACKAGES` (`:651` is the retired-name check) | profile composition + upgrade cleanup |
| `desktop/e-mate-desktop/tests/e-mate-profile.spec.ts:224,333,933` | replace the "contains tidychat" expectations with the retired-name expectation | three assertions pin the plugin into the profile |
| `desktop/e-mate-desktop/scripts/verify-profile-boot.mjs:272` | remove `@e-mate/dsh-plugin-tidychat` from the required Web-graph ids | the assembled boot graph must not require it |
| `packages/dsh/test/e-mate.test.mjs:247` | remove it from the expected `dsh.profile.bundles` list | profile manifest equality assertion |
| `scripts/` + root `package.json` | ~~`git mv docs/2.0.18/no-core-rewrite-guard.{mjs,test.mjs} scripts/` and add the test to `test:fast`~~ **DONE in facts §85**: the files were untracked, so `git mv` failed (exit 128) and a plain `mv` was used; the test is now in the `test:fast` node --test list | the guard is a repository rule; it must not live in `docs/` |
| `docs/2.0.18/regression-ledger.{md,json}` | bookkeeping: the guard-file set (151) still lists `packages/dsh-plugin-tidychat/test/folding.test.mjs` and `test/navigation.client.spec.tsx` | those two guard files are deleted; the ledger is the regression acceptance basis |

## 5. Gate evidence (this working tree, uncommitted)

| command | result |
|---|---|
| `pnpm run test:fast` | **EXIT 0** — 19/19 tests pass |
| `node --test scripts/no-core-rewrite-guard.test.mjs` | **EXIT 0** — 16/16 pass at the time (19/19 after facts §85), zero violations on the real tree |
| `node scripts/component-run.mjs check` | **EXIT 1** — `ENOENT …/packages/dsh-plugin-tidychat/package.json` at `scripts/component-run.mjs:53`, i.e. the not-yet-removed inventory row (§4). Every other row's frozen install still resolves ("Already up to date" ×19). |
| `node scripts/component-run.mjs check --component @e-mate/dsh-plugin-tidychat` | **EXIT 1** — same `ENOENT`, single-row proof |
| identity loop of `component-run.mjs:52-58` over the surviving rows | 19/19 rows pass `name` / `version` / `eMate.harnessVersion` / `eMate.baseImports` |
| node scripts/component-run.mjs check --component <id> for each of the 19 surviving rows | **EXIT 0** for 19/19 (@e-mate/dsh-plugin-canvas hit one browser-test timeout while all 19 ran in parallel; its isolated re-run is **EXIT 0**) |

The two hard gates cannot both be green while the inventory is untouched:
`scripts/version-contract.test.mjs:10-13` (inside `test:fast`) maps every surviving
`packages/dsh-plugin-*` **directory** to its `package.json`, so keeping the directory alive
without a manifest breaks `test:fast`, while `component-run.mjs:52-58` requires a
manifest-bearing package for every inventory row. A green `component-run check` therefore
requires either the §4 inventory edit or keeping a buildable, manifest-bearing plugin with
no capability — i.e. exactly the empty plugin the ruling forbids.

## 6. Verdict

- The plugin now owns **nothing**: no folding, no navigation, no settings, no second rail,
  no DOM surgery, no diagnostic surface.
- `packages/dsh-plugin-tidychat/` is retired; folding and navigation are back on their
  pinned native owners.
- The repository keeps an executable, fail-closed rule that neither capability can return.
- Open: the inventory/profile/desktop/ledger edits in §4, and the guard's move out of
  `docs/` into `scripts/` with a `test:fast` wiring.
