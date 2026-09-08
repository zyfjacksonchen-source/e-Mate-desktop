import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unpackedAsarPath } from './packaged-runtime-path.ts'

export const EMATE_PROFILE_NAME = 'e-mate'

const desktopManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version?: unknown }
export const EMATE_DESKTOP_PROFILE_VERSION = desktopManifest.version
if (typeof EMATE_DESKTOP_PROFILE_VERSION !== 'string'
  || !/^\d+\.\d+\.\d+$/u.test(EMATE_DESKTOP_PROFILE_VERSION)) {
  throw new Error('e-Mate desktop package version must be a stable semantic version')
}
const HARNESS_COMMIT = '4da69d7c3522ee51de12822c917c503a124f7a7d'
const sourceRoot = unpackedAsarPath(
  fileURLToPath(new URL('../build/e-mate-profile/', import.meta.url)),
)
interface ComponentInventoryEntry {
  readonly id: string
  readonly root: string
  readonly desktop: 'bundled-profile' | 'blocked'
  readonly cli: boolean
}
const componentInventory = JSON.parse(
  readFileSync(join(sourceRoot, 'component-inventory.json'), 'utf8'),
) as { schema_version?: unknown; components?: unknown }
if (componentInventory.schema_version !== 1 || !Array.isArray(componentInventory.components)
  || componentInventory.components.some(entry => entry === null || typeof entry !== 'object'
    || typeof (entry as ComponentInventoryEntry).id !== 'string'
    || !['bundled-profile', 'blocked'].includes((entry as ComponentInventoryEntry).desktop))) {
  throw new Error('e-Mate component inventory is invalid')
}
const desktopComponents = componentInventory.components as ComponentInventoryEntry[]
const PLUGIN_PACKAGES = desktopComponents
  .filter(component => component.desktop !== 'blocked' && component.id.startsWith('@e-mate/dsh-plugin-'))
  .map(component => component.id)

/** Components whose complete closure can currently move independently of the Base. */
export const EMATE_BUNDLED_PROFILE_COMPONENT_IDS = [
  ...desktopComponents
    .filter(component => component.desktop !== 'blocked')
    .map(component => component.id),
] as readonly string[]

const ECOSYSTEM_PLUGIN_PACKAGES = [
  { name: '@kelearns/dsh-navigation-bar', version: '0.2.1', entry: 'index.js', client: true, patchName: "'@kelearns/dsh-navigation-bar'" },
  { name: 'dsh-at-file', version: '0.6.2', entry: 'lib/index.js', client: true, patchName: 'dsh-at-file' },
  { name: 'dsh-file-viewer', version: '0.1.0', entry: 'lib/index.js', client: true, patchName: "'dsh-file-viewer'" },
  { name: 'dsh-visualize', version: '0.1.0', entry: 'lib/index.mjs', client: true, patchName: "'dsh-visualize'" },
] as const

const PROFILE_PLUGIN_PACKAGES = [
  ...PLUGIN_PACKAGES,
  ...ECOSYSTEM_PLUGIN_PACKAGES.map(plugin => plugin.name),
]
const MANAGED_PROFILE_PACKAGES = new Set<string>(PROFILE_PLUGIN_PACKAGES)
const RETIRED_PROFILE_PACKAGES = new Set([
  '@e-mate/dsh-plugin-browser',
  '@e-mate/dsh-plugin-browser-panel',
  '@e-mate/dsh-plugin-idesign',
  '@e-mate/dsh-plugin-im',
  '@e-mate/dsh-plugin-search-mcp',
  '@e-mate/dsh-plugin-subagent',
  '@e-mate/dsh-plugin-xin-assistant',
  '@omdsh-dev/dsh-genui',
  '@yuxianglin/dsh-bridge-browser',
  'dsh-better-sidebar',
  'dsh-search-mcp',
  'dsh-turn-fold',
])
const OWNED_PROFILE_PACKAGES = new Set([...MANAGED_PROFILE_PACKAGES, ...RETIRED_PROFILE_PACKAGES])
const PROFILE_INSTALL_RECEIPT = '.e-mate-install.json'
const COMPONENT_STORE_METADATA = new Set(['.e-mate-component.json', '.e-mate-component-manifest.json'])
const WINDOWS_MANAGED_PACKAGE_LAYOUT = 'win32-materialized-v1'
const LINKED_MANAGED_PACKAGE_LAYOUT = 'linked-v1'
const MANAGED_PACKAGE_NEXT_SUFFIX = '.e-mate-next'
const MANAGED_PACKAGE_STALE_SUFFIX = '.e-mate-stale'
export const EMATE_MANAGED_PROFILE_CLEANUP_MAX_ATTEMPTS = 3

const DEFAULT_SETTINGS = 'ui-theme:\n  preference: dark\nagent-default-model:\n  provider: e-mate-enterprise\n  model: gpt-5.6-luna\n  reasoningEffort: max\n'
const DEFAULT_MODEL_SETTINGS = 'agent-default-model:\n  provider: e-mate-enterprise\n  model: gpt-5.6-luna\n  reasoningEffort: max\n'

function atomicWrite(path: string, content: string | NodeJS.ArrayBufferView, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, content, { mode })
    renameSync(temporary, path)
    chmodSync(path, mode)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sha256Bytes(bytes: string | NodeJS.ArrayBufferView): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function bundledComponentSource(id: string): string {
  return id === '@e-mate/dsh-client-shell'
    ? join(sourceRoot, 'plugins', 'emate-shell')
    : join(sourceRoot, 'bundles', id.slice('@e-mate/dsh-plugin-'.length))
}

/** Exact component roots whose declared imports may resolve through the Base ABI. */
export function emateProfileComponentSources(): readonly string[] {
  return EMATE_BUNDLED_PROFILE_COMPONENT_IDS.map(bundledComponentSource)
}

function packageVersion(source: string, expectedName: string): string {
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as {
    name?: unknown
    version?: unknown
  }
  if (manifest.name !== expectedName || typeof manifest.version !== 'string'
    || !/^\d+\.\d+\.\d+$/u.test(manifest.version)) {
    throw new Error(`${expectedName} component package identity is invalid`)
  }
  return manifest.version
}

function packageEntry(name: string): string {
  return createRequire(import.meta.url).resolve(name)
}

function dependencyEntry(packageManifest: string, name: string): string {
  return createRequire(packageManifest).resolve(name)
}

function emptyPatch(patch: string): boolean {
  return patch.split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
    .join('\n') === '[]'
}

function samePath(left: string, right: string): boolean {
  const normalized = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
  return normalized(realpathSync(left)) === normalized(realpathSync(right))
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw cause
  }
}

function managedPackageLayout(): string {
  return process.platform === 'win32' ? WINDOWS_MANAGED_PACKAGE_LAYOUT : LINKED_MANAGED_PACKAGE_LAYOUT
}

function portablePath(path: string): string {
  return path.split(sep).join('/')
}

function packageRelativePath(source: string, value: string): string {
  if (isAbsolute(value)) throw new Error('managed package entry must be relative')
  const local = relative(resolve(source), resolve(source, value))
  if (local === '' || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error('managed package entry escapes its package root')
  }
  return portablePath(local)
}

function declaredExportPaths(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(declaredExportPaths)
  if (value !== null && typeof value === 'object') {
    // Type declarations are development-only and excluded by electron-builder.
    return Object.entries(value as Record<string, unknown>)
      .filter(([condition]) => condition !== 'types' && !condition.startsWith('types@'))
      .flatMap(([, entry]) => declaredExportPaths(entry))
  }
  return []
}

function managedPackageCriticalEntries(source: string): ReadonlySet<string> {
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as {
    main?: unknown
    exports?: Record<string, unknown>
    dsh?: { bundle?: { patch?: unknown }; client?: unknown }
  }
  const mainEntries = typeof manifest.main === 'string'
    ? [manifest.main]
    : declaredExportPaths(manifest.exports?.['.'])
  if (mainEntries.length === 0) throw new Error('managed package has no main entry')
  const entries = ['package.json', ...mainEntries]
  if (manifest.dsh?.client !== undefined) {
    const clients = declaredExportPaths(manifest.exports?.['./client'])
    if (clients.length === 0) throw new Error('managed client package has no client export')
    entries.push(...clients)
  }
  if (manifest.dsh?.bundle?.patch !== undefined) {
    if (typeof manifest.dsh.bundle.patch !== 'string') throw new Error('managed package patch entry is invalid')
    entries.push(manifest.dsh.bundle.patch)
  }
  return new Set(entries.map(entry => packageRelativePath(source, entry)))
}

function visibleEntries(path: string, componentRoot: boolean): string[] {
  return readdirSync(path)
    .filter(name => !componentRoot || !COMPONENT_STORE_METADATA.has(name))
    .sort()
}

function sameEntries(source: string, target: string, componentRoot: boolean): boolean {
  const expected = visibleEntries(source, componentRoot)
  const actual = visibleEntries(target, false)
  return expected.length === actual.length && expected.every((name, index) => actual[index] === name)
}

function managedFileCurrent(
  source: string,
  target: string,
  entry: string,
  overrides: ReadonlyMap<string, string>,
): boolean {
  const parts = entry.split('/')
  if (process.platform === 'win32') {
    let current = target
    for (const part of parts.slice(0, -1)) {
      current = join(current, part)
      const metadata = lstatSync(current)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false
    }
  }
  const from = join(source, ...parts)
  const to = join(target, ...parts)
  return managedFileContentCurrent(from, to, overrides.get(entry))
}

function managedFileContentCurrent(from: string, to: string, override: string | undefined): boolean {
  const targetMetadata = lstatSync(to)
  if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) return false
  if (override !== undefined) return sha256Bytes(override) === sha256(to)
  const sourceMetadata = statSync(from)
  return sourceMetadata.isFile() && sourceMetadata.size === targetMetadata.size && sha256(from) === sha256(to)
}

function materializedDirectoryCurrent(
  source: string,
  target: string,
  overrides: ReadonlyMap<string, string>,
  prefix = '',
): boolean {
  if (!sameEntries(source, target, prefix === '')) return false
  return readdirSync(source, { withFileTypes: true })
    .filter(entry => prefix !== '' || !COMPONENT_STORE_METADATA.has(entry.name))
    .every(entry => {
      const from = join(source, entry.name)
      const to = join(target, entry.name)
      const targetMetadata = lstatSync(to)
      if (targetMetadata.isSymbolicLink()) return false
      const local = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        return targetMetadata.isDirectory()
          && materializedDirectoryCurrent(from, to, overrides, local)
      }
      // The recursive walk has already checked every parent as a real directory.
      // Critical-entry checks outside this walk still validate their entire ancestry.
      return entry.isFile() && managedFileContentCurrent(from, to, overrides.get(local))
    })
}

function managedPackageFullyCurrent(
  source: string,
  target: string,
  overrides: ReadonlyMap<string, string> = new Map(),
): boolean {
  try {
    const targetRoot = lstatSync(target)
    if (!targetRoot.isDirectory() || targetRoot.isSymbolicLink()) return false
    if (process.platform === 'win32') return materializedDirectoryCurrent(source, target, overrides)
    if (!sameEntries(source, target, true)) return false
    return readdirSync(source, { withFileTypes: true })
      .filter(entry => !COMPONENT_STORE_METADATA.has(entry.name))
      .every(entry => {
        const from = join(source, entry.name)
        const to = join(target, entry.name)
        const targetMetadata = lstatSync(to)
        if (entry.isDirectory()) return targetMetadata.isSymbolicLink() && samePath(from, to)
        return entry.isFile() && managedFileCurrent(source, target, entry.name, overrides)
      })
  } catch {
    return false
  }
}

function managedPackageTransactionPaths(target: string): { readonly candidate: string; readonly stale: string } {
  return {
    candidate: `${target}${MANAGED_PACKAGE_NEXT_SUFFIX}`,
    stale: `${target}${MANAGED_PACKAGE_STALE_SUFFIX}`,
  }
}

function removeWithoutFollowing(path: string): void {
  if (!pathExists(path)) return
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) unlinkSync(path)
  else rmSync(path, { recursive: true, force: true })
}

/** Keep package metadata patchable while loading large immutable directories from the app bundle. */
function installManagedPackage(
  source: string,
  target: string,
  overrides: ReadonlyMap<string, string> = new Map(),
  deferCleanup?: (path: string) => void,
  reuseInstalledGeneration = false,
): void {
  // A repair in the same installed generation uses the native warm checks for
  // unaffected packages. New or damaged packages still require full validation.
  if (reuseInstalledGeneration && managedPackageCurrent(source, target, overrides)) return
  if (managedPackageFullyCurrent(source, target, overrides)) return
  const { candidate, stale } = managedPackageTransactionPaths(target)
  if (pathExists(candidate) || pathExists(stale)) {
    throw new Error('managed package transaction recovery is incomplete')
  }
  let movedPrevious = false
  let activatedCandidate = false
  try {
    mkdirSync(candidate, { recursive: true })
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (COMPONENT_STORE_METADATA.has(entry.name)) continue
      const from = join(source, entry.name)
      const to = join(candidate, entry.name)
      if (entry.isDirectory()) {
        if (process.platform === 'win32') cpSync(from, to, { recursive: true, force: true, dereference: true })
        else symlinkSync(resolve(from), to, 'dir')
      } else {
        const override = overrides.get(entry.name)
        if (override === undefined) cpSync(from, to, { force: true })
        else writeFileSync(to, override)
      }
    }
    if (!managedPackageFullyCurrent(source, candidate, overrides)) {
      throw new Error('managed package materialization is incomplete')
    }
    if (pathExists(target)) {
      renameSync(target, stale)
      movedPrevious = true
    }
    renameSync(candidate, target)
    activatedCandidate = true
    if (movedPrevious) {
      if (deferCleanup === undefined) removeWithoutFollowing(stale)
      else deferCleanup(stale)
    }
  } catch (cause) {
    removeWithoutFollowing(candidate)
    if (activatedCandidate) removeWithoutFollowing(target)
    if (movedPrevious && !pathExists(target)) renameSync(stale, target)
    throw cause
  }
}

function managedPackageCurrent(
  source: string,
  target: string,
  overrides: ReadonlyMap<string, string> = new Map(),
): boolean {
  try {
    const targetRoot = lstatSync(target)
    if (!targetRoot.isDirectory() || targetRoot.isSymbolicLink() || !sameEntries(source, target, true)) return false
    const criticalEntries = managedPackageCriticalEntries(source)
    const rootsCurrent = readdirSync(source, { withFileTypes: true })
      .filter(entry => !COMPONENT_STORE_METADATA.has(entry.name))
      .every(entry => {
        const from = join(source, entry.name)
        const to = join(target, entry.name)
        const targetMetadata = lstatSync(to)
        if (entry.isDirectory()) {
          return process.platform === 'win32'
            ? targetMetadata.isDirectory() && !targetMetadata.isSymbolicLink()
            : targetMetadata.isSymbolicLink() && samePath(from, to)
        }
        if (!entry.isFile() || !targetMetadata.isFile() || targetMetadata.isSymbolicLink()) return false
        const override = overrides.get(entry.name)
        return targetMetadata.size === (override === undefined ? statSync(from).size : Buffer.byteLength(override))
      })
    return rootsCurrent && [...criticalEntries].every(entry => managedFileCurrent(source, target, entry, overrides))
  } catch {
    return false
  }
}

function managedPackageTargets(profile: string): readonly string[] {
  return [
    join(profile, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar'),
    ...PLUGIN_PACKAGES.map(name => join(profile, 'node_modules', ...name.split('/'))),
    ...ECOSYSTEM_PLUGIN_PACKAGES.map(plugin => join(profile, 'node_modules', plugin.name)),
  ]
}

function managedCleanupArtifacts(profile: string): readonly string[] {
  return managedPackageTargets(profile).flatMap(target => {
    const transaction = managedPackageTransactionPaths(target)
    return [transaction.candidate, transaction.stale]
  })
}

function normalizedPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function managedCleanupArtifact(profile: string, path: string): string {
  const requested = normalizedPath(path)
  const artifact = managedCleanupArtifacts(profile).find(candidate => normalizedPath(candidate) === requested)
  if (artifact === undefined) throw new Error('managed profile cleanup path is outside the owned package transaction set')
  return resolve(artifact)
}

function managedCleanupKey(profile: string, path: string): string {
  return portablePath(relative(resolve(profile), resolve(path)))
}

function readProfileInstallReceipt(profile: string): Record<string, unknown> {
  const receipt = JSON.parse(readFileSync(join(profile, PROFILE_INSTALL_RECEIPT), 'utf8')) as Record<string, unknown>
  if (receipt.schema_version !== 2 || receipt.version !== EMATE_DESKTOP_PROFILE_VERSION
    || receipt.harness_commit !== HARNESS_COMMIT) {
    throw new Error('managed profile cleanup receipt identity is invalid')
  }
  return receipt
}

function managedCleanupAttempt(receipt: Record<string, unknown>, key: string): number {
  const attempts = receipt.cleanup_attempts
  if (attempts === undefined) return 0
  if (attempts === null || typeof attempts !== 'object' || Array.isArray(attempts)) {
    return EMATE_MANAGED_PROFILE_CLEANUP_MAX_ATTEMPTS
  }
  const value = (attempts as Record<string, unknown>)[key]
  if (value === undefined) return 0
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Math.min(Number(value), EMATE_MANAGED_PROFILE_CLEANUP_MAX_ATTEMPTS)
    : EMATE_MANAGED_PROFILE_CLEANUP_MAX_ATTEMPTS
}

function writeManagedCleanupAttempt(profile: string, key: string, value?: number): void {
  const receipt = readProfileInstallReceipt(profile)
  const allowed = new Set(managedCleanupArtifacts(profile).map(path => managedCleanupKey(profile, path)))
  if (!allowed.has(key)) throw new Error('managed profile cleanup key is outside the owned package transaction set')
  const current = receipt.cleanup_attempts
  const attempts = Object.fromEntries(current !== null && typeof current === 'object' && !Array.isArray(current)
    ? Object.entries(current as Record<string, unknown>).filter(([candidate, attempt]) => (
        allowed.has(candidate) && Number.isSafeInteger(attempt) && Number(attempt) > 0
        && Number(attempt) <= EMATE_MANAGED_PROFILE_CLEANUP_MAX_ATTEMPTS
      ))
    : []) as Record<string, number>
  if (value === undefined || value === 0) delete attempts[key]
  else attempts[key] = Math.min(value, EMATE_MANAGED_PROFILE_CLEANUP_MAX_ATTEMPTS)
  if (Object.keys(attempts).length === 0) delete receipt.cleanup_attempts
  else receipt.cleanup_attempts = attempts
  atomicWrite(join(profile, PROFILE_INSTALL_RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`, 0o600)
}

function recoverManagedPackageTransactions(profile: string): void {
  for (const target of managedPackageTargets(profile)) {
    const { candidate, stale } = managedPackageTransactionPaths(target)
    removeWithoutFollowing(candidate)
    if (!pathExists(stale)) continue
    const staleMetadata = lstatSync(stale)
    if (!staleMetadata.isDirectory() || staleMetadata.isSymbolicLink()) {
      throw new Error('managed package stale transaction is not a physical directory')
    }
    removeWithoutFollowing(target)
    renameSync(stale, target)
  }
}

function deferManagedPackageCleanup(
  profile: string,
  deferCleanup?: (path: string) => void,
): void {
  const receipt = readProfileInstallReceipt(profile)
  for (const path of managedCleanupArtifacts(profile)) {
    if (!pathExists(path)) continue
    const key = managedCleanupKey(profile, path)
    if (managedCleanupAttempt(receipt, key) >= EMATE_MANAGED_PROFILE_CLEANUP_MAX_ATTEMPTS) continue
    if (deferCleanup === undefined) {
      removeWithoutFollowing(path)
      writeManagedCleanupAttempt(profile, key)
    } else {
      deferCleanup(path)
    }
  }
}

/** Delete only a deterministic managed-package sibling and persist a bounded retry after failure. */
export async function cleanupEmateDesktopProfileArtifact(profile: string, path: string): Promise<void> {
  const artifact = managedCleanupArtifact(profile, path)
  const key = managedCleanupKey(profile, artifact)
  const receipt = readProfileInstallReceipt(profile)
  const attempts = managedCleanupAttempt(receipt, key)
  if (attempts >= EMATE_MANAGED_PROFILE_CLEANUP_MAX_ATTEMPTS) {
    throw new Error('managed profile cleanup retry limit is exhausted')
  }
  try {
    if (pathExists(artifact)) {
      const metadata = lstatSync(artifact)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error('managed profile cleanup artifact is not a physical directory')
      }
      await rm(artifact, { recursive: true, force: true })
    }
    writeManagedCleanupAttempt(profile, key)
  } catch (cause) {
    try {
      writeManagedCleanupAttempt(profile, key, attempts + 1)
    } catch (receiptCause) {
      throw new AggregateError([cause, receiptCause], 'managed profile cleanup and retry receipt both failed')
    }
    throw cause
  }
}

interface ManagedBundleManifest {
  readonly main: string
  readonly dsh: { readonly bundle: { readonly patch: string }; readonly client?: { readonly platform?: string } }
}

function adaptedPluginPatch(source: string, name: string): ReadonlyMap<string, string> {
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as ManagedBundleManifest
  if (manifest.dsh.client?.platform === 'web') return new Map()
  const patchName = manifest.dsh.bundle.patch.replace(/^\.\//u, '')
  let patch = readFileSync(join(source, patchName), 'utf8')
  if (emptyPatch(patch)) return new Map()
  const marker = `name: '${name}'`
  if (patch.split(marker).length !== 2) throw new Error(`${name} bundle entry is not uniquely localizable`)
  patch = patch.replace(marker, `name: './node_modules/${name}/${manifest.main}'`)
  return new Map([[patchName, patch]])
}

function adaptedEcosystemPatch(
  source: string,
  expected: (typeof ECOSYSTEM_PLUGIN_PACKAGES)[number],
): ReadonlyMap<string, string> {
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as {
    dsh?: { bundle?: { patch?: string } }
  }
  const declaredPatch = manifest.dsh?.bundle?.patch
  if (typeof declaredPatch !== 'string') throw new Error(`${expected.name} has no bundle patch`)
  const patchName = declaredPatch.replace(/^\.\//u, '')
  const marker = `name: ${expected.patchName}`
  const patch = readFileSync(join(source, patchName), 'utf8')
  if (patch.split(marker).length !== 2) {
    throw new Error(`${expected.name} bundle entry is not uniquely localizable`)
  }
  return new Map([[
    patchName,
    patch.replace(marker, `name: './node_modules/${expected.name}/${expected.entry}'`),
  ]])
}

function installedGenerationCurrent(
  profile: string,
  dshHome: string,
): boolean {
  try {
    const receipt = JSON.parse(readFileSync(join(profile, PROFILE_INSTALL_RECEIPT), 'utf8')) as Record<string, unknown>
    return receipt.schema_version === 2
      && receipt.version === EMATE_DESKTOP_PROFILE_VERSION
      && receipt.harness_commit === HARNESS_COMMIT
      && receipt.dsh_home === resolve(dshHome)
      && receipt.source_root === resolve(sourceRoot)
      && receipt.profile_generation === 'bundled'
      && receipt.managed_package_layout === managedPackageLayout()
  } catch {
    return false
  }
}

function installedProfileCurrent(profile: string, dshHome: string): boolean {
  try {
    if (!installedGenerationCurrent(profile, dshHome)) return false
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>
      dsh?: { profile?: { bundles?: unknown[] } }
    }
    const dependencies = manifest.dependencies ?? {}
    for (const name of PLUGIN_PACKAGES) {
      if (dependencies[name] !== packageVersion(bundledComponentSource(name), name)) return false
    }
    for (const plugin of ECOSYSTEM_PLUGIN_PACKAGES) {
      if (dependencies[plugin.name] !== plugin.version) return false
    }
    for (const name of RETIRED_PROFILE_PACKAGES) {
      if (dependencies[name] !== undefined) return false
    }
    const bundles = manifest.dsh?.profile?.bundles
    const managedBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...PROFILE_PLUGIN_PACKAGES]
    if (!Array.isArray(bundles)
      || managedBundles.some((name, index) => bundles[index] !== name)
      || [...RETIRED_PROFILE_PACKAGES].some(name => bundles.includes(name))) return false

    if (!managedPackageCurrent(
      bundledComponentSource('@e-mate/dsh-client-shell'),
      join(profile, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar'),
    )) return false
    for (const name of PLUGIN_PACKAGES) {
      const source = bundledComponentSource(name)
      if (!managedPackageCurrent(
        source,
        join(profile, 'node_modules', ...name.split('/')),
        adaptedPluginPatch(source, name),
      )) return false
    }
    for (const plugin of ECOSYSTEM_PLUGIN_PACKAGES) {
      const source = join(sourceRoot, 'ecosystem', plugin.name)
      if (!managedPackageCurrent(
        source,
        join(profile, 'node_modules', plugin.name),
        adaptedEcosystemPatch(source, plugin),
      )) return false
    }

    return [
      join(profile, 'cordis.patch.yml'),
      join(profile, 'cordis.yml'),
      join(profile, 'plugins', 'runtime-binding.json'),
      join(profile, 'plugins', 'health.js'),
      join(profile, 'plugins', 'model-policy.js'),
      join(profile, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar', 'package.json'),
      ...PLUGIN_PACKAGES.map(name => join(profile, 'node_modules', ...name.split('/'), 'package.json')),
      ...ECOSYSTEM_PLUGIN_PACKAGES.map(plugin => join(profile, 'node_modules', plugin.name, 'package.json')),
    ].every(existsSync)
  } catch {
    return false
  }
}

/** Install or repair only the e-Mate-owned profile files before Desktop boot. */
export function installEmateDesktopProfile(
  dshHome: string,
  deferCleanup?: (path: string) => void,
): string {
  const profile = join(dshHome, 'profiles', EMATE_PROFILE_NAME)
  const data = join(dshHome, 'e-mate')
  for (const directory of [
    profile,
    join(data, 'attachments'),
    join(data, 'general'),
    join(data, 'memory'),
    join(data, 'cache'),
    join(data, 'migrations'),
    join(data, 'run'),
    join(data, 'logs'),
  ]) mkdirSync(directory, { recursive: true })

  const settings = join(dshHome, 'settings.yaml')
  if (!existsSync(settings)) {
    atomicWrite(settings, DEFAULT_SETTINGS, 0o600)
  } else {
    const current = readFileSync(settings, 'utf8')
    if (!/^agent-default-model\s*:/mu.test(current)) {
      atomicWrite(settings, `${current}${current.endsWith('\n') ? '' : '\n'}${DEFAULT_MODEL_SETTINGS}`, 0o600)
    }
  }
  rmSync(join(dshHome, 'browser-extension'), { recursive: true, force: true })
  rmSync(join(dshHome, 'ext-bridge-token'), { force: true })
  if (installedProfileCurrent(profile, dshHome)) {
    deferManagedPackageCleanup(profile, deferCleanup)
    return profile
  }

  recoverManagedPackageTransactions(profile)
  const reuseInstalledGeneration = installedGenerationCurrent(profile, dshHome)
  rmSync(join(profile, PROFILE_INSTALL_RECEIPT), { force: true })
  cpSync(join(sourceRoot, 'plugins'), join(profile, 'plugins'), { recursive: true, force: true })
  atomicWrite(
    join(profile, 'cordis.patch.yml'),
    `${readFileSync(join(sourceRoot, 'cordis.patch.yml'), 'utf8').trimEnd()}\n\n- id: dsh-file-viewer\n  config:\n    allowAbsolutePaths: false\n`,
  )
  atomicWrite(join(profile, 'cordis.yml'), '[]\n')
  let previous: {
    dependencies?: Record<string, unknown>
    dsh?: { profile?: { bundles?: unknown[] } }
  } = {}
  try { previous = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) } catch {}
  const externalDependencies = Object.entries(previous.dependencies ?? {})
    .filter(([name, version]) => !OWNED_PROFILE_PACKAGES.has(name) && typeof version === 'string')
  const externalBundles = (Array.isArray(previous.dsh?.profile?.bundles) ? previous.dsh.profile.bundles : [])
    .filter((name): name is string => typeof name === 'string' && !OWNED_PROFILE_PACKAGES.has(name)
      && name !== '@deepseek-ai/dsh-base' && name !== '@deepseek-ai/dsh-web-app')
  atomicWrite(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-e-mate',
    private: true,
    type: 'module',
    dependencies: Object.fromEntries([
      ...PLUGIN_PACKAGES.map(name => [name, packageVersion(bundledComponentSource(name), name)]),
      ...ECOSYSTEM_PLUGIN_PACKAGES.map(plugin => [plugin.name, plugin.version]),
      ...externalDependencies,
    ]),
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...PROFILE_PLUGIN_PACKAGES, ...externalBundles],
      },
    },
  }, null, 2)}\n`)
  for (const name of RETIRED_PROFILE_PACKAGES) {
    rmSync(join(profile, 'node_modules', ...name.split('/')), { recursive: true, force: true })
  }

  const shellSource = bundledComponentSource('@e-mate/dsh-client-shell')
  const shellTarget = join(profile, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar')
  mkdirSync(dirname(shellTarget), { recursive: true })
  installManagedPackage(shellSource, shellTarget, new Map(), deferCleanup, reuseInstalledGeneration)

  for (const name of PLUGIN_PACKAGES) {
    const source = bundledComponentSource(name)
    const target = join(profile, 'node_modules', ...name.split('/'))
    const overrides = adaptedPluginPatch(source, name)
    mkdirSync(dirname(target), { recursive: true })
    installManagedPackage(source, target, overrides, deferCleanup, reuseInstalledGeneration)
  }

  for (const expected of ECOSYSTEM_PLUGIN_PACKAGES) {
    const sourceManifest = join(sourceRoot, 'ecosystem', expected.name, 'package.json')
    const source = dirname(sourceManifest)
    const target = join(profile, 'node_modules', expected.name)
    const manifest = JSON.parse(readFileSync(sourceManifest, 'utf8')) as {
      name?: string
      version?: string
      license?: string
      main?: string
      exports?: Record<string, unknown>
      dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
    }
    const rootExport = manifest.exports?.['.']
    const rootEntry = typeof rootExport === 'string'
      ? rootExport
      : rootExport && typeof rootExport === 'object'
        ? (rootExport as { default?: unknown }).default
        : undefined
    if (manifest.name !== expected.name || manifest.version !== expected.version
      || manifest.license !== 'MIT'
      || (expected.client
        ? manifest.dsh?.client?.platform !== 'web'
        : manifest.dsh?.client !== undefined)
      || (manifest.main !== expected.entry && rootEntry !== `./${expected.entry}`)
      || (expected.client && manifest.exports?.['./client'] === undefined)
      || typeof manifest.dsh?.bundle?.patch !== 'string') {
      throw new Error(`${expected.name} package contract does not match the pinned e-Mate desktop profile`)
    }
    installManagedPackage(source, target, adaptedEcosystemPatch(source, expected), deferCleanup, reuseInstalledGeneration)
  }

  const tools = packageEntry('@deepseek-ai/dsh-tools')
  const storage = packageEntry('@deepseek-ai/dsh-storage-domain')
  const llm = packageEntry('@deepseek-ai/dsh-llm')
  const compaction = packageEntry('@deepseek-ai/dsh-compaction')
  const schedule = packageEntry('@deepseek-ai/dsh-schedule')
  const credentials = packageEntry('@deepseek-ai/dsh-credentials')
  const environment = packageEntry('@deepseek-ai/dsh-launch-environment')
  const storageManifest = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-storage-domain/package.json')
  const zod = dependencyEntry(storageManifest, 'zod')
  atomicWrite(join(profile, 'plugins', 'runtime-binding.json'), `${JSON.stringify({
    schema_version: 1,
    product: 'e-Mate',
    version: EMATE_DESKTOP_PROFILE_VERSION,
    dsh_home: resolve(dshHome),
    harness_commit: HARNESS_COMMIT,
    tools_module: tools,
    tools_module_sha256: sha256(tools),
    storage_domain_module: storage,
    storage_domain_module_sha256: sha256(storage),
    llm_module: llm,
    llm_module_sha256: sha256(llm),
    compaction_module: compaction,
    compaction_module_sha256: sha256(compaction),
    schedule_module: schedule,
    schedule_module_sha256: sha256(schedule),
    credentials_module: credentials,
    credentials_module_sha256: sha256(credentials),
    launch_environment_module: environment,
    launch_environment_module_sha256: sha256(environment),
    zod_module: zod,
    zod_module_sha256: sha256(zod),
  }, null, 2)}\n`, 0o600)

  const registry = JSON.parse(readFileSync(join(sourceRoot, 'bundles', 'registry.json'), 'utf8')) as {
    product?: string
    version?: string
    harness_commit?: string
    packages?: unknown[]
  }
  if (registry.product !== 'e-Mate' || registry.version !== EMATE_DESKTOP_PROFILE_VERSION
    || registry.harness_commit !== HARNESS_COMMIT
    || !Array.isArray(registry.packages)
    || PLUGIN_PACKAGES.some(name => !registry.packages!.some(candidate => (
      candidate !== null && typeof candidate === 'object'
      && (candidate as { name?: unknown }).name === name
    )))) {
    throw new Error('e-Mate desktop profile bundle registry is invalid')
  }
  const generatedPlugins = readdirSync(join(profile, 'plugins'))
  if (!generatedPlugins.includes('health.js') || !generatedPlugins.includes('model-policy.js')) {
    throw new Error('e-Mate desktop profile plugins are incomplete')
  }
  atomicWrite(join(profile, PROFILE_INSTALL_RECEIPT), `${JSON.stringify({
    schema_version: 2,
    version: EMATE_DESKTOP_PROFILE_VERSION,
    harness_commit: HARNESS_COMMIT,
    dsh_home: resolve(dshHome),
    source_root: resolve(sourceRoot),
    profile_generation: 'bundled',
    managed_package_layout: managedPackageLayout(),
  }, null, 2)}\n`, 0o600)
  return profile
}
