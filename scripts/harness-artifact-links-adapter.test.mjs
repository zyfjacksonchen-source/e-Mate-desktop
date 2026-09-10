import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { readFile, mkdtemp, realpath, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { adaptHarnessConversationSource } from './harness-conversation-adapter.mjs'
import { adaptHarnessArtifactLinksSource, adaptHarnessArtifactLinksRendererSource, artifactLinksVitePlugin, ARTIFACT_LINKS_RENDERER_PATH } from './harness-artifact-links-adapter.mjs'
import { apply as applyOpenBoundary } from '../packages/dsh/src/profile/artifact-open-boundary.ts'

const harness = join(process.env.EMATE_TEST_NATIVE_ROOT ?? new URL('..', import.meta.url).pathname, 'upstream/deepseek-harness')
const libraryRoot = join(harness, 'packages/client/ui-primitives')
const native = await readFile(join(libraryRoot, 'lib/index.js'), 'utf8')
const adapted = adaptHarnessArtifactLinksSource(native)
const requireNative = createRequire(join(libraryRoot, 'package.json'))
const requireHarness = createRequire(join(harness, 'package.json'))

// Import the actual emitted renderer. Only package resolution and the CSS-only
// side effect are adjusted for this Node DOM test; no renderer is substituted.
const moduleText = adapted.replace(/^import [^\n]+ from "([^"]+)";/gmu, (line, name) => line.replace('"' + name + '"', JSON.stringify(pathToFileURL(requireNative.resolve(name)).href)))
  .replace(/^import "katex\/dist\/katex.min.css";$/mu, '')
const primitiveModule = await import('data:text/javascript;base64,' + Buffer.from(moduleText).toString('base64'))
const { MarkdownText } = primitiveModule
const { jsx } = requireNative('react/jsx-runtime')
const { renderToStaticMarkup } = requireNative('react-dom/server')
const vocabularyText = await readFile(join(harness, 'packages/client/ui-deliverables/src/client/turn-deliverables.ts'), 'utf8')
const vocabulary = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(vocabularyText.slice(vocabularyText.indexOf('export function basename(')))).toString('base64'))
const conversation = adaptHarnessConversationSource(await readFile(join(harness, 'packages/client/ui-conversation/lib/client.js'), 'utf8'))
const mentionsCode = conversation.slice(conversation.indexOf('function emateArtifactFileMentions('), conversation.indexOf('function emateCanvasNavigationRequest('))
const fileLinkOwner = new Function(mentionsCode + '\nreturn emateArtifactFileMentions')()
const { resolveWorkspacePath } = await import(pathToFileURL(join(harness, 'upstream/deepseek-harness/packages/util/workspace-path/src/index.ts')).href)
const { openNativePath } = await import(pathToFileURL(join(harness, 'upstream/deepseek-harness/packages/util/native-command/src/path-opener.ts')).href)

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

test('DOM click travels actual MarkdownText and native vocabulary to fenced native mac/windows opener; missing/escaped files refuse', async t => {
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
    const commands = [], responses = []
    const ctx = { workspaceRegistry: { list: () => [{ path: root }] }, effect: effect => effect(), apiProxy: { host: { openPath: async (request, signal) => {
      await openNativePath(request.payload.path, signal, { platform, run: async (command, args) => { commands.push({ command, args }); return { stdout: '', stderr: '' } } })
      return { rpcId: request.rpcId, result: { ok: true, value: { opened: true } } }
    } } } }
    applyOpenBoundary(ctx)
    const waiting = []
    const openFile = path => {
      waiting.push(ctx.apiProxy.host.openPath({ rpcId: 'synthetic', payload: { path: resolveWorkspacePath(root, path) } }, new AbortController().signal).then(result => responses.push(result)))
    }
    const proven = vocabulary.producedFileMentions([report], openFile, () => '打开产物')
    const fileMentions = fileLinkOwner({ get: () => ({ forClosing: () => proven }) }, { openFile })
    for (const path of [report, image, missing, escaped]) {
      const view = render(jsx(MarkdownText, { text: '[点击产物](<' + path + '>)', fileMentions }))
      fireEvent.click(view.getByRole('button')); cleanup()
    }
    await Promise.all(waiting)
    assert.equal(commands.length, 2)
    assert.equal(responses.filter(result => result.result.ok).length, 2)
    assert.equal(responses.filter(result => !result.result.ok).length, 2)
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
function emittedFactory(source, require, extraExports = '') {
  let output
  new Function('window', source.replace('return module.exports;', extraExports + '\nreturn module.exports;'))({ __ModuleLoader__: { load(module) { output = module.factory(require) } } })
  return output
}
const requireConversation = createRequire(join(harness, 'packages/client/ui-conversation/package.json'))
const clientRuntime = emittedFactory(await readFile(join(harness, 'packages/client/runtime/lib/client.js'), 'utf8'), requireConversation)
const conversationOwners = emittedFactory(conversation, name => {
  if (name === '@deepseek-ai/dsh-client-runtime/client') return clientRuntime
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitiveModule
  if (name === '@deepseek-ai/dsh-client-ui-attachment') return {}
  return requireConversation(name)
}, 'exports.testOwners = { registerConversationNodes, AssistantNodeView, ChatNodeSeat, CHAT_NODE_INJECT };').testOwners
function nativeChat(events, incremental = false) {
  const definitions = [], views = []; let fallback
  conversationOwners.registerConversationNodes({ conversationEvents: { register: value => definitions.push(value), registerFallback: value => { fallback = value } }, conversationViews: { register: value => views.push(value) } })
  const assembler = new clientRuntime.ConversationNodeAssembler({ entries: () => definitions, fallbackEntry: () => fallback }, { entries: () => views })
  if (incremental) for (const event of events) { assembler.append({ event, view: undefined }); assembler.flush() }
  else assembler.replaceWindow(events.map(event => ({ event, view: undefined })), false)
  assembler.flush()
  return assembler.snapshot('chat')
}
const terminalText = '- [文本文件 EM218-link-check.txt](/workspace/EM218-link-check.txt)\n- [图片 EM218-link-check.png](/workspace/EM218-link-check.png)'
function terminalEvents() {
  return [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 3, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'final-message', role: 'assistant', content: [{ type: 'text', text: terminalText }] } } },
    { seq: 4, type: 'step/end', data: { turn: 1, step: 1 } },
    { seq: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map(event => ({ ...event, time: 1700000000000 + event.seq }))
}
function nodeProps(chat, openFile) {
  const node = chat.nodes.values().find(node => node.kind === 'assistant-step' && node.data.finalNode?.seq === 3)
  assert(node)
  const useSession = selector => selector({ chat })
  return { nodeKey: node.key, selectedCallId: null, cwd: '/workspace', openFile, inspectCall() {}, forkAt() {}, useSession,
    fileMentions: owner => fileLinkOwner({ get: () => undefined }, owner), t: key => key,
    renderSlot(_name, owner, { hookContext }) {
      return jsx(conversationOwners.AssistantNodeView, { ...owner, useSession, t: key => key, useTurnData: conversationOwners.CHAT_NODE_INJECT.hooks.turnData({ useSession }, hookContext) })
    },
  }
}
test('actual native final projection and Assistant renderer retain explicit file links after cold and incremental completion', () => {
  for (const incremental of [false, true]) {
    const chat = nativeChat(terminalEvents(), incremental)
    const html = renderToStaticMarkup(jsx(conversationOwners.ChatNodeSeat, nodeProps(chat, () => {})))
    assert.equal((html.match(/<button/g) ?? []).length, 2, incremental ? 'incremental completion' : 'cold completion')
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

test('native deliverables adopts only successful Office receipts explicitly named by latest closing prose', async () => {
  const { adaptHarnessArtifactDeliverablesSource } = await import('./harness-artifact-links-adapter.mjs')
  const library = await readFile(join(harness, 'packages/client/ui-deliverables/lib/client.js'), 'utf8')
  const adapted = adaptHarnessArtifactDeliverablesSource(library)
  // Execute the emitted native accumulator from its module factory. The actual
  // boot serves this client.js; it does not import the source through Vite.
  const code = adapted.slice(adapted.indexOf('function producedPaths('), adapted.indexOf('function basename('))
  const definition = new Function('_deepseek_ai_dsh_client_runtime_client', code + '\nreturn deliverablesDefinition')({ isAppendSurfaceEvent: (event) => event.surfaceOp !== 'replace' })
  assert.throws(() => adaptHarnessArtifactDeliverablesSource(adapted), /expected one/)
  let seq = 1
  const start = { type: 'turn/start', seq: seq++, data: { turn: 3 } }
  let state = definition.start({}, { event: start })
  function step(event, view) { event.seq = seq++; event.data.turn = 3; const match = definition.match(event); if (match) state = definition.update({ state }, { event, view }) }
  function receipt(id, name, path, operation = 'read', extra = {}) {
    step({ type: 'tool/call', data: { callId: id, name } }, { for: 'call', view: { card: 'generic', kind: 'edit', locations: [{ path: 'wrong-requested-name.pptx' }] } })
    step({ type: 'tool/result', data: { message: { source: { callId: id }, content: [{ type: 'tool-result', isError: false }] }, meta: { operation, format: 'pptx', job_id: 'emate-office-7', bytes: 1703973, relative_path: path, ...extra } } })
  }
  function closing(text) { step({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }) }
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
  step({ type: 'tool/result', data: { message: { source: { callId: 'failed' }, content: [{ type: 'tool-result', isError: true }] }, meta: { operation: 'read', format: 'pptx', job_id: 'emate-office-8', bytes: 20, relative_path: 'failed.pptx' } } })
  closing('`failed.pptx`'); assert.ok(!paths().includes('failed.pptx'))
  receipt('png', 'office_write', '.e-mate/office/page.png', 'write', { format: 'png' })
  assert.ok(paths().includes('.e-mate/office/page.png'))
  const before = paths(); const event = { type: 'assistant/message', surfaceOp: 'replace', data: { turn: 3 } }
  assert.equal(definition.match(event), null); assert.deepEqual(paths(), before)
})

test('Univer outputs use native root and Code trees in replay and live closing, with exact paths and session ownership', async () => {
  const { adaptHarnessArtifactDeliverablesSource } = await import('./harness-artifact-links-adapter.mjs')
  const adapted = adaptHarnessArtifactDeliverablesSource(await readFile(join(harness, 'packages/client/ui-deliverables/lib/client.js'), 'utf8'))
  const code = adapted.slice(adapted.indexOf('function producedPaths('), adapted.indexOf('function basename('))
  const select = new Function('_deepseek_ai_dsh_client_runtime_client', code + '\nreturn selectProducedFiles')({ isAppendSurfaceEvent: () => true })
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
    add('tool/code-dispatch-start', identity)
    add('tool/code-dispatch', { ...identity, isError: false, content: content('print-pdf', file, { output, pageCount: 1, unitType: 'slide' }) })
    add('tool/result', { turn: 1, step: 1, message: { source: { callId: id }, content: [{ type: 'tool-result', isError: id === 'root-b', content: [{ type: 'text', text: 'partial: /guessed.pdf' }] }] } })
  }
  const fake = content('print-pdf', file, { output: '/fake.pdf', pageCount: 1 })
  call('stdout', 'run_code', fake); call('failed', 'univer_print_pdf', fake, true)
  call('mismatch', 'univer_export', fake)
  call('escape', 'univer_print_pdf', content('print-pdf', file, { output: '/workspace/../escape.pdf', pageCount: 1 }))
  call('remote', 'univer_print_pdf', content('print-pdf', file, { output: 'https://example.com/report.pdf', pageCount: 1 }))
  call('prose', 'univer_print_pdf', [{ type: 'text', text: 'Result: ' + fake[0].text }])
  add('assistant/message', { turn: 1, step: 1, message: { id: 'done', role: 'assistant', content: [{ type: 'text', text: '完成' }] } })
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
