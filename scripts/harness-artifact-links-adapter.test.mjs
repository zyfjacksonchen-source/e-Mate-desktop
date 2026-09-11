import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { readFile, mkdtemp, realpath, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { adaptHarnessChatSource, adaptHarnessConversationSource } from './harness-conversation-adapter.mjs'
import { adaptHarnessArtifactLinksSource, adaptHarnessArtifactLinksRendererSource, artifactLinksVitePlugin, ARTIFACT_LINKS_RENDERER_PATH } from './harness-artifact-links-adapter.mjs'

const harness = join(process.env.EMATE_TEST_NATIVE_ROOT ?? new URL('..', import.meta.url).pathname, 'upstream/deepseek-harness')
const libraryRoot = join(harness, 'packages/client/ui-primitives')
const native = await readFile(join(libraryRoot, 'lib/index.js'), 'utf8')
const adapted = adaptHarnessArtifactLinksSource(native)
const requireNative = createRequire(join(libraryRoot, 'package.json'))
const requireHarness = createRequire(join(harness, 'package.json'))

// Import the actual emitted renderer. Only package resolution and the CSS-only
// side effect are adjusted for this Node DOM test; no renderer is substituted.
// rc.1 emits CSS-module imports beside the library, and a data:-URL module cannot
// resolve them; stub each one with a class-name proxy so rendered markup keeps
// its class attributes.
const cssStub = 'data:text/javascript,' + encodeURIComponent('export default new Proxy({}, { get: (_t, key) => String(key) })')
const moduleText = adapted.replace(/^(import [^\n]+ from )"([^"]+\.css)";$/gmu, (_line, head) => head + '"' + cssStub + '";')
  .replace(/^import [^\n]+ from "([^"]+)";/gmu, (line, name) => name.startsWith('data:')
    ? line
    : line.replace('"' + name + '"', JSON.stringify(pathToFileURL(requireNative.resolve(name)).href)))
  .replace(/^import "katex\/dist\/katex.min.css";$/mu, '')
const primitiveModule = await import('data:text/javascript;base64,' + Buffer.from(moduleText).toString('base64'))
const { MarkdownText } = primitiveModule
const { jsx } = requireNative('react/jsx-runtime')
const { renderToStaticMarkup } = requireNative('react-dom/server')
const vocabularyText = await readFile(join(harness, 'packages/client/ui-deliverables/src/client/turn-deliverables.ts'), 'utf8')
// rc.1 moved the vocabulary's basename() into presented.ts; inline the same
// three-line helper so the evaluated slice keeps its one external dependency.
const basenameSource = `function basename(path) {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\\\"))
  return at === -1 ? path : path.slice(at + 1)
}
`
const vocabularySlice = vocabularyText.slice(vocabularyText.indexOf('export function producedForClosing('))
  // A data:-URL module cannot resolve the slice's trailing relative re-export;
  // basenameSource above supplies that one helper.
  .replace(/^export \{[^}]*\} from '[^']*'$/gmu, '')
const vocabulary = await import('data:text/javascript;base64,' + Buffer.from(
  basenameSource + stripTypeScriptTypes(vocabularySlice),
).toString('base64'))
const conversation = adaptHarnessConversationSource(await readFile(join(harness, 'packages/client/ui-conversation/lib/client.js'), 'utf8'))
const mentionsCode = conversation.slice(conversation.indexOf('function emateArtifactFileMentions('), conversation.indexOf('function emateCanvasNavigationRequest('))
const fileLinkOwner = new Function(mentionsCode + '\nreturn emateArtifactFileMentions')()
const { resolveWorkspacePath } = await import(pathToFileURL(join(harness, 'packages/util/workspace-path/src/index.ts')).href)
const { openNativePath } = await import(pathToFileURL(join(harness, 'packages/util/native-command/src/path-opener.ts')).href)

test('all renderer seams fail closed on drift, duplication and already adapted output', () => {
  assert.throws(() => adaptHarnessArtifactLinksSource('future'), /expected one rc.7 seam/)
  assert.throws(() => adaptHarnessArtifactLinksSource(native + native), /found 2/)
  assert.throws(() => adaptHarnessArtifactLinksSource(adapted), /expected one rc.7 seam/)
})

test('real native MarkdownText resolves only proven local files and preserves authored labels/reference images', () => {
  const files = ['/workspace/报告 空格.pdf', '/workspace/chart.png', '/workspace/100%.txt']
  const fileMentions = vocabulary.producedFileMentions(files, () => {}, path => '打开 ' + path)
  for (const text of [
    '[打开报告](/workspace/%E6%8A%A5%E5%91%8A%20%E7%A9%BA%E6%A0%BC.pdf)',
    '[打开报告](file:///workspace/%E6%8A%A5%E5%91%8A%20%E7%A9%BA%E6%A0%BC.pdf)',
    '[打开报告][report]\n\n[report]: </workspace/报告 空格.pdf>',
    '![查看图片](/workspace/chart.png)',
    '![查看图片][image]\n\n[image]: /workspace/chart.png',
    '[百分比文件](/workspace/100%.txt)',
  ]) {
    const html = renderToStaticMarkup(jsx(MarkdownText, { text, fileMentions }))
    assert.match(html, /<button[^>]*type="button"/)
    assert.doesNotMatch(html, /href="file:|src="file:/)
    assert.match(html, /打开报告|查看图片|百分比文件/)
  }
  for (const text of ['[未知](/workspace/missing.pdf)', '[伪路径](sandbox:/mnt/data/chart.png)', '[跨协议](javascript:alert%281%29)', '[外部主机](file://other-host/workspace/chart.png)']) {
    assert.doesNotMatch(renderToStaticMarkup(jsx(MarkdownText, { text, fileMentions })), /<a |<button|<img/)
  }
  const ambiguous = vocabulary.producedFileMentions(['/one/report.pdf', '/two/report.pdf'], () => {}, path => path)
  assert.doesNotMatch(renderToStaticMarkup(jsx(MarkdownText, { text: '[不猜重名](report.pdf)', fileMentions: ambiguous })), /<button/)
  const remote = renderToStaticMarkup(jsx(MarkdownText, { text: '[官网](https://example.com)', fileMentions }))
  assert.match(remote, /href="https:\/\/example.com"/); assert.match(remote, /rel="noopener noreferrer"/)
  assert.doesNotMatch(renderToStaticMarkup(jsx(MarkdownText, { text: '[未提供身份](/workspace/chart.png)' })), /<button/)
})

test('DOM click travels actual MarkdownText and native vocabulary to the native mac/windows opener', async t => {
  const { JSDOM } = requireHarness('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const names = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT']
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[name] })
  const { render, fireEvent, cleanup } = requireHarness('@testing-library/react')
  t.after(() => { cleanup(); dom.window.close(); for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] } })
  const root = await realpath(await mkdtemp(join(tmpdir(), 'emate-link-native-')))
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'emate-link-outside-')))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))
  const report = join(root, '报告 空格.pdf'), image = join(root, 'image.png'), missing = join(root, 'missing.txt'), escaped = join(root, 'escaped.txt')
  await writeFile(report, '%PDF-1.4\nsynthetic artifact')
  await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jg0kAAAAASUVORK5CYII=', 'base64'))
  await writeFile(join(outside, 'private.txt'), 'must not open'); await symlink(join(outside, 'private.txt'), escaped)
  for (const platform of ['darwin', 'win32']) {
    const commands = []
    // The retired ApiProxy boundary is gone. rc.1 verifies an artifact open in the
    // native route that owns it: the presented file's coordinates resolve through
    // workspaceFiles inside the Session workspace before the route calls
    // session.openWorkspacePath
    // (upstream/deepseek-harness/packages/client/ui-deliverables/src/present-open.ts:64-74).
    // This renderer-only fixture therefore asserts the renderer half only: the click
    // reaches the native opener with the resolved path, and no product-side check
    // refuses a missing file or a symlink out of the workspace any more.
    const waiting = []
    const openFile = path => {
      waiting.push(openNativePath(resolveWorkspacePath(root, path), new AbortController().signal, {
        platform,
        run: async (command, args) => { commands.push({ command, args }); return { stdout: '', stderr: '' } },
      }))
    }
    const proven = vocabulary.producedFileMentions([report], openFile, () => '打开产物')
    const fileMentions = fileLinkOwner({ get: () => ({ forClosing: () => proven }) }, { openFile })
    for (const path of [report, image, missing, escaped]) {
      const view = render(jsx(MarkdownText, { text: '[点击产物](<' + path + '>)', fileMentions }))
      fireEvent.click(view.getByRole('button')); cleanup()
    }
    await Promise.all(waiting)
    // Every click reaches the native opener now, including the missing file and the
    // symlink that resolves outside the workspace; only the two existing artifacts
    // are on the produced list, so the other two carry their raw mention path.
    assert.equal(commands.length, 4)
    for (const path of [report, image]) assert(commands.some(call => platform === 'darwin' ? call.command === 'open' && call.args[0] === path : call.command === 'powershell.exe' && call.args.at(-1).includes(path)))
    assert(!commands.some(call => call.args.some(argument => argument.includes(outside))))
  }
})


test('explicit links preserve Windows drives and relative paths without promoting sandbox, network or executable URLs', () => {
  const paths = []
  const fileMentions = fileLinkOwner({ get: () => undefined }, { openFile: path => paths.push(path) })
  const helper = adapted.slice(adapted.indexOf('function emateArtifactMention('), adapted.indexOf('function renderAnchor('))
  const mention = new Function('normalizeUri', helper + '\nreturn emateArtifactMention')(value => value)
  for (const value of ['C:/项目/报告 空格.pdf', 'C:\\项目\\报告 空格.pdf', 'file:///C:/%E9%A1%B9%E7%9B%AE/%E6%8A%A5%E5%91%8A%20%E7%A9%BA%E6%A0%BC.pdf', 'subdir/copied.png']) mention(value, { fileMentions }).open()
  assert.deepEqual(paths, ['C:/项目/报告 空格.pdf', 'C:\\项目\\报告 空格.pdf', 'C:/项目/报告 空格.pdf', 'subdir/copied.png'])
  for (const value of ['', '#part', 'sandbox:/mnt/data/image.png', 'javascript:alert(1)', '%6Aavascript:alert(1)', 'data:image/png;base64,abc', '//remote/share.png', 'file://remote/share.png']) {
    assert.equal(mention(value, { fileMentions }), undefined)
  }
  const html = renderToStaticMarkup(jsx(MarkdownText, { text: '![查看图片](copied.png)', fileMentions }))
  assert.match(html, /<button/); assert.doesNotMatch(html, /<img|src=/)
  assert.equal(paths.length, 4, 'rendering never probes or opens any file/image')
})

// Load the emitted native module factories, exposing only their real owners for
// this test. Slot dispatch below supplies the same native hook context as ChatView.
// The emitted prologue reads its loader from a global window, and a factory's
// other window reads resolve lazily against whatever page the current test has
// installed, so a factory loaded before a DOM test still sees that test's DOM.
function emittedFactory(source, require, extraExports = '') {
  let output
  const loader = { __ModuleLoader__: { load(module) { output = module.factory(require) } } }
  const host = new Proxy(loader, {
    get: (target, key) => key in target ? target[key] : (globalThis.window ?? globalThis)[key],
  })
  new Function('window', source.replace('return module.exports;', extraExports + '\nreturn module.exports;'))(host)
  return output
}
// 0.1.5 kept the assembler in ui-conversation and moved the Chat renderer, its
// Node Definitions and the Chat target builder to ui-chat, so each owner is
// loaded from its own emitted bundle.
const requireConversation = createRequire(join(harness, 'packages/client/ui-conversation/package.json'))
const requireChat = createRequire(join(harness, 'packages/client/ui-chat/package.json'))
// Every emitted factory and the adapted renderer must render through the one
// React instance the assertions use, so React resolves through the library.
function harnessRequire(packageRequire) {
  return name => name === '@deepseek-ai/dsh-client-ui-primitives' ? primitiveModule
    : name === 'react' || name === 'react-dom' || name === 'react/jsx-runtime' ? requireNative(name)
    : packageRequire(name)
}
const conversationRuntime = emittedFactory(conversation, harnessRequire(requireConversation))
const conversationOwners = emittedFactory(
  adaptHarnessChatSource(await readFile(join(harness, 'packages/client/ui-chat/lib/client.js'), 'utf8')),
  harnessRequire(requireChat),
  'exports.testOwners = { registerConversationNodes, AssistantNodeView, ChatNodeSeat, CHAT_NODE_INJECT };',
).testOwners
function nativeChat(events, incremental = false) {
  const definitions = [], views = []; let fallback
  // The registry entry point is ctx.uiConversation.{events,views}.register;
  // only the system-prompt and request-prompt Definitions read the two
  // inspect helpers, and no fixture event here reaches them.
  conversationOwners.registerConversationNodes({
    uiConversation: {
      events: { register: value => definitions.push(value), registerFallback: value => { fallback = value } },
      views: { register: value => views.push(value) },
      inspectSystemPrompt: previous => previous,
      inspectRequestPrompt: previous => previous,
    },
  })
  const assembler = new conversationRuntime.ConversationNodeAssembler({ entries: () => definitions, fallbackEntry: () => fallback }, { entries: () => views })
  // 0.1.5 feeds one activated target with tagged SessionEventLikeEntry values:
  // rc.7 accepted a bare { event } and appended without activating 'chat'.
  assembler.activateTarget('chat')
  if (incremental) for (const event of events) { assembler.append({ type: 'event', event }); assembler.flush() }
  else assembler.replaceWindow(events.map(event => ({ type: 'event', event })), false)
  assembler.flush()
  return assembler.snapshot('chat')
}
const terminalText = '- [文本文件 EM218-link-check.txt](/workspace/EM218-link-check.txt)\n- [图片 EM218-link-check.png](/workspace/EM218-link-check.png)'
function terminalEvents() {
  return [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'step/start', data: { turn: 1, step: 1 } },
    // 0.1.5's turn-tail Definition derives Turn token usage from the durable
    // assistant/message payload, which always carries `source` and `stream`.
    { seq: 3, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'final-message', role: 'assistant', content: [{ type: 'text', text: terminalText }], source: { kind: 'model', provider: 'synthetic', model: 'synthetic' } }, stream: [] } },
    { seq: 4, type: 'step/end', data: { turn: 1, step: 1 } },
    { seq: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map(event => ({ ...event, time: 1700000000000 + event.seq }))
}
function nodeProps(chat, openFile) {
  const node = chat.nodes.values().find(node => node.kind === 'assistant-step' && node.data.finalNode?.seq === 3)
  assert(node)
  const useSession = selector => selector({ chat })
  const useChat = selector => selector(chat)
  return {
    nodeKey: node.key,
    // 0.1.5's ChatNodeSeat subscribes per Node key through the seat's keyed
    // hook faces; rc.7 handed it one selectedCallId and a whole-snapshot
    // useSession to pick the row itself.
    useChatNode: key => chat.nodes.get(key),
    useChatNodeProcess: () => undefined,
    historyIncomplete: false, compactTranscript: false, useStore: () => undefined,
    actions: { setTurnProcessOpen() {} },
    cwd: '/workspace', openFile, inspectCall() {}, forkAt() {}, loadImage: async () => undefined,
    renderMessageImages: () => null,
    fileMentions: owner => fileLinkOwner({ get: () => undefined }, owner), t: key => key,
    renderSlot(_name, owner, { hookContext }) {
      // useChat is a session standard hook and the Turn-data hook rides the
      // slot's provided hook face, exactly as the keyed seat supplies them.
      return jsx(conversationOwners.AssistantNodeView, { ...owner, useChat, useSession, t: key => key,
        useTurnData: conversationOwners.CHAT_NODE_INJECT.hooks.turnData({ useSession }, hookContext) })
    },
  }
}
test('actual native final projection and Assistant renderer retain explicit file links after cold and incremental completion', async t => {
  // 0.1.5's Turn-data hook reads its Turn store through useSyncExternalStore and
  // publishes no server snapshot, so the shipped renderer is exercised in a DOM
  // instead of through renderToStaticMarkup.
  const { JSDOM } = requireHarness('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const names = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT']
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[name] })
  const { render, cleanup } = requireHarness('@testing-library/react')
  t.after(() => { cleanup(); dom.window.close(); for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] } })
  for (const incremental of [false, true]) {
    const chat = nativeChat(terminalEvents(), incremental)
    const view = render(jsx(conversationOwners.ChatNodeSeat, nodeProps(chat, () => {})))
    assert.equal((view.container.innerHTML.match(/<button/g) ?? []).length, 2, incremental ? 'incremental completion' : 'cold completion')
    cleanup()
  }
})


test('Vite consumes the native source adapter and the emitted browser library opens final local links', async t => {
  const requireWeb = createRequire(join(harness, 'apps/web/package.json'))
  const { build } = await import(pathToFileURL(requireWeb.resolve('vite')).href)
  const directory = await mkdtemp(join(tmpdir(), 'emate-artifact-vite-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const entry = join(directory, 'entry.js')
  await writeFile(entry, "export { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';")
  const rendererPath = await realpath(join(harness, ARTIFACT_LINKS_RENDERER_PATH))
  const renderer = await readFile(rendererPath, 'utf8')
  assert.throws(() => adaptHarnessArtifactLinksRendererSource('changed native source'), /expected one rc.7 seam/)
  assert.throws(() => adaptHarnessArtifactLinksRendererSource(renderer + renderer), /found 2/)
  assert.throws(() => adaptHarnessArtifactLinksRendererSource(adaptHarnessArtifactLinksRendererSource(renderer)), /expected one rc.7 seam/)
  const absent = artifactLinksVitePlugin(rendererPath)
  absent.buildStart()
  assert.equal(absent.transform('unrelated', join(directory, 'other.tsx')), null)
  assert.throws(() => absent.generateBundle(), /not consumed/)
  for (const apply of [false, true]) {
    const result = await build({ configFile: false, root: directory, logLevel: 'silent',
      esbuild: { jsx: 'automatic' }, plugins: apply ? [artifactLinksVitePlugin(rendererPath)] : [],
      resolve: { alias: [{ find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: join(harness, 'packages/client/ui-primitives/src/index.ts') }] },
      build: { outDir: join(directory, apply ? 'adapted-dist' : 'native-dist'), minify: false, lib: { entry, formats: ['es'], fileName: 'browser' },
        rollupOptions: { external: id => id !== '@deepseek-ai/dsh-client-ui-primitives' && !id.endsWith('.css') && !id.startsWith('.') && !id.startsWith('/') },
      },
    })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(value => value.output)
    const built = outputs.find(item => item.type === 'chunk' && item.isEntry)
    assert(built)
    const shipped = await readFile(join(directory, apply ? 'adapted-dist' : 'native-dist', built.fileName), 'utf8')
    assert.equal(shipped, built.code)
    const code = shipped.replace(/(?:from |^import )["']([^"']+)["']/gm, (match, id) => match.replace(id, pathToFileURL(requireNative.resolve(id)).href))
    const domEntry = join(directory, apply ? 'adapted-dom.mjs' : 'native-dom.mjs')
    await writeFile(domEntry, code)
    const compiled = await import(pathToFileURL(domEntry).href)
    const html = renderToStaticMarkup(jsx(compiled.MarkdownText, { text: terminalText, fileMentions: fileLinkOwner({ get: () => undefined }, { openFile() {} }) }))
    assert.equal((html.match(/<button/g) ?? []).length, apply ? 2 : 0)
    if (apply) {
      const { JSDOM } = requireHarness('jsdom')
      const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
      const names = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT']
      const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
      for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[name] })
      const { render, fireEvent, cleanup } = requireHarness('@testing-library/react')
      try {
        const opened = []
        const view = render(jsx(compiled.MarkdownText, { text: terminalText, fileMentions: fileLinkOwner({ get: () => undefined }, { openFile: path => opened.push(path) }) }))
        assert.deepEqual(opened, [], 'Vite output never probes or opens on render')
        for (const button of view.getAllByRole('button')) fireEvent.click(button)
        assert.deepEqual(opened, ['/workspace/EM218-link-check.txt', '/workspace/EM218-link-check.png'])
      } finally { cleanup(); dom.window.close(); for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] } }
    }
  }
})

// 0.1.5 emits the deliverables owner as three bundle regions whose two helper
// regions carry no outer reference, so slicing all three keeps the Definition
// and its readers self-contained; rc.7 sliced one producedPaths() helper and
// injected the runtime namespace's isAppendSurfaceEvent.
function deliverablesBundleCode(bundle) {
  const region = name => {
    const start = bundle.indexOf('//#region ' + name)
    const end = bundle.indexOf('//#endregion', start)
    assert(start !== -1 && end !== -1, 'missing emitted region ' + name)
    return bundle.slice(start, end)
  }
  return [
    region('lib/types/presented.js'),
    region('../../core/session/lib/types/surface.js'),
    region('lib/types/client/turn-deliverables.js'),
  ].join('\n')
}
test('native deliverables adopts only successful Office receipts explicitly named by latest closing prose', async () => {
  const { adaptHarnessArtifactDeliverablesSource } = await import('./harness-artifact-links-adapter.mjs')
  const library = await readFile(join(harness, 'packages/client/ui-deliverables/lib/client.js'), 'utf8')
  const adapted = adaptHarnessArtifactDeliverablesSource(library)
  // Execute the emitted native accumulator from its module factory. The actual
  // boot serves this client.js; it does not import the source through Vite.
  const code = deliverablesBundleCode(adapted)
  const definition = new Function(code + '\nreturn deliverablesDefinition')()
  assert.throws(() => adaptHarnessArtifactDeliverablesSource(adapted), /expected one/)
  let seq = 1
  const start = { type: 'turn/start', seq: seq++, data: { turn: 3 } }
  let state = definition.start({}, { event: start })
  // 0.1.5's own isAppendSurfaceEvent gates every surface Match on the durable
  // marker, so the fixture carries the `append` a real Session event carries;
  // rc.7's injected stub read a missing marker as append.
  function step(event, view) { event.seq = seq++; event.data.turn = 3; const match = definition.match(event); if (match) state = definition.update({ state }, { event, view }) }
  function receipt(id, name, path, operation = 'read', extra = {}) {
    step({ type: 'tool/call', data: { callId: id, name } }, { for: 'call', view: { card: 'generic', kind: 'edit', locations: [{ path: 'wrong-requested-name.pptx' }] } })
    step({ type: 'tool/result', surfaceOp: 'append', data: { message: { source: { callId: id }, content: [{ type: 'tool-result', isError: false }] }, meta: { operation, format: 'pptx', job_id: 'emate-office-7', bytes: 1703973, relative_path: path, ...extra } } })
  }
  function closing(text) { step({ type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text }] } } }) }
  const paths = () => definition.buildLocationData({ state }, 'turn').value.produced.map(row => row.path)
  receipt('intermediate', 'editor', 'ignored')
  const real = 'emate_red_intro_20260908/exports/e-Mate介绍_红色活力风_5页.pptx'
  receipt('read', 'office_read', real)
  assert.ok(!paths().includes(real))
  closing('交付：`' + real + '`')
  assert.equal(paths()[0], real)
  const fileMentions = vocabulary.producedFileMentions(paths(), () => {}, path => path)
  const html = renderToStaticMarkup(jsx(MarkdownText, { text: '`' + real + '`', fileMentions }))
  assert.match(html, /<button/u)
  assert.ok(html.includes('e-Mate介绍_红色活力风_5页.pptx'))
  assert.ok(!paths().includes('ignored'))
  closing('最终正文不再引用文件')
  assert.ok(!paths().includes(real))
  closing('```bash\n`' + real + '`\n```')
  assert.ok(!paths().includes(real))
  receipt('write', 'office_write', '.e-mate/office/结果-2.pptx', 'write')
  assert.ok(paths().includes('.e-mate/office/结果-2.pptx'))
  for (const [id, path, extra] of [['escape', '../secret.pptx', {}], ['wrongformat', 'out.pptx', { format: 'pdf' }], ['badsize', 'bad.pptx', { bytes: 0 }]]) {
    receipt(id, 'office_read', path, 'read', extra); closing('`' + path + '`'); assert.ok(!paths().includes(path))
  }
  receipt('fake-tool', 'bash', 'unverified.pptx'); closing('`unverified.pptx`')
  assert.ok(!paths().includes('unverified.pptx'))
  step({ type: 'tool/call', data: { callId: 'failed', name: 'office_read' } })
  step({ type: 'tool/result', surfaceOp: 'append', data: { message: { source: { callId: 'failed' }, content: [{ type: 'tool-result', isError: true }] }, meta: { operation: 'read', format: 'pptx', job_id: 'emate-office-8', bytes: 20, relative_path: 'failed.pptx' } } })
  closing('`failed.pptx`'); assert.ok(!paths().includes('failed.pptx'))
  receipt('png', 'office_write', '.e-mate/office/page.png', 'write', { format: 'png' })
  assert.ok(paths().includes('.e-mate/office/page.png'))
  const before = paths(); const event = { type: 'assistant/message', surfaceOp: 'replace', data: { turn: 3 } }
  assert.equal(definition.match(event), null); assert.deepEqual(paths(), before)
})

test('Univer outputs use native root and Code trees in replay and live closing, with exact paths and session ownership', async () => {
  const { adaptHarnessArtifactDeliverablesSource } = await import('./harness-artifact-links-adapter.mjs')
  const adapted = adaptHarnessArtifactDeliverablesSource(await readFile(join(harness, 'packages/client/ui-deliverables/lib/client.js'), 'utf8'))
  const code = deliverablesBundleCode(adapted)
  const select = new Function(code + '\nreturn selectProducedFiles')()
  const events = []; let seq = 0
  const add = (type, data) => events.push({ type, data, seq: ++seq, time: 100 + seq, surfaceOp: 'append' })
  const content = (operation, file, result) => [{ type: 'text', text: JSON.stringify({ ok: true, operation, ...(file ? { file } : {}), result }) }]
  const call = (id, name, blocks, isError = false, turn = 1) => {
    add('tool/call', { turn, step: 1, callId: id, name, arguments: '{}' })
    add('tool/result', { turn, step: 1, message: { source: { callId: id }, content: [{ type: 'tool-result', isError, content: blocks }] } })
  }
  const file = '/workspace/book.univer'
  add('turn/start', { turn: 1 }); add('step/start', { turn: 1, step: 1 })
  call('new', 'univer_new', content('new', file, { filePath: file, created: true }))
  call('export', 'univer_export', content('export', file, { filePath: file, outputPath: '/one/report.xlsx', kind: 'sheet' }))
  call('execute-read', 'univer_execute', content('execute', file, { filePath: file, committed: false }))
  call('png', 'univer_screenshot', content('screenshot', file, { images: [{ path: '/workspace/page.png', mediaType: 'image/png', image: { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png' } }] }))
  call('svg', 'univer_resources', content('resources', undefined, { exported: [{ path: '/workspace/icon.svg' }] }))
  for (const [id, output] of [['root-a', '/one/report.pdf'], ['root-b', 'C:\\two\\report.pdf']]) {
    add('tool/call', { turn: 1, step: 1, callId: id, name: 'run_code', arguments: '{}' })
    const identity = { rootCallId: id, parentCallId: id, subCallId: 'same-child', name: 'univer_print_pdf', arguments: { output: '/guessed.pdf' } }
    add('tool/ptc-dispatch-start', identity)
    add('tool/ptc-dispatch', { ...identity, isError: false, content: content('print-pdf', file, { output, pageCount: 1, unitType: 'slide' }) })
    add('tool/result', { turn: 1, step: 1, message: { source: { callId: id }, content: [{ type: 'tool-result', isError: id === 'root-b', content: [{ type: 'text', text: 'partial: /guessed.pdf' }] }] } })
  }
  const fake = content('print-pdf', file, { output: '/fake.pdf', pageCount: 1 })
  call('stdout', 'run_code', fake); call('failed', 'univer_print_pdf', fake, true)
  call('mismatch', 'univer_export', fake)
  call('escape', 'univer_print_pdf', content('print-pdf', file, { output: '/workspace/../escape.pdf', pageCount: 1 }))
  call('remote', 'univer_print_pdf', content('print-pdf', file, { output: 'https://example.com/report.pdf', pageCount: 1 }))
  call('prose', 'univer_print_pdf', [{ type: 'text', text: 'Result: ' + fake[0].text }])
  add('assistant/message', { turn: 1, step: 1, message: { id: 'done', role: 'assistant', content: [{ type: 'text', text: '完成' }], source: { kind: 'model', provider: 'synthetic', model: 'synthetic' } }, stream: [] })
  const closing = seq
  call('late', 'univer_print_pdf', content('print-pdf', file, { output: '/late.pdf', pageCount: 1 }))
  add('step/end', { turn: 1, step: 1 }); add('turn/end', { turn: 1, reason: { kind: 'completed' } })
  add('turn/start', { turn: 2 }); add('step/start', { turn: 2, step: 1 })
  call('foreign', 'univer_print_pdf', content('print-pdf', file, { output: '/foreign.pdf', pageCount: 1 }), false, 2)
  const expected = [file, '/one/report.xlsx', '/workspace/page.png', '/workspace/icon.svg', '/one/report.pdf', 'C:\\two\\report.pdf']
  for (const incremental of [false, true]) {
    const chat = nativeChat(events, incremental)
    const turn = chat.timeline.turns.get(1)
    const owner = { turn, seq: closing, nodes: chat.nodes.values(), openFile() {} }
    assert.deepEqual(select(owner), expected)
    assert.deepEqual(select({ ...owner, seq: Infinity }), [...expected, '/late.pdf'])
    const { nodes, ...assistantOwner } = owner
    const snapshot = { sessionId: 'current', openState: 'open', chat }
    const session = { getSnapshot: () => snapshot }
    const sessions = { list: { getSnapshot: () => ({ current: 'current' }) }, binding: () => ({ session }) }
    assert.deepEqual(select(assistantOwner, sessions), expected)
    const foreignChat = nativeChat(events)
    assert.equal(select({ ...assistantOwner, turn: foreignChat.timeline.turns.get(1) }, sessions), null)
    const opened = []; const mentions = vocabulary.producedFileMentions(select(owner), path => opened.push(path), path => path)
    assert.equal(mentions.resolve('report.pdf'), undefined)
    for (const path of ['/one/report.pdf', 'C:\\two\\report.pdf']) mentions.resolve(path).open()
    assert.deepEqual(opened, ['/one/report.pdf', 'C:\\two\\report.pdf'])
    const priorOpened = []
    const followUp = { turn: chat.timeline.turns.get(2), seq: Infinity, nodes: chat.nodes.values().filter(node => node.location.turn?.turn === 2), openFile: path => priorOpened.push(path) }
    const service = { forClosing: owner => {
      const paths = select(owner, sessions)
      return paths === null ? undefined : vocabulary.producedFileMentions(paths, owner.openFile, path => path)
    } }
    const followMentions = fileLinkOwner({ get: () => service }, followUp, sessions, 'current')
    assert.deepEqual(select(followUp, sessions), ['/foreign.pdf'])
    for (const path of [file, '/one/report.xlsx', '/one/report.pdf', 'C:\\two\\report.pdf']) {
      assert.equal(followMentions.resolve(path)?.title, path)
      followMentions.resolve(path).open()
    }
    assert.deepEqual(priorOpened, [file, '/one/report.xlsx', '/one/report.pdf', 'C:\\two\\report.pdf'])
    assert.deepEqual(select(followUp, sessions), ['/foreign.pdf'], 'prior mentions do not promote new produced facts')
    for (const unknown of ['report.pdf', '/unverified/report.pdf', '/fake.pdf', '/workspace/../escape.pdf']) assert.equal(followMentions.resolve(unknown), undefined)
    const retained = followMentions.resolve(file)
    snapshot.sessionId = 'other-session'
    assert.equal(followMentions.resolve(file), undefined); retained.open(); assert.equal(priorOpened.length, 4)
    snapshot.sessionId = 'current'
    snapshot.chat = foreignChat
    assert.equal(followMentions.resolve(file), undefined); retained.open(); assert.equal(priorOpened.length, 4)
  }
})
