# Four dangling plugin submodules: vendored or removed

Worktree `/Users/mac/e-mate/worktrees/emate-2.0.18-dsh015-upgrade`, branch
`feat/2.0.18/dsh-0.1.5-upgrade`, base commit `040538c132`. **Uncommitted** — the
whole change is staged in the index and described here.

## The defect

Four plugin submodules were pinned to commits that no longer exist on their
third-party upstreams, so `git clone --recurse-submodules` cannot materialise
them. A clone then builds against empty directories, and the root build stops at
the first one it reads — on Windows `ENOENT …/upstream/plugins/dsh-computer-use/lib`.

| Path | Pinned gitlink | Pinned commit's parent (upstream release tip) |
|---|---|---|
| `upstream/plugins/dsh-better-sidebar` | `494b67638b7aba5fef0656854eaf96b0721f79cb` | `5d2d6e580143dc6ad95c015feb2909ec60afdf77` *Merge pull request #88 from omdsh-dev/feat/title-bar-compat* |
| `upstream/plugins/dsh-computer-use` | `5863c14d053f584dc2e118352beefcf7906122fa` | `76bfe8607f61945c1cbb84e73976e601100c13a2` *release: publish @anionex/dsh-computer-use (#4)* |
| `upstream/plugins/dsh-vision-toolkit` | `5cbce73bdec538e35012992dc241c8f0f6790c30` | `29850a83871d4b7a7cc13e251420c5a440e2f69e` *release: prepare v0.1.7 (#32)* |
| `upstream/plugins/computer-user` | `3e32cc59ab73596804b2a0e3821748fa2b2ad268` | `2fbf383b49fe08e466d4d1caba659fb42b61de6b` *release: v0.3.6 — peerDependencies 兼容 DSH 0.1.1-rc.2* |

All four tips are the **same e-Mate commit** — `0.1.5 compat: replace the removed
settingsNamespace() with the plain namespace string`, author `e-Mate migration`,
2026-09-11T13:32:01+08:00 — sitting directly on the upstream release commit named
above. Inside each former submodule `git for-each-ref --contains HEAD refs/remotes`
returns **0 refs**, which is the measured reason a fresh clone cannot fetch them.

## Consumer audit — and a correction to how it was first done

The work order that opened this slice asserted that three of the four had "no
consumer" after grepping `packages/dsh/profile/component-inventory.json`,
`packages/dsh/profile/cordis.patch.yml` and `desktop/e-mate-desktop/src` for the
directory names. **That conclusion was wrong**, and the rule it teaches is the
one to keep: *"no consumer found" may only be claimed after searching the whole
tree for both the directory name and relative-path references* — not "not found
in the three files I happened to list".

Whole-tree search result (`grep -rn --exclude-dir={node_modules,.git,dist,build,lib} …`):

| Path | Consumers found | Classification |
|---|---|---|
| `dsh-computer-use` | `packages/dsh-plugin-computer-use/scripts/build.mjs:7` (copies `lib/`, `assets/`, `scripts/build-native.mjs` out of it — the `lib/` copy is the first thing the root build reads, hence the Windows `ENOENT`), `src/windows.ts:8-11` (build-time types + `ComputerUseError` from `src/{backend,config,types,errors}.ts`), `test/windows-source.test.mjs:262,358` and `test/contract.test.mjs:22` (read `src/{service,leases,confirmations}.ts`, `lib/{skill,leases}.js`) | **consumed — must keep its content** |
| `dsh-vision-toolkit` | `packages/dsh-plugin-vision-toolkit/scripts/build.mjs:7` (copies `lib/`, `package.json`, `runtime/`, `vendor/` out of it) | **consumed — must keep its content** |
| `dsh-better-sidebar` | No build script reads the tree. Kept under e-Mate control because the pinned commit is e-Mate's own 0.1.5 compatibility work; the shipped `@e-mate/dsh-plugin-better-sidebar` is e-Mate's implementation of the same surface (`packages/dsh-plugin-better-sidebar/THIRD_PARTY_NOTICES.md`) and `desktop/e-mate-desktop/src/e-mate-profile.ts:88` still names the retired `dsh-better-sidebar` package | **no consumer — vendored by user ruling so the content survives under our control** |
| `computer-user` | Nothing reads the tree. The only reference is the negative assertion at `packages/dsh/test/e-mate.test.mjs:119` (it asserts the *string* `upstream/plugins/computer-user/src/index.js` is absent from `packages/dsh-plugin-computer-use/src/windows.ts`); its provenance is already recorded in `packages/dsh-plugin-computer-use/SOURCE.md` and `LICENSE` | **no consumer — removed** |

Deleting `dsh-computer-use` or `dsh-vision-toolkit` would have re-created exactly
the failure this slice exists to fix, so the main agent's ruling was: vendor all
three, remove only `computer-user`.

## What was changed

1. `.gitmodules`: the four stanzas removed; the remaining six submodules
   (`upstream/deepseek-harness`, `ego-lite`, `dsh-memory-evolve`, `dsh-genui`,
   `dsh-find-skill`, `dsh-im`) are byte-identical to before.
2. Each vendored tree: the gitlink removed from the index and the pinned tracked
   content added as ordinary files at the same paths, byte-for-byte identical,
   with the same file modes, plus a new `SOURCE.md` recording provenance, the
   upstream commit it sits on, the license, the consumers and a full sha256
   inventory — the same shape as `upstream/plugins/dsh-turn-fold/SOURCE.md`.
3. Each vendored tree: the nested `.git` gitfile removed, so the directories are
   plain content and behave like a fresh clone. The submodule object stores are
   untouched at
   `<repo>/.git/worktrees/emate-2.0.18-dsh015-upgrade/modules/upstream/plugins/<name>`,
   so every former clone is still inspectable with
   `git --git-dir=<that path> log`.
4. `upstream/plugins/computer-user` removed from the index and from the working
   tree (25 tracked files, 147 726 bytes). Its object store also remains under the
   same `modules/…/computer-user` path.

Commands used (all from the worktree root):

```sh
# 1. .gitmodules rewritten without the four stanzas
git add .gitmodules                       # git refuses to add inside a gitlink until this is staged

# 2. per vendored tree: gitlink out of the index, pinned content in
git update-index --force-remove upstream/plugins/<name>
git -C upstream/plugins/<name> ls-files -z | tr '\0' '\n' | sed '/^$/d' > /tmp/list
sed 's|^|upstream/plugins/<name>/|' /tmp/list > /tmp/add.list
git add --pathspec-from-file=/tmp/add.list
rm upstream/plugins/<name>/.git            # nested gitfile -> plain content

# 3. computer-user removed
git update-index --force-remove upstream/plugins/computer-user
rm -rf upstream/plugins/computer-user
```

## Evidence

| Check | Result |
|---|---|
| File set and modes equal the pinned submodule | `dsh-better-sidebar` 155×100644 + 3×100755, `dsh-computer-use` 150 + 5, `dsh-vision-toolkit` 205 + 11 — identical counts to `git --git-dir=…/modules/… ls-files -s` |
| Content byte-identical to the pinned commit | per-file sha256 re-checked after staging: 158/155/216 files, **0 mismatches** |
| No gitlink remains | `git ls-files -s upstream/plugins/{dsh-better-sidebar,dsh-computer-use,dsh-vision-toolkit,computer-user} \| awk '$1=="160000"'` → **empty**; `git ls-files -s \| awk '$1=="160000"'` lists only the six intended submodules, harness first at `f9e0f1190e4021e63db579ef36b67484028e8c53` |
| No nested `.git`/gitfile | `find upstream/plugins/{…} -maxdepth 2 -name .git` → nothing |
| Fresh clone is complete without any fetch | `git checkout-index -a --prefix=/tmp/emate-fresh/` (exit 0) → 159 / 156 / 217 files at the three vendored paths, 0 at `computer-user`, and every file the consumers copy is present (`dsh-computer-use/lib/index.js`, `lib/client.js`, `scripts/build-native.mjs`, `src/service.ts`; `dsh-vision-toolkit/lib/index.js`, `runtime/requirements.lock`, `vendor/`) |
| Harness pin untouched | `160000 f9e0f1190e4021e63db579ef36b67484028e8c53 0 upstream/deepseek-harness` — unchanged in the index and in the materialised tree; `scripts/harness-provenance.mjs:229` still matches |
| Staged diff shape | `532 A` (529 pinned files + 3 `SOURCE.md`), `4 D` (the four gitlinks), `1 M` (`.gitmodules`); `git status -uall` has no untracked leftovers |

## Gates

| Command | Exit code |
|---|---|
| `pnpm run test:fast` | **0** — `68 pass / 0 fail` + `38 pass / 0 fail`, 0 `not ok` markers |
| `node scripts/component-run.mjs check --component @e-mate/dsh-plugin-computer-use` | see the run recorded below |
| `node scripts/component-run.mjs check --component @e-mate/dsh-plugin-vision-toolkit` | see the run recorded below |
| `node scripts/component-run.mjs check` | see the run recorded below |

## Notes left for the main agent

- Nothing outside the write set needed to change. No dependency, version,
  lockfile or surviving submodule pin was touched, and no product behaviour
  changed: the same bytes now arrive as ordinary files instead of a gitlink.
- `.github/workflows/ci.yml:27,52,76` still checks out with `submodules: recursive`.
  That is harmless (the six real submodules still need it) and it is the only
  remaining place in the repository that mentions submodules — no script or test
  enumerates `.gitmodules`, so no gate had to be taught the new layout.
- `upstream/plugins/computer-user` cannot be re-fetched from its upstream, and its
  content is now absent from the working tree. Everything that used it as
  *evidence* (the incorporated-primitives notes) lives in
  `packages/dsh-plugin-computer-use/SOURCE.md`; if an audit ever needs the bytes
  again they are in the former gitdir under `.git/worktrees/…/modules/upstream/plugins/computer-user`.
