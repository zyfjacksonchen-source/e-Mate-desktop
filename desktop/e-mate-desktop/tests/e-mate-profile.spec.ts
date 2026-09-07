import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
const conversationAdapterUrl = new URL('../../../scripts/harness-conversation-adapter.mjs', import.meta.url).href
const { adaptNavigationSource, NAVIGATION_PACKAGE } = await import(conversationAdapterUrl) as {
  adaptNavigationSource(source: string): string
  NAVIGATION_PACKAGE: string
}
import { prepareDesktopProfile } from '../src/profile.ts'

const roots: string[] = []

function navigationEntries(client: string) {
  const window = { __ModuleLoader__: { load({ factory }: { factory: (require: () => object) => unknown }) { factory(() => ({})) } } }
  return new Function('window', `${client}\nreturn window.__dspnNavDebug__.buildEntries;`)(window) as
    (snapshot: unknown) => { key: string; userText: string; modelText: string }[]
}

describe('e-Mate navigation attachment display', () => {
  const navigation = readFileSync(new URL(`../node_modules/${NAVIGATION_PACKAGE}/lib/client.js`, import.meta.url), 'utf8')
  const file = (stored = '报告_带空格_验证.txt', display = '报告 带空格@验证.txt') => ({
    stored_name: stored, display_name: display, media_type: 'text/plain', relative_path: '.e-mate/imports/' + stored,
  })

  it('rejects bundle drift, duplicate or already adapted input', () => {
    expect(() => adaptNavigationSource('future')).toThrow(/expected one 0\.2\.1 seam/u)
    expect(() => adaptNavigationSource(navigation + navigation)).toThrow(/found 2/u)
    expect(() => adaptNavigationSource(adaptNavigationSource(navigation))).toThrow(/navigation\/user-text: expected one 0\.2\.1 seam/u)
    expect(() => adaptNavigationSource(navigation.replace('textOfBlocks(data.content)', 'textOfBlocks(data.blocks)'))).toThrow(/navigation\/user-text: expected one 0\.2\.1 seam/u)
  })

  it('projects actual buildEntries AX and hover labels without mutating messages or keys', () => {
    const source = adaptNavigationSource(navigation)
    const buildEntries = navigationEntries(source)
    const files = [file(), file('plain.txt', 'literal@name  file.txt')] as const
    const nodes = [{
      key: 'user-anchor', kind: 'user',
      data: {
        kind: 'user',
        content: [{ type: 'image' }, { type: 'text', text: `请看 @同事 与 README@v2.md\n@${files[0].relative_path}\n@${files[1].relative_path}\n@${files[0].relative_path}` }],
        source: { mentions: [
          ...files.map(value => ({ source: 'e-mate/file-import', ref: JSON.stringify(value) })),
          { source: 'unrelated', ref: JSON.stringify({ ...files[0], display_name: 'wrong owner' }) },
          { source: 'e-mate/file-import', ref: 'broken JSON' },
          { source: 'e-mate/file-import', ref: JSON.stringify({ ...files[0], display_name: '../invalid' }) },
          { source: 'e-mate/file-import', ref: JSON.stringify(file('unreferenced.txt', 'not in message')) },
        ] },
      },
    }, { key: 'reply', kind: 'assistant', blocks: [{ kind: 'text', text: '回复 @同事' }] }]
    const snapshot = { chat: { order: nodes.map(node => node.key), nodes: new Map(nodes.map(node => [node.key, node])) } }
    const before = structuredClone(snapshot)
    expect(buildEntries(snapshot)).toEqual([{
      key: 'user-anchor',
      userText: '[图片] 请看 @同事 与 README@v2.md\n报告 带空格@验证.txt\nliteral@name  file.txt',
      modelText: '回复 @同事',
    }])
    expect(snapshot).toEqual(before)
    expect(buildEntries({ nodes: [
      { key: 'legacy-steering', kind: 'steering', content: [{ kind: 'text', text: `@${file().relative_path}` }], source: { mentions: [null, { source: 'e-mate/file-import', ref: '{}' }] } },
      { key: 'plain', kind: 'user', content: [{ type: 'text', text: '普通 @同事 README@v2.md @workspace/file.txt' }] },
    ] })).toEqual([
      { key: 'legacy-steering', userText: file().stored_name, modelText: '' },
      { key: 'plain', userText: '普通 @同事 README@v2.md @workspace/file.txt', modelText: '' },
    ])
    // Both unmodified UI consumers use this shared producer; navigation uses key.
    expect(source).toMatch(/'aria-label': entry\.userText/u)
    expect(source).toMatch(/className: 'dspn-tip-user' \}, entries\[tipIndex\]\.userText/u)
    expect(source).toMatch(/onClick: \(\) => jumpTo\(entry\)/u)
  })
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('e-Mate desktop profile', () => {
  type ProfileModule = typeof import('../src/e-mate-profile.ts')
  let EMATE_DESKTOP_PROFILE_VERSION: ProfileModule['EMATE_DESKTOP_PROFILE_VERSION']
  let EMATE_MANAGED_PROFILE_CLEANUP_MAX_ATTEMPTS: ProfileModule['EMATE_MANAGED_PROFILE_CLEANUP_MAX_ATTEMPTS']
  let EMATE_BUNDLED_PROFILE_COMPONENT_IDS: ProfileModule['EMATE_BUNDLED_PROFILE_COMPONENT_IDS']
  let cleanupEmateDesktopProfileArtifact: ProfileModule['cleanupEmateDesktopProfileArtifact']
  let installEmateDesktopProfile: ProfileModule['installEmateDesktopProfile']
  let packagedSource: string
  // Navigation source checks do not need a built profile; installation checks do.
  // Copy/cleanup includes bundled Skill assets; these hooks are not startup measurements.
  beforeAll(async () => {
    packagedSource = mkdtempSync(join(tmpdir(), 'e-mate-packaged-profile-'))
    // Match electron-builder's declaration exclusion without mutating shared build resources.
    cpSync(fileURLToPath(new URL('../build/e-mate-profile/', import.meta.url)), packagedSource, {
      recursive: true, dereference: true, filter: source => !source.endsWith('.d.ts'),
    })
    const runtimePaths = await import('../src/packaged-runtime-path.ts')
    vi.doMock('../src/packaged-runtime-path.ts', () => ({
      ...runtimePaths,
      unpackedAsarPath: (path: string) => path === fileURLToPath(new URL('../build/e-mate-profile/', import.meta.url))
        ? packagedSource : runtimePaths.unpackedAsarPath(path),
    }))
    ;({ EMATE_DESKTOP_PROFILE_VERSION, EMATE_MANAGED_PROFILE_CLEANUP_MAX_ATTEMPTS,
      EMATE_BUNDLED_PROFILE_COMPONENT_IDS, cleanupEmateDesktopProfileArtifact,
      installEmateDesktopProfile } = await import('../src/e-mate-profile.ts'))
  }, 60_000)

  afterAll(() => {
    vi.doUnmock('../src/packaged-runtime-path.ts')
    if (packagedSource) rmSync(packagedSource, { recursive: true, force: true })
  }, 60_000)

  it('installs the fixed product profile and replaces legacy CLI update guidance', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)

    const profile = installEmateDesktopProfile(home)
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      ...EMATE_BUNDLED_PROFILE_COMPONENT_IDS.filter(id => id.startsWith('@e-mate/dsh-plugin-')),
      '@kelearns/dsh-navigation-bar',
      'dsh-at-file',
      'dsh-file-viewer',
      'dsh-visualize',
    ])
    expect(manifest.dsh.profile.bundles).not.toContain('@e-mate/dsh-plugin-im')
    expect(manifest.dsh.profile.bundles).toContain('@e-mate/dsh-plugin-vision-toolkit')
    expect(manifest.dsh.profile.bundles).toContain('@e-mate/dsh-plugin-better-sidebar')
    expect(manifest.dsh.profile.bundles).toContain('@e-mate/dsh-plugin-genui')
    expect(manifest.dsh.profile.bundles).not.toContain('@e-mate/dsh-plugin-xin-assistant')
    expect(manifest.dsh.profile.bundles).not.toContain('@e-mate/dsh-plugin-search-mcp')
    expect(manifest.dsh.profile.bundles).not.toContain('dsh-search-mcp')
    expect(manifest.dsh.profile.bundles).not.toContain('@e-mate/dsh-plugin-subagent')
    const navigationClient = readFileSync(join(profile, 'node_modules', '@kelearns', 'dsh-navigation-bar', 'lib', 'client.js'), 'utf8')
    const importedFile = {
      stored_name: '报告_验证.txt', relative_path: '.e-mate/imports/报告_验证.txt',
      display_name: '报告 @验证.txt', media_type: 'text/plain',
    }
    expect(navigationEntries(navigationClient)({ nodes: [{
      key: 'user-anchor', kind: 'user',
      content: [{ type: 'text', text: `请读 @同事\n@${importedFile.relative_path}` }],
      source: { mentions: [{ source: 'e-mate/file-import', ref: JSON.stringify(importedFile) }] },
    }] })).toEqual([{ key: 'user-anchor', userText: '请读 @同事\n报告 @验证.txt', modelText: '' }])
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-genui', 'lib', 'client.js'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-vision-toolkit', 'lib', 'index.mjs'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-cdp', 'lib', 'index.mjs'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-skill-hub', 'lib', 'index.js'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-tool-search', 'lib', 'index.mjs'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-schedules', 'lib', 'index.js'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-file-import', 'lib', 'client.js'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-computer-use', 'lib', 'client.js'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-find-skill', 'lib', 'index.js'))).toBe(true)
    const findSkillPatch = readFileSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-find-skill', 'cordis.patch.yml'), 'utf8')
    expect(findSkillPatch).toContain("cliCommand: 'pnpm dlx skills@1.5.22'")
    expect(findSkillPatch).toContain('/tree/skills-v2.0.12-r1/skills/connect-feishu-cli')
    expect(findSkillPatch).not.toContain('/tree/main/skills/connect-feishu-cli')
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-mcp-manage', 'lib', 'index.mjs'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-office-skills', 'lib', 'index.js'))).toBe(true)
    expect(lstatSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-office-skills', 'assets')).isSymbolicLink())
      .toBe(process.platform !== 'win32')
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-xin-assistant'))).toBe(false)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-office-skills', 'assets', 'pdf2json', 'pdfparser.js'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-office-skills', 'assets', 'noto-sans-sc', 'files', 'noto-sans-sc-4-wght-normal.woff2'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', 'dsh-at-file', 'lib', 'client.js'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-better-sidebar', 'lib', 'client.js'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', 'dsh-better-sidebar'))).toBe(false)
    expect(existsSync(join(profile, 'node_modules', 'dsh-file-viewer', 'lib', 'client.js'))).toBe(true)
    const fileViewerHost = readFileSync(join(profile, 'node_modules', 'dsh-file-viewer', 'lib', 'index.js'), 'utf8')
    const fileViewerClient = readFileSync(join(profile, 'node_modules', 'dsh-file-viewer', 'lib', 'client.js'), 'utf8')
    expect(fileViewerHost).toContain('/usr/bin/open')
    expect(fileViewerHost).toContain('Invoke-Item -LiteralPath $env:E_MATE_OPEN_PATH')
    expect(fileViewerClient).not.toContain('"file-viewer: file open router"')
    expect(fileViewerClient).toContain('name: "conversation.session.header.actions"')
    expect(fileViewerClient).toContain('coordinator.openInSystem(sessionId, path)')
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-search-mcp'))).toBe(false)
    expect(existsSync(join(profile, 'node_modules', 'dsh-search-mcp'))).toBe(false)
    expect(existsSync(join(profile, 'node_modules', 'dsh-turn-fold'))).toBe(false)
    expect(existsSync(join(profile, 'node_modules', 'dsh-visualize', 'lib', 'client.js'))).toBe(true)
    expect(existsSync(join(home, 'browser-extension'))).toBe(false)
    mkdirSync(join(home, 'browser-extension'))
    writeFileSync(join(home, 'ext-bridge-token'), 'retired-token')
    installEmateDesktopProfile(home)
    expect(existsSync(join(home, 'browser-extension'))).toBe(false)
    expect(existsSync(join(home, 'ext-bridge-token'))).toBe(false)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-browser'))).toBe(false)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-browser-panel'))).toBe(false)
    expect(existsSync(join(profile, 'plugins', 'runtime-binding.json'))).toBe(true)
    const runtimeBinding = JSON.parse(readFileSync(join(profile, 'plugins', 'runtime-binding.json'), 'utf8')) as {
      version?: string
      schedule_module?: string
      schedule_module_sha256?: string
      compaction_module?: string
      compaction_module_sha256?: string
    }
    expect(runtimeBinding.version).toBe(EMATE_DESKTOP_PROFILE_VERSION)
    expect(runtimeBinding.schedule_module).toContain('@deepseek-ai/dsh-schedule')
    expect(runtimeBinding.schedule_module_sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(runtimeBinding.compaction_module).toContain('@deepseek-ai/dsh-compaction')
    expect(runtimeBinding.compaction_module_sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe(
      'ui-theme:\n  preference: dark\nagent-default-model:\n  provider: e-mate-enterprise\n  model: gpt-5.6-luna\n  reasoningEffort: max\n',
    )

    const prepared = prepareDesktopProfile(undefined, home, process.platform, 'e-mate')
    const rows = composeEntries([prepared.patches])
    expect(prepared.profile.name).toBe('e-mate')
    expect(prepared.mode).toBe(process.platform === 'linux' ? 'compatibility' : 'advanced')
    expect(rows.find(row => row.id === 'desktop-agent-update')).toEqual(expect.objectContaining({
      name: '@e-mate/desktop/agent-update',
    }))
    expect(rows.find(row => row.id === 'desktop-agent-update')?.disabled).not.toBe(true)
    expect(rows.map(row => row.id)).not.toContain('desktop-computer-use-setup')
    expect(rows.find(row => row.id === 'emate-cdp')).toEqual(expect.objectContaining({
      name: './node_modules/@e-mate/dsh-plugin-cdp/lib/index.mjs',
    }))
    expect(rows.map(row => row.id)).not.toContain('bridge-browser')
    expect(rows.find(row => row.id === 'emate-genui')).toEqual(expect.objectContaining({
      name: '@e-mate/dsh-plugin-genui',
    }))
    expect(rows.map(row => row.id)).not.toContain('genui')
    expect(rows.find(row => row.id === 'vision-toolkit')).toEqual(expect.objectContaining({
      name: '@e-mate/dsh-plugin-vision-toolkit',
    }))
    expect(rows.map(row => row.id)).not.toContain('desktop-vision-toolkit')
    expect(rows.find(row => row.id === 'dsh-navigation-bar')).toEqual(expect.objectContaining({
      name: '@kelearns/dsh-navigation-bar',
    }))
    expect(rows.find(row => row.id === 'emate-better-sidebar')).toEqual(expect.objectContaining({
      name: '@e-mate/dsh-plugin-better-sidebar',
    }))
    expect(rows.map(row => row.id)).not.toContain('better-sidebar')
    expect(rows.map(row => row.id)).not.toContain('search-mcp')
    expect(rows.find(row => row.id === 'web')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-web',
      config: expect.objectContaining({ searchProvider: 'deepseek-official' }),
    }))
    expect(rows.find(row => row.id === 'web-search-deepseek')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-web-search-deepseek',
      disabled: false,
      config: expect.objectContaining({
        apiKeyEnv: 'E_MATE_SEARCH_KEY_DEEPSEEK',
        baseURL: 'https://api.deepseek.com/anthropic/v1',
        model: 'deepseek-v4-flash',
      }),
    }))
    expect(rows.find(row => row.id === 'tool-web')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-tool-web',
      disabled: false,
      config: expect.objectContaining({ fetch: false, searchTimeoutMs: 60000, searchMaxResults: 50 }),
    }))
    expect(rows.find(row => row.id === 'emate-tool-search')?.config?.alwaysVisible).toContain('web_search')
    expect(rows.find(row => row.id === 'emate-tool-search')?.config?.alwaysVisible)
      .toEqual(expect.arrayContaining(['imagegen', 'image_pack']))
    expect(rows.find(row => row.id === 'emate-file-import')).toEqual(expect.objectContaining({
      name: '@e-mate/dsh-plugin-file-import',
    }))
    expect(rows.find(row => row.id === 'emate-computer-use')).toEqual(expect.objectContaining({
      name: '@e-mate/dsh-plugin-computer-use',
    }))
    expect(rows.find(row => row.id === 'emate-find-skill')).toEqual(expect.objectContaining({
      name: '@e-mate/dsh-plugin-find-skill',
    }))
    expect(rows.find(row => row.id === 'emate-mcp-manage')).toEqual(expect.objectContaining({
      name: './node_modules/@e-mate/dsh-plugin-mcp-manage/lib/index.mjs',
    }))
    expect(rows.map(row => row.id)).not.toContain('emate-xin-assistant')
    expect(rows.find(row => row.id === 'emate-office-skills')).toEqual(expect.objectContaining({
      name: './node_modules/@e-mate/dsh-plugin-office-skills/lib/index.js',
    }))
    expect(rows.find(row => row.id === 'emate-agent-operations')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'emate-schedules')).toEqual(expect.objectContaining({
      name: './node_modules/@e-mate/dsh-plugin-schedules/lib/index.js',
      inject: ['connection', 'sessionPersistence'],
    }))
    const schedules = readFileSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-schedules', 'lib', 'index.js'), 'utf8')
    expect(schedules).toContain('/emate.schedules')
    expect(schedules).toContain('foldScheduleEvents')
    expect(rows.map(row => row.id)).not.toContain('desktop-profiles')
    expect(rows.find(row => row.id === 'dsh-at-file')).toEqual(expect.objectContaining({
      name: 'dsh-at-file',
    }))
    expect(rows.find(row => row.id === 'dsh-file-viewer')).toEqual(expect.objectContaining({
      name: 'dsh-file-viewer',
      config: expect.objectContaining({ allowAbsolutePaths: false }),
    }))
    expect(rows.map(row => row.id)).not.toContain('dsh-turn-fold')
    expect(rows.find(row => row.id === 'visualize')).toEqual(expect.objectContaining({
      name: 'dsh-visualize',
    }))
  })

  it('preserves an existing theme preference and adds the managed model default once', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const settings = join(home, 'settings.yaml')
    writeFileSync(settings, 'ui-theme:\n  preference: light\n')

    installEmateDesktopProfile(home)
    installEmateDesktopProfile(home)

    expect(readFileSync(settings, 'utf8')).toBe(
      'ui-theme:\n  preference: light\nagent-default-model:\n  provider: e-mate-enterprise\n  model: gpt-5.6-luna\n  reasoningEffort: max\n',
    )
  })

  it('reuses a complete immutable profile and repairs it when a required file disappears', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const cdpManifest = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-cdp', 'package.json')
    const sentinel = join(profile, '.warm-start-sentinel')
    const firstModified = readFileSync(join(profile, '.e-mate-install.json'), 'utf8')

    writeFileSync(sentinel, 'preserved only when the immutable install is reused')
    installEmateDesktopProfile(home)
    expect(readFileSync(join(profile, '.e-mate-install.json'), 'utf8')).toBe(firstModified)
    expect(existsSync(sentinel)).toBe(true)

    rmSync(cdpManifest)
    installEmateDesktopProfile(home)
    expect(existsSync(cdpManifest)).toBe(true)
    expect(existsSync(sentinel)).toBe(true)
  })

  it('repairs a managed package with a top-level extra while preserving package-external data', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const cdpPackage = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-cdp')
    const extra = join(cdpPackage, '.unexpected-top-level-entry')
    const external = join(profile, 'node_modules', 'user-owned-package', 'data.txt')
    mkdirSync(join(profile, 'node_modules', 'user-owned-package'), { recursive: true })
    writeFileSync(extra, 'must not survive inside a managed package')
    writeFileSync(external, 'outside the managed package owner')

    installEmateDesktopProfile(home)

    expect(existsSync(extra)).toBe(false)
    expect(readFileSync(external, 'utf8')).toBe('outside the managed package owner')
  })

  it('repairs an explicitly constructed legacy managed-package directory link', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const receiptPath = join(profile, '.e-mate-install.json')
    const library = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-schedules', 'lib')
    const legacyLibrary = join(home, 'legacy-schedules-lib')
    cpSync(library, legacyLibrary, { recursive: true, dereference: true })
    rmSync(library, { recursive: true, force: true })
    symlinkSync(legacyLibrary, library, process.platform === 'win32' ? 'junction' : 'dir')
    expect(lstatSync(library).isSymbolicLink()).toBe(true)
    const legacyReceipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>
    legacyReceipt.schema_version = 1
    delete legacyReceipt.managed_package_layout
    writeFileSync(receiptPath, `${JSON.stringify(legacyReceipt, null, 2)}\n`)

    installEmateDesktopProfile(home)

    expect(lstatSync(library).isSymbolicLink()).toBe(process.platform !== 'win32')
    expect(readFileSync(join(library, 'index.js'))).toEqual(readFileSync(join(legacyLibrary, 'index.js')))
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toEqual(expect.objectContaining({
      schema_version: 2,
      managed_package_layout: process.platform === 'win32' ? 'win32-materialized-v1' : 'linked-v1',
    }))
  })

  it('rejects a managed package root reparse point', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const target = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-cdp')
    const legacyPackage = join(home, 'legacy-cdp-package')
    cpSync(target, legacyPackage, { recursive: true, dereference: true })
    rmSync(target, { recursive: true, force: true })
    symlinkSync(legacyPackage, target, process.platform === 'win32' ? 'junction' : 'dir')

    installEmateDesktopProfile(home)

    expect(lstatSync(target).isSymbolicLink()).toBe(false)
    expect(lstatSync(join(target, 'lib')).isSymbolicLink()).toBe(process.platform !== 'win32')
  })

  it('repairs a broken top-level managed-package directory link without following it', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const library = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-schedules', 'lib')
    const removedTarget = join(home, 'removed-schedules-lib')
    mkdirSync(removedTarget)
    rmSync(library, { recursive: true, force: true })
    symlinkSync(removedTarget, library, process.platform === 'win32' ? 'junction' : 'dir')
    rmSync(removedTarget, { recursive: true, force: true })

    installEmateDesktopProfile(home)

    expect(existsSync(join(library, 'index.js'))).toBe(true)
    expect(lstatSync(library).isSymbolicLink()).toBe(process.platform !== 'win32')
  })

  it.runIf(process.platform !== 'win32')('keeps non-Windows linked package directories current without reading nested payloads', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const library = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-schedules', 'lib')
    const sourceLibrary = realpathSync(library)
    const sentinel = join(profile, '.warm-start-sentinel')
    const receiptPath = join(profile, '.e-mate-install.json')
    const receipt = readFileSync(receiptPath, 'utf8')
    const previousTime = new Date('2000-01-01T00:00:00Z')
    utimesSync(receiptPath, previousTime, previousTime)
    writeFileSync(sentinel, 'warm path reused')

    installEmateDesktopProfile(home)

    expect(realpathSync(library)).toBe(sourceLibrary)
    expect(readFileSync(receiptPath, 'utf8')).toBe(receipt)
    expect(statSync(receiptPath).mtimeMs).toBe(previousTime.getTime())
    expect(readFileSync(sentinel, 'utf8')).toBe('warm path reused')
  })

  it('skips only declaration conditions while repairing missing or corrupted runtime entries', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const source = join(packagedSource, 'bundles', 'computer-use')
    const manifestPath = join(source, 'package.json')
    const originalManifest = readFileSync(manifestPath, 'utf8')
    const manifest = JSON.parse(originalManifest)
    const entries = ['host-default.js', 'host-import.js', 'host-require.js', 'client-default.js', 'client-import.js', 'client-require.js', 'types-runtime.js']
    const runtime = 'export const value = 1\n'
    try {
      delete manifest.main
      manifest.exports['.'] = {
        types: './missing-host.d.ts',
        'types@>=5.2': { default: './missing-versioned-host.d.ts' },
        import: ['./host-import.js'], require: './host-require.js', default: './host-default.js',
      }
      manifest.exports['./client'] = {
        types: './missing-client.d.ts',
        import: { 'types@>=5.2': './missing-versioned-client.d.ts', default: './client-import.js' },
        require: './client-require.js', default: './client-default.js',
        'types-runtime': './types-runtime.js',
      }
      writeFileSync(manifestPath, JSON.stringify(manifest))
      for (const entry of entries) writeFileSync(join(source, entry), runtime)
      const profile = installEmateDesktopProfile(home)
      const target = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-computer-use')
      const receiptPath = join(profile, '.e-mate-install.json')
      const previousTime = new Date('2000-01-01T00:00:00Z')
      expect(existsSync(join(source, 'lib', 'types', 'client', 'index.d.ts'))).toBe(false)
      utimesSync(receiptPath, previousTime, previousTime)
      installEmateDesktopProfile(home)
      expect(statSync(receiptPath).mtimeMs).toBe(previousTime.getTime())

      for (const entry of [...entries, 'cordis.patch.yml']) {
        const path = join(target, entry)
        const expected = readFileSync(path)
        // Same-size corruption must be caught by critical-entry hashing.
        const corrupted = Buffer.from(expected)
        corrupted[0] = corrupted[0]! ^ 1
        writeFileSync(path, corrupted)
        utimesSync(receiptPath, previousTime, previousTime)
        installEmateDesktopProfile(home)
        expect(readFileSync(path)).toEqual(expected)
        expect(statSync(receiptPath).mtimeMs).not.toBe(previousTime.getTime())
        rmSync(path)
        installEmateDesktopProfile(home)
        expect(readFileSync(path)).toEqual(expected)
      }

      manifest.main = './host-default.js'
      writeFileSync(manifestPath, JSON.stringify(manifest))
      installEmateDesktopProfile(home)
      writeFileSync(join(target, manifest.main), runtime.replace('1', '2'))
      installEmateDesktopProfile(home)
      expect(readFileSync(join(target, manifest.main), 'utf8')).toBe(runtime)

      // A runtime condition still cannot escape the package, even if its bytes match.
      manifest.exports['./client'].default = '../outside.js'
      writeFileSync(manifestPath, JSON.stringify(manifest))
      writeFileSync(join(source, '..', 'outside.js'), runtime)
      writeFileSync(join(target, '..', 'outside.js'), runtime)
      installEmateDesktopProfile(home)
      utimesSync(receiptPath, previousTime, previousTime)
      installEmateDesktopProfile(home)
      expect(statSync(receiptPath).mtimeMs).not.toBe(previousTime.getTime())
    } finally {
      writeFileSync(manifestPath, originalManifest)
      for (const entry of entries) rmSync(join(source, entry), { force: true })
      rmSync(join(source, '..', 'outside.js'), { force: true })
    }
    // This exercises repeated full on-disk repairs, not the warm-start latency budget.
  }, 30_000)

  it('defers removal of replaced managed packages until the desktop is interactive', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const cdpPackage = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-cdp')
    const sentinel = join(cdpPackage, '.old-package-sentinel')
    const deferred: string[] = []
    writeFileSync(sentinel, 'old package tree')
    rmSync(join(cdpPackage, 'package.json'))

    installEmateDesktopProfile(home, path => { deferred.push(path) })

    expect(existsSync(join(cdpPackage, 'package.json'))).toBe(true)
    expect(deferred.some(path => existsSync(join(path, '.old-package-sentinel')))).toBe(true)
    for (const path of deferred) rmSync(path, { recursive: true, force: true })
  })

  it('restores the previous managed package when deferred cleanup fails', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const cdpPackage = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-cdp')
    const sentinel = join(cdpPackage, '.old-package-sentinel')
    writeFileSync(sentinel, 'previous package tree')
    rmSync(join(cdpPackage, 'package.json'))

    expect(() => installEmateDesktopProfile(home, () => {
      throw new Error('deferred cleanup failed')
    })).toThrow('deferred cleanup failed')

    expect(readFileSync(sentinel, 'utf8')).toBe('previous package tree')
    expect(existsSync(join(cdpPackage, 'package.json'))).toBe(false)
  })

  it('recovers a deterministic swap interrupted between the two renames', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const target = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-cdp')
    const candidate = `${target}.e-mate-next`
    const stale = `${target}.e-mate-stale`
    renameSync(target, stale)
    mkdirSync(candidate)
    writeFileSync(join(candidate, 'partial.txt'), 'interrupted candidate')

    installEmateDesktopProfile(home)

    expect(existsSync(join(target, 'package.json'))).toBe(true)
    expect(existsSync(candidate)).toBe(false)
    expect(existsSync(stale)).toBe(false)
  })

  it('persists and bounds failed stale cleanup without following an external link', async () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const target = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-cdp')
    const deferred: string[] = []
    rmSync(join(target, 'package.json'))
    installEmateDesktopProfile(home, path => { deferred.push(path) })
    const stale = `${target}.e-mate-stale`
    expect(deferred).toContain(stale)
    const warmDeferred: string[] = []
    installEmateDesktopProfile(home, path => { warmDeferred.push(path) })
    expect(warmDeferred).toContain(stale)

    const outside = join(home, 'outside-cleanup-owner')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'must remain')
    rmSync(stale, { recursive: true, force: true })
    symlinkSync(outside, stale, 'dir')
    const linkedDeferred: string[] = []
    installEmateDesktopProfile(home, path => { linkedDeferred.push(path) })
    expect(linkedDeferred).toContain(stale)
    await expect(cleanupEmateDesktopProfileArtifact(profile, outside)).rejects.toThrow('outside the owned')
    for (let attempt = 0; attempt < EMATE_MANAGED_PROFILE_CLEANUP_MAX_ATTEMPTS; attempt += 1) {
      await expect(cleanupEmateDesktopProfileArtifact(profile, stale)).rejects.toThrow('not a physical directory')
    }
    await expect(cleanupEmateDesktopProfileArtifact(profile, stale)).rejects.toThrow('retry limit is exhausted')

    const retried: string[] = []
    installEmateDesktopProfile(home, path => { retried.push(path) })
    expect(retried).not.toContain(stale)
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('must remain')
    const receipt = JSON.parse(readFileSync(join(profile, '.e-mate-install.json'), 'utf8')) as {
      cleanup_attempts?: Record<string, number>
    }
    expect(Object.values(receipt.cleanup_attempts ?? {})).toContain(EMATE_MANAGED_PROFILE_CLEANUP_MAX_ATTEMPTS)
  })

  it('preserves a native DSH plugin dependency and bundle across managed profile repair', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const manifestPath = join(profile, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    manifest.dependencies['@xmanrui/dsh-im'] = 'github:zyfjacksonchen-source/dsh-im#f984f73dcd67692141d4e475c8fbe887e2ce7062'
    manifest.dependencies['@e-mate/dsh-plugin-im'] = '2.0.8'
    manifest.dependencies['@e-mate/dsh-plugin-idesign'] = '2.0.12'
    manifest.dependencies['@e-mate/dsh-plugin-search-mcp'] = '2.0.11'
    manifest.dependencies['@e-mate/dsh-plugin-xin-assistant'] = '2.0.10'
    manifest.dependencies['@yuxianglin/dsh-bridge-browser'] = '0.0.1'
    manifest.dependencies['dsh-better-sidebar'] = '0.12.2'
    manifest.dependencies['dsh-turn-fold'] = '0.2.2'
    const retiredXin = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-xin-assistant')
    const retiredIDesign = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-idesign')
    const retiredSearchMcp = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-search-mcp')
    const retiredSidebar = join(profile, 'node_modules', 'dsh-better-sidebar')
    const retiredTurnFold = join(profile, 'node_modules', 'dsh-turn-fold')
    mkdirSync(retiredXin, { recursive: true })
    mkdirSync(retiredIDesign, { recursive: true })
    mkdirSync(retiredSearchMcp, { recursive: true })
    mkdirSync(retiredSidebar, { recursive: true })
    mkdirSync(retiredTurnFold, { recursive: true })
    writeFileSync(join(retiredXin, 'stale.txt'), 'retired', { flag: 'w' })
    writeFileSync(join(retiredIDesign, 'stale.txt'), 'retired', { flag: 'w' })
    writeFileSync(join(retiredSearchMcp, 'stale.txt'), 'retired', { flag: 'w' })
    writeFileSync(join(retiredSidebar, 'stale.txt'), 'retired', { flag: 'w' })
    writeFileSync(join(retiredTurnFold, 'stale.txt'), 'retired', { flag: 'w' })
    manifest.dsh.profile.bundles.push(
      '@xmanrui/dsh-im',
      '@e-mate/dsh-plugin-im',
      '@e-mate/dsh-plugin-idesign',
      '@e-mate/dsh-plugin-search-mcp',
      '@e-mate/dsh-plugin-xin-assistant',
      '@yuxianglin/dsh-bridge-browser',
      'dsh-better-sidebar',
      'dsh-turn-fold',
    )
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    installEmateDesktopProfile(home)

    const repaired = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest
    expect(repaired.dependencies['@xmanrui/dsh-im']).toBe(
      'github:zyfjacksonchen-source/dsh-im#f984f73dcd67692141d4e475c8fbe887e2ce7062',
    )
    expect(repaired.dsh.profile.bundles.at(-1)).toBe('@xmanrui/dsh-im')
    expect(repaired.dependencies['@e-mate/dsh-plugin-im']).toBeUndefined()
    expect(repaired.dependencies['@e-mate/dsh-plugin-idesign']).toBeUndefined()
    expect(repaired.dependencies['@e-mate/dsh-plugin-search-mcp']).toBeUndefined()
    expect(repaired.dependencies['@e-mate/dsh-plugin-xin-assistant']).toBeUndefined()
    expect(repaired.dependencies['@yuxianglin/dsh-bridge-browser']).toBeUndefined()
    expect(repaired.dependencies['dsh-better-sidebar']).toBeUndefined()
    expect(repaired.dependencies['dsh-turn-fold']).toBeUndefined()
    expect(repaired.dsh.profile.bundles).not.toContain('@e-mate/dsh-plugin-im')
    expect(repaired.dsh.profile.bundles).not.toContain('@e-mate/dsh-plugin-idesign')
    expect(repaired.dsh.profile.bundles).not.toContain('@e-mate/dsh-plugin-search-mcp')
    expect(repaired.dsh.profile.bundles).not.toContain('@e-mate/dsh-plugin-xin-assistant')
    expect(repaired.dsh.profile.bundles).not.toContain('@yuxianglin/dsh-bridge-browser')
    expect(repaired.dsh.profile.bundles).not.toContain('dsh-better-sidebar')
    expect(repaired.dsh.profile.bundles).not.toContain('dsh-turn-fold')
    expect(existsSync(retiredXin)).toBe(false)
    expect(existsSync(retiredIDesign)).toBe(false)
    expect(existsSync(retiredSearchMcp)).toBe(false)
    expect(existsSync(retiredSidebar)).toBe(false)
    expect(existsSync(retiredTurnFold)).toBe(false)
  })
})
