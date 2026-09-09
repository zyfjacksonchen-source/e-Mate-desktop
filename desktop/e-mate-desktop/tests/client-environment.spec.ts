import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { provideDesktopLayout } from '../src/client/layout-service.ts'
import { parseDesktopClientEnvironment } from '../src/client/environment.ts'
import {
  computeDesktopColumns, DesktopLayoutState, MACOS_SIDEBAR_COLLAPSED, SIDEBAR_COLLAPSED,
} from '../src/client/layout-state.ts'
import { installAdvancedStyles } from '../src/client/styles.ts'
import {
  MACOS_DRAG_REGION_HEIGHT,
  MACOS_TITLEBAR_HEIGHT,
  MACOS_TRAFFIC_LIGHT_SAFE_WIDTH,
  WINDOWS_CAPTION_CONTROLS_WIDTH,
  WINDOWS_TITLEBAR_HEIGHT,
} from '../src/window-chrome.ts'

describe('desktop client environment', () => {
  it('accepts the Electron-owned kebab query markers', () => {
    expect(parseDesktopClientEnvironment('?dsh-desktop-mode=advanced&dsh-desktop-platform=darwin'))
      .toEqual({ mode: 'advanced', platform: 'darwin' })
    expect(parseDesktopClientEnvironment('?dsh-desktop-platform=win32&dsh-desktop-mode=compatibility'))
      .toEqual({ mode: 'compatibility', platform: 'win32' })
  })

  it('prefers the immutable Preload bootstrap over missing or malformed URL state', () => {
    const bootstrap = {
      schemaVersion: 1 as const,
      mode: 'advanced' as const,
      platform: 'win32' as const,
      profileGeneration: 'bundled' as const,
      runtimeId: 'runtime-123',
      windowKind: 'main' as const,
    }
    expect(parseDesktopClientEnvironment('', undefined, bootstrap))
      .toEqual({ mode: 'advanced', platform: 'win32' })
    expect(parseDesktopClientEnvironment('?dsh-desktop-mode=glass', undefined, bootstrap))
      .toEqual({ mode: 'advanced', platform: 'win32' })
  })

  it.each([
    ['', 'dsh-desktop-mode'],
    ['?dsh-desktop-mode=glass&dsh-desktop-platform=darwin', 'dsh-desktop-mode'],
    ['?dsh-desktop-mode=advanced', 'dsh-desktop-platform'],
    ['?dsh-desktop-mode=advanced&dsh-desktop-platform=android', 'dsh-desktop-platform'],
  ])('fails loud for malformed marker %s', (search, field) => {
    expect(() => parseDesktopClientEnvironment(search)).toThrow(field)
  })

  it('restores the validated Electron markers after SPA navigation drops the query', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }

    expect(parseDesktopClientEnvironment(
      '?dsh-desktop-mode=compatibility&dsh-desktop-platform=darwin',
      storage,
    )).toEqual({ mode: 'compatibility', platform: 'darwin' })
    expect(parseDesktopClientEnvironment('/login?return=%2F', storage))
      .toEqual({ mode: 'compatibility', platform: 'darwin' })
  })
})

describe('advanced desktop layout', () => {
  it('owns native caption geometry without targeting feature headers', () => {
    expect(MACOS_TITLEBAR_HEIGHT).toBe(20)
    expect(MACOS_DRAG_REGION_HEIGHT).toBe(32)
    expect(MACOS_DRAG_REGION_HEIGHT).toBeGreaterThan(MACOS_TITLEBAR_HEIGHT)
    expect(WINDOWS_TITLEBAR_HEIGHT).toBe(32)
    let css = ''
    const remove = vi.fn()
    const style = {
      dataset: {},
      get textContent() { return css },
      set textContent(value: string) { css = value },
      remove,
    }
    const appendChild = vi.fn()
    vi.stubGlobal('document', {
      createElement: () => style,
      head: { appendChild },
    })

    try {
      const dispose = installAdvancedStyles()
      expect(css).toMatch(/\.dshDesktopFrame \{[^}]*background:\s*var\(--emate-color-workspace, var\(--dsw-alias-bg-base\)\);/)
      expect(css).toMatch(/\.dshDesktopSidebarSurface\s*\{[^}]*--dsw-specific-sidebar-fill:\s*var\(--emate-color-canvas, var\(--dsw-alias-bg-layer-1\)\);[^}]*background:\s*var\(--dsw-specific-sidebar-fill\);/)
      expect(css).toMatch(/data-desktop-platform="darwin"\]\[data-sidebar-collapsed\][^{]*\.dshDesktopUpstreamSidebar \{[^}]*width:\s*56px;[^}]*margin:\s*0 auto;/)
      expect(css).toMatch(new RegExp(`data-desktop-platform="darwin"\\] \\.dshDesktopUpstreamSidebar \\{[^}]*padding-top: ${MACOS_TITLEBAR_HEIGHT}px;[^}]*-webkit-app-region: no-drag;`))
      expect(css).toContain(`grid-template-rows: ${MACOS_TITLEBAR_HEIGHT}px minmax(0, 1fr)`)
      expect(css).toMatch(/\.dshDesktopFrame\[data-desktop-platform="darwin"\] \.dshDesktopSidebarSurface \{[^}]*grid-row: 1 \/ -1;[^}]*-webkit-app-region: no-drag;/)
      expect(css).toMatch(new RegExp(`data-desktop-platform="darwin"\\] \\.dshDesktopConversationSurface,[\\s\\S]*grid-row: 1 / -1;[\\s\\S]*padding-top: ${MACOS_TITLEBAR_HEIGHT}px;`))
      expect(css).toMatch(/body\[data-dsh-desktop-mode="advanced"\]\[data-dsh-desktop-platform="darwin"\] \{[^}]*--dsh-desktop-caption-safe-left:\s*80px;/)
      expect(css).toMatch(new RegExp(`data-desktop-platform="darwin"\\] \\.dshDesktopSidebarSurface::before \\{[^}]*left: ${MACOS_TRAFFIC_LIGHT_SAFE_WIDTH}px;[^}]*height: ${MACOS_DRAG_REGION_HEIGHT}px;[^}]*-webkit-app-region: drag;`))
      expect(css).not.toMatch(/data-desktop-platform="darwin"\] \.dshDesktopSidebarSurface::before \{[^}]*z-index:/)
      expect(css).toMatch(/\.dshDesktopMacCaptionRow \{[^}]*position: relative;[^}]*grid-column: 2 \/ -1;[^}]*grid-row: 1;/)
      expect(css).toMatch(/\.dshDesktopMacCaptionRow \{[^}]*background:\s*transparent;/)
      expect(css).toMatch(/\.dshDesktopConversationSurface \{[^}]*background:\s*var\(--emate-color-workspace, var\(--dsw-alias-bg-base\)\);/)
      expect(css).toMatch(/\.dshDesktopDetailsSurface \{[^}]*background:\s*var\(--emate-color-workspace, var\(--dsw-alias-bg-base\)\);/)
      expect(css).toMatch(new RegExp(`\\.dshDesktopMacCaptionRow::before \\{[^}]*height: ${MACOS_DRAG_REGION_HEIGHT}px;[^}]*-webkit-app-region: drag;`))
      expect(css).not.toMatch(/\.dshDesktopMacCaptionRow::before \{[^}]*z-index:/)
      expect(css).not.toMatch(/data-desktop-platform="darwin"\] \.dshDesktopSidebarSurface \{[^}]*-webkit-app-region:\s*drag;/)
      expect(css).not.toContain('[data-phase')
      expect(css).toMatch(/html:has\(\[aria-modal="true"\]\) \.dshDesktopMacCaptionRow::before,[\s\S]*html:has\(\[aria-modal="true"\]\) \.dshDesktopSidebarSurface::before \{ -webkit-app-region: no-drag !important; \}/)
      expect(css).toContain(`grid-template-rows: ${WINDOWS_TITLEBAR_HEIGHT}px minmax(0, 1fr)`)
      expect(css).toMatch(/\.dshDesktopFrame\[data-desktop-platform="win32"\] \.dshDesktopSidebarSurface \{ grid-row: 1 \/ -1; \}/)
      expect(css).toMatch(/\.dshDesktopFrame\[data-desktop-platform="win32"\] \.dshDesktopConversationSurface,\s*\.dshDesktopFrame\[data-desktop-platform="win32"\] \.dshDesktopDetailsSurface \{ grid-row: 2; \}/)
      expect(css).toMatch(/\.dshDesktopWindowsCaptionRow \{[^}]*grid-column: 2 \/ -1;[^}]*grid-row: 1;/)
      expect(css).toMatch(/\.dshDesktopWindowsCaptionRow \{[^}]*background:\s*var\(--emate-color-workspace, var\(--dsw-alias-bg-base\)\);/)
      expect(css).toMatch(/body\[data-dsh-desktop-mode="advanced"\] \{[^}]*--dsh-desktop-caption-safe-width:\s*0px;/)
      expect(css).toMatch(new RegExp(`body\\[data-dsh-desktop-mode="advanced"\\]\\[data-dsh-desktop-platform="win32"\\] \\{[^}]*--dsh-desktop-caption-safe-width: max\\(${WINDOWS_CAPTION_CONTROLS_WIDTH}px, calc\\(100vw - env\\(titlebar-area-x, 0px\\) - env\\(titlebar-area-width, 100vw\\)\\)\\);`))
      expect(css).not.toMatch(/data-dsh-desktop-platform="(?:darwin|linux)"[^}]*--dsh-desktop-caption-safe-width:/)
      expect(css.match(new RegExp(`${WINDOWS_CAPTION_CONTROLS_WIDTH}px`, 'gu'))).toHaveLength(1)
      expect(css).toMatch(/\.dshDesktopWindowsCaptionRow::before \{[^}]*inset: 0 var\(--dsh-desktop-caption-safe-width\) 0 0;[^}]*-webkit-app-region: drag;/)
      expect(css).toMatch(/\.dshDesktopTitlebarUtilities \{[^}]*top: 1px;[^}]*right: 112px;[^}]*height: 32px;/)
      expect(css).toContain('right: calc(var(--dsh-desktop-caption-safe-width) + 112px);')
      expect(css).toContain('right: calc(var(--dsh-desktop-caption-safe-width) + 10px);')
      expect(css).not.toMatch(/data-desktop-platform="win32"[^{}]*header[^{}]*\{[^}]*padding-right/)
      expect(appendChild).toHaveBeenCalledWith(style)
      dispose()
      expect(remove).toHaveBeenCalledOnce()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('releases the Cordis layout service with its owning effect', () => {
    let disposed = false
    const ctx = {
      reflect: {
        provide: (name: string, value: unknown) => {
          expect(name).toBe('layout')
          expect(value).toBeInstanceOf(DesktopLayoutState)
          return () => { disposed = true }
        },
      },
    } as unknown as ClientContext

    const dispose = provideDesktopLayout(ctx, new DesktopLayoutState())
    expect(disposed).toBe(false)
    dispose()
    expect(disposed).toBe(true)
  })

  it('uses the compatibility rail on Windows and the wider desktop rail on macOS', () => {
    expect(computeDesktopColumns(1440, 0, 0)).toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 1384, details: 0 })
    expect(computeDesktopColumns(1440, 0, 0, MACOS_SIDEBAR_COLLAPSED))
      .toEqual({ sidebar: MACOS_SIDEBAR_COLLAPSED, center: 1350, details: 0 })
    expect(SIDEBAR_COLLAPSED).toBe(56)
    expect(MACOS_SIDEBAR_COLLAPSED).toBe(90)
  })

  it('publishes mirrored panel transitions', () => {
    const layout = new DesktopLayoutState()
    const snapshots: object[] = []
    layout.subscribe(() => { snapshots.push(layout.getSnapshot()) })
    layout.toggleSidebar()
    layout.openDetails()
    layout.closeDetails()
    expect(snapshots).toEqual([
      { sidebar: 0, details: 0, narrow: false, narrowExpanded: false },
      { sidebar: 0, details: 360, narrow: false, narrowExpanded: false },
      { sidebar: 0, details: 0, narrow: false, narrowExpanded: false },
    ])
  })

  it('closes details whenever the current conversation changes', () => {
    const source = readFileSync(new URL('../src/client/AdvancedFrame.tsx', import.meta.url), 'utf8')
    expect(source).toMatch(/const currentSession = useSessions\(state => state\.current\)/u)
    expect(source).toMatch(/if \(previousSession\.current !== currentSession\) layout\.closeDetails\(\)/u)
  })

  it('lets the rail re-expand without losing its wide preference on narrow windows', () => {
    const layout = new DesktopLayoutState()
    layout.setNarrow(true)
    expect(layout.getSnapshot()).toMatchObject({ sidebar: 280, narrow: true, narrowExpanded: false })
    layout.toggleSidebar()
    expect(layout.getSnapshot()).toMatchObject({ sidebar: 280, narrow: true, narrowExpanded: true })
    layout.setNarrow(false)
    expect(layout.getSnapshot()).toMatchObject({ sidebar: 280, narrow: false, narrowExpanded: false })
  })
})


it('notification navigation waits for the native catalog and drops missing sessions safely', async () => {
  const { installNotificationNavigation } = await import('../src/client/index.ts')
  let state = { phase: 'pending', byId: {} } as any
  let changed: (() => void) | undefined
  let clicked: ((id: string) => void) | undefined
  const stopList = vi.fn(() => { changed = undefined })
  const stopBridge = vi.fn(() => { clicked = undefined })
  const open = vi.fn()
  const stop = installNotificationNavigation({ open, list: {
    getSnapshot: () => state,
    subscribe: fn => { changed = fn; return stopList },
  } }, { subscribe: fn => { clicked = fn; return stopBridge } })
  clicked!('one')
  expect(open).not.toHaveBeenCalled()
  state = { phase: 'ready', byId: { one: {} } }
  changed!()
  expect(open).toHaveBeenCalledExactlyOnceWith('one')
  changed!()
  clicked!('deleted')
  expect(open).toHaveBeenCalledTimes(1)
  open.mockImplementation(() => { throw new Error('deleted between snapshot and select') })
  expect(() => clicked!('one')).not.toThrow()
  stop()
  expect(stopList).toHaveBeenCalledOnce()
  expect(stopBridge).toHaveBeenCalledOnce()
})
