/**
 * Advanced-shell layout state: the desktop frame's panel facts and the column
 * solve that reads them.
 *
 * Why this state is desktop-owned: the native layout owner
 * (@deepseek-ai/dsh-client-ui-layout) is disabled for the desktop advanced
 * profile (src/profile.ts disables the ui-layout row), because this frame
 * replaces its AppFrame, and its store value cannot be seated from the desktop
 * client program or bundle: the package's client entry exports LayoutController,
 * ILayout, MainPanelId, PanelInfo and the owner prop types only (createLayoutStore
 * stays internal), its internal module is absent from the installed closure and
 * the shared module table, and its engine (@deepseek-ai/dsh-client-store, which
 * needs zustand and immer) is neither externalized by tsdown.config.ts nor
 * present in the desktop closure. One desktop boot therefore has exactly one
 * owner of these facts; the state and action names mirror upstream
 * packages/client/ui-layout/src/client/stores.ts, so ctx.layout and the frame
 * read and write the same vocabulary a native store seat would.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'

/** Desktop layout facts, the twin of the native layout store's state. */
export interface DesktopLayoutSnapshot {
  /** Root-scoped panel selection, reported through the usePanelInfo standard hook. */
  panelInfo: PanelInfo
  layoutInfo: {
    /** Saved sidebar width preference; zero closes it into the compact rail. */
    sidebar: number
    /** Last positive frame measurement; the window width bootstraps the first render. */
    viewportWidth: number
    /** Narrow-frame override that re-expands the auto-collapsed rail. */
    narrowExpanded: boolean
    /** Saved right panel width in px, or null before its first opening. */
    rightbar: number | null
    /** Whether the occupant draws its panel at all, in either presentation. */
    rightbarShown: boolean
    /** Whether the normal panel width reserves a grid track, including beneath fullscreen. */
    rightbarTrack: boolean
    /** Reported fullscreen presentation; hides the outer resize handle. */
    rightbarFullscreen: boolean
  }
}

/**
 * The complete write set over the panel facts: what the frame's drag handles and
 * collapse gestures call, and what ctx.layout (layout-service.ts) forwards. The
 * native store's rightbarInstant flag is not modelled because this frame's
 * stylesheet eases the sidebar track only, and a drag pauses every track
 * transition through the frame's dragging attribute instead.
 */
export interface DesktopLayoutActions {
  /** Select a global main panel without changing the current Session. */
  selectPanel(panelId: MainPanelId | null): void
  /** Drop a selection whose main panel is no longer registered. */
  retainMainPanels(panelIds: readonly string[]): void
  /** @param px - requested sidebar width from a resize gesture. */
  setSidebar(px: number): void
  /** Toggle the sidebar between the wide preference and the compact rail. */
  toggleSidebar(): void
  /** @param width - latest positive frame measurement. */
  setViewportWidth(width: number): void
  /** @param px - requested right panel width from a resize gesture. */
  setRightbar(px: number): void
  /** Report the right panel's presentation; the occupant decides it. @param track - whether the normal width reserves a grid track. @param fullscreen - whether the panel covers the frame. */
  openRightbar(track: boolean, fullscreen: boolean): void
  /** Report the right panel as hidden: no track, no resize handle. */
  closeRightbar(): void
}

/** Resolved widths for one desktop frame. */
export interface DesktopLayoutColumns {
  /** Rendered sidebar width. */
  sidebar: number
  /** Rendered center width. */
  center: number
  /** Rendered right column track; zero when the center keeps the space. */
  rightbar: number
}

/** Compact sidebar rail on Windows and Linux. */
export const SIDEBAR_COLLAPSED = 56
/** Wider compact rail reserved for the macOS sidebar, clear of the traffic lights. */
export const MACOS_SIDEBAR_COLLAPSED = 90
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264
/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420
/** Viewport width below which the sidebar auto-collapses to the rail. */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/** Right column drag clamp floor. */
export const RIGHTBAR_MIN = 300
/** Maximum normal right panel width as a fraction of the frame. */
export const RIGHTBAR_MAX_RATIO = 0.7
/** First-open right panel preference as a fraction of the frame. */
export const RIGHTBAR_DEFAULT_RATIO = 0.45
/** Center width protected while the normal right column is open. */
export const CENTER_MIN = 400

/**
 * Clamp a panel width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * Solve the three desktop columns for one frame box: the right column shrinks,
 * then loses its track, before the center drops below its minimum; the sidebar
 * never concedes here, so callers pass its effective preference after the
 * responsive collapse.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param rightbar - requested right panel width in px (0 = no track).
 * @param collapsedWidth - rail width the platform gives a closed sidebar.
 * @returns rendered column widths.
 */
export function computeDesktopColumns(
  viewport: number,
  sidebar: number,
  rightbar: number,
  collapsedWidth: number = SIDEBAR_COLLAPSED,
): DesktopLayoutColumns {
  const sidebarWidth = sidebar === 0 ? collapsedWidth : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const available = viewport - sidebarWidth - CENTER_MIN
  const rightbarWidth = rightbar === 0 || available < RIGHTBAR_MIN
    ? 0
    : Math.min(available, clampWidth(rightbar, RIGHTBAR_MIN, viewport * RIGHTBAR_MAX_RATIO))
  return {
    sidebar: sidebarWidth,
    center: Math.max(0, viewport - sidebarWidth - rightbarWidth),
    rightbar: rightbarWidth,
  }
}

/** Panel facts of one advanced desktop frame, shared by the frame and ctx.layout. */
export class DesktopLayoutState {
  private snapshot: DesktopLayoutSnapshot
  private readonly listeners = new Set<() => void>()

  /** @param viewportWidth - frame width bootstrap before the first measurement. */
  constructor(viewportWidth: number) {
    const panelInfo: PanelInfo = Object.freeze({ activePanelId: null })
    this.snapshot = Object.freeze({
      panelInfo,
      layoutInfo: Object.freeze({
        sidebar: SIDEBAR_DEFAULT,
        viewportWidth,
        narrowExpanded: false,
        rightbar: null,
        rightbarShown: false,
        rightbarTrack: false,
        rightbarFullscreen: false,
      }),
    })
  }

  /** @returns the immutable current facts. */
  getSnapshot(): DesktopLayoutSnapshot {
    return this.snapshot
  }

  /** @param listener - callback notified after a snapshot replacement. @returns its disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** @param panelId - registered main key, or null for the Conversation. */
  selectPanel(panelId: MainPanelId | null): void {
    this.publish({ ...this.snapshot, panelInfo: Object.freeze({ activePanelId: panelId }) })
  }

  /** @param panelIds - main keys that still have a live registration. */
  retainMainPanels(panelIds: readonly string[]): void {
    const current = this.snapshot.panelInfo.activePanelId
    if (current === null || panelIds.includes(current)) return
    this.selectPanel(null)
  }

  /** @param px - requested sidebar width from a resize gesture. */
  setSidebar(px: number): void {
    this.write({ sidebar: clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX) })
  }

  /** Toggle the wide sidebar, or the narrow frame's rail override. */
  toggleSidebar(): void {
    const layoutInfo = this.snapshot.layoutInfo
    if (layoutInfo.viewportWidth < SIDEBAR_AUTO_COLLAPSE) {
      this.write({ narrowExpanded: !layoutInfo.narrowExpanded })
      return
    }
    this.write({ sidebar: layoutInfo.sidebar === 0 ? SIDEBAR_DEFAULT : 0 })
  }

  /** @param width - latest positive frame measurement. */
  setViewportWidth(width: number): void {
    const layoutInfo = this.snapshot.layoutInfo
    if (layoutInfo.viewportWidth === width) return
    // Crossing the auto-collapse breakpoint in either direction drops the
    // narrow override: the narrow default is collapsed, the wide state is the
    // stored preference.
    const crossed = (layoutInfo.viewportWidth < SIDEBAR_AUTO_COLLAPSE) !== (width < SIDEBAR_AUTO_COLLAPSE)
    this.write({ viewportWidth: width, ...crossed ? { narrowExpanded: false } : {} })
  }

  /** @param px - requested right panel width from a resize gesture. */
  setRightbar(px: number): void {
    const max = Math.max(RIGHTBAR_MIN, this.snapshot.layoutInfo.viewportWidth * RIGHTBAR_MAX_RATIO)
    this.write({ rightbar: clampWidth(px, RIGHTBAR_MIN, max) })
  }

  /** @param track - whether the normal panel width reserves a grid track. @param fullscreen - whether the occupant covers the frame. */
  openRightbar(track: boolean, fullscreen: boolean): void {
    const layoutInfo = this.snapshot.layoutInfo
    this.write({
      rightbarShown: true,
      rightbarTrack: track,
      rightbarFullscreen: fullscreen,
      // The first opening remembers its default so later resizes and closes
      // keep the width the user last saw.
      ...layoutInfo.rightbar === null
        ? { rightbar: Math.max(RIGHTBAR_MIN, Math.round(layoutInfo.viewportWidth * RIGHTBAR_DEFAULT_RATIO)) }
        : {},
      ...!layoutInfo.rightbarShown && layoutInfo.viewportWidth < SIDEBAR_AUTO_COLLAPSE ? { narrowExpanded: false } : {},
    })
  }

  /** Report the right column as hidden: no track, no resize handle. */
  closeRightbar(): void {
    this.write({ rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false })
  }

  private write(patch: Partial<DesktopLayoutSnapshot['layoutInfo']>): void {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      layoutInfo: Object.freeze({ ...this.snapshot.layoutInfo, ...patch }),
    })
    for (const listener of this.listeners) listener()
  }

  private publish(next: DesktopLayoutSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

/**
 * Bind the write set to one state instance; the frame and ctx.layout share this
 * object so both faces reach the same owner.
 * @param state - desktop layout facts.
 * @returns the bound action set.
 */
export function desktopLayoutActions(state: DesktopLayoutState): DesktopLayoutActions {
  return {
    selectPanel: panelId => { state.selectPanel(panelId) },
    retainMainPanels: panelIds => { state.retainMainPanels(panelIds) },
    setSidebar: px => { state.setSidebar(px) },
    toggleSidebar: () => { state.toggleSidebar() },
    setViewportWidth: width => { state.setViewportWidth(width) },
    setRightbar: px => { state.setRightbar(px) },
    openRightbar: (track, fullscreen) => { state.openRightbar(track, fullscreen) },
    closeRightbar: () => { state.closeRightbar() },
  }
}

/**
 * Bare observable the frame reads through the injected useLayout selector hook.
 * @param state - desktop layout facts.
 * @returns the stable source (same reference until the facts move).
 */
export function desktopLayoutSource(state: DesktopLayoutState): HostObservable<DesktopLayoutSnapshot> {
  return { getSnapshot: () => state.getSnapshot(), subscribe: listener => state.subscribe(listener) }
}

/**
 * Bare observable published as the root PanelInfo seat (the usePanelInfo
 * standard hook), the same channel the native frame reads the selected main
 * key from.
 * @param state - desktop layout facts.
 * @returns the stable source (same reference until the selection moves).
 */
export function desktopPanelInfoSource(state: DesktopLayoutState): HostObservable<PanelInfo> {
  return { getSnapshot: () => state.getSnapshot().panelInfo, subscribe: listener => state.subscribe(listener) }
}
