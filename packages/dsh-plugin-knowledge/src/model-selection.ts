import { fail, type Execution } from './imports.ts'

/** Read the same native selection as the composer, including an unsent pick. */
export async function resolveKnowledgeSelection(ctx: any, exec?: Execution, signal = exec?.signal, frozenSelection?: { provider: string; model: string; reasoningEffort?: string }) {
  signal?.throwIfAborted()
  let selection: any = frozenSelection
  if (!selection && exec?.agent) {
    // rc.1 removed the ApiProxy RPC this used to call. The pinned owner of a
    // Session's current selection — a composer pick not yet sent, else the logged
    // request header, else the deployment default — is
    // SessionController.selectionFor(agent).current
    // (upstream/deepseek-harness/packages/api/session-controller/src/agent.ts:276-305).
    const controller = ctx.get?.('sessionController')
    if (controller === undefined) fail('model-selection-unavailable')
    selection = controller.selectionFor(exec.agent).current
  } else if (!selection) selection = ctx.agentDefaultModel.currentSelection()
  signal?.throwIfAborted()
  if (!selection || typeof selection.provider !== 'string' || !selection.provider || typeof selection.model !== 'string' || !selection.model) fail('model-selection-unavailable')
  await ctx.emateModelPolicy.assertModel(selection.model)
  const resolved = await ctx.llm.resolveCallConfig(selection, signal)
  signal?.throwIfAborted()
  if (resolved.provider !== selection.provider || resolved.model !== selection.model) fail('model-changed')
  return { provider: resolved.provider, model: resolved.model,
    ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) }
}
