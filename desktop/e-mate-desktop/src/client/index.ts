import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type convergence only: locale/theme declarations expose settings slot rows.
// The desktop client does not load or register a settings surface.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { applyAdvancedShell } from './advanced-shell.ts'
import {
  DESKTOP_BOOTSTRAP_BRIDGE,
  DESKTOP_NOTIFICATION_BRIDGE, type DesktopNotificationBridge,
  type DesktopBootstrapWindow,
} from '../desktop-bootstrap-contract.ts'
import { startRendererBootReporter } from './boot-health.ts'
import { parseDesktopClientEnvironment } from './environment.ts'
import { installResourceContext } from './resource-context.ts'
import { installWorkspaceFolderDrop } from './workspace-folder-drop.ts'

export { applyAdvancedShell } from './advanced-shell.ts'
export {
  RENDERER_BOOT_REPORT_PATH,
  rendererBootReport,
  sendRendererBootReport,
  startRendererBootReporter,
} from './boot-health.ts'
export type { RendererBootLoader, RendererBootReport } from './boot-health.ts'
export { parseDesktopClientEnvironment } from './environment.ts'
export type { DesktopClientEnvironment, DesktopClientMode, DesktopClientPlatform } from './environment.ts'

/** Services required by advanced presentation. */
export const inject = [
  'slots',
  'sessions',
  'theme',
  'workspaces',
]

/** Register desktop-owned client surfaces for the current BrowserWindow mode. @param ctx - browser Cordis context. */
export function apply(ctx: ClientContext): void {
  const bootstrap = (window as Window & DesktopBootstrapWindow)[DESKTOP_BOOTSTRAP_BRIDGE]
  const environment = parseDesktopClientEnvironment(window.location.search, window.sessionStorage, bootstrap)
  ctx.effect(
    () => startRendererBootReporter(ctx.loader),
    '@e-mate/desktop: renderer boot health report',
  )
  const notifications = (window as unknown as Record<string, DesktopNotificationBridge | undefined>)[DESKTOP_NOTIFICATION_BRIDGE]
  if (notifications !== undefined) ctx.effect(
    () => installNotificationNavigation(ctx.sessions, notifications),
    '@e-mate/desktop: notification navigation',
  )
  ctx.effect(() => installResourceContext(ctx.sessions), '@e-mate/desktop: resource context')
  ctx.effect(
    () => installWorkspaceFolderDrop({
      create: input => ctx.workspaces.create(input),
      startSession: workspaceId => { ctx.workspaces.startSession(workspaceId) },
    }),
    '@e-mate/desktop: workspace folder drop',
  )
  if (environment.mode === 'advanced') applyAdvancedShell(ctx, environment)
}

/** Consume a clicked notification only once the native session catalog is ready. */
export function installNotificationNavigation(
  sessions: Pick<ClientContext['sessions'], 'list' | 'open'>,
  bridge: DesktopNotificationBridge,
): () => void {
  let pending: string | undefined
  const open = (): void => {
    if (pending === undefined) return
    const state = sessions.list.getSnapshot()
    if (state.phase !== 'ready') return
    const id = pending
    pending = undefined
    if (Object.hasOwn(state.byId, id)) {
      try { sessions.open(id as Parameters<typeof sessions.open>[0]) } catch { /* Deleted during selection: keep current view. */ }
    }
  }
  const unsubscribeList = sessions.list.subscribe(open)
  const unsubscribeBridge = bridge.subscribe(id => { pending = id; open() })
  return () => { pending = undefined; unsubscribeBridge(); unsubscribeList() }
}
