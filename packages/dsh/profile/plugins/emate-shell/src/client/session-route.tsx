import { useEffect, useRef } from 'react'
import { IDENTITY_CHANGED_EVENT } from './identity.tsx'

interface SessionListState {
  phase: 'pending' | 'ready'
  current?: string
  byId: Record<string, { blank?: boolean }>
}

interface WorkspaceListState {
  baselinesReady: boolean
}

interface Props {
  useSessions: <T>(selector: (state: SessionListState) => T) => T
  useWorkspaces: <T>(selector: (state: WorkspaceListState) => T) => T
  getSessions: () => SessionListState
  openSession: (id: string) => void
  beforeNavigate?: () => Promise<void> | undefined
  onNavigationError?: () => void
}

type PendingRoute = string | null

function chatId(pathname: string): string | null {
  const match = /^\/chat\/([^/]+)$/u.exec(pathname)
  if (match === null) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return null
  }
}

export function SessionRouteProjection({
  useSessions,
  useWorkspaces,
  getSessions,
  openSession,
  beforeNavigate,
  onNavigationError,
}: Props) {
  const phase = useSessions(state => state.phase)
  const current = useSessions(state => state.current)
  const workspacesReady = useWorkspaces(state => state.baselinesReady)
  const initialized = useRef(false)
  const pending = useRef<PendingRoute>(null)

  const applyLocation = () => {
    const state = getSessions()
    if (state.phase !== 'ready' || !workspacesReady) return
    if (location.pathname === '/') {
      pending.current = null
      if (state.current !== undefined && Object.prototype.hasOwnProperty.call(state.byId, state.current)) {
        history.replaceState(null, '', `/chat/${encodeURIComponent(state.current)}`)
      }
      return
    }
    if (!location.pathname.startsWith('/chat')) return
    const id = chatId(location.pathname)
    if (id === null || !Object.prototype.hasOwnProperty.call(state.byId, id)) {
      const fallback = state.current === undefined || !Object.prototype.hasOwnProperty.call(state.byId, state.current)
        ? '/'
        : `/chat/${encodeURIComponent(state.current)}`
      history.replaceState(null, '', fallback)
      pending.current = null
      return
    }
    pending.current = state.current === id ? null : id
    if (state.current !== id) openSession(id)
  }

  useEffect(() => {
    const onPopState = () => { applyLocation() }
    addEventListener('popstate', onPopState)
    return () => { removeEventListener('popstate', onPopState) }
  }, [getSessions, openSession, workspacesReady])

  useEffect(() => {
    if (phase !== 'ready' || !workspacesReady) return
    if (!initialized.current) {
      initialized.current = true
      applyLocation()
    }
    if (pending.current !== null) {
      if (pending.current === current) {
        pending.current = null
      } else {
        return
      }
    }
    const path = current === undefined ? '/' : `/chat/${encodeURIComponent(current)}`
    if (['/capabilities', '/settings', '/schedules', '/knowledge'].includes(location.pathname)) return
    if (!['/', '/chat'].some(prefix => location.pathname === prefix || location.pathname.startsWith(`${prefix}/`))) return
    if (location.pathname !== path) {
      history.pushState(null, '', path)
      dispatchEvent(new PopStateEvent('popstate'))
    }
  }, [current, phase, workspacesReady])

  useEffect(() => {
    const indexKey = 'eMateRouteIndex'
    let accepted = { url: `${location.pathname}${location.search}${location.hash}`, state: { ...history.state, [indexKey]: history.state?.[indexKey] ?? 0 } }
    history.replaceState(accepted.state, '', accepted.url)
    let generation = 0
    let replaying = false
    let restoring = false
    const identityChanged = () => { generation++; replaying = false; restoring = false; pending.current = null }
    const guard = (event: PopStateEvent) => {
      const url = `${location.pathname}${location.search}${location.hash}`
      // Authentication wins even over a pending history-cursor restoration.
      if (['/login', '/register', '/agreement'].includes(location.pathname)) {
        generation++; restoring = false; replaying = false; pending.current = null
        accepted = { url, state: { ...history.state, [indexKey]: Number.isInteger(history.state?.[indexKey]) ? history.state[indexKey] : accepted.state[indexKey] ?? 0 } }
        history.replaceState(accepted.state, '', accepted.url)
        return
      }
      if (restoring) { restoring = false; event.stopImmediatePropagation(); return }
      const target = { url, state: { ...history.state, [indexKey]: Number.isInteger(history.state?.[indexKey]) ? history.state[indexKey] : event.isTrusted ? null : (accepted.state[indexKey] ?? 0) + 1 } }
      const request = ++generation
      // Identity routing must never wait on an ordinary workspace save. A
      // locked workspace cannot replay an old settings/chat destination.
      if (document.querySelector('[data-emate-identity-gate]')) {
        event.stopImmediatePropagation()
        history.replaceState(accepted.state, '', accepted.url)
        return
      }
      if (replaying || target.url === accepted.url) {
        accepted = target
        history.replaceState(target.state, '', target.url)
        return
      }
      const saving = beforeNavigate?.()
      if (!saving) {
        accepted = target
        history.replaceState(target.state, '', target.url)
        return
      }
      event.stopImmediatePropagation()
      const previous = accepted
      history.replaceState(previous.state, '', previous.url)
      void saving.then(() => {
        if (request !== generation || document.querySelector('[data-emate-identity-gate]')) return
        history.replaceState(target.state, '', target.url)
        replaying = true
        dispatchEvent(new PopStateEvent('popstate', { state: target.state }))
        replaying = false
      }).catch(() => {
        if (request !== generation) return
        // A real Back/Forward changes the history cursor. Return to the prior
        // entry while retaining the rejected destination for a later retry.
        const delta = previous.state[indexKey] - target.state[indexKey]
        if (event.isTrusted && Number.isInteger(previous.state[indexKey]) && Number.isInteger(target.state[indexKey]) && delta !== 0) {
          history.replaceState(target.state, '', target.url)
          restoring = true
          history.go(delta)
        }
        onNavigationError?.()
      })
    }
    addEventListener('popstate', guard, true)
    addEventListener(IDENTITY_CHANGED_EVENT, identityChanged)
    return () => { generation++; removeEventListener('popstate', guard, true); removeEventListener(IDENTITY_CHANGED_EVENT, identityChanged) }
  }, [beforeNavigate, onNavigationError])

  return null
}
