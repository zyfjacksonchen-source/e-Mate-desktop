import { createElement, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ASSET_PATH, EDITOR_MODULE } from '../contract.ts'
import { createBridge, type CanvasClientService, type CanvasOpenOptions } from './bridge.ts'
export type { CanvasClientService, CanvasOpenOptions } from './bridge.ts'
export const inject = ['slots', 'modules', 'sessions', 'connection', 'conversation']
export const CANVAS_VIEW = 'e-mate-canvas'

/** A normal native conversation view. Editor code and media stay lazy. */
export function apply(ctx: any): void {
  let loading: Promise<any> | undefined
  let generation = 0
  let activeSession: string | undefined
  let pendingSession: string | undefined
  const consumedRequests = new WeakSet<object>()
  let leave: (() => Promise<void>) | undefined
  const actionsBySession = new Map<string, { setView(view: string): void }>()
  const requests = new Map<string, { projectId: string; asset?: any; revision: number }>()
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  const initial: { projectId: string; asset?: any; revision: number } = { projectId: 'main', revision: 0 }
  const load = () => {
    loading ??= (async () => {
      await import(/* @vite-ignore */ new URL(ASSET_PATH + 'editor.js', location.origin).href)
      return await ctx.modules.import(EDITOR_MODULE)
    })().catch(error => { loading = undefined; throw error })
    return loading
  }
  const service: CanvasClientService = {
    activeSessionId: () => activeSession ?? pendingSession,
    async beforeNavigate() { await service.leave() },
    async leave() { await leave?.(); generation += 1; pendingSession = undefined },
    async open(sessionId: string, options: CanvasOpenOptions = {}) {
      const current = ++generation
      pendingSession = sessionId
      try {
        const isCurrent = () => current === generation && ctx.sessions.list.getSnapshot().current === sessionId
        if (!isCurrent()) return
        await leave?.()
        if (!isCurrent()) return
        if (!ctx.sessions.binding(sessionId)?.session) throw new Error('当前会话不可用。')
        const bridge = createBridge(ctx, sessionId, () => {}, () => () => {})
        const asset = options.attachment ? await bridge.call('resolve-image', {
          owner_session_id: options.attachment.ownerSessionId, attachment_id: options.attachment.attachmentId,
        }) : undefined
        if (!isCurrent()) return
        const actions = actionsBySession.get(sessionId)
        if (!actions) throw new Error('画布页面尚未就绪，请稍后重试。')
        requests.set(sessionId, { projectId: options.projectId ?? 'main', asset, revision: current })
        notify()
        actions.setView(CANVAS_VIEW)
      } finally { if (current === generation) pendingSession = undefined }
    },
    insertAttachment(sessionId, ownerSessionId, attachmentId) { return service.open(sessionId, { attachment: { ownerSessionId, attachmentId } }) },
  }
  function CanvasPage({ sessionId, actions }: { sessionId: string; actions: { setView(view: string): void } }) {
    const request = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => requests.get(sessionId) ?? initial)
    const asset = useMemo(() => consumedRequests.has(request) ? undefined : request.asset, [request])
    const [editor, setEditor] = useState<any>()
    const [error, setError] = useState('')
    const [bridge] = useState(() => createBridge(ctx, sessionId,
      () => { void service.leave().then(() => actions.setView('chat')).catch((error: Error) => setError(error.message)) },
      handler => {
        leave = handler; activeSession = sessionId
        return () => { if (leave === handler) { leave = undefined; activeSession = undefined } }
      }))
    useEffect(() => {
      let alive = true
      actionsBySession.set(sessionId, actions)
      void load().then(value => { if (alive) setEditor(value) }).catch((error: Error) => { if (alive) setError(error.message) })
      return () => { alive = false }
    }, [sessionId, actions])
    if (error) return createElement('div', { role: 'alert' }, error)
    if (!editor) return createElement('div', { role: 'status' }, '正在打开画布…')
    return createElement(editor.CanvasPanel, { sessionId, bridge, initialProjectId: request.projectId, initialAsset: asset, onInitialAssetConsumed: () => consumedRequests.add(request) })
  }
  ctx.effect(() => {
    const dispose = ctx.reflect.provide('emateCanvas', service)
    return () => { generation += 1; listeners.clear(); actionsBySession.clear(); void dispose() }
  }, 'emate.canvas: lazy native page service')
  ctx.slots.inject('conversation.view', () => {
    // Reuse the native header/body store handle, never create a parallel view state.
    const store = ctx.slots.entries('conversation.session').find((entry: any) => entry.store)?.store
    if (!store) throw new Error('画布缺少原生会话视图状态。')
    ctx.slots.register({ name: 'conversation.view', id: CANVAS_VIEW, order: 19, label: '画布', store }, (props: any) => createElement(CanvasPage, { ...props, key: props.sessionId }))
    // The resident native header supplies its scope-bound actions even when
    // another tab is visible. This controller has no button or visual surface.
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
      name: 'conversation.session.header.utilities', id: 'e-mate-canvas-navigation', store,
      inject: (sessionId: string, actions: { setView(view: string): void }) => { actionsBySession.set(sessionId, actions); return {} },
    }, () => null))
  })
}
