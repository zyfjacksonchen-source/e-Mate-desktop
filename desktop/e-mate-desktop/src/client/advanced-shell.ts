import type { Context as ClientContext } from '@deepseek-ai/cordis'
// The native client entries are what augment Context with slots/sessions and the
// composed props with the standard hooks; without them the desktop client
// program sees none of the 0.1.5 slot keys.
// ui-slots publishes its client types as the package's own entry.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from './contracts.ts'
import type { DesktopClientEnvironment } from './environment.ts'
import { AdvancedFrame } from './AdvancedFrame.tsx'
import {
  desktopLayoutActions, desktopLayoutSource, desktopPanelInfoSource, DesktopLayoutState,
} from './layout-state.ts'
import { DesktopLayoutController, provideDesktopLayout } from './layout-service.ts'
import { installAdvancedStyles } from './styles.ts'
import { DesktopThemePresenter } from './theme-presenter.ts'

/**
 * Provide the advanced layout service and own the desktop root slot.
 *
 * The root registration carries the native frame contract: the built-in 'root'
 * slot, its four ui-layout child slots (sidebar, main — keyed, so the
 * Conversation is one panel among the global ones — rightbar, and
 * shell.overlay), plus the desktop's own title-strip utilities seat. The
 * right column's track is the occupant's report through ctx.layout, never a
 * desktop decision.
 * @param ctx - active browser Cordis context.
 * @param environment - validated mode and platform marker.
 */
export function applyAdvancedShell(ctx: ClientContext, environment: DesktopClientEnvironment): void {
  if (environment.mode !== 'advanced') {
    throw new Error(`@e-mate/desktop: advanced shell received mode ${JSON.stringify(environment.mode)}`)
  }

  // One state instance behind both faces: ctx.layout writes through these bound
  // actions and the frame reads the same facts through the injected useLayout
  // hook and the root usePanelInfo hook.
  const layoutState = new DesktopLayoutState(window.innerWidth)
  const actions = desktopLayoutActions(layoutState)

  ctx.effect(() => {
    const controller = new DesktopLayoutController(actions, id =>
      ctx.slots.entries('main').some(entry => entry.options.key === id))
    const disposeService = provideDesktopLayout(ctx, controller)
    const disposePanelInfo = ctx.slots.provideRoot({ hooks: { panelInfo: desktopPanelInfoSource(layoutState) } })
    // Keep the selected main key valid as panel entries come and go.
    const retainMainPanels = (): void => {
      actions.retainMainPanels(ctx.slots.entries('main').flatMap(entry =>
        entry.options.key === undefined ? [] : [entry.options.key]))
    }
    const disposePanels = ctx.slots.subscribe('main', retainMainPanels)
    retainMainPanels()
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'main': { kind: 'keyed', scope: 'root' },
        'rightbar': { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
        'desktop.titlebar.utilities': { kind: 'list', scope: 'session-maybe' },
      },
      inject: () => ({
        platform: environment.platform,
        actions,
        hooks: { layout: desktopLayoutSource(layoutState) },
      }),
    }, AdvancedFrame)
    return () => {
      controller.dispose()
      disposeRegistration()
      disposePanels()
      disposePanelInfo()
      disposeService()
    }
  }, 'desktop: advanced root slot')

  ctx.effect(() => {
    document.body.dataset.dshDesktopMode = 'advanced'
    document.body.dataset.dshDesktopPlatform = environment.platform
    const removeStyles = installAdvancedStyles()
    return () => {
      removeStyles()
      delete document.body.dataset.dshDesktopMode
      delete document.body.dataset.dshDesktopPlatform
    }
  }, 'desktop: advanced shell styles')

  ctx.effect(() => {
    const presenter = new DesktopThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', snapshot => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'desktop: theme presenter')
}
