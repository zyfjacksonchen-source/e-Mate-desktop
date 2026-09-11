/**
 * The vendored upstream files this package ships inside `lib/`.
 *
 * Every entry is copied verbatim — no path rewriting and no identifier renaming —
 * because `index.cjs`/`patch.cjs` require their siblings by relative path and the
 * flat `lib/` layout preserves exactly that. `test/package.test.mjs` asserts the
 * copied bytes still equal the vendored bytes.
 */
export const SHIPPED = Object.freeze([
  'index.cjs',
  'settings.cjs',
  'patch.cjs',
  'inline-source.cjs',
  'locales.cjs',
  'locales/en.json',
  'locales/zh.json',
])
