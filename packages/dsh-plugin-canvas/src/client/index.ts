import { createElement } from 'react'
import { ASSET_PATH, EDITOR_MODULE } from '../contract.ts'
import { createBridge, type CanvasClientService, type CanvasOpenOptions } from './bridge.ts'
export type { CanvasClientService, CanvasOpenOptions } from './bridge.ts'
export const inject = ['slots', 'modules', 'layout', 'sessions', 'connection', 'conversation']

/** Only a user open/insert gesture fetches editor code, CSS, Excalidraw or fonts. */
export function apply(ctx: any): void {
  let loading: Promise<any> | undefined
  let disposePanel: (() => void) | undefined
  let generation = 0
  let leave: (() => Promise<void>) | undefined
  const load = () => {
    loading ??= (async () => {
      const asset = new URL(ASSET_PATH + 'editor.js', location.origin)
      // Native factory registration is preserved; the normal module owner materializes shared React externals.
      await import(/* @vite-ignore */ asset.href)
      return await ctx.modules.import(EDITOR_MODULE)
    })().catch(error => { loading = undefined; throw error })
    return loading
  }
  const service: CanvasClientService = {
    async leave() {
      await leave?.()
      generation += 1
      disposePanel?.()
      disposePanel = undefined
    },
    async open(sessionId: string, options: CanvasOpenOptions = {}) {
      const current = ++generation
      const isCurrent = () => current === generation && ctx.sessions.list.getSnapshot().current === sessionId
      if (!isCurrent()) return
      await leave?.()
      if (!isCurrent()) return
      const editor = await load()
      if (!isCurrent()) return
      if (!ctx.sessions.binding(sessionId)?.session) throw new Error('当前会话不可用。')
      const close = () => { generation += 1; disposePanel?.(); disposePanel = undefined; ctx.layout.closeDetails() }
      const bridge = createBridge(ctx, sessionId, close, handler => { leave = handler; return () => { if (leave === handler) leave = undefined } })
      const asset = options.attachment ? await bridge.call('resolve-image', {
        owner_session_id: options.attachment.ownerSessionId, attachment_id: options.attachment.attachmentId,
      }) : undefined
      if (!isCurrent()) return
      ctx.get?.('ematePetDetails')?.release()
      disposePanel?.()
      disposePanel = ctx.slots.register({ name: 'details', id: 'e-mate-canvas', priority: -2,
        inject: () => ({ bridge, initialProjectId: options.projectId ?? 'main', initialAsset: asset }),
      }, editor.CanvasPanel)
      ctx.sessions.open(sessionId)
      ctx.layout.openDetails()
    },
    insertAttachment(sessionId, ownerSessionId, attachmentId) { return service.open(sessionId, { attachment: { ownerSessionId, attachmentId } }) },
  }
  ctx.effect(() => {
    const dispose = ctx.reflect.provide('emateCanvas', service)
    return () => { generation += 1; disposePanel?.(); void dispose() }
  }, 'emate.canvas: lazy details service')
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'e-mate-canvas-open', order: 30,
  }, ({ sessionId }: { sessionId: string }) => createElement('button', { type: 'button', title: '打开项目画布', 'aria-label': '打开项目画布',
    onClick: () => { void service.open(sessionId).catch((error: Error) => {
      const scope = ctx.sessions.scope(sessionId)
      if (scope) ctx.conversation?.input.for(scope).notify('error', error.message)
    }) } }, '画布')))
}
