// e-Mate lifecycle overlay on the pinned Harness runtime.
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { migrateLegacySessions } from './legacy-migration.js'
import { migrateLegacySchedules } from './legacy-schedule.js'
import { checkOsCredentialBackend } from './profile/credentials-os.js'

export const PRODUCT = 'e-Mate'
export const VERSION = '2.0.18'
export const PROFILE = 'e-mate'
export const DEFAULT_PORT = 3080
export const HARNESS_VERSION = '0.1.5-rc.1'
export const HARNESS_COMMIT = '43c411a51c555e61e9b5f500442cb3404a2d70cd'
/** Product Web shell package name in the bundled component store. */
const EMATE_SHELL_PACKAGE = '@e-mate/dsh-client-shell'
/**
 * Package the pinned Web bundle names in its `ui-sidebar` row. The e-Mate shell
 * takes that row over, and its client bundle registers this same identity
 * (packages/dsh/profile/plugins/emate-shell/tsdown.config.ts).
 */
const NATIVE_SIDEBAR_PACKAGE = '@deepseek-ai/dsh-client-ui-sidebar'
const SHELL_INSTALL_PACKAGE = `node_modules/${NATIVE_SIDEBAR_PACKAGE}/package.json`
const packageRoot = resolve(import.meta.dirname, '..')
const componentInventory = JSON.parse(
  readFileSync(join(packageRoot, 'profile', 'component-inventory.json'), 'utf8'),
)
if (componentInventory.schema_version !== 1 || !Array.isArray(componentInventory.components)) {
  throw new Error('e-Mate component inventory is invalid')
}
const PLUGIN_PACKAGES = componentInventory.components
  .filter(component => component.cli === true && /^@e-mate\/dsh-plugin-[a-z0-9-]+$/u.test(component.id))
  .map(component => component.id)
const MANAGED_PROFILE_PACKAGES = new Set(PLUGIN_PACKAGES)
const RETIRED_PROFILE_PACKAGES = new Set([
  '@e-mate/dsh-plugin-browser',
  '@e-mate/dsh-plugin-computer-use',
  '@e-mate/dsh-plugin-browser-panel',
  '@e-mate/dsh-plugin-idesign',
  '@e-mate/dsh-plugin-im',
  '@e-mate/dsh-plugin-search-mcp',
  '@e-mate/dsh-plugin-subagent',
  '@e-mate/dsh-plugin-tidychat',
  '@e-mate/dsh-plugin-xin-assistant',
  '@yuxianglin/dsh-bridge-browser',
  'dsh-search-mcp',
])
const OWNED_PROFILE_PACKAGES = new Set([...MANAGED_PROFILE_PACKAGES, ...RETIRED_PROFILE_PACKAGES])
const binPath = fileURLToPath(new URL('./bin.js', import.meta.url))
export function resolveDshHome(environment = process.env) {
  return resolve(environment.DSH_HOME || join(homedir(), '.dsh'))
}

export function managedPaths(dshHome = resolveDshHome()) {
  const data = join(dshHome, 'e-mate')
  const run = join(data, 'run')
  return {
    dshHome,
    data,
    profile: join(dshHome, 'profiles', PROFILE),
    run,
    state: join(run, 'instance.json'),
    log: join(data, 'logs', 'web.log'),
    receipt: join(data, 'migrations', `setup-${VERSION}.json`),
  }
}

function atomicWrite(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, content, { mode })
    renameSync(temporary, path)
    if (mode !== undefined) chmodSync(path, mode)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Shell manifest text as it must be installed at the native Sidebar path. The
 * pinned client module registry names each served graph row after the manifest
 * that declares the resolved specifier (upstream
 * packages/client/modules/src/index.ts, locatePkgJson/nearestPackage), and the
 * shell client bundle registers that same native identity. An installed manifest
 * keeping the shell's own name therefore leaves the native row with no matching
 * package: the row is dropped from the served graph and the shell client never
 * loads. Installing under the native identity keeps row, graph id and registered
 * bundle id in agreement.
 * @param source - bundled shell manifest text.
 * @returns manifest text to install at the native Sidebar path.
 */
function shellInstallManifest(source) {
  const manifest = JSON.parse(source)
  if (manifest.name !== EMATE_SHELL_PACKAGE) {
    throw new Error(`${EMATE_SHELL_PACKAGE} component package identity is invalid`)
  }
  return `${JSON.stringify({ ...manifest, name: NATIVE_SIDEBAR_PACKAGE }, null, 2)}\n`
}

function emptyBundlePatch(patch) {
  return patch.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#')).join('\n') === '[]'
}

export function installProfile(dshHome = resolveDshHome()) {
  const paths = managedPaths(dshHome)
  for (const directory of [
    paths.profile,
    join(paths.data, 'attachments'),
    join(paths.data, 'general'),
    join(paths.data, 'memory'),
    join(paths.data, 'cache'),
    join(paths.data, 'migrations'),
    join(paths.data, 'run'),
    join(paths.data, 'logs'),
  ]) mkdirSync(directory, { recursive: true })

  const previous = readJson(join(paths.profile, 'package.json')) ?? {}
  const externalDependencies = Object.entries(previous.dependencies ?? {})
    .filter(([name, version]) => !OWNED_PROFILE_PACKAGES.has(name) && typeof version === 'string')
  const externalBundles = (Array.isArray(previous.dsh?.profile?.bundles) ? previous.dsh.profile.bundles : [])
    .filter(name => typeof name === 'string' && !OWNED_PROFILE_PACKAGES.has(name)
      && name !== '@deepseek-ai/dsh-base' && name !== '@deepseek-ai/dsh-web-app')
  const manifest = {
    name: 'dsh-profile-e-mate',
    private: true,
    type: 'module',
    dependencies: Object.fromEntries([
      ...PLUGIN_PACKAGES.map(name => [name, VERSION]),
      ...externalDependencies,
    ]),
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...PLUGIN_PACKAGES, ...externalBundles] } },
  }
  atomicWrite(join(paths.profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  atomicWrite(
    join(paths.profile, 'cordis.patch.yml'),
    readFileSync(join(packageRoot, 'profile', 'cordis.patch.yml')),
  )
  // Remove only the retired managed executable; saved Sessions and image bytes stay owned by DSH.
  rmSync(join(paths.profile, 'plugins', 'image-generation.js'), { force: true })
  const generatedPlugins = readdirSync(join(packageRoot, 'profile', 'plugins'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => [`plugins/${entry.name}`, `plugins/${entry.name}`])
  const profileFiles = [
    ...generatedPlugins,
    ['plugins/identity/index.js', 'plugins/identity/index.js'],
    ['plugins/identity/agreements.js', 'plugins/identity/agreements.js'],
    ['plugins/identity/agreements/e-mate-user-agreement.md', 'plugins/identity/agreements/e-mate-user-agreement.md'],
    ['plugins/identity/agreements/yixin-enterprise-disclaimer.md', 'plugins/identity/agreements/yixin-enterprise-disclaimer.md'],
    ['plugins/emate-shell/package.json', SHELL_INSTALL_PACKAGE],
    ['plugins/emate-shell/index.js', 'node_modules/@deepseek-ai/dsh-client-ui-sidebar/index.js'],
    ['plugins/emate-shell/lib/client.js', 'node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js'],
    ['plugins/emate-shell/assets/emate-logo.png', 'node_modules/@deepseek-ai/dsh-client-ui-sidebar/assets/emate-logo.png'],
    ['plugins/emate-shell/assets/emate-mark.png', 'node_modules/@deepseek-ai/dsh-client-ui-sidebar/assets/emate-mark.png'],
    ['plugins/emate-shell/assets/e-mate-team-hero-transparent.png', 'node_modules/@deepseek-ai/dsh-client-ui-sidebar/assets/e-mate-team-hero-transparent.png'],
    ['plugins/emate-shell/assets/xiaoxin-avatar.png', 'node_modules/@deepseek-ai/dsh-client-ui-sidebar/assets/xiaoxin-avatar.png'],
    ['plugins/emate-shell/assets/lucide-send.svg', 'node_modules/@deepseek-ai/dsh-client-ui-sidebar/assets/lucide-send.svg'],
  ]
  for (const [source, target] of profileFiles) {
    const content = readFileSync(join(packageRoot, 'profile', source))
    atomicWrite(
      join(paths.profile, target),
      target === SHELL_INSTALL_PACKAGE ? shellInstallManifest(content.toString('utf8')) : content,
    )
  }
  for (const name of RETIRED_PROFILE_PACKAGES) {
    rmSync(join(paths.profile, 'node_modules', ...name.split('/')), { recursive: true, force: true })
  }
  for (const name of PLUGIN_PACKAGES) {
    const slug = name.slice('@e-mate/dsh-plugin-'.length)
    const source = join(packageRoot, 'profile', 'bundles', slug)
    const target = join(paths.profile, 'node_modules', ...name.split('/'))
    rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, { recursive: true, force: true })
    const packageManifest = readJson(join(target, 'package.json'))
    const patchPath = join(target, packageManifest.dsh.bundle.patch)
    const patch = readFileSync(patchPath, 'utf8')
    if (!emptyBundlePatch(patch) && packageManifest.dsh?.client?.platform !== 'web') {
      const packageEntry = `name: '${name}'`
      if (patch.split(packageEntry).length !== 2) throw new Error(`${name} bundle entry is not uniquely localizable`)
      atomicWrite(patchPath, patch.replace(packageEntry, `name: './node_modules/${name}/${packageManifest.main}'`))
    }
  }
  const binding = join(paths.profile, 'plugins', 'runtime-binding.json')
  const harness = resolveHarness()
  const toolsModule = resolveHarnessModule(harness, 'packages/core/tools', '@deepseek-ai/dsh-tools')
  const storageDomainModule = resolveHarnessModule(harness, 'packages/storage/storage-domain', '@deepseek-ai/dsh-storage-domain')
  const llmModule = resolveHarnessModule(harness, 'packages/llm/llm', '@deepseek-ai/dsh-llm')
  const compactionModule = resolveHarnessModule(harness, 'packages/compaction/compaction', '@deepseek-ai/dsh-compaction')
  const scheduleModule = resolveHarnessModule(harness, 'packages/schedule/schedule', '@deepseek-ai/dsh-schedule')
  const credentialsModule = resolveHarnessModule(harness, 'packages/credentials/credentials', '@deepseek-ai/dsh-credentials')
  const launchEnvironmentModule = resolveHarnessModule(harness, 'packages/util/launch-environment', '@deepseek-ai/dsh-launch-environment')
  const zodModule = resolveHarnessDependency(harness, 'packages/storage/storage-domain', 'zod')
  atomicWrite(binding, `${JSON.stringify({
    schema_version: 1,
    product: PRODUCT,
    version: VERSION,
    dsh_home: paths.dshHome,
    harness_commit: HARNESS_COMMIT,
    tools_module: toolsModule,
    tools_module_sha256: createHash('sha256').update(readFileSync(toolsModule)).digest('hex'),
    storage_domain_module: storageDomainModule,
    storage_domain_module_sha256: createHash('sha256').update(readFileSync(storageDomainModule)).digest('hex'),
    llm_module: llmModule,
    llm_module_sha256: createHash('sha256').update(readFileSync(llmModule)).digest('hex'),
    compaction_module: compactionModule,
    compaction_module_sha256: createHash('sha256').update(readFileSync(compactionModule)).digest('hex'),
    schedule_module: scheduleModule,
    schedule_module_sha256: createHash('sha256').update(readFileSync(scheduleModule)).digest('hex'),
    credentials_module: credentialsModule,
    credentials_module_sha256: createHash('sha256').update(readFileSync(credentialsModule)).digest('hex'),
    launch_environment_module: launchEnvironmentModule,
    launch_environment_module_sha256: createHash('sha256').update(readFileSync(launchEnvironmentModule)).digest('hex'),
    zod_module: zodModule,
    zod_module_sha256: createHash('sha256').update(readFileSync(zodModule)).digest('hex'),
  }, null, 2)}\n`, 0o600)
  return paths
}

function parseNodeVersion(value = process.versions.node) {
  const [major, minor] = value.split('.').map(Number)
  return { major, minor }
}

export function nodeVersionSupported(value = process.versions.node) {
  const { major, minor } = parseNodeVersion(value)
  return major >= 24 || (major === 22 && minor >= 19)
}

export function platformSupported(platform = process.platform, arch = process.arch) {
  return (platform === 'darwin' && (arch === 'arm64' || arch === 'x64'))
    || (platform === 'win32' && arch === 'x64')
}

function harnessFromDevelopmentTree() {
  const root = resolve(packageRoot, '..', '..', 'upstream', 'deepseek-harness')
  const bin = join(root, 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(bin)) return undefined
  const version = readJson(join(root, 'apps', 'cli', 'package.json'))?.version
  const git = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  return { bin, version, commit: git.status === 0 ? git.stdout.trim() : undefined, source: 'development-source' }
}

function harnessFromPackage() {
  const root = join(packageRoot, 'runtime', 'harness')
  const bin = join(root, 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(bin)) return undefined
  const source = readJson(join(packageRoot, 'runtime', 'source-manifest.json'))
  for (const [expected, path] of [
    [source?.artifact_links_adapter_sha256, join(root, 'e-mate-artifact-links-adapter.mjs')],
    [source?.artifact_links_client_sha256, join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives', 'lib', 'index.js')],
    [source?.artifact_deliverables_client_sha256, join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-deliverables', 'lib', 'client.js')],
    [source?.conversation_adapter_sha256, join(root, 'e-mate-conversation-adapter.mjs')],
    [source?.conversation_client_sha256, join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js')],
    // rc.1 removes @deepseek-ai/dsh-client-runtime and moves the slot-error
    // adaptation onto ui-conversation; the chat adapter's own owner is pinned too.
    [source?.conversation_chat_client_sha256, join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-chat', 'lib', 'client.js')],
  ]) {
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/u.test(expected) || !existsSync(path)
      || createHash('sha256').update(readFileSync(path)).digest('hex') !== expected) {
      throw new Error('e-Mate packaged conversation adapter provenance is missing or mismatched')
    }
  }
  const version = readJson(join(root, 'apps', 'cli', 'package.json'))?.version
  return { bin, version, commit: source?.commit, source: 'packaged-runtime' }
}

export function resolveHarness() {
  const runtime = harnessFromPackage() ?? harnessFromDevelopmentTree()
  if (runtime === undefined) throw new Error('exact e-Mate local runtime is missing')
  if (runtime.version !== HARNESS_VERSION || runtime.commit !== HARNESS_COMMIT) {
    throw new Error(`e-Mate local runtime drifted (version=${String(runtime.version)}, commit=${String(runtime.commit)})`)
  }
  return runtime
}

function harnessRoot(harness) {
  return resolve(dirname(dirname(harness.bin)), '..', '..')
}

export function resolveHarnessModule(harness, packagePath, packageName) {
  const root = harnessRoot(harness)
  const manifestPath = join(root, packagePath, 'package.json')
  if (existsSync(manifestPath)) {
    const main = readJson(manifestPath)?.main
    const entry = typeof main === 'string' ? resolve(dirname(manifestPath), main) : undefined
    if (entry === undefined || !existsSync(entry)) throw new Error(`pinned runtime package ${packageName} is not built`)
    return entry
  }
  return createRequire(join(dirname(dirname(harness.bin)), 'package.json')).resolve(packageName)
}

function resolveHarnessDependency(harness, packagePath, dependencyName) {
  const manifestPath = join(harnessRoot(harness), packagePath, 'package.json')
  return createRequire(existsSync(manifestPath)
    ? manifestPath
    : join(dirname(dirname(harness.bin)), 'package.json')).resolve(dependencyName)
}

function nearestExisting(path) {
  let candidate = path
  while (!existsSync(candidate)) {
    const parent = dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  return candidate
}

function writableCheck(path) {
  try {
    accessSync(nearestExisting(path), constants.W_OK)
    return { ok: true, detail: path }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

async function sqliteCheck(paths) {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const databases = [join(paths.data, 'sessions.sqlite3'), join(paths.data, 'state.sqlite3')]
      .filter(existsSync)
    if (databases.length === 0) {
      const db = new DatabaseSync(':memory:')
      db.close()
    } else {
      for (const path of databases) {
        const db = new DatabaseSync(path, { readOnly: true })
        db.prepare('PRAGMA quick_check').get()
        db.close()
      }
    }
    return { ok: true, detail: databases.length === 0 ? 'node:sqlite available' : `${databases.length} database(s) readable` }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

function pluginBundleCheck(root = join(packageRoot, 'profile', 'bundles')) {
  try {
    const registry = readJson(join(root, 'registry.json'))
    if (registry?.schema_version !== 1
      || registry.product !== PRODUCT
      || registry.version !== VERSION
      || registry.harness_version !== HARNESS_VERSION
      || registry.harness_commit !== HARNESS_COMMIT
      || !Array.isArray(registry.packages)
      || JSON.stringify(registry.packages.map(item => item?.name)) !== JSON.stringify(PLUGIN_PACKAGES)) {
      throw new Error('plugin bundle registry is invalid')
    }
    for (const name of PLUGIN_PACKAGES) {
      const slug = name.slice('@e-mate/dsh-plugin-'.length)
      const bundleRoot = join(root, slug)
      const manifest = readJson(join(bundleRoot, 'package.json'))
      if (manifest?.name !== name || manifest?.version !== VERSION || manifest?.license !== (name === '@e-mate/dsh-plugin-imagegen' ? 'Apache-2.0' : 'MIT')
        || typeof manifest?.main !== 'string' || !existsSync(join(bundleRoot, manifest.main))
        || typeof manifest?.dsh?.bundle?.patch !== 'string'
        || !existsSync(join(bundleRoot, manifest.dsh.bundle.patch))) {
        throw new Error(`${name} bundle is incomplete`)
      }
      if (manifest?.dsh?.client !== undefined && !existsSync(join(bundleRoot, 'lib', 'client.js'))) {
        throw new Error(`${name} client bundle is incomplete`)
      }
    }
    return { ok: true, detail: `${PLUGIN_PACKAGES.length} pinned DSH plugin bundle(s)` }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

function profileCheck(paths) {
  const manifest = readJson(join(paths.profile, 'package.json'))
  const bundles = manifest?.dsh?.profile?.bundles
  const patch = join(paths.profile, 'cordis.patch.yml')
  const plugins = [
    join(paths.profile, 'plugins', 'health.js'),
    join(paths.profile, 'plugins', 'agent-operations.js'),
    join(paths.profile, 'plugins', 'capabilities.js'),
    join(paths.profile, 'plugins', 'qr-generation.js'),
    join(paths.profile, 'plugins', 'credentials-os.js'),
    join(paths.profile, 'plugins', 'settings-document-boundary.js'),
    join(paths.profile, 'plugins', 'image-history.js'),
    join(paths.profile, 'plugins', 'model-policy.js'),
    join(paths.profile, 'plugins', 'audit.js'),
    join(paths.profile, 'plugins', 'legacy-migration.js'),
    join(paths.profile, 'plugins', 'schedule-import.js'),
    join(paths.profile, 'plugins', 'runtime-binding.json'),
    join(paths.profile, 'plugins', 'identity', 'index.js'),
    join(paths.profile, 'plugins', 'identity', 'agreements.js'),
    join(paths.profile, 'plugins', 'identity', 'agreements', 'e-mate-user-agreement.md'),
    join(paths.profile, 'plugins', 'identity', 'agreements', 'yixin-enterprise-disclaimer.md'),
    join(paths.profile, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar', 'package.json'),
    join(paths.profile, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar', 'index.js'),
    join(paths.profile, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar', 'lib', 'client.js'),
    join(paths.profile, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar', 'assets', 'emate-logo.png'),
    join(paths.profile, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar', 'assets', 'emate-mark.png'),
  ]
  let patchValid = false
  try {
    const document = parseYaml(readFileSync(patch, 'utf8'))
    const rows = Array.isArray(document)
      ? document.flatMap(operation => Array.isArray(operation?.insert) ? operation.insert : operation?.id ? [operation] : [])
      : []
    const byId = new Map(rows.map(row => [row?.id, row]))
    patchValid = byId.get('schedule')?.name === '@deepseek-ai/dsh-schedule'
      && byId.get('agent-loop')?.config?.maxParallelToolCalls === 4
      && byId.get('credentials')?.name === '@deepseek-ai/dsh-credentials-local'
      && byId.get('credentials')?.disabled === true
      && byId.get('emate-settings-document-boundary')?.name === './plugins/settings-document-boundary.js'
      && byId.get('emate-credentials-os')?.name === './plugins/credentials-os.js'
      && byId.get('emate-qr-generation')?.name === './plugins/qr-generation.js'
      && byId.get('emate-model-policy')?.name === './plugins/model-policy.js'
      && byId.get('emate-audit')?.name === './plugins/audit.js'
      && JSON.stringify(byId.get('emate-audit')?.inject) === JSON.stringify([
        'connection', 'sessionPersistence', 'storageDomain', 'timer', 'tools', 'emateModelPolicy', 'emateIdentity',
      ])
      && byId.get('emate-schedule-import')?.name === './plugins/schedule-import.js'
      && byId.get('emate-legacy-migration')?.name === './plugins/legacy-migration.js'
      && byId.get('emate-agent-operations')?.name === './plugins/agent-operations.js'
      && JSON.stringify(byId.get('emate-agent-operations')?.inject) === JSON.stringify(['systemPrompt', 'connection', 'sessions', 'sessionController'])
      && !byId.has('emate-office-ocr')
      && !byId.has('emate-browser-computer-use')
      && !byId.has('emate-memory')
      && !byId.has('emate-dream')
      && !byId.has('emate-learning')
  } catch {
    patchValid = false
  }
  const managedPlugins = PLUGIN_PACKAGES.every(name => {
    const root = join(paths.profile, 'node_modules', ...name.split('/'))
    const packageManifest = readJson(join(root, 'package.json'))
    if (packageManifest?.name !== name || packageManifest?.version !== VERSION
      || typeof packageManifest?.main !== 'string' || !existsSync(join(root, packageManifest.main))
      || typeof packageManifest?.dsh?.bundle?.patch !== 'string') return false
    let patch
    try {
      patch = readFileSync(join(root, packageManifest.dsh.bundle.patch), 'utf8')
    } catch {
      return false
    }
    const entry = packageManifest.dsh?.client?.platform === 'web'
      ? `name: '${name}'` : `name: './node_modules/${name}/${packageManifest.main}'`
    return (emptyBundlePatch(patch) || patch.includes(entry))
      && (packageManifest?.dsh?.client === undefined || existsSync(join(root, 'lib', 'client.js')))
  })
  // The shell must answer the native `ui-sidebar` row's own name, or the pinned
  // client module registry drops that row from the served graph and the product
  // Sidebar never reaches the browser. See shellInstallManifest.
  const installedShell = readJson(join(paths.profile, ...SHELL_INSTALL_PACKAGE.split('/')))
  const sidebarIdentity = installedShell?.name === NATIVE_SIDEBAR_PACKAGE
  const expectedBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...PLUGIN_PACKAGES]
  const expectedDependencies = Object.fromEntries(PLUGIN_PACKAGES.map(name => [name, VERSION]))
  const dependencyEntries = manifest?.dependencies !== null && typeof manifest?.dependencies === 'object'
    ? Object.entries(manifest.dependencies)
    : []
  const ok = Array.isArray(bundles)
    && JSON.stringify(bundles.slice(0, expectedBundles.length)) === JSON.stringify(expectedBundles)
    && bundles.slice(expectedBundles.length).every(name => typeof name === 'string'
      && !expectedBundles.includes(name) && !RETIRED_PROFILE_PACKAGES.has(name))
    && Object.entries(expectedDependencies).every(([name, version]) => manifest.dependencies?.[name] === version)
    && dependencyEntries.every(([name, version]) => typeof version === 'string'
      && !RETIRED_PROFILE_PACKAGES.has(name) && (!MANAGED_PROFILE_PACKAGES.has(name) || version === VERSION))
    && patchValid && plugins.every(existsSync) && managedPlugins && sidebarIdentity
  return { ok, detail: ok ? paths.profile : 'managed e-mate profile is missing or drifted; run e-mate setup' }
}

function check(id, result, required = true) {
  return { id, required, status: result.ok ? 'pass' : required ? 'fail' : 'warning', detail: result.detail }
}

export async function checkEnvironment({ dshHome = resolveDshHome(), includeProfile = true } = {}) {
  const paths = managedPaths(dshHome)
  const supported = platformSupported()
  let harness
  try {
    harness = resolveHarness()
  } catch (error) {
    harness = { error: error instanceof Error ? error.message : String(error) }
  }
  const credentialStore = await checkOsCredentialBackend()
  const checks = [
    check('node', { ok: nodeVersionSupported(), detail: process.versions.node }),
    check('platform', { ok: supported, detail: `${process.platform}-${process.arch}` }),
    check('harness', harness.error === undefined
      ? { ok: true, detail: `${harness.source} ${HARNESS_VERSION} ${HARNESS_COMMIT}` }
      : { ok: false, detail: harness.error }),
    check('plugin_bundles', pluginBundleCheck()),
    check('dsh_home_writable', writableCheck(dshHome)),
    check('sqlite', await sqliteCheck(paths)),
    check('credential_store', credentialStore),
  ]
  if (includeProfile) checks.push(check('profile', profileCheck(paths)))
  return {
    product: PRODUCT,
    version: VERSION,
    ok: checks.every(item => !item.required || item.status === 'pass'),
    checks,
  }
}

function printCheckReport(report, json) {
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  for (const item of report.checks) {
    const marker = item.status === 'pass' ? 'PASS' : item.status === 'warning' ? 'WARN' : 'FAIL'
    console.log(`${marker.padEnd(4)} ${item.id}: ${item.detail}`)
  }
  console.log(report.ok ? 'e-Mate environment is ready.' : 'e-Mate environment is not ready.')
}

function readState(paths = managedPaths()) {
  const state = readJson(paths.state)
  return state?.product === PRODUCT && state?.profile === PROFILE ? state : undefined
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function fetchHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/e-mate/health`, {
      signal: AbortSignal.timeout(800),
    })
    if (!response.ok) return undefined
    const health = await response.json()
    return health?.product === PRODUCT && health?.version === VERSION && health?.profile === PROFILE
      ? health
      : undefined
  } catch {
    return undefined
  }
}

export async function managedStatus(dshHome = resolveDshHome()) {
  const paths = managedPaths(dshHome)
  const state = readState(paths)
  if (state === undefined) return { running: false, healthy: false, product: PRODUCT, version: VERSION }
  const alive = pidAlive(state.pid)
  const health = alive ? await fetchHealth(state.port) : undefined
  const healthy = health?.instance_id === state.instance_id
  return { ...state, running: alive, healthy, health }
}

async function portAvailable(port) {
  return await new Promise(resolvePort => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolvePort(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePort(true)))
  })
}

function parsePort(value) {
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port ${JSON.stringify(value)}`)
  return port
}

function parseLaunchArgs(args) {
  let port = DEFAULT_PORT
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--port' || args[index + 1] === undefined) {
      throw new Error(`launch accepts only --port <1-65535>, got ${JSON.stringify(args[index])}`)
    }
    port = parsePort(args[index + 1])
    index += 1
  }
  return { port }
}

function assertLoopbackWebArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--host') {
      if (args[index + 1] !== '127.0.0.1') throw new Error('e-Mate web is loopback-only; --host must be 127.0.0.1')
      index += 1
    } else if (argument.startsWith('--host=') && argument !== '--host=127.0.0.1') {
      throw new Error('e-Mate web is loopback-only; --host must be 127.0.0.1')
    }
  }
}

async function runChild(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', ...options })
  const forward = signal => {
    if (child.exitCode === null) child.kill(signal)
  }
  const onTerm = () => forward('SIGTERM')
  const onInterrupt = () => forward('SIGINT')
  process.on('SIGTERM', onTerm)
  process.on('SIGINT', onInterrupt)
  try {
    return await new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolveExit(code ?? (signal === 'SIGINT' ? 130 : 1)))
    })
  } finally {
    process.off('SIGTERM', onTerm)
    process.off('SIGINT', onInterrupt)
  }
}

export async function runWeb(args, dshHome = resolveDshHome()) {
  assertLoopbackWebArgs(args)
  const paths = managedPaths(dshHome)
  if (!profileCheck(paths).ok) throw new Error('managed profile unavailable; run e-mate setup')
  const harness = resolveHarness()
  const webArgs = args.some(argument => argument === '--host' || argument.startsWith('--host='))
    ? args
    : ['--host', '127.0.0.1', ...args]
  return runChild(process.execPath, [harness.bin, '--profile', PROFILE, ...webArgs], {
    env: { ...process.env, DSH_HOME: dshHome },
  })
}

function openBrowser(url) {
  if (process.env.EMATE_NO_OPEN === '1') return
  const child = process.platform === 'darwin'
    ? spawn('/usr/bin/open', [url], { detached: true, stdio: 'ignore' })
    : spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', url], { detached: true, stdio: 'ignore' })
  child.unref()
}

async function waitForManagedHealth(state, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const health = await fetchHealth(state.port)
    if (health?.instance_id === state.instance_id) {
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
      if (pidAlive(state.pid)) {
        const stable = await fetchHealth(state.port)
        if (stable?.instance_id === state.instance_id) return stable
      }
    }
    if (!pidAlive(state.pid)) break
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  return undefined
}

export async function launchManaged(args = [], dshHome = resolveDshHome()) {
  const { port } = parseLaunchArgs(args)
  const paths = managedPaths(dshHome)
  const existing = await managedStatus(dshHome)
  if (existing.healthy) {
    openBrowser(existing.url)
    return existing
  }
  if (existing.running) throw new Error(`managed PID ${existing.pid} is alive but unhealthy; e-mate will not replace or kill it`)
  if (!profileCheck(paths).ok) throw new Error('managed profile unavailable; run e-mate setup')
  resolveHarness()
  if (!await portAvailable(port)) {
    throw new Error(`port ${port} is occupied by a non-managed or unhealthy process; nothing was stopped`)
  }

  mkdirSync(dirname(paths.log), { recursive: true })
  mkdirSync(paths.run, { recursive: true })
  const output = openSync(paths.log, 'a')
  const instanceId = randomUUID()
  const url = `http://127.0.0.1:${port}/`
  const child = spawn(process.execPath, [binPath, 'web', '--port', String(port)], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      EMATE_INSTANCE_ID: instanceId,
      EMATE_MANAGED: '1',
    },
    stdio: ['ignore', output, output],
  })
  child.unref()
  closeSync(output)
  const state = {
    product: PRODUCT,
    version: VERSION,
    profile: PROFILE,
    instance_id: instanceId,
    pid: child.pid,
    port,
    url,
    log: paths.log,
    started_at: new Date().toISOString(),
  }
  atomicWrite(paths.state, `${JSON.stringify(state, null, 2)}\n`, 0o600)
  const health = await waitForManagedHealth(state)
  if (health === undefined) {
    if (pidAlive(child.pid)) child.kill('SIGTERM')
    const current = readState(paths)
    if (current?.instance_id === instanceId) rmSync(paths.state, { force: true })
    throw new Error(`managed web failed health check; see ${paths.log}`)
  }
  openBrowser(url)
  return { ...state, running: true, healthy: true, health }
}

export async function stopManaged(dshHome = resolveDshHome()) {
  const paths = managedPaths(dshHome)
  const state = readState(paths)
  if (state === undefined) return { stopped: false, detail: 'not running' }
  if (!pidAlive(state.pid)) {
    rmSync(paths.state, { force: true })
    return { stopped: false, detail: 'removed stale instance state' }
  }
  const health = await fetchHealth(state.port)
  if (health?.instance_id !== state.instance_id) {
    throw new Error('instance identity could not be verified; no process was stopped')
  }
  process.kill(state.pid, 'SIGTERM')
  const deadline = Date.now() + 10000
  while (pidAlive(state.pid) && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  if (pidAlive(state.pid)) throw new Error(`managed PID ${state.pid} did not stop within 10 seconds`)
  const current = readState(paths)
  if (current?.instance_id === state.instance_id) rmSync(paths.state, { force: true })
  return { stopped: true, instance_id: state.instance_id }
}

function installShortcut(environment = process.env) {
  if (process.platform === 'darwin') {
    const desktop = environment.EMATE_DESKTOP_DIR || join(homedir(), 'Desktop')
    mkdirSync(desktop, { recursive: true })
    const path = join(desktop, 'e-Mate.command')
    atomicWrite(path, "#!/bin/zsh\nexec /bin/zsh -lic 'exec e-mate launch'\n", 0o755)
    return path
  }
  if (process.platform === 'win32') {
    const script = [
      "$desktop = [Environment]::GetFolderPath('Desktop')",
      "$final = Join-Path $desktop 'e-Mate.lnk'",
      "$temp = Join-Path $desktop ('e-Mate.' + [guid]::NewGuid().ToString() + '.tmp.lnk')",
      '$shell = New-Object -ComObject WScript.Shell',
      '$shortcut = $shell.CreateShortcut($temp)',
      '$shortcut.TargetPath = $env:ComSpec',
      '$shortcut.Arguments = \'/d /c start "" e-mate launch\'',
      '$shortcut.Save()',
      'Move-Item -LiteralPath $temp -Destination $final -Force',
      'Write-Output $final',
    ].join('; ')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr.trim() || 'failed to create Windows shortcut')
    return result.stdout.trim()
  }
  throw new Error('desktop shortcut is unsupported on this platform')
}

async function setup() {
  const report = await checkEnvironment({ includeProfile: false })
  if (!report.ok) {
    printCheckReport(report, false)
    throw new Error('required e-Mate runtime and plugin closure is incomplete; setup made no changes')
  }
  const current = await managedStatus()
  if (current.healthy && current.health.active_runs > 0) {
    throw new Error(`setup refused: ${current.health.active_runs} active run(s)`)
  }
  if (current.running) await stopManaged()
  const paths = installProfile()
  const migration = await migrateWithHarnessPersistence(paths.dshHome)
  const scheduleMigration = migrateLegacySchedules({ dshHome: paths.dshHome })
  const shortcut = installShortcut()
  atomicWrite(paths.receipt, `${JSON.stringify({
    product: PRODUCT,
    version: VERSION,
    profile: PROFILE,
    shortcut,
    legacy_migration: migration,
    legacy_schedule_migration: scheduleMigration,
    installed_at: new Date().toISOString(),
  }, null, 2)}\n`, 0o600)
  const verified = await checkEnvironment()
  if (!verified.ok) throw new Error('post-setup environment check failed')
  console.log(`e-Mate ${VERSION} setup complete.`)
  console.log(`Shortcut: ${shortcut}`)
  return 0
}

async function migrateWithHarnessPersistence(dshHome) {
  const harness = resolveHarness()
  const [{ Context }, { default: SessionStore }, { default: JsonlSessionPersistence }] = await Promise.all([
    import(pathToFileURL(resolveHarnessModule(harness, 'vendor/cordis', '@deepseek-ai/cordis')).href),
    import(pathToFileURL(resolveHarnessModule(harness, 'packages/core/session', '@deepseek-ai/dsh-session')).href),
    import(pathToFileURL(resolveHarnessModule(harness, 'packages/session/session-persistence-jsonl', '@deepseek-ai/dsh-session-persistence-jsonl')).href),
  ])
  const ctx = new Context()
  let sessionsFiber
  let persistenceFiber
  try {
    sessionsFiber = await ctx.plugin(SessionStore)
    persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root: join(dshHome, 'sessions') })
    return await migrateLegacySessions({ sessionPersistence: ctx.sessionPersistence, dshHome })
  } finally {
    await persistenceFiber?.dispose()
    await sessionsFiber?.dispose()
  }
}

async function forwardProfile(args) {
  if (args[0] !== '--profile' || args[1] !== PROFILE) {
    throw new Error('e-mate only boots the managed e-mate profile')
  }
  const paths = managedPaths()
  if (!profileCheck(paths).ok) throw new Error('managed profile unavailable; run e-mate setup')
  const harness = resolveHarness()
  return runChild(process.execPath, [harness.bin, ...args], {
    env: { ...process.env, DSH_HOME: paths.dshHome },
  })
}

function help() {
  console.log(`e-Mate ${VERSION}

Usage:
  e-mate setup [--check] [--json]
  e-mate web [--port <port>]
  e-mate launch [--port <port>]
  e-mate status
  e-mate stop
  e-mate --profile e-mate --dump-config
  e-mate --version`)
}

export async function main(args) {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    help()
    return 0
  }
  if (args[0] === '--version' || args[0] === '-V') {
    console.log(VERSION)
    return 0
  }
  if (args[0] === '--profile') return forwardProfile(args)
  if (args[0] === 'web') return runWeb(args.slice(1))
  if (args[0] === 'launch') {
    const status = await launchManaged(args.slice(1))
    console.log(`${status.url} (PID ${status.pid}, instance ${status.instance_id})`)
    return 0
  }
  if (args[0] === 'status') {
    if (args.length !== 1) throw new Error('status takes no arguments')
    const status = await managedStatus()
    console.log(JSON.stringify(status, null, 2))
    return status.healthy ? 0 : 1
  }
  if (args[0] === 'stop') {
    if (args.length !== 1) throw new Error('stop takes no arguments')
    console.log(JSON.stringify(await stopManaged(), null, 2))
    return 0
  }
  if (args[0] === 'setup') {
    const options = new Set(args.slice(1))
    for (const option of options) {
      if (option !== '--check' && option !== '--json') throw new Error(`unknown setup option ${JSON.stringify(option)}`)
    }
    if (options.has('--json') && !options.has('--check')) throw new Error('--json requires --check')
    if (options.has('--check')) {
      const report = await checkEnvironment({ includeProfile: process.env.EMATE_STAGING_CHECK !== '1' })
      printCheckReport(report, options.has('--json'))
      return report.ok ? 0 : 1
    }
    return setup()
  }
  throw new Error(`unknown command ${JSON.stringify(args[0])}; run e-mate --help`)
}
