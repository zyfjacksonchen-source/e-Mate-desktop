/**
 * Fail-closed seam assertions for the vendored `dsh-turn-fold` patches.
 *
 * The vendored `patch.cjs` rewrites the **already-compiled** browser bundle in
 * memory with three tsquery selectors (`expect: 1` each) and prepends an injected
 * runtime that runs inside that module factory. A Harness rebuild can change that
 * compiled shape without changing any public API, so this checker re-evaluates the
 * real selectors against the pinned 0.1.5 build and refuses to build when any of
 * them no longer resolves exactly once, or when a symbol the injected runtime
 * reads from the host module scope is no longer bound there.
 *
 * It runs against `upstream/deepseek-harness/packages/client/ui-chat/lib/client.js`
 * (the pinned fork checkout, commit d1d095bee770c3e9d302f844083e02f0b74576ee).
 * `lib/` is build output: run the pinned Harness build first, or this checker
 * fails closed with that instruction instead of guessing.
 *
 * The patches may only touch the bundle they were verified against, so the checker verifies
 * the resolved bundle against the shared pin (`TARGET_BUNDLE_SHA256`, the AGENTS.md condition
 * "the bundle hash must be verified"). A rebuilt bundle with a different digest is refused
 * *before* a single selector is evaluated: no seam result is produced, no patch is
 * authorized, and the failure names both the pinned and the resolved digest. The pin and its
 * evaluation live in the shared engine (`src/select.cjs`) that the runtime driver imports
 * too, so the two gates cannot judge different bytes.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  BUNDLE_HASH_CHECK_ID,
  TARGET_BUNDLE_SHA256,
  createSelectorEngine,
  evaluateBundleHash,
  sha256,
} from './tsquery-subset.mjs'

// The bundle-identity pin and its evaluation belong to the shared engine, so this checker
// and the runtime driver cannot drift apart. They are re-exported here because this module
// remains the checker's public surface.
export { BUNDLE_HASH_CHECK_ID, TARGET_BUNDLE_SHA256, evaluateBundleHash }

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const repoRoot = resolve(packageRoot, '..', '..')

/** The compiled target the vendored patch rewrites. */
export const TARGET = Object.freeze({
  package: '@deepseek-ai/dsh-client-ui-chat',
  file: 'lib/client.js',
})

/**
 * The three selectors are copied verbatim from the vendored
 * `upstream/plugins/dsh-turn-fold/patch.cjs`; `test/package.test.mjs` asserts they
 * are still present in that file so the checker cannot drift away from the code
 * it guards.
 */
export const SEAMS = Object.freeze([
  Object.freeze({
    id: 'inject-turn-fold-runtime',
    selector: 'FunctionDeclaration[name.name="ChatView"], VariableStatement:has(VariableDeclaration[name.name="ChatView"])',
    expect: 1,
    description: 'anchor for the injected fold runtime',
  }),
  Object.freeze({
    id: 'rewrite-node-render-loop',
    selector: 'CallExpression[arguments.0.name="ChatNodeList"]',
    expect: 1,
    description: 'the native node-list seam that becomes the per-turn renderer',
    requireArguments: 2,
  }),
  Object.freeze({
    id: 'install-turn-fold-services',
    selector: 'VariableStatement:has(VariableDeclaration[name.name="t"][initializer.expression.name.name="bind"])',
    expect: 1,
    description: 'locale bind statement that also installs the settings scope',
  }),
])

/**
 * Identifiers the injected runtime reads from the host module scope.
 *
 * Derived, not guessed: a full free-identifier analysis of the vendored
 * `inline-source.cjs` (277 declarations vs 300 referenced identifiers) leaves
 * exactly these six. The upstream header comment names only the first four; the
 * other two are real host dependencies it omits —
 * `_deepseek_ai_dsh_client_ui_primitives` (the compiled alias for
 * `@deepseek-ai/dsh-client-ui-primitives`, used by the injected `DisclosureRow`
 * call at inline-source.cjs:316) and `ReasoningRow` (the ui-chat factory's own
 * component, called at inline-source.cjs:342; it exists in `ui-chat/lib/client.js`
 * but NOT in the legacy `ui-conversation` bundle).
 */
export const HOST_SYMBOLS = Object.freeze([
  Object.freeze({ name: 'react', reason: 'injected runtime uses react.useState/useRef/useEffect (inline-source.cjs:244)' }),
  Object.freeze({ name: 'react_jsx_runtime', reason: 'injected runtime renders with react_jsx_runtime.jsx/jsxs (:203)' }),
  Object.freeze({ name: 'formatRunDuration', reason: 'summary bar formats wall time with formatRunDuration(ms, t) (:746)' }),
  Object.freeze({ name: 'formatTokens', reason: 'summary bar formats token counts with formatTokens(value, t) (:756)' }),
  Object.freeze({ name: '_deepseek_ai_dsh_client_ui_primitives', reason: 'renders primitives.DisclosureRow/StateDot/Icon* (:316)' }),
  Object.freeze({ name: 'ReasoningRow', reason: 'renders the native reasoning row inside the folded activity (:342)' }),
])

const IGNORED_DIRECTORIES = new Set(['.git', '.github', 'build', 'dist', 'lib', 'node_modules'])

/** Exported so `test/seams.test.mjs` can read the real pinned bundle for its negative controls. */
export function findHarnessRoot() {
  const candidates = [
    process.env.EMATE_HARNESS_ROOT,
    resolve(repoRoot, 'upstream', 'deepseek-harness'),
  ].filter(candidate => typeof candidate === 'string' && candidate.length > 0)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  throw new Error(
    `turn-fold seams: no pinned Harness checkout found (tried ${candidates.join(', ')}); ` +
    'set EMATE_HARNESS_ROOT to the pinned deepseek-harness checkout',
  )
}

/** Exported so `test/seams.test.mjs` can parse mutated copies with the pinned compiler. */
export function loadCompiler(harnessRoot) {
  const manifest = join(harnessRoot, 'package.json')
  if (!existsSync(manifest)) throw new Error(`turn-fold seams: pinned Harness manifest is missing: ${manifest}`)
  const require = createRequire(manifest)
  try {
    return require('typescript')
  } catch {
    throw new Error(
      `turn-fold seams: the pinned Harness TypeScript compiler is not installed under ${harnessRoot}; ` +
      'install the Harness checkout (pnpm install) before building this component',
    )
  }
}

/** Map every workspace package of the pinned Harness checkout by npm name. */
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
          if (packages.has(manifest.name)) throw new Error(`duplicate pinned Harness package: ${manifest.name}`)
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

/** Exported so `test/seams.test.mjs` can locate the real target file without hard-coding a path. */
export function locateTarget(harnessRoot, spec) {
  const installed = join(harnessRoot, 'node_modules', ...spec.package.split('/'))
  const root = existsSync(join(installed, 'package.json'))
    ? installed
    : harnessPackages(harnessRoot).get(spec.package)?.root
  if (root === undefined) {
    throw new Error(`turn-fold seams: pinned Harness package is unavailable: ${spec.package}`)
  }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const file = join(root, spec.file)
  if (!existsSync(file)) {
    throw new Error(
      `turn-fold seams: ${spec.package}/${spec.file} is missing under ${root}. ` +
      'That file is build output — build the pinned Harness checkout first ' +
      '(root: npm_execpath=<pnpm 11.7.0> node scripts/harness-provenance.mjs build).',
    )
  }
  return { root, file, name: manifest.name, version: manifest.version }
}

/** Collect every binding visible in the function scopes that enclose `node`. */
function enclosingScopeBindings(ts, node) {
  const bindings = new Set()
  const visitStatements = (scope, depth) => {
    for (const statement of scope.statements ?? []) {
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
        bindings.add(statement.name.text)
        continue
      }
      if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
        bindings.add(statement.name.text)
        continue
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          for (const name of bindingNames(ts, declaration.name)) bindings.add(name)
        }
        continue
      }
      // `var` hoists out of nested blocks; descend without crossing a function boundary.
      if (ts.isBlock(statement) && depth < 8) visitStatements(statement, depth + 1)
    }
  }
  for (let current = node; current !== undefined; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      for (const parameter of current.parameters ?? []) {
        for (const name of bindingNames(ts, parameter.name)) bindings.add(name)
      }
      if (current.body !== undefined && ts.isBlock(current.body)) visitStatements(current.body, 0)
    }
  }
  return bindings
}

function bindingNames(ts, name) {
  if (ts.isIdentifier(name)) return [name.text]
  const names = []
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) names.push(...bindingNames(ts, element.name))
    }
  }
  return names
}

function line(ts, sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

/**
 * Evaluate every seam against one compiled source text.
 *
 * Pure on purpose: it takes the compiler and the text, touches no filesystem, and can
 * therefore be driven with deliberately mutated copies of the pinned bundle.
 * `test/seams.test.mjs` does exactly that, so the rule below is proven to *reject* a
 * missing or duplicated anchor instead of quietly accepting one.
 *
 * @param {*} ts the pinned Harness TypeScript compiler module
 * @param {string} sourceText the compiled module text to inspect
 * @param {string} fileName path recorded on the parsed source file (diagnostics only)
 * @returns {{ results: Array<{id: string, ok: boolean, found: number, expect: number, detail: string}>, failures: string[] }}
 */
export function evaluateSeams(ts, sourceText, fileName) {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const engine = createSelectorEngine(ts)

  const results = []
  const failures = []
  for (const seam of SEAMS) {
    let matched = []
    try {
      matched = engine.query(sourceFile, seam.selector)
    } catch (cause) {
      failures.push(`${seam.id}: ${cause.message}`)
      results.push({ id: seam.id, ok: false, found: 0, expect: seam.expect, detail: cause.message })
      continue
    }
    const lines = matched.map(node => line(ts, sourceFile, node))
    let detail = matched.length === 0 ? 'no match' : `line ${lines.join(', ')}`
    let ok = matched.length === seam.expect
    if (ok && seam.requireArguments !== undefined) {
      const missing = matched.filter(node => (node.arguments?.length ?? 0) < seam.requireArguments)
      if (missing.length > 0) {
        ok = false
        detail += `; matched call has fewer than ${seam.requireArguments} arguments (the patch rewrite needs the props argument)`
      }
    }
    if (!ok) failures.push(`${seam.id}: selector matched ${matched.length}, expected ${seam.expect}`)
    results.push({ id: seam.id, ok, found: matched.length, expect: seam.expect, detail })
  }
  return { results, failures }
}

/**
 * Resolve the host symbols the injected runtime reads, from the seam-1 anchor's scope
 * chain. The coupling is fail-closed on purpose: with no resolved anchor there is no
 * scope to read, so every symbol is reported unresolved rather than assumed present.
 *
 * @param {*} ts the pinned Harness TypeScript compiler module
 * @param {string} sourceText the same text `results` were produced from
 * @param {string} fileName path recorded on the parsed source file (diagnostics only)
 * @param {Array<{id: string, ok: boolean, found: number, expect: number, detail: string}>} results the `results` returned by `evaluateSeams`
 * @returns {{ symbols: Array<{name: string, reason: string, resolved: boolean}>, failures: string[] }}
 */
export function evaluateHostSymbols(ts, sourceText, fileName, results) {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const engine = createSelectorEngine(ts)
  const anchor = results[0]?.ok === true ? engine.query(sourceFile, SEAMS[0].selector)[0] : undefined
  const bindings = anchor === undefined ? new Set() : enclosingScopeBindings(ts, anchor)
  const failures = []
  const symbols = HOST_SYMBOLS.map(symbol => {
    const resolved = bindings.has(symbol.name)
    if (!resolved) failures.push(`host symbol ${symbol.name} is not bound in the ChatView scope chain`)
    return { ...symbol, resolved }
  })
  return { symbols, failures }
}

/**
 * Verify the bundle pin, then evaluate every seam against the pinned build.
 *
 * The order is the guard: the hash gate runs first, and when the resolved bundle is not the
 * verified target this throws **before a single selector is evaluated**. Nothing downstream
 * can then read the run as an authorization, so no patch is applied to a bundle whose shape
 * was never verified — `report.evaluated` is false and both hook lists are empty.
 *
 * @param {{pinnedSha256?: string}} [options] exists so `test/seams.test.mjs` can drive the
 *   mismatch path; `build.mjs` and the CLI call this with no argument, so the shipped gate
 *   always uses `TARGET_BUNDLE_SHA256`.
 * @returns a report object; throws when the pin mismatches, or when any seam does not
 *   resolve as declared.
 */
export function assertSeams(options = {}) {
  const pinnedSha256 = options.pinnedSha256 ?? TARGET_BUNDLE_SHA256
  const harnessRoot = findHarnessRoot()
  const ts = loadCompiler(harnessRoot)
  const target = locateTarget(harnessRoot, TARGET)
  const fileBytes = statSync(target.file).size
  const fileSha256 = sha256(readFileSync(target.file))

  const hash = evaluateBundleHash(fileSha256, pinnedSha256)
  const identity = {
    packageName: target.name,
    packageVersion: target.version,
    file: target.file,
    fileBytes,
    fileSha256,
    pinnedSha256,
    harnessRoot,
    hash: hash.result,
    bundleVerified: hash.result.ok === true,
  }

  if (hash.result.ok !== true) {
    const report = { ...identity, evaluated: false, seams: [], symbols: [] }
    const error = new Error(
      `turn-fold seams failed against ${target.name}@${target.version}:\n  - ${hash.failures.join('\n  - ')}\n` +
      `no patch is authorized for this bundle: the hash gate refused it (${fileBytes} bytes at ${target.file}) ` +
      'before any selector was evaluated.',
    )
    error.report = report
    throw error
  }

  const sourceText = readFileSync(target.file, 'utf8')
  const seams = evaluateSeams(ts, sourceText, target.file)
  const hosts = evaluateHostSymbols(ts, sourceText, target.file, seams.results)
  const failures = [...seams.failures, ...hosts.failures]
  const report = { ...identity, evaluated: true, seams: seams.results, symbols: hosts.symbols }
  if (failures.length > 0) {
    const error = new Error(`turn-fold seams failed against ${target.name}@${target.version}:\n  - ${failures.join('\n  - ')}`)
    error.report = report
    throw error
  }
  return report
}

export function formatReport(report) {
  const rows = [
    `turn-fold seams vs ${report.packageName}@${report.packageVersion}`,
    `  build: ${report.file}`,
    `  sha256: ${report.fileSha256}`,
    `  pinned: ${report.pinnedSha256}`,
  ]
  if (report.hash !== undefined) {
    rows.push(`  ${report.hash.ok ? 'OK  ' : 'FAIL'} ${report.hash.id.padEnd(30)} ${report.hash.found}/${report.hash.expect}  ${report.hash.detail}`)
  }
  if (report.evaluated === false) {
    // A refused bundle has no seam results to show: printing the selector rows here would
    // read as a pass for a bundle whose compiled shape was never inspected.
    rows.push('  SKIP seam selectors and host symbols: the hash gate refused this bundle first')
    rows.push('  REFUSED: no patch is applied to a bundle that is not the verified target')
    return rows.join('\n')
  }
  for (const seam of report.seams) {
    rows.push(`  ${seam.ok ? 'OK  ' : 'FAIL'} ${seam.id.padEnd(30)} ${seam.found}/${seam.expect}  ${seam.detail}`)
  }
  rows.push(`  ${report.symbols.every(symbol => symbol.resolved) ? 'OK  ' : 'FAIL'} host symbols in ChatView scope: ${report.symbols.map(symbol => (symbol.resolved ? symbol.name : `MISSING(${symbol.name})`)).join(', ')}`)
  return rows.join('\n')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = assertSeams()
    process.stdout.write(`${formatReport(report)}\n`)
  } catch (cause) {
    if (cause.report !== undefined) process.stdout.write(`${formatReport(cause.report)}\n`)
    process.stderr.write(`${cause.message}\n`)
    process.exitCode = 1
  }
}
