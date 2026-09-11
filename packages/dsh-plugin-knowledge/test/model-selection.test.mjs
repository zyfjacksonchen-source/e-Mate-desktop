import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveKnowledgeSelection } from '../src/model-selection.ts'

test('knowledge reads the native Session Controller selection instead of stale Agent options and resolves its default effort', async () => {
  const asked = []
  const selected = { provider: 'picked-provider', model: 'gpt-6-astra' }
  const agent = { id: 'current-session', options: { provider: 'old-provider', model: 'old-model' } }
  const ctx = {
    get(name) {
      assert.equal(name, 'sessionController')
      return { selectionFor(owner) { asked.push(owner); return { current: selected } } }
    },
    emateModelPolicy: { async assertModel(model) { assert.equal(model, 'gpt-6-astra') } },
    llm: { async resolveCallConfig(value) { assert.equal(value, selected); return { ...value, reasoningEffort: 'medium' } } },
  }
  const actual = await resolveKnowledgeSelection(ctx, { agent })
  assert.deepEqual(actual, { ...selected, reasoningEffort: 'medium' })
  assert.deepEqual(asked, [agent])
})

test('standalone selection reads the native default and fails when enterprise policy rejects it', async () => {
  const selected = { provider: 'default-provider', model: 'default-model' }
  const ctx = { agentDefaultModel: { currentSelection: () => selected }, emateModelPolicy: { async assertModel() { throw Error('disabled') } }, llm: { resolveCallConfig() { assert.fail('must not resolve a denied model') } } }
  await assert.rejects(resolveKnowledgeSelection(ctx), /disabled/)
})

test('a missing native selection owner and cancellation never reach model resolution', async () => {
  const ctx = { get: () => undefined, llm: { resolveCallConfig() { assert.fail('must not resolve without a native selection') } } }
  await assert.rejects(resolveKnowledgeSelection(ctx, { agent: { id: 'session' } }), { code: 'model-selection-unavailable' })
  const cancel = new AbortController(); cancel.abort()
  await assert.rejects(resolveKnowledgeSelection({}, undefined, cancel.signal), { name: 'AbortError' })
})

test('a refused registry lookup or a rewritten selection never becomes resolved model output', async () => {
  let resolved = 0
  const owner = { selectionFor: () => ({ current: { provider: 'retired-provider', model: 'gone-model' } }) }
  const refused = Object.assign(Error('provider "retired-provider" is not registered'), { code: 'llm-unavailable' })
  await assert.rejects(resolveKnowledgeSelection({
    get: () => owner,
    emateModelPolicy: { async assertModel() {} },
    llm: { async resolveCallConfig() { resolved += 1; throw refused } },
  }, { agent: { id: 'session' } }), /is not registered/)
  assert.equal(resolved, 1)
  await assert.rejects(resolveKnowledgeSelection({
    get: () => owner,
    emateModelPolicy: { async assertModel() {} },
    llm: { async resolveCallConfig() { return { provider: 'retired-provider', model: 'replacement-model' } } },
  }, { agent: { id: 'session' } }), { code: 'model-changed' })
})

test('resumed UI imports retain their frozen native selection but recheck current model policy', async () => {
  const selected = { provider: 'frozen-provider', model: 'gpt-6-astra', reasoningEffort: 'medium' }
  let denied = false
  const ctx = {
    emateModelPolicy: { async assertModel(model) { assert.equal(model, selected.model); if (denied) throw Error('disabled') } },
    llm: { async resolveCallConfig(value) { assert.deepEqual(value, selected); return value } },
  }
  assert.deepEqual(await resolveKnowledgeSelection(ctx, { agent: { id: 'ui-import' } }, undefined, selected), selected)
  denied = true
  await assert.rejects(resolveKnowledgeSelection(ctx, { agent: { id: 'ui-import' } }, undefined, selected), /disabled/)
})
