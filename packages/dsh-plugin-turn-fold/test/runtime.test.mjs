/**
 * End-to-end behaviour of the turn-fold provider on the pinned 0.1.5 build.
 *
 * This is not a smoke test. The file loads the **real compiled ui-chat bundle**,
 * applies the **real vendored Source Patches** through this package's driver, executes
 * the transformed module through a module-loader shim backed by the **real React and
 * react-dom the pinned Harness installs**, and renders a real 0.1.5 chat snapshot into
 * a jsdom document. The folded activity and the final answer are drawn by the native
 * node renderers the bundle itself registers, reached through the same
 * `(nodeKey) => jsx(ChatNodeSeat, props, nodeKey)` callback the production rewrite
 * emits — nothing in the render path below is a stand-in for native code.
 *
 * Two things are deliberately not native and are named here so the evidence is
 * readable:
 *
 * - `@deepseek-ai/dsh-client-ui-primitives` is a browser-only leaf package whose
 *   Node face imports CSS modules. The shim supplies the named components the chat
 *   renderers call, with `DisclosureRow` reproducing the open/closed structure the
 *   assertions read. That a real build resolves this package is asserted separately by
 *   `scripts/seams.mjs` (the host symbol must be bound in the ChatView scope).
 * - The slot renderer is reproduced, not imported: it resolves the component a
 *   registration declared, and supplies the framework hook the slot declaration
 *   publishes (`conversation.chat.node` declares `hooks.turnData`, ui-chat
 *   `src/client/apply.ts:104`). `registerChatNodeRenderers` is the real one.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { TARGET, findHarnessRoot, locateTarget } from '../scripts/seams.mjs'

const require = createRequire(import.meta.url)
const { transformClientBundle } = require('../lib/transform.cjs')
const dictionaries = require('../lib/locales.cjs')

const SESSION_ID = 's1'
const TURN = 1
const REASONING_ONE = 'CHECKPOINT-REASONING-ONE'
const REASONING_TWO = 'CHECKPOINT-REASONING-TWO'
const TOOL_OUTPUT = 'CHECKPOINT-TOOL-OUTPUT'
const FINAL_ANSWER = 'CHECKPOINT-FINAL-ANSWER'
const ACTIVITY_ONLY = 'CHECKPOINT-ACTIVITY-ONLY'

/** Load one module out of the pinned Harness through its own resolution rules. */
function harnessRequire(harnessRoot, from, specifier) {
  return createRequire(join(harnessRoot, from, 'package.json'))(specifier)
}

/**
 * Substituting translator over the provider's own dictionaries, so the summary bar
 * renders the strings a user sees. Keys the chat renderers own (`t` is the
 * chat-scoped translator) fall back to the key itself.
 * @param {string} locale - dictionary to read.
 * @returns {(key: string, params?: object) => string} the translator.
 */
/**
 * Locale keys the summary bar borrows from the seats it renders inside, copied
 * verbatim from their pinned owners: the shared number forms
 * (packages/client/locale/src/locales/en.ts:42-43) and the chat duration forms
 * (packages/client/ui-chat/src/client/locale.ts:210-211). Keys nobody owns fall back
 * to the key itself, exactly as an unregistered namespace would.
 */
const BORROWED_LOCALE = Object.freeze({
  'number.thousand': '{value}K',
  'number.million': '{value}M',
  'duration.seconds': '{seconds}s',
  'duration.minutes': '{minutes}m {seconds}s',
})

function createTranslator(locale) {
  const table = { ...BORROWED_LOCALE, ...dictionaries[locale] }
  return (key, params) => {
    const template = table[key]
    if (typeof template !== 'string') return key
    return template.replace(/\{(\w+)\}/gu, (match, name) => params !== undefined && name in params ? String(params[name]) : match)
  }
}

/**
 * `DisclosureRow` and friends: the browser-only primitives package, as components.
 * @param {{ jsx: Function }} runtime - the real `react/jsx-runtime`.
 * @returns {object} the module face the chat bundle requires.
 */
function createPrimitives(runtime) {
  const jsx = runtime.jsx
  const overrides = new Map()
  overrides.set('DisclosureRow', function DisclosureRow(props) {
    return jsx('div', {
      'data-shim-disclosure-row': '',
      'data-open': props.open ? 'true' : 'false',
      children: [
        props.leading ?? null,
        props.icon ?? null,
        props.title ?? null,
        props.collapsedContent ?? null,
        props.open ? props.children ?? null : null,
      ],
    })
  })
  overrides.set('MarkdownText', function MarkdownText(props) {
    return jsx('span', { 'data-shim-markdown': '', children: props.text ?? null })
  })
  // The chat seat's fallback for a node kind nobody registered is a JsonBlock
  // carrying the node's own data as `payload` (ChatNodeSeat.tsx:139-145), and the
  // real component renders that payload (ui-primitives
  // src/markdown/JsonBlock.tsx:8-33). The shim rendered every unlisted primitive as
  // a bare span, so a fallback-rendered node contributed no text and the assertions
  // could not read what the fallback was handed. The real component defers its body
  // behind its own toggle; the shim renders it so the payload stays readable.
  overrides.set('JsonBlock', function JsonBlock(props) {
    let payload
    try {
      payload = JSON.stringify(props.payload, null, 2) ?? String(props.payload)
    } catch {
      payload = String(props.payload)
    }
    return jsx('div', {
      'data-shim-json-block': '',
      children: [props.label ?? null, jsx('pre', { 'data-shim-json-body': '', children: payload })],
    })
  })
  const cache = new Map()
  return new Proxy({}, {
    get(_target, name) {
      if (typeof name !== 'string') return undefined
      if (overrides.has(name)) return overrides.get(name)
      if (!cache.has(name)) {
        cache.set(name, name.startsWith('Icon') || name.endsWith('Icon')
          ? function Icon() { return null }
          : function Primitive(props) { return jsx('span', { 'data-shim-primitive': name, children: props?.children ?? null }) })
      }
      return cache.get(name)
    },
  })
}

/** A store package the fold render path must not need; using it is a hard error. */
const unusedStore = new Proxy({}, {
  get(_target, name) {
    throw new Error('the turn-fold render path must not reach @deepseek-ai/dsh-client-store.' + String(name))
  },
})

/**
 * The client context the injected runtime installs itself into. Every member is the
 * one the pinned 0.1.5 client exposes: `locale.register`/`bind` (ui-chat
 * `src/client/apply.ts:74-95`), `settingsScope.bind({ namespace, decode })`
 * (ui-settings `src/client/settings-scope.ts:58,203`) and the keyed
 * `settings.plugin.item` slot (ui-settings-plugins `src/client/slot-contract.ts:19`).
 * @param {object} [options] - `fields` to serve from the scope, `onCall` to record calls.
 * @returns {{ ctx: object, calls: object }} the context and what it recorded.
 */
function createInstallContext(options = {}) {
  const fields = options.fields ?? ['duration', 'toolCalls', 'inputTokens', 'outputTokens']
  const calls = { locale: [], effects: [], scopes: [], injections: [], registrations: [], translations: [] }
  // One frozen snapshot: `useSyncExternalStore` re-renders while the snapshot reference
  // changes, so a fresh object per call would loop instead of settling.
  const snapshot = Object.freeze({ status: 'ready', value: Object.freeze({ summaryFields: Object.freeze(fields.slice()) }), writable: true })
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: () => Promise.resolve(),
  }
  const ctx = {
    effect: (callback, label) => { calls.effects.push(label); return callback() },
    locale: {
      register: (namespace, table) => { calls.locale.push({ namespace, table }); return () => {} },
      bind: namespace => { calls.translations.push(namespace); return createTranslator('en') },
    },
    settingsScope: {
      bind: spec => { calls.scopes.push(spec); return scope },
    },
    slots: {
      inject: (name, factory) => { calls.injections.push(name); factory(); return () => {} },
      register: (slotOptions, Component) => { calls.registrations.push({ options: slotOptions, Component }); return () => {} },
    },
  }
  return { ctx, calls }
}

/**
 * Apply the patches to the pinned bundle and execute the result.
 *
 * The probe epilogue is appended to the transformed text **in memory** so the test can
 * reach the injected runtime; the transform itself never writes a bundle anywhere.
 * @returns {object} the module exports plus the host functions the assertions use.
 */
function loadPatchedBundle() {
  const harnessRoot = findHarnessRoot()
  const jsdom = harnessRequire(harnessRoot, '', 'jsdom')
  const react = harnessRequire(harnessRoot, join('packages', 'client', 'ui-chat'), 'react')
  const reactDom = harnessRequire(harnessRoot, join('packages', 'client', 'ui-chat'), 'react-dom')
  const reactDomClient = harnessRequire(harnessRoot, join('packages', 'client', 'ui-chat'), 'react-dom/client')
  const jsxRuntime = harnessRequire(harnessRoot, join('packages', 'client', 'ui-chat'), 'react/jsx-runtime')

  const dom = new jsdom.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const previous = { window: globalThis.window, document: globalThis.document }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Element = dom.window.Element
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.Node = dom.window.Node
  globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0)
  globalThis.cancelAnimationFrame = handle => clearTimeout(handle)

  let record
  dom.window.__ModuleLoader__ = { load: value => { record = value } }
  // React only recognises `act(...)` when the environment announces itself.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const result = transformClientBundle()
  const probeLine = [
    '\t\texports.__emateProbe = {',
    '\t\t\tCHAT_NODE_INJECT, ChatNodeSeat, formatRunDuration, formatTokens,',
    '\t\t\tinstall: __ch4acko3DshTurnFoldInstall,',
    '\t\t\topenKeys: __ch4acko3DshTurnFoldOpenKeys,',
    '\t\t\trender: __ch4acko3DshTurnFoldRender,',
    '\t\t\tregisterChatNodeRenderers',
    '\t\t};\n',
  ].join('\n')
  const sentinel = '\t\treturn module.exports;'
  const occurrences = result.text.split(sentinel).length - 1
  assert.equal(occurrences, 1, 'the factory tail must appear exactly once')
  const instrumented = result.text.replace(sentinel, probeLine + sentinel)

  Function(instrumented)()
  assert.ok(record !== undefined, 'the transformed bundle must register itself through window.__ModuleLoader__')
  assert.equal(record.id, TARGET.package)

  const primitives = createPrimitives(jsxRuntime)
  const clientRequire = specifier => {
    if (specifier === 'react') return react
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    if (specifier === 'react-dom') return reactDom
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    if (specifier === '@deepseek-ai/dsh-client-store') return unusedStore
    throw new Error('the pinned chat bundle requested an unexpected module: ' + specifier)
  }
  const moduleExports = record.factory(clientRequire)
  const probe = moduleExports.__emateProbe
  assert.equal(typeof probe.render, 'function')
  assert.equal(typeof probe.install, 'function')
  assert.ok(probe.ChatNodeSeat !== undefined, 'the native node seat must be reachable through the probe')
  assert.equal(typeof probe.registerChatNodeRenderers, 'function')
  // The runtime installs itself exactly the way the patched bundle does, so the bar
  // below renders through the provider's own locale and settings wiring.
  const installation = createInstallContext()
  probe.install(installation.ctx)
  assert.deepEqual(installation.calls.effects, ['@ch4acko3/dsh-turn-fold: dictionaries', '@ch4acko3/dsh-turn-fold: settings'])

  test.after(() => {
    if (previous.window === undefined) delete globalThis.window
    else globalThis.window = previous.window
    if (previous.document === undefined) delete globalThis.document
    else globalThis.document = previous.document
    dom.window.close()
  })

  return { probe, react, reactDomClient, jsxRuntime, result }
}

const loaded = loadPatchedBundle()
const t = createTranslator('en')

/** One 0.1.5 Chat snapshot: a settled completed turn whose answer closes it. */
function createSnapshot({ tailUsage = { uncachedInputTokens: 1200, outputTokens: 340, totalTokens: 1540, cacheReadTokens: 100, cacheWriteTokens: 20, reasoningTokens: 30 }, stepUsage = { inputTokens: 5000, outputTokens: 5000 }, status = 'closed', reason = 'completed', includeTail = true } = {}) {
  const turnData = new Map()
  const locationData = {
    source: key => ({ subscribe: () => () => {}, getSnapshot: () => turnData.get(key) }),
    get: key => turnData.get(key),
  }
  const turn = {
    turn: TURN,
    start: { type: 'turn/start', seq: 1, time: 1000, data: { turn: TURN } },
    end: status === 'closed' ? { type: 'turn/end', seq: 30, time: 7000, data: { turn: TURN, reason: { kind: reason } } } : undefined,
    status,
    steps: [],
    data: locationData,
  }
  turnData.set('turn-tail', includeTail ? {
    turn: TURN,
    seq: 12,
    time: 7000,
    closing: { status: 'settled', turn: TURN, step: 3, blocks: [{ kind: 'text', text: FINAL_ANSWER }], time: 7000, finalNode: { kind: 'assistant', seq: 20, time: 7000, turn: TURN, step: 3, blocks: [{ kind: 'text', text: FINAL_ANSWER }] } },
    branchUnavailable: false,
    ttftMs: 250,
    tokensPerSecond: 42.5,
    ...tailUsage === null ? {} : { tokenUsage: tailUsage },
  } : undefined)

  const locationFor = step => ({ kind: 'step', turn, step })
  const nodes = [
    { key: 'k-step-1', kind: 'assistant-step', data: { status: 'settled', turn: TURN, step: 1, blocks: [{ kind: 'reasoning', text: REASONING_ONE }, { kind: 'tool-call', callId: 'c1', name: 'read', argsRaw: '{}' }], time: 1500, usage: stepUsage, finalNode: { kind: 'assistant', seq: 6, time: 1500, turn: TURN, step: 1, blocks: [], timing: { stepStartTime: 1100, firstTokenTime: 1350, completedTime: 1500 } } }, order: 0, location: locationFor(1) },
    { key: 'k-tool-1', kind: 'tool-call', data: { root: { kind: 'tool-result', seq: 7, time: 1600, callId: 'c1', call: { name: 'read', argsRaw: '{}' }, callTime: 1400, content: [{ type: 'text', text: TOOL_OUTPUT }], isError: false } }, order: 1, location: locationFor(1) },
    { key: 'k-step-2', kind: 'assistant-step', data: { status: 'settled', turn: TURN, step: 2, blocks: [{ kind: 'reasoning', text: REASONING_TWO }], time: 3000, usage: stepUsage, finalNode: { kind: 'assistant', seq: 10, time: 3000, turn: TURN, step: 2, blocks: [], timing: { stepStartTime: 2100, firstTokenTime: 2400, completedTime: 3000 } } }, order: 2, location: locationFor(2) },
    ...includeTail ? [{ key: 'k-tail', kind: 'turn-tail', data: turnData.get('turn-tail'), order: 3, location: locationFor(3) }] : [],
    { key: 'k-answer', kind: 'assistant-step', data: { status: 'settled', turn: TURN, step: 3, blocks: [{ kind: 'text', text: FINAL_ANSWER }, { kind: 'reasoning', text: ACTIVITY_ONLY }], time: 7000, finalNode: { kind: 'assistant', seq: 20, time: 7000, turn: TURN, step: 3, blocks: [{ kind: 'text', text: FINAL_ANSWER }] } }, order: 4, location: locationFor(3) },
  ]
  for (const node of nodes) {
    node.id = node.key
    node.target = 'chat'
    node.anchorSeq = node.data.seq ?? node.order + 1
    node.visibility = 'visible'
  }
  const order = nodes.map(node => node.key)
  const nodeStore = new Map(nodes.map(node => [node.key, node]))
  const timeline = { turnOrder: [TURN], turns: new Map([[TURN, turn]]) }
  const chatSnapshot = { order, nodes: nodeStore, timeline, locations: { getTurn: () => order } }
  return { order, nodeStore, timeline, chatSnapshot, turn }
}

/**
 * Render the fold output exactly the way the production rewrite does: every node
 * crosses the real `ChatNodeSeat`, and the slot renderer dispatches to the real
 * component the package registered for that node kind.
 */
function renderTurn(snapshot, { openFoldKeys = [], openActivityKeys = [] } = {}) {
  const { probe, react, reactDomClient, jsxRuntime } = loaded
  const jsx = jsxRuntime.jsx
  const rendered = []
  const nodeViews = new Map()
  const ctx = {
    slots: {
      inject(name, factory) { if (name === 'conversation.chat.node') factory() },
      register(options, Component) {
        if (options.name === 'conversation.chat.node') nodeViews.set(options.key, Component)
        return () => nodeViews.delete(options.key)
      },
    },
  }
  probe.registerChatNodeRenderers(ctx)
  // The open-key set is module-global runtime state; each render starts from closed
  // so one case cannot leak an expanded fold into the next.
  probe.openKeys.clear()
  for (const key of openActivityKeys) probe.openKeys.add(key)
  for (const key of openFoldKeys) probe.openKeys.add(key)

  const openFile = () => {}
  const actions = { setTurnProcessOpen() {} }
  const useStore = selector => selector({})
  const useChat = selector => selector(snapshot.chatSnapshot)
  const renderSlotChain = () => null
  const renderSlot = (name, owner, options) => {
    if (name !== 'conversation.chat.node') return null
    const View = nodeViews.get(options?.entryKey)
    if (View === undefined) return options?.fallback ?? null
    const useTurnData = probe.CHAT_NODE_INJECT.hooks.turnData(undefined, options.hookContext)
    return jsx(View, { ...owner, useTurnData, renderSlot, renderSlotChain, useChat, useStore, actions, t })
  }
  const seatProps = {
    useChatNode: nodeKey => snapshot.nodeStore.get(nodeKey),
    useChatNodeProcess: () => undefined,
    historyIncomplete: false,
    compactTranscript: false,
    cwd: undefined,
    openFile,
    inspectCall: () => {},
    forkAt: () => {},
    loadImage: () => '',
    renderMessageImages: () => null,
    fileMentions: () => undefined,
    useStore,
    actions,
    renderSlot,
    t,
  }
  // This is the callback the vendored rewrite emits verbatim.
  const renderNode = nodeKey => {
    rendered.push(nodeKey)
    return jsx(probe.ChatNodeSeat, { ...seatProps, nodeKey }, nodeKey)
  }

  const entries = probe.render({
    order: snapshot.order,
    nodeStore: snapshot.nodeStore,
    timeline: snapshot.timeline,
    sessionId: SESSION_ID,
    renderNode,
    t,
  })
  const container = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(container)
  const root = reactDomClient.createRoot(container)
  react.act(() => { root.render(jsx('div', { children: entries })) })
  const html = container.innerHTML
  const text = container.textContent ?? ''
  // Unmount before returning: the live-duration ticker owns an interval while a turn
  // is running, and a root left mounted would keep this process alive.
  react.act(() => { root.unmount() })
  container.remove()
  return { html, text, rendered }
}

test('a settled completed turn folds its activity and keeps the native answer', () => {
  const snapshot = createSnapshot()
  const folded = renderTurn(snapshot)

  assert.ok(folded.text.includes(FINAL_ANSWER), 'the final answer must stay visible')
  assert.ok(!folded.text.includes(REASONING_ONE), 'folded reasoning must not be rendered')
  assert.ok(!folded.text.includes(REASONING_TWO), 'folded reasoning must not be rendered')
  assert.ok(!folded.text.includes(TOOL_OUTPUT), 'the folded tool result must not be rendered')
  assert.ok(!folded.rendered.includes('k-step-1'), 'the native renderer must not be asked for a folded node')

  // The bar carries the 0.1.5 turn-tail facts, not a re-derivation.
  assert.ok(folded.text.includes('1 tool call'), folded.text)
  const expectedDuration = loaded.probe.formatRunDuration(6000, t)
  const expectedInput = loaded.probe.formatTokens(1320, t)
  const expectedOutput = loaded.probe.formatTokens(340, t)
  assert.notEqual(expectedInput, loaded.probe.formatTokens(10000, t), 'the token assertions must be able to tell the two owners apart')
  assert.ok(folded.text.includes('Took ' + expectedDuration), folded.text)
  assert.ok(folded.text.includes(expectedInput + ' input tokens'), folded.text)
  assert.ok(folded.text.includes(expectedOutput + ' output tokens'), folded.text)
  assert.ok(!folded.text.includes(loaded.probe.formatTokens(10000, t)), 'the per-step sum must not win over the turn tail')
})

test('expanding the fold renders the activity through the native node renderers', () => {
  const snapshot = createSnapshot()
  const folded = renderTurn(snapshot)
  assert.ok(!folded.text.includes(REASONING_ONE))

  const expanded = renderTurn(snapshot, { openFoldKeys: [SESSION_ID + ':' + TURN], openActivityKeys: ['activity:' + SESSION_ID + ':' + TURN + ':k-step-1'] })
  assert.ok(expanded.rendered.includes('k-tool-1'), 'the folded tool node must cross the native renderer when expanded')
  // ui-tool owns the 'tool-call' node key in the product (ui-tool/src/client/apply.ts:33-35).
  // This harness loads only the ui-chat bundle, so the seat paints its generic fallback
  // and this asserts what the seat handed that fallback — not what ui-tool would draw.
  assert.ok(expanded.text.includes(TOOL_OUTPUT), 'the seat must hand the folded tool result to the node renderer it calls')
  assert.ok(expanded.text.includes(REASONING_ONE), 'the native reasoning row must render the folded reasoning')
  assert.ok(expanded.text.includes(REASONING_TWO), 'every folded reasoning text must render')
  assert.ok(expanded.text.includes(FINAL_ANSWER), 'the answer must stay visible while expanded')
  assert.ok(expanded.text.includes('2 reasoning steps'), expanded.text)
  assert.ok(expanded.text.includes('1 tool call'), expanded.text)
})

test('a running turn keeps its live bar and never folds the turn', () => {
  const snapshot = createSnapshot({ status: 'open', tailUsage: null })
  const live = renderTurn(snapshot)
  assert.ok(live.html.includes('data-ch4acko3dsh-turn-fold-summary="running"'), 'an open turn shows the live summary bar')
  assert.ok(!live.html.includes('data-dsh-fold-scope="turn"'), 'an open turn must not be folded')
  assert.ok(live.text.includes('2 reasoning steps'), 'the activity is still present as its compact group: ' + live.text)
  assert.ok(live.text.includes(FINAL_ANSWER))
  // The activity itself is one disclosure away, drawn by the native reasoning row.
  const opened = renderTurn(snapshot, { openActivityKeys: ['activity:' + SESSION_ID + ':' + TURN + ':k-step-1'] })
  assert.ok(opened.text.includes(REASONING_ONE))
})

test('a turn with incomplete accounting shows the partial reading', () => {
  const snapshot = createSnapshot({ tailUsage: null })
  const partial = renderTurn(snapshot)
  assert.ok(partial.text.includes('\u2265'), 'incomplete evidence must render the "at least" reading: ' + partial.text)
})

test('a failed or max-token turn is never folded into the settled disclosure', () => {
  for (const reason of ['error', 'max-tokens', 'blocked']) {
    const snapshot = createSnapshot({ reason })
    const kept = renderTurn(snapshot)
    assert.ok(!kept.html.includes('data-dsh-fold-scope="turn"'), 'a ' + reason + ' turn must not fold')
    assert.ok(kept.html.includes('data-ch4acko3dsh-turn-fold-summary="complete"'), 'the bar still reports the turn')
    const opened = renderTurn(snapshot, { openActivityKeys: ['activity:' + SESSION_ID + ':' + TURN + ':k-step-1'] })
    assert.ok(opened.text.includes(REASONING_ONE), 'a ' + reason + ' turn must keep its evidence reachable')
  }
})

test('the runtime registers its locale, its settings scope and its settings card', () => {
  const { probe } = loaded
  const { ctx, calls } = createInstallContext({ fields: ['duration', 'toolCalls'] })
  probe.install(ctx)

  assert.deepEqual(calls.locale.map(entry => entry.namespace), ['@ch4acko3/dsh-turn-fold'])
  assert.deepEqual(Object.keys(calls.locale[0].table).sort(), ['en', 'zh'])
  assert.deepEqual(calls.effects, ['@ch4acko3/dsh-turn-fold: dictionaries', '@ch4acko3/dsh-turn-fold: settings'])
  assert.deepEqual(calls.translations, ['@ch4acko3/dsh-turn-fold'])
  assert.equal(calls.scopes.length, 1, 'the runtime must bind exactly one settings scope')
  const scopeSpec = calls.scopes[0]
  assert.equal(scopeSpec.namespace, 'dsh-turn-fold')
  assert.equal(typeof scopeSpec.decode, 'function')
  // The 0.1.5 settings scope takes a narrowing decoder; it must reject unknown fields
  // instead of letting an unexpected metric reach the bar.
  assert.deepEqual(scopeSpec.decode({ summaryFields: ['duration', 'outputTokens'] }), { summaryFields: ['duration', 'outputTokens'] })
  assert.equal(scopeSpec.decode({ summaryFields: ['duration', 'notAMetric'] }), undefined)
  assert.deepEqual(scopeSpec.decode({ summaryFields: ['duration', 'duration'] }), { summaryFields: ['duration'] }, 'a repeated field is collapsed, never doubled')
  assert.equal(scopeSpec.decode(null), undefined)
  assert.ok(calls.injections.includes('settings.plugin.item'), JSON.stringify(calls.injections))
  const card = calls.registrations.find(entry => entry.options.name === 'settings.plugin.item')
  assert.ok(card !== undefined, 'the runtime must register its settings card')
  assert.equal(card.options.key, 'dsh-turn-fold', 'the keyed slot is keyed by the settings namespace')

  const container = globalThis.document.createElement('div')
  const root = loaded.reactDomClient.createRoot(container)
  loaded.react.act(() => { root.render(loaded.jsxRuntime.jsx(card.Component, {})) })
  assert.ok((container.textContent ?? '').includes('Turn Fold'), container.innerHTML)
  assert.ok((container.textContent ?? '').includes('Displayed metrics'), container.textContent ?? '')
  // The card still starts closed: its body stays in the document, hidden, until
  // the header is activated.
  const cardRoot = container.querySelector('[data-ch4acko3-dsh-turn-fold-settings]')
  assert.ok(cardRoot !== null, 'the registration renders the settings card')
  assert.notEqual(
    cardRoot.querySelector('.__ch4acko3-dsh-turn-fold-settings__body[hidden]'),
    null,
    'a card that is closed by default keeps its body hidden',
  )
  loaded.react.act(() => { cardRoot.querySelector('button').click() })
  assert.equal(
    cardRoot.querySelector('.__ch4acko3-dsh-turn-fold-settings__body[hidden]'),
    null,
    'opening the card reveals the body it already carries',
  )
})
