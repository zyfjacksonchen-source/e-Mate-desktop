import { randomUUID } from 'node:crypto'
import { fail, type Execution } from './imports.ts'

/** Read the same native selection as the composer, including an unsent pick. */
export async function resolveKnowledgeSelection(ctx: any, exec?: Execution, signal = exec?.signal) {
  signal?.throwIfAborted()
  let selection: any
  if (exec?.agent) {
    const response = await ctx.apiProxy.sessions.models({ rpcId: randomUUID(), payload: { sessionId: exec.agent.id } })
    if (!response?.result?.ok || response.result.value?.routable !== true) fail('model-unavailable')
    selection = response.result.value.current
  } else selection = ctx.agentDefaultModel.currentSelection()
  signal?.throwIfAborted()
  if (!selection || typeof selection.provider !== 'string' || !selection.provider || typeof selection.model !== 'string' || !selection.model) fail('model-selection-unavailable')
  await ctx.emateModelPolicy.assertModel(selection.model)
  const resolved = await ctx.llm.resolveCallConfig(selection, signal)
  signal?.throwIfAborted()
  if (resolved.provider !== selection.provider || resolved.model !== selection.model) fail('model-changed')
  return { provider: resolved.provider, model: resolved.model,
    ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) }
}
