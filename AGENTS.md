# e-Mate repository rules

These rules are the repository's highest-priority engineering contract. Historical notes and evidence do not override them.

The current source target for the e-Mate desktop application is version `2.0.18` in the GitHub repository `zyfjacksonchen-source/e-Mate-desktop`. The stable Electron product name and installed application name remain `e-Mate`; “Desktop” describes the repository scope and does not rename the app or its installation locations. This identity is not evidence that a candidate was built, installed, or publicly released.

At source level, 2.0.18 includes the pinned `dickpy/dsh-imagegen` generation and edit Tools, discovery and native on-demand installation of the 0.1.5-compatible `dream-num/dsh-univer-office` plugin, native PTC as the default Agent preset, zero image/edit confirmation, universal ordinary-file upload, the pinned Windows source backend, enterprise authentication recovery, and bounded direct-image latency. This is a source capability and compatibility statement only; it makes no candidate, installed, or public-production claim.

## First principle: sole main-agent governance

The main agent is the sole supervisory manager. It owns worktree and baseline selection, mutually exclusive write sets, work orders, review, integration, evidence gates, installed acceptance, release, and rollback decisions.

Subagents execute development only inside their assigned work order and write set, then run the narrowest relevant test. They must not independently broaden scope, change product or dependency versions, build or package installers, install, deploy, push, clean worktrees or artifacts, or decide that any release-contract gate passed.

## Native baseline: return to the pinned owner

1. Read `desktop/e-mate-desktop/base-contract.json` before changing runtime behavior. The only accepted Harness baseline is `@deepseek-ai/dsh@0.1.5-rc.1`, repository commit `ff9a977890dafc4fe9b05634470db9a33bc9a3ef`. The only accepted Desktop reference is `anywhere-labs/deepseek-harness-desktop@166c16cfc38c51d32c2316715548c0f8271db517`.
2. Trace the complete 0.1.5 native path before adding code. Reuse its Agent Loop, Session, event projection, Tool, approval, Job, Skill, workspace, storage, settings, plugin, slot, and lifecycle owners. Fix a shared native defect at its owner when possible; keep an e-Mate adapter only for a real product-specific difference.
3. Never infer native behavior from a floating branch, another release candidate, a newer DSH version, or a historical e-Mate implementation. Do not add parallel UI, stores, routers, transports, Host or Agent Loop paths, Tool registries, updaters, package managers, or fallbacks. Delete divergence and route callers back to the pinned native owner.

## Sole Desktop owner

`desktop/e-mate-desktop` is the only owner of Electron startup, build, platform packaging, installation, replacement, relaunch, and online update. Its implementation follows the pinned `deepseek-harness-desktop` lifecycle; e-Mate changes are limited to branding, the product Profile, enterprise policy, platform-required adapters, and truthful unsigned-distribution behavior.

- When the main agent authorizes candidate work, build and verify through the existing Desktop workspace only, with the process working directory set to `desktop`: `corepack yarn check`, `corepack yarn dist:mac`, and `corepack yarn dist:win`. Do not invoke Desktop Yarn through root Corepack with `--cwd`.
- macOS candidate builds run locally. For this 2.0.18 continuation, the user explicitly selected the existing `win-codex` public SSH connection for Windows builds and machine checks. Installed GUI acceptance still requires the signed-in interactive Windows session; a remote command receipt alone is not GUI or installed acceptance. Do not introduce GitHub Actions artifacts, a root release coordinator, or another packaging wrapper as a fallback.
- Keep the macOS package unsigned and unnotarized unless real signing credentials are deliberately introduced. The supported flow downloads the DMG, lets the user grant trust, and replaces `/Applications/e-Mate.app` in place.
- Keep the Windows package on the native assisted NSIS path. New install and replacement use the same canonical installation directory and shortcut set.
- Tray, background, Settings, and natural-language update requests converge on the same Desktop update lifecycle. Natural language may trigger `desktopUpdates.runInteractiveUpdate()` only; it must not own URLs, download, verification, installation, replacement, or rollback logic.
- Online update accepts only a strictly newer stable version. Same-version replacement and migration from older unsupported readers use the official manual download page, not a second feed.

## Source and extension boundaries

- Keep e-Mate product behavior in existing Profile plugins, Cordis services, Harness Tools, and client slots. Prefer deletion to wrappers and positive reuse to compatibility shims.
- Preserve exact dependency pins and lockfiles. Root and Desktop `pnpm@11.8.0` follow the pinned dsh-desktop reference, and DSH `0.1.5-rc.1` is fixed; the Harness fork keeps its own upstream `pnpm@11.7.0` through `pinnedPnpmInvocation`, and any rc.8 DSH dependency is a contract failure.
- Generated build output, installers, local run receipts, caches, and acceptance screenshots do not belong in source control.
- Historical documents are context only. Current code, `base-contract.json`, this file, and `docs/target-contract.md` define the active repository contract.

## Verification and release truth

- Match verification to the change. Run the narrow owner test first; run the Desktop platform check when build, packaging, install, or update behavior changes.
- Source truth is the reviewed source diff and its named focused checks only.
- Candidate truth requires exact source provenance, pins, installer bytes, and hashes from the authorized native macOS and Windows builds; it is not installed truth.
- Installed truth requires those exact bytes to install, replace in place, and launch on local macOS and the logged-in Codex Remote Windows machine; it is not public-production truth.
- Public-production truth requires the immutable Cloudflare/R2 objects and official version and platform pointers to be read back after activation. Publish immutable bytes first and activate the version pointer last.
- GitHub `e-Mate-desktop` is the source, review, and source-CI boundary. A commit, check, artifact, tag, or GitHub release does not by itself prove candidate installation or public production and is not a fallback release transport.
- Fail closed at the first missing or mismatched gate. Keep it `OPEN`; never substitute source checks, fixtures, another candidate, historical receipts, or narrative approval. The main agent alone decides release or rollback.
- Do not restore removed schema-2 signing orchestration, Profile hot-update publication, custom health rollback, local-flow coordinators, performance admission, or parallel package/update paths.

## Private update acceptance and promotion

- For the 2.0.18 release, use only the Desktop-owned private acceptance and same-byte promotion entry points specified in `docs/target-contract.md`. The canary launcher routes the existing native updater; it is not another updater or proof of installation.
- Both platforms must supply real, same-source acceptance receipts before `desktop/e-mate-desktop/scripts/candidate-promotion-worker.mjs` may publish. No independent copy/version route or handwritten website success status may bypass this gate. These are required gates, not a claim that implementation review or release has passed.

## Worktree hygiene

- Work in the named repository worktree, not `/Users/mac/e-mate` itself.
- Never discard another worktree's uncommitted changes. Remove old worktrees only after proving them clean; build output and dependency caches are rebuildable.
- Only the main agent may authorize integration, cleanup, or push. Before an authorized push, inspect `git status`, the actual diff, and the focused checks; never invent release evidence.

## Current release direction: 0.1.5-rc.1 and one tidychat plugin

The user directed the 0.1.5 migration onto the accepted baseline. Keep Harness 0.1.5-rc.1 at ff9a977890dafc4fe9b05634470db9a33bc9a3ef and the native dsh-desktop reference. The Agent Loop must remain unmodified; image/Vision capabilities use native plugin/Tool interfaces. Preserve existing image reference, edit routing, terminal deduplication and recovery fixes carried over from the 0.1.5 migration tree.

Where the pinned Harness already owns a capability, the native owner is used and no plugin may duplicate it: 0.1.5-rc.1 already ships message-process folding (the compact transcript) and conversation navigation (the native turn navigator), so tidychat gives both up and must not register a second owner for either. A plugin exists only for a capability the pinned Harness genuinely lacks, and must enter through its supported slot or service interface. Automatic older-history loading is disabled, including restoration of previous autoLoad=true settings; preserve the native manual load action. Project file browsing is a separate capability and is not removed as a substitute for conversation navigation. Build, install and release acceptance still require the existing native Desktop owners and dual-platform evidence.
