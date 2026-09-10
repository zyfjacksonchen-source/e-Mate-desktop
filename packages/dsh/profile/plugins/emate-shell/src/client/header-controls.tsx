import { useState, useSyncExternalStore, type ComponentType } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { DesktopUpdateTriggerBridge } from '../../../../../../../desktop/e-mate-desktop/src/desktop-update-trigger-contract.ts'
import { SessionShareAction, type SessionShareActionProps } from './session-share.tsx'
import { collectInternalSubagentIds, highlightedProductSessionId, isTopLevelProductSession } from './session-visibility.ts'
import css from './header-controls.module.css'

type Icon = ComponentType<{ size?: number }>

interface Props extends Omit<SessionShareActionProps, 'sessionId'> {
  useSessions: <T>(selector: (state: SessionListState) => T) => T
  getThemeScheme: () => 'light' | 'dark'
  subscribeTheme: (listener: () => void) => () => void
  toggleTheme: () => void
  LightIcon: Icon
  DarkIcon: Icon
}

export function UpdateControl({
  updates,
  UpdateIcon,
  compact = true,
}: {
  updates: DesktopUpdateTriggerBridge
  UpdateIcon: Icon
  compact?: boolean
}) {
  const [requesting, setRequesting] = useState(false)
  const [error, setError] = useState('')
  const label = requesting ? '检查中' : '检查更新'

  return <>
    <button
      type="button"
      className={`${css.updateControl} ${compact ? '' : css.updateWide}`}
      title={label}
      aria-label={label}
      aria-busy={requesting || undefined}
      disabled={requesting}
      onClick={() => {
        setError('')
        setRequesting(true)
        void updates.runInteractiveUpdate().catch(reason => {
          setError(reason instanceof Error ? reason.message : '暂时无法检查更新。')
        }).finally(() => { setRequesting(false) })
      }}
    >
      <UpdateIcon size={18} />
      {!compact && <span>{label}</span>}
    </button>
    {error !== '' && <span className={css.updateError} role="alert">{error}</span>}
  </>
}

const routeSubscribe = (listener: () => void): (() => void) => {
  addEventListener('popstate', listener)
  return () => { removeEventListener('popstate', listener) }
}
const routeSnapshot = (): string => location.pathname

/** e-Mate utilities projected once over DSH's complete root frame. */
export function HeaderControls({
  useSessions,
  getThemeScheme,
  subscribeTheme,
  toggleTheme,
  callShare,
  useSessionLogDownload,
  requestDownload,
  dismissDownload,
  LightIcon,
  DarkIcon,
}: Props) {
  const themeScheme = useSyncExternalStore(subscribeTheme, getThemeScheme, getThemeScheme)
  const pathname = useSyncExternalStore(routeSubscribe, routeSnapshot, routeSnapshot)
  const currentSessionId = useSessions(state => state.current)
  const sessionId = useSessions(state => {
    const candidate = highlightedProductSessionId(state)
    if (candidate === undefined || candidate !== currentSessionId
      || pathname !== `/chat/${encodeURIComponent(candidate)}`) return undefined
    const row = state.byId[candidate]
    return row !== undefined && !row.blank
      && isTopLevelProductSession(row, collectInternalSubagentIds(state)) ? candidate : undefined
  })
  const ThemeIcon = themeScheme === 'dark' ? DarkIcon : LightIcon

  return (
    <div
      className={css.controls}
      aria-label={pathname === '/settings' ? undefined : '应用工具'}
      data-emate-header-controls=""
      data-emate-settings-route={pathname === '/settings' ? '' : undefined}
    >
      {sessionId !== undefined && <SessionShareAction
        sessionId={sessionId}
        callShare={callShare}
        useSessionLogDownload={useSessionLogDownload}
        requestDownload={requestDownload}
        dismissDownload={dismissDownload}
      />}
      <button type="button" title={themeScheme === 'dark' ? '切换到明亮模式' : '切换到暗色模式'} aria-label={themeScheme === 'dark' ? '切换到明亮模式' : '切换到暗色模式'} onClick={toggleTheme}>
        <ThemeIcon size={18} />
      </button>
    </div>
  )
}
