# Sidebar identity takeover: the row the served graph had dropped

**Scope**: why `desktop/e-mate-desktop/scripts/verify-profile-boot.mjs` (and therefore
`cd desktop && corepack yarn check`) answered `assembled desktop Web graph is missing
@deepseek-ai/dsh-client-ui-sidebar`, why the conflict predates the 0.1.5 migration, the
resolution chosen and the evidence for it. All evidence is first-hand from this worktree
unless a command says otherwise. Changes are uncommitted.

## 1. The conflict

Three facts that had coexisted since `cae7bceccb` (e-Mate 2.0.7):

| Fact | Evidence |
|---|---|
| The pinned Web bundle names the **native** Sidebar row | `upstream/deepseek-harness/packages/bundle/web-app/cordis.patch.yml:220-221`: `- id: ui-sidebar` / `name: '@deepseek-ai/dsh-client-ui-sidebar'` |
| e-Mate installs its **shell** into that package path | `desktop/e-mate-desktop/src/e-mate-profile.ts` `shellInstallTarget()`; CLI counterpart `packages/dsh/src/e-mate.ts` `SHELL_INSTALL_PACKAGE` = `node_modules/@deepseek-ai/dsh-client-ui-sidebar/package.json` |
| The shell keeps its **own** manifest name | `packages/dsh/profile/plugins/emate-shell/package.json:2` `"name": "@e-mate/dsh-client-shell"`, the id `packages/dsh/profile/component-inventory.json` declares |

The takeover is deliberate at the bundle-identity level, and the ledger already said so
(`docs/2.0.18/dsh-0.1.5-upgrade-facts.md:1686`: the shell "impersonates the native sidebar
client bundle identity"):

- `packages/dsh/profile/plugins/emate-shell/tsdown.config.ts:3` builds the shell client with
  `clientBundle('@deepseek-ai/dsh-client-ui-sidebar', ['src/index.ts'], …)`.
- The built bundle registers exactly that id: `lib/client.js:2`
  `id: "@deepseek-ai/dsh-client-ui-sidebar"`.
- `packages/dsh/test/e-mate.test.mjs:502` already asserted it:
  `assert.match(client, /\bid:\s*["']@deepseek-ai\/dsh-client-ui-sidebar["']/)`.
- `desktop/e-mate-desktop/src/profile.ts:397` requires the `ui-sidebar` row to name
  `@deepseek-ai/dsh-client-ui-sidebar` in advanced desktop mode.

So the identity clash was **only** the installed manifest name.

## 2. Why the native id never reached the graph (measured mechanism)

`upstream/deepseek-harness/packages/client/modules/src/index.ts` composes the graph:

- `locatePkgJson()` (:791-826) resolves the Loader row's specifier through the same
  resolution that imported the row's host half, then
- `nearestPackage()` (:828-852) walks up from the resolved module accepting the nearest
  manifest whose `name` **equals the resolved specifier**; with no match it returns
  `undefined` (:852), which `resolveMeta()` (:743-764) caches as "not a client row".
- The graph id is always the **manifest** name (`@param id - entry id (package name)`,
  :593, :754-775), never the Loader row name.

A package installed at the native path that declares another `name` is therefore dropped
silently: the row still loads its host half, and no client row is served for it.

Measured before the fix (temporary copy of the smoke that prints the served graph and probes
the shell's own HTTP route; the copy was deleted afterwards):

```
SHELL_MANIFEST_NAME=@e-mate/dsh-client-shell
GRAPH_IDS=[… "@deepseek-ai/dsh-client-ui-sidebar-documentpreview",
             "@deepseek-ai/dsh-client-ui-sidebar-files",
             "@deepseek-ai/dsh-client-ui-sidebar-right",
             "@e-mate/dsh-plugin-better-sidebar" …]
```

Neither `@deepseek-ai/dsh-client-ui-sidebar` nor `@e-mate/dsh-client-shell` is present.
Consequences, all product-visible: the whole e-Mate shell client (home, chat chrome, account,
header controls, settings chrome, image gallery, session route) never reached the browser; the
native Sidebar slot tree it contributes into (`sidebar.footer.action` among others, declared by
`upstream/deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.tsx:270`) had no
declarer; and the smoke could not report any of it, because the bundle-registration loop only
walks the graph, and the row it would have fetched did not exist.

## 3. Decision: keep the takeover, install the shell under the native identity

**Chosen: (b)** — install the shell under the row's own identity through the installer's
existing overrides mechanism (`installManagedPackage(source, target, overrides)`), so Loader
row, served graph id and registered bundle id agree.

**Rejected: (a)** — install the shell at its own path under its own row and leave the native
Sidebar package intact. Cost and risk, both grounded above:

- The shell client is **built** to register the native id (`tsdown.config.ts:3`), so its own
  row cannot coexist with the native row without a shell-client rebuild under a new identity,
  a new bundle patch/row, a new `dsh.profile.bundles` entry, and a smoke rewrite.
- Any second row that also resolves the shell would register a duplicate id, which the loader
  refuses (the smoke installs a `__ModuleLoader__` that throws on a duplicate registration).
- It would leave **two** Sidebar implementations active in the graph — the native session-tree
  Sidebar and the shell — which is the double-owner state the repository contract forbids.

(b) is also what the product's own tests already assume (`packages/dsh/test/e-mate.test.mjs:502`)
and what the desktop profile requires of the row (`desktop/e-mate-desktop/src/profile.ts:397`).

## 4. The change (uncommitted)

- `desktop/e-mate-desktop/src/e-mate-profile.ts`: new `EMATE_SHELL_PACKAGE`,
  `NATIVE_SIDEBAR_PACKAGE`, `shellInstallTarget()` and `shellIdentityOverride()`. The override
  rewrites **only** `package.json.name` to the native identity, and fails loud if the source
  manifest is not the shell or if the shell client bundle does not register the native id. It is
  passed to `installManagedPackage` **and** to the installed-generation currency check, so a
  profile installed by the previous code is repaired on the next boot instead of being reported
  current.
- `packages/dsh/src/e-mate.ts`: the same identity for the CLI profile
  (`shellInstallManifest()`, used by the `profileFiles` copy loop), plus a fail-closed line in
  `profileCheck()` requiring the installed shell manifest to carry the native name.
- `desktop/e-mate-desktop/scripts/verify-profile-boot.mjs`: the native id is required again
  (the expectation was never weakened), and the Sidebar assertion now reads "exactly one
  implementation among [native id, `@e-mate/dsh-client-shell`]", which fails closed both when
  the Sidebar is missing and when a second mount reappears. `@e-mate/dsh-plugin-better-sidebar`
  stays required and is **not** an implementation: it registers a single
  `conversation.view` slot (`packages/dsh-plugin-better-sidebar/src/client/index.tsx:122`).

## 5. Verification

Measured after the change (same temporary probe as §2):

```
SHELL_MANIFEST_NAME=@deepseek-ai/dsh-client-ui-sidebar
SHELL_MANIFEST_STATUS=200          # the shell host half is still the row's module
GRAPH_IDS=[… "@deepseek-ai/dsh-client-ui-sidebar" …]   # and no @e-mate/dsh-client-shell row
```

Repair proof (a profile left by the previous code is fixed, not reported current): the probe below
installed the profile, rewrote the installed shell manifest back to the shell's own name (the old
state), and called the installer again — the warm generation path, because the install receipt was
still valid:

```
AFTER_FIRST_INSTALL=@deepseek-ai/dsh-client-ui-sidebar
AFTER_SIMULATED_OLD_INSTALL=@e-mate/dsh-client-shell
AFTER_NEXT_BOOT=@deepseek-ai/dsh-client-ui-sidebar
```

Guard proof (fail-closed direction): with only the install-site override neutered in the built
installer, the smoke went red with the original refusal verbatim —
`assembled desktop Web graph is missing @deepseek-ai/dsh-client-ui-sidebar; got …` — and the
built file was then restored byte-identically (`sha256 1fe958f47e891fb945bd0ffdeb769ef056c10f1a83f69ecf442c50c69df1133b`).

| command | exit | result |
|---|---|---|
| `cd desktop && corepack yarn run verify:profile` | 0 | Profile boot smoke passes end to end, including every client bundle registering its graph id; it advances to no further failure |
| `cd desktop && corepack yarn check` | 0 | Full desktop gate: typecheck, 50 test files / 517 passed + 5 skipped, `verify:closure` (247 first-party runtime nodes), `verify:cli`, `verify:loader`, `verify:licenses` (547 packages), then `verify:profile` |
| `pnpm run test:fast` (root) | 0 | 68/68 and 38/38, 0 fail |
| `node scripts/component-run.mjs check` (root) | 0 | component gate green (22/22 plugin tests plus the type checks) |
| `cd packages/dsh && node --test test/e-mate.test.mjs` | 0 | 36/36 — the narrow owner test for the CLI installer, including `:502` (the installed shell client registers the native id) against a profile installed by the changed code |

## 6. What this does not claim

- No upstream file was modified; the pinned scanner's name rule is used as it stands.
- `better-sidebar` is not the Sidebar implementation, and the native Sidebar package is not
  installed separately — there is exactly one Sidebar implementation, the shell, answering the
  native row.
- The installed identity is a product-side install detail; the row name in the pinned Web bundle
  is untouched.
