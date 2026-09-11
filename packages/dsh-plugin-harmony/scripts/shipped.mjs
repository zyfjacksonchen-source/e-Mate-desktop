/**
 * The vendored `dsh-harmony` files this package ships.
 *
 * The published tarball is copied verbatim, preserving the relative layout the
 * built code depends on:
 *  - `lib/profile.js` / `lib/session-profile.js` import `@deepseek-ai/dsh-atomic-write`;
 *  - `lib/installer.js` requires `../scripts/install-shim.cjs` and
 *    `<packageRoot>/scripts/restart.cjs`;
 *  - `lib/plugin.js` serves `../assets/*` over its own HTTP route.
 *
 * Upstream's `harmony.patch.yml` is deliberately NOT shipped: it inserts the
 * upstream `dsh-harmony` / `dsh-harmony/settings` rows, and this package owns its
 * own `cordis.patch.yml` row instead.
 */
export const SHIPPED_TREES = Object.freeze([
  'lib',
  'assets',
  'browser-dist',
])

export const SHIPPED_FILES = Object.freeze([
  'scripts/install-shim.cjs',
  'scripts/restart.cjs',
])

/** The four builtin patch modules re-declared by this package's manifest. */
export const BUILTINS = Object.freeze([
  'lib/builtins/client-load-plan.patch.cjs',
  'lib/builtins/cordis-service-index.patch.cjs',
  'lib/builtins/settings.patch.cjs',
  'lib/builtins/session-profile.patch.cjs',
])
