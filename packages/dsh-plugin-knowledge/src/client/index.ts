import { CHANNEL, GRAPH_ASSET, GRAPH_MODULE, parseKnowledgeRpc } from '../contract.ts'
import { KnowledgeConstellationIcon, KnowledgeEntry, KnowledgePage } from './page.tsx'
export const inject = ['slots', 'connection', 'modules', 'workspaces', 'sessions', 'conversation']
/** Use the native input and Workspace default projection; never submit or rebuild attachments. */
export async function prepareKnowledgeDraft(ctx: any, text: string, signal: AbortSignal, viewActions: (id: string) => { setView(view: string): void } | undefined): Promise<void> {
  const initialSession = ctx.sessions.list.getSnapshot().current
  const controller = new AbortController()
  const cancel = () => controller.abort()
  addEventListener('emate:identity-changed', cancel); addEventListener('popstate', cancel)
  const check = () => {
    signal.throwIfAborted(); controller.signal.throwIfAborted()
    if (location.pathname !== '/knowledge' || document.querySelector('[data-emate-identity-gate]') || ctx.sessions.list.getSnapshot().current !== initialSession) throw Error('当前账号或会话已变化，请重新准备草稿。')
  }
  try {
    check()
    await ctx.get?.('emateCanvas')?.beforeNavigate()
    check()
    let sessionId = initialSession
    if (sessionId === undefined) {
      const workspace = ctx.workspaces.list.getSnapshot()
      if (!workspace.baselinesReady || !workspace.recentWorkspaceId) throw Error('新会话尚未就绪，请先打开一个会话后重试。')
      sessionId = await ctx.workspaces.connectWorkspace(workspace.recentWorkspaceId)
      check()
    }
    const scope = ctx.sessions.scope(sessionId)
    if (scope === undefined) throw Error('当前会话不可用，请重新打开会话后重试。')
    const actions = viewActions(sessionId)
    if (initialSession !== undefined && !actions) throw Error('聊天页面尚未就绪，请稍后重试。')
    const input = ctx.conversation.input.for(scope), snapshot = input.state.getSnapshot()
    if (snapshot.phase !== 'plain') throw Error('输入框正在提交，请稍后重试。')
    check()
    input.setDraft(snapshot.draft === '' ? text : `${snapshot.draft}\n\n${text}`)
    actions?.setView('chat')
    ctx.sessions.open(sessionId)
    history.pushState(null, '', `/chat/${encodeURIComponent(sessionId)}`)
    dispatchEvent(new PopStateEvent('popstate'))
  } finally { removeEventListener('emate:identity-changed', cancel); removeEventListener('popstate', cancel) }
}
export function apply(ctx: any): void {
  const actions = new Map<string, { setView(view: string): void }>()
  ctx.effect(() => {
    const clear = () => actions.clear()
    addEventListener('emate:identity-changed', clear)
    return () => { clear(); removeEventListener('emate:identity-changed', clear) }
  })
  ctx.slots.inject('conversation.session.header.utilities', () => {
    const store = ctx.slots.entries('conversation.session').find((entry: any) => entry.store)?.store
    if (!store) throw Error('知识阅读缺少原生会话视图状态。')
    return ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'e-mate-knowledge-draft', store,
      inject: (sessionId: string, value: { setView(view: string): void }) => { actions.set(sessionId, value); return {} },
    }, () => null)
  })
  let loading: Promise<any> | undefined
  const loadGraph = () => {
    loading ??= (async () => { await import(/* @vite-ignore */ new URL(GRAPH_ASSET, location.origin).href); return ctx.modules.import(GRAPH_MODULE) })().catch(error => { loading = undefined; throw error })
    return loading
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'e-mate-knowledge', order: -9,
    inject: () => ({
      loadGraph,
      prepareDraft: (text: string, signal: AbortSignal) => prepareKnowledgeDraft(ctx, text, signal, id => actions.get(id)),
      pickDirectory: async (signal?: AbortSignal) => {
        signal?.throwIfAborted()
        const path = await ctx.workspaces.pickDirectory()
        signal?.throwIfAborted()
        return path
      },
      openTask: (sessionId: string) => ctx.sessions.open(sessionId),
      callKnowledge: async (endpoint: string, payload: Record<string, unknown>, signal?: AbortSignal) => {
        const response = await ctx.connection.rpc.call(CHANNEL, endpoint, payload, signal)
        return parseKnowledgeRpc(response)
      },
    }),
  }, KnowledgePage))
  ctx.slots.inject('sidebar.primary.action', () => ctx.slots.register({
    name: 'sidebar.primary.action', id: 'e-mate-knowledge-entry', order: 30,
    inject: () => ({ KnowledgeIcon: KnowledgeConstellationIcon }),
  }, KnowledgeEntry))
}
