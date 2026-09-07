import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveKnowledgeSelection } from '../src/model-selection.ts'

test('knowledge uses the native composer pick instead of stale Agent options and resolves its default effort', async () => {
  const calls = []
  const selected = { provider: 'picked-provider', model: 'gpt-6-astra' }
  const ctx = {
    apiProxy: { sessions: { async models(request) { calls.push(request); return { result: { ok: true, value: { routable: true, current: selected } } } } } },
    emateModelPolicy: { async assertModel(model) { assert.equal(model, 'gpt-6-astra') } },
    llm: { async resolveCallConfig(value) { assert.equal(value, selected); return { ...value, reasoningEffort: 'medium' } } },
  }
  const actual = await resolveKnowledgeSelection(ctx, { agent: { id: 'current-session', options: { provider: 'old-provider', model: 'old-model' } } })
  assert.deepEqual(actual, { ...selected, reasoningEffort: 'medium' })
  assert.deepEqual(calls[0].payload, { sessionId: 'current-session' })
})

test('standalone selection reads the native default and fails when enterprise policy rejects it', async () => {
  const selected = { provider: 'default-provider', model: 'default-model' }
  const ctx = { agentDefaultModel: { currentSelection: () => selected }, emateModelPolicy: { async assertModel() { throw Error('disabled') } }, llm: { resolveCallConfig() { assert.fail('must not resolve a denied model') } } }
  await assert.rejects(resolveKnowledgeSelection(ctx), /disabled/)
})

test('unroutable selections and cancellation never reach model resolution', async () => {
  const ctx = { apiProxy: { sessions: { async models() { return { result: { ok: true, value: { routable: false } } } } } } }
  await assert.rejects(resolveKnowledgeSelection(ctx, { agent: { id: 'session' } }), { code: 'model-unavailable' })
  const cancel = new AbortController(); cancel.abort()
  await assert.rejects(resolveKnowledgeSelection({}, undefined, cancel.signal), { name: 'AbortError' })
})
