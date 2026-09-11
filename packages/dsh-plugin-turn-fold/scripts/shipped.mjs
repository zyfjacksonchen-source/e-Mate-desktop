/**
 * The files this package ships inside `lib/`.
 *
 * Two origins, never mixed:
 *
 * - `VENDORED` entries are copied verbatim from `upstream/plugins/dsh-turn-fold`.
 *   No path rewriting and no identifier renaming, because `index.cjs`/`patch.cjs`
 *   require their siblings by relative path and the flat `lib/` layout preserves
 *   exactly that. `test/package.test.mjs` asserts the copied bytes still equal the
 *   vendored bytes, and `upstream/plugins/dsh-turn-fold/SOURCE.md` records every
 *   local modification with its reason.
 * - `EMATE` entries are this package's own sources. `transform.cjs` is the driver that
 *   applies the vendored patches in memory; `select.cjs` is the selector engine it
 *   shares with `scripts/seams.mjs`.
 */
export const VENDORED = Object.freeze([
  'index.cjs',
  'settings.cjs',
  'patch.cjs',
  'inline-source.cjs',
  'locales.cjs',
  'locales/en.json',
  'locales/zh.json',
])

/** e-Mate-owned sources copied from `src/` into the shipped `lib/`. */
export const EMATE = Object.freeze([
  'select.cjs',
  'transform.cjs',
])

/** Every shipped file, for the manifest and `files` assertions. */
export const SHIPPED = Object.freeze([...VENDORED, ...EMATE])
