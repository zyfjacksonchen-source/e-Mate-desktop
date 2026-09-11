/**
 * The desktop's ctx.layout face: the pinned native contract (ILayout from
 * '@deepseek-ai/dsh-client-ui-layout/client') implemented over the desktop's one
 * layout state.
 *
 * The native owner row (ui-layout) is disabled for the desktop advanced profile
 * (src/profile.ts), because this frame replaces its AppFrame, and ui-sidebar and
 * ui-sidebar-right inject 'layout' (their fibers wait for the service) while
 * ui-workspace calls it for navigation. A desktop boot therefore needs exactly
 * one provider of that name: this controller, holding the native interface and
 * writing through the same bound action set the frame reads. Neither the native
 * controller class nor its store is reachable from this bundle, so the face is
 * re-bound to the contract instead of to a desktop-invented one.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ILayout, MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { DesktopLayoutActions } from './layout-state.ts'

/** Cross-plugin panel-action face behind ctx.layout. */
export class DesktopLayoutController implements ILayout {
  private navigation = new AbortController()

  /**
   * @param panels - the desktop layout state's bound write set.
   * @param hasMainPanel - checks the live main-slot registry for a panel id.
   */
  constructor(
    private readonly panels: DesktopLayoutActions,
    private readonly hasMainPanel: (id: MainPanelId) => boolean,
  ) {}

  /**
   * Select a global panel or return to the Conversation.
   * @param panelId - registered main key, or null for the Conversation.
   * @throws when the key is not registered; the current selection survives.
   */
  selectPanel(panelId: MainPanelId | null): void {
    if (panelId !== null && !this.hasMainPanel(panelId)) {
      throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
    }
    this.navigation.abort()
    this.panels.selectPanel(panelId)
  }

  /** @returns the new pending navigation's cancellation signal. */
  beginNavigation(): AbortSignal {
    this.navigation.abort()
    this.navigation = new AbortController()
    return this.navigation.signal
  }

  /** Invalidate pending navigations when the layout owner is unloaded. */
  dispose(): void {
    this.navigation.abort()
  }

  /** Toggle the sidebar between the wide preference and the compact rail. */
  toggleSidebar(): void {
    this.panels.toggleSidebar()
  }

  /** @param track - whether the normal panel width reserves a grid track. @param fullscreen - whether the occupant covers the frame. */
  openRightbar(track: boolean, fullscreen: boolean): void {
    this.panels.openRightbar(track, fullscreen)
  }

  /** Report the right column as hidden: no track, no resize handle. */
  closeRightbar(): void {
    this.panels.closeRightbar()
  }
}

/**
 * Provide the advanced layout service for one plugin-fiber lifetime.
 * @param ctx - active browser Cordis context.
 * @param layout - the desktop's ILayout implementation.
 * @returns disposer for the service registration.
 */
export function provideDesktopLayout(ctx: ClientContext, layout: ILayout): () => void {
  const dispose = ctx.reflect.provide('layout', layout)
  return () => { void dispose() }
}
