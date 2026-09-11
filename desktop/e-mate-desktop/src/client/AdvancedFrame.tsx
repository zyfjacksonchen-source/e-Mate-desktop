import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { HostObservable, InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only entry imports: the desktop client program binds the native root
// contract (the built-in 'root' slot, the frame's sidebar/main/rightbar/
// shell.overlay children, GlobalStandardProps.usePanelInfo) from these
// declarations, whose augmentations are not otherwise in this program.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from './contracts.ts'
import type { DesktopClientPlatform } from './environment.ts'
import type { DesktopLayoutActions, DesktopLayoutSnapshot } from './layout-state.ts'
import {
  computeDesktopColumns, MACOS_SIDEBAR_COLLAPSED, RIGHTBAR_DEFAULT_RATIO,
  SIDEBAR_AUTO_COLLAPSE, SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT,
} from './layout-state.ts'

/** Private values assembled by the advanced-shell registration. */
export interface AdvancedFrameInjected {
  /** Host platform controlling native title-bar spacing. */
  platform: DesktopClientPlatform
  /** Bound writes over the desktop layout facts; ctx.layout forwards the same set. */
  actions: DesktopLayoutActions
  /**
   * Bare observable in the inject hooks compartment, bound by the renderer to
   * the useLayout selector hook. The desktop's one layout owner publishes here
   * because the native store's factory is not reachable from this bundle
   * (layout-state.ts records why).
   */
  hooks: { layout: HostObservable<DesktopLayoutSnapshot> }
}

/**
 * Full advanced root slot props: runtime share, child render share, and the
 * injected face with its hooks compartment bound to the useLayout selector hook.
 */
export type AdvancedFrameProps = PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'main' | 'rightbar' | 'shell.overlay' | 'desktop.titlebar.utilities'>
  & InjectFace<AdvancedFrameInjected>

/**
 * Center column: subscribes to the selected main key without re-rendering the
 * frame for every panel change. The reserved 'conversation' key hosts the
 * Conversation; other keys render a global panel with no Session binding.
 */
function MainPanel({ usePanelInfo, renderSlot }: Pick<PropsRuntime<'root'>, 'usePanelInfo'> & PropsRenderSlots<'main'>) {
  const panelId = usePanelInfo(info => info.activePanelId)
  return renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })
}

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the
 * drag-start width. The base is the rendered width, so grabbing a
 * concession-clamped column cannot jump back to the stored preference.
 */
function ResizeHandle(props: {
  side: 'sidebar' | 'rightbar'
  left: number
  onStart: () => void
  onDrag: (dx: number) => void
  onEnd: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const capture = useRef<{ element: HTMLDivElement; id: number } | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const endDrag = useCallback(() => {
    const active = capture.current
    if (active === null) return
    capture.current = null
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])
  useEffect(() => endDrag, [endDrag])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || capture.current !== null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    capture.current = { element: event.currentTarget, id: event.pointerId }
    origin.current = event.clientX
    latest.current = event.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== event.pointerId) return
    latest.current = event.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== event.pointerId) return
    callbacks.current.onDrag(event.clientX - origin.current)
    endDrag()
  }, [endDrag])
  const onPointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id === event.pointerId) endDrag()
  }, [endDrag])

  return (
    <div
      className="dshDesktopResizeHandle"
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  )
}

/** Desktop-owned transparent frame around the unchanged product surfaces. */
export function AdvancedFrame({ platform, actions, useLayout, usePanelInfo, renderSlot }: AdvancedFrameProps) {
  const layoutInfo = useLayout(state => state.layoutInfo)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const viewport = layoutInfo.viewportWidth

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useLayoutEffect(() => {
    const element = frameRef.current
    if (element === null) return
    let frame: number | null = null
    let disposed = false
    const measure = (): void => {
      const width = element.getBoundingClientRect().width
      if (width > 0) actions.setViewportWidth(width)
    }
    measure()
    const observer = new ResizeObserver(() => {
      if (disposed) return
      frame ??= requestAnimationFrame(() => {
        frame = null
        measure()
      })
    })
    observer.observe(element)
    return () => {
      disposed = true
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [actions])

  const rail = platform === 'darwin' ? MACOS_SIDEBAR_COLLAPSED : SIDEBAR_COLLAPSED
  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0
  const sidebarPreference = sidebarCollapsed ? 0 : layoutInfo.sidebar === 0 ? SIDEBAR_DEFAULT : layoutInfo.sidebar
  const rightbarPreference = layoutInfo.rightbar ?? viewport * RIGHTBAR_DEFAULT_RATIO
  // Opening the right panel on a narrow frame collapses the left sidebar first,
  // so eligibility must include that space before the occupant's first report
  // arrives. Normal geometry is where the panel sits without a track; it is
  // also the width the occupant draws and the handle follows.
  const normal = computeDesktopColumns(viewport, !layoutInfo.rightbarShown && narrow ? 0 : sidebarPreference, rightbarPreference, rail)
  // The occupant's report decides whether the normal width reserves a grid
  // track (ctx.layout.openRightbar/closeRightbar); the frame never opens or
  // closes the right column on its own.
  const columns = computeDesktopColumns(viewport, sidebarPreference, layoutInfo.rightbarTrack ? rightbarPreference : 0, rail)
  const columnsRef = useRef(columns)
  columnsRef.current = columns
  const rightbarWidth = useRef(normal.rightbar)
  rightbarWidth.current = normal.rightbar

  // Track-level transitions pause for the whole gesture, so the column edge
  // stays under the pointer.
  const [dragging, setDragging] = useState(false)
  const sidebarBase = useRef(0)
  const rightbarBase = useRef(0)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = columnsRef.current.sidebar; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => { actions.setSidebar(sidebarBase.current + dx) }, [actions])
  const onRightbarStart = useCallback(() => { rightbarBase.current = rightbarWidth.current; setDragging(true) }, [])
  const onRightbarDrag = useCallback((dx: number) => { actions.setRightbar(rightbarBase.current - dx) }, [actions])

  const titlebarUtilities = useMemo(() => renderSlot('desktop.titlebar.utilities', {}), [renderSlot])
  const sidebar = useMemo(
    () => renderSlot('sidebar', { collapsed: sidebarCollapsed, width: columns.sidebar }),
    [renderSlot, sidebarCollapsed, columns.sidebar],
  )
  const main = useMemo(() => <MainPanel usePanelInfo={usePanelInfo} renderSlot={renderSlot} />, [usePanelInfo, renderSlot])
  const rightbar = useMemo(
    () => renderSlot('rightbar', { width: normal.rightbar, viewportWidth: viewport, canShow: normal.rightbar > 0 }),
    [renderSlot, normal.rightbar, viewport],
  )
  const overlays = useMemo(() => renderSlot('shell.overlay', {}), [renderSlot])

  return (
    <div
      ref={frameRef}
      className="dshDesktopFrame"
      data-desktop-platform={platform}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-dragging={dragging || undefined}
      style={{
        '--dsh-desktop-sidebar-width': `${columns.sidebar}px`,
        gridTemplateColumns: `${columns.sidebar}px minmax(0, 1fr) ${columns.rightbar}px`,
      } as CSSProperties}
    >
      {platform === 'darwin' && <div className="dshDesktopMacCaptionRow" aria-hidden="true" />}
      {platform === 'win32' && <div className="dshDesktopWindowsCaptionRow" aria-hidden="true" />}
      <div className="dshDesktopTitlebarUtilities" data-desktop-titlebar-utilities>
        {titlebarUtilities}
      </div>
      <aside className="dshDesktopSidebarSurface">
        <div className="dshDesktopUpstreamSidebar">{sidebar}</div>
      </aside>
      <main className="dshDesktopConversationSurface">{main}</main>
      <aside className="dshDesktopRightbarSurface">{rightbar}</aside>
      <div className="dshDesktopOverlay" data-shell-overlay>
        {overlays}
      </div>
      {!sidebarCollapsed && (
        <ResizeHandle
          side="sidebar"
          left={columns.sidebar}
          onStart={onSidebarStart}
          onDrag={onSidebarDrag}
          onEnd={onDragEnd}
        />
      )}
      {layoutInfo.rightbarShown && !layoutInfo.rightbarFullscreen && normal.rightbar > 0 && (
        <ResizeHandle
          side="rightbar"
          left={viewport - normal.rightbar}
          onStart={onRightbarStart}
          onDrag={onRightbarDrag}
          onEnd={onDragEnd}
        />
      )}
    </div>
  )
}
