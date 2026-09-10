import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { composeEntries, initProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import {
  DESKTOP_PACKAGE_NAME,
  desktopShellModeFromSettings,
  desktopBundleList,
  ensureDesktopProfile,
  prepareDesktopProfile,
  readDesktopShellMode,
  shippedPresetRoot,
} from '../src/profile.ts'

const homes: string[] = []

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-'))
  homes.push(home)
  return home
}

function installWebClient(
  home: string,
  packageName: string,
  manifest: Record<string, unknown> = {},
): string {
  const webDir = join(home, 'profiles', 'web')
  const bundles = PROFILE_TEMPLATES.web
  if (bundles === undefined) throw new Error('test requires the shipped Web template')
  initProfile(webDir, bundles)
  const packageDir = join(webDir, 'node_modules', ...packageName.split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: packageName,
    type: 'module',
    dsh: { client: { platform: 'web' } },
    ...manifest,
  }) + '\n')
  writeFileSync(join(packageDir, 'index.js'), 'export default {}\n')
  return webDir
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('desktop profile composition', () => {
  it('adds the Web surface before third-party bundles and removes the launcher bundle duplicate', () => {
    expect(desktopBundleList([
      '@deepseek-ai/dsh-base',
      'third-party-one',
      DESKTOP_PACKAGE_NAME,
      'third-party-two',
    ])).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'third-party-one',
      'third-party-two',
    ])
  })

  it('repairs a base-only CLI profile without replacing dependencies', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const path = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({
      ...manifest,
      dependencies: { 'third-party-plugin': '^1.2.3' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'third-party-plugin'] } },
      custom: { preserved: true },
    }, undefined, 2) + '\n')

    ensureDesktopProfile(home)
    const repaired = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
      custom: { preserved: boolean }
    }
    expect(repaired.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'third-party-plugin',
    ])
    expect(repaired.dependencies).toEqual({ 'third-party-plugin': '^1.2.3' })
    expect(repaired.custom.preserved).toBe(true)
  })

  it('rejects malformed persistent bundle metadata', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const path = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({ ...manifest, dsh: { profile: { bundles: 'not-an-array' } } }) + '\n')
    expect(() => ensureDesktopProfile(home)).toThrow('dsh.profile.bundles must be an array')
  })

  // A cold Windows home materializes the full dependency junction fallback; keep its I/O budget local.
  it('assembles the Host shell without replacing the upstream client shell', () => {
    const home = temporaryHome()
    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    const patches = prepared.patches as Array<Record<string, unknown>>
    const inserted = patches.flatMap((patch) => {
      const rows = patch.insert
      return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []
    })
    expect(inserted).toContainEqual(expect.objectContaining({
      name: DESKTOP_PACKAGE_NAME,
      config: { mode: 'advanced' },
    }))
    expect(patches).toContainEqual(expect.objectContaining({
      id: 'webserver',
      config: { host: '127.0.0.1', port: 3080 },
    }))
    expect(patches).toContainEqual(expect.objectContaining({
      id: 'agent-presets',
      config: expect.objectContaining({
        roots: [
          expect.objectContaining({ trust: 'system' }),
          expect.objectContaining({ trust: 'system' }),
        ],
      }),
    }))
    const presetPatch = patches.find(patch => patch.id === 'agent-presets') as {
      config: { roots: Array<{ path: string; trust: string }> }
    }
    const managedRoot = presetPatch.config.roots[0]?.path
    const nativeRoot = presetPatch.config.roots[1]?.path
    expect(managedRoot).toBe(join(home, 'profiles', 'e-mate', 'agent-presets'))
    expect(nativeRoot).toBe(shippedPresetRoot())
    const managedPreset = readFileSync(join(managedRoot!, 'standard', 'agent.cordis.yml'), 'utf8')
    expect(managedPreset).toContain('你是小芯，用户的 AI 办公助手。')
    expect(managedPreset).toContain('普通 Bash 或 PowerShell 调用不要设置 sandbox_permissions 或 justification')
    expect(managedPreset).toContain('当前工作目录是 {{cwd}}。')
    expect(managedPreset).not.toContain('You are a coding agent powered by the {{model}} model.')
    const nativeCode = readFileSync(join(nativeRoot!, 'code', 'agent.cordis.yml'), 'utf8')
    const managedCode = readFileSync(join(managedRoot!, 'code', 'agent.cordis.yml'), 'utf8')
    const nativePersona = 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.'
    const managedPersona = managedPreset.split('\n').find(line => line.includes('你是小芯，用户的 AI 办公助手。'))!.trim()
    expect(managedCode).toBe(nativeCode.replace(nativePersona, managedPersona))
    expect(readFileSync(join(managedRoot!, 'code', 'preset.yml'), 'utf8'))
      .toBe(readFileSync(join(nativeRoot!, 'code', 'preset.yml'), 'utf8'))
    expect(managedCode).toContain("name: '@deepseek-ai/dsh-agent-tool-presentation'")
    expect(managedCode).toContain('mode: code')
    expect(readFileSync(join(nativeRoot!, 'cordis', 'preset.yml'), 'utf8')).toContain('name: 创造模式')
    expect(readFileSync(join(nativeRoot!, 'cordis', 'skills', 'cordis-plugin-development', 'SKILL.md'), 'utf8'))
      .toContain('Cordis')
    expect(readFileSync(join(nativeRoot!, 'cordis', 'skills', 'editing-cordis-compositions', 'SKILL.md'), 'utf8'))
      .toContain('preset')
    expect(readFileSync(prepared.rootConfig, 'utf8')).toBe('[]\n')
    expect(prepared.homeDir).toBe(home)
    expect(fileURLToPath(prepared.bareModuleBaseUrl)).toBe(join(prepared.profile.dir, 'package.json'))
    expect(prepared.mode).toBe('advanced')

    const rows = composeEntries([prepared.patches])
    for (const [id, name] of [
      ['ui-layout', '@deepseek-ai/dsh-client-ui-layout'],
      ['ui-sidebar', '@deepseek-ai/dsh-client-ui-sidebar'],
      ['ui-conversation', '@deepseek-ai/dsh-client-ui-conversation'],
    ] as const) {
      const matching = rows.filter(row => row.id === id)
      expect(matching).toHaveLength(1)
      expect(matching[0]).toEqual(expect.objectContaining({ name }))
      expect(matching[0]?.disabled).toBe(id === 'ui-layout')
    }
    expect(rows.find(row => row.id === 'directory-picker')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-directory-picker-auto',
      disabled: true,
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'desktop-windows-directory-picker',
      name: '@e-mate/desktop/windows-directory-picker',
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'desktop-directory-picker-native-surface',
      name: '@deepseek-ai/dsh-client-ui-directory-picker-native',
    }))
    expect(rows.map(row => row.id)).not.toContain('desktop-directory-picker-browse-host')
    expect(rows.map(row => row.id)).not.toContain('desktop-directory-picker-browse-surface')
    expect(rows.find(row => row.id === 'subprocess')).toEqual({
      id: 'subprocess',
      name: '@deepseek-ai/dsh-subprocess-local',
    })
    expect(rows.find(row => row.id === 'sandbox')).toEqual({
      id: 'sandbox',
      name: '@deepseek-ai/dsh-sandbox-local',
    })
    expect(rows.find(row => row.id === 'pwsh-sandbox')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-pwsh-sandbox',
    }))
    expect(rows.map(row => row.id)).not.toContain('desktop-windows-pwsh-sandbox')
    expect(rows.find(row => row.id === 'desktop-terminal')).toEqual(expect.objectContaining({
      name: '@e-mate/desktop/terminal',
      disabled: { __jsExpr: "process.platform === 'linux'" },
    }))
    expect(rows.find(row => row.id === 'desktop-pnpm')).toEqual(expect.objectContaining({
      name: '@e-mate/desktop/pnpm',
    }))
    expect(rows.find(row => row.id === 'desktop-updates')).toEqual(expect.objectContaining({
      name: '@e-mate/desktop/updates',
    }))
    expect(rows.find(row => row.id === 'desktop-agent-update')).toEqual(expect.objectContaining({
      name: '@e-mate/desktop/agent-update',
    }))
    expect(rows.map(row => row.id)).not.toContain('desktop-computer-use-setup')
    expect(rows.map(row => row.id)).not.toContain('desktop-profiles')
  }, 15_000)

  it('boots a selected Web profile without overriding its compatibility UI rows', () => {
    const home = temporaryHome()
    const webDir = join(home, 'profiles', 'web')
    const bundles = PROFILE_TEMPLATES.web
    if (bundles === undefined) throw new Error('test requires the shipped Web template')
    initProfile(webDir, bundles)
    writeFileSync(join(webDir, 'cordis.patch.yml'), [
      '- id: ui-layout',
      "  name: '@deepseek-ai/dsh-client-ui-layout'",
      '  disabled: true',
      '- insert:',
      '    - id: third-party-layout',
      "      name: 'third-party-layout'",
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(undefined, home, 'darwin', 'web')
    const rows = composeEntries([prepared.patches])

    expect(prepared.profile.name).toBe('web')
    expect(rows.find(row => row.id === 'ui-layout')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-client-ui-layout',
      disabled: true,
    }))
    expect(rows.find(row => row.id === 'third-party-layout')).toEqual({
      id: 'third-party-layout',
      name: 'third-party-layout',
    })
    expect(rows.find(row => row.id === 'desktop-shell')).toEqual(expect.objectContaining({
      name: '@e-mate/desktop',
      config: expect.objectContaining({ mode: 'advanced' }),
    }))
  }, 15_000)

  it('keeps advanced mode fixed when stale settings request compatibility mode', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'settings.yaml'), 'dsh-desktop:\n  mode: compatibility\n')

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    const rows = composeEntries([prepared.patches])

    expect(prepared.mode).toBe('advanced')
    expect(rows.find(row => row.id === 'desktop-shell')).toEqual(expect.objectContaining({
      disabled: false,
      config: expect.objectContaining({ mode: 'advanced' }),
    }))
    expect(rows.find(row => row.id === 'settings')).toEqual(expect.objectContaining({
      config: expect.objectContaining({ dshHome: home }),
    }))
  })

  it('reads JSON settings and defaults an absent desktop namespace to advanced', () => {
    const home = temporaryHome()
    const path = join(home, 'desktop-settings.json')
    writeFileSync(path, JSON.stringify({ 'dsh-desktop': { mode: 'advanced' } }))

    expect(readDesktopShellMode({ path })).toBe('advanced')
    expect(desktopShellModeFromSettings({ unrelated: { enabled: true } })).toBe('advanced')
  })

  it('keeps Linux on the supported compatibility fallback', () => {
    const prepared = prepareDesktopProfile(undefined, temporaryHome(), 'linux')
    const rows = composeEntries([prepared.patches])
    expect(prepared.mode).toBe('compatibility')
    expect(rows.find(row => row.id === 'directory-picker')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-directory-picker-auto',
    }))
    expect(rows.find(row => row.id === 'directory-picker')?.disabled).toBeFalsy()
    expect(rows.map(row => row.id)).not.toContain('desktop-windows-directory-picker')
    expect(rows.map(row => row.id)).not.toContain('desktop-directory-picker-native-surface')
  })

  it('rejects invalid settings roots, sections, modes, and YAML', () => {
    expect(() => desktopShellModeFromSettings([])).toThrow('must be a map')
    expect(() => desktopShellModeFromSettings({ 'dsh-desktop': true })).toThrow('settings must be a map')
    expect(() => desktopShellModeFromSettings({ 'dsh-desktop': { mode: 'glass' } })).toThrow(
      'must be "compatibility" or "advanced"',
    )

    const home = temporaryHome()
    const path = join(home, 'invalid.yaml')
    writeFileSync(path, 'dsh-desktop: [\n')
    expect(() => readDesktopShellMode({ path })).toThrow('invalid settings document')
  })

  it.each(['', '# no machine-wide patches\n'])(
    'treats an empty machine-wide patch document %j as no entries',
    (content) => {
      const home = temporaryHome()
      const path = join(home, 'cordis.patch.yml')
      const baseline = composeEntries([prepareDesktopProfile(undefined, home, 'win32').patches])
      writeFileSync(path, content)
      const rows = composeEntries([prepareDesktopProfile(undefined, home, 'win32').patches])
      expect(rows).toEqual(baseline)
    },
  )

  it('rejects a malformed machine-wide patch root', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), 'not: a patch list\n')
    expect(() => prepareDesktopProfile(undefined, home, 'win32')).toThrow(
      'must be a top-level YAML array of loader patch entries',
    )
  })

  it('adapts one Windows native picker and desktop pwsh provider without replacing DSH seams', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- id: pwsh-sandbox',
      "  name: '@deepseek-ai/dsh-pwsh-sandbox'",
      '  config:',
      "    cwd: 'C:\\workspace'",
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(undefined, home, 'win32')
    const rows = composeEntries([prepared.patches])
    const picker = rows.find(row => row.id === 'directory-picker')

    expect(picker).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-directory-picker-auto',
      disabled: true,
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'desktop-windows-directory-picker',
      name: '@e-mate/desktop/windows-directory-picker',
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'desktop-directory-picker-native-surface',
      name: '@deepseek-ai/dsh-client-ui-directory-picker-native',
    }))
    expect(rows.filter(row => row.disabled !== true && [
      '@e-mate/desktop/windows-directory-picker',
      '@deepseek-ai/dsh-host-directory-picker-auto',
      '@deepseek-ai/dsh-host-directory-picker-native',
      '@deepseek-ai/dsh-host-directory-picker-browse',
    ].includes(row.name))).toEqual([
      expect.objectContaining({
        id: 'desktop-windows-directory-picker',
        name: '@e-mate/desktop/windows-directory-picker',
      }),
    ])
    expect(rows.filter(row => row.disabled !== true && [
      '@deepseek-ai/dsh-client-ui-directory-picker-native',
      '@deepseek-ai/dsh-client-ui-directory-picker-browse',
    ].includes(row.name))).toEqual([
      expect.objectContaining({
        id: 'desktop-directory-picker-native-surface',
        name: '@deepseek-ai/dsh-client-ui-directory-picker-native',
      }),
    ])
    expect(rows.find(row => row.id === 'subprocess')).toEqual({
      id: 'subprocess',
      name: '@deepseek-ai/dsh-subprocess-local',
    })
    expect(rows.find(row => row.id === 'sandbox')).toEqual({
      id: 'sandbox',
      name: '@deepseek-ai/dsh-sandbox-local',
    })
    expect(rows.find(row => row.id === 'pwsh-sandbox')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-pwsh-sandbox',
      disabled: true,
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'desktop-windows-pwsh-sandbox',
      name: '@e-mate/desktop/windows-pwsh-sandbox',
      disabled: { __jsExpr: "process.platform !== 'win32'" },
      config: { cwd: 'C:\\workspace' },
    }))
  })

  it('keeps a Web Client in its owning profile and omits it from desktop', () => {
    const home = temporaryHome()
    const packageName = '@linxin666/dsh-client-ui-skin-whale-song'
    installWebClient(home, packageName, { exports: { '.': { import: './index.js' } } })
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: missing-skin',
      `      name: '${packageName}'`,
      '    - id: third-party-host',
      "      name: 'third-party-host-plugin'",
      '',
    ].join('\n'))

    const desktop = prepareDesktopProfile(undefined, home, 'darwin')
    const desktopRows = composeEntries([desktop.patches])

    expect(desktopRows.map(row => row.id)).not.toContain('missing-skin')
    expect(desktopRows).toContainEqual({
      id: 'third-party-host',
      name: 'third-party-host-plugin',
    })
    expect(desktop.skippedOptionalEntries).toEqual([{
      id: 'missing-skin',
      name: packageName,
    }])

    const web = prepareDesktopProfile(undefined, home, 'darwin', 'web')
    const webRows = composeEntries([web.patches])
    expect(webRows).toContainEqual({ id: 'missing-skin', name: packageName })
    expect(web.skippedOptionalEntries).toEqual([])
  })

  it('keeps unresolved non-UI package entries fail-loud', () => {
    const home = temporaryHome()
    const packageName = '@example/whale-song-theme'
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: optional-theme',
      `      name: '${packageName}'`,
      '',
    ].join('\n'))

    const desktop = prepareDesktopProfile(undefined, home, 'darwin')
    expect(composeEntries([desktop.patches])).toContainEqual({ id: 'optional-theme', name: packageName })
    expect(desktop.skippedOptionalEntries).toEqual([])
  })

  it('does not treat ordinary array config as nested Loader entries', () => {
    const home = temporaryHome()
    const packageName = '@example/whale-song-theme'
    installWebClient(home, packageName)
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: config-holder',
      "      name: 'third-party-host-plugin'",
      '      config:',
      `        - name: '${packageName}'`,
      '          enabled: true',
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    expect(composeEntries([prepared.patches])).toContainEqual({
      id: 'config-holder',
      name: 'third-party-host-plugin',
      config: [{ name: packageName, enabled: true }],
    })
    expect(prepared.skippedOptionalEntries).toEqual([])
  })

  it('leaves non-package Loader specifiers unchanged', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: builtin-plugin',
      "      name: 'cordis:example'",
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    expect(composeEntries([prepared.patches])).toContainEqual({
      id: 'builtin-plugin',
      name: 'cordis:example',
    })
    expect(prepared.skippedOptionalEntries).toEqual([])
  })

  it('preserves an explicitly disabled upstream pwsh provider and a third-party replacement', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- id: pwsh-sandbox',
      "  name: '@deepseek-ai/dsh-pwsh-sandbox'",
      '  disabled: true',
      '- insert:',
      '    - id: third-party-pwsh-sandbox',
      "      name: 'third-party-pwsh-sandbox'",
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(undefined, home, 'win32')
    const rows = composeEntries([prepared.patches])

    expect(rows.find(row => row.id === 'pwsh-sandbox')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-pwsh-sandbox',
      disabled: true,
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'third-party-pwsh-sandbox',
      name: 'third-party-pwsh-sandbox',
    }))
    expect(rows.map(row => row.id)).not.toContain('desktop-windows-pwsh-sandbox')
  })
})
