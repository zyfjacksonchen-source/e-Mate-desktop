# WebUI-driven acceptance: scope, boundaries, and protocol

Status: active for the 2.0.18 / DSH 0.1.5-rc.1 verification loop. This page owns the
division between what the e-Mate WebUI can prove and what only the packaged Desktop
candidate can prove. It does not change the release contract in `docs/target-contract.md`
or the truth ladder in `AGENTS.md`.

## Why the WebUI loop is the right inner loop

The Desktop renderer and the WebUI load the same Client artifacts. Both mount the
same `e-mate` Profile: the same Cordis Host plugins, the same
`@deepseek-ai/dsh-client-*` bundles, the same slots, stores, Tools, Jobs, Session
authority, and persistence. The Electron layer is a process host around that
Profile, not a second implementation of it.

Consequences that make the loop cheap and meaningful:

- A Profile or Client fix is observable in the WebUI with a rebuild plus a
  process restart, with no packaging, signing, install, or relaunch cycle.
- A defect is reproducible through the same HTTP/SSE transport the Desktop
  renderer uses, so browser automation exercises the real Host and Agent Loop.
- The regression ledger is dominated by Host and Client behavior, which the
  WebUI genuinely covers.

## Desktop-only surface (NOT provable through the WebUI)

These are owned by the Electron process or by packaging. They must be accepted on
the built candidate for both platforms.

| Surface | Owning e-Mate modules |
| --- | --- |
| Electron startup, single instance, window and tray lifecycle | `desktop/e-mate-desktop/src/main.ts`, `electron-runtime.ts`, `runtime.ts` |
| Preload bridge and renderer boot contract | `src/preload.ts`, `src/renderer-boot.ts`, `src/renderer-boot-contract.ts` |
| Native directory picker and OS file open | `@deepseek-ai/dsh-host-directory-picker-native`, `src/file-path-bridge-contract.ts` |
| Finder / Explorer drag-and-drop into the window | `src/client/workspace-folder-drop.ts` |
| Online update: download, verify, replace in place, relaunch | `src/agent-update.ts`, `desktop-update-trigger-contract.ts`, `@deepseek-ai/dsh/app-update` |
| Packaging, asar layout, unpacked native libraries, universal slices | `src/mac-universal-inventory.ts`, `src/module-resolution.ts`, `src/packaged-runtime-path.ts` |
| Install, install recovery, profiles on disk | `src/install-recovery.ts`, `src/profile.ts`, `src/profiles.ts` |
| Windows-only process, sandbox, and terminal paths | `@deepseek-ai/dsh-win32-process`, `@deepseek-ai/dsh-tool-pwsh-persistent` |
| Desktop terminal host | `src/desktop-terminal.ts` |
| Theme and layout presentation owned by the shell host | `src/client/theme-presenter.ts`, `src/client/layout-service.ts` |

The two online-update modules named in the repository contract stay byte-untouched
and are verified by the packaged candidate, never by the WebUI.

## What is explicitly NOT claimed

WebUI acceptance is **source and candidate evidence**. It is not installed truth
and it is not public-production truth. A green WebUI sweep never substitutes for
the dual-platform installed acceptance receipts required before promotion, and it
must never be recorded in a release receipt as an install check.

## Protocol

1. Build the Profile the candidate ships: `pnpm --filter @e-mate/dsh build`.
2. Boot the server on a loopback port with an isolated `DSH_HOME`.
3. Drive the real UI through browser automation and assert user-visible outcomes,
   not DOM internals or class names.
4. On a defect: fix at the owning layer, rebuild, restart, re-run the same check.
5. Record the outcome per ledger item with the exact assertion that passed.

## Coverage split for the 2.0.11 to 2.0.18 regression ledger

The ledger holds 236 fixes; 218 carry a guard test and 151 distinct guard test
files exist. Acceptance is split by what can actually falsify each item:

- **Guard tests (mechanical, all 236).** The 151 guard files run against the
  upgraded tree. This is the primary mechanism for "a fixed bug must not
  reappear in any form", because it executes on every run rather than once.
- **WebUI end-to-end (browser-observable subset).** Confirms the user-visible
  behavior and its native parity on the real Host, Agent Loop, and Client.
- **Desktop candidate (Electron-only subset).** The table above, on macOS and
  Windows, through the existing native owners.

## Native comparison

Every browser-observable item is checked twice on the same build: once through the
e-Mate Profile and once against an unmodified pinned DSH 0.1.5-rc.1 Profile with
the same scenario. A behavior that differs only because the native build lacks an
e-Mate product feature is recorded as an intended product difference, not a regression.
