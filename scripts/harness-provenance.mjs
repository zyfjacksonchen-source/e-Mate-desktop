#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pinnedPnpmInvocation } from './package-manager.mjs'
import { adaptHarnessConversationSource, CONVERSATION_ADAPTER_PATH, CONVERSATION_PACKAGE } from './harness-conversation-adapter.mjs'
import { adaptHarnessSessionExportSource, SESSION_EXPORT_ADAPTER_PATH, SESSION_EXPORT_PACKAGE } from './harness-session-export-adapter.mjs'
import { adaptHarnessFsBytesSource, FS_BYTES_ADAPTER_PATH, FS_BYTES_PACKAGE } from './harness-fs-bytes-adapter.mjs'

export const HARNESS_COMMIT = '4da69d7c3522ee51de12822c917c503a124f7a7d'
export const HARNESS_VERSION = '0.1.0-rc.7'

const NATIVE_MODEL_REFRESH = 'ctx.remote.$on("credentials/updated", refresh);'
const BUILD_RECEIPT = '.release-cache/harness-build.json'
const DESKTOP_RECEIPT = 'desktop/e-mate-desktop/build/harness-runtime-provenance.json'
export const DESKTOP_OVERLAYS = new Map([
  ['@deepseek-ai/dsh-app-boot', 'desktop/patches/dsh-app-boot@0.1.0-rc.7.patch'],
  ['@deepseek-ai/dsh-client-ui-workspace', 'desktop/patches/dsh-client-ui-workspace@0.1.0-rc.7.patch'],
  ['@deepseek-ai/dsh-sandbox-windows-acl', 'desktop/patches/dsh-sandbox-windows-acl@0.1.0-rc.7.patch'],
  ['@deepseek-ai/dsh-tool-fs', 'desktop/.yarn/patches/@deepseek-ai-dsh-tool-fs-npm-0.1.0-rc.7-redundant-escalation.patch'],
])

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function sortedEntries(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareText(left.name, right.name))
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout.trim()
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function regularFiles(root, directory = root) {
  const files = []
  for (const entry of sortedEntries(directory)) {
    const path = join(directory, entry.name)
    const metadata = lstatSync(path)
    if (metadata.isSymbolicLink()) throw new Error(`Harness emitted lib contains a symlink: ${relative(root, path)}`)
    if (metadata.isDirectory()) files.push(...regularFiles(root, path))
    else if (metadata.isFile()) files.push(path)
    else throw new Error(`Harness emitted lib entry is not a regular file: ${relative(root, path)}`)
  }
  return files
}

export function hashDirectory(directory) {
  const digest = createHash('sha256').update('e-mate-harness-directory-v1\0')
  for (const path of regularFiles(directory)) {
    const local = relative(directory, path).split(sep).join('/')
    const bytes = readFileSync(path)
    digest.update(`${local}\0${String(bytes.byteLength)}\0`)
    digest.update(bytes)
  }
  return digest.digest('hex')
}

function packageMap(harnessRoot) {
  const packages = new Map()
  function visit(directory) {
    for (const entry of sortedEntries(directory)) {
      if (!entry.isDirectory() || ['.git', 'lib', 'node_modules'].includes(entry.name)) continue
      const path = join(directory, entry.name)
      const manifestPath = join(path, 'package.json')
      if (existsSync(manifestPath)) {
        const manifest = readJson(manifestPath)
        if (typeof manifest.name === 'string' && manifest.name.startsWith('@deepseek-ai/dsh')) {
          if (packages.has(manifest.name)) throw new Error(`Harness package is declared twice: ${manifest.name}`)
          packages.set(manifest.name, { path, manifest })
        }
      }
      visit(path)
    }
  }
  for (const root of ['apps', 'packages']) visit(join(harnessRoot, root))
  return packages
}

function packageRecords(harnessRoot) {
  return [...packageMap(harnessRoot)].map(([name, value]) => {
    const lib = join(value.path, 'lib')
    if (!existsSync(lib)) throw new Error(`pinned Harness build is missing emitted lib for ${name}`)
    if (value.manifest.version !== HARNESS_VERSION) {
      throw new Error(`${name} version drifted: ${String(value.manifest.version)}`)
    }
    return {
      name,
      source: relative(harnessRoot, value.path).split(sep).join('/'),
      lib_sha256: hashDirectory(lib),
    }
  }).sort((left, right) => compareText(left.name, right.name))
}

function packageDirectories(nodeModules) {
  const packages = []
  for (const entry of sortedEntries(nodeModules)) {
    if (entry.name.startsWith('.')) continue
    const path = join(nodeModules, entry.name)
    if (!entry.name.startsWith('@')) {
      if (entry.isDirectory() || entry.isSymbolicLink()) packages.push(path)
      continue
    }
    if (entry.isSymbolicLink()) {
      if (entry.name === '@deepseek-ai') throw new Error('Desktop @deepseek-ai scope must not be a symlink')
      continue
    }
    if (!entry.isDirectory()) continue
    for (const scoped of sortedEntries(path)) {
      if (scoped.isDirectory() || scoped.isSymbolicLink()) packages.push(join(path, scoped.name))
    }
  }
  return packages
}

/** Find every physical DSH package that Node can resolve from the Desktop closure. */
export function findDesktopHarnessPackages(nodeModules) {
  const packages = []
  const visited = new Set()
  function visit(directory) {
    if (!existsSync(directory) || visited.has(directory)) return
    visited.add(directory)
    for (const path of packageDirectories(directory)) {
      const manifestPath = join(path, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = readJson(manifestPath)
      const metadata = lstatSync(path)
      if (typeof manifest.name === 'string' && manifest.name.startsWith('@deepseek-ai/dsh')) {
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error(`Desktop Harness package is not a physical directory: ${manifest.name}`)
        }
        packages.push({ path, manifest })
      }
      if (metadata.isDirectory()) visit(join(path, 'node_modules'))
    }
  }
  visit(nodeModules)
  return packages.sort((left, right) => compareText(left.path, right.path))
}

export function assertHarnessSourceClean(harnessRoot) {
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: harnessRoot })
  if (status !== '') throw new Error('pinned Harness source must be clean before building Base artifacts')
}

export function assertHarnessSource(root) {
  const harnessRoot = join(root, 'upstream', 'deepseek-harness')
  const gitlink = run('git', ['ls-files', '-s', '--', 'upstream/deepseek-harness'], { cwd: root })
  if (gitlink !== `160000 ${HARNESS_COMMIT} 0\tupstream/deepseek-harness`) {
    throw new Error('pinned Harness gitlink does not match the accepted commit')
  }
  assertHarnessSourceClean(harnessRoot)
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: harnessRoot })
  const version = readJson(join(harnessRoot, 'apps', 'cli', 'package.json')).version
  if (commit !== HARNESS_COMMIT || version !== HARNESS_VERSION) {
    throw new Error(`pinned Harness drifted (version=${String(version)}, commit=${commit})`)
  }
  const listener = readFileSync(join(harnessRoot, 'packages', 'client', 'ui-model-selection', 'src', 'client', 'service.ts'), 'utf8')
  assertExactOccurrence(listener, "ctx.remote.$on('credentials/updated', refresh)", 'native model-directory refresh listener')
  return harnessRoot
}

export function assertExactOccurrence(source, seam, label) {
  const occurrences = source.split(seam).length - 1
  if (occurrences !== 1) throw new Error(`${label} expected once, found ${occurrences}`)
}

export function writeHarnessBuildReceipt(root) {
  const harnessRoot = assertHarnessSource(root)
  const receipt = {
    schema_version: 1,
    harness_commit: HARNESS_COMMIT,
    harness_version: HARNESS_VERSION,
    pnpm_lock_sha256: sha256(readFileSync(join(harnessRoot, 'pnpm-lock.yaml'))),
    packages: packageRecords(harnessRoot),
  }
  const path = join(root, BUILD_RECEIPT)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`)
  return receipt
}

export function verifyHarnessBuildReceipt(root) {
  const harnessRoot = assertHarnessSource(root)
  const path = join(root, BUILD_RECEIPT)
  if (!existsSync(path)) throw new Error('pinned Harness build receipt is missing; run pnpm build:harness')
  const actual = readJson(path)
  const expected = {
    schema_version: 1,
    harness_commit: HARNESS_COMMIT,
    harness_version: HARNESS_VERSION,
    pnpm_lock_sha256: sha256(readFileSync(join(harnessRoot, 'pnpm-lock.yaml'))),
    packages: packageRecords(harnessRoot),
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('pinned Harness emitted libs do not match their clean-source build receipt')
  }
  return actual
}

function assertOverlayContract(root) {
  const resolutions = readJson(join(root, 'desktop', 'package.json')).resolutions ?? {}
  const resolved = new Set()
  for (const [selector, value] of Object.entries(resolutions)) {
    if (typeof value !== 'string' || !value.startsWith('patch:@deepseek-ai/dsh')) continue
    const name = selector.replace(/@npm:.*$/u, '')
    const patch = DESKTOP_OVERLAYS.get(name)
    const marker = patch?.startsWith('desktop/.yarn/')
      ? `#~/.yarn/${patch.slice('desktop/.yarn/'.length)}`
      : patch === undefined ? '' : `#./${patch.slice('desktop/'.length)}`
    if (patch === undefined || !value.includes(marker)) {
      throw new Error(`Desktop Harness overlay is not admitted: ${selector}`)
    }
    resolved.add(name)
  }
  for (const [name, patch] of DESKTOP_OVERLAYS) {
    if (!resolved.has(name)) throw new Error(`Desktop Harness overlay must have an admitted tracked resolution: ${name}`)
    if (!existsSync(join(root, patch))) throw new Error(`Desktop Harness overlay is missing: ${patch}`)
  }
  if (Object.entries(resolutions).some(([selector, value]) => selector.startsWith('@deepseek-ai/dsh-session') && String(value).startsWith('patch:'))) {
    throw new Error('Desktop must consume native Harness Session packages without overlays')
  }
  if (Object.entries(resolutions).some(([selector, value]) => selector.startsWith('@deepseek-ai/dsh-client-ui-model-selection@npm:') && String(value).startsWith('patch:'))) {
    throw new Error('Desktop must consume the native Harness model-directory implementation without an overlay')
  }
}

export function materializeHarnessDesktopRuntime(root) {
  const receipt = verifyHarnessBuildReceipt(root)
  assertOverlayContract(root)
  const harnessRoot = join(root, 'upstream', 'deepseek-harness')
  const desktopPackages = join(root, 'desktop', 'e-mate-desktop', 'node_modules', '@deepseek-ai')
  const desktopNodeModules = join(root, 'desktop', 'e-mate-desktop', 'node_modules')
  if (!existsSync(desktopPackages)) throw new Error('Desktop Yarn closure is missing; run yarn install first')
  const sources = packageMap(harnessRoot)
  for (const { path: target, manifest } of findDesktopHarnessPackages(desktopNodeModules)) {
    const source = sources.get(manifest.name)
    if (source === undefined || manifest.version !== HARNESS_VERSION) {
      throw new Error(`Desktop resolved package is outside the pinned Harness closure: ${String(manifest.name)}@${String(manifest.version)}`)
    }
    const sourceLib = join(source.path, 'lib')
    const targetLib = join(target, 'lib')
    if (!existsSync(sourceLib)) throw new Error(`pinned Harness build is missing emitted lib for ${manifest.name}`)
    rmSync(targetLib, { recursive: true, force: true })
    cpSync(sourceLib, targetLib, { recursive: true, errorOnExist: true })
    if (manifest.name === CONVERSATION_PACKAGE) {
      const client = join(targetLib, 'client.js')
      writeFileSync(client, adaptHarnessConversationSource(readFileSync(client, 'utf8')))
    }
    if (manifest.name === SESSION_EXPORT_PACKAGE) {
      const entry = join(targetLib, 'index.js')
      writeFileSync(entry, adaptHarnessSessionExportSource(readFileSync(entry, 'utf8')))
    }
    if (manifest.name === FS_BYTES_PACKAGE) {
      const entry = join(targetLib, 'index.js')
      writeFileSync(entry, adaptHarnessFsBytesSource(readFileSync(entry, 'utf8')))
    }
    const overlay = DESKTOP_OVERLAYS.get(manifest.name)
    if (overlay !== undefined) {
      const targetDirectory = relative(root, target).split(sep).join('/')
      run('git', ['apply', '--unidiff-zero', '--whitespace=nowarn', `--directory=${targetDirectory}`, overlay], { cwd: root })
    }
  }
  const provenance = desktopProvenance(root, receipt)
  const path = join(root, DESKTOP_RECEIPT)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(provenance, null, 2)}\n`)
  return provenance
}

function desktopProvenance(root, receipt) {
  const harnessRoot = join(root, 'upstream', 'deepseek-harness')
  const desktopNodeModules = join(root, 'desktop', 'e-mate-desktop', 'node_modules')
  const sources = packageMap(harnessRoot)
  const packages = []
  const targets = findDesktopHarnessPackages(desktopNodeModules)
  for (const { path: target, manifest } of targets) {
    const source = sources.get(manifest.name)
    if (source === undefined || manifest.version !== HARNESS_VERSION) {
      throw new Error(`Desktop resolved package is outside the pinned Harness closure: ${String(manifest.name)}@${String(manifest.version)}`)
    }
    const sourceLib = join(source.path, 'lib')
    const targetLib = join(target, 'lib')
    if (!existsSync(sourceLib) || !existsSync(targetLib)) throw new Error(`Desktop Harness lib is missing: ${manifest.name}`)
    const overlay = DESKTOP_OVERLAYS.get(manifest.name)
    const adapter = manifest.name === CONVERSATION_PACKAGE ? CONVERSATION_ADAPTER_PATH
      : manifest.name === SESSION_EXPORT_PACKAGE ? SESSION_EXPORT_ADAPTER_PATH
        : manifest.name === FS_BYTES_PACKAGE ? FS_BYTES_ADAPTER_PATH : null
    if (manifest.name === CONVERSATION_PACKAGE && readFileSync(join(targetLib, 'client.js'), 'utf8')
      !== adaptHarnessConversationSource(readFileSync(join(sourceLib, 'client.js'), 'utf8'))) {
      throw new Error('Desktop conversation package does not match the pinned native owner plus product adapter')
    }
    if (manifest.name === SESSION_EXPORT_PACKAGE && readFileSync(join(targetLib, 'index.js'), 'utf8')
      !== adaptHarnessSessionExportSource(readFileSync(join(sourceLib, 'index.js'), 'utf8'))) {
      throw new Error('Desktop session export does not match the pinned native owner plus product adapter')
    }
    if (manifest.name === FS_BYTES_PACKAGE && readFileSync(join(targetLib, 'index.js'), 'utf8')
      !== adaptHarnessFsBytesSource(readFileSync(join(sourceLib, 'index.js'), 'utf8'))) {
      throw new Error('Desktop binary reads do not match the pinned native owner plus product adapter')
    }
    packages.push({
      name: manifest.name,
      resolved: relative(root, target).split(sep).join('/'),
      source: relative(harnessRoot, source.path).split(sep).join('/'),
      source_lib_sha256: hashDirectory(sourceLib),
      resolved_lib_sha256: hashDirectory(targetLib),
      adapter: adapter === null ? null : { path: adapter, sha256: sha256(readFileSync(join(root, adapter))) },
      ...(manifest.name === SESSION_EXPORT_PACKAGE ? {
        adapter_inputs: [{
          path: 'packages/dsh-plugin-file-import/src/contract.ts',
          sha256: sha256(readFileSync(join(root, 'packages/dsh-plugin-file-import/src/contract.ts'))),
        }],
      } : {}),
      overlay: overlay === undefined ? null : {
        path: overlay,
        sha256: sha256(readFileSync(join(root, overlay))),
      },
    })
  }
  if (packages.length === 0) throw new Error('Desktop resolved no pinned Harness packages')
  const modelPackages = targets.filter(value => value.manifest.name === '@deepseek-ai/dsh-client-ui-model-selection')
  if (modelPackages.length === 0 || packages.some(value => value.name === '@deepseek-ai/dsh-client-ui-model-selection' && value.overlay !== null)) {
    throw new Error('Desktop native model-directory package is missing or overlaid')
  }
  for (const modelPackage of modelPackages) {
    const modelClient = readFileSync(join(modelPackage.path, 'lib', 'client.js'), 'utf8')
    assertExactOccurrence(modelClient, NATIVE_MODEL_REFRESH, 'Desktop native model-directory refresh listener')
  }
  for (const name of ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-persistence']) {
    const sessionPackages = packages.filter(value => value.name === name)
    if (sessionPackages.length === 0 || sessionPackages.some(value => value.overlay !== null)) {
      throw new Error(`Desktop native Session package is missing or overlaid: ${name}`)
    }
  }
  const receivedOverlays = new Set(packages.flatMap(value => value.overlay === null ? [] : [value.overlay.path]))
  for (const path of DESKTOP_OVERLAYS.values()) {
    if (!receivedOverlays.has(path)) throw new Error(`Desktop Harness overlay was not materialized: ${path}`)
  }
  return {
    schema_version: 1,
    harness_commit: receipt.harness_commit,
    harness_version: receipt.harness_version,
    harness_pnpm_lock_sha256: receipt.pnpm_lock_sha256,
    desktop_yarn_lock_sha256: sha256(readFileSync(join(root, 'desktop', 'yarn.lock'))),
    packages,
  }
}

export function verifyHarnessDesktopRuntime(root) {
  const path = join(root, DESKTOP_RECEIPT)
  if (!existsSync(path)) throw new Error('Desktop Harness provenance is missing; run yarn build:sdk')
  const actual = readJson(path)
  const expected = desktopProvenance(root, verifyHarnessBuildReceipt(root))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Desktop resolved Harness packages do not match the Base SDK emitted libs')
  }
  return actual
}

export function runHarnessBuildScripts(root, pnpmVersion, env = process.env) {
  const commands = [
    // Host tsdown owns the generated remote declarations consumed by the Client graph.
    ['--dir', 'upstream/deepseek-harness', 'run', 'build:lib:host'],
    ['--dir', 'upstream/deepseek-harness', 'exec', 'tsc', '-b', 'tsconfig.client.json'],
    ['--dir', 'upstream/deepseek-harness', 'run', 'build:lib:client'],
    ['--dir', 'upstream/deepseek-harness', '--filter', '@deepseek-ai/dsh-web-frontend', 'run', 'build'],
  ]
  for (const args of commands) {
    const invocation = pinnedPnpmInvocation(pnpmVersion, args, { env })
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: root,
      env: invocation.env,
      stdio: 'inherit',
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) throw new Error(`pinned Harness ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

function build(root) {
  assertHarnessSource(root)
  const packageManager = readJson(join(root, 'package.json')).packageManager
  const pnpmVersion = /^pnpm@([^+]+)$/u.exec(packageManager)?.[1]
  if (pnpmVersion === undefined) throw new Error(`unsupported packageManager: ${String(packageManager)}`)
  runHarnessBuildScripts(root, pnpmVersion)
  writeHarnessBuildReceipt(root)
}

function main() {
  const root = resolve(import.meta.dirname, '..')
  const command = process.argv[2]
  if (command === 'build') build(root)
  else if (command === 'sync-desktop') materializeHarnessDesktopRuntime(root)
  else if (command === 'verify-desktop') verifyHarnessDesktopRuntime(root)
  else throw new Error('command must be build, sync-desktop, or verify-desktop')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (cause) {
    process.stderr.write(`harness provenance: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    process.exitCode = 1
  }
}
