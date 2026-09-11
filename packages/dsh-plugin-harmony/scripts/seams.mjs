/**
 * Fail-closed seam assertions for the vendored `dsh-harmony` runtime patcher.
 *
 * Harmony rewrites the **already-compiled** bundles of other Harness packages in
 * memory. Its four builtin patches each select nodes by tsquery and then run
 * inner `query()` lookups with `exactlyOne` checks, so a Harness rebuild can break
 * them without any public API change. This checker re-runs those selections
 * against the pinned 0.1.5 build and refuses to build when one no longer
 * resolves.
 *
 * It also reports — but never fails on — each builtin's declared `target.version`
 * range: harmony itself treats a version mismatch as a status warning, not a gate
 * (`upstream/plugins/dsh-harmony/lib/runtime.js:1114` `versionWarning`), and the
 * ranges are 0.1.2-alpha-era. See `docs/2.0.18/dsh-0.1.5-upgrade-facts.md` §76.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createSelectorEngine } from './tsquery-subset.mjs'

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const repoRoot = resolve(packageRoot, '..', '..')

/**
 * Every builtin patch with the seams it needs. `select`/`expect` are the upstream
 * declarations; `checks` are the inner `exactlyOne`/`query()` requirements the
 * vendored `apply` bodies perform.
 */
export const BUILTIN_SEAMS = Object.freeze([
  Object.freeze({
    id: 'client-load-plan',
    builtin: 'lib/builtins/client-load-plan.patch.cjs',
    target: '@deepseek-ai/dsh-client-modules',
    file: 'lib/index.js',
    declaredRange: '>=0.1.1-rc.2 <0.1.2-0 || >=0.1.2-alpha.4 <0.1.3-0',
    rangeSite: 'lib/builtins/dsh-compat.cjs LEGACY_CLIENT_RANGE || DSH_012_RANGE',
    parts: Object.freeze([
      Object.freeze({
        id: 'client-package-resolution',
        select: 'MethodDeclaration[name.name="resolveMeta"]',
        expect: 1,
        check: 'client-package-resolution',
        detail: 'one supported package resolver: locatePkgJson(loaderName, baseUrl)',
      }),
      Object.freeze({
        id: 'client-module-graph',
        select: 'FunctionDeclaration[name.name="graphRow"]',
        expect: 1,
        check: 'function-body',
        detail: 'graphRow must stay a function declaration with a body',
      }),
    ]),
  }),
  Object.freeze({
    id: 'cordis-service-index',
    builtin: 'lib/builtins/cordis-service-index.patch.cjs',
    target: '@deepseek-ai/cordis',
    file: 'lib/index.js',
    declaredRange: '>=4.0.1',
    rangeSite: 'lib/builtins/cordis-service-index.patch.cjs target.version',
    parts: Object.freeze([
      Object.freeze({ id: 'cordis-service-waiter-index', select: 'SourceFile', expect: 1, check: 'cordis-service-index', detail: 'ReflectService.notify registry/fiber loops and the Fiber constructor publication seams' }),
    ]),
  }),
  Object.freeze({
    id: 'settings',
    builtin: 'lib/builtins/settings.patch.cjs',
    target: '@deepseek-ai/dsh-client-ui-settings-general',
    file: 'lib/client.js',
    declaredRange: '>=0.1.0-rc.8 <0.1.2-0 || >=0.1.2-alpha.4 <0.1.3-0',
    rangeSite: 'lib/builtins/dsh-compat.cjs LEGACY_SHARED_RANGE || DSH_012_RANGE',
    parts: Object.freeze([
      Object.freeze({ id: 'settings-integration', select: 'SourceFile', expect: 1, check: 'settings-panel', detail: 'SettingsPanel, navIcon, close and onSelect seams' }),
    ]),
  }),
  Object.freeze({
    id: 'session-profile',
    builtin: 'lib/builtins/session-profile.patch.cjs',
    target: '@deepseek-ai/dsh-api-session-controller',
    file: 'lib/client.js',
    declaredRange: '>=0.1.2-alpha.4 <0.1.3-0',
    rangeSite: 'lib/builtins/dsh-compat.cjs DSH_012_RANGE (>=0.1.2-0 branch)',
    parts: Object.freeze([
      Object.freeze({ id: 'session-profile-guard', select: 'SourceFile', expect: 1, check: 'session-open', detail: 'Session.open -> this.doOpen(this.openGeneration)' }),
    ]),
  }),
])

/**
 * Load-time external requirements of the vendored host entry, with the pinned
 * closure's verdict. Reported, never asserted: slice 2 owns the dependency
 * decision (`README.md` § "Open dependency gaps").
 */
export const LOAD_DEPENDENCIES = Object.freeze([
  Object.freeze({ specifier: '@deepseek-ai/dsh-atomic-write', sites: 'lib/profile.js:5, lib/session-profile.js:3', available: 'pinned Harness ships 0.1.5-rc.1 but base-contract.json does not declare it, so baseImports cannot link it' }),
  Object.freeze({ specifier: '@phenomnomnominal/tsquery', sites: 'lib/transform.js:4-6 (plus dist/src/traverse.js and dist/src/matchers/sibling.js)', available: 'missing from the closure' }),
  Object.freeze({ specifier: 'magic-string', sites: 'lib/transform.js:2', available: 'missing from the closure' }),
  Object.freeze({ specifier: 'semver', sites: 'lib/compatibility.js:1, lib/dsh.js:5, lib/runtime.js:7', available: 'missing from the closure' }),
  Object.freeze({ specifier: 'typescript', sites: 'lib/transform.js:3, lib/runtime.js:8, lib/orchestrator.js:3', available: 'only in the pinned Harness checkout, not in the e-mate closure' }),
  Object.freeze({ specifier: '@deepseek-ai/dsh-settings', sites: 'lib/settings.js:1', available: 'present 0.1.5-rc.1, but the imported settingsNamespace() was deleted in 0.1.5' }),
  Object.freeze({ specifier: '@deepseek-ai/schemastery', sites: 'lib/settings.js:2', available: 'present 3.18.2' }),
  Object.freeze({ specifier: '@deepseek-ai/dsh/lib/bin.js', sites: 'lib/dsh.js:9 (launcher path only)', available: 'pinned Harness ships @deepseek-ai/dsh from apps/cli' }),
])

const IGNORED_DIRECTORIES = new Set(['.git', '.github', 'build', 'dist', 'lib', 'node_modules'])

function findHarnessRoot() {
  const candidates = [
    process.env.EMATE_HARNESS_ROOT,
    resolve(repoRoot, 'upstream', 'deepseek-harness'),
  ].filter(candidate => typeof candidate === 'string' && candidate.length > 0)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  throw new Error(
    `harmony seams: no pinned Harness checkout found (tried ${candidates.join(', ')}); ` +
    'set EMATE_HARNESS_ROOT to the pinned deepseek-harness checkout',
  )
}

function loadCompiler(harnessRoot) {
  const manifest = join(harnessRoot, 'package.json')
  const require = createRequire(manifest)
  try {
    return require('typescript')
  } catch {
    throw new Error(
      `harmony seams: the pinned Harness TypeScript compiler is not installed under ${harnessRoot}; ` +
      'install the Harness checkout (pnpm install) before building this component',
    )
  }
}

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

function locateTarget(harnessRoot, spec) {
  const installed = join(harnessRoot, 'node_modules', ...spec.target.split('/'))
  const root = existsSync(join(installed, 'package.json'))
    ? installed
    : harnessPackages(harnessRoot).get(spec.target)?.root
  if (root === undefined) throw new Error(`harmony seams: pinned Harness package is unavailable: ${spec.target}`)
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const file = join(root, spec.file)
  if (!existsSync(file)) {
    throw new Error(
      `harmony seams: ${spec.target}/${spec.file} is missing under ${root}. That file is build output — ` +
      'build the pinned Harness checkout first.',
    )
  }
  return { root, file, name: manifest.name, version: manifest.version }
}

function text(ts, sourceFile, node) {
  return node.getText(sourceFile)
}

function key(ts, node) {
  return ts.isIdentifier(node) ? node.text : node.getText()
}

function collect(sourceFile, ts, predicate) {
  const found = []
  const walk = node => {
    if (predicate(node)) found.push(node)
    node.forEachChild(walk)
  }
  walk(sourceFile)
  return found
}

function classExpressionVariable(sourceFile, ts, name) {
  return collect(sourceFile, ts, node =>
    ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.name.text === name
    && node.initializer !== undefined
    && ts.isClassExpression(node.initializer))
}

function exactly(nodes, expected) {
  return nodes.length === expected
}

/** Inner requirements of `client-load-plan.patch.cjs#client-package-resolution`. */
function checkClientPackageResolution(sourceFile, ts, node) {
  const calls = collect(node, ts, candidate => ts.isCallExpression(candidate))
  const legacy = calls.filter(call => text(ts, sourceFile, call) === 'this.resolvePkgJson(pkgName)')
  const current = calls.filter(call => text(ts, sourceFile, call) === 'this.locatePkgJson(loaderName, baseUrl)')
  if (legacy.length === 1 && current.length === 0) return { ok: true, detail: 'legacy resolver branch (this.resolvePkgJson(pkgName))' }
  if (current.length === 1 && legacy.length === 0) return { ok: true, detail: 'current resolver branch (this.locatePkgJson(loaderName, baseUrl))' }
  return { ok: false, detail: `expected exactly one supported resolver, found ${legacy.length} legacy and ${current.length} current` }
}

function checkFunctionBody(sourceFile, ts, node) {
  if (node.body === undefined || !ts.isBlock(node.body)) return { ok: false, detail: 'not a function declaration with a block body' }
  return { ok: true, detail: 'function declaration with a body' }
}

/** Inner requirements of `cordis-service-index.patch.cjs`. */
function checkCordisServiceIndex(sourceFile, ts) {
  const reflect = classExpressionVariable(sourceFile, ts, 'ReflectService')
  if (!exactly(reflect, 1)) return { ok: false, detail: `expected 1 ReflectService class expression, found ${reflect.length}` }
  const notify = collect(reflect[0], ts, node => ts.isMethodDeclaration(node) && key(ts, node.name) === 'notify')
  if (!exactly(notify, 1)) return { ok: false, detail: `expected 1 ReflectService.notify method, found ${notify.length}` }
  const registryLoop = collect(notify[0], ts, node =>
    ts.isForOfStatement(node) && text(ts, sourceFile, node.expression) === 'this.ctx.registry.values()')
  if (!exactly(registryLoop, 1)) return { ok: false, detail: `expected 1 registry.values() loop, found ${registryLoop.length}` }
  const fiberLoop = collect(registryLoop[0], ts, node =>
    ts.isForOfStatement(node) && text(ts, sourceFile, node.expression) === 'runtime.fibers')
  if (!exactly(fiberLoop, 1)) return { ok: false, detail: `expected 1 runtime.fibers loop inside the registry scan, found ${fiberLoop.length}` }
  const fiber = classExpressionVariable(sourceFile, ts, 'Fiber')
  if (!exactly(fiber, 1)) return { ok: false, detail: `expected 1 Fiber class expression, found ${fiber.length}` }
  const constructors = collect(fiber[0], ts, node => ts.isConstructorDeclaration(node))
  if (!exactly(constructors, 1)) return { ok: false, detail: `expected 1 Fiber constructor, found ${constructors.length}` }
  const publication = collect(constructors[0], ts, node =>
    ts.isTryStatement(node) && text(ts, sourceFile, node).includes('this.context.emit("internal/plugin", this)'))
  if (!exactly(publication, 1)) return { ok: false, detail: `expected 1 Fiber publication try-statement, found ${publication.length}` }
  const disposal = collect(constructors[0], ts, node =>
    ts.isExpressionStatement(node) && text(ts, sourceFile, node) === 'this.uid = null;')
  if (!exactly(disposal, 1)) return { ok: false, detail: `expected 1 'this.uid = null;' disposal statement, found ${disposal.length}` }
  return {
    ok: true,
    detail: 'ReflectService.notify loops + Fiber constructor publication/disposal',
  }
}

/** Inner requirements of `settings.patch.cjs`. */
function checkSettingsPanel(sourceFile, ts) {
  const panels = collect(sourceFile, ts, node => ts.isFunctionDeclaration(node) && node.name !== undefined && node.name.text === 'SettingsPanel')
  if (!exactly(panels, 1)) return { ok: false, detail: `expected 1 SettingsPanel declaration, found ${panels.length}` }
  const className = collect(panels[0], ts, node =>
    ts.isPropertyAssignment(node)
    && text(ts, sourceFile, node.name) === 'className'
    && text(ts, sourceFile, node.initializer) === 'SettingsRoot_module_css_default.panel')
  if (!exactly(className, 1)) return { ok: false, detail: `expected 1 panel className assignment, found ${className.length}` }
  const navIcon = collect(sourceFile, ts, node => ts.isFunctionDeclaration(node) && node.name !== undefined && node.name.text === 'navIcon')
  if (!exactly(navIcon, 1) || navIcon[0].body === undefined) return { ok: false, detail: `expected 1 navIcon declaration with a body, found ${navIcon.length}` }
  const close = collect(sourceFile, ts, node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'close')
  if (!exactly(close, 1)) return { ok: false, detail: `expected 1 close declaration, found ${close.length}` }
  const closeCallback = collect(close[0], ts, node => ts.isArrowFunction(node))
  if (!exactly(closeCallback, 1)) return { ok: false, detail: `expected 1 close callback arrow function, found ${closeCallback.length}` }
  const onSelect = collect(sourceFile, ts, node =>
    ts.isPropertyAssignment(node)
    && text(ts, sourceFile, node.name) === 'onSelect'
    && text(ts, sourceFile, node.initializer) === 'setActiveId')
  if (!exactly(onSelect, 1)) return { ok: false, detail: `expected 1 onSelect: setActiveId property, found ${onSelect.length}` }
  return { ok: true, detail: 'SettingsPanel/navIcon/close/onSelect seams' }
}

/** Inner requirements of `session-profile.patch.cjs`. */
function checkSessionOpen(sourceFile, ts) {
  const opens = collect(sourceFile, ts, node =>
    ts.isMethodDeclaration(node)
    && text(ts, sourceFile, node.name) === 'open'
    && node.body !== undefined
    && text(ts, sourceFile, node.body).includes('this.doOpen(this.openGeneration)'))
  if (!exactly(opens, 1)) return { ok: false, detail: `expected 1 Session.open declaration, found ${opens.length}` }
  const calls = collect(opens[0], ts, node =>
    ts.isCallExpression(node) && text(ts, sourceFile, node) === 'this.doOpen(this.openGeneration)')
  if (!exactly(calls, 1)) return { ok: false, detail: `expected 1 Session.doOpen call, found ${calls.length}` }
  return { ok: true, detail: 'Session.open -> this.doOpen(this.openGeneration)' }
}

const SYSTEMS = {
  'client-package-resolution': (sourceFile, ts, node) => checkClientPackageResolution(sourceFile, ts, node),
  'function-body': (sourceFile, ts, node) => checkFunctionBody(sourceFile, ts, node),
  'cordis-service-index': (sourceFile, ts) => checkCordisServiceIndex(sourceFile, ts),
  'settings-panel': (sourceFile, ts) => checkSettingsPanel(sourceFile, ts),
  'session-open': (sourceFile, ts) => checkSessionOpen(sourceFile, ts),
}

/**
 * Minimal semver satisfaction check covering the comparator shapes the vendored
 * builtins declare (`A || B`, `>=x.y.z-pre`, `<x.y.z-0`, `<=x.y.z`). It mirrors
 * `semver.satisfies(version, range, { includePrerelease: true })` — the exact call
 * harmony makes (`lib/runtime.js:1116`), so the tuple-restricted pre-release rule
 * of the default mode deliberately does NOT apply. Cross-checked against
 * `semver@7.8.5` over 105 (version, range) pairs including all four pinned ranges:
 * 105/105 agree after that correction (facts §76). Any shape outside this subset is
 * reported as `unknown` rather than guessed.
 */
export function satisfiesRange(version, range) {
  const parse = value => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value)
    if (match === null) return undefined
    return { major: +match[1], minor: +match[2], patch: +match[3], pre: match[4] === undefined ? [] : match[4].split('.') }
  }
  const compare = (left, right) => {
    for (const field of ['major', 'minor', 'patch']) {
      if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1
    }
    if (left.pre.length === 0 && right.pre.length === 0) return 0
    if (left.pre.length === 0) return 1
    if (right.pre.length === 0) return -1
    for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
      const a = left.pre[index]
      const b = right.pre[index]
      if (a === undefined) return -1
      if (b === undefined) return 1
      const numeric = /^\d+$/u
      if (numeric.test(a) && numeric.test(b)) {
        if (+a !== +b) return +a < +b ? -1 : 1
        continue
      }
      if (numeric.test(a)) return -1
      if (numeric.test(b)) return 1
      if (a !== b) return a < b ? -1 : 1
    }
    return 0
  }
  const target = parse(version)
  if (target === undefined) return 'unknown'
  let evaluated = false
  for (const set of range.split('||').map(part => part.trim())) {
    const comparators = set.split(/\s+/u).filter(part => part.length > 0)
    let matches = true
    for (const comparator of comparators) {
      const match = /^(>=|<=|>|<)?\s*(.+)$/u.exec(comparator)
      if (match === null) return 'unknown'
      const bound = parse(match[2])
      if (bound === undefined) return 'unknown'
      const order = compare(target, bound)
      const operator = match[1] ?? '='
      if (operator === '>=') matches = matches && order >= 0
      else if (operator === '<=') matches = matches && order <= 0
      else if (operator === '>') matches = matches && order > 0
      else if (operator === '<') matches = matches && order < 0
      else matches = matches && order === 0
    }
    evaluated = true
    if (matches) return true
  }
  return evaluated ? false : 'unknown'
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Evaluate every builtin seam against the pinned build. Throws when one fails. */
export function assertSeams() {
  const harnessRoot = findHarnessRoot()
  const ts = loadCompiler(harnessRoot)
  const engine = createSelectorEngine(ts)
  const results = []
  const ranges = []
  const failures = []

  for (const builtin of BUILTIN_SEAMS) {
    const builtinPath = resolve(packageRoot, builtin.builtin)
    if (!existsSync(builtinPath)) {
      failures.push(`${builtin.id}: builtin module is not built: ${builtin.builtin}`)
      continue
    }
    const target = locateTarget(harnessRoot, builtin)
    const sourceFile = ts.createSourceFile(target.file, readFileSync(target.file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const parts = []
    for (const part of builtin.parts) {
      let matched = []
      try {
        matched = engine.query(sourceFile, part.select)
        if (matched.length !== part.expect) {
          failures.push(`${builtin.id}/${part.id}: selector matched ${matched.length}, expected ${part.expect}`)
          parts.push({ id: part.id, ok: false, found: matched.length, expect: part.expect, detail: `selector matched ${matched.length}` })
          continue
        }
        const verdict = SYSTEMS[part.check](sourceFile, ts, matched[0])
        if (!verdict.ok) failures.push(`${builtin.id}/${part.id}: ${verdict.detail}`)
        parts.push({ id: part.id, ok: verdict.ok, found: matched.length, expect: part.expect, detail: verdict.detail })
      } catch (cause) {
        failures.push(`${builtin.id}/${part.id}: ${cause.message}`)
        parts.push({ id: part.id, ok: false, found: matched.length, expect: part.expect, detail: cause.message })
      }
    }
    ranges.push({
      id: builtin.id,
      target: `${target.name}@${target.version}`,
      declared: builtin.declaredRange,
      site: builtin.rangeSite,
      satisfied: satisfiesRange(target.version, builtin.declaredRange),
    })
    results.push({
      id: builtin.id,
      builtin: builtin.builtin,
      target: target.name,
      file: target.file,
      fileSha256: sha256(target.file),
      parts,
    })
  }

  const report = { harnessRoot, builtins: results, ranges, dependencies: LOAD_DEPENDENCIES }
  if (failures.length > 0) {
    const error = new Error(`harmony seams failed against the pinned 0.1.5 build:\n  - ${failures.join('\n  - ')}`)
    error.report = report
    throw error
  }
  return report
}

export function formatReport(report) {
  const rows = [`harmony seams vs the pinned 0.1.5 build (${report.harnessRoot})`]
  for (const builtin of report.builtins) {
    rows.push(`  ${builtin.builtin}  → ${builtin.target}  sha256 ${builtin.fileSha256.slice(0, 16)}`)
    rows.push(`    build: ${builtin.file}`)
    for (const part of builtin.parts) {
      rows.push(`    ${part.ok ? 'OK  ' : 'FAIL'} ${part.id.padEnd(28)} ${part.found}/${part.expect}  ${part.detail}`)
    }
  }
  rows.push('  declared target ranges (harmony treats a mismatch as a status warning, not a gate):')
  for (const range of report.ranges) {
    const state = range.satisfied === true ? 'satisfied' : range.satisfied === false ? 'NOT satisfied' : 'unknown'
    rows.push(`    ${range.id.padEnd(22)} ${range.target.padEnd(46)} ${state}  [${range.declared}]`)
  }
  return rows.join('\n')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${formatReport(assertSeams())}\n`)
  } catch (cause) {
    if (cause.report !== undefined) process.stdout.write(`${formatReport(cause.report)}\n`)
    process.stderr.write(`${cause.message}\n`)
    process.exitCode = 1
  }
}
