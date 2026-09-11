/**
 * Executable form of the repository rule "no plugin modifies the core":
 * an e-Mate plugin never parses, patches, injects into or writes a compiled
 * DeepSeek Harness artifact, and never carries a source-parsing toolchain.
 *
 * The shape this forbids is the retracted Path C one: packages/dsh-plugin-turn-fold
 * (removed in b1357ced55) carried a vendored runtime plus tsquery selectors that
 * injected that runtime into @deepseek-ai/dsh-client-ui-chat/lib/client.js in memory.
 * Its replacement route is native: the pinned Harness already declares the slots and
 * services a client plugin composes through, so no plugin needs to read a core artifact.
 *
 * Scanned surfaces are the e-Mate-owned plugin trees. The pinned Harness checkout
 * (upstream/deepseek-harness) is never scanned: it is the core itself, not an extender.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Source extensions a plugin may ship. */
export const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'])

/** Sub-directories of a plugin package that carry shipped, build or test code. */
export const SCANNED_SUBDIRECTORIES = ['src', 'scripts', 'test', 'tests']

/**
 * The checker's own two files name every forbidden identifier and bundle path in
 * their rule tables, so scanning them would make the rule fail on its own prose.
 * The exemption is by exact path, and the suite asserts it is exactly this pair.
 */
export const SELF_EXEMPT_PATHS = [
  'packages/dsh-plugin-tidychat/test/no-core-rewrite.mjs',
  'packages/dsh-plugin-tidychat/test/no-core-rewrite.test.mjs',
]

/** Package-specifier prefixes that pull a source parser into a plugin. */
export const PARSING_TOOLCHAIN_SPECIFIERS = [
  'typescript',
  '@phenomnomnominal/tsquery',
  'ts-morph',
  'magic-string',
  '@babel/parser',
  '@babel/traverse',
  'acorn',
  'recast',
  'jscodeshift',
]

/**
 * Identifiers that rewrite a source text when called. The rule requires a call, so a
 * protocol constant that merely spells one of these names is not a false positive.
 */
export const SOURCE_REWRITE_IDENTIFIERS = [
  'createSourceFile',
  'MagicString',
  'prependLeft',
  'prependRight',
  'replaceWithText',
  'insertText',
  'tsquery',
]

/** Calls that emit bytes into a filesystem location. */
const WRITE_CALL = /\b(?:writeFileSync|writeFile|cpSync|cp|copyFileSync|copyFile|renameSync|rmSync)\s*\(|\bgit'\s*,\s*\[[^\]]*'apply'/u

/** A filesystem location inside the pinned Harness closure. */
const HARNESS_LOCATION = /deepseek-harness|@deepseek-ai\/dsh-[a-z0-9-]+|targetLib|sourceLib/u

/** A compiled Harness client bundle, addressed by path rather than by package name. */
const HARNESS_CLIENT_BUNDLE = /client\/([a-z0-9-]+)\/lib\/client\.js/gu

/**
 * Reads of a compiled Harness client bundle that already exist in the tree and were
 * reviewed as test-only replayers of a native registration. They are listed by the
 * bundle they read, never by line number, so an unrelated edit above them cannot
 * silently retire the exception and a different bundle cannot inherit it.
 */
export const REVIEWED_TEST_BUNDLE_READS = [
  {
    path: 'packages/dsh-plugin-file-import/test/client-flow.client.spec.tsx',
    target: 'client/ui-conversation/lib/client.js',
    reason: 'Replays the pinned composer-bar registration inside a SlotTestRuntime double; test-only and unable to reach a shipped bundle.',
  },
  {
    path: 'packages/dsh/profile/plugins/emate-shell/tests/image-gallery.client.spec.tsx',
    target: 'client/ui-chat/lib/client.js',
    reason: 'Feeds the adapted chat bundle to a SlotTestRuntime double; test-only and unable to reach a shipped bundle.',
  },
]

/**
 * Classify one repository-relative POSIX path as a shipped/build surface.
 * @param path - repository-relative POSIX path.
 * @returns true when the path ships or builds a plugin.
 */
export function isShippedSurface(path) {
  return /^packages\/dsh-plugin-[^/]+\/(?:src|scripts)\//u.test(path)
    || /^packages\/dsh\/profile\/plugins\/[^/]+\/(?:src|scripts)\//u.test(path)
}

/**
 * Every quoted module specifier a line names through import, export-from, require or dynamic import.
 * @param line - one source line.
 * @returns the specifiers found on that line.
 */
export function specifiersOf(line) {
  const found = []
  const pattern = /(?:from|require\s*\(|import\s*\()\s*(['"])([^'"]+)\1|\bimport\s+(['"])([^'"]+)\3/gu
  for (const match of line.matchAll(pattern)) found.push(match[2] ?? match[4])
  return found
}

/**
 * Compiled Harness client bundles a line addresses by path.
 * @param line - one source line.
 * @returns normalized bundle targets shaped client/<package>/lib/client.js.
 */
export function harnessBundlesOf(line) {
  const found = []
  for (const match of line.matchAll(HARNESS_CLIENT_BUNDLE)) {
    const target = 'client/' + match[1] + '/lib/client.js'
    if (!found.includes(target)) found.push(target)
  }
  return found
}

/**
 * Evaluate every rule over an explicit file set. Pure: it reads only the text it is
 * handed, so tests drive the shipped rules directly instead of a copy of them.
 * @param files - entries of path and text with repository-relative POSIX paths.
 * @returns violations in scan order.
 */
export function findViolations(files) {
  const violations = []
  for (const file of files) {
    const shipped = isShippedSurface(file.path)
    file.text.split('\n').forEach((line, index) => {
      const at = { path: file.path, line: index + 1, text: line.trim().slice(0, 200) }
      for (const specifier of specifiersOf(line)) {
        if (PARSING_TOOLCHAIN_SPECIFIERS.some(name => specifier === name || specifier.startsWith(name + '/'))) {
          violations.push({ ...at, rule: 'parsing-toolchain', detail: 'imports ' + specifier })
        }
      }
      for (const identifier of SOURCE_REWRITE_IDENTIFIERS) {
        if (new RegExp('(?:^|[^\\w$])(?:new\\s+)?' + identifier + '\\s*\\(', 'u').test(line)) {
          violations.push({ ...at, rule: 'source-rewrite', detail: 'uses ' + identifier })
        }
      }
      if (WRITE_CALL.test(line) && HARNESS_LOCATION.test(line)) {
        violations.push({ ...at, rule: 'harness-artifact-write', detail: 'writes inside the pinned Harness closure' })
      }
      for (const target of harnessBundlesOf(line)) {
        if (shipped) {
          violations.push({ ...at, rule: 'shipped-harness-bundle', detail: 'shipped code reads ' + target })
          continue
        }
        if (!REVIEWED_TEST_BUNDLE_READS.some(entry => entry.path === file.path && entry.target === target)) {
          violations.push({ ...at, rule: 'unreviewed-harness-bundle', detail: 'test reads ' + target })
        }
      }
    })
  }
  return violations
}

/**
 * Every bundle read the rules currently observe in test surfaces.
 * @param files - scanned entries.
 * @returns keys shaped <path>#client/<package>/lib/client.js.
 */
export function observedTestBundleReads(files) {
  const observed = []
  for (const file of files) {
    if (isShippedSurface(file.path)) continue
    for (const line of file.text.split('\n')) {
      for (const target of harnessBundlesOf(line)) observed.push(file.path + '#' + target)
    }
  }
  return observed.sort()
}

/**
 * Every bundle read the review list admits.
 * @returns keys shaped <path>#client/<package>/lib/client.js.
 */
export function reviewedTestBundleReads() {
  return REVIEWED_TEST_BUNDLE_READS.map(entry => entry.path + '#' + entry.target).sort()
}

/** Recursively collect scannable files below one directory. */
function walk(directory, root, out) {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules') continue
    const path = join(directory, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) walk(path, root, out)
    else if (SCANNED_EXTENSIONS.has(path.slice(path.lastIndexOf('.')))) {
      const name = relative(root, path).split(sep).join('/')
      if (!SELF_EXEMPT_PATHS.includes(name)) out.push({ path: name, text: readFileSync(path, 'utf8') })
    }
  }
  return out
}

/**
 * Read every e-Mate-owned plugin surface in a checkout.
 * @param root - repository root.
 * @returns every scannable file as path and text entries.
 */
export function readPluginSurfaces(root) {
  const files = []
  const packages = join(root, 'packages')
  for (const entry of readdirSync(packages)) {
    if (!entry.startsWith('dsh-plugin-')) continue
    for (const sub of SCANNED_SUBDIRECTORIES) {
      const directory = join(packages, entry, sub)
      if (statSync(directory, { throwIfNoEntry: false })?.isDirectory() === true) walk(directory, root, files)
    }
  }
  const profilePlugins = join(packages, 'dsh', 'profile', 'plugins')
  for (const entry of readdirSync(profilePlugins)) {
    for (const sub of SCANNED_SUBDIRECTORIES) {
      const directory = join(profilePlugins, entry, sub)
      if (statSync(directory, { throwIfNoEntry: false })?.isDirectory() === true) walk(directory, root, files)
    }
  }
  return files
}
