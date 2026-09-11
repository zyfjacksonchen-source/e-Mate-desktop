'use strict'

/**
 * e-Mate driver for the vendored dsh-turn-fold Source Patches.
 *
 * The upstream provider declares a patch list in its package manifest and expects
 * dsh-harmony to run it. DSH 0.1.5 has no Harmony layer, the harmony runtime cannot
 * even be imported on 0.1.5, and the only two facilities the vendored patches
 * actually use are a three-selector tsquery subset and three source splices. This
 * module supplies exactly those, so the provider loads with no third-party
 * dependency beyond the TypeScript compiler the pinned Harness checkout already
 * carries.
 *
 * Four properties are load-bearing and are enforced here, not documented and
 * hoped for:
 *   - the source must be the **verified bundle**: its sha256 is compared against the
 *     shared pin before the compiler or the patch module is even loaded, so a bundle
 *     whose bytes were never verified is refused instead of rewritten;
 *   - the patches run **in memory only**; a transformed bundle is returned as a
 *     string and never written to disk;
 *   - every descriptor must declare `expect: 1` and must match exactly once, so a
 *     Harness rebuild that changes the compiled shape refuses the transform
 *     instead of applying a partial rewrite;
 *   - the result must parse as JavaScript, because that is the only thing the
 *     browser will do with it.
 */

const { existsSync, readFileSync, readdirSync } = require('node:fs')
const { createRequire } = require('node:module')
const { dirname, join, resolve } = require('node:path')

// The selector engine and the bundle-identity pin come from one shared module, so this
// driver cannot drift from the build-time checker that authorizes the same bundle.
const {
  BUNDLE_HASH_CHECK_ID,
  VERIFIED_BUNDLE_SHA256,
  createSelectorEngine,
  evaluateBundleHash,
  sha256,
} = require('./select.cjs')

/** The compiled target the vendored 0.1.2-and-later patch set rewrites. */
const TARGET = Object.freeze({
  package: '@deepseek-ai/dsh-client-ui-chat',
  file: 'lib/client.js',
})

/** Environment override naming the pinned Harness checkout. */
const ENV_HARNESS_ROOT = 'EMATE_HARNESS_ROOT'
/** Environment channel the vendored patch module reads its active version from. */
const ENV_ACTIVE_VERSION = 'DSH_TURN_FOLD_ACTIVE_VERSION'

const IGNORED_DIRECTORIES = new Set(['.git', '.github', 'build', 'dist', 'lib', 'node_modules'])

/**
 * Locate the pinned Harness checkout.
 * @param {{ harnessRoot?: string }} [options] - explicit checkout path.
 * @returns {string} the checkout root.
 */
function findHarnessRoot(options = {}) {
  const candidates = [
    options.harnessRoot,
    process.env[ENV_HARNESS_ROOT],
    resolve(__dirname, '..', '..', '..', 'upstream', 'deepseek-harness'),
  ].filter(candidate => typeof candidate === 'string' && candidate.length > 0)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  throw new Error(
    'turn-fold transform: no pinned Harness checkout found (tried ' + candidates.join(', ') + '); ' +
    'set ' + ENV_HARNESS_ROOT + ' to the pinned deepseek-harness checkout',
  )
}

/**
 * Load the TypeScript compiler from the pinned checkout.
 * @param {string} harnessRoot - pinned Harness checkout root.
 * @returns {*} the TypeScript module.
 */
function loadCompiler(harnessRoot) {
  const manifest = join(harnessRoot, 'package.json')
  if (!existsSync(manifest)) throw new Error('turn-fold transform: pinned Harness manifest is missing: ' + manifest)
  const require = createRequire(manifest)
  try {
    return require('typescript')
  } catch {
    throw new Error(
      'turn-fold transform: the pinned Harness TypeScript compiler is not installed under ' + harnessRoot + '; ' +
      'install the Harness checkout (pnpm install) before running this component',
    )
  }
}

/**
 * Map every workspace package of the pinned Harness checkout by npm name.
 * @param {string} harnessRoot - pinned Harness checkout root.
 * @returns {Map<string, { root: string, version: string }>} name to package.
 */
function harnessPackages(harnessRoot) {
  const packages = new Map()
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue
      const child = join(directory, entry.name)
      const manifestPath = join(child, 'package.json')
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (typeof manifest.name === 'string') {
          if (packages.has(manifest.name)) throw new Error('duplicate pinned Harness package: ' + manifest.name)
          packages.set(manifest.name, { root: child, version: manifest.version })
        }
      }
      visit(child)
    }
  }
  for (const top of ['apps', 'packages', 'vendor']) {
    const directory = join(harnessRoot, top)
    if (existsSync(directory)) visit(directory)
  }
  return packages
}

/**
 * Resolve one compiled target inside the pinned checkout.
 * @param {string} harnessRoot - pinned Harness checkout root.
 * @param {{ package: string, file: string }} spec - target package and its relative file.
 * @returns {{ root: string, file: string, name: string, version: string }} resolved target.
 */
function locateTarget(harnessRoot, spec) {
  const installed = join(harnessRoot, 'node_modules', ...spec.package.split('/'))
  const root = existsSync(join(installed, 'package.json'))
    ? installed
    : harnessPackages(harnessRoot).get(spec.package)?.root
  if (root === undefined) throw new Error('turn-fold transform: pinned Harness package is unavailable: ' + spec.package)
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const file = join(root, spec.file)
  if (!existsSync(file)) {
    throw new Error(
      'turn-fold transform: ' + spec.package + '/' + spec.file + ' is missing under ' + root + '. ' +
      'That file is build output — build the pinned Harness checkout first.',
    )
  }
  return { root, file, name: manifest.name, version: manifest.version }
}

/**
 * Resolve a patch target from the bundle a seat is about to serve.
 *
 * The installed product has no Harness checkout to walk: the Client module registry serves the
 * assembled closure, and `clientPath()` names the exact file it will hand the browser. That file
 * is the artifact whose bytes must be verified, so it is resolved from its own manifest rather
 * than from a build tree.
 *
 * @param {string} sourcePath - absolute path of the bundle that will be served.
 * @param {{ package: string, file: string }} spec - the expected package and relative file.
 * @returns {{ root: string, file: string, name: string, version: string }} resolved target.
 */
function locateServedTarget(sourcePath, spec) {
  const root = dirname(dirname(sourcePath))
  const manifestPath = join(root, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error('turn-fold transform: no package manifest above the served bundle: ' + sourcePath)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.name !== spec.package) {
    throw new Error(
      'turn-fold transform: the served bundle belongs to ' + String(manifest.name) +
      ', not the pinned target ' + spec.package,
    )
  }
  if (!existsSync(sourcePath)) throw new Error('turn-fold transform: the served bundle is missing: ' + sourcePath)
  return { root, file: sourcePath, name: manifest.name, version: manifest.version }
}

/**
 * Read the vendored patch descriptors for one target version.
 *
 * The vendored module resolves its own active version at load time; the owning
 * driver already knows it from the target manifest, so it is supplied through the
 * documented channel instead of probing an ambient installation.
 *
 * @param {string} patchModulePath - absolute path of the vendored `patch.cjs`.
 * @param {{ name: string, version: string }} target - resolved patch target.
 * @returns {Array<object>} the patch descriptors, validated.
 */
function loadPatches(patchModulePath, target) {
  const previous = process.env[ENV_ACTIVE_VERSION]
  process.env[ENV_ACTIVE_VERSION] = target.version
  let module
  try {
    module = require(patchModulePath)
  } finally {
    if (previous === undefined) delete process.env[ENV_ACTIVE_VERSION]
    else process.env[ENV_ACTIVE_VERSION] = previous
  }
  const createPatches = module.createPatches
  if (typeof createPatches !== 'function') {
    throw new Error('turn-fold transform: ' + patchModulePath + ' does not expose createPatches')
  }
  const patches = createPatches(target.version)
  if (!Array.isArray(patches) || patches.length === 0) {
    throw new Error('turn-fold transform: ' + patchModulePath + ' produced no patches for ' + target.version)
  }
  for (const patch of patches) {
    if (patch === null || typeof patch !== 'object') throw new Error('turn-fold transform: malformed patch descriptor')
    if (typeof patch.id !== 'string' || patch.id.length === 0) throw new Error('turn-fold transform: patch without an id')
    if (typeof patch.select !== 'string' || typeof patch.apply !== 'function') {
      throw new Error('turn-fold transform: patch ' + patch.id + ' is missing select/apply')
    }
    if (patch.expect !== 1) {
      throw new Error('turn-fold transform: patch ' + patch.id + ' declares expect ' + String(patch.expect) + ', not the fail-closed 1')
    }
    if (patch.target?.package !== target.name || patch.target?.file !== TARGET.file) {
      throw new Error(
        'turn-fold transform: patch ' + patch.id + ' targets ' + String(patch.target?.package) + '/' +
        String(patch.target?.file) + ', not ' + target.name + '/' + TARGET.file,
      )
    }
  }
  return patches
}

/** Collect the splices one patch run requests and apply them right to left. */
function createEditor() {
  const edits = []
  return {
    prependLeft(position, text) {
      edits.push({ start: position, end: position, text })
    },
    overwrite(start, end, text) {
      edits.push({ start, end, text })
    },
    apply(text) {
      const ordered = edits.slice().sort((left, right) => left.start - right.start || left.end - right.end)
      let cursor = -1
      for (const edit of ordered) {
        if (edit.start < cursor) throw new Error('turn-fold transform: patch edits overlap at offset ' + edit.start)
        cursor = edit.end
      }
      let output = text
      for (let index = ordered.length - 1; index >= 0; index -= 1) {
        const edit = ordered[index]
        output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
      }
      return output
    },
    get count() {
      return edits.length
    },
  }
}

/** Refuse a transform whose result the browser could not even parse. */
function assertParses(text, fileName) {
  try {
    // The browser evaluates the served bundle through the module loader, which is
    // a full parse; this is the cheapest faithful reproduction of that step.
    Function(text)
  } catch (cause) {
    throw new Error('turn-fold transform produced an unparsable bundle (' + fileName + '): ' + cause.message)
  }
}

/**
 * Refuse a bundle that is not the verified target, before anything is rewritten.
 *
 * The build-time checker holds the same pin, but a gate at build time cannot protect a
 * runtime that patches whatever bytes it finds: this driver is the last code to see the
 * bundle before it is rewritten, so it repeats the check here, against the same
 * `VERIFIED_BUNDLE_SHA256` set both callers import from `./select.cjs`. Hashing happens before
 * the compiler is loaded, before the patch module is required and before any selector is
 * evaluated, so a refused bundle never reaches code that could rewrite it.
 *
 * @param {Buffer} sourceBytes the compiled bundle exactly as it sits on disk.
 * @param {{ name: string, version: string, file: string }} target the resolved patch target.
 * @returns {{ actualSha256: string, pinnedSha256: readonly string[] }} the verified identity.
 * @throws when the digest is not the pin; nothing is applied and nothing is written.
 */
function assertVerifiedBundle(sourceBytes, target) {
  const actualSha256 = sha256(sourceBytes)
  const evaluation = evaluateBundleHash(actualSha256)
  if (evaluation.result.ok !== true) {
    const error = new Error(
      'turn-fold transform refused: ' + BUNDLE_HASH_CHECK_ID + ' refused ' + target.name + ' at ' + target.file + '\n' +
      '  - ' + evaluation.result.detail + '\n' +
      'no patch is applied to a bundle whose identity was not verified: re-verify the three selectors against ' +
      'the new build, then move the digest set in packages/dsh-plugin-turn-fold/src/select.cjs',
    )
    error.report = {
      applied: [],
      bundleVerified: false,
      evaluated: false,
      failures: evaluation.failures,
      file: target.file,
      fileSha256: actualSha256,
      hash: evaluation.result,
      pinnedSha256: VERIFIED_BUNDLE_SHA256,
      target,
    }
    throw error
  }
  return { actualSha256, pinnedSha256: VERIFIED_BUNDLE_SHA256 }
}

/**
 * Apply the vendored Source Patches to the pinned compiled bundle, in memory.
 *
 * The source is digest-verified first (see `assertVerifiedBundle`): only the bundle whose
 * bytes were verified is ever rewritten.
 *
 * @param {{ harnessRoot?: string, target?: { package: string, file: string }, patchModule?: string }} [options]
 *   overrides for the pinned checkout, the patch target and the vendored patch module.
 * @returns {{ text: string, sourceText: string, target: object, patches: Array<object>, sourceSha256: string, pinnedSha256: readonly string[], bundleVerified: boolean, sha256: string }}
 *   the transformed bundle text; nothing is written to disk.
 */
function transformClientBundle(options = {}) {
  const spec = options.target ?? TARGET
  // Two callers, two ways to name the same artifact: the build-time checker resolves the pinned
  // checkout, while a serving seat hands over the file the registry is about to serve. Both end in
  // the same digest gate below, so neither can bypass it.
  const served = options.sourcePath !== undefined
  const harnessRoot = served ? undefined : findHarnessRoot(options)
  const target = served
    ? locateServedTarget(options.sourcePath, spec)
    : locateTarget(harnessRoot, spec)

  // The gate owns the order: the digest is verified before the compiler is loaded, before
  // the patch module is required and before a single selector is evaluated.
  const sourceBytes = readFileSync(target.file)
  const verified = assertVerifiedBundle(sourceBytes, target)
  const sourceText = sourceBytes.toString('utf8')

  const ts = options.compiler ?? loadCompiler(served ? target.root : harnessRoot)
  const patchModulePath = options.patchModule ?? join(__dirname, 'patch.cjs')
  const patches = loadPatches(patchModulePath, target)

  const sourceFile = ts.createSourceFile(target.file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const engine = createSelectorEngine(ts)
  const editor = createEditor()
  const applied = []
  for (const patch of patches) {
    const matched = engine.query(sourceFile, patch.select)
    if (matched.length !== patch.expect) {
      throw new Error(
        'turn-fold transform refused: ' + patch.id + ' matched ' + matched.length + ', expected ' + patch.expect +
        ' (the compiled shape of ' + target.name + ' changed)',
      )
    }
    const before = editor.count
    patch.apply({ node: matched[0], sourceFile, edit: editor, ts })
    if (editor.count === before) throw new Error('turn-fold transform: ' + patch.id + ' edited nothing')
    applied.push({
      id: patch.id,
      select: patch.select,
      found: matched.length,
      line: sourceFile.getLineAndCharacterOfPosition(matched[0].getStart(sourceFile)).line + 1,
    })
  }

  const text = editor.apply(sourceText)
  assertParses(text, target.file)
  return {
    text,
    sourceText,
    target,
    patches: applied,
    sourceSha256: verified.actualSha256,
    pinnedSha256: verified.pinnedSha256,
    bundleVerified: true,
    sha256: sha256(text),
  }
}

module.exports = {
  ENV_ACTIVE_VERSION,
  ENV_HARNESS_ROOT,
  TARGET,
  assertVerifiedBundle,
  findHarnessRoot,
  loadCompiler,
  locateTarget,
  transformClientBundle,
}
