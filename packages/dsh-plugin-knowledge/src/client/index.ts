import { IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { CHANNEL, GRAPH_ASSET, GRAPH_MODULE, parseKnowledgeRpc } from '../contract.ts'
import { KnowledgeEntry, KnowledgePage } from './page.tsx'
export const inject = ['slots', 'connection', 'modules', 'workspaces', 'sessions']
export function apply(ctx: any): void {
  let loading: Promise<any> | undefined
  const loadGraph = () => {
    loading ??= (async () => { await import(/* @vite-ignore */ new URL(GRAPH_ASSET, location.origin).href); return ctx.modules.import(GRAPH_MODULE) })().catch(error => { loading = undefined; throw error })
    return loading
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'e-mate-knowledge', order: -9,
    inject: () => ({
      loadGraph,
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
    inject: () => ({ KnowledgeIcon: IconDataOutline16 }),
  }, KnowledgeEntry))
}
