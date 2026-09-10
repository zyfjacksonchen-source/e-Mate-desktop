import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { unzipSync } from 'fflate'
import { parse as parseYaml } from 'yaml'
import { Context } from '../../../upstream/deepseek-harness/vendor/cordis/lib/index.js'
import AgentRegistry, { Inbox } from '../../../upstream/deepseek-harness/packages/core/agent/lib/index.js'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '../../../upstream/deepseek-harness/packages/core/session/lib/index.js'
import { LocalAttachmentStore } from '../../../upstream/deepseek-harness/packages/attachment/attachment-local/lib/index.js'
import LocalJobRegistry from '../../../upstream/deepseek-harness/packages/jobs/jobs-local/lib/index.js'
import { validateJsonSchemaValue } from '../../../upstream/deepseek-harness/packages/core/tools/lib/index.js'
import { FileSettingsProvider } from '../../../upstream/deepseek-harness/packages/settings/settings-file/lib/index.js'

import {
  HARNESS_COMMIT,
  HARNESS_VERSION,
  VERSION,
  checkEnvironment,
  managedStatus,
  nodeVersionSupported,
  platformSupported,
  resolveHarness,
  resolveHarnessModule,
} from '../lib/e-mate.js'
import { installTestProfile as installProfile } from './runtime-binding.fixture.mjs'
import { apply as applyHealth } from '../profile/plugins/health.js'
import { apply as applyShare, SHARE_CHANNEL } from '../profile/plugins/share.js'
import { apply as applyGeneralWorkspace } from '../profile/plugins/general-workspace.js'
import * as settingsDocumentBoundary from '../profile/plugins/settings-document-boundary.js'
import { apply as applyAgentOperations, expertModeActive, expertModeRequest } from '../profile/plugins/agent-operations.js'
import { apply as applyShell } from '../profile/plugins/emate-shell/index.js'
import { apply as applyCapabilities, CAPABILITIES_CHANNEL } from '../profile/plugins/capabilities.js'
import { apply as applyQrGeneration } from '../profile/plugins/qr-generation.js'
import {
  CredentialStore,
  checkOsCredentialBackend,
  createOsCredentialBackend,
  runCommand,
} from '../profile/plugins/credentials-os.js'
import {
  apply as applyModelPolicy,
  createQuotaService,
  filterGroups,
  MODEL_POLICY_CHANNEL,
  validateModelPolicy,
} from '../profile/plugins/model-policy.js'
import { apply as applyAudit, AUDIT_CHANNEL, createTaskAuditFact, createUsageFact, imageBatchAuditCorrelation } from '../profile/plugins/audit.js'
import {
  apply as applyIdentity,
  createEnterpriseIdentityProvider,
  ENTERPRISE_KEEP_ALIVE_MS,
  IDENTITY_CHANNEL,
  MODEL_SESSION_REF,
} from '../profile/plugins/identity/index.js'
import {
  agreementBundleSha256,
  agreementDocuments,
  describeAgreements,
  requiredAcknowledgements,
} from '../profile/plugins/identity/agreements.js'
const fileDigest = path => createHash('sha256').update(readFileSync(path)).digest('hex')

function writeAuditRuntimeBinding(temporary) {
  const harness = resolveHarness()
  const toolsModule = resolveHarnessModule(harness, 'packages/core/tools', '@deepseek-ai/dsh-tools')
  const storageDomainModule = resolveHarnessModule(
    harness,
    'packages/storage/storage-domain',
    '@deepseek-ai/dsh-storage-domain',
  )
  const zodModule = realpathSync(new URL(
    '../../../upstream/deepseek-harness/packages/storage/storage-domain/node_modules/zod/index.js',
    import.meta.url,
  ))
  const bindingPath = join(temporary, 'runtime-binding.json')
  writeFileSync(bindingPath, JSON.stringify({
    schema_version: 1,
    product: 'e-Mate',
    version: VERSION,
    dsh_home: join(temporary, 'dsh-home'),
    harness_commit: HARNESS_COMMIT,
    tools_module: toolsModule,
    tools_module_sha256: fileDigest(toolsModule),
    storage_domain_module: storageDomainModule,
    storage_domain_module_sha256: fileDigest(storageDomainModule),
    zod_module: zodModule,
    zod_module_sha256: fileDigest(zodModule),
  }))
  return bindingPath
}

test('resolved Harness modules use source builds and file URLs for Windows ESM imports', () => {
  const source = readFileSync(new URL('../src/e-mate.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /import\(harnessRequire\.resolve\(/)
  assert.equal(source.match(/import\(pathToFileURL\(resolveHarnessModule\(/g)?.length, 3)
  const root = resolve(new URL('../../../upstream/deepseek-harness/', import.meta.url).pathname)
  assert.equal(resolveHarnessModule({ bin: join(root, 'apps', 'cli', 'lib', 'bin.js') },
    'packages/storage/storage-domain', '@deepseek-ai/dsh-storage-domain'),
  join(root, 'packages', 'storage', 'storage-domain', 'lib', 'index.js'))
})

test('Computer Use composes one cross-platform Profile row without a candidate plugin layer', () => {
  const root = new URL('../../dsh-plugin-computer-use/', import.meta.url)
  const patchSource = readFileSync(new URL('cordis.patch.yml', root), 'utf8')
  const patch = parseYaml(patchSource)
  assert.match(patchSource, /process\.platform === 'win32' \? 'hidden' : 'visible'/u)
  const build = readFileSync(new URL('scripts/build.mjs', root), 'utf8')
  assert.doesNotMatch(build, /executablePath\?: string|processStartTime\?: string|windowId\?: number/u)
  const rows = patch.flatMap(entry => entry.insert ?? []).filter(entry => entry.id === 'emate-computer-use')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, '@e-mate/dsh-plugin-computer-use')
  const source = readFileSync(new URL('src/windows.ts', root), 'utf8')
  for (const excluded of ['upstream/plugins/computer-user/src/index.js', 'computer_set_mode', 'node:child_process']) {
    assert.equal(source.includes(excluded), false)
  }
})

test('identity mutations restore the native route only after validated login or agreement acceptance', () => {
  const source = readFileSync(new URL('../profile/plugins/emate-shell/src/client/identity.tsx', import.meta.url), 'utf8')
  const login = source.slice(source.indexOf('  const login = async'), source.indexOf('  const issueChallenge'))
  const acceptance = source.slice(source.indexOf('  const accept = async'), source.indexOf("  if (mode === 'unlocked') return null"))
  const loginValidation = login.indexOf('validBootstrap(result.value)')
  const loginRestore = login.indexOf("result.value.workspace_unlocked ? returnPath : '/agreement'")
  const loginReload = login.indexOf('location.reload()')
  assert.ok(loginValidation >= 0 && loginRestore > loginValidation && loginReload > loginRestore)
  const acceptanceValidation = acceptance.indexOf('validBootstrap(result.value)')
  const acceptanceRestore = acceptance.indexOf("history.replaceState(null, '', returnPath)")
  const acceptanceReload = acceptance.indexOf('location.reload()')
  assert.ok(acceptanceValidation >= 0 && acceptanceRestore > acceptanceValidation && acceptanceReload > acceptanceRestore)
  assert.doesNotMatch(login, /setState\(result\.value\)/)
  assert.doesNotMatch(acceptance, /setState\(result\.value\)/)
  assert.match(source, /addEventListener\('popstate', sync\)/)
  assert.match(source, /removeEventListener\('popstate', sync\)/)
})

test('settings URL is a lifecycle projection over the target SettingsRoot state', () => {
  const source = readFileSync(new URL('../profile/plugins/emate-shell/src/client/settings-chrome.tsx', import.meta.url), 'utf8')
  const sidebar = readFileSync(new URL('../profile/plugins/emate-shell/src/client/sidebar.tsx', import.meta.url), 'utf8')
  const shell = readFileSync(new URL('../profile/plugins/emate-shell/src/client/index.ts', import.meta.url), 'utf8')
  assert.match(source, /dataset\.emateSettingsTrigger/)
  assert.match(source, /data-emate-settings-close/)
  assert.match(source, /data-emate-settings-content/)
  assert.match(sidebar, /data-emate-mobile-open/)
  assert.match(sidebar, /ref=\{mobileOpen\}/)
  assert.match(sidebar, /onClick=\{toggleSidebar\}/)
  const settingsBoundary = "if (pathname === '/settings') return <>{renderSlot('sidebar.settings', { wide })}</>"
  assert.ok(sidebar.indexOf(settingsBoundary) >= 0 && sidebar.indexOf(settingsBoundary) < sidebar.indexOf('const mobileLayer'))
  assert.doesNotMatch(sidebar, /data-emate-settings-(?:content|trigger)|MutationObserver|requestAnimationFrame|cancelAnimationFrame|syncSettingsRoute|retryFrames|awaitingTarget|restartForLayout|scheduleRetry/)
  assert.doesNotMatch(shell, /e-mate-settings-route|SettingsRouteProjection/)
  assert.match(source, /new MutationObserver/)
  assert.match(source, /addEventListener\('popstate', syncPanel\)/)
  assert.match(source, /removeEventListener\('popstate', syncPanel\)/)
  assert.match(source, /const SETTINGS_RETURN_KEY = 'eMateSettingsReturn'/)
  assert.match(source, /history\.pushState\(\{ \[SETTINGS_RETURN_KEY\]: returnPath, [^\n]+\}, '', SETTINGS_PATH\)/)
  assert.match(source, /const returnPath = history\.state\?\.\[SETTINGS_RETURN_KEY\]/)
  assert.match(source, /history\.replaceState\(null, '', typeof returnPath === 'string' \? returnPath : '\/'\)/)
  assert.doesNotMatch(source, /history\.back\(\)/)
  assert.doesNotMatch(source, /\buseState\b|\b(?:fetch|WebSocket|EventSource)\s*\(/)
  assert.doesNotMatch(sidebar, /\b(?:fetch|WebSocket|EventSource)\s*\(/)
})

test('browser profile keeps settings storage but exposes no native document action', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e-mate-settings-boundary-'))
  const path = join(root, 'settings.yaml')
  const context = new Context()
  const settings = context.plugin(FileSettingsProvider, { path, watch: false })
  await settings
  const boundary = context.plugin(settingsDocumentBoundary)
  await boundary
  try {
    assert.equal(context.settings.writable, true)
    assert.equal(context.settings.documentPath, undefined)
    assert.equal(await context.settings.prepareDocument(), undefined)
    assert.equal(existsSync(path), false)
  } finally {
    await boundary.dispose()
    assert.equal(context.settings.documentPath, path)
    await settings.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})


test('version gates match the release contract', () => {
  assert.equal(nodeVersionSupported('22.18.0'), false)
  assert.equal(nodeVersionSupported('22.19.0'), true)
  assert.equal(nodeVersionSupported('23.9.0'), false)
  assert.equal(nodeVersionSupported('24.0.0'), true)
  assert.equal(platformSupported('darwin', 'arm64'), true)
  assert.equal(platformSupported('darwin', 'x64'), true)
  assert.equal(platformSupported('win32', 'x64'), true)
  assert.equal(platformSupported('linux', 'x64'), false)
  const libFiles = readdirSync(new URL('../lib/', import.meta.url))
  for (const stem of ['e-mate', 'legacy-migration', 'legacy-schedule']) {
    assert.equal(libFiles.filter(name => name.startsWith(`${stem}-`) && name.endsWith('.js')).length, 1)
  }
})

test('runtime resolves only the exact Harness source', () => {
  const source = readFileSync(new URL('../src/e-mate.ts', import.meta.url), 'utf8')
  const packaged = source.slice(source.indexOf('function harnessFromPackage()'), source.indexOf('export function resolveHarness()'))
  for (const field of ['conversation_adapter_sha256', 'conversation_client_sha256']) assert.ok(packaged.includes(field))
  assert.match(packaged, /throw new Error\('e-Mate packaged conversation adapter provenance is missing or mismatched'\)/u)
  const runtime = resolveHarness()
  assert.equal(HARNESS_COMMIT, '4da69d7c3522ee51de12822c917c503a124f7a7d')
  assert.equal(runtime.version, HARNESS_VERSION)
  assert.equal(runtime.commit, HARNESS_COMMIT)
  assert.ok(['development-source', 'packaged-runtime'].includes(runtime.source))
  assert.equal(
    JSON.parse(readFileSync(new URL('../profile/plugins/emate-shell/package.json', import.meta.url), 'utf8')).eMate.harnessCommit,
    HARNESS_COMMIT,
  )
  assert.match(readFileSync(new URL('../THIRD_PARTY_NOTICES.txt', import.meta.url), 'utf8'), new RegExp(HARNESS_COMMIT, 'u'))
})

test('managed profile installation is idempotent', () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'e-mate-profile-'))
  try {
    const first = installProfile(dshHome)
    assert.equal(existsSync(join(first.data, 'general')), true)
    const manifest = readFileSync(join(first.profile, 'package.json'), 'utf8')
    const profileManifest = JSON.parse(manifest)
    assert.equal(profileManifest.type, 'module')
    const pluginPackages = [
      '@e-mate/dsh-plugin-canvas',
      '@e-mate/dsh-plugin-pet',
      '@e-mate/dsh-plugin-knowledge',
      '@e-mate/dsh-plugin-skill-hub',
      '@e-mate/dsh-plugin-better-sidebar',
      '@e-mate/dsh-plugin-cdp',
      '@e-mate/dsh-plugin-computer-use',
      '@e-mate/dsh-plugin-file-import',
      '@e-mate/dsh-plugin-find-skill',
      '@e-mate/dsh-plugin-genui',
      '@e-mate/dsh-plugin-glass-composer',
      '@e-mate/dsh-plugin-mcp-manage',
      '@e-mate/dsh-plugin-memory-evolve',
      '@e-mate/dsh-plugin-office-skills',
      '@e-mate/dsh-plugin-schedules',
      '@e-mate/dsh-plugin-tool-search',
      '@e-mate/dsh-plugin-tidychat',
      '@e-mate/dsh-plugin-imagegen',
    ]
    assert.deepEqual(profileManifest.dsh.profile.bundles, [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...pluginPackages,
    ])
    assert.deepEqual(profileManifest.dependencies, Object.fromEntries(pluginPackages.map(name => [name, '2.0.18'])))
    const patch = readFileSync(join(first.profile, 'cordis.patch.yml'), 'utf8')
    installProfile(dshHome)
    assert.equal(readFileSync(join(first.profile, 'package.json'), 'utf8'), manifest)
    assert.equal(readFileSync(join(first.profile, 'cordis.patch.yml'), 'utf8'), patch)
    profileManifest.dependencies['@e-mate/dsh-plugin-im'] = '2.0.8'
    profileManifest.dependencies['@e-mate/dsh-plugin-idesign'] = '2.0.12'
    profileManifest.dependencies['@e-mate/dsh-plugin-search-mcp'] = '2.0.11'
    profileManifest.dependencies['@e-mate/dsh-plugin-xin-assistant'] = '2.0.10'
    profileManifest.dependencies['@yuxianglin/dsh-bridge-browser'] = '0.0.1'
    const retiredXin = join(first.profile, 'node_modules', '@e-mate', 'dsh-plugin-xin-assistant')
    const retiredIDesign = join(first.profile, 'node_modules', '@e-mate', 'dsh-plugin-idesign')
    const retiredSearchMcp = join(first.profile, 'node_modules', '@e-mate', 'dsh-plugin-search-mcp')
    mkdirSync(retiredXin, { recursive: true })
    writeFileSync(join(retiredXin, 'stale.txt'), 'retired')
    mkdirSync(retiredIDesign, { recursive: true })
    writeFileSync(join(retiredIDesign, 'stale.txt'), 'retired')
    mkdirSync(retiredSearchMcp, { recursive: true })
    writeFileSync(join(retiredSearchMcp, 'stale.txt'), 'retired')
    profileManifest.dsh.profile.bundles.push(
      '@e-mate/dsh-plugin-im',
      '@e-mate/dsh-plugin-idesign',
      '@e-mate/dsh-plugin-search-mcp',
      '@e-mate/dsh-plugin-xin-assistant',
      '@yuxianglin/dsh-bridge-browser',
    )
    writeFileSync(join(first.profile, 'package.json'), `${JSON.stringify(profileManifest, null, 2)}\n`)
    installProfile(dshHome)
    const repairedManifest = JSON.parse(readFileSync(join(first.profile, 'package.json'), 'utf8'))
    assert.equal(repairedManifest.dependencies['@e-mate/dsh-plugin-im'], undefined)
    assert.equal(repairedManifest.dependencies['@e-mate/dsh-plugin-idesign'], undefined)
    assert.equal(repairedManifest.dependencies['@e-mate/dsh-plugin-search-mcp'], undefined)
    assert.equal(repairedManifest.dependencies['@e-mate/dsh-plugin-xin-assistant'], undefined)
    assert.equal(repairedManifest.dependencies['@yuxianglin/dsh-bridge-browser'], undefined)
    assert.equal(repairedManifest.dsh.profile.bundles.includes('@e-mate/dsh-plugin-im'), false)
    assert.equal(repairedManifest.dsh.profile.bundles.includes('@e-mate/dsh-plugin-idesign'), false)
    assert.equal(repairedManifest.dsh.profile.bundles.includes('@e-mate/dsh-plugin-search-mcp'), false)
    assert.equal(repairedManifest.dsh.profile.bundles.includes('@e-mate/dsh-plugin-xin-assistant'), false)
    assert.equal(repairedManifest.dsh.profile.bundles.includes('@yuxianglin/dsh-bridge-browser'), false)
    assert.equal(existsSync(retiredXin), false)
    assert.equal(existsSync(retiredIDesign), false)
    assert.equal(existsSync(retiredSearchMcp), false)
    const patchRows = parseYaml(patch).flatMap(operation => operation.insert ?? (operation.id ? [operation] : []))
    const patchById = new Map(patchRows.map(row => [row.id, row]))
    assert.deepEqual(patchById.get('credentials'), {
      id: 'credentials',
      name: '@deepseek-ai/dsh-credentials-local',
      disabled: true,
    })
    assert.equal(patchById.get('emate-credentials-os').name, './plugins/credentials-os.js')
    assert.equal(patchById.has('emate-connections'), false)
    assert.deepEqual(patchById.get('emate-qr-generation'), {
      id: 'emate-qr-generation',
      name: './plugins/qr-generation.js',
      inject: ['tools', 'jobs', 'attachments'],
    })
    assert.deepEqual(patchById.get('ui-settings-models'), {
      id: 'ui-settings-models',
      name: '@deepseek-ai/dsh-client-ui-settings-models',
      disabled: true,
    })
    assert.deepEqual(patchById.get('ui-agent-preset'), {
      id: 'ui-agent-preset',
      name: '@deepseek-ai/dsh-client-ui-agent-preset',
      disabled: false,
    })
    assert.deepEqual(patchById.get('ui-trajectory'), {
      id: 'ui-trajectory',
      name: '@deepseek-ai/dsh-client-ui-trajectory',
      disabled: true,
    })
    assert.equal(patchById.get('agent-presets').config.default, 'code')
    assert.equal(patchById.get('sandbox-policy').config.mode, 'danger-full-access')
    assert.equal(patchById.get('approval').config.policy, 'never')
    assert.equal(patchById.get('permission').config.defaultPreset, 'danger-full-access')
    assert.deepEqual(patchById.get('web').config, { searchProvider: 'deepseek-official' })
    assert.deepEqual(patchById.get('web-search-deepseek'), {
      id: 'web-search-deepseek',
      disabled: false,
      config: {
        apiKeyEnv: 'E_MATE_SEARCH_KEY_DEEPSEEK',
        baseURL: 'https://api.deepseek.com/anthropic/v1',
        model: 'deepseek-v4-flash',
      },
    })
    assert.deepEqual(patchById.get('tool-web'), {
      id: 'tool-web',
      disabled: false,
      config: { fetch: false, searchTimeoutMs: 60000, searchMaxResults: 50 },
    })
    assert.equal(patchById.has('search-mcp'), false)
    assert.equal(patchById.get('llm-deepseek').disabled, true)
    assert.deepEqual(patchById.get('agent-default-model').config, {
      provider: 'e-mate-enterprise',
      model: 'gpt-5.6-luna',
    })
    assert.equal(patchById.get('agent-loop').config.maxParallelToolCalls, 4)
    assert.deepEqual(patchById.get('llm-pi-ai').config.providers, {})
    assert.equal(patchById.get('emate-general-workspace').name, './plugins/general-workspace.js')
    assert.deepEqual(patchById.get('emate-settings-document-boundary'), {
      id: 'emate-settings-document-boundary',
      name: './plugins/settings-document-boundary.js',
      inject: ['settings'],
    })
    assert.equal(patchById.get('schedule').name, '@deepseek-ai/dsh-schedule')
    assert.equal(patchById.get('emate-schedule-import').name, './plugins/schedule-import.js')
    assert.equal(patchById.has('emate-schedules'), false)
    assert.equal(patchById.get('emate-legacy-migration').name, './plugins/legacy-migration.js')
    assert.equal(patchById.get('emate-model-policy').name, './plugins/model-policy.js')
    assert.deepEqual(patchById.get('emate-model-policy').inject, [
      'apiProxy', 'connection', 'credentials', 'settings', 'storageDomain', 'llm', 'emateIdentity',
    ])
    assert.equal(patchById.get('emate-identity').config.enterprise.clientId, 'e-mate-web')
    assert.equal(patchById.get('emate-identity').config.enterprise.organization, 'emate-v2')
    assert.equal(patchById.get('emate-share').name, './plugins/share.js')
    assert.deepEqual(patchById.get('emate-share').inject, ['apiProxy', 'connection', 'credentials'])
    assert.equal(patchById.get('emate-share').config.rootUrl, 'https://mvdcm.ecoremedia.net/e-mate/share')
    assert.equal(patchById.get('emate-audit').name, './plugins/audit.js')
    assert.deepEqual(patchById.get('emate-audit').inject, [
      'connection', 'sessionPersistence', 'storageDomain', 'timer', 'tools', 'emateModelPolicy', 'emateIdentity',
    ])
    assert.equal(patchById.get('emate-agent-operations').name, './plugins/agent-operations.js')
    assert.deepEqual(patchById.get('emate-agent-operations').inject, ['systemPrompt', 'connection', 'sessions'])
    assert.equal(patchById.has('ui-sidebar'), false)
    assert.equal(patchById.has('emate-shell'), false)
    assert.match(patch, /\.\/plugins\/health\.js/)
    assert.match(patch, /id: emate-general-workspace[\s\S]*\.\/plugins\/general-workspace\.js[\s\S]*inject: \[workspaceRegistry\]/)
    assert.match(patch, /id: emate-identity[\s\S]*\.\/plugins\/identity\/index\.js/)
    assert.match(patch, /id: emate-capabilities[\s\S]*\.\/plugins\/capabilities\.js/)
    assert.doesNotMatch(patch, /emate-connections|plugins\/connections\.js/)
    assert.match(patch, /id: emate-qr-generation[\s\S]*\.\/plugins\/qr-generation\.js[\s\S]*inject: \[tools, jobs, attachments\]/)
    assert.match(patch, /id: emate-agent-operations[\s\S]*\.\/plugins\/agent-operations\.js/)
    assert.doesNotMatch(patch, /emate-skill-hub-agent|plugins\/skill-hub-agent\.js/)
    assert.doesNotMatch(patch, /emate-(?:office-ocr|browser-computer-use|memory|dream|learning)/)
    assert.match(patch, /id: emate-model-policy[\s\S]*\.\/plugins\/model-policy\.js[\s\S]*inject: \[apiProxy, connection, credentials, settings, storageDomain, llm, emateIdentity\]/)
    assert.match(patch, /id: emate-audit[\s\S]*\.\/plugins\/audit\.js[\s\S]*inject: \[connection, sessionPersistence, storageDomain, timer, tools, emateModelPolicy, emateIdentity\]/)
    assert.equal(patchById.has('emate-image-generation'), false)
    assert.equal(patchById.get('emate-imagegen').config.rootUrl, 'https://mvdcm.ecoremedia.net/e-mate/model-api/v1')
    assert.deepEqual(patchById.get('emate-image-history').inject, ['sessionProjections', 'sessionProjectionCache', 'sessionPersistence'])
    assert.match(patch, /id: emate-legacy-migration[\s\S]*\.\/plugins\/legacy-migration\.js[\s\S]*inject: \[sessionPersistence, webServer\]/)
    assert.match(patch, /id: emate-schedule-import[\s\S]*\.\/plugins\/schedule-import\.js[\s\S]*inject: \[tools\]/)
    assert.ok(readFileSync(join(first.profile, 'plugins', 'agent-operations.js')).byteLength > 0)
    const schedules = readFileSync(join(first.profile, 'node_modules', '@e-mate', 'dsh-plugin-schedules', 'lib', 'index.js'), 'utf8')
    assert.match(schedules, /\/emate\.schedules/u)
    assert.match(schedules, /foldScheduleEvents/u)
    assert.ok(readFileSync(join(first.profile, 'plugins', 'capabilities.js')).byteLength > 0)
    assert.ok(readFileSync(join(first.profile, 'plugins', 'general-workspace.js')).byteLength > 0)
    assert.ok(readFileSync(join(first.profile, 'plugins', 'settings-document-boundary.js')).byteLength > 0)
    const qrGeneration = readFileSync(join(first.profile, 'plugins', 'qr-generation.js'), 'utf8')
    assert.match(qrGeneration, /e_mate_qr_generate/)
    assert.match(qrGeneration, /ctx\.jobs\.start/)
    assert.match(qrGeneration, /attachments\.saveImage/)
    assert.doesNotMatch(qrGeneration, /from ["']qrcode["']/)
    const credentials = readFileSync(join(first.profile, 'plugins', 'credentials-os.js'), 'utf8')
    assert.match(credentials, /loadTargetCredentials/)
    assert.match(credentials, /DataProtectionScope\]::CurrentUser/)
    assert.match(credentials, /find-generic-password/)
    assert.doesNotMatch(credentials, /ctx\.connection|\.credentials\.yaml/)
    for (const name of pluginPackages) {
      const pluginRoot = join(first.profile, 'node_modules', ...name.split('/'))
      const pluginManifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
      assert.equal(pluginManifest.name, name)
      assert.equal(pluginManifest.version, '2.0.18')
      assert.ok(readFileSync(join(pluginRoot, pluginManifest.main)).byteLength > 0)
      const pluginPatch = readFileSync(join(pluginRoot, pluginManifest.dsh.bundle.patch), 'utf8')
      assert.ok(pluginPatch.length >= 2)
      const patchBody = pluginPatch.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#')).join('\n')
      if (patchBody !== '[]') {
        if (pluginManifest.dsh?.client?.platform === 'web') {
          assert.ok(pluginPatch.includes(`name: '${name}'`))
        } else {
          assert.ok(pluginPatch.includes(`name: './node_modules/${name}/${pluginManifest.main}'`))
          assert.doesNotMatch(pluginPatch, new RegExp(`name: '${name}'`, 'u'))
        }
      }
    }
    assert.equal(existsSync(join(first.profile, 'plugins', 'image-generation.js')), false)
    const imageGeneration = readFileSync(join(first.profile, 'node_modules', '@e-mate', 'dsh-plugin-imagegen', 'lib', 'index.js'), 'utf8')
    assert.match(imageGeneration, /generate_image/)
    assert.match(imageGeneration, /edit_image/)
    assert.match(imageGeneration, /emateIdentity/)
    assert.match(imageGeneration, /emateModelPolicy/)
    const legacyMigration = readFileSync(join(first.profile, 'plugins', 'legacy-migration.js'), 'utf8')
    assert.match(legacyMigration, /sessionPersistence/)
    assert.match(legacyMigration, /legacy-sessions-v1\.json/)
    assert.doesNotMatch(legacyMigration, /WebSocket|EventSource/)
    const scheduleImport = readFileSync(join(first.profile, 'plugins', 'schedule-import.js'), 'utf8')
    assert.match(scheduleImport, /e_mate_schedule_import_list/)
    assert.match(scheduleImport, /e_mate_schedule_import_enable/)
    assert.match(scheduleImport, /schedule_list/)
    assert.match(scheduleImport, /schedule_create/)
    const binding = JSON.parse(readFileSync(join(first.profile, 'plugins', 'runtime-binding.json'), 'utf8'))
    assert.match(binding.storage_domain_module_sha256, /^[0-9a-f]{64}$/)
    assert.match(binding.llm_module_sha256, /^[0-9a-f]{64}$/)
    assert.match(binding.compaction_module_sha256, /^[0-9a-f]{64}$/)
    assert.match(binding.schedule_module_sha256, /^[0-9a-f]{64}$/)
    assert.match(binding.credentials_module_sha256, /^[0-9a-f]{64}$/)
    assert.match(binding.launch_environment_module_sha256, /^[0-9a-f]{64}$/)
    const dumped = spawnSync(process.execPath, [
      new URL('../lib/bin.js', import.meta.url).pathname,
      '--profile', 'e-mate', '--dump-config',
    ], {
      cwd: dshHome,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DEEPSEEK_SEARCH_BASE_URL: 'https://environment-override.invalid/anthropic/v1',
      },
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
    assert.equal(dumped.status, 0, dumped.stderr)
    assert.match(dumped.stdout, /- id: credentials\n  name: '@deepseek-ai\/dsh-credentials-local'\n  disabled: true/)
    assert.match(dumped.stdout, /- id: emate-credentials-os\n  name: \.\/plugins\/credentials-os\.js/)
    assert.match(dumped.stdout, /- id: ui-trajectory\n  name: '@deepseek-ai\/dsh-client-ui-trajectory'\n  disabled: true/)
    assert.match(dumped.stdout, /- id: web\n  name: '@deepseek-ai\/dsh-web'\n  config:\n    searchProvider: deepseek-official/)
    assert.match(dumped.stdout, /- id: web-search-deepseek\n  name: '@deepseek-ai\/dsh-web-search-deepseek'\n  config:\n    apiKeyEnv: E_MATE_SEARCH_KEY_DEEPSEEK\n    baseURL: https:\/\/api\.deepseek\.com\/anthropic\/v1\n    model: deepseek-v4-flash\n  disabled: false/)
    assert.doesNotMatch(dumped.stdout, /environment-override\.invalid/)
    assert.match(dumped.stdout, /- id: tool-web\n  name: '@deepseek-ai\/dsh-tool-web'\n  config:\n    fetch: false\n    searchTimeoutMs: 60000\n    searchMaxResults: 50\n  disabled: false/)
    assert.doesNotMatch(dumped.stdout, /- id: search-mcp\b|TAVILY_API_KEY/)
    assert.doesNotMatch(dumped.stdout, /- id: credentials\n  name: '@deepseek-ai\/dsh-credentials-local'\n(?!  disabled: true)/)
    assert.doesNotMatch(dumped.stdout, /- id: ui-trajectory\n  name: '@deepseek-ai\/dsh-client-ui-trajectory'\n(?!  disabled: true)/)
    assert.match(binding.zod_module_sha256, /^[0-9a-f]{64}$/)
    const shell = join(first.profile, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar')
    const shellManifest = JSON.parse(readFileSync(join(shell, 'package.json'), 'utf8'))
    assert.deepEqual(shellManifest.dsh.client.inject, [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-input-trigger',
      '@deepseek-ai/dsh-client-ui-attachment',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-session-log-export',
    ])
    const client = readFileSync(join(shell, 'lib', 'client.js'), 'utf8')
    assert.match(client, /window\.__ModuleLoader__\.load\(\s*\{/)
    assert.match(client, /\bid:\s*["']@deepseek-ai\/dsh-client-ui-sidebar["']/)
    assert.match(client, /data-emate-home-hero/)
    assert.match(client, /data-chain-overlay-fallback/)
    assert.match(client, /ctx\.slots\.inject\(["']shell\.overlay["']/)
    assert.match(client, /welcome-notice/)
    assert.doesNotMatch(client, /deepseek-official/)
    assert.match(client, /priority:\s*-1/)
    assert.match(client, /e-mate-identity-gate/)
    assert.match(client, /e-mate-user-center/)
    assert.match(client, /data-emate-settings-header/)
    assert.match(client, /ctx\.slots\.inject\(["']settings\.section["']/)
    assert.match(client, /ctx\.slots\.inject\(["']settings\.action["']/)
    assert.match(client, /identity\.bootstrap/)
    assert.match(client, /verification\.issue/)
    assert.match(client, /session\.register/)
    assert.match(client, /remember_login/)
    assert.match(client, /真实姓名/)
    assert.match(client, /保持登录/)
    assert.match(client, /session\.logout/)
    assert.match(client, /session\.password/)
    assert.match(client, /\.inert\s*=\s*true/)
    assert.match(client, /外部连接/)
    const skillHubRoot = join(first.profile, 'node_modules', '@e-mate', 'dsh-plugin-skill-hub')
    const skillHubClient = readFileSync(join(skillHubRoot, 'lib', 'client.js'), 'utf8')
    assert.match(skillHubClient, /e-mate-capabilities-entry/)
    assert.match(skillHubClient, /data-emate-capabilities/)
    assert.match(skillHubClient, /\/emate\.capabilities/)
    assert.match(skillHubClient, /\/emate\.skillHub/)
    assert.match(skillHubClient, /catalog\.search/)
    assert.match(skillHubClient, /skills\.publish/)
    assert.match(skillHubClient, /\/capabilities/)
    assert.match(skillHubClient, /保存 ZIP/)
    assert.match(client, /emate\/legacy-artifacts/)
    assert.match(client, /conversationEvents\.register/)
    assert.match(client, /legacy-artifact\.download/)
    assert.doesNotMatch(client, /e-mate-activity-group|data-emate-activity-header|e-mate-message-disclosure/)
    const capabilities = readFileSync(new URL('../../dsh-plugin-skill-hub/src/client/capabilities.tsx', import.meta.url), 'utf8')
    assert.match(capabilities, /icons\[capability\.icon_key\]/)
    assert.match(capabilities, /社区 Skill 暂时不可用；内置能力仍可正常使用。/)
    assert.doesNotMatch(capabilities, /capability\.(?:id|title)\s*===|switch\s*\(\s*capability\.(?:id|title)/)
    assert.doesNotMatch(capabilities, /\b(?:fetch|WebSocket|EventSource)\s*\(/)
    const connectionsUi = readFileSync(new URL('../profile/plugins/emate-shell/src/client/composer-connectors.tsx', import.meta.url), 'utf8')
    assert.match(connectionsUi, /data-emate-composer-connectors/)
    assert.match(connectionsUi, /loadConnections/)
    assert.match(connectionsUi, /prepareDraft/)
    assert.doesNotMatch(connectionsUi, /openConnections/)
    assert.match(connectionsUi, /外部连接状态/)
    assert.doesNotMatch(connectionsUi, /打开外部连接能力中心/)
    assert.doesNotMatch(connectionsUi, /\b(?:fetch|WebSocket|EventSource)\s*\(/)
    const sessionRoute = readFileSync(new URL('../profile/plugins/emate-shell/src/client/session-route.tsx', import.meta.url), 'utf8')
    assert.match(sessionRoute, /state\.phase !== ['"]ready['"]/) // waits for the target list baseline
    assert.match(sessionRoute, /Object\.prototype\.hasOwnProperty\.call\(state\.byId, id\)/)
    assert.match(sessionRoute, /openSession\(id\)/)
    assert.doesNotMatch(sessionRoute, /startHomeSession\(\)/)
    assert.doesNotMatch(sessionRoute, /clearSession\(\)/)
    assert.match(sessionRoute, /\/chat\/\$\{encodeURIComponent\(current\)\}/)
    assert.doesNotMatch(sessionRoute, /\b(?:fetch|WebSocket|EventSource|createSnapshotStore|defineStore)\b/)
    const home = readFileSync(new URL('../profile/plugins/emate-shell/src/client/home.tsx', import.meta.url), 'utf8')
    const homeCss = readFileSync(new URL('../profile/plugins/emate-shell/src/client/home.module.css', import.meta.url), 'utf8')
    assert.match(home, /data-emate-home/)
    assert.match(home, /<QuickTemplates prepareDraft=\{prepareTemplateDraft\} \/>/)
    assert.doesNotMatch(home, /\b(?:createPortal|querySelector|MutationObserver)\b/)
    const heroOverlayRule = homeCss.match(/:global\(\[data-phase='hero'\] \[data-chain-overlay-fallback='conversation\.composer'\] > div\) \{([^}]*)\}/)?.[1]
    assert.ok(heroOverlayRule)
    assert.match(heroOverlayRule, /gap:\s*12px !important;/)
    assert.match(heroOverlayRule, /padding:\s*8px 16px 14px !important;/)
    assert.match(homeCss, /:global\(\[data-phase='hero'\] \[data-composer-seat\]\) \{\s*padding-bottom:\s*32px;/)
    assert.match(homeCss, /:global\(\[data-phase='active'\] \[data-emate-composer-frame-host\]\) \{\s*align-self:\s*center;\s*width:\s*min\(var\(--dsh-composer-card-max-width\), 100%\);/)
    const frameRule = homeCss.match(/:global\(\[data-emate-composer-frame-host\]\) \{([^}]*)\}/)?.[1]
    assert.ok(frameRule)
    assert.match(frameRule, /border:\s*2px solid var\(--emate-color-rule\);/)
    assert.match(frameRule, /border-radius:\s*var\(--emate-composer-frame-radius\);/)
    const workspaceRule = homeCss.match(/:global\(\[data-emate-composer-frame-host\] > :has\(> \[data-slot='conversation\.hero\.workspace'\]\)\) \{([^}]*)\}/)?.[1]
    assert.ok(workspaceRule)
    assert.match(workspaceRule, /border-top:\s*1px solid var\(--emate-color-rule\);/)
    const framedCardRule = homeCss.match(/:global\(\[data-emate-composer-frame-host\] \[data-composer-card\]\) \{([^}]*)\}/)?.[1]
    assert.ok(framedCardRule)
    assert.match(framedCardRule, /border:\s*0 !important;/)
    assert.match(framedCardRule, /border-radius:\s*0 !important;/)
    assert.match(framedCardRule, /background:\s*transparent !important;/)
    assert.match(homeCss, /:global\(\[data-emate-composer-frame-host\] \[data-composer-card\]\)::after \{\s*content:\s*none !important;/)
    assert.match(homeCss, /min-height:\s*44px/)
    assert.doesNotMatch(homeCss, /> div > div:first-of-type/)
    const chatCss = readFileSync(new URL('../profile/plugins/emate-shell/src/client/chat-chrome.module.css', import.meta.url), 'utf8')
    assert.doesNotMatch(chatCss, /data-turn-tail|data-emate-activity/)
    assert.doesNotMatch(chatCss, /data-chat-flow-kind='(?:steering|model-retry|turn-error|command)'/)
    assert.match(chatCss, /--dsw-font-markdown-base:\s*14px\/22px/)
    assert.match(chatCss, /\[data-chat-flow-kind='user'\] \[data-time-hover-root\]/)
    assert.match(chatCss, /\[data-chat-flow-kind='tool-call'\] \[data-disclosure-row\]/)
    assert.match(chatCss, /\[data-chat-flow-kind='assistant-step'\] \[data-align='start'\] > \[data-variant='single'\]/)
    assert.match(chatCss, /\[data-chat-flow-kind='assistant-step'\] \[data-align='start'\] > \[data-variant='tile'\]/)
    assert.match(chatCss, /width:\s*clamp\(112px, 18vw, 160px\) !important/)
    assert.match(chatCss, /height:\s*clamp\(112px, 18vw, 160px\) !important/)
    assert.doesNotMatch(chatCss, /(?:e_mate_|imagegen|office|ocr|browser|feishu|weixin|dingtalk)/i)
    const catalogLoader = capabilities.slice(capabilities.indexOf('const loadCatalog'), capabilities.indexOf('const loadInstalled'))
    assert.match(catalogLoader, /setBuiltins\(/)
    assert.match(catalogLoader, /callSkillHub\('catalog\.search'/)
    assert.ok(catalogLoader.indexOf('setBuiltins(') < catalogLoader.indexOf("callSkillHub('catalog.search'"))
    assert.match(catalogLoader, /catch \(skillHubError\) \{\s*if \(cursor === undefined\) setItems\(\[\]\)\s*setError\(message\(skillHubError\)\)/)
    const imageGallery = readFileSync(new URL('../profile/plugins/emate-shell/src/client/image-gallery.tsx', import.meta.url), 'utf8')
    assert.match(imageGallery, /kind: 'e-mate-tool-images'/)
    assert.match(imageGallery, /visibility: 'hidden'/)
    assert.match(imageGallery, /selectArtifactTerminal\(owner: TurnTailOwnerProps\)/)
    assert.match(imageGallery, /terminalImageItems\(/)
    assert.doesNotMatch(imageGallery, /\b(?:fetch|WebSocket|EventSource|setTimeout)\s*\(/)
    const legacyArtifactCss = readFileSync(new URL('../profile/plugins/emate-shell/src/client/legacy-artifacts.module.css', import.meta.url), 'utf8')
    assert.match(legacyArtifactCss, /flex-direction:\s*column/)
    assert.match(legacyArtifactCss, /\.item \+ \.item/)
    assert.match(legacyArtifactCss, /background:\s*var\(--dsw-alias-bg-layer-1\)/)
    assert.doesNotMatch(client, /e-mate-office-artifacts|officeArtifactsDefinition|OfficeArtifacts/)
    assert.doesNotMatch(client, /\b(?:WebSocket|EventSource)\b|\bfetch\s*\(/)
    assert.ok(readFileSync(join(shell, 'assets', 'emate-logo.png')).byteLength > 0)
    assert.ok(readFileSync(join(shell, 'assets', 'lucide-send.svg')).byteLength > 0)
  } finally {
    rmSync(dshHome, { recursive: true, force: true })
  }
})

test('public share RPC publishes the native DSH Session ZIP and revokes the returned link', async () => {
  let registration
  const shareId = 'S'.repeat(32)
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString()
  const requests = []
  const sessionLogCalls = []
  applyShare({
    apiProxy: { downloads: { sessionLog: async (request, signal) => {
      sessionLogCalls.push(request)
      assert.equal(signal.aborted, false)
      return new Response(new Uint8Array([80, 75, 3, 4]), {
        headers: { 'content-type': 'application/zip' },
      })
    } } },
    credentials: { resolve: async ref => {
      assert.equal(ref, 'E_MATE_MODEL_SESSION_TOKEN')
      return { value: 'model-session-token-which-is-long-enough', source: 'test' }
    } },
    connection: { rpc: { handle: (channel, handler, options) => {
      registration = { channel, handler, options }
      return async () => {}
    } } },
    effect: effect => effect(),
  }, {
    rootUrl: 'https://share.example',
    fetchImplementation: async (input, init = {}) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith('/healthz')) {
        return Response.json({ schema_version: 1, service: 'emate-share', version: 1, ready: true })
      }
      if (url.includes('/v1/shares?')) {
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer model-session-token-which-is-long-enough')
        assert.equal(url, `https://share.example/v1/shares?session_sha256=${createHash('sha256').update('session-1').digest('hex')}`)
        return Response.json({
          schema_version: 1,
          shares: [{
            id: shareId,
            public_url: `https://share.example/s/${shareId}`,
            expires_at: expiresAt,
          }],
        })
      }
      if (init.method === 'POST') {
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer model-session-token-which-is-long-enough')
        assert.equal(new Headers(init.headers).get('x-emate-session-sha256'), createHash('sha256').update('session-1').digest('hex'))
        assert.deepEqual(new Uint8Array(await new Response(init.body).arrayBuffer()), new Uint8Array([80, 75, 3, 4]))
        return Response.json({
          schema_version: 1,
          share: {
            id: shareId,
            public_url: `https://share.example/s/${shareId}`,
            expires_at: expiresAt,
          },
        }, { status: 201 })
      }
      if (init.method === 'DELETE') return Response.json({ schema_version: 1, revoked: true })
      return new Response(null, { status: 404 })
    },
  })
  assert.equal(registration.channel, SHARE_CHANNEL)
  assert.deepEqual(registration.options, { authority: 'loopback' })
  assert.deepEqual(await registration.handler('status', {}), {
    ok: true,
    value: { schema_version: 1, stage: 'preparing', service_version: 1, ready: true },
  })
  assert.deepEqual(await registration.handler('create', { session_id: 'session-1' }), {
    ok: true,
    value: {
      stage: 'created',
      schema_version: 1,
      share_id: shareId,
      public_url: `https://share.example/s/${shareId}`,
      expires_at: expiresAt,
    },
  })
  assert.deepEqual(sessionLogCalls, [{ sessionId: 'session-1', includeDescendants: true }])
  assert.deepEqual(await registration.handler('list', { session_id: 'session-1' }), {
    ok: true,
    value: {
      stage: 'listing',
      schema_version: 1,
      shares: [{
        share_id: shareId,
        public_url: `https://share.example/s/${shareId}`,
        expires_at: expiresAt,
      }],
    },
  })
  assert.deepEqual(await registration.handler('revoke', { share_id: shareId, session_id: 'session-1' }), {
    ok: true,
    value: { schema_version: 1, stage: 'revoking', revoked: true },
  })
  assert.equal(requests.at(-1).url, `https://share.example/v2/shares/${shareId}`)
  assert.equal((await registration.handler('create', {})).error.code, 'bad-request')
  assert.equal((await registration.handler('status', [])).error.code, 'bad-request')
})

test('credential helper runner surfaces stdin closed-pipe errors and skips empty pipes', async () => {
  const input = 'x'.repeat(1024 * 1024)
  const closeBeforeRead = "require('node:fs').closeSync(0); setTimeout(() => {}, 50)"
  const closeDuringRead = "process.stdin.once('data', () => { require('node:fs').closeSync(0); setTimeout(() => {}, 50) })"
  await assert.rejects(runCommand(process.execPath, ['-e', closeBeforeRead], input), error => ['EPIPE', 'ENOTCONN'].includes(error?.code))
  await assert.rejects(runCommand(process.execPath, ['-e', closeDuringRead], input), error => ['EPIPE', 'ENOTCONN'].includes(error?.code))

  const empty = await runCommand(process.execPath, ['-e', "process.stdout.write(require('node:fs').fstatSync(0).isFIFO() ? 'pipe' : 'ignore')"])
  assert.deepEqual(empty, { status: 0, stdout: 'ignore' })
  assert.deepEqual(await runCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 'test-input'), {
    status: 0,
    stdout: 'test-input',
  })
  assert.equal((await runCommand(process.execPath, ['-e', 'process.exit(7)'])).status, 7)
  await assert.rejects(runCommand(join(tmpdir(), `missing-credential-helper-${process.pid}`), []), /could not be started/u)
  await assert.rejects(
    runCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(4 * 1024 * 1024 + 1))"]),
    /output exceeded its boundary/u,
  )
})

test('OS credential provider preserves target layering without exposing values through describe', async () => {
  const stored = new Map()
  let reads = 0
  let writes = 0
  let rejectWrite = false
  let rejectUnset = false
  const backend = {
    source: 'keychain',
    get: async ref => { reads += 1; return stored.get(ref) },
    has: async ref => stored.has(ref),
    set: async (ref, value) => {
      if (rejectWrite) throw new Error('simulated credential write failure')
      writes += 1
      stored.set(ref, value)
    },
    unset: async ref => {
      if (rejectUnset) throw new Error('simulated credential unset failure')
      return stored.delete(ref)
    },
  }
  const layers = {
    process: new Map(),
    'project-env': new Map([['PROJECT_ONLY', 'project-secret']]),
    'user-env': new Map([['USER_ONLY', 'user-secret']]),
  }
  const environment = {
    getFrom(ref, sources) {
      for (const source of sources) {
        const value = layers[source].get(ref)
        if (value !== undefined) return { value, source }
      }
    },
  }
  const credentials = new CredentialStore(environment, backend)
  await credentials.set('CONNECTOR_TOKEN', 'stored-secret')
  assert.deepEqual(await credentials.resolve('CONNECTOR_TOKEN'), { value: 'stored-secret', source: 'keychain' })
  assert.deepEqual(await credentials.resolve('CONNECTOR_TOKEN'), { value: 'stored-secret', source: 'keychain' })
  await credentials.set('CONNECTOR_TOKEN', 'stored-secret')
  assert.deepEqual({ reads, writes }, { reads: 0, writes: 1 })
  const restored = new CredentialStore(environment, backend)
  assert.deepEqual(await restored.resolve('CONNECTOR_TOKEN'), { value: 'stored-secret', source: 'keychain' })
  assert.deepEqual(await restored.resolve('CONNECTOR_TOKEN'), { value: 'stored-secret', source: 'keychain' })
  assert.equal(reads, 1)
  await credentials.set('CONNECTOR_TOKEN', 'next-account-secret')
  assert.deepEqual(await credentials.resolve('CONNECTOR_TOKEN'), { value: 'next-account-secret', source: 'keychain' })
  rejectWrite = true
  await assert.rejects(credentials.set('CONNECTOR_TOKEN', 'failed-account-secret'), /simulated credential write failure/u)
  rejectWrite = false
  assert.deepEqual(await credentials.resolve('CONNECTOR_TOKEN'), { value: 'next-account-secret', source: 'keychain' })
  rejectUnset = true
  await assert.rejects(credentials.unset('CONNECTOR_TOKEN'), /simulated credential unset failure/u)
  rejectUnset = false
  assert.deepEqual(await credentials.resolve('CONNECTOR_TOKEN'), { value: 'next-account-secret', source: 'keychain' })
  const described = await credentials.describe('CONNECTOR_TOKEN')
  assert.deepEqual(described, { configured: true, source: 'keychain', writable: true })
  assert.equal(JSON.stringify(described).includes('next-account-secret'), false)
  assert.deepEqual(await credentials.resolve('PROJECT_ONLY'), { value: 'project-secret', source: 'project-env' })
  for (const ref of [
    'E_MATE_MODEL_KEY_GPT',
    'E_MATE_MODEL_KEY_DEEPSEEK',
    'E_MATE_MODEL_KEY_DOUBAO',
    'E_MATE_SEARCH_KEY_DEEPSEEK',
  ]) {
    layers.process.set(ref, `${ref}-process-secret`)
    layers['project-env'].set(ref, `${ref}-project-secret`)
    layers['user-env'].set(ref, `${ref}-user-secret`)
    assert.equal(await credentials.resolve(ref), undefined)
    assert.deepEqual(await credentials.describe(ref), { configured: false, writable: true })
    await credentials.set(ref, `${ref}-managed-secret`)
    assert.deepEqual(await credentials.resolve(ref), { value: `${ref}-managed-secret`, source: 'keychain' })
    assert.equal(await credentials.unset(ref), true)
    assert.equal(await credentials.resolve(ref), undefined)
  }
  layers.process.set('CONNECTOR_TOKEN', 'process-secret')
  assert.deepEqual(await credentials.resolve('CONNECTOR_TOKEN'), { value: 'process-secret', source: 'env' })
  assert.deepEqual(await credentials.describe('CONNECTOR_TOKEN'), { configured: true, source: 'env', writable: false })
  await assert.rejects(credentials.set('CONNECTOR_TOKEN', 'replacement'), /read-only/)
  await assert.rejects(credentials.unset('CONNECTOR_TOKEN'), /read-only/)
  layers.process.delete('CONNECTOR_TOKEN')
  assert.equal(await credentials.unset('CONNECTOR_TOKEN'), true)
  assert.deepEqual(await credentials.describe('CONNECTOR_TOKEN'), { configured: false, writable: true })
  await assert.rejects(credentials.set('CONNECTOR_TOKEN', ''), /empty value/)
})

test('OS credential backends use Keychain and CurrentUser DPAPI without plaintext files', async () => {
  const keychain = new Map()
  const macCommands = []
  let rejectedChunkSuffix
  const rejectedDeletes = new Set()
  let blockConcurrentChunk = false
  let concurrentChunkEntered
  let releaseConcurrentChunk
  let armManifestReadFailure
  let rejectRestoreWrite
  const mac = createOsCredentialBackend('darwin', '/unused', async (file, args, input = '') => {
    macCommands.push({ file, args, input })
    if (file === '/usr/bin/expect') {
      assert.equal(args.length, 2)
      assert.match(args[1], /password data for new item:/)
      assert.match(args[1], /retype password for new item:/)
      assert.match(args[1], /set timeout 30/)
      assert.match(args[1], /spawn -noecho \/usr\/bin\/security/)
      assert.match(args[1], /set service \{net\.ecoremedia\.e-mate\.credentials\.v1\}/)
      assert.doesNotMatch(args[1], /mac-secret|bWFjLXNlY3JldA==/)
      const account = /set account \{([A-Za-z0-9_]+)\}/u.exec(args[1])?.[1]
      assert.ok(account)
      if (rejectRestoreWrite === account) {
        rejectRestoreWrite = undefined
        return { status: 1, stdout: '' }
      }
      if (rejectedChunkSuffix !== undefined && account.endsWith(rejectedChunkSuffix)) {
        return { status: 1, stdout: '' }
      }
      if (blockConcurrentChunk && account.startsWith('CONCURRENT_TOKEN_EMATE1_') && account.endsWith('_0')) {
        blockConcurrentChunk = false
        await new Promise(resolve => {
          releaseConcurrentChunk = resolve
          concurrentChunkEntered()
        })
      }
      keychain.set(account, input.trim())
      if (armManifestReadFailure === account) armManifestReadFailure = `armed:${account}`
      return { status: 0, stdout: '' }
    }
    const ref = args[args.indexOf('-a') + 1]
    if (args[0] === 'find-generic-password') {
      if (armManifestReadFailure === `armed:${ref}` && args.includes('-w')) {
        armManifestReadFailure = undefined
        rejectRestoreWrite = ref
        return { status: 1, stdout: '' }
      }
      if (!keychain.has(ref)) return { status: 44, stdout: '' }
      return { status: 0, stdout: args.includes('-w') ? `${keychain.get(ref)}\n` : '' }
    }
    if (args[0] === 'delete-generic-password') {
      if (rejectedDeletes.has(ref)) return { status: 1, stdout: '' }
      return { status: keychain.delete(ref) ? 0 : 44, stdout: '' }
    }
    return { status: 1, stdout: '' }
  })
  await mac.set('CONNECTOR_TOKEN', 'mac-secret')
  assert.equal(await mac.get('CONNECTOR_TOKEN'), 'mac-secret')
  assert.equal(await mac.has('CONNECTOR_TOKEN'), true)
  assert.equal(await mac.unset('CONNECTOR_TOKEN'), true)

  const firstLongValue = 's'.repeat(4_096)
  const secondLongValue = 't'.repeat(8_192)
  await mac.set('SESSION_TOKEN', firstLongValue)
  assert.equal(await mac.get('SESSION_TOKEN'), firstLongValue)
  const firstGeneration = [...keychain.keys()].filter(ref => ref.startsWith('SESSION_TOKEN_EMATE1_'))
  assert.ok(firstGeneration.length > 1)
  await mac.set('SESSION_TOKEN', secondLongValue)
  assert.equal(await mac.get('SESSION_TOKEN'), secondLongValue)
  assert.ok(firstGeneration.every(ref => !keychain.has(ref)))

  const committedEntries = new Set(keychain.keys())
  rejectedChunkSuffix = '_2'
  await assert.rejects(mac.set('SESSION_TOKEN', 'u'.repeat(12_288)), /macOS Keychain operation failed/)
  rejectedChunkSuffix = undefined
  assert.deepEqual(new Set(keychain.keys()), committedEntries)
  assert.equal(await mac.get('SESSION_TOKEN'), secondLongValue)

  let enteredConcurrentChunk
  const concurrentChunk = new Promise(resolve => { enteredConcurrentChunk = resolve })
  concurrentChunkEntered = enteredConcurrentChunk
  blockConcurrentChunk = true
  const firstConcurrentSet = mac.set('CONCURRENT_TOKEN', 'a'.repeat(1_024))
  await concurrentChunk
  const commandsBeforeSecondSet = macCommands.length
  const secondConcurrentSet = mac.set('CONCURRENT_TOKEN', 'b'.repeat(1_024))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(macCommands.length, commandsBeforeSecondSet)
  releaseConcurrentChunk()
  await Promise.all([firstConcurrentSet, secondConcurrentSet])
  assert.equal(await mac.get('CONCURRENT_TOKEN'), 'b'.repeat(1_024))

  await mac.set('CLEANUP_TOKEN', 'c'.repeat(1_024))
  const staleChunk = [...keychain.keys()].find(ref => ref.startsWith('CLEANUP_TOKEN_EMATE1_'))
  assert.ok(staleChunk)
  rejectedDeletes.add(staleChunk)
  await mac.set('CLEANUP_TOKEN', 'd'.repeat(1_024))
  assert.equal(await mac.get('CLEANUP_TOKEN'), 'd'.repeat(1_024))
  assert.equal(keychain.has(staleChunk), true)
  rejectedDeletes.clear()

  await mac.set('ROLLBACK_TOKEN', 'e'.repeat(1_024))
  armManifestReadFailure = 'ROLLBACK_TOKEN'
  await assert.rejects(mac.set('ROLLBACK_TOKEN', 'f'.repeat(1_024)), /rollback failed/)
  assert.equal(await mac.get('ROLLBACK_TOKEN'), 'f'.repeat(1_024))

  const activeChunk = [...keychain.keys()].find(ref => ref.startsWith('SESSION_TOKEN_EMATE1_'))
  assert.ok(activeChunk)
  keychain.set(activeChunk, Buffer.from('tampered').toString('base64'))
  await assert.rejects(mac.get('SESSION_TOKEN'), /integrity check failed/)
  assert.equal(await mac.unset('SESSION_TOKEN'), true)
  assert.equal([...keychain.keys()].some(ref => ref.startsWith('SESSION_TOKEN')), false)

  const macSet = macCommands.find(command => command.file === '/usr/bin/expect')
  assert.equal(macSet.args[0], '-c')
  assert.equal(macSet.args.includes('mac-secret'), false)
  assert.equal(macSet.args.includes(Buffer.from('mac-secret').toString('base64')), false)
  assert.equal(macSet.input.trim(), Buffer.from('mac-secret').toString('base64'))

  const dshHome = mkdtempSync(join(tmpdir(), 'e-mate-dpapi-'))
  const powershell = async (file, args, input) => {
    assert.equal(file, 'powershell.exe')
    assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
    assert.match(args[3], /Add-Type -AssemblyName System\.Security/)
    assert.match(args[3], /System\.Security\.Cryptography\.ProtectedData/)
    assert.match(args[3], /System\.Security\.Cryptography\.DataProtectionScope\]::CurrentUser/)
    const request = JSON.parse(input)
    if (request.op === 'probe') return { status: 0, stdout: 'ok' }
    if (request.op === 'protect') {
      return { status: 0, stdout: Buffer.from(`cipher:${request.value_base64}`).toString('base64') }
    }
    const wrapped = Buffer.from(request.value_base64, 'base64').toString('utf8')
    return { status: 0, stdout: wrapped.slice('cipher:'.length) }
  }
  try {
    const windows = createOsCredentialBackend('win32', dshHome, powershell)
    await windows.set('CONNECTOR_TOKEN', 'windows-secret')
    assert.equal(await windows.get('CONNECTOR_TOKEN'), 'windows-secret')
    const storedPath = join(dshHome, 'e-mate', 'credentials', 'CONNECTOR_TOKEN.dpapi')
    assert.equal(readFileSync(storedPath, 'utf8').includes('windows-secret'), false)
    assert.equal(await windows.unset('CONNECTOR_TOKEN'), true)
    assert.deepEqual(await checkOsCredentialBackend('win32', powershell), {
      ok: true,
      detail: 'Windows CurrentUser DPAPI available',
    })
  } finally {
    rmSync(dshHome, { recursive: true, force: true })
  }
})

test('managed profile exposes only user-facing plugin capabilities', () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'e-mate-capability-profile-'))
  try {
    const paths = installProfile(dshHome)
    const visible = new Set([
      '@e-mate/dsh-plugin-tool-search',
      '@e-mate/dsh-plugin-cdp',
      '@e-mate/dsh-plugin-computer-use',
    ])
    const packages = [
      '@e-mate/dsh-plugin-better-sidebar',
      '@e-mate/dsh-plugin-cdp',
      '@e-mate/dsh-plugin-computer-use',
      '@e-mate/dsh-plugin-file-import',
      '@e-mate/dsh-plugin-find-skill',
      '@e-mate/dsh-plugin-genui',
      '@e-mate/dsh-plugin-mcp-manage',
      '@e-mate/dsh-plugin-memory-evolve',
      '@e-mate/dsh-plugin-office-skills',
      '@e-mate/dsh-plugin-schedules',
    ]
    for (const name of packages) {
      const pluginRoot = join(paths.profile, 'node_modules', ...name.split('/'))
      const pluginManifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
      const source = readFileSync(join(pluginRoot, pluginManifest.main), 'utf8')
      if (visible.has(name)) assert.match(source, /emateCapabilities/)
      else assert.doesNotMatch(source, /emateCapabilities/)
    }
  } finally {
    rmSync(dshHome, { recursive: true, force: true })
  }
})

test('capability registry projects only registered plugin metadata and actions', async () => {
  let handler
  let registry
  applyCapabilities({
    connection: { rpc: { handle: (channel, callback, options) => {
      assert.equal(channel, CAPABILITIES_CHANNEL)
      assert.deepEqual(options, { authority: 'loopback' })
      handler = callback
      return async () => {}
    } } },
    provide: (name, value) => {
      assert.equal(name, 'emateCapabilities')
      registry = value
    },
    effect: effect => effect(),
  })
  const dispose = registry.register({
    id: 'office',
    title: 'Office',
    summary: 'Create and edit documents.',
    icon_key: 'office',
    order: 20,
    actions: [
      { id: 'setup', label: '设置', kind: 'primary' },
      { id: 'credential', label: '配置凭据', kind: 'primary', input: 'credential' },
    ],
    status: async () => ({
      state: 'setup-required', detail: '首次使用需要配置。',
      action_ids: ['setup', 'credential'], credential_refs: { credential: 'OFFICE_API_KEY' },
    }),
    invoke: async (action, data) => ({ action, data, accepted: true }),
  })
  const listed = await handler('list', {})
  assert.equal(listed.value.schema_version, 1)
  assert.deepEqual(listed.value.items.map(item => [item.id, item.state]), [['office', 'setup-required']])
  assert.equal(listed.value.items[0].icon_key, 'office')
  assert.deepEqual(listed.value.items[0].actions[1], {
    id: 'credential', label: '配置凭据', kind: 'primary', input: 'credential', credential_ref: 'OFFICE_API_KEY',
  })
  const acted = await handler('action', { capability_id: 'office', action_id: 'setup', data: { source: 'user' } })
  assert.deepEqual(acted.value.result, { action: 'setup', data: { source: 'user' }, accepted: true })
  assert.equal((await handler('action', { capability_id: 'office', action_id: 'credential', data: { secret: 'must-not-pass' } })).error.code, 'bad-request')
  assert.equal((await handler('action', { capability_id: 'office', action_id: 'missing', data: {} })).error.code, 'bad-request')
  assert.throws(() => registry.register({
    id: 'bad-icon', title: 'Bad', summary: 'Bad icon.', icon_key: 'emoji', order: 99,
    actions: [], status: async () => ({ state: 'blocked', action_ids: [] }),
  }), /invalid e-Mate capability definition/)
  assert.throws(() => registry.register({ id: 'office' }), /invalid e-Mate capability definition/)
  dispose()
  assert.deepEqual((await handler('list', {})).value.items, [])
})


test('capability action reports failures without leaking errors or swallowing cancellation', async () => {
  let handler
  let registry
  applyCapabilities({
    connection: { rpc: { handle: (_channel, callback) => { handler = callback; return () => {} } } },
    provide: (_name, value) => { registry = value },
    effect: effect => effect(),
  })
  let failStatus = false
  registry.register({
    id: 'cdp-browser', title: 'Chrome 浏览器', summary: 'Browser', icon_key: 'browser', order: 1,
    actions: [{ id: 'open-browser', label: '打开浏览器', kind: 'primary' }],
    status: async () => {
      if (failStatus) throw new Error('private status detail')
      return { state: 'ready', action_ids: ['open-browser'] }
    },
    invoke: async () => { throw new Error('private launch detail') },
  })
  const payload = { capability_id: 'cdp-browser', action_id: 'open-browser', data: {} }
  const signal = new AbortController().signal
  for (const failedStatus of [false, true]) {
    failStatus = failedStatus
    const result = await handler('action', payload, signal)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'internal')
    assert.match(result.error.message, /Chrome 浏览器.*刷新能力状态/)
    assert.doesNotMatch(JSON.stringify(result), /private/)
    assert.equal(result.value, undefined)
  }
  const cancelled = new AbortController()
  const reason = new Error('cancelled')
  cancelled.abort(reason)
  await assert.rejects(handler('action', payload, cancelled.signal), error => error === reason)
})

test('Agent QR generation uses the target Tool, Job, Attachment, and image renderer path', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'e-mate-qr-generation-'))
  const context = new Context()
  let attachmentFiber
  try {
    const paths = installProfile(join(temporary, 'dsh-home'))
    attachmentFiber = await context.plugin(LocalAttachmentStore, { dshHome: join(temporary, 'dsh-home') })
    const tools = new Map()
    const jobs = []
    const controllers = []
    await applyQrGeneration({
      tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
      jobs: {
        attachController: kind => { controllers.push(kind); return () => {} },
        start(spec) {
          assert.equal(spec.kind, 'emate-qr')
          assert.equal(spec.owner.id, 'qr-session')
          const id = `emate-qr-${jobs.length + 1}`
          const run = spec.run()
          jobs.push({ id, spec, ...run })
          return id
        },
      },
      attachments: context.attachments,
      effect: effect => effect(),
    }, { bindingPath: join(paths.profile, 'plugins', 'runtime-binding.json') })

    assert.deepEqual([...tools.keys()], ['e_mate_qr_generate'])
    assert.deepEqual(controllers, ['emate-qr'])
    const tool = tools.get('e_mate_qr_generate')
    assert.match(tool.description, /never encode passwords, API keys/iu)
    const result = await tool.execute({ content: 'https://example.com/e-mate' }, {
      agent: { id: 'qr-session' },
      signal: new AbortController().signal,
    })
    assert.match(result.image.attachmentId, /^sha256:[0-9a-f]{64}$/u)
    assert.equal(result.image.mediaType, 'image/png')
    assert.equal(tool.output.render({}, result).some(block => block.type === 'image'), true)
    assert.equal((await jobs[0].done).output, '{"image_count":1}')
    assert.doesNotMatch(JSON.stringify(await jobs[0].done), /example\.com/u)
    const stored = await context.attachments.readImage(result.image, new AbortController().signal)
    assert.equal(Buffer.from(stored.data).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), true)
    await assert.rejects(
      tool.execute({ content: 'x'.repeat(1025) }, { agent: { id: 'qr-session' }, signal: new AbortController().signal }),
      /1 to 1024 UTF-8 bytes/u,
    )
    await assert.rejects(
      tool.execute({ content: 'safe', model: 'external' }, { agent: { id: 'qr-session' }, signal: new AbortController().signal }),
      /accepts only content/u,
    )
  } finally {
    await attachmentFiber?.dispose()
    await context.fiber.dispose()
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('expert mode persists in its native session and leaves other conversations unchanged', async () => {
  const first = { header: { cwd: '/test' }, events: [], append(type, data) { this.events.push({ type, data }) } }
  const second = { events: [] }
  let flushes = 0
  const ctx = { get: name => name === 'apiProxy' ? { sessions: { create: async request => ({ rpcId: request.rpcId, result: { ok: true, value: { sessionId: request.payload.sessionId } } }) } } : undefined, sessions: { get: id => id === 'one' ? first : id === 'two' ? second : undefined,
    flush: async value => { assert.equal(value, first); flushes++; return true } } }
  let expertPolicy
  applyAgentOperations({ ...ctx, effect: () => {}, systemPrompt: { section(value) {
    if (value.name === 'emate:expert-mode') expertPolicy = value.text
  } } })
  assert.equal(expertPolicy({ agent: { session: first } }), '')
  assert.equal(expertModeActive(first), false)
  assert.deepEqual(await expertModeRequest(ctx, 'set', { session_id: 'one', active: true }), { active: true })
  assert.match(expertPolicy({ agent: { session: first } }), /enterprise-knowledge Skill/u)
  assert.equal(expertModeActive({ events: structuredClone(first.events) }), true)
  assert.equal(expertModeActive(second), false)
  assert.deepEqual(await expertModeRequest(ctx, 'set', { session_id: 'one', active: false }), { active: false })
  assert.match(expertPolicy({ agent: { session: first } }), /用户已关闭/u)
  assert.equal(flushes, 2)
  await assert.rejects(expertModeRequest(ctx, 'set', { session_id: 'one', active: 'true' }), /请求无效/u)
  await assert.rejects(expertModeRequest(ctx, 'set', { session_id: 'missing', active: true }), /尚未就绪/u)
})

test('Agent operation guidance owns the e-Mate persona without a second image policy', () => {
  let section
  applyAgentOperations({
    effect: () => {},
    systemPrompt: { section: value => { if (value.name === 'emate:agent-operations') section = value } },
  })
  const profilePatch = parseYaml(readFileSync(new URL('../profile/cordis.patch.yml', import.meta.url), 'utf8'))
  const nativeRoot = new URL('../../../upstream/deepseek-harness/', import.meta.url)
  const nativeBase = readFileSync(new URL('packages/bundle/base/cordis.patch.yml', nativeRoot), 'utf8')
  const nativeTool = readFileSync(new URL('packages/subagent/tool-subagent/src/index.ts', nativeRoot), 'utf8')
  const nativeScheduler = readFileSync(new URL('packages/core/agent-loop/src/tool-calls.ts', nativeRoot), 'utf8')
  const nativeSpawn = readFileSync(new URL('packages/subagent/subagent-spawn-in-process/src/index.ts', nativeRoot), 'utf8')
  assert.equal(profilePatch.find(row => row?.id === 'agent-loop').config.maxParallelToolCalls, 4)
  assert.match(nativeBase, /toolName: subagent[\s\S]*backgroundMode: continuable/u)
  assert.match(nativeTool, /isConcurrencySafe: \(\) => true/u)
  assert.match(nativeTool, /if \(runSpec\.runInBackground\)[\s\S]*const run: SubagentRun = await ctx\.subagents\.start/u)
  assert.match(nativeScheduler, /inFlight\.size < maxParallelToolCalls/u)
  assert.match(nativeSpawn, /inheritsParentContext = false/u)
  assert.equal(section.name, 'emate:agent-operations')
  assert.equal(section.order, 180)
  assert.match(section.text, /我是小芯，你的 AI 办公助手/u)
  assert.match(section.text, /运行在 e-Mate 内，是亦芯开发的全场景办公 AI Agent/u)
  assert.match(section.text, /Never use Bash, PowerShell, npm, pnpm/)
  assert.match(section.text, /e_mate_desktop_update/)
  assert.doesNotMatch(section.text, /e-mate update --json|e_mate_skill_hub_/)
  assert.match(section.text, /installed find-skill provider/u)
  assert.match(section.text, /use `mcp_manage`/u)
  assert.match(section.text, /latest direct request explicitly asks to read or operate a user-visible webpage/u)
  assert.match(section.text, /never use Browser\/CDP as a fallback for native `web_search`, attachment resolution/u)
  assert.match(section.text, /Do not invent a built-in connector or ask the user to paste secrets into chat/u)
  assert.doesNotMatch(section.text, /imagegen|image_batch|image_pack|batch children/u)
})

test('identity agreements are immutable, explicit, and use the target Connection RPC', async () => {
  assert.equal(agreementDocuments.length, 2)
  assert.match(agreementBundleSha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(requiredAcknowledgements, [
    'agreements_read',
    'ai_output_requires_human_verification',
    'lawful_use_and_ai_labels',
  ])
  for (const document of agreementDocuments) {
    assert.match(document.sha256, /^[0-9a-f]{64}$/)
    assert.match(document.markdown, /人工核实|AI 输出/u)
  }
  assert.deepEqual(describeAgreements().blocker, 'provider-identity-not-configured')
  assert.equal(describeAgreements('  亦芯测试主体  ').provider_legal_name, '亦芯测试主体')
  assert.deepEqual(
    describeAgreements('亦芯测试主体').acknowledgements.map(item => item.id),
    requiredAcknowledgements,
  )

  let registration
  let identity
  const ctx = {
    connection: {
      rpc: {
        handle: (channel, handler, options) => {
          registration = { channel, handler, options }
          return async () => {}
        },
      },
    },
    provide: (name, value) => {
      assert.equal(name, 'emateIdentity')
      identity = value
    },
    effect: effect => effect(),
  }
  applyIdentity(ctx, { providerLegalName: '亦芯测试主体' })
  assert.equal(registration.channel, IDENTITY_CHANNEL)
  assert.deepEqual(registration.options, { authority: 'loopback' })
  const described = await registration.handler('agreements.describe', {}, AbortSignal.abort())
  assert.equal(described.ok, true)
  assert.equal(described.value.ready, true)
  assert.equal(described.value.documents.length, 2)
  const blocked = await registration.handler('identity.bootstrap', {})
  assert.equal(blocked.ok, true)
  assert.equal(blocked.value.ready, false)
  assert.equal(blocked.value.workspace_unlocked, false)
  assert.equal((await registration.handler('agreements.describe', { extra: true })).error.code, 'bad-request')
  assert.equal((await registration.handler('other', {})).error.code, 'bad-request')
  await assert.rejects(identity.request(new URL('https://dl.ecoremedia.net/')), /identity transport is unavailable/)
  await assert.rejects(identity.uploadAudit([]), /audit transport is unavailable/)

  let configuredRegistration
  let authenticated = false
  let archived = false
  let activePassword = 'secret-value'
  let challengeExpiresAt = '2030-01-01T00:00:00.000Z'
  const captchaImage = `data:image/png;base64,${Buffer.from('captcha-image').toString('base64')}`
  applyIdentity({
    connection: { rpc: { handle: (_channel, handler) => {
      configuredRegistration = handler
      return async () => {}
    } } },
    provide: () => {},
    effect: effect => effect(),
  }, {
    providerLegalName: '亦芯测试主体',
    identityProvider: {
      bootstrap: async () => ({
        authenticated,
        workspace_unlocked: authenticated && archived,
        ...(authenticated ? { account_status: 'active', weekly_token_limit: 50_000 } : {}),
        ...(archived ? { agreement_receipt_id: 'receipt-1' } : {}),
      }),
      usage: async timezone => ({
        schema_version: 1,
        scope: 'account',
        timezone,
        week: { total_tokens: 12_345 },
        week_started_at: '2030-01-07T00:00:00.000Z',
        calculated_at: '2030-01-08T00:00:00.000Z',
      }),
      issueRegistrationChallenge: async () => ({
        schema_version: 1,
        challenge_id: 'registration_challenge:test-1',
        image_data_url: captchaImage,
        expires_at: challengeExpiresAt,
      }),
      register: async ({ account, real_name, password, challenge_id, verification_code }) => {
        assert.equal(account, 'test.user')
        assert.equal(real_name, '测试用户')
        assert.equal(password, 'registration-secret')
        assert.equal(challenge_id, 'registration_challenge:test-1')
        assert.equal(verification_code, 'A207')
        return { schema_version: 1, registration_id: 'registration:test-1', status: 'pending_approval' }
      },
      login: async ({ identifier, password, remember_login }) => {
        assert.equal(identifier, 'user@example.com')
        assert.equal(password, activePassword)
        assert.equal(remember_login, true)
        authenticated = true
      },
      acceptAgreements: async ({ bundle_sha256, acknowledgements }) => {
        assert.equal(bundle_sha256, agreementBundleSha256)
        assert.deepEqual(acknowledgements, requiredAcknowledgements)
        archived = true
      },
      changePassword: async ({ current_password, new_password, client_request_id }) => {
        assert.equal(current_password, activePassword)
        assert.equal(new_password, 'new-secret-value')
        assert.equal(client_request_id, 'session_password:test-1')
        activePassword = new_password
        authenticated = false
        return { receipt_id: 'password-receipt-1', reauthentication_required: true }
      },
      logout: async ({ client_request_id }) => {
        assert.equal(client_request_id, 'session_logout:test-1')
        authenticated = false
        return { remote_revocation: 'revoked', receipt_id: 'logout-receipt-1' }
      },
    },
  })
  const challenge = await configuredRegistration('verification.issue', { purpose: 'registration' })
  assert.equal(challenge.value.image_data_url, captchaImage)
  challengeExpiresAt = '2020-01-01T00:00:00.000Z'
  const invalidChallenge = await configuredRegistration('verification.issue', { purpose: 'registration' })
  assert.equal(invalidChallenge.ok, false)
  assert.equal(invalidChallenge.error.code, 'internal')
  assert.doesNotMatch(invalidChallenge.error.message, /registration challenge is invalid/)
  challengeExpiresAt = '2030-01-01T00:00:00.000Z'
  const registered = await configuredRegistration('session.register', {
    account: ' test.user ',
    real_name: ' 测试用户 ',
    password: 'registration-secret',
    challenge_id: 'registration_challenge:test-1',
    verification_code: ' A207 ',
  })
  assert.equal(registered.value.status, 'pending_approval')
  assert.equal((await configuredRegistration('session.register', {
    account: 'x',
    real_name: '测试用户',
    password: 'registration-secret',
    challenge_id: 'registration_challenge:test-1',
    verification_code: 'A207',
  })).error.code, 'bad-request')
  const loggedIn = await configuredRegistration('session.login', {
    identifier: ' user@example.com ',
    password: 'secret-value',
    remember_login: true,
  })
  assert.equal(loggedIn.value.authenticated, true)
  assert.equal(loggedIn.value.workspace_unlocked, false)
  const accepted = await configuredRegistration('agreements.accept', {
    bundle_sha256: agreementBundleSha256,
    acknowledgements: [...requiredAcknowledgements],
  })
  assert.equal(accepted.value.workspace_unlocked, true)
  assert.equal(accepted.value.agreement_receipt_id, 'receipt-1')
  const usage = await configuredRegistration('identity.usage', { timezone: 'Asia/Shanghai' })
  assert.equal(usage.value.week.total_tokens, 12_345)
  assert.equal((await configuredRegistration('identity.usage', { timezone: '' })).error.code, 'bad-request')
  const passwordChanged = await configuredRegistration('session.password', {
    client_request_id: 'session_password:test-1',
    current_password: 'secret-value',
    new_password: 'new-secret-value',
  })
  assert.equal(passwordChanged.value.receipt_id, 'password-receipt-1')
  assert.equal(passwordChanged.value.reauthentication_required, true)
  assert.equal(passwordChanged.value.state.authenticated, false)
  assert.equal(passwordChanged.value.state.workspace_unlocked, false)
  assert.equal((await configuredRegistration('session.password', {
    client_request_id: 'short',
    current_password: 'secret-value',
    new_password: 'new-secret-value',
  })).error.code, 'bad-request')
  const relogged = await configuredRegistration('session.login', {
    identifier: 'user@example.com',
    password: 'new-secret-value',
    remember_login: true,
  })
  assert.equal(relogged.value.workspace_unlocked, true)
  const loggedOut = await configuredRegistration('session.logout', {
    client_request_id: 'session_logout:test-1',
    confirmed: true,
  })
  assert.equal(loggedOut.value.remote_revocation, 'revoked')
  assert.equal(loggedOut.value.receipt_id, 'logout-receipt-1')
  assert.equal(loggedOut.value.state.authenticated, false)
  assert.equal((await configuredRegistration('session.logout', {
    client_request_id: 'session_logout:test-2',
    confirmed: false,
  })).error.code, 'bad-request')
  assert.equal((await configuredRegistration('agreements.accept', {
    bundle_sha256: agreementBundleSha256,
    acknowledgements: requiredAcknowledgements.slice(0, 2),
  })).error.code, 'bad-request')

  let invalidBootstrap
  applyIdentity({
    connection: { rpc: { handle: (_channel, handler) => {
      invalidBootstrap = handler
      return async () => {}
    } } },
    provide: () => {},
    effect: effect => effect(),
  }, {
    providerLegalName: '亦芯测试主体',
    identityProvider: { bootstrap: async () => ({ authenticated: true, workspace_unlocked: false }) },
  })
  const invalidBootstrapResult = await invalidBootstrap('identity.bootstrap', {})
  assert.equal(invalidBootstrapResult.ok, false)
  assert.equal(invalidBootstrapResult.error.code, 'internal')
  assert.doesNotMatch(invalidBootstrapResult.error.message, /identity bootstrap is invalid/)
})

test('enterprise identity provider maps target credentials and the production HTTP contracts without exposing tokens', async () => {
  const values = new Map()
  let rejectModelCredential = false
  let holdModelCredential
  let modelCredentialStarted
  let holdSessionCredential
  let sessionCredentialStarted
  const credentials = {
    resolve: async ref => {
      if (holdSessionCredential !== undefined && ref === 'E_MATE_ENTERPRISE_SESSION') {
        sessionCredentialStarted()
        await holdSessionCredential
        holdSessionCredential = undefined
      }
      return values.has(ref) ? { value: values.get(ref), source: 'test' } : undefined
    },
    set: async (ref, value) => {
      if (rejectModelCredential && ref === MODEL_SESSION_REF) throw new Error('simulated model credential failure')
      if (holdModelCredential !== undefined && ref === MODEL_SESSION_REF) {
        modelCredentialStarted()
        await holdModelCredential
        holdModelCredential = undefined
      }
      values.set(ref, value)
    },
    unset: async ref => { values.delete(ref) },
  }
  let clock = Date.parse('2030-01-08T12:00:00.000Z')
  const accessToken = 'access.payload.signature'
  const modelToken = 'model.payload.signature'
  const refreshToken = `emate_rt_${'r'.repeat(43)}`
  const usageKeys = generateKeyPairSync('ed25519')
  const usagePublicKey = usageKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const userAgreement = agreementDocuments.find(document => document.id === 'e-mate-user-agreement')
  const disclaimer = agreementDocuments.find(document => document.id === 'yixin-enterprise-disclaimer')
  const policy = {
    schemaVersion: 1,
    agreementId: 'e-mate-legal-bundle',
    agreementVersion: userAgreement.version,
    disclaimerVersion: disclaimer.version,
    contentHash: agreementBundleSha256,
  }
  let accepted = false
  const searchKey = 'managed-search-key-not-persisted-here'
  const runtimePayload = {
    schemaVersion: 1,
    models: [{
      id: 'gpt-5.6-luna',
      apiMode: 'responses',
      upstreamModelId: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna · 最大推理',
      input: ['text', 'image'],
      reasoning: true,
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    }],
    searchCredentialGrant: {
      schemaVersion: 1,
      status: 'granted',
      purpose: 'web-search',
      provider: 'deepseek-official',
      credentialRef: 'E_MATE_SEARCH_KEY_DEEPSEEK',
      upstreamApiKey: searchKey,
    },
  }
  let runtimeResponse = runtimePayload
  const requests = []
  let auditBody
  let taskAuditBody
  let transportAvailable = true
  let refreshRejected = false
  let refreshRejectionCode = 'TOKEN_REUSED'
  const json = value => {
    const body = JSON.stringify(value)
    return new Response(body, { status: 200, headers: {
      'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(gzipSync(body).length),
    } })
  }
  const session = {
    schemaVersion: 1,
    sessionId: 'session-enterprise-207',
    accessToken,
    refreshToken,
    expiresAt: new Date(clock + 15 * 60_000).toISOString(),
    identity: {
      tenantId: 'tenant-207',
      userId: 'user-207',
      displayName: '测试用户',
      roles: ['MEMBER'],
      weeklyTokenLimit: 50_000,
    },
    modelGateway: {
      baseUrl: 'https://mvdcm.ecoremedia.net/e-mate/model-api',
      sessionToken: modelToken,
      expiresAt: new Date(clock + 10 * 60_000).toISOString(),
      usageKeyId: 'usage-key-207',
      usagePublicKey,
      allowedModelIds: ['gpt-5.6-luna', 'gpt-image-2.5-flare'],
    },
  }
  const fetchImplementation = async (input, init = {}) => {
    if (!transportAvailable) throw new Error('simulated enterprise transport outage')
    const url = new URL(input)
    requests.push({ url: url.href, path: url.pathname, authorization: new Headers(init.headers).get('authorization') })
    if (url.pathname.endsWith('/v1/auth/registration/challenge')) {
      return json({
        schemaVersion: 1,
        challengeId: 'registration-challenge-207',
        imageDataUrl: `data:image/png;base64,${Buffer.from('captcha').toString('base64')}`,
        expiresAt: new Date(clock + 5 * 60_000).toISOString(),
      })
    }
    if (url.pathname.endsWith('/v1/auth/register')) {
      return new Response(JSON.stringify({
        schemaVersion: 1,
        registrationId: 'registration-receipt-207',
        status: 'PENDING_APPROVAL',
      }), { status: 201, headers: { 'content-type': 'application/json' } })
    }
    if (url.pathname.endsWith('/v1/auth/password')) return json(session)
    if (url.pathname.endsWith('/v1/auth/refresh')) {
      if (refreshRejected) {
        return new Response(JSON.stringify({ error: { code: refreshRejectionCode } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      return json({
        ...session,
        expiresAt: new Date(clock + 15 * 60_000).toISOString(),
        modelGateway: {
          ...session.modelGateway,
          expiresAt: new Date(clock + 10 * 60_000).toISOString(),
        },
      })
    }
    if (url.pathname.endsWith('/v1/auth/logout')) {
      return json({ schemaVersion: 1, receiptId: 'logout-receipt-207', reauthenticationRequired: false })
    }
    if (url.pathname.endsWith('/v1/consents/current')) {
      return json({
        schemaVersion: 1,
        policy,
        required: !accepted,
        acceptance: accepted ? {
          ...policy,
          acceptanceId: 'acceptance-receipt-207',
          userId: 'user-207',
          acceptedAt: new Date(clock).toISOString(),
          clientVersion: '2.0.17',
          locale: 'zh-CN',
        } : null,
      })
    }
    if (url.pathname.endsWith('/v1/consents/accept')) {
      accepted = true
      return json({
        ...policy,
        acceptanceId: 'acceptance-receipt-207',
        userId: 'user-207',
        acceptedAt: new Date(clock).toISOString(),
        clientVersion: '2.0.17',
        locale: 'zh-CN',
      })
    }
    if (url.pathname.endsWith('/v1/usage/current')) {
      return json({
        schemaVersion: 1,
        totalTokens: 12_345,
        weekStartedAt: '2030-01-07T00:00:00.000Z',
        calculatedAt: new Date(clock).toISOString(),
      })
    }
    if (url.pathname.endsWith('/v1/audit/usage')) {
      auditBody = JSON.parse(String(init.body))
      return json({
        schema_version: 1,
        receipts: auditBody.records.map(record => ({
          fact_id: record.fact_id,
          payload_sha256: record.payload_sha256,
          receipt_id: `receipt:${record.fact_id}`,
          accepted_at: new Date(clock).toISOString(),
        })),
      })
    }
    if (url.pathname.endsWith('/v1/audit/tasks')) {
      taskAuditBody = JSON.parse(String(init.body))
      return json({
        schema_version: 1,
        receipts: taskAuditBody.records.map(record => ({
          event_id: record.event_id,
          payload_sha256: record.payload_sha256,
          receipt_id: `receipt:${record.event_id}`,
          accepted_at: new Date(clock).toISOString(),
        })),
      })
    }
    if (url.pathname.endsWith('/v1/runtime-models')) {
      assert.equal(url.search, '?client_version=2.0.18&capabilities=responses-multimodal')
      return json(runtimeResponse)
    }
    if (url.pathname.endsWith('/v1/authenticated-probe')
      || url.pathname.startsWith('/ecorex-agent/client/skill-hub/v1/')) {
      return json({ ok: true })
    }
    throw new Error(`unexpected test endpoint ${url.pathname}`)
  }
  const providerOptions = {
    credentials,
    enterprise: {
      authBaseUrl: 'https://mvdcm.ecoremedia.net/e-mate/auth-api',
      modelBaseUrl: 'https://mvdcm.ecoremedia.net/e-mate/model-api',
      clientId: 'e-mate-desktop',
      organization: 'emate',
    },
    fetchImplementation,
    now: () => clock,
  }
  let provider = createEnterpriseIdentityProvider(providerOptions)

  const challenge = await provider.issueRegistrationChallenge()
  assert.equal(challenge.challenge_id, 'registration-challenge-207')
  const registration = await provider.register({
    account: 'test.user',
    real_name: '测试用户',
    password: 'registration-secret',
    challenge_id: challenge.challenge_id,
    verification_code: '123456',
  })
  assert.equal(registration.status, 'pending_approval')
  const nonEd25519PublicKey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privateKey = usageKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  for (const invalid of [privateKey, nonEd25519PublicKey, `${usagePublicKey}\u0000`, 'x'.repeat(8_193)]) {
    session.modelGateway.usagePublicKey = invalid
    await assert.rejects(
      provider.login({ identifier: 'test.user', password: 'secret-value', remember_login: true }),
      /usage public key is invalid/,
    )
    assert.equal(values.size, 0)
  }
  session.modelGateway.usagePublicKey = usagePublicKey.replaceAll('\n', '\r\n')
  values.set(MODEL_SESSION_REF, 'previous-model-token')
  rejectModelCredential = true
  await assert.rejects(
    provider.login({ identifier: 'test.user', password: 'secret-value', remember_login: true }),
    /simulated model credential failure/,
  )
  assert.equal(values.has('E_MATE_ENTERPRISE_SESSION'), false)
  assert.equal(values.has(MODEL_SESSION_REF), false)
  rejectModelCredential = false
  values.delete(MODEL_SESSION_REF)
  await provider.login({ identifier: 'test.user', password: 'secret-value', remember_login: true })
  assert.equal(values.get(MODEL_SESSION_REF), modelToken)
  assert.doesNotMatch(values.get('E_MATE_ENTERPRISE_SESSION'), /secret-value|registration-secret/)
  assert.equal(
    JSON.parse(values.get('E_MATE_ENTERPRISE_SESSION')).session.modelGateway.usagePublicKey,
    usagePublicKey,
  )
  const beforeConcurrentBootstrap = requests.filter(request => request.path.endsWith('/v1/consents/current')).length
  const [locked] = await Promise.all([provider.bootstrap(), provider.bootstrap(), provider.bootstrap()])
  assert.equal(requests.filter(request => request.path.endsWith('/v1/consents/current')).length,
    beforeConcurrentBootstrap + 1, 'concurrent startup surfaces share one live consent request')
  assert.equal(locked.authenticated, true)
  assert.equal(locked.workspace_unlocked, false)
  assert.equal('accessToken' in locked, false)
  assert.equal('sessionToken' in locked, false)
  const consentRequestsAfterFirstBootstrap = requests.filter(request => request.path.endsWith('/v1/consents/current')).length
  await provider.bootstrap()
  assert.equal(
    requests.filter(request => request.path.endsWith('/v1/consents/current')).length,
    consentRequestsAfterFirstBootstrap + 1,
  )
  const modelPolicy = await provider.modelPolicy()
  assert.equal(modelPolicy.default_chat_model_id, 'gpt-5.6-luna')
  assert.deepEqual(modelPolicy.allowed_model_ids, [
    'gpt-5.6-luna', 'gpt-image-2.5-flare',
  ])
  assert.equal('image_fallback_upstream_model_id' in modelPolicy, false)
  const runtimePolicy = await provider.modelRuntimePolicy()
  assert.equal(runtimePolicy.models[0].provider, 'e-mate-enterprise')
  assert.equal(runtimePolicy.models[0].credentialRef, MODEL_SESSION_REF)
  assert.equal(runtimePolicy.models[0].upstreamBaseUrl, 'https://mvdcm.ecoremedia.net/e-mate/model-api/v1')
  assert.equal('upstreamApiKey' in runtimePolicy.models[0], false)
  assert.deepEqual(runtimePolicy.searchCredentialGrant, runtimePayload.searchCredentialGrant)
  assert.equal(runtimePolicy.policy.allowed_model_ids.includes('deepseek'), false)
  assert.equal(values.has('E_MATE_MODEL_KEY_GPT'), false)
  assert.equal(values.has('E_MATE_MODEL_KEY_DEEPSEEK'), false)
  assert.equal(values.has('E_MATE_SEARCH_KEY_DEEPSEEK'), false)
  assert.doesNotMatch(values.get('E_MATE_ENTERPRISE_SESSION'), /managed-search-key/u)
  for (const status of ['denied', 'unavailable']) {
    runtimeResponse = {
      ...runtimePayload,
      searchCredentialGrant: {
        schemaVersion: 1,
        status,
        purpose: 'web-search',
        provider: 'deepseek-official',
        credentialRef: 'E_MATE_SEARCH_KEY_DEEPSEEK',
      },
    }
    assert.equal((await provider.modelRuntimePolicy()).searchCredentialGrant.status, status)
  }
  for (const invalid of [
    {
      ...runtimePayload,
      models: [{
        ...runtimePayload.models[0],
        upstreamBaseUrl: 'https://provider.example/v1',
        upstreamApiKey: 'legacy-direct-provider-key-must-be-rejected',
      }],
    },
    { ...runtimePayload, unexpected: true },
    { ...runtimePayload, searchCredentialGrant: { ...runtimePayload.searchCredentialGrant, credentialRef: 'UNMANAGED_KEY' } },
    { ...runtimePayload, searchCredentialGrant: { ...runtimePayload.searchCredentialGrant, status: 'denied' } },
    { schemaVersion: 1, models: runtimePayload.models },
  ]) {
    runtimeResponse = invalid
    await assert.rejects(provider.modelRuntimePolicy(), error => {
      assert.match(error.message, /runtime model(?:s)? (?:are|is) invalid|search credential grant is invalid/u)
      if (/search credential grant is invalid/u.test(error.message)) {
        assert.equal(error.code, 'E_MATE_SEARCH_GRANT_INVALID')
      }
      return true
    })
  }
  runtimeResponse = runtimePayload
  const accountSubject = provider.localAccountSubject()
  clock += 9 * 60_000
  let releaseModelCredential
  holdModelCredential = new Promise(resolve => { releaseModelCredential = resolve })
  const modelCredentialWriteStarted = new Promise(resolve => { modelCredentialStarted = resolve })
  const refreshingPolicy = provider.modelRuntimePolicy()
  await modelCredentialWriteStarted
  assert.equal(provider.localAccountSubject(), accountSubject)
  releaseModelCredential()
  await refreshingPolicy
  const refreshRequestsBeforeIdle = requests.filter(request => request.path.endsWith('/v1/auth/refresh')).length
  clock += 16 * 60_000
  let releaseSessionCredential
  holdSessionCredential = new Promise(resolve => { releaseSessionCredential = resolve })
  const sessionCredentialReadStarted = new Promise(resolve => { sessionCredentialStarted = resolve })
  provider = createEnterpriseIdentityProvider(providerOptions)
  const idleLease = provider.keepAlive()
  await sessionCredentialReadStarted
  const idlePolicy = provider.modelPolicy()
  const idleBootstrap = provider.bootstrap()
  releaseSessionCredential()
  await idleLease
  assert.equal((await idlePolicy).default_chat_model_id, 'gpt-5.6-luna')
  assert.equal((await idleBootstrap).authenticated, true)
  assert.equal(
    requests.filter(request => request.path.endsWith('/v1/auth/refresh')).length,
    refreshRequestsBeforeIdle + 1,
  )
  assert.ok(Date.parse(JSON.parse(values.get('E_MATE_ENTERPRISE_SESSION')).session.expiresAt) > clock)
  const usage = await provider.usage('Asia/Shanghai')
  assert.equal(usage.week.total_tokens, 12_345)
  assert.equal(usage.timezone, 'Asia/Shanghai')
  const auditRecords = [{ fact_id: 'auditfact_test-207', payload_sha256: 'a'.repeat(64), payload: { total_tokens: 17 } }]
  const auditReceipt = await provider.auditUpload(auditRecords)
  assert.deepEqual(auditBody, { schema_version: 1, records: auditRecords })
  assert.equal(auditReceipt.receipts[0].fact_id, auditRecords[0].fact_id)
  const taskAuditRecords = [{
    event_id: `taskevent_${'b'.repeat(64)}`,
    account_subject_sha256: 'c'.repeat(64),
    payload_sha256: 'd'.repeat(64),
    payload: { schemaVersion: 1 },
  }]
  const taskAuditReceipt = await provider.taskAuditUpload(taskAuditRecords)
  assert.deepEqual(taskAuditBody, { schema_version: 1, records: taskAuditRecords })
  assert.equal(taskAuditReceipt.receipts[0].event_id, taskAuditRecords[0].event_id)
  const modelProbe = await provider.authenticatedRequest(
    'https://mvdcm.ecoremedia.net/e-mate/model-api/v1/authenticated-probe',
  )
  assert.equal(modelProbe.ok, true)
  await assert.rejects(
    provider.authenticatedRequest('https://mvdcm.ecoremedia.net/e-mate/model-api/v1/authenticated-probe?query=blocked'),
    /outside the managed enterprise root/,
  )
  const skillHubUrl = 'https://emate-skill-hub.emate-zyfjacksonchen.workers.dev/ecorex-agent/client/skill-hub/v1/skills?query=office&limit=24'
  const skillHubResponse = await provider.authenticatedRequest(skillHubUrl)
  assert.equal(skillHubResponse.ok, true)
  assert.deepEqual(requests.at(-1), {
    url: skillHubUrl,
    path: '/ecorex-agent/client/skill-hub/v1/skills',
    authorization: `Bearer ${modelToken}`,
  })
  const migratedHubUrl = skillHubUrl.replace('emate-skill-hub.emate-zyfjacksonchen.workers.dev', 'mvdcm.ecoremedia.net')
  assert.equal((await provider.authenticatedRequest(migratedHubUrl)).ok, true)
  assert.deepEqual(requests.at(-1), {
    url: migratedHubUrl, path: '/ecorex-agent/client/skill-hub/v1/skills', authorization: `Bearer ${modelToken}`,
  })
  for (const target of [
    'https://mvdcm.ecoremedia.net/ecorex-agent/client/skill-hub/v10/skills',
    'https://mvdcm.ecoremedia.net/ecorex-agent/client/other-service',
    'http://mvdcm.ecoremedia.net/ecorex-agent/client/skill-hub/v1/skills',
    'https://emate-skill-hub.emate-zyfjacksonchen.workers.dev/ecorex-agent/client/skill-hub/v10/skills?query=office&limit=24',
    'https://example.com/ecorex-agent/client/skill-hub/v1/skills?query=office&limit=24',
    'https://user:password@emate-skill-hub.emate-zyfjacksonchen.workers.dev/ecorex-agent/client/skill-hub/v1/skills?query=office&limit=24',
    'https://emate-skill-hub.emate-zyfjacksonchen.workers.dev/ecorex-agent/client/skill-hub/v1/skills?query=office&limit=24#fragment',
  ]) {
    await assert.rejects(provider.authenticatedRequest(target), /outside the managed enterprise root/)
  }
  await assert.rejects(
    provider.authenticatedRequest(skillHubUrl, { headers: { authorization: 'Bearer caller-token' } }),
    /cannot override authorization/,
  )
  await provider.acceptAgreements()
  const unlocked = await provider.bootstrap()
  assert.equal(unlocked.workspace_unlocked, true)
  assert.equal(unlocked.agreement_receipt_id, 'acceptance-receipt-207')
  const consentRequestsAfterAcceptance = requests.filter(request => request.path.endsWith('/v1/consents/current')).length
  await provider.bootstrap()
  assert.equal(
    requests.filter(request => request.path.endsWith('/v1/consents/current')).length,
    consentRequestsAfterAcceptance + 1,
  )
  const protectedRequests = requests.filter(request => request.path.includes('/v1/consents/'))
  assert.ok(protectedRequests.every(request => request.authorization === `Bearer ${modelToken}`))
  const runtimeRequests = requests.filter(request => request.path.endsWith('/v1/runtime-models'))
  assert.ok(runtimeRequests.length >= 2)
  assert.ok(runtimeRequests.every(request => request.authorization === `Bearer ${modelToken}`))
  const auditRequests = requests.filter(request => request.path.endsWith('/v1/audit/usage'))
  assert.equal(auditRequests.length, 1)
  assert.equal(auditRequests[0].authorization, `Bearer ${modelToken}`)
  const taskAuditRequests = requests.filter(request => request.path.endsWith('/v1/audit/tasks'))
  assert.equal(taskAuditRequests.length, 1)
  assert.equal(taskAuditRequests[0].authorization, `Bearer ${modelToken}`)
  clock += 16 * 60_000
  transportAvailable = false
  provider = createEnterpriseIdentityProvider(providerOptions)
  const offlineWorkspace = await provider.bootstrap()
  assert.equal(offlineWorkspace.authenticated, false)
  assert.equal(offlineWorkspace.workspace_unlocked, false)
  await assert.rejects(provider.modelPolicy(), /企业身份服务暂时不可用/)
  assert.equal(values.has('E_MATE_ENTERPRISE_SESSION'), true)
  transportAvailable = true
  clock = Date.parse(JSON.parse(values.get('E_MATE_ENTERPRISE_SESSION')).session.expiresAt)
  refreshRejected = true
  refreshRejectionCode = 'TOKEN_REUSED'
  const refreshRequestsBeforeTerminal = requests.filter(request => request.path.endsWith('/v1/auth/refresh')).length
  assert.deepEqual(await provider.bootstrap(), { authenticated: false, workspace_unlocked: false })
  assert.equal(provider.localAccountPrincipal(), undefined)
  assert.equal(
    requests.filter(request => request.path.endsWith('/v1/auth/refresh')).length,
    refreshRequestsBeforeTerminal + 1,
  )
  for (const ref of ['E_MATE_ENTERPRISE_SESSION', MODEL_SESSION_REF, 'E_MATE_MODEL_KEY_GPT', 'E_MATE_MODEL_KEY_DEEPSEEK', 'E_MATE_MODEL_KEY_DOUBAO']) {
    assert.equal(values.has(ref), false)
  }
  assert.deepEqual(await provider.bootstrap(), { authenticated: false, workspace_unlocked: false })
  refreshRejected = false
  await provider.login({ identifier: 'test.user', password: 'secret-value', remember_login: true })
  values.set('E_MATE_MODEL_KEY_GPT', 'runtime-provider-key-not-persisted-here')
  const logout = await provider.logout({ client_request_id: 'logout-request-207' })
  assert.equal(logout.remote_revocation, 'revoked')
  assert.equal(logout.receipt_id, 'logout-receipt-207')
  assert.equal(values.size, 0)

  accepted = false
  session.identity.roles = ['AUDIT_ADMIN']
  await provider.login({ identifier: 'audit.admin', password: 'secret-value', remember_login: false })
  const consentRequestsBeforeAdminBootstrap = requests.filter(request => request.path.includes('/v1/consents/')).length
  const administrator = await provider.bootstrap()
  assert.equal(administrator.workspace_unlocked, true)
  assert.equal(administrator.agreement_exempt, true)
  assert.equal(administrator.agreement_receipt_id, undefined)
  assert.equal(
    requests.filter(request => request.path.includes('/v1/consents/')).length,
    consentRequestsBeforeAdminBootstrap,
  )
  await provider.logout({ client_request_id: 'admin-logout-request-207' })
})

test('enterprise identity rejects expected gateway responses through the target RPC result', async () => {
  let identityHandler
  let keepAliveTick
  let keepAliveInterval
  let response = { status: 400, body: { error: { code: 'INVALID_CHALLENGE' } } }
  let transportFailure = false
  let requestSignal
  const warnings = []
  const credentials = {
    resolve: async () => undefined,
    set: async () => {},
    unset: async () => {},
  }
  applyIdentity({
    get: name => name === 'credentials' ? credentials : undefined,
    connection: { rpc: { handle: (_channel, handler) => {
      identityHandler = handler
      return async () => {}
    } } },
    provide: () => {},
    effect: effect => effect(),
    logger: { warn: warning => { warnings.push(warning) } },
    interval: (callback, delay) => {
      keepAliveTick = callback
      keepAliveInterval = delay
      return () => {}
    },
  }, {
    providerLegalName: '亦芯测试主体',
    enterprise: {
      authBaseUrl: 'https://mvdcm.ecoremedia.net/e-mate/auth-api',
      modelBaseUrl: 'https://mvdcm.ecoremedia.net/e-mate/model-api',
      clientId: 'e-mate-web',
      organization: 'emate-v2',
    },
    fetchImplementation: async (_input, init) => {
      requestSignal = init.signal
      if (transportFailure) throw new Error('simulated transport failure')
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  assert.equal(keepAliveInterval, ENTERPRISE_KEEP_ALIVE_MS)
  keepAliveTick()
  const payload = {
    account: 'test.user',
    real_name: '测试用户',
    password: 'registration-secret',
    challenge_id: 'registration-challenge-207',
    verification_code: '123456',
  }

  assert.deepEqual(await identityHandler('session.register', payload), {
    ok: false,
    error: { code: 'bad-request', message: '验证码无效或已过期', details: { issues: [] } },
  })
  response = { status: 409, body: { error: { code: 'ACCOUNT_EXISTS' } } }
  assert.deepEqual(await identityHandler('session.register', payload), {
    ok: false,
    error: { code: 'bad-request', message: '该账号已存在', details: { issues: [] } },
  })

  response = { status: 500, body: { error: { code: 'ACCOUNT_EXISTS', message: 'sensitive upstream detail' } } }
  assert.deepEqual(await identityHandler('session.register', payload), {
    ok: false,
    error: { code: 'internal', message: '企业身份服务暂时不可用，请稍后重试。', details: {} },
  })

  const login = { identifier: 'test.user', password: 'old-password', remember_login: true }
  response = { status: 401, body: { error: { code: 'INVALID_GRANT' } } }
  assert.deepEqual(await identityHandler('session.login', login), {
    ok: false,
    error: { code: 'bad-request', message: '账号或密码错误', details: { issues: [] } },
  })
  response = { status: 500, body: { error: { code: 'INVALID_GRANT' } } }
  assert.deepEqual(await identityHandler('session.login', login), {
    ok: false,
    error: { code: 'internal', message: '企业身份服务暂时不可用，请稍后重试。', details: {} },
  })
  assert.match(warnings.at(-1), /session\.login unavailable \(upstream-http 500\)/u)
  transportFailure = true
  assert.deepEqual(await identityHandler('session.login', login), {
    ok: false,
    error: { code: 'internal', message: '企业身份服务暂时不可用，请稍后重试。', details: {} },
  })
  assert.equal(requestSignal instanceof AbortSignal, true)
  assert.match(warnings.at(-1), /session\.login unavailable \(transport\)/u)
  transportFailure = false
  response = { status: 400, body: { error: { code: 'UNKNOWN_CONTRACT_FAILURE' } } }
  assert.deepEqual(await identityHandler('session.login', login), {
    ok: false,
    error: { code: 'internal', message: '企业身份服务暂时不可用，请稍后重试。', details: {} },
  })
})

test('enterprise model switch keeps native history and survives a cached-policy outage and cold restart', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'e-mate-model-policy-'))
  const cleanups = []
  const records = new Map()
  const projectionRecords = new Map()
  let rejectProjectionMarkerWrite = false
  const table = {
    entries: () => records.entries(),
    get: key => records.get(key),
    put: async (key, value) => { records.set(key, structuredClone(value)) },
    delete: async key => records.delete(key),
  }
  const projectionTable = {
    entries: () => projectionRecords.entries(),
    get: key => projectionRecords.get(key),
    put: async (key, value) => {
      if (rejectProjectionMarkerWrite) throw new Error('simulated runtime projection marker failure')
      projectionRecords.set(key, structuredClone(value))
    },
    delete: async key => projectionRecords.delete(key),
  }
  let rejectQuotaSnapshotWrite = false
  const quotaRecords = { snapshots: new Map(), reservations: new Map(), usage: new Map() }
  const domain = {
    table: name => name === 'active' ? table : name === 'runtime_projection' ? projectionTable : undefined,
    close: async () => {},
  }
  const quotaDomain = {
    table: name => ({
      entries: () => quotaRecords[name].entries(),
      put: async (key, value) => {
        if (name === 'snapshots' && rejectQuotaSnapshotWrite) {
          throw new Error('simulated quota snapshot failure')
        }
        quotaRecords[name].set(key, structuredClone(value))
      },
      delete: async key => quotaRecords[name].delete(key),
    }),
    close: async () => {},
  }
  let openedDomains = 0
  let policyStorageSchema
  const calls = { selected: [], policy: 0 }
  const credentialValues = new Map()
  let llmSettings = {
    providers: {
      'e-mate-enterprise': {
        apiKeyEnv: 'E_MATE_MODEL_KEY_GPT',
        api: 'openai-responses',
        baseURL: 'http://provider.example:8080/v1',
        models: [{ id: 'gpt-5.6-luna' }],
      },
    },
  }
  let defaultModelSettings
  const settingsRevisions = new Map([
    ['llm-pi-ai', 0],
    ['agent-default-model', 0],
  ])
  let failDefaultModelWrite = false
  let delayedCredentialWrite
  let rejectedCredentialWrite
  let credentialWriteRejected = false
  let projectedGptKey = 'production-key-redacted-for-test-123'
  let projectedGptBaseUrl = 'http://provider.example:8080/v1'
  let astraAllowed = false
  let policyDefaultModel = 'gpt-5.6-luna'
  let deepseekChatAllowed = true
  let searchGrantStatus = 'granted'
  let searchGrantFailure
  let rejectSearchUnset = false
  let projectedSearchKey = 'deepseek-key-redacted-for-test-123'
  let projectedDeepseekChatKey = 'deepseek-chat-key-redacted-for-test-123'
  credentialValues.set('E_MATE_MODEL_KEY_GPT', 'legacy-gpt-key-redacted-for-test-000')
  credentialValues.set(MODEL_SESSION_REF, 'model.payload.signature')
  const session = {
    current: { provider: 'e-mate-enterprise', model: 'gpt-5.6-luna', reasoningEffort: 'max' },
    messages: [
      { id: 'user-1', role: 'user', content: 'first turn' },
      { id: 'assistant-1', role: 'assistant', content: 'first answer' },
    ],
  }
  let accountSubject = 'account:test-207'
  let providerAvailable = true
  let rpc
  let requestPolicy
  let streamPolicy
  const modelPolicyHandlers = new Map()
  let modelPolicy
  const now = Date.now()
  const policy = () => ({
    schema_version: 1,
    account_subject: accountSubject,
    revision: 7,
    allowed_model_ids: [
      'gpt-5.6-luna', 'gpt-5.6-sol',
      ...(astraAllowed ? ['gpt-6-astra'] : []),
      ...(deepseekChatAllowed ? ['deepseek'] : []),
      'gpt-image-2.5-flare',
    ],
    default_chat_model_id: policyDefaultModel,
    default_chat_reasoning_effort: policyDefaultModel === 'gpt-5.6-luna' ? 'max' : 'medium',
    image_primary_model_id: 'gpt-image-2.5-flare',
    issued_at: new Date(now - 1_000).toISOString(),
    expires_at: new Date(now + 60 * 60_000).toISOString(),
    receipt_id: 'policy-receipt:test-207',
  })
  const legacyPolicy = {
    ...policy(),
    image_primary_model_id: 'gpt-image-2-pro',
    allowed_model_ids: [
      'deepseek', 'doubao-seed-2-0-pro-260215', 'gpt-5.6-luna',
      'gpt-5.6-sol', 'gpt-image-2', 'gpt-image-2-pro',
    ],
    image_fallback_upstream_model_id: 'gpt-image-2',
    issued_at: new Date(now - 60 * 60_000).toISOString(),
    expires_at: new Date(now - 45 * 60_000).toISOString(),
  }
  const storedLegacyPolicy = value => ({
    ...value,
    policy_sha256: createHash('sha256').update(JSON.stringify(Object.fromEntries(
      Object.keys(value).sort().map(key => [key, value[key]]),
    ))).digest('hex'),
  })
  const parseCurrentDurablePolicy = value => {
    assert.equal(value.image_primary_model_id, 'gpt-image-2.5-flare')
    assert.equal('image_fallback_upstream_model_id' in value, false)
    assert.equal(value.allowed_model_ids.includes('gpt-image-2'), false)
    assert.equal(value.allowed_model_ids.includes('gpt-image-2-pro'), false)
    assert.equal(value.policy_sha256, storedLegacyPolicy(Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== 'policy_sha256'),
    )).policy_sha256)
    return structuredClone(value)
  }
  const legacyPolicyRecord = storedLegacyPolicy(legacyPolicy)
  const legacyPolicySha256 = legacyPolicyRecord.policy_sha256
  records.set('active', legacyPolicyRecord)
  const catalog = {
    groups: [{
      id: 'enterprise',
      name: 'e-Mate Enterprise',
      models: [
        { id: 'gpt-5.6-luna', name: 'e-Mate Chat' },
        { id: 'gpt-5.6-sol', name: 'e-Mate Sol' },
        { id: 'deepseek', name: 'DeepSeek V4 Pro' },
      ],
    }],
    failures: [],
  }
  const apiProxy = {
    sessions: {
      models: async request => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { current: structuredClone(session.current), routable: true, ...catalog } },
      }),
      selectModel: async request => {
        calls.selected.push(structuredClone(request.payload))
        session.current = {
          provider: request.payload.provider,
          model: request.payload.model,
          ...request.payload.reasoningEffort === undefined ? {} : { reasoningEffort: request.payload.reasoningEffort },
        }
        return { rpcId: request.rpcId, result: { ok: true, value: { selected: structuredClone(session.current) } } }
      },
    },
    llm: {
      models: async request => ({ rpcId: request.rpcId, result: { ok: true, value: catalog } }),
    },
  }
  try {
    const paths = installProfile(join(temporary, 'dsh-home'))
    const modelPolicyContext = {
      apiProxy,
      connection: { rpc: { handle: (channel, handler, options) => {
        rpc = { channel, handler, options }
        return () => {}
      } } },
      llm: {},
      credentials: {
        resolve: async ref => credentialValues.has(ref) ? { value: credentialValues.get(ref), source: 'test' } : undefined,
        set: async (ref, value) => {
          if (delayedCredentialWrite?.ref === ref && delayedCredentialWrite.value === value) {
            delayedCredentialWrite.started()
            await delayedCredentialWrite.release
            delayedCredentialWrite = undefined
          }
          if (rejectedCredentialWrite?.ref === ref && rejectedCredentialWrite.value === value) {
            rejectedCredentialWrite = undefined
            credentialWriteRejected = true
            throw new Error('simulated ordered credential write failure')
          }
          credentialValues.set(ref, value)
        },
        unset: async ref => {
          if (rejectSearchUnset && ref === 'E_MATE_SEARCH_KEY_DEEPSEEK') {
            throw new Error('simulated search credential revocation failure')
          }
          credentialValues.delete(ref)
        },
      },
      settings: {
        describe: () => [...settingsRevisions].map(([ns, revision]) => ({ ns, revision })),
        get: ns => ns === 'llm-pi-ai'
          ? structuredClone(llmSettings)
          : ns === 'agent-default-model' ? structuredClone(defaultModelSettings) : undefined,
        replace: async (ns, value, expectedRevision) => {
          const revision = settingsRevisions.get(ns)
          assert.notEqual(revision, undefined)
          if (expectedRevision !== undefined && expectedRevision !== revision) {
            throw Object.assign(new Error('simulated Settings revision conflict'), { code: 'SETTINGS_CONFLICT' })
          }
          const previous = ns === 'llm-pi-ai' ? llmSettings : defaultModelSettings
          if (ns === 'llm-pi-ai') llmSettings = structuredClone(value)
          else if (ns === 'agent-default-model') {
            if (failDefaultModelWrite) {
              failDefaultModelWrite = false
              throw new Error('simulated default model settings failure')
            }
            defaultModelSettings = structuredClone(value)
          }
          else assert.fail(`unexpected settings namespace ${ns}`)
          if (JSON.stringify(previous) !== JSON.stringify(value)) settingsRevisions.set(ns, revision + 1)
        },
      },
      storageDomain: { open: async spec => {
        if (openedDomains++ > 0) return quotaDomain
        policyStorageSchema = spec.tables.active.valueSchema
        for (const [key, value] of records) {
          records.set(key, policyStorageSchema.parse(value))
        }
        return domain
      } },
      emateIdentity: {
        localAccountSubject: () => accountSubject,
        state: async () => ({
          authenticated: true,
          workspace_unlocked: true,
          account_subject: accountSubject,
          weekly_token_limit: 100_000,
        }),
        usage: async timezone => {
          const date = new Date(now)
          date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
          date.setUTCHours(0, 0, 0, 0)
          return {
            schema_version: 1,
            scope: 'account',
            timezone,
            week: { total_tokens: 48_855 },
            week_started_at: date.toISOString(),
            calculated_at: new Date(now).toISOString(),
          }
        },
        modelRuntimePolicy: async () => {
          calls.policy += 1
          if (!providerAvailable) throw new Error('enterprise unavailable')
          if (searchGrantFailure !== undefined) throw searchGrantFailure
          return {
            policy: policy(),
            models: [
              {
                id: 'gpt-5.6-luna',
                provider: 'e-mate-enterprise',
                credentialRef: MODEL_SESSION_REF,
                api: 'openai-responses',
                upstreamModelId: 'gpt-5.6-luna',
                upstreamBaseUrl: 'https://mvdcm.ecoremedia.net/e-mate/model-api/v1',
                label: 'GPT-5.6 Luna · 最大推理',
                input: ['text', 'image'],
                contextWindow: 1_050_000,
                maxTokens: 128_000,
              },
              {
                id: 'gpt-5.6-sol',
                provider: 'e-mate-enterprise',
                credentialRef: MODEL_SESSION_REF,
                api: 'openai-responses',
                upstreamModelId: 'gpt-5.6-sol',
                upstreamBaseUrl: 'https://mvdcm.ecoremedia.net/e-mate/model-api/v1',
                label: 'GPT-5.6 Sol · 中等推理',
                input: ['text', 'image'],
                contextWindow: 1_050_000,
                maxTokens: 128_000,
              },
              ...(astraAllowed ? [{
                id: 'gpt-6-astra', provider: 'e-mate-enterprise', credentialRef: MODEL_SESSION_REF,
                api: 'openai-responses', upstreamModelId: 'gpt-6-astra',
                upstreamBaseUrl: 'https://mvdcm.ecoremedia.net/e-mate/model-api/v1',
                label: 'Astra', input: ['text', 'image'], contextWindow: 1_050_000, maxTokens: 128_000,
              }] : []),
              ...(deepseekChatAllowed ? [{
                id: 'deepseek',
                provider: 'e-mate-enterprise-deepseek',
                credentialRef: MODEL_SESSION_REF,
                api: 'openai-responses',
                upstreamModelId: 'deepseek',
                upstreamBaseUrl: 'https://mvdcm.ecoremedia.net/e-mate/model-api/v1',
                label: 'DeepSeek V4 Flash Vision · 最大推理',
                input: ['text', 'image'],
                contextWindow: 131_072,
                maxTokens: 65_536,
              }] : []),
            ],
            searchCredentialGrant: {
              schemaVersion: 1,
              status: searchGrantStatus,
              purpose: 'web-search',
              provider: 'deepseek-official',
              credentialRef: 'E_MATE_SEARCH_KEY_DEEPSEEK',
              ...(searchGrantStatus === 'granted' ? { upstreamApiKey: projectedSearchKey } : {}),
            },
          }
        },
      },
      provide: (name, value) => {
        assert.equal(name, 'emateModelPolicy')
        modelPolicy = value
      },
      effect(effect) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
        return cleanup
      },
      reflect: { store: {} },
      on: (event, handler) => {
        if (event === 'internal/service') modelPolicyHandlers.set(event, handler)
        else if (event === 'agent/request') requestPolicy = handler
        else if (event === 'llm/stream') streamPolicy = handler
        else if (event === 'agent/pre-step' || event === 'session/event' || event === 'session/flush') modelPolicyHandlers.set(event, handler)
        else if (event === 'credentials/updated') modelPolicyHandlers.set(event, handler)
        else assert.fail(`unexpected model policy event ${event}`)
        return () => {}
      },
    }
    const modelPolicyConfig = { bindingPath: join(paths.profile, 'plugins', 'runtime-binding.json') }
    await applyModelPolicy(modelPolicyContext, modelPolicyConfig)

    const migratedPolicy = parseCurrentDurablePolicy(records.get('active'))
    assert.deepEqual(migratedPolicy.allowed_model_ids, [
      'deepseek', 'gpt-5.6-luna',
      'gpt-5.6-sol', 'gpt-image-2.5-flare',
    ])
    assert.equal('image_fallback_upstream_model_id' in migratedPolicy, false)
    assert.notEqual(migratedPolicy.policy_sha256, legacyPolicySha256)
    const { policy_sha256: migratedHash, ...migratedPayload } = migratedPolicy
    assert.equal(migratedHash, storedLegacyPolicy(migratedPayload).policy_sha256)
    assert.throws(
      () => policyStorageSchema.parse({ ...legacyPolicy, policy_sha256: '0'.repeat(64) }),
      /legacy model policy is invalid/,
    )
    assert.throws(() => policyStorageSchema.parse(storedLegacyPolicy({
      ...legacyPolicy,
      allowed_model_ids: [
        'deepseek', 'deepseek', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-image-2', 'gpt-image-2-pro',
      ],
    })), /legacy model policy is invalid/)
    assert.throws(() => policyStorageSchema.parse(storedLegacyPolicy({
      ...legacyPolicy,
      allowed_model_ids: [...legacyPolicy.allowed_model_ids, 'deepseek'],
    })))

    assert.equal(rpc.channel, MODEL_POLICY_CHANNEL)
    assert.deepEqual(rpc.options, { authority: 'loopback' })
    assert.equal(credentialValues.has('E_MATE_SEARCH_KEY_DEEPSEEK'), false)
    assert.deepEqual(
      await requestPolicy({}, async () => ({ provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' })),
      { provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' },
    )
    assert.equal(calls.policy, 1)
    const current = await rpc.handler('policy.current', {})
    assert.equal(current.ok, true)
    assert.equal(current.value.revision, 7)
    assert.equal('account_subject' in current.value, false)
    assert.equal('image_fallback_upstream_model_id' in current.value, false)
    assert.equal(current.value.allowed_model_ids.includes('gpt-image-2'), false)
    const refreshedDurablePolicy = parseCurrentDurablePolicy(records.get('active'))
    assert.equal('image_fallback_upstream_model_id' in refreshedDurablePolicy, false)
    assert.equal(refreshedDurablePolicy.allowed_model_ids.includes('gpt-image-2'), false)
    assert.notEqual(refreshedDurablePolicy.policy_sha256, legacyPolicySha256)
    assert.equal(refreshedDurablePolicy.policy_sha256, current.value.policy_sha256)
    assert.equal(projectionRecords.get('active').policy_sha256, current.value.policy_sha256)
    assert.equal(Object.values(llmSettings.providers)
      .flatMap(provider => provider.models.map(model => model.id))
      .includes('gpt-image-2'), false)
    assert.match(refreshedDurablePolicy.policy_sha256, /^[0-9a-f]{64}$/)
    assert.equal(projectionRecords.get('active').search_status, 'granted')
    assert.doesNotMatch(JSON.stringify(projectionRecords.get('active')), /redacted-for-test/u)
    assert.equal(credentialValues.has('E_MATE_MODEL_KEY_GPT'), false)
    assert.equal(credentialValues.has('E_MATE_MODEL_KEY_DEEPSEEK'), false)
    assert.equal(credentialValues.get(MODEL_SESSION_REF), 'model.payload.signature')
    assert.equal(credentialValues.get('E_MATE_SEARCH_KEY_DEEPSEEK'), projectedSearchKey)
    assert.equal(llmSettings.providers['e-mate-enterprise'].baseURL, 'https://mvdcm.ecoremedia.net/e-mate/model-api/v1')
    assert.equal(llmSettings.providers['e-mate-enterprise'].apiKeyEnv, MODEL_SESSION_REF)
    assert.deepEqual(
      llmSettings.providers['e-mate-enterprise'].models.map(model => model.id),
      ['gpt-5.6-luna', 'gpt-5.6-sol'],
    )
    assert.deepEqual(
      llmSettings.providers['e-mate-enterprise-deepseek'].models.map(model => model.id),
      ['deepseek'],
    )
    assert.deepEqual(
      llmSettings.providers['e-mate-enterprise'].models.map(model => model.name),
      ['gpt-5.6-luna', 'gpt-5.6-sol'],
    )
    assert.deepEqual(defaultModelSettings, {
      provider: 'e-mate-enterprise',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'max',
    })
    assert.doesNotMatch(JSON.stringify(llmSettings), /redacted-for-test/u)
    assert.doesNotMatch(JSON.stringify(llmSettings), /runtime-provider-key/u)
    assert.equal((await rpc.handler('unknown', {})).error.code, 'bad-request')

    const nextGenerationSettings = structuredClone(llmSettings)
    nextGenerationSettings.providers['e-mate-enterprise'].baseURL = 'http://next-generation.example:8088/v1'
    const nextGenerationDefault = {
      provider: 'e-mate-enterprise',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
    }
    projectedSearchKey = 'superseded-search-key-redacted-for-test-456'
    let releaseSupersededWrite
    let markSupersededWriteStarted
    const supersededWriteStarted = new Promise(resolve => { markSupersededWriteStarted = resolve })
    delayedCredentialWrite = {
      ref: 'E_MATE_SEARCH_KEY_DEEPSEEK',
      value: projectedSearchKey,
      started: markSupersededWriteStarted,
      release: new Promise(resolve => { releaseSupersededWrite = resolve }),
    }
    const supersededProjection = modelPolicy.refresh({ force: true })
    await supersededWriteStarted
    llmSettings = structuredClone(nextGenerationSettings)
    defaultModelSettings = structuredClone(nextGenerationDefault)
    settingsRevisions.set('llm-pi-ai', settingsRevisions.get('llm-pi-ai') + 1)
    settingsRevisions.set('agent-default-model', settingsRevisions.get('agent-default-model') + 1)
    modelPolicyHandlers.get('credentials/updated')('E_MATE_ENTERPRISE_SESSION')
    releaseSupersededWrite()
    await assert.rejects(supersededProjection, /superseded/u)
    assert.deepEqual(llmSettings, nextGenerationSettings)
    assert.deepEqual(defaultModelSettings, nextGenerationDefault)
    for (const ref of [
      'E_MATE_MODEL_KEY_GPT', 'E_MATE_MODEL_KEY_DEEPSEEK',
      'E_MATE_MODEL_KEY_DOUBAO', 'E_MATE_SEARCH_KEY_DEEPSEEK',
    ]) assert.equal(credentialValues.has(ref), false)
    projectedSearchKey = 'deepseek-key-redacted-for-test-123'
    await modelPolicy.refresh({ force: true })

    searchGrantStatus = 'denied'
    rejectQuotaSnapshotWrite = true
    assert.equal((await modelPolicy.refresh({ force: true })).revision, 7)
    assert.equal(credentialValues.has('E_MATE_SEARCH_KEY_DEEPSEEK'), false)
    assert.equal(projectionRecords.has('active'), false)
    await assert.rejects(
      requestPolicy({}, async () => ({ provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' })),
      /native runtime model projection is not ready/u,
    )
    rejectQuotaSnapshotWrite = false
    await modelPolicy.refresh({ force: true })
    assert.equal(projectionRecords.get('active').search_status, 'denied')
    searchGrantStatus = 'granted'
    await modelPolicy.refresh({ force: true })
    assert.equal(credentialValues.get('E_MATE_SEARCH_KEY_DEEPSEEK'), projectedSearchKey)

    const projectedSettings = structuredClone(llmSettings)
    const projectedDefault = structuredClone(defaultModelSettings)
    const projectedCredentials = new Map(credentialValues)
    const invalidatedSearchCredentials = new Map(projectedCredentials)
    invalidatedSearchCredentials.delete('E_MATE_SEARCH_KEY_DEEPSEEK')
    projectedSearchKey = 'slow-search-key-redacted-for-test-456'
    projectedGptKey = 'fast-fail-gpt-key-redacted-for-test-456'
    let releaseDelayedCredential
    let markCredentialStarted
    const credentialStarted = new Promise(resolve => { markCredentialStarted = resolve })
    delayedCredentialWrite = {
      ref: 'E_MATE_SEARCH_KEY_DEEPSEEK',
      value: projectedSearchKey,
      started: markCredentialStarted,
      release: new Promise(resolve => { releaseDelayedCredential = resolve }),
    }
    rejectedCredentialWrite = { ref: 'E_MATE_SEARCH_KEY_DEEPSEEK', value: projectedSearchKey }
    const orderedFailure = modelPolicy.refresh({ force: true })
    await credentialStarted
    assert.equal(credentialWriteRejected, false)
    releaseDelayedCredential()
    assert.equal((await orderedFailure).revision, 7)
    assert.equal(credentialWriteRejected, true)
    assert.deepEqual(llmSettings, projectedSettings)
    assert.deepEqual(defaultModelSettings, projectedDefault)
    assert.deepEqual(credentialValues, invalidatedSearchCredentials)
    projectedSearchKey = 'deepseek-key-redacted-for-test-123'
    projectedGptKey = 'production-key-redacted-for-test-123'

    projectedGptKey = 'rotated-key-redacted-for-test-456'
    projectedGptBaseUrl = 'http://provider.example:8081/v1'
    policyDefaultModel = 'gpt-5.6-sol'
    failDefaultModelWrite = true
    assert.equal((await modelPolicy.refresh({ force: true })).revision, 7)
    assert.deepEqual(llmSettings, projectedSettings)
    assert.deepEqual(defaultModelSettings, projectedDefault)
    assert.deepEqual(credentialValues, invalidatedSearchCredentials)
    projectedGptKey = 'production-key-redacted-for-test-123'
    projectedGptBaseUrl = 'http://provider.example:8080/v1'
    policyDefaultModel = 'gpt-5.6-luna'
    await modelPolicy.refresh({ force: true })
    assert.deepEqual(credentialValues, projectedCredentials)

    const models = await apiProxy.sessions.models({ rpcId: 'models-1', payload: { sessionId: 'session-1' } })
    assert.deepEqual(models.result.value.groups[0].models.map(model => model.id), [
      'gpt-5.6-sol', 'gpt-5.6-luna', 'deepseek',
    ])
    assert.equal(models.result.value.routable, true)
    const settingsModels = await apiProxy.llm.models({ rpcId: 'models-2', payload: {} })
    assert.deepEqual(settingsModels.result.value.groups[0].models.map(model => model.id), [
      'gpt-5.6-sol', 'gpt-5.6-luna', 'deepseek',
    ])
    const allowed = await apiProxy.sessions.selectModel({
      rpcId: 'select-1', payload: { sessionId: 'session-1', provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' },
    })
    assert.equal(allowed.result.ok, true)
    assert.equal(allowed.result.value.selected.reasoningEffort, 'max')
    const historyBeforeSwitch = structuredClone(session.messages)
    const switched = await apiProxy.sessions.selectModel({
      rpcId: 'select-2', payload: { sessionId: 'session-1', provider: 'e-mate-enterprise', model: 'gpt-5.6-sol' },
    })
    assert.deepEqual(switched.result.value.selected, session.current)
    assert.equal(switched.result.value.selected.reasoningEffort, 'medium')
    assert.deepEqual(session.messages, historyBeforeSwitch)
    assert.equal((await apiProxy.sessions.models({ rpcId: 'models-3', payload: { sessionId: 'session-1' } })).result.value.current.model, 'gpt-5.6-sol')
    const blocked = await apiProxy.sessions.selectModel({
      rpcId: 'select-3', payload: { sessionId: 'session-1', provider: 'e-mate-enterprise', model: 'unknown' },
    })
    assert.equal(blocked.result.error.code, 'model-unavailable')
    assert.deepEqual(calls.selected.map(call => call.model), ['gpt-5.6-luna', 'gpt-5.6-sol'])
    assert.ok(calls.selected.every(call => call.sessionId === 'session-1'))
    assert.deepEqual(
      await requestPolicy({ agent: { id: 'session-1' }, turn: 1, step: 1 }, async () => structuredClone(session.current)),
      session.current,
    )
    await assert.rejects(
      requestPolicy({}, async () => ({ provider: 'e-mate-enterprise', model: 'unknown-native-model' })),
      /not allowed/,
    )
    assert.deepEqual(
      await requestPolicy({}, async () => ({ provider: 'e-mate-enterprise-deepseek', model: 'deepseek' })),
      { provider: 'e-mate-enterprise-deepseek', model: 'deepseek' },
    )
    const { deepFreeze } = await import('../../../upstream/deepseek-harness/packages/llm/llm/lib/index.js')
    const frozenDeepSeek = deepFreeze({ provider: 'e-mate-deepseek', model: 'deepseek', reasoningEffort: 'max', sessionId: 'deepseek-frozen-stream' })
    let reachedDeepSeek = false
    for await (const _chunk of streamPolicy(frozenDeepSeek, () => (async function* () {
      reachedDeepSeek = true
      assert.equal(frozenDeepSeek.reasoningEffort, 'max')
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())) {}
    assert.equal(reachedDeepSeek, true, 'a frozen DeepSeek Max request reaches the native adapter')
    deepseekChatAllowed = false
    await modelPolicy.refresh({ force: true })
    assert.equal(credentialValues.has('E_MATE_MODEL_KEY_DEEPSEEK'), false)
    assert.equal(credentialValues.get('E_MATE_SEARCH_KEY_DEEPSEEK'), projectedSearchKey)
    assert.equal(llmSettings.providers['e-mate-enterprise-deepseek'], undefined)
    assert.deepEqual(
      llmSettings.providers['e-mate-enterprise'].models.map(model => model.id),
      ['gpt-5.6-luna', 'gpt-5.6-sol'],
    )
    assert.doesNotMatch(JSON.stringify(llmSettings), /redacted-for-test/u)
    assert.deepEqual(
      (await apiProxy.sessions.models({ rpcId: 'models-gpt-only', payload: { sessionId: 'session-1' } }))
        .result.value.groups[0].models.map(model => model.id),
      ['gpt-5.6-sol', 'gpt-5.6-luna'],
    )
    await assert.rejects(
      requestPolicy({}, async () => ({ provider: 'e-mate-enterprise-deepseek', model: 'deepseek' })),
      /not allowed/u,
    )
    searchGrantStatus = 'denied'
    rejectSearchUnset = true
    await assert.rejects(
      modelPolicy.refresh({ force: true }),
      /invalid search grant revocation failed/u,
    )
    assert.equal(projectionRecords.has('active'), false)
    assert.equal(credentialValues.get('E_MATE_SEARCH_KEY_DEEPSEEK'), projectedSearchKey)
    await assert.rejects(
      requestPolicy({}, async () => ({ provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' })),
      /invalid search grant revocation failed/u,
    )
    rejectSearchUnset = false
    await modelPolicy.refresh({ force: true })
    assert.equal(credentialValues.has('E_MATE_SEARCH_KEY_DEEPSEEK'), false)
    assert.deepEqual(
      await requestPolicy({}, async () => ({ provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' })),
      { provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' },
    )
    credentialValues.set('E_MATE_SEARCH_KEY_DEEPSEEK', 'stale-search-key-redacted-for-test-000')
    searchGrantStatus = 'unavailable'
    await modelPolicy.refresh({ force: true })
    assert.equal(credentialValues.has('E_MATE_SEARCH_KEY_DEEPSEEK'), false)
    projectedSearchKey = 'rotated-search-key-redacted-for-test-789'
    searchGrantStatus = 'granted'
    await modelPolicy.refresh({ force: true })
    assert.equal(credentialValues.get('E_MATE_SEARCH_KEY_DEEPSEEK'), projectedSearchKey)
    searchGrantFailure = Object.assign(
      new Error('e-Mate enterprise search credential grant is invalid'),
      { code: 'E_MATE_SEARCH_GRANT_INVALID' },
    )
    rejectProjectionMarkerWrite = true
    await assert.rejects(
      modelPolicy.refresh({ force: true }),
      /runtime projection marker failure/u,
    )
    assert.equal(projectionRecords.has('active'), false)
    assert.equal(credentialValues.has('E_MATE_SEARCH_KEY_DEEPSEEK'), false)
    await assert.rejects(
      requestPolicy({}, async () => ({ provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' })),
      /runtime projection marker failure/u,
    )
    rejectProjectionMarkerWrite = false
    assert.equal((await modelPolicy.refresh({ force: true })).revision, 7)
    assert.equal(credentialValues.has('E_MATE_SEARCH_KEY_DEEPSEEK'), false)
    assert.equal(projectionRecords.get('active').search_status, 'unavailable')
    assert.deepEqual(
      await requestPolicy({}, async () => ({ provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' })),
      { provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' },
    )
    searchGrantFailure = undefined
    await modelPolicy.refresh({ force: true })
    assert.equal(credentialValues.get('E_MATE_SEARCH_KEY_DEEPSEEK'), projectedSearchKey)
    searchGrantFailure = Object.assign(
      new Error('e-Mate enterprise search credential grant is invalid'),
      { code: 'E_MATE_SEARCH_GRANT_INVALID' },
    )
    rejectSearchUnset = true
    await assert.rejects(
      modelPolicy.refresh({ force: true }),
      /invalid search grant revocation failed/u,
    )
    assert.equal(projectionRecords.has('active'), false)
    assert.equal(credentialValues.get('E_MATE_SEARCH_KEY_DEEPSEEK'), projectedSearchKey)
    rejectSearchUnset = false
    assert.equal((await modelPolicy.refresh({ force: true })).revision, 7)
    assert.equal(credentialValues.has('E_MATE_SEARCH_KEY_DEEPSEEK'), false)
    searchGrantFailure = undefined
    await modelPolicy.refresh({ force: true })
    assert.equal(credentialValues.get('E_MATE_SEARCH_KEY_DEEPSEEK'), projectedSearchKey)
    rejectProjectionMarkerWrite = true
    projectedSearchKey = 'marker-failure-search-key-redacted-for-test-321'
    assert.equal((await modelPolicy.refresh({ force: true })).revision, 7)
    assert.equal(projectionRecords.has('active'), false)
    await assert.rejects(
      requestPolicy({}, async () => ({ provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' })),
      /native runtime model projection is not ready/u,
    )
    rejectProjectionMarkerWrite = false
    await modelPolicy.refresh({ force: true })
    assert.equal(credentialValues.get('E_MATE_SEARCH_KEY_DEEPSEEK'), projectedSearchKey)
    await requestPolicy({ agent: { id: 'oversized-session' }, turn: 1, step: 1 }, async () => ({ provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' }))
    const sizeBlocked = []
    for await (const chunk of streamPolicy(
      { provider: 'e-mate-enterprise', model: 'gpt-5.6-luna', sessionId: 'oversized-session', messages: [{ role: 'user', content: [{ type: 'image', attachment: { bytes: 37 * 1024 * 1024 } }] }] },
      () => { assert.fail('oversized request must not reach the provider or attachment reader') },
    )) sizeBlocked.push(chunk)
    assert.equal(sizeBlocked[0].reason.failure.code, 'REQUEST_TOO_LARGE')
    assert.equal(sizeBlocked[0].reason.failure.status, 413)
    for (const thrown of [false, true]) {
      let sent = 0
      const failed = []
      for await (const chunk of streamPolicy(
        { provider: 'e-mate-enterprise', model: 'gpt-5.6-luna', sessionId: `size-rejected-${thrown}` },
        () => (async function* () {
          sent++
          const failure = { code: 'PI_AI_ERROR', status: 413, message: 'OpenAI API error (413): <html>private upstream diagnostic</html>' }
          if (thrown) throw Object.assign(new Error(failure.message), failure)
          yield { type: 'finish', reason: { kind: 'error', failure } }
        })(),
      )) failed.push(chunk)
      assert.equal(sent, 1)
      assert.equal(failed[0].reason.failure.code, 'REQUEST_TOO_LARGE')
      assert.doesNotMatch(failed[0].reason.failure.message, /html|private/u)
    }
    const policyCallsBeforeHotPath = calls.policy
    await requestPolicy(
      { agent: { id: 'session-1' }, turn: 1, step: 1 },
      async () => ({ provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' }),
    )
    const streamed = []
    for await (const chunk of streamPolicy(
      { provider: 'e-mate-enterprise', model: 'gpt-5.6-luna', sessionId: 'session-1' },
      () => (async function* () {
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    )) streamed.push(chunk)
    assert.deepEqual(streamed.map(chunk => chunk.type), ['usage', 'finish'])
    assert.equal(calls.policy, policyCallsBeforeHotPath)
    modelPolicyHandlers.get('session/event')({ id: 'session-1' }, {
      type: 'assistant/message',
      seq: 9,
      time: now,
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'model', provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' },
        },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
      },
    })
    await modelPolicyHandlers.get('session/flush')()
    assert.equal(quotaRecords.usage.size, 1)
    assert.equal(quotaRecords.reservations.size, 0)

    await requestPolicy(
      { agent: { id: 'session-throw' }, turn: 1, step: 1 },
      async () => ({ provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' }),
    )
    const streamFailure = new Error('real downstream stream failure')
    await assert.rejects(async () => {
      for await (const _chunk of streamPolicy(
        { provider: 'e-mate-enterprise', model: 'gpt-5.6-luna', sessionId: 'session-throw' },
        () => (async function* () { throw streamFailure })(),
      )) {}
    }, error => error === streamFailure)
    assert.equal(quotaRecords.reservations.size, 0)

    await requestPolicy(
      { agent: { id: 'session-no-finish' }, turn: 1, step: 1 },
      async () => ({ provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' }),
    )
    for await (const _chunk of streamPolicy(
      { provider: 'e-mate-enterprise', model: 'gpt-5.6-luna', sessionId: 'session-no-finish' },
      () => (async function* () { yield { type: 'text-delta', index: 0, text: 'partial' } })(),
    )) {}
    assert.equal(quotaRecords.reservations.size, 1)

    await assert.rejects(async () => {
      for await (const _chunk of streamPolicy(
        { provider: 'e-mate-enterprise', model: 'unknown-native-model' },
        () => (async function* () { yield 'blocked' })(),
      )) {}
    }, /not allowed/)

    providerAvailable = false
    assert.equal((await modelPolicy.refresh({ force: true })).revision, 7)
    const cachedSwitch = await apiProxy.sessions.selectModel({
      rpcId: 'select-4', payload: { sessionId: 'session-1', provider: 'e-mate-enterprise', model: 'gpt-5.6-luna', reasoningEffort: 'max' },
    })
    assert.equal(cachedSwitch.result.ok, true)
    assert.deepEqual(session.messages, historyBeforeSwitch)
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    openedDomains = 0
    await applyModelPolicy(modelPolicyContext, modelPolicyConfig)
    assert.deepEqual(
      await requestPolicy({}, async () => ({ provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' })),
      { provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' },
    )
    providerAvailable = true
    astraAllowed = true
    await modelPolicy.refresh({ force: true })
    // Simulate a restored native session whose persisted selection predates this policy.
    session.current = { provider: 'e-mate-enterprise', model: 'gpt-6-astra', reasoningEffort: 'medium' }
    const astraHistory = structuredClone(session.messages)
    const restored = await apiProxy.sessions.models({ rpcId: 'astra-restored', payload: { sessionId: 'session-1' } })
    assert.equal(restored.result.value.current.reasoningEffort, 'low')
    assert.deepEqual(llmSettings.providers['e-mate-enterprise'].models.find(model => model.id === 'gpt-6-astra').reasoningEfforts, { low: 'low' })
    const oldSelection = deepFreeze({ ...session.current, sessionId: 'astra-restored-stream' })
    const restoredOptions = deepFreeze(await requestPolicy({}, async () => oldSelection))
    assert.equal(oldSelection.reasoningEffort, 'medium', 'selection migration must not mutate the original native config')
    assert.notEqual(restoredOptions, oldSelection)
    for await (const _chunk of streamPolicy(restoredOptions, () => (async function* () {
      assert.equal(restoredOptions.reasoningEffort, 'low', 'effective options reach the native adapter after migration')
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())) {}
    const selectedAstra = await apiProxy.sessions.selectModel({ rpcId: 'astra-select', payload: { ...session.current, sessionId: 'session-1' } })
    assert.equal(selectedAstra.result.value.selected.reasoningEffort, 'low')
    assert.deepEqual(session.messages, astraHistory)
    records.set('active', storedLegacyPolicy({ ...policy(), image_primary_model_id: 'gpt-image-2-pro', default_chat_model_id: 'gpt-6-astra', default_chat_reasoning_effort: 'medium', image_fallback_upstream_model_id: 'gpt-image-2', allowed_model_ids: [...policy().allowed_model_ids.filter(id => id !== 'gpt-image-2.5-flare'), 'gpt-image-2-pro', 'gpt-image-2'] }))
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    openedDomains = 0
    await applyModelPolicy(modelPolicyContext, modelPolicyConfig)
    assert.equal(records.get('active').default_chat_reasoning_effort, 'low', 'hashed previous Astra default policy migrates on cold restore')
    accountSubject = 'account:other-207'
    assert.deepEqual(
      await requestPolicy({}, async () => ({ provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' })),
      { provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' },
    )
    assert.equal(records.get('active').account_subject, accountSubject)
    accountSubject = 'account:invalid-search-grant-207'
    credentialValues.set('E_MATE_SEARCH_KEY_DEEPSEEK', 'stale-no-cache-search-key-redacted-for-test-000')
    searchGrantFailure = Object.assign(
      new Error('e-Mate enterprise search credential grant is invalid'),
      { code: 'E_MATE_SEARCH_GRANT_INVALID' },
    )
    await assert.rejects(
      modelPolicy.refresh({ force: true }),
      /search credential grant is invalid/u,
    )
    assert.equal(credentialValues.has('E_MATE_SEARCH_KEY_DEEPSEEK'), false)
    assert.equal(projectionRecords.has('active'), false)
    searchGrantFailure = undefined
    providerAvailable = false
    accountSubject = 'account:unavailable-207'
    await assert.rejects(
      requestPolicy({}, async () => ({ provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' })),
      /enterprise unavailable/,
    )
    await assert.rejects(modelPolicy.refresh({ force: true }), /enterprise unavailable/)
    assert.throws(
      () => validateModelPolicy({ ...policy(), allowed_model_ids: ['gpt-5.6-luna', 'unknown'] }, accountSubject, now),
      /policy is invalid/,
    )
    assert.throws(
      () => validateModelPolicy(legacyPolicy, accountSubject, now),
      /policy is invalid/,
    )
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup()
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('local weekly quota serializes finite accounts and settles only real terminal Harness usage', async () => {
  const monday = new Date()
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
  monday.setUTCHours(0, 0, 0, 0)
  let clock = monday.getTime() + 24 * 60 * 60_000
  let subject = 'account:quota-207'
  let limit = 100
  let enterpriseTokens = 90
  let calculatedAt = clock
  let usageAvailable = true
  const records = { snapshots: new Map(), reservations: new Map(), usage: new Map() }
  const table = name => ({
    entries: () => records[name].entries(),
    put: async (key, value) => { records[name].set(key, structuredClone(value)) },
    delete: async key => records[name].delete(key),
  })
  const warnings = []
  const identity = {
    localAccountSubject: () => subject,
    state: async () => ({
      authenticated: true,
      workspace_unlocked: true,
      account_subject: subject,
      weekly_token_limit: limit,
    }),
    usage: async timezone => {
      if (!usageAvailable) throw new Error('enterprise unavailable')
      return {
        schema_version: 1,
        scope: 'account',
        timezone,
        week: { total_tokens: enterpriseTokens },
        week_started_at: monday.toISOString(),
        calculated_at: new Date(calculatedAt).toISOString(),
      }
    },
  }
  const service = () => createQuotaService(
    { emateIdentity: identity, logger: { warn: message => warnings.push(message) } },
    table('snapshots'),
    table('reservations'),
    table('usage'),
    () => clock,
  )
  const quota = service()
  const policy = () => ({
    account_subject: subject,
    expires_at: new Date(monday.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
  })
  const arm = (target, turn = 1, step = 1) => quota.armRequest(
    { agent: { id: target }, turn, step },
    { provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' },
  )
  const options = target => ({
    sessionId: target,
    provider: 'e-mate-enterprise',
    model: 'gpt-5.6-luna',
  })

  arm('oversized')
  assert.equal(quota.isArmed(options('oversized')), true)
  quota.disarmRequest(options('oversized'))
  assert.equal(quota.isArmed(options('oversized')), false)
  assert.equal(records.reservations.size, 0)

  await quota.refresh(policy())
  arm('quota-session-1')
  const failed = await quota.admit(options('quota-session-1'))
  assert.equal(records.reservations.values().next().value.reserved_tokens, 10)
  arm('quota-session-2')
  await assert.rejects(quota.admit(options('quota-session-2')), /unsettled request/)
  await quota.finish(failed, undefined, 'error')
  assert.equal(records.reservations.size, 0)

  arm('quota-session-3')
  const completed = await quota.admit(options('quota-session-3'))
  const realUsage = { inputTokens: 2, outputTokens: 3 }
  await quota.finish(completed, realUsage, 'stop')
  const event = {
    type: 'assistant/message',
    seq: 7,
    time: clock,
    data: {
      turn: 1,
      step: 1,
      message: { source: { kind: 'model', provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' } },
      usage: realUsage,
    },
  }
  await quota.captureEvent('quota-session-3', event)
  await quota.captureEvent('quota-session-3', structuredClone(event))
  assert.equal(records.usage.size, 1)
  assert.equal(records.reservations.size, 0)
  assert.deepEqual(quota.status(), {
    ready: true,
    unlimited: false,
    enterprise_tokens: 90,
    local_tokens: 5,
    reservations: 0,
  })

  const factId = records.usage.keys().next().value
  await quota.markAuditDelivered(factId, new Date(clock).toISOString())
  clock += 1
  calculatedAt = clock
  enterpriseTokens = 95
  await quota.refresh(policy())
  assert.equal(quota.status().local_tokens, 0)

  usageAvailable = false
  arm('quota-session-offline')
  const orphan = await quota.admit(options('quota-session-offline'))
  const restarted = service()
  restarted.armRequest(
    { agent: { id: 'quota-session-restart' }, turn: 1, step: 1 },
    { provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' },
  )
  await assert.rejects(
    restarted.admit(options('quota-session-restart')),
    /unsettled request/,
  )
  await restarted.finish(orphan, undefined, 'aborted')
  assert.equal(records.reservations.size, 0)

  usageAvailable = true
  enterpriseTokens = 100
  calculatedAt = ++clock
  await restarted.refresh(policy())
  restarted.armRequest(
    { agent: { id: 'quota-session-exhausted' }, turn: 1, step: 1 },
    { provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' },
  )
  await assert.rejects(
    restarted.admit(options('quota-session-exhausted')),
    /allowance is exhausted/,
  )

  subject = 'account:other-207'
  assert.deepEqual(restarted.status(), { ready: false })
  subject = 'account:unlimited-207'
  limit = Number.MAX_SAFE_INTEGER
  enterpriseTokens = 123_456
  usageAvailable = true
  calculatedAt = clock
  await restarted.refresh(policy())
  restarted.armRequest(
    { agent: { id: 'quota-unlimited-1' }, turn: 1, step: 1 },
    { provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' },
  )
  restarted.armRequest(
    { agent: { id: 'quota-unlimited-2' }, turn: 1, step: 1 },
    { provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' },
  )
  assert.equal((await restarted.admit(options('quota-unlimited-1'))).unlimited, true)
  assert.equal((await restarted.admit(options('quota-unlimited-2'))).unlimited, true)
  assert.equal(records.reservations.size, 0)
  clock = monday.getTime() + 7 * 24 * 60 * 60_000
  assert.deepEqual(restarted.status(), { ready: false })
  assert.deepEqual(warnings, [
    'e-Mate finite weekly quota permits one in-flight request; one real request may exceed its remaining allowance',
  ])
})


test('audit derives strict attachment and parent append stages without claiming UI visibility', () => {
  const time = Date.parse('2027-01-02T03:04:05.000Z')
  const taskId = 'sha256:' + 'a'.repeat(64)
  const batchId = 'sha256:' + 'b'.repeat(64)
  const clientRequestId = 'image-' + 'a'.repeat(64)
  const image = { attachmentId: 'sha256:' + 'c'.repeat(64), mediaType: 'image/png', bytes: 8, width: 1, height: 1 }
  const attachment = imageBatchAuditCorrelation({ time, type: 'emate/image-output', data: {
    schema_version: 2, status: 'completed', billing_status: 'recorded', client_request_id: clientRequestId,
    output: image, content: [{ type: 'image', attachment: { ...image } }],
  } })
  assert.deepEqual(attachment, {
    schema_version: 1, stage: 'attachment_commit', trace_id: clientRequestId,
    client_request_id: clientRequestId, task_id: taskId, occurred_at: '2027-01-02T03:04:05.000Z',
  })
  const parent = imageBatchAuditCorrelation({ time, type: 'emate/image-batch', data: {
    kind: 'task-state', batch_id: batchId, task: { task_id: taskId, ordinal: 4, state: 'completed' },
  } })
  assert.deepEqual(parent, {
    schema_version: 1, stage: 'parent_projection_append', trace_id: clientRequestId,
    client_request_id: clientRequestId, task_id: taskId, batch_id: batchId, ordinal: 4,
    occurred_at: '2027-01-02T03:04:05.000Z',
  })
  for (const observation of [attachment, parent]) {
    const serialized = JSON.stringify(observation)
    for (const forbidden of ['prompt', 'b64_json', 'nonce', 'secret', '/Users/', 'projection_visible']) {
      assert.equal(serialized.includes(forbidden), false)
    }
  }
  for (const invalid of [
    { time, type: 'emate/image-output', data: { schema_version: 2, status: 'failed', billing_status: 'not-submitted', client_request_id: clientRequestId, content: [] } },
    { time, type: 'emate/image-output', data: { schema_version: 2, status: 'completed', billing_status: 'recorded', client_request_id: clientRequestId, output: image, content: [] } },
    { time: Number.NaN, type: 'emate/image-output', data: { schema_version: 2, status: 'completed', billing_status: 'recorded', client_request_id: clientRequestId, output: image, content: [{ type: 'image', attachment: image }] } },
  ]) assert.equal(imageBatchAuditCorrelation(invalid), undefined)
})

test('audit records only real Harness usage and deduplicates reconnect replay and concurrent flush', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'e-mate-audit-'))
  const tables = { bindings: new Map(), outbox: new Map() }
  const taskTables = { bindings: new Map(), outbox: new Map() }
  let accountSubject = 'tenant-207:user-207'
  let principalActive = true
  taskTables.bindings.set(`${createHash('sha256').update('historical-preview-session').digest('hex')}:3`, {
    schema_version: 1,
    account_subject_sha256: createHash('sha256').update(accountSubject).digest('hex'),
    created_at: new Date().toISOString(),
  })
  const handlers = new Map()
  const cleanups = []
  const uploads = []
  const taskUploads = []
  const deliveredFacts = []
  let audit
  let rpc
  let interval
  let uploadAvailable = false
  let notifyAuditContextStarted
  let releaseAuditContext
  const auditContextStarted = new Promise(resolve => { notifyAuditContextStarted = resolve })
  const auditContextGate = new Promise(resolve => { releaseAuditContext = resolve })
  const provider = {
    async upload(facts) {
      uploads.push(structuredClone(facts))
      if (!uploadAvailable) throw new Error('audit endpoint unavailable')
      return {
        schema_version: 1,
        receipts: facts.map(fact => ({
          fact_id: fact.fact_id,
          payload_sha256: fact.payload_sha256,
          receipt_id: `audit-receipt:${fact.fact_id.slice(-16)}`,
          accepted_at: new Date().toISOString(),
        })),
      }
    },
  }
  const taskProvider = {
    async upload(facts) {
      taskUploads.push(structuredClone(facts))
      if (!uploadAvailable) throw new Error('task audit endpoint unavailable')
      return {
        schema_version: 1,
        receipts: facts.map(fact => ({
          event_id: fact.event_id,
          payload_sha256: fact.payload_sha256,
          receipt_id: `task-receipt:${fact.event_id.slice(-16)}`,
          accepted_at: new Date().toISOString(),
        })),
      }
    },
  }
  const domain = source => ({
    table: name => ({
      entries: () => source[name].entries(),
      put: async (key, value) => { source[name].set(key, structuredClone(value)) },
    }),
    close: async () => {},
  })
  let openedDomains = 0
  try {
    const bindingPath = writeAuditRuntimeBinding(temporary)
    await applyAudit({
      connection: { rpc: { handle: (channel, handler, options) => {
        rpc = { channel, handler, options }
        return () => {}
      } } },
      sessionPersistence: { list: async () => [], readFrom: async () => ({ events: [] }) },
      storageDomain: { open: async () => domain(openedDomains++ === 0 ? tables : taskTables) },
      emateIdentity: {
        localAccountSubject: () => accountSubject,
        localAccountPrincipal: () => principalActive ? { tenantId: accountSubject.split(':')[0], userId: accountSubject.split(':')[1] } : undefined,
      },
      emateModelPolicy: {
        auditContext: async model => {
          assert.equal(model, 'gpt-5.6-luna')
          notifyAuditContextStarted()
          await auditContextGate
          return {
            account_subject_sha256: 'a'.repeat(64),
            policy_revision: 3,
            policy_receipt_id: 'policy-receipt:audit-207',
            policy_sha256: 'b'.repeat(64),
          }
        },
        markAuditDelivered: async (factId, acceptedAt) => {
          deliveredFacts.push({ factId, acceptedAt })
        },
      },
      provide: (name, value) => {
        assert.equal(name, 'emateAudit')
        audit = value
      },
      effect(effect) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
        return cleanup
      },
      on: (event, handler) => {
        handlers.set(event, handler)
        return () => { handlers.delete(event) }
      },
      interval: (callback, milliseconds) => {
        interval = { callback, milliseconds }
        return () => {}
      },
      logger: { warn: () => {} },
    }, {
      bindingPath,
      auditProvider: provider,
      taskAuditProvider: taskProvider,
      flushIntervalMs: 30_000,
    })
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(rpc.channel, AUDIT_CHANNEL)
    assert.deepEqual(rpc.options, { authority: 'loopback' })
    assert.equal(interval.milliseconds, 30_000)
    assert.equal(audit.ownsTask('historical-preview-session', 3), true)
    assert.equal(audit.ownsTask('historical-preview-session', 2), false)
    assert.equal(audit.ownsTask('missing-session', 3), false)
    for (const sessionId of ['', null, 3]) assert.equal(audit.ownsTask(sessionId, 3), false)
    for (const turn of [0, -1, 1.5, '3', NaN]) assert.equal(audit.ownsTask('historical-preview-session', turn), false)
    principalActive = false
    assert.equal(audit.ownsTask('historical-preview-session', 3), false)
    principalActive = true
    accountSubject = 'tenant-207:another-user'
    assert.equal(audit.ownsTask('historical-preview-session', 3), false)
    accountSubject = 'another-tenant:user-207'
    assert.equal(audit.ownsTask('historical-preview-session', 3), false)
    accountSubject = 'tenant-207:user-207'
    assert.equal(audit.ownsTask('historical-preview-session', 3), true)
    assert.equal(taskTables.bindings.size, 1)
    const startedAt = Date.now()
    handlers.get('session/event')({ id: 'audit-session-1' }, {
      type: 'turn/start', seq: 0, time: startedAt, data: { turn: 1 },
    })
    let requestDone = false
    const requestPromise = handlers.get('agent/request')({
      agent: { id: 'audit-session-1' }, turn: 1, step: 1,
    }, async () => ({ provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' }))
    void requestPromise.then(
      () => { requestDone = true },
      () => { requestDone = true },
    )
    await auditContextStarted
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(requestDone, true)
    const request = await requestPromise
    assert.deepEqual(request, { provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' })
    const event = {
      type: 'assistant/message',
      seq: 8,
      time: startedAt + 1,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-message-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'must never enter audit payload' }],
          source: { kind: 'model', provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' },
        },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 1 },
      },
    }
    handlers.get('session/event')({ id: 'audit-session-1' }, event)
    await audit.drain('audit-session-1')
    assert.equal(tables.outbox.size, 0)
    releaseAuditContext()
    await new Promise(resolve => setImmediate(resolve))
    await audit.drain('audit-session-1')
    handlers.get('session/event')({ id: 'audit-session-1' }, {
      type: 'tool/call', seq: 9, time: startedAt + 2,
      data: { turn: 1, step: 1, callId: 'private-call-id', name: 'private-tool-name', arguments: '{"secret":true}' },
    })
    handlers.get('session/event')({ id: 'audit-session-1' }, {
      type: 'approval/asked', seq: 10, time: startedAt + 3,
      data: { id: 'private-approval-id', toolName: 'private-tool-name' },
    })
    handlers.get('session/event')({ id: 'audit-session-1' }, {
      type: 'turn/end', seq: 11, time: startedAt + 4,
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    assert.equal(handlers.get('session/flush')({ id: 'audit-session-1' }), undefined)
    await audit.drain('audit-session-1')
    assert.equal(tables.bindings.size, 1)
    assert.equal(tables.outbox.size, 1)
    assert.equal(taskTables.bindings.size, 2)
    assert.equal(taskTables.outbox.size, 5)
    assert.deepEqual(
      [...taskTables.outbox.values()].map(record => record.payload.type),
      ['RECEIVED', 'FIRST_RESPONSE', 'TOOL_EXECUTION', 'PERMISSION_REQUESTED', 'COMPLETED'],
    )
    assert.ok([...taskTables.outbox.values()].every(record => record.payload.scenario === 'GENERAL'))
    assert.equal(JSON.stringify([...taskTables.outbox.values()]).includes('private-tool-name'), false)
    assert.equal(JSON.stringify([...taskTables.outbox.values()]).includes('private-call-id'), false)
    const stored = [...tables.outbox.values()][0]
    assert.equal(stored.status, 'pending')
    assert.equal(stored.payload.total_tokens, 17)
    assert.equal(stored.payload.account_subject_sha256, 'a'.repeat(64))
    assert.equal(JSON.stringify(stored).includes('audit-session-1'), false)
    assert.equal(JSON.stringify(stored).includes('must never enter audit payload'), false)
    handlers.get('session/event')({ id: 'audit-session-1' }, event)
    await audit.drain('audit-session-1')
    assert.equal(tables.outbox.size, 1)

    const deferred = await audit.flush({ force: true })
    assert.equal(deferred.delivered_now, 0)
    assert.match(deferred.error_code, /^[0-9a-f]{16}$/)
    assert.equal(audit.status().pending, 1)
    assert.equal(audit.status().task_events_pending, 5)
    uploadAvailable = true
    const [delivered, sameFlight] = await Promise.all([
      audit.flush({ force: true }),
      audit.flush({ force: true }),
    ])
    await audit.drain()
    assert.deepEqual(sameFlight, delivered)
    assert.equal(delivered.delivered_now, 1)
    assert.equal(delivered.delivered, 1)
    assert.equal(delivered.task_delivered_now, 5)
    assert.equal(deliveredFacts.length, 1)
    assert.equal(deliveredFacts[0].factId, stored.fact_id)
    assert.equal(Number.isFinite(Date.parse(deliveredFacts[0].acceptedAt)), true)
    assert.equal(tables.outbox.values().next().value.status, 'delivered')
    assert.equal(uploads.length, 2)
    assert.equal(taskUploads.length, 2)
    assert.equal('content' in uploads[1][0].payload, false)
    assert.deepEqual(uploads[1][0], uploads[0][0])
    handlers.get('session/event')({ id: 'audit-session-1' }, structuredClone(event))
    await audit.drain('audit-session-1')
    assert.equal((await audit.flush({ force: true })).delivered_now, 0)
    assert.equal(uploads.length, 2)
    const status = await rpc.handler('audit.status', {})
    assert.equal(status.value.delivered_tokens, 17)
    assert.equal(status.value.task_events_delivered, 5)
    assert.equal((await rpc.handler('unknown', {})).error.code, 'bad-request')

    const blocked = createUsageFact('unbound-session', event, undefined)
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.last_error_code, 'identity-policy-binding-missing-or-conflicting')
    const taskFact = createTaskAuditFact('audit-session-1', {
      type: 'turn/end', seq: 12, time: startedAt + 5, data: { turn: 2, reason: { kind: 'aborted' } },
    }, 'CANCELLED', { schema_version: 1, account_subject_sha256: 'e'.repeat(64) })
    assert.equal(taskFact.payload.type, 'CANCELLED')
    assert.equal(JSON.stringify(taskFact).includes('audit-session-1'), false)
  } finally {
    releaseAuditContext()
    for (const cleanup of cleanups.reverse()) await cleanup()
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('audit locks terminal scenarios from trusted local outcomes', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'e-mate-audit-scenarios-'))
  const taskTables = { bindings: new Map(), outbox: new Map() }
  const usageTables = { bindings: new Map(), outbox: new Map() }
  const handlers = new Map()
  const cleanups = []
  let audit
  const domain = source => ({
    table: name => ({
      entries: () => source[name].entries(),
      put: async (key, value) => { source[name].set(key, structuredClone(value)) },
    }),
    close: async () => {},
  })
  let openedDomains = 0
  try {
    const bindingPath = writeAuditRuntimeBinding(temporary)
    await applyAudit({
      connection: { rpc: { handle: () => () => {} } },
      sessionPersistence: { list: async () => [], readFrom: async () => ({ events: [] }) },
      storageDomain: { open: async () => domain(openedDomains++ === 0 ? usageTables : taskTables) },
      tools: {
        provenance(name, agent) {
          if (agent.id === 'audit-provenance-error') throw new Error('private provenance failure')
          if (name === 'univer_new' && agent.id === 'audit-private-office') {
            return { moduleSpecifier: './private/office.js', pluginName: 'private-office' }
          }
          if (name === 'univer_inspect') {
            return {
              moduleSpecifier: './node_modules/@e-mate/dsh-plugin-univer-office/lib/index.js',
              pluginName: 'univer-tools',
            }
          }
          if (name === 'univer_new') {
            return { moduleSpecifier: '@e-mate/dsh-plugin-univer-office', pluginName: 'univer-tools' }
          }
          if (name === 'generate_image' || name === 'edit_image') {
            return { moduleSpecifier: './node_modules/@e-mate/dsh-plugin-imagegen/lib/index.js', pluginName: 'emate-imagegen' }
          }
          if (name === 'web_search') {
            return { moduleSpecifier: '@deepseek-ai/dsh-tool-web', pluginName: 'tool-web' }
          }
        },
      },
      emateIdentity: { localAccountSubject: () => 'tenant-207:user-207' },
      emateModelPolicy: { markAuditDelivered: async () => {} },
      provide: (_name, value) => { audit = value },
      effect(effect) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
        return cleanup
      },
      on: (event, handler) => {
        handlers.set(event, handler)
        return () => { handlers.delete(event) }
      },
      interval: () => () => {},
      logger: { warn: () => {} },
    }, {
      bindingPath,
      auditProvider: {},
      taskAuditProvider: {},
      flushIntervalMs: 30_000,
    })
    await new Promise(resolve => setImmediate(resolve))

    const run = (sessionId, time, {
      model = 'gpt-5.6-luna',
      reason = 'completed',
      terminalEvidence,
    } = {}) => {
      const agent = { id: sessionId }
      handlers.get('session/event')(agent, {
        type: 'turn/start', seq: 0, time, data: { turn: 1 },
      })
      handlers.get('session/event')(agent, {
        type: 'assistant/message', seq: 1, time: time + 1,
        data: {
          turn: 1,
          step: 1,
          message: {
            content: [{ type: 'text', text: `private-response:${sessionId}` }],
            source: { kind: 'model', provider: 'e-mate-enterprise', model },
          },
        },
      })
      terminalEvidence?.(agent, time)
      handlers.get('session/event')(agent, {
        type: 'turn/end', seq: 4, time: time + 4,
        data: { turn: 1, reason: { kind: reason } },
      })
    }

    const settleTool = (agent, time, name, isError = false) => {
      handlers.get('session/event')(agent, {
        type: 'tool/call', seq: 2, time: time + 2,
        data: {
          turn: 1,
          step: 1,
          callId: `private-call:${agent.id}`,
          name,
          arguments: '{"path":"/private/customer.docx","prompt":"secret"}',
        },
      })
      handlers.get('tools/result')({
        name,
        callId: `private-call:${agent.id}`,
        arguments: { path: '/private/customer.docx' },
        agent,
      }, {
        isError,
        content: [{ type: 'text', text: 'private tool result' }],
        ...(isError ? { error: { name: 'Error', code: 'PRIVATE_FAILURE' } } : { value: null }),
      })
    }

    const startedAt = Date.now()
    run('audit-content', startedAt)
    run('audit-office', startedAt + 100, {
      terminalEvidence: (agent, time) => { settleTool(agent, time, 'univer_new') },
    })
    const imageReceipt = (status, schemaVersion = 2) => (agent, time) => {
      handlers.get('session/event')(agent, {
        type: 'emate/image-output', seq: 2, time: time + 2,
        data: {
          schema_version: schemaVersion,
          call_id: `private-image-call:${agent.id}`,
          parent_session_id: agent.id,
          status,
          output: { attachmentId: 'sha256:private-attachment', fileName: 'private-image.png' },
        },
      })
    }
    run('audit-image', startedAt + 200, { terminalEvidence: imageReceipt('completed') })
    run('audit-search', startedAt + 300, {
      terminalEvidence: (agent, time) => { settleTool(agent, time, 'web_search') },
    })
    run('audit-private-office', startedAt + 400, {
      terminalEvidence: (agent, time) => { settleTool(agent, time, 'univer_new') },
    })
    run('audit-unknown', startedAt + 500, {
      terminalEvidence: (agent, time) => { settleTool(agent, time, 'private_tool') },
    })
    run('audit-provenance-error', startedAt + 600, {
      terminalEvidence: (agent, time) => { settleTool(agent, time, 'univer_new') },
    })
    run('audit-conflict', startedAt + 700, {
      terminalEvidence: (agent, time) => {
        settleTool(agent, time, 'univer_inspect')
        imageReceipt('completed')(agent, time)
      },
    })
    run('audit-office-cancelled', startedAt + 800, {
      reason: 'aborted',
      terminalEvidence: (agent, time) => { settleTool(agent, time, 'univer_new', true) },
    })
    run('audit-image-cancelled', startedAt + 900, {
      reason: 'interrupted',
      terminalEvidence: imageReceipt('failed'),
    })
    run('audit-model-name-only', startedAt + 1_000, { model: 'gpt-image-2.5-flare' })
    run('audit-generate-image-tool', startedAt + 1_100, {
      terminalEvidence: (agent, time) => { settleTool(agent, time, 'generate_image', true) },
    })
    run('audit-edit-image-tool', startedAt + 1_150, {
      terminalEvidence: (agent, time) => { settleTool(agent, time, 'edit_image', true) },
    })
    run('audit-document-with-search', startedAt + 1_200, {
      terminalEvidence: (agent, time) => {
        settleTool(agent, time, 'web_search')
        settleTool(agent, time, 'univer_inspect')
      },
    })
    run('audit-document-with-run-code', startedAt + 1_250, {
      terminalEvidence: (agent, time) => {
        settleTool(agent, time, 'univer_inspect')
        settleTool(agent, time, 'run_code')
      },
    })
    run('audit-image-v3', startedAt + 1_275, { terminalEvidence: imageReceipt('completed', 3) })
    const abandonedAgent = { id: 'audit-abandoned' }
    handlers.get('session/event')(abandonedAgent, {
      type: 'turn/start', seq: 0, time: startedAt + 1_300, data: { turn: 1 },
    })
    settleTool(abandonedAgent, startedAt + 1_300, 'univer_new')
    handlers.get('agent/disposed')({ agent: abandonedAgent })
    await audit.drain()

    const taskRecords = [...taskTables.outbox.values()]
    assert.deepEqual(taskRecords
      .filter(record => record.payload.type === 'RECEIVED')
      .sort((left, right) => left.payload.occurredAt.localeCompare(right.payload.occurredAt))
      .map(record => record.payload.scenario), [
      'CONTENT_CREATION',
      'DOCUMENT_EDITING',
      'ASSET_PRODUCTION',
      'SEARCH_QUERY',
      'GENERAL',
      'GENERAL',
      'GENERAL',
      'GENERAL',
      'DOCUMENT_EDITING',
      'ASSET_PRODUCTION',
      'CONTENT_CREATION',
      'ASSET_PRODUCTION',
      'ASSET_PRODUCTION',
      'DOCUMENT_EDITING',
      'DOCUMENT_EDITING',
      'ASSET_PRODUCTION',
      'GENERAL',
    ])
    const scenariosByTask = Map.groupBy(taskRecords, record => record.payload.taskId)
    assert.ok([...scenariosByTask.values()].every(records => new Set(
      records.map(record => record.payload.scenario),
    ).size === 1))
    const serialized = JSON.stringify({ bindings: [...taskTables.bindings.values()], taskRecords })
    for (const privateValue of [
      'private-response',
      'private_tool',
      'univer_new',
      'web_search',
      'PRIVATE_FAILURE',
      '/private/customer.docx',
      'private-image.png',
      'private-attachment',
      'private-call',
    ]) assert.equal(serialized.includes(privateValue), false)
    assert.ok([...taskTables.bindings.values()].every(binding => binding.locked_scenario !== undefined))
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup()
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('audit replays persisted scenario candidates without reclassifying historical GENERAL', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'e-mate-audit-replay-'))
  const bindingPath = writeAuditRuntimeBinding(temporary)
  const usageTables = { bindings: new Map(), outbox: new Map() }
  const taskTables = { bindings: new Map(), outbox: new Map() }
  const allCleanups = []
  const events = sessionId => [
    { type: 'turn/start', seq: 0, time: 1_800_000_000_000, data: { turn: 1 } },
    {
      type: 'assistant/message', seq: 1, time: 1_800_000_000_001,
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [{ type: 'text', text: `private-replay:${sessionId}` }],
          source: { kind: 'model', provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' },
        },
      },
    },
    {
      type: 'tool/call', seq: 2, time: 1_800_000_000_002,
      data: { turn: 1, step: 1, callId: 'private-replay-call', name: 'univer_inspect', arguments: '{}' },
    },
    { type: 'turn/end', seq: 3, time: 1_800_000_000_003, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const start = async (sessionPersistence) => {
    const handlers = new Map()
    const cleanups = []
    let audit
    let openedDomains = 0
    const domain = source => ({
      table: name => ({
        entries: () => source[name].entries(),
        put: async (key, value) => { source[name].set(key, structuredClone(value)) },
      }),
      close: async () => {},
    })
    await applyAudit({
      connection: { rpc: { handle: () => () => {} } },
      sessionPersistence,
      storageDomain: { open: async () => domain(openedDomains++ === 0 ? usageTables : taskTables) },
      tools: {
        provenance: name => name === 'univer_inspect'
          ? { moduleSpecifier: '@e-mate/dsh-plugin-univer-office', pluginName: 'univer-tools' }
          : undefined,
      },
      emateIdentity: { localAccountSubject: () => 'tenant-207:replay-user' },
      emateModelPolicy: { markAuditDelivered: async () => {} },
      provide: (_name, value) => { audit = value },
      effect(effect) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
        return cleanup
      },
      on: (event, handler) => {
        handlers.set(event, handler)
        return () => { handlers.delete(event) }
      },
      interval: () => () => {},
      logger: { warn: () => {} },
    }, { bindingPath, auditProvider: {}, taskAuditProvider: {}, flushIntervalMs: 30_000 })
    allCleanups.push(...cleanups)
    return { audit, handlers }
  }

  try {
    const first = await start({ list: async () => [], readFrom: async () => ({ events: [] }) })
    await new Promise(resolve => setImmediate(resolve))
    const liveEvents = events('audit-replay')
    for (const event of liveEvents.slice(0, 3)) {
      first.handlers.get('session/event')({ id: 'audit-replay' }, event)
    }
    first.handlers.get('tools/result')({
      name: 'univer_inspect', callId: 'private-replay-call', agent: { id: 'audit-replay' },
    }, { isError: false, content: [{ type: 'text', text: 'private-result' }], value: null })
    await first.audit.drain('audit-replay')
    assert.equal(taskTables.outbox.size, 0)
    assert.deepEqual([...taskTables.bindings.values()][0].scenario_candidates, [
      'CONTENT_CREATION',
      'DOCUMENT_EDITING',
    ])

    const historicalSession = 'audit-historical-general'
    const historicalBinding = {
      schema_version: 1,
      account_subject_sha256: 'a'.repeat(64),
      created_at: new Date(1_800_000_000_000).toISOString(),
      scenario_candidates: ['DOCUMENT_EDITING'],
      locked_scenario: 'DOCUMENT_EDITING',
    }
    taskTables.bindings.set(
      `${createHash('sha256').update(historicalSession).digest('hex')}:1`,
      historicalBinding,
    )
    const historicalFact = createTaskAuditFact(
      historicalSession,
      events(historicalSession)[0],
      'RECEIVED',
      historicalBinding,
      1,
      'GENERAL',
    )
    const historicalDelivered = {
      ...historicalFact,
      status: 'delivered',
      receipt_id: 'task-receipt:historical',
      delivered_at: new Date(1_800_000_000_100).toISOString(),
    }
    taskTables.outbox.set(historicalDelivered.event_id, historicalDelivered)
    const historicalBefore = JSON.stringify(historicalDelivered)
    const crashSession = 'audit-crash-open'
    const crashBinding = {
      schema_version: 1,
      account_subject_sha256: 'c'.repeat(64),
      created_at: new Date(1_800_000_000_000).toISOString(),
    }
    taskTables.bindings.set(
      `${createHash('sha256').update(crashSession).digest('hex')}:1`,
      crashBinding,
    )
    const crashTaskId = createTaskAuditFact(
      crashSession,
      events(crashSession)[0],
      'RECEIVED',
      crashBinding,
      1,
      'GENERAL',
    ).payload.taskId
    const replayTaskId = createTaskAuditFact(
      'audit-replay',
      events('audit-replay')[0],
      'RECEIVED',
      crashBinding,
      1,
      'GENERAL',
    ).payload.taskId

    let readCount = 0
    let replayed
    const replayStarted = new Promise(resolve => { replayed = resolve })
    const restarted = await start({
      list: async () => [{ id: 'audit-replay' }, { id: historicalSession }, { id: crashSession }],
      readFrom: async (sessionId) => {
        readCount += 1
        if (readCount === 3) replayed()
        return { events: sessionId === crashSession ? events(sessionId).slice(0, 3) : events(sessionId) }
      },
    })
    await replayStarted
    await new Promise(resolve => setImmediate(resolve))
    await restarted.audit.drain()

    const replayRecords = [...taskTables.outbox.values()]
    const replayTask = replayRecords.filter(record => record.payload.taskId === replayTaskId)
    assert.ok(replayTask.length > 0)
    assert.ok(replayTask.every(record => record.payload.scenario === 'DOCUMENT_EDITING'))
    const historicalTask = replayRecords.filter(record => record.payload.taskId === historicalFact.payload.taskId)
    assert.ok(historicalTask.every(record => record.payload.scenario === 'GENERAL'))
    const crashTask = replayRecords.filter(record => record.payload.taskId === crashTaskId)
    assert.deepEqual(crashTask.map(record => record.payload.type), [
      'RECEIVED',
      'FIRST_RESPONSE',
      'TOOL_EXECUTION',
    ])
    assert.ok(crashTask.every(record => record.payload.scenario === 'GENERAL'))
    assert.equal(JSON.stringify(taskTables.outbox.get(historicalDelivered.event_id)), historicalBefore)
    const sizeAfterReplay = taskTables.outbox.size

    const replayedAgain = await start({
      list: async () => [{ id: 'audit-replay' }, { id: historicalSession }, { id: crashSession }],
      readFrom: async sessionId => ({
        events: sessionId === crashSession ? events(sessionId).slice(0, 3) : events(sessionId),
      }),
    })
    await new Promise(resolve => setImmediate(resolve))
    await replayedAgain.audit.drain()
    assert.equal(taskTables.outbox.size, sizeAfterReplay)
    assert.equal(JSON.stringify(replayRecords).includes('private-replay'), false)
  } finally {
    for (const cleanup of allCleanups.reverse()) await cleanup()
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('audit isolates slow session writes and quarantines malformed task records', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'e-mate-audit-isolation-'))
  const bindingPath = writeAuditRuntimeBinding(temporary)
  const usageTables = { bindings: new Map(), outbox: new Map() }
  const taskTables = { bindings: new Map(), outbox: new Map() }
  const cleanups = []
  const handlers = new Map()
  const uploads = []
  let audit
  let releaseSlowWrite
  const slowWrite = new Promise(resolve => { releaseSlowWrite = resolve })
  let releaseUpload
  let notifyUploadHang
  const uploadGate = new Promise(resolve => { releaseUpload = resolve })
  const uploadHung = new Promise(resolve => { notifyUploadHang = resolve })
  let hangUpload = false
  let rejectedTaskId
  const slowPrefix = createHash('sha256').update('audit-slow-a').digest('hex')
  const preloadBinding = { schema_version: 1, account_subject_sha256: 'b'.repeat(64) }
  const preloadFact = createTaskAuditFact('audit-preload', {
    type: 'turn/end', seq: 1, time: 1_700_000_100_000, data: { turn: 1, reason: { kind: 'completed' } },
  }, 'COMPLETED', preloadBinding, 1, 'GENERAL')
  taskTables.outbox.set(preloadFact.event_id, preloadFact)
  taskTables.outbox.set(`taskevent_${'f'.repeat(64)}`, {
    schema_version: 1,
    event_id: `taskevent_${'f'.repeat(64)}`,
    account_subject_sha256: 'b'.repeat(64),
    payload: { content: 'private malformed record' },
    payload_sha256: 'c'.repeat(64),
    source_seq: 2,
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: new Date(1_700_000_100_000).toISOString(),
  })
  let uploadAttempted
  const attempted = new Promise(resolve => { uploadAttempted = resolve })
  let openedDomains = 0
  const domain = (source, task) => ({
    table: name => ({
      entries: () => source[name].entries(),
      put: async (key, value) => {
        if (task && name === 'bindings' && key.startsWith(slowPrefix)) await slowWrite
        if (task && name === 'outbox' && value.payload?.taskId === rejectedTaskId) {
          throw new Error('simulated task audit write failure')
        }
        source[name].set(key, structuredClone(value))
      },
    }),
    close: async () => {},
  })
  try {
    await applyAudit({
      connection: { rpc: { handle: () => () => {} } },
      sessionPersistence: { list: async () => [], readFrom: async () => ({ events: [] }) },
      storageDomain: { open: async () => openedDomains++ === 0
        ? domain(usageTables, false)
        : domain(taskTables, true) },
      tools: { provenance: () => undefined },
      emateIdentity: { localAccountSubject: () => 'tenant-207:isolation-user' },
      emateModelPolicy: { markAuditDelivered: async () => {} },
      provide: (_name, value) => { audit = value },
      effect(effect) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
        return cleanup
      },
      on: (event, handler) => {
        handlers.set(event, handler)
        return () => { handlers.delete(event) }
      },
      interval: () => () => {},
      logger: { warn: () => {} },
    }, {
      bindingPath,
      auditProvider: {},
      taskAuditProvider: {
        upload: async (records) => {
          uploads.push(structuredClone(records))
          uploadAttempted()
          if (hangUpload) {
            notifyUploadHang()
            await uploadGate
          }
          return {
            schema_version: 1,
            receipts: records.map(record => ({
              event_id: record.event_id,
              payload_sha256: record.payload_sha256,
              receipt_id: `task-receipt:${record.event_id.slice(-16)}`,
              accepted_at: new Date().toISOString(),
            })),
          }
        },
      },
      flushIntervalMs: 30_000,
    })
    await attempted
    await audit.flush({ force: true })
    await audit.drain()
    assert.equal(uploads.length, 1)
    assert.deepEqual(uploads[0].map(record => record.event_id), [preloadFact.event_id])
    assert.equal(taskTables.outbox.get(preloadFact.event_id).status, 'delivered')
    assert.equal(taskTables.outbox.get(`taskevent_${'f'.repeat(64)}`).status, 'pending')

    const run = (sessionId, time) => {
      const session = { id: sessionId }
      handlers.get('session/event')(session, { type: 'turn/start', seq: 0, time, data: { turn: 1 } })
      handlers.get('session/event')(session, {
        type: 'assistant/message', seq: 1, time: time + 1,
        data: {
          turn: 1,
          step: 1,
          message: { source: { kind: 'model', provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' } },
        },
      })
      handlers.get('session/event')(session, {
        type: 'turn/end', seq: 2, time: time + 2, data: { turn: 1, reason: { kind: 'completed' } },
      })
    }
    const now = Date.now()
    run('audit-slow-a', now)
    run('audit-fast-b', now + 100)
    assert.equal(handlers.get('session/flush')({ id: 'audit-slow-a' }), undefined)
    await audit.drain('audit-fast-b')
    const binding = { schema_version: 1, account_subject_sha256: 'd'.repeat(64) }
    const fastTaskId = createTaskAuditFact('audit-fast-b', {
      type: 'turn/start', seq: 0, time: now + 100, data: { turn: 1 },
    }, 'RECEIVED', binding).payload.taskId
    const slowTaskId = createTaskAuditFact('audit-slow-a', {
      type: 'turn/start', seq: 0, time: now, data: { turn: 1 },
    }, 'RECEIVED', binding).payload.taskId
    assert.equal([...taskTables.outbox.values()].filter(record => record.payload?.taskId === fastTaskId).length, 3)
    assert.equal([...taskTables.outbox.values()].filter(record => record.payload?.taskId === slowTaskId).length, 0)
    releaseSlowWrite()
    await audit.drain('audit-slow-a')
    assert.equal([...taskTables.outbox.values()].filter(record => record.payload?.taskId === slowTaskId).length, 3)

    const rejectedTime = now + 150
    rejectedTaskId = createTaskAuditFact('audit-write-failure', {
      type: 'turn/start', seq: 0, time: rejectedTime, data: { turn: 1 },
    }, 'RECEIVED', binding).payload.taskId
    run('audit-write-failure', rejectedTime)
    await audit.drain('audit-write-failure')
    assert.equal([...taskTables.outbox.values()].filter(record => record.payload?.taskId === rejectedTaskId).length, 0)
    run('audit-fast-after-failure', now + 175)
    await audit.drain('audit-fast-after-failure')
    assert.equal([...taskTables.outbox.values()].filter(record => record.payload?.occurredAt
      === new Date(now + 175).toISOString()).length, 1)

    hangUpload = true
    const hangingFlush = audit.flush({ force: true })
    await uploadHung
    run('audit-fast-c', now + 200)
    await audit.drain('audit-fast-c')
    const fastTaskCId = createTaskAuditFact('audit-fast-c', {
      type: 'turn/start', seq: 0, time: now + 200, data: { turn: 1 },
    }, 'RECEIVED', binding).payload.taskId
    assert.equal([...taskTables.outbox.values()].filter(record => record.payload?.taskId === fastTaskCId).length, 3)
    releaseUpload()
    await hangingFlush
  } finally {
    releaseSlowWrite()
    releaseUpload()
    for (const cleanup of cleanups.reverse()) await cleanup()
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('audit startup flushes a persisted outbox through the Host identity transport', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'e-mate-audit-backfill-'))
  const bindingPath = writeAuditRuntimeBinding(temporary)
  const tables = { bindings: new Map(), outbox: new Map() }
  const taskTables = { bindings: new Map(), outbox: new Map() }
  const cleanups = []
  const deliveredFacts = []
  const uploads = []
  let audit
  let uploadAvailable = false
  let notifyAttempt
  const attempted = new Promise(resolve => { notifyAttempt = resolve })
  const event = {
    type: 'assistant/message',
    seq: 21,
    time: Date.now(),
    data: {
      turn: 2,
      step: 1,
      message: {
        source: { kind: 'model', provider: 'e-mate-enterprise', model: 'gpt-5.6-luna' },
      },
      usage: { inputTokens: 9, outputTokens: 4 },
    },
  }
  const pending = createUsageFact('audit-backfill-session', event, {
    schema_version: 1,
    account_subject_sha256: 'c'.repeat(64),
    policy_revision: 4,
    policy_receipt_id: 'policy-receipt:backfill-207',
    policy_sha256: 'd'.repeat(64),
    provider: 'e-mate-enterprise',
    model: 'gpt-5.6-luna',
  })
  tables.outbox.set(pending.fact_id, pending)
  const domain = source => ({
    table: name => ({
      entries: () => source[name].entries(),
      put: async (key, value) => { source[name].set(key, structuredClone(value)) },
    }),
    close: async () => {},
  })
  let openedDomains = 0
  try {
    await applyAudit({
      connection: { rpc: { handle: () => () => {} } },
      sessionPersistence: { list: async () => [], readFrom: async () => ({ events: [] }) },
      storageDomain: { open: async () => domain(openedDomains++ === 0 ? tables : taskTables) },
      emateIdentity: {
        uploadAudit: async records => {
          uploads.push(structuredClone(records))
          notifyAttempt()
          if (!uploadAvailable) throw new Error('e-Mate login is required')
          return {
            schema_version: 1,
            receipts: records.map(record => ({
              fact_id: record.fact_id,
              payload_sha256: record.payload_sha256,
              receipt_id: `audit-receipt:${record.fact_id.slice(-16)}`,
              accepted_at: new Date().toISOString(),
            })),
          }
        },
      },
      emateModelPolicy: {
        markAuditDelivered: async (factId, acceptedAt) => { deliveredFacts.push({ factId, acceptedAt }) },
      },
      provide: (_name, value) => { audit = value },
      effect(effect) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
        return cleanup
      },
      on: () => () => {},
      interval: () => () => {},
      logger: { warn: () => {} },
    }, {
      bindingPath,
      flushIntervalMs: 30_000,
    })

    await attempted
    await audit.flush({ force: true })
    await audit.drain()
    assert.equal(audit.status().pending, 1)
    assert.equal(tables.outbox.get(pending.fact_id).attempt_count, 1)
    uploadAvailable = true
    const delivered = await audit.flush({ force: true })
    await audit.drain()
    assert.equal(delivered.delivered_now, 1)
    assert.equal(tables.outbox.get(pending.fact_id).status, 'delivered')
    assert.equal(deliveredFacts.length, 1)
    assert.equal(uploads.length, 2)
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup()
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('environment check validates the pinned Harness and embedded plugin closure', async () => {
  const dshHome = join(tmpdir(), `e-mate-check-${process.pid}`)
  const report = await checkEnvironment({ dshHome, includeProfile: false })
  assert.equal(report.checks.find(item => item.id === 'harness')?.status, 'pass')
  assert.equal(report.checks.find(item => item.id === 'plugin_bundles')?.status, 'pass')
  const credentialStore = await checkOsCredentialBackend()
  assert.equal(report.checks.find(item => item.id === 'platform')?.status, platformSupported() ? 'pass' : 'fail')
  assert.equal(report.checks.find(item => item.id === 'credential_store')?.status, credentialStore.ok ? 'pass' : 'fail')
  for (const removedId of [
    'platform_runtime', 'browser_runtime', 'office_worker', 'ocr_worker', 'chromium',
  ]) assert.equal(report.checks.some(item => item.id === removedId), false)
  assert.equal(report.ok, platformSupported() && credentialStore.ok)
})

test('health route reports real projected job activity and rejects writes', () => {
  const effects = []
  const jobs = []
  let changed
  let route
  let transformIndex
  const ctx = {
    jobs: {
      list: () => jobs,
      onJobsChanged: listener => {
        changed = listener
        return () => {}
      },
    },
    webServer: {
      tapIndex: transform => {
        transformIndex = transform
        return () => {}
      },
      register: value => {
        route = value
        return () => {}
      },
    },
    effect: effect => effects.push(effect()),
  }
  applyHealth(ctx)
  jobs.push({ id: 'image-1', status: 'running' })
  changed(undefined)

  const response = () => ({
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body },
  })
  const get = response()
  route.handler({ method: 'GET' }, get)
  assert.equal(get.status, 200)
  assert.equal(JSON.parse(get.body).active_runs, 1)
  assert.equal(JSON.parse(get.body).product, 'e-Mate')

  const post = response()
  route.handler({ method: 'POST' }, post)
  assert.equal(post.status, 405)
  const branded = transformIndex('<head><title data-old="1">DeepSeek\nHarness</title><link rel="icon" href="/favicon.svg"></head>')
  assert.match(branded, /<title>e-Mate<\/title>/)
  assert.match(branded, /id="e-mate-boot-brand"/)
  assert.match(branded, /url\('\/assets\/e-mate\/logo\.png'\)/)
  assert.match(branded, /\[class\^="_wordmark_"\]/)
  assert.match(branded, /正在加载…/)
  assert.match(branded, /rel="icon" type="image\/png" href="\/assets\/e-mate\/xiaoxin-avatar\.png"/)
  assert.match(branded, /rel="manifest" href="\/manifest\.webmanifest"/)
  assert.doesNotMatch(branded, /favicon\.svg|DeepSeek|Harness/)
  assert.equal(transformIndex('<main>no title</main>'), '<main>no title</main>')
  assert.equal(effects.length, 3)
})

test('shell plugin serves branded Web resources without adding a transport', () => {
  const routes = new Map()
  const ctx = {
    inject: (services, callback) => {
      assert.deepEqual(services, ['settings'])
      callback({ settings: { register: () => () => {} } })
    },
    webServer: {
      register: route => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    effect: effect => effect(),
  }
  applyShell(ctx)
  assert.deepEqual([...routes.keys()], [
    '/assets/e-mate/logo.png',
    '/assets/e-mate/mark.png',
    '/assets/e-mate/team-hero.png',
    '/assets/e-mate/xiaoxin-avatar.png',
    '/assets/e-mate/send.svg',
    '/manifest.webmanifest',
  ])

  const response = () => ({
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body },
  })
  const get = response()
  routes.get('/assets/e-mate/logo.png').handler({ method: 'GET' }, get)
  assert.equal(get.status, 200)
  assert.equal(get.headers['Content-Type'], 'image/png')
  assert.ok(get.body.byteLength > 0)

  const head = response()
  routes.get('/assets/e-mate/mark.png').handler({ method: 'HEAD' }, head)
  assert.equal(head.status, 200)
  assert.equal(head.body, undefined)

  const send = response()
  routes.get('/assets/e-mate/send.svg').handler({ method: 'GET' }, send)
  assert.equal(send.status, 200)
  assert.equal(send.headers['Content-Type'], 'image/svg+xml')
  assert.ok(send.body.byteLength > 0)

  const post = response()
  routes.get('/assets/e-mate/logo.png').handler({ method: 'POST' }, post)
  assert.equal(post.status, 405)
  assert.equal(post.headers.Allow, 'GET, HEAD')

  const webManifest = response()
  routes.get('/manifest.webmanifest').handler({ method: 'GET' }, webManifest)
  assert.equal(webManifest.status, 200)
  assert.equal(webManifest.headers['Cache-Control'], 'no-cache')
  assert.equal(webManifest.headers['Content-Type'], 'application/manifest+json; charset=utf-8')
  assert.equal(JSON.parse(webManifest.body).name, 'e-Mate')
  assert.equal(JSON.parse(webManifest.body).icons[0].src, '/assets/e-mate/xiaoxin-avatar.png')
})

test('user-visible runtime copy exposes only the e-Mate product brand', () => {
  const profile = new URL('../src/profile/', import.meta.url)
  const sources = [
    new URL('../src/e-mate.ts', import.meta.url),
    new URL('../src/legacy-migration.ts', import.meta.url),
    ...readdirSync(profile).filter(name => name.endsWith('.ts')).map(name => new URL(name, profile)),
  ]
  const leakedBrandLiteral = /(?:'[^'\n]*\b(?:DeepSeek Harness|Harness)\b[^'\n]*'|"[^"\n]*\b(?:DeepSeek Harness|Harness)\b[^"\n]*"|`[^`\n]*\b(?:DeepSeek Harness|Harness)\b[^`\n]*`)/u
  for (const source of sources) assert.doesNotMatch(readFileSync(source, 'utf8'), leakedBrandLiteral, source.pathname)
})

test('general conversations reuse a managed Harness workspace outside user projects', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'e-mate-general-'))
  let created
  let renamed
  try {
    await applyGeneralWorkspace({
      workspaceRegistry: {
        create: async (path, title) => {
          created = { path: realpathSync(path), title }
          return { title: 'general', setTitle: async value => { renamed = value } }
        },
      },
    }, { dshHome })
    assert.deepEqual(created, {
      path: realpathSync(join(dshHome, 'e-mate', 'general')),
      title: '通用会话',
    })
    assert.equal(renamed, '通用会话')
  } finally {
    rmSync(dshHome, { recursive: true, force: true })
  }
})


test('model catalog ranks Astra first across providers without mutating policy or catalog', () => {
  const groups = [
    { id: 'deepseek', models: [{ id: 'deepseek-v4-flash' }] },
    { id: 'gpt', models: ['gpt-5.6-luna', 'gpt-6-astra', 'gpt-5.6-sol'].map(id => ({ id })) },
    { id: 'empty', models: [{ id: 'not-authorized' }] },
  ]
  const policy = {
    allowed_model_ids: ['deepseek', 'gpt-5.6-luna', 'gpt-6-astra', 'gpt-5.6-sol'],
    default_chat_model_id: 'gpt-5.6-luna',
  }
  const before = structuredClone({ groups, policy })
  assert.deepEqual(filterGroups(groups, policy).flatMap(group => group.models.map(model => model.id)),
    ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'deepseek-v4-flash'])
  assert.deepEqual({ groups, policy }, before)
  assert.deepEqual(filterGroups(groups, { ...policy, allowed_model_ids: ['gpt-5.6-luna', 'deepseek'] })
    .flatMap(group => group.models.map(model => model.id)), ['gpt-5.6-luna', 'deepseek-v4-flash'])
})


test('model catalog excludes retired Doubao even when a stale policy allows it', () => {
  const groups = [{ id: 'legacy', models: [{ id: 'doubao-seed-2-0-pro-260215' }, { id: 'deepseek' }] }]
  const policy = { allowed_model_ids: ['doubao-seed-2-0-pro-260215', 'deepseek'] }
  assert.deepEqual(filterGroups(groups, policy)[0].models.map(model => model.id), ['deepseek'])
  assert.equal(groups[0].models.length, 2)
})
