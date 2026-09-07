import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { readFile, mkdtemp, realpath, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { adaptHarnessConversationSource } from './harness-conversation-adapter.mjs'
import { adaptHarnessArtifactLinksSource } from './harness-artifact-links-adapter.mjs'
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
const { MarkdownText } = await import('data:text/javascript;base64,' + Buffer.from(moduleText).toString('base64'))
const { jsx } = requireNative('react/jsx-runtime')
const { renderToStaticMarkup } = requireNative('react-dom/server')
const vocabularyText = await readFile(join(harness, 'packages/client/ui-deliverables/src/client/turn-deliverables.ts'), 'utf8')
const vocabulary = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(vocabularyText.slice(vocabularyText.indexOf('export function basename(')))).toString('base64'))
const conversation = adaptHarnessConversationSource(await readFile(join(harness, 'packages/client/ui-conversation/lib/client.js'), 'utf8'))
const mentionsCode = conversation.slice(conversation.indexOf('function emateArtifactFileMentions('), conversation.indexOf('function emateCanvasNavigationRequest('))
const fileLinkOwner = new Function(mentionsCode + '\nreturn emateArtifactFileMentions')()
const { resolveWorkspacePath } = await import(pathToFileURL(join(harness, 'packages/client/runtime/src/client/workspaces/path.ts')).href)
const { openNativePath } = await import(pathToFileURL(join(harness, 'packages/host/apiproxy/src/native-path-opener.ts')).href)

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
