/**
 * Executable form of two repository rules, proved against this checkout:
 *
 * 1. "No plugin modifies the core": an e-Mate plugin never parses, patches, injects
 *    into or writes a compiled DeepSeek Harness artifact, and never carries a
 *    source-parsing toolchain.
 *
 *    The shape this forbids is the retracted Path C one: packages/dsh-plugin-turn-fold
 *    (removed in b1357ced55) carried a vendored runtime plus tsquery selectors that
 *    injected that runtime into @deepseek-ai/dsh-client-ui-chat/lib/client.js in memory.
 *    Its replacement route is native: the pinned Harness already declares the slots and
 *    services a client plugin composes through, so no plugin needs to read a core artifact.
 *
 * 2. "No plugin owns the native transcript": the pinned Harness renders the conversation
 *    transcript itself (packages/client/ui-chat ChatView.tsx / ChatNodeSeat.tsx) and owns
 *    both capabilities dsh-plugin-tidychat used to duplicate - message process folding
 *    (compact transcript view mode, chat/TurnProcessNodeView.tsx) and conversation
 *    navigation (chat/TurnNavigator.tsx, rendered inside ChatView, not through a slot).
 *    A plugin that addresses the transcript's private DOM hooks is doing surgery on the
 *    native transcript or re-anchoring a second navigation owner onto it. Both were
 *    retired with packages/dsh-plugin-tidychat (2.0.18), so this second family is
 *    fail-closed: the retired owner cannot come back under another name.
 *
 * 3. The one exemption, by explicit user ruling recorded in AGENTS.md: Codex-style turn
 *    folding is delivered by the dsh-turn-fold provider, whose three shape-guarded
 *    patches apply in memory to the compiled ui-chat bundle at load time. Reading,
 *    parsing and rewriting that compiled bundle is exactly what rules 1 and 2 above
 *    forbid, so the ruling is expressed in one place - EXEMPT_PROVIDER_ROOTS below -
 *    and every rule that honours it reads it from there. It stays narrow: the roots are
 *    named exactly, it grants nothing outside them, and the ruling's own "never written
 *    to disk" condition is enforced inside them, because the harness-artifact-write rule
 *    is never exempt.
 *
 * Scanned surfaces are the e-Mate-owned plugin trees. The pinned Harness checkout
 * (upstream/deepseek-harness) is never scanned: it is the core itself, not an extender.
 * Rule family 2 applies to shipped surfaces only; plugin tests legitimately replay the
 * native DOM with fixtures and ship nothing.
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
 *
 * These paths are the checker's current home. It lived at
 * packages/dsh-plugin-tidychat/test/ until that plugin was retired, then in
 * docs/2.0.18/; the checker is a repository rule, so it now lives in scripts/
 * beside the other repository checkers and is listed in the root test:fast.
 */
export const SELF_EXEMPT_PATHS = [
  'scripts/no-core-rewrite-guard.mjs',
  'scripts/no-core-rewrite-guard.test.mjs',
]

/**
 * The provider roots granted the turn-folding exemption, and the only place that
 * exemption is expressed.
 *
 * AGENTS.md: "One capability is exempt by explicit user ruling: Codex-style turn
 * folding is delivered by the dsh-turn-fold provider, whose three shape-guarded
 * patches apply in memory to the compiled ui-chat bundle at load time. That
 * exemption is narrow and evidenced: the patches must stay in memory (never written
 * to disk), each selector must still match exactly once or the patch is refused, the
 * bundle hash must be verified, and no other plugin may parse sources or rewrite a
 * Harness artifact."
 *
 * The provider does what rules 1 and 2 forbid, so the grant covers both rules for
 * these roots only: parsing toolchains, source rewrites, reads of a shipped Harness
 * bundle, and the native-transcript rules. It grants nothing else, and it cannot
 * spread: matching is by exact root, so a neighbour such as
 * dsh-plugin-turn-fold-extra inherits nothing.
 *
 * One rule deliberately stays fail-closed inside these roots:
 * harness-artifact-write, because the ruling requires the patches to stay in memory
 * and never be written to disk. A provider that persisted a patch would be reported
 * by this very guard.
 */
export const EXEMPT_PROVIDER_ROOTS = [
  'packages/dsh-plugin-turn-fold',
  'packages/dsh-plugin-harmony',
  'upstream/plugins/dsh-turn-fold',
  'upstream/plugins/dsh-harmony',
]

/**
 * Whether a repository-relative path belongs to the exempt turn-folding provider.
 * @param path - repository-relative POSIX path.
 * @returns true when the path is one of the exempt roots or sits below one.
 */
export function isExemptProviderPath(path) {
  return EXEMPT_PROVIDER_ROOTS.some(root => path === root || path.startsWith(root + '/'))
}

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

/**
 * Private DOM hooks of the native transcript. ui-chat owns these attributes
 * (ChatView.tsx writes them, TurnNavigator and the compact transcript read them);
 * a plugin reading or writing them is measuring or mutating another owner's view.
 */
export const NATIVE_TRANSCRIPT_HOOKS = [
  'data-chat-anchor-key',
  'data-chat-flow-kind',
  'data-chat-turn',
  'data-chat-flow',
  'data-conversation-scroll',
]

/** DOM markers the retired tidychat owner wrote into native transcript rows. */
export const RETIRED_OWNER_MARKERS = ['data-tidychat-']

/** Identity the retired navigation owner registered under (slot entry id and CSS prefix). */
export const RETIRED_OWNER_ENTRIES = ['tidychat-nav']

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
 * Native transcript hooks a shipped line names.
 * @param line - one source line.
 * @returns the hooks found on that line.
 */
export function nativeTranscriptHooksOf(line) {
  // Longest first: data-chat-flow is a prefix of data-chat-flow-kind, and a line
  // that names the longer hook names one hook, not two.
  const found = []
  for (const hook of [...NATIVE_TRANSCRIPT_HOOKS].sort((left, right) => right.length - left.length)) {
    if (line.includes(hook) && !found.some(seen => seen.startsWith(hook))) found.push(hook)
  }
  return found.sort((left, right) => NATIVE_TRANSCRIPT_HOOKS.indexOf(left) - NATIVE_TRANSCRIPT_HOOKS.indexOf(right))
}

/**
 * Retired tidychat markers a shipped line emits.
 * @param line - one source line.
 * @returns the markers found on that line.
 */
export function retiredOwnerMarkersOf(line) {
  return RETIRED_OWNER_MARKERS.filter(marker => line.includes(marker))
}

/**
 * Retired navigation owner identities a shipped line names.
 * @param line - one source line.
 * @returns the identities found on that line.
 */
export function retiredOwnerEntriesOf(line) {
  return RETIRED_OWNER_ENTRIES.filter(entry => line.includes(entry))
}

/**
 * Evaluate every rule over an explicit file set. Pure: it reads only the text it is
 * handed, so tests drive the shipped rules directly instead of a copy of them.
 * The AGENTS.md turn-folding exemption is applied here, and only for the roots that
 * EXEMPT_PROVIDER_ROOTS names; harness-artifact-write is never exempt.
 * @param files - entries of path and text with repository-relative POSIX paths.
 * @returns violations in scan order.
 */
export function findViolations(files) {
  const violations = []
  for (const file of files) {
    const shipped = isShippedSurface(file.path)
    // The AGENTS.md exemption, read from its single definition above. It covers
    // rules 1 and 2 for the exempt provider roots, and nothing anywhere else.
    const exempt = isExemptProviderPath(file.path)
    file.text.split('\n').forEach((line, index) => {
      const at = { path: file.path, line: index + 1, text: line.trim().slice(0, 200) }
      if (!exempt) {
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
      }
      // Never exempt: the ruling requires the patches to stay in memory, so a write
      // into the Harness closure is reported inside the exempt roots too.
      if (WRITE_CALL.test(line) && HARNESS_LOCATION.test(line)) {
        violations.push({ ...at, rule: 'harness-artifact-write', detail: 'writes inside the pinned Harness closure' })
      }
      if (!exempt) {
        for (const target of harnessBundlesOf(line)) {
          if (shipped) {
            violations.push({ ...at, rule: 'shipped-harness-bundle', detail: 'shipped code reads ' + target })
            continue
          }
          if (!REVIEWED_TEST_BUNDLE_READS.some(entry => entry.path === file.path && entry.target === target)) {
            violations.push({ ...at, rule: 'unreviewed-harness-bundle', detail: 'test reads ' + target })
          }
        }
      }
      // The native owner keeps ownership of the transcript. A test may replay these
      // hooks with fixtures; shipped code that names them ships a second owner.
      if (!shipped || exempt) return
      for (const hook of nativeTranscriptHooksOf(line)) {
        violations.push({ ...at, rule: 'native-transcript-hook', detail: 'addresses the native transcript hook ' + hook })
      }
      for (const marker of retiredOwnerMarkersOf(line)) {
        violations.push({ ...at, rule: 'retired-owner-marker', detail: 'emits the retired owner marker ' + marker })
      }
      for (const entry of retiredOwnerEntriesOf(line)) {
        violations.push({ ...at, rule: 'retired-owner-identity', detail: 'names the retired navigation owner identity ' + entry })
      }
    })
  }
  return violations
}

/**
 * Every bundle read the rules currently observe in test surfaces, outside the exempt
 * provider roots: an exempt read is granted by EXEMPT_PROVIDER_ROOTS itself, so it is
 * not something the review list has to admit.
 * @param files - scanned entries.
 * @returns keys shaped <path>#client/<package>/lib/client.js.
 */
export function observedTestBundleReads(files) {
  const observed = []
  for (const file of files) {
    if (isShippedSurface(file.path) || isExemptProviderPath(file.path)) continue
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
