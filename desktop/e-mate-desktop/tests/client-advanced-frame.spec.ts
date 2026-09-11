import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { AdvancedFrame } from '../src/client/AdvancedFrame.tsx'
import { applyAdvancedShell } from '../src/client/advanced-shell.ts'
import { DesktopLayoutController } from '../src/client/layout-service.ts'
import {
  computeDesktopColumns, desktopLayoutActions, DesktopLayoutState, MACOS_SIDEBAR_COLLAPSED,
  RIGHTBAR_MIN, SIDEBAR_COLLAPSED,
} from '../src/client/layout-state.ts'

interface RootRegistration {
  options: {
    name: string
    children: Record<string, { kind: string; scope: string }>
    inject: () => { platform: string; actions: ReturnType<typeof desktopLayoutActions>; hooks: { layout: { getSnapshot(): LayoutFacts } } }
  }
  component: unknown
}

interface LayoutFacts { panelInfo: { activePanelId: string | null }; layoutInfo: Record<string, unknown> }

/** Minimal renderer document used by the advanced shell's style and theme effects. */
function stubRendererDom(viewportWidth = 1440): void {
  const element = () => ({
    dataset: {}, textContent: '', name: '', content: '', isConnected: true,
    remove: vi.fn(), setAttribute: vi.fn(), removeAttribute: vi.fn(),
    style: { colorScheme: '', setProperty: vi.fn(), removeProperty: vi.fn() },
  })
  vi.stubGlobal('document', {
    createElement: element,
    head: { appendChild: vi.fn() },
    body: { dataset: {}, setAttribute: vi.fn(), removeAttribute: vi.fn(), style: { setProperty: vi.fn(), removeProperty: vi.fn() } },
    documentElement: { style: { colorScheme: '', removeProperty: vi.fn() } },
  })
  vi.stubGlobal('getComputedStyle', () => ({ backgroundColor: 'rgb(0, 0, 0)' }))
  vi.stubGlobal('window', { innerWidth: viewportWidth })
}

/** Driven Cordis fixture: runs each effect and records the registration, the faces and the root hooks. */
function createShellFixture(viewportWidth = 1440) {
  const registrations: RootRegistration[] = []
  const rootHooks: Array<{ hooks?: Record<string, { getSnapshot(): unknown }> }> = []
  const services: Record<string, unknown> = {}
  const mainEntries: Array<{ options: { key?: string } }> = []
  const teardown: Array<() => void> = []
  const ctx = {
    effect: (fn: () => unknown) => {
      const dispose = fn()
      if (typeof dispose === 'function') teardown.push(dispose as () => void)
    },
    on: () => () => {},
    get: () => undefined,
    slots: {
      entries: () => mainEntries,
      subscribe: () => () => {},
      provideRoot: (contribution: { hooks?: Record<string, { getSnapshot(): unknown }> }) => {
        rootHooks.push(contribution)
        return () => {}
      },
      register: (options: RootRegistration['options'], component: unknown) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    reflect: {
      provide: (name: string, value: unknown) => {
        services[name] = value
        return () => {}
      },
    },
    theme: { getTheme: () => ({ active: { colorScheme: 'dark', tokens: {} } }) },
  } as unknown as ClientContext
  stubRendererDom(viewportWidth)
  return { ctx, registrations, rootHooks, services, mainEntries, teardown }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('advanced desktop root registration', () => {
  it('declares the pinned 0.1.5 frame contract instead of the retired conversation/details seats', () => {
    const fixture = createShellFixture()
    applyAdvancedShell(fixture.ctx, { mode: 'advanced', platform: 'darwin' })

    expect(fixture.registrations).toHaveLength(1)
    const registration = fixture.registrations[0]!
    expect(registration.options.name).toBe('root')
    expect(registration.options.children).toEqual({
      'sidebar': { kind: 'single', scope: 'root' },
      'main': { kind: 'keyed', scope: 'root' },
      'rightbar': { kind: 'single', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
      'desktop.titlebar.utilities': { kind: 'list', scope: 'session-maybe' },
    })
    expect(registration.component).toBe(AdvancedFrame)
    expect(registration.options.inject().platform).toBe('darwin')
  })

  it('serves ctx.layout, the usePanelInfo seat and the frame from one layout state', () => {
    const fixture = createShellFixture()
    applyAdvancedShell(fixture.ctx, { mode: 'advanced', platform: 'darwin' })
    const registration = fixture.registrations[0]!
    const injected = registration.options.inject()

    expect(fixture.services.layout).toBeInstanceOf(DesktopLayoutController)
    expect(fixture.rootHooks).toEqual([{ hooks: { panelInfo: expect.anything() } }])
    expect(fixture.rootHooks[0]!.hooks!.panelInfo!.getSnapshot()).toEqual({ activePanelId: null })
    expect(injected.hooks.layout.getSnapshot().layoutInfo).toMatchObject({ sidebar: 280, viewportWidth: 1440 })

    // The occupant's report arrives through ctx.layout and reaches the frame's
    // own source, then the frame's gesture writes reach the same facts.
    ;(fixture.services.layout as DesktopLayoutController).openRightbar(true, false)
    expect(injected.hooks.layout.getSnapshot().layoutInfo).toMatchObject({
      rightbarShown: true, rightbarTrack: true, rightbarFullscreen: false,
    })
    injected.actions.setSidebar(100)
    expect(injected.hooks.layout.getSnapshot().layoutInfo).toMatchObject({ sidebar: 264 })
    injected.actions.toggleSidebar()
    expect(injected.hooks.layout.getSnapshot().layoutInfo).toMatchObject({ sidebar: 0 })
  })

  it('releases ctx.layout and the root hook with the owning effect', () => {
    const fixture = createShellFixture()
    applyAdvancedShell(fixture.ctx, { mode: 'advanced', platform: 'win32' })
    expect(fixture.teardown).toHaveLength(3)
    expect(() => { for (const dispose of fixture.teardown) dispose() }).not.toThrow()
  })
})

describe('ctx.layout face', () => {
  function controller(actions: ReturnType<typeof desktopLayoutActions>, registered: string[]) {
    return new DesktopLayoutController(actions, id => registered.includes(id))
  }

  it('rejects an unregistered main panel and keeps the current selection', () => {
    const state = new DesktopLayoutState(1440)
    const actions = desktopLayoutActions(state)
    const registered: string[] = []
    const layout = controller(actions, registered)
    expect(() => layout.selectPanel('jobs' as MainPanelId)).toThrow('not registered')
    expect(state.getSnapshot().panelInfo.activePanelId).toBeNull()
    registered.push('jobs')
    layout.selectPanel('jobs' as MainPanelId)
    expect(state.getSnapshot().panelInfo.activePanelId).toBe('jobs')
    layout.selectPanel(null)
    expect(state.getSnapshot().panelInfo.activePanelId).toBeNull()
  })

  it('supersedes pending navigation and aborts it on disposal', () => {
    const layout = controller(desktopLayoutActions(new DesktopLayoutState(1440)), [])
    const first = layout.beginNavigation()
    const second = layout.beginNavigation()
    expect(first.aborted).toBe(true)
    layout.dispose()
    expect(second.aborted).toBe(true)
  })

  it('reports the right column presentation without owning it', () => {
    const state = new DesktopLayoutState(1440)
    const layout = controller(desktopLayoutActions(state), [])
    layout.openRightbar(false, true)
    expect(state.getSnapshot().layoutInfo).toMatchObject({ rightbarShown: true, rightbarTrack: false, rightbarFullscreen: true })
    layout.closeRightbar()
    expect(state.getSnapshot().layoutInfo).toMatchObject({ rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false })
  })
})

describe('desktop layout state', () => {
  it('opens the right panel at its default width and keeps that preference', () => {
    const state = new DesktopLayoutState(1440)
    const actions = desktopLayoutActions(state)
    actions.openRightbar(true, false)
    expect(state.getSnapshot().layoutInfo.rightbar).toBe(648)
    actions.setRightbar(520)
    actions.closeRightbar()
    actions.openRightbar(true, false)
    expect(state.getSnapshot().layoutInfo).toMatchObject({ rightbar: 520, rightbarShown: true, rightbarTrack: true })
  })

  it('clamps a dragged right panel between its floor and the frame ratio', () => {
    const state = new DesktopLayoutState(1000)
    const actions = desktopLayoutActions(state)
    actions.setRightbar(10)
    expect(state.getSnapshot().layoutInfo.rightbar).toBe(RIGHTBAR_MIN)
    actions.setRightbar(5_000)
    expect(state.getSnapshot().layoutInfo.rightbar).toBe(700)
  })

  it('keeps the wide preference while the rail re-expands on a narrow frame', () => {
    const state = new DesktopLayoutState(1440)
    const actions = desktopLayoutActions(state)
    actions.setViewportWidth(800)
    expect(state.getSnapshot().layoutInfo).toMatchObject({ sidebar: 280, narrowExpanded: false })
    actions.toggleSidebar()
    expect(state.getSnapshot().layoutInfo).toMatchObject({ sidebar: 280, narrowExpanded: true })
    actions.setViewportWidth(1440)
    expect(state.getSnapshot().layoutInfo).toMatchObject({ sidebar: 280, narrowExpanded: false })
  })

  it('collapses the narrow rail override when the right panel opens', () => {
    const state = new DesktopLayoutState(800)
    const actions = desktopLayoutActions(state)
    actions.toggleSidebar()
    expect(state.getSnapshot().layoutInfo.narrowExpanded).toBe(true)
    actions.openRightbar(true, false)
    expect(state.getSnapshot().layoutInfo.narrowExpanded).toBe(false)
  })

  it('drops a selection whose main panel is no longer registered', () => {
    const state = new DesktopLayoutState(1440)
    const actions = desktopLayoutActions(state)
    actions.selectPanel('jobs' as MainPanelId)
    actions.retainMainPanels(['jobs'])
    expect(state.getSnapshot().panelInfo.activePanelId).toBe('jobs')
    actions.retainMainPanels([])
    expect(state.getSnapshot().panelInfo.activePanelId).toBeNull()
  })

  it('publishes immutable snapshots to its subscribers', () => {
    const state = new DesktopLayoutState(1440)
    const seen: unknown[] = []
    const unsubscribe = state.subscribe(() => { seen.push(state.getSnapshot()) })
    const before = state.getSnapshot()
    state.toggleSidebar()
    unsubscribe()
    state.toggleSidebar()
    expect(seen).toHaveLength(1)
    expect(before).not.toBe(state.getSnapshot())
    expect(Object.isFrozen(state.getSnapshot().layoutInfo)).toBe(true)
  })
})

describe('desktop column solve', () => {
  it('renders the platform rail for a closed sidebar', () => {
    expect(computeDesktopColumns(1440, 0, 0)).toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 1384, rightbar: 0 })
    expect(computeDesktopColumns(1440, 0, 0, MACOS_SIDEBAR_COLLAPSED))
      .toEqual({ sidebar: MACOS_SIDEBAR_COLLAPSED, center: 1350, rightbar: 0 })
  })

  it('shrinks the right column, then drops its track, before the center yields', () => {
    expect(computeDesktopColumns(1440, 280, 600)).toEqual({ sidebar: 280, center: 560, rightbar: 600 })
    expect(computeDesktopColumns(1000, 280, 600)).toEqual({ sidebar: 280, center: 400, rightbar: 320 })
    expect(computeDesktopColumns(900, 280, 600)).toEqual({ sidebar: 280, center: 620, rightbar: 0 })
  })

  it('clamps the sidebar preference into its drag range', () => {
    expect(computeDesktopColumns(1440, 100, 0).sidebar).toBe(264)
    expect(computeDesktopColumns(1440, 900, 0).sidebar).toBe(420)
  })
})
