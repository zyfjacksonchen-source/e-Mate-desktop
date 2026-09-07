import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInThisContext } from 'node:vm'
import test from 'node:test'

const harness = createRequire(new URL('../../../upstream/deepseek-harness/package.json', import.meta.url))
const ui = createRequire(new URL('../../../upstream/deepseek-harness/packages/client/ui-primitives/package.json', import.meta.url))
const { JSDOM } = harness('jsdom')
const React = ui('react')
const ReactDom = ui('react-dom/client')
const jsx = ui('react/jsx-runtime')

test('shipped client apply restores streaming, historical fences and native ToolView while preserving plain-code fallback', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://emate.test/', pretendToBeVisual: true })
  const saved = new Map()
  for (const key of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'MutationObserver', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value: typeof dom.window[key] === 'function' && key.endsWith('AnimationFrame') ? dom.window[key].bind(dom.window) : dom.window[key] })
  }
  let dispose
  try {
    let api
    // Actual browser bundle factory and real React; pristine rc.7 has no fence registry.
    const modules = { react: React, 'react-dom/client': ReactDom, 'react/jsx-runtime': jsx, '@deepseek-ai/dsh-client-ui-primitives': {} }
    window.__ModuleLoader__ = { load(definition) { assert.equal(definition.id, '@e-mate/dsh-plugin-genui'); api = definition.factory(id => { assert.ok(id in modules, id); return modules[id] }) } }
    runInThisContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))
    const registered = []
    const ctx = { sessions: { list: { getSnapshot: () => ({ current: 'session-test' }) } }, slots: {
      inject(_name, run) { run(); return () => {} }, register(spec, component) { registered.push({ spec, component }); return () => {} },
    }, get() {}, effect(run) { return run() } }
    const spec = label => JSON.stringify({ title: '卡片', items: [{ type: 'text', content: label }] })
    const make = (language, body, streaming = false) => {
      const row = document.createElement('section'); row.setAttribute('data-chat-anchor-key', `14:assistant-step${document.body.children.length + 1}:0`)
      if (streaming) row.setAttribute('data-streaming', '')
      const block = document.createElement('div'); block.className = 'md-code-block'
      const label = document.createElement('div'); label.textContent = language
      const pre = document.createElement('pre'); pre.textContent = body
      block.append(label, pre); row.append(block); document.body.append(row)
      return { row, block, label, pre }
    }
    const wait = () => new Promise(resolve => setTimeout(resolve, 90))
    const historical = make('dsh-ui', spec('历史卡片'))
    const plain = make('json', spec('普通代码'))
    const unsupported = make('genui', spec('未约定别名'))
    const broken = make('dsh-ui', 'this is not JSON')
    dispose = api.apply(ctx); await wait()
    assert.equal(historical.block.style.display, 'none')
    assert.match(historical.row.querySelector('.genui-dom-fence').textContent, /历史卡片/)
    for (const value of [plain, unsupported, broken]) assert.notEqual(value.block.style.display, 'none')
    assert.ok(registered.some(({ spec }) => spec.name === 'tool.call.toolview' && spec.key === 'render_ui'))
    assert.ok(registered.some(({ spec }) => spec.name === 'conversation.input.dock'))
    const ToolView = registered.find(({ spec }) => spec.key === 'render_ui').component
    const toolContainer = document.createElement('div'); document.body.append(toolContainer)
    const toolRoot = ReactDom.createRoot(toolContainer)
    try {
      toolRoot.render(React.createElement(ToolView, { toolName: 'render_ui', sessionId: 'session-test', block: { callId: 'call-valid', seq: 5, meta: JSON.parse(spec('工具卡片')) } }))
      await wait(); assert.match(toolContainer.textContent, /工具卡片/)
      assert.equal(toolContainer.querySelector('[data-genui-error]'), null)
      toolRoot.render(React.createElement(ToolView, { toolName: 'render_ui', sessionId: 'session-test', block: { callId: 'call-old' } }))
      await wait(); assert.match(toolContainer.textContent, /render_ui/)
      assert.match(toolContainer.textContent, /call-old/)
    } finally { toolRoot.unmount(); toolContainer.remove() }
    const streaming = make('', '{"title":"流式","items":[', true)
    await wait(); assert.notEqual(streaming.block.style.display, 'none')
    streaming.pre.textContent = spec('流式卡片'); await wait()
    assert.equal(streaming.block.style.display, 'none')
    streaming.label.textContent = 'dsh-ui'; streaming.row.removeAttribute('data-streaming'); await wait()
    assert.match(streaming.row.querySelector('.genui-dom-fence').textContent, /流式卡片/)
    const wrong = make('', spec('流式普通JSON'), true); await wait()
    wrong.label.textContent = 'json'; wrong.row.removeAttribute('data-streaming'); await wait()
    assert.notEqual(wrong.block.style.display, 'none')
    dispose(); dispose = undefined; await wait()
    assert.equal(document.querySelectorAll('.genui-dom-fence').length, 0)
    assert.equal(historical.block.style.display, '')
    dispose = api.apply(ctx); await wait() // Native remount/restart over saved Markdown.
    assert.match(historical.row.querySelector('.genui-dom-fence').textContent, /历史卡片/)
  } finally {
    dispose?.(); dom.window.close()
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
})
