/** e-Mate Host plugin: owns the selected native shell generation. */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  THEME_SETTINGS_NAMESPACE,
  type ThemeSettings,
} from '@deepseek-ai/dsh-client-ui-theme'
import {
  handleRendererBootRequest,
  RENDERER_BOOT_REPORT_PATH,
} from './renderer-boot.ts'
import type { DesktopShellMode } from './runtime.ts'
import type {} from './runtime.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-shell'

/** Services required before the shell can register its renderer generation. */
/** Services required by the desktop shell; `desktopRuntime` is probed, not required. */
export const inject = ['webServer', 'webRuntime', 'appExit', 'settings', 'workspaceRegistry', 'sessions', 'connection']

/** Standard settings namespace shared by tray and configuration surfaces. */
export const DESKTOP_SETTINGS_NAMESPACE = 'dsh-desktop'

const UI_THEME_SETTINGS_NAMESPACE = THEME_SETTINGS_NAMESPACE

/** Desktop settings presented by the standard settings service. */
export interface DesktopSettings {
  /** Native presentation selected for the next application generation. */
  mode: DesktopShellMode
}

/** Schema registered with the standard settings service. */
export const DesktopSettingsSchema: z<DesktopSettings> = z.object({
  mode: z.union(['compatibility', 'advanced'] as const).default('advanced'),
})

/** Native window configuration. */
export interface Config {
  /** Native presentation mode selected before BrowserWindow construction. */
  mode: DesktopShellMode
  /** Initial window width in CSS pixels. */
  width: number
  /** Initial window height in CSS pixels. */
  height: number
  /** Minimum window width in CSS pixels. */
  minWidth: number
  /** Minimum window height in CSS pixels. */
  minHeight: number
}

/** Validated native window configuration. */
export const Config: z<Config> = z.object({
  mode: z.union(['compatibility', 'advanced'] as const).default('advanced'),
  width: z.number().step(1).min(800).default(1280),
  height: z.number().step(1).min(600).default(840),
  minWidth: z.number().step(1).min(640).default(900),
  minHeight: z.number().step(1).min(480).default(640),
})

/**
 * Construct the unmodified upstream Web root URL.
 * @param port - active loopback Web server port.
 * @param mode - active native presentation mode.
 * @param platform - active Electron platform.
 * @returns the URL loaded by the BrowserWindow.
 */
export function desktopRendererUrl(
  port: number,
  mode: DesktopShellMode,
  platform: Context['desktopRuntime']['platform'],
): string {
  const url = new URL(`http://127.0.0.1:${String(port)}/`)
  url.searchParams.set('dsh-desktop-mode', mode)
  url.searchParams.set('dsh-desktop-platform', platform)
  return url.href
}

/**
 * Resolve the renderer window URL together with the process-token URL that
 * authenticates its session before that URL is loaded.
 * @param ctx - Host context carrying the Web carrier and the Connection owner.
 * @param config - validated native window values.
 * @param runtime - active Electron adapter values.
 * @returns the marker-bearing Web root and the token URL to exchange first.
 */
function rendererAuthentication(
  ctx: Context,
  config: Config,
  runtime: Context['desktopRuntime'],
): { url: string; authenticationUrl?: string } {
  const url = desktopRendererUrl(ctx.webServer.port, config.mode, runtime.platform)
  // A context without Connection (hand-built plugin harness) holds no process
  // token; the profile boot gate proves the shipped composition always has one.
  const authenticationUrl = ctx.get('connection')?.authenticatedUrl(new URL(url).origin)
  return authenticationUrl === undefined ? { url } : { url, authenticationUrl }
}

/**
 * Register the Electron shell from active Web carrier values.
 * @param ctx - Host context carrying the Electron adapter and Web carrier.
 * @param config - validated native window values.
 */
export function apply(ctx: Context, config: Config): void {
  const runtime = ctx.get('desktopRuntime')
  if (runtime === undefined) {
    process.stderr.write(
      '@e-mate/desktop: this profile is composed with the e-Mate shell, which requires the desktop launcher (desktopRuntime).\n'
      + 'Start it with `dsh-desktop`, or select this profile inside the packaged e-Mate application.\n'
      + 'The desktop terminal, profile, and update rows stay inactive in an ordinary DSH boot.\n',
    )
    return
  }
  let active = true
  ctx.effect(() => () => { active = false }, '@e-mate/desktop: completion notification lifetime')
  ctx.on('session/event', (session, event) => {
    if (!active || event.type !== 'turn/end' || event.data.reason.kind !== 'completed'
      || session.header.origin === 'subagent') return
    try {
      const goals = ctx.get('goals')
      if (goals !== undefined) {
        const agent = ctx.get('agents')?.get(session.id)
        if (agent === undefined || agent.session !== session) return
        const goal = goals.get(agent)
        if (goal !== undefined && goal.phase !== 'complete') return
      }
      runtime.updates.notify({
        title: '任务已完成',
        body: '任务已成功完成，点击查看结果。',
        sessionId: session.id,
        isCurrent: () => active,
      })
    } catch {
      // Notification failures must never interfere with the completed native turn.
      process.stderr.write('@e-mate/desktop: task completion notification unavailable\n')
    }
  })
  const appExit = ctx.get('appExit')
  if (appExit === undefined) {
    throw new Error('@e-mate/desktop: the launcher did not provide ctx.appExit')
  }
  const workspaceRegistry = ctx.get('workspaceRegistry') as { list(): readonly { path: string }[] } | undefined
  if (workspaceRegistry === undefined) {
    throw new Error('@e-mate/desktop: the profile did not provide ctx.workspaceRegistry')
  }
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error('@e-mate/desktop: desktop shell requires a loopback Web server')
  }
  const iconFilename = runtime.platform === 'darwin'
    ? 'app-icon-mac.png'
    : 'app-icon.png'
  const iconPath = fileURLToPath(new URL(`../build/${iconFilename}`, import.meta.url))
  const trayIcons = {
    templatePath: fileURLToPath(new URL('../build/tray-iconTemplate.png', import.meta.url)),
    bluePath: fileURLToPath(new URL('../build/tray-icon-blue.png', import.meta.url)),
  }
  const rendererOrigin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: RENDERER_BOOT_REPORT_PATH,
      handler: (req, res) => handleRendererBootRequest(
        req,
        res,
        rendererOrigin,
        report => { runtime.reportRendererBoot(report) },
      ),
    }),
    '@e-mate/desktop: renderer boot report route',
  )
  ctx.on('settings/updated', (namespace, next) => {
    if (namespace !== UI_THEME_SETTINGS_NAMESPACE) return
    runtime.setThemeSource((next as ThemeSettings).preference)
  })
  ctx.effect(
    () => {
      const { url, authenticationUrl } = rendererAuthentication(ctx, config, runtime)
      return runtime.schedule({
        ...config,
        url,
        // The Web root is browser-authenticated: the Electron adapter exchanges
        // this process-token URL inside the BrowserWindow session before loading
        // the marker URL above, which otherwise answers HTTP 401.
        ...(authenticationUrl === undefined ? {} : { authenticationUrl }),
        productName: 'e-Mate',
        windowTitle: 'e-Mate',
        iconPath,
        trayIcons,
        readThemeSource: () => {
          const theme = ctx.settings.get(UI_THEME_SETTINGS_NAMESPACE) as ThemeSettings | undefined
          if (theme === undefined) {
            throw new Error('@e-mate/desktop: shell requires the ui-theme settings namespace')
          }
          return theme.preference
        },
        resourceRoots: () => workspaceRegistry.list().map(workspace => workspace.path),
        resourceSessionRoot: sessionId => ctx.sessions.get(sessionId as SessionId)?.header.cwd,
        requestQuit: appExit,
        requestModeChange: async () => {
          throw new Error(`@e-mate/desktop: shell mode is fixed to ${config.mode}`)
        },
      })
    },
    '@e-mate/desktop: native shell generation',
  )
}
