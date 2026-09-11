# Renderer-session authentication: the step e-Mate had dropped

**Scope**: why `desktop/e-mate-desktop/scripts/verify-profile-boot.mjs` answered
`assembled Web root returned HTTP 401`, and the wiring correction that fixes it.
All evidence below is first-hand from this worktree unless a command says otherwise.
Changes are uncommitted.

## 1. The divergence

The pinned Desktop reference authenticates the renderer session **before** it loads the
marker-bearing Web root; e-Mate loaded the URL directly. Measured against
`anywhere-labs/deepseek-harness-desktop@166c16cfc38c51d32c2316715548c0f8271db517`
(`dsh-plugin-desktop/src/`, fetched with `curl -sSL`; the repository now redirects to
`anywhere-labs/dsh-desktop`, id 1333321333):

| Pinned reference | e-Mate before this change |
|---|---|
| `index.ts:88` `export const inject = ['webServer','webRuntime','appExit','settings','connection']` | `src/index.ts:27` injected the same list **without `connection`** |
| `index.ts:466-479` builds `url` and then `authenticationUrl: ctx.connection.authenticatedUrl(new URL(url).origin)` | `src/index.ts:165` scheduled only `url: desktopRendererUrl(...)` |
| `electron-shell-generation.ts:47-68` `authenticateRendererSession()`: `session.fetch(spec.authenticationUrl, { method:'GET', credentials:'include', redirect:'follow', cache:'no-store', headers })`, then requires `status === 200` and cancels the body | `src/electron-runtime.ts:1068` called `window.loadURL(spec.url)` with no exchange |
| `electron-shell-generation.ts:52-56` documents both reasons: preserve the Desktop query markers across the redirect, keep the launch token out of renderer history | — |
| `electron-shell-generation.ts:556-564` exchanges after `compatibilityShell?.load()` and before `loadURL` | — |

Why the missing step is fatal rather than cosmetic, in the pinned Harness:

- `upstream/deepseek-harness/packages/host/frontend-static/src/index.ts:139` authorises every
  index request through `ctx.connection.authorizeIndex(req, res)` and `:89` returns without
  writing when that is false, which is what the smoke observed as HTTP 401.
- `upstream/deepseek-harness/packages/client/connection/src/rpc-host.ts:97-101`
  `requestRejection` = trusted-authority fence (403) then `browserAuth.isAuthenticated` (401);
  `connection/src/index.ts:129-134` applies the same rejection to the shared `/api` route.
- `upstream/deepseek-harness/packages/client/connection/src/browser-auth.ts:223-229`
  `authenticatedUrl()` **clears the query string** (`:226` `url.search = ''`) before setting the
  token, and `:233-270` `authorizeIndex` mints the browser-session cookie and answers a 303
  redirect. Loading the token URL as the window URL would therefore drop the
  `dsh-desktop-mode` / `dsh-desktop-platform` markers the Desktop profile depends on — the
  exchange must stay a separate step, exactly as the pinned reference documents.

## 2. The correction (this worktree, uncommitted)

| File | Change |
|---|---|
| `desktop/e-mate-desktop/src/runtime.ts` | optional `authenticationUrl?: string` on `DesktopShellSpec`, with the marker/token rationale |
| `desktop/e-mate-desktop/src/renderer-session-auth.ts` | new: `authenticateRendererSession(session, authenticationUrl)` — the exchange, status-200 requirement, body cancel; no Electron import so gates can drive it |
| `desktop/e-mate-desktop/src/index.ts` | `'connection'` added to `inject`; `rendererAuthentication()` reads `ctx.get('connection')` and schedules `{ url, authenticationUrl }`; the marker-bearing `url` stays the loaded URL |
| `desktop/e-mate-desktop/src/electron-runtime.ts` | exchange inside the window's own session before `window.loadURL(spec.url)` |
| `desktop/e-mate-desktop/scripts/verify-profile-boot.mjs` | mirrors the three states (bare URL 401 → token exchange → marker URL + cookie 200) instead of fetching the bare URL and expecting 200; parses the native `globalThis["__DSH_BOOT__"]` row (`host/webserver/src/injections.ts:56`) instead of the retired `window.__DSH_BOOT__` assignment; asserts exactly one Sidebar owner |
| `desktop/e-mate-desktop/scripts/verify-loader-boot.mjs` | supplies a `connection` seam (the reduced composition had none) and asserts the plugin hands its token URL through |

Contexts without a Connection service (the plugin unit harness, the reduced loader smoke)
keep working because the field is optional and read through `ctx.get`; the shipped
composition is the one asserted by `verify:profile`.

## 3. The stale Sidebar expectation (reported, not silently dropped)

The smoke also required `@deepseek-ai/dsh-client-ui-sidebar` in the served client graph.
It is not there, and the reason is a deliberate e-Mate overlay, measured:

- `desktop/e-mate-desktop/scripts/verify-profile-boot.mjs` composed rows show
  `ui-sidebar | @deepseek-ai/dsh-client-ui-sidebar | disabled: false`
  (the patch comes from `src/profile.ts:396-404`).
- Resolving that id through the profile resolver used by the shipped Desktop
  (`installProfilePackageResolver` + `emateProfileComponentSources()`) gives
  `profiles/e-mate/node_modules/@deepseek-ai/dsh-client-ui-sidebar/package.json` whose
  **`name` is `@e-mate/dsh-client-shell`** — e-Mate installs its own shell at the native
  Sidebar package path (`packages/dsh/profile/plugins/emate-shell/tsdown.config.ts:3`
  builds that bundle, and `component-inventory.json` lists the id).
- `@deepseek-ai/dsh-client-modules` keys client rows by the manifest that owns the module
  (`packages/client/modules/src/index.ts:746-800`, `resolveMeta`/`locatePkgJson`), so the
  overlay is not served as the native id; the served graph (64 entries) instead carries
  `@e-mate/dsh-plugin-better-sidebar` plus the native `ui-sidebar-*` tab plugins.
- Re-enabling `ui-layout` in-memory does not restore the native Sidebar row (65 entries,
  still absent), so the drop is not a side effect of the disabled native layout.

The gate now asserts **exactly one** Sidebar owner among the native id and
`@e-mate/dsh-plugin-better-sidebar`: it fails closed if neither is served (Sidebar lost)
and if both are (two owners of one slot). Whether e-Mate's shell overlay should also be
served as a client row under its own name is a composition decision for the main agent; it
is recorded here instead of being hidden by deleting the expectation.
