import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { adaptHarnessFsSource, adaptHarnessSessionTitleSource, SESSION_TITLE_PACKAGE, applyHarnessRuntimeAdapters } from './harness-runtime-adapters.mjs'
import { adaptHarnessFsBytesSource, FS_BYTES_PACKAGE } from './harness-fs-bytes-adapter.mjs'
import { adaptHarnessSessionExportSource, SESSION_EXPORT_PACKAGE } from './harness-session-export-adapter.mjs'
import { adaptHarnessConversationSource, CONVERSATION_PACKAGE } from './harness-conversation-adapter.mjs'
import { adaptHarnessArtifactLinksSource, ARTIFACT_LINKS_PACKAGE, adaptHarnessArtifactDeliverablesSource, ARTIFACT_DELIVERABLES_PACKAGE } from './harness-artifact-links-adapter.mjs'

const rc7Seam = `\tasync resolvePolicy(toolName, args, exec) {
\t\tvalidateEscalationArgs(args.sandbox_permissions, args.justification);
\t\tconst standingPolicy = this.policy?.resolve({ ...exec.agent ? { session: exec.agent.session } : {} });
\t\tif (args.sandbox_permissions === void 0 || args.justification === void 0) return standingPolicy;`

test('filesystem adapter ignores only escalation metadata redundant with the standing policy', () => {
  const adapted = adaptHarnessFsSource(rc7Seam)
  assert.match(adapted, /standingPolicy\.mode === "danger-full-access"/u)
  assert.match(adapted, /if \(!redundantEscalation\) validateEscalationArgs/u)
  assert.match(adapted, /args\.justification === void 0 \|\| redundantEscalation/u)
})

test('filesystem adapter fails closed when the pinned Harness seam drifts', () => {
  assert.throws(() => adaptHarnessFsSource('future harness output'), /expected one rc\.7 escalation seam, found 0/u)
  assert.throws(() => adaptHarnessFsSource(`${rc7Seam}\n${rc7Seam}`), /expected one rc\.7 escalation seam, found 2/u)
})

test('runtime adapters isolate real hardlinks and preserve their sources on replacement failure', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'emate-runtime-hardlinks-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const runtime = join(directory, 'runtime')
  const nativeRoot = process.env.EMATE_TEST_NATIVE_ROOT ?? new URL('..', import.meta.url).pathname
  const nativeArtifactLinks = await fs.readFile(join(nativeRoot, 'upstream/deepseek-harness/packages/client/ui-primitives/lib/index.js'), 'utf8')
  const nativeDeliverables = await fs.readFile(join(nativeRoot, 'upstream/deepseek-harness/packages/client/ui-deliverables/lib/client.js'), 'utf8')
  const nativeConversation = await fs.readFile(join(nativeRoot, 'upstream/deepseek-harness/packages/client/ui-conversation/lib/client.js'), 'utf8')
  const nativeExport = await fs.readFile(join(nativeRoot, 'upstream/deepseek-harness/packages/session-query/session-log-export/lib/index.js'), 'utf8')
  const nativeBytes = await fs.readFile(join(nativeRoot, 'upstream/deepseek-harness/packages/fs/fs-local/lib/index.js'), 'utf8')
  const nativeTitle = await fs.readFile(join(nativeRoot, 'upstream/deepseek-harness/packages/session/session-title/lib/index.js'), 'utf8')
  const entries = [
    { name: '@deepseek-ai/dsh-tool-fs', file: 'index.js', input: rc7Seam, adapt: adaptHarnessFsSource },
    { name: FS_BYTES_PACKAGE, file: 'index.js', input: nativeBytes, adapt: adaptHarnessFsBytesSource },
    { name: SESSION_EXPORT_PACKAGE, file: 'index.js', input: nativeExport, adapt: adaptHarnessSessionExportSource },
    { name: ARTIFACT_LINKS_PACKAGE, file: 'index.js', input: nativeArtifactLinks, adapt: adaptHarnessArtifactLinksSource },
    { name: ARTIFACT_DELIVERABLES_PACKAGE, file: 'client.js', input: nativeDeliverables, adapt: adaptHarnessArtifactDeliverablesSource },
    { name: CONVERSATION_PACKAGE, file: 'client.js', input: nativeConversation, adapt: adaptHarnessConversationSource },
    { name: SESSION_TITLE_PACKAGE, file: 'index.js', input: nativeTitle, adapt: adaptHarnessSessionTitleSource },
  ]
  for (const entry of entries) {
    entry.source = join(directory, entry.name.replace(/[@/]/gu, '_') + '-' + entry.file)
    entry.target = join(runtime, 'node_modules', entry.name, 'lib', entry.file)
    await fs.writeFile(entry.source, entry.input)
    await fs.chmod(entry.source, 0o750)
    await fs.mkdir(dirname(entry.target), { recursive: true })
    await fs.link(entry.source, entry.target)
    entry.original = await fs.stat(entry.source)
    assert.equal((await fs.stat(entry.target)).ino, entry.original.ino)
    assert.equal(entry.original.nlink, 2)
  }

  await applyHarnessRuntimeAdapters(runtime)
  for (const entry of entries) {
    assert.equal(await fs.readFile(entry.source, 'utf8'), entry.input)
    assert.equal(await fs.readFile(entry.target, 'utf8'), entry.adapt(entry.input))
    assert.notEqual((await fs.stat(entry.target)).ino, entry.original.ino)
    assert.equal((await fs.stat(entry.target)).mode, entry.original.mode)
    assert.deepEqual(await fs.readdir(dirname(entry.target)), [entry.file])
    await fs.rm(entry.target)
    await fs.link(entry.source, entry.target)
  }

  const failure = new Error('simulated replacement failure')
  const rename = t.mock.method(fs, 'rename', async (temporary, target) => {
    assert.equal(target, entries[0].target)
    assert.equal(await fs.readFile(temporary, 'utf8'), adaptHarnessFsSource(rc7Seam))
    throw failure
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(applyHarnessRuntimeAdapters(runtime), error => error === failure)
    assert.equal(rename.mock.callCount(), 1)
  } finally {
    rename.mock.restore()
    syncBuiltinESMExports()
  }
  for (const entry of entries) {
    assert.equal(await fs.readFile(entry.source, 'utf8'), entry.input)
    assert.equal(await fs.readFile(entry.target, 'utf8'), entry.input)
    assert.equal((await fs.stat(entry.target)).ino, entry.original.ino)
    assert.deepEqual(await fs.readdir(dirname(entry.target)), [entry.file])
  }
})

// 0.1.5 retires the slot-error adapter with the package it patched: the
// harness no longer ships @deepseek-ai/dsh-client-runtime and SlotsService
// supervision is native, so only the dynamic-bundle guarantee remains here.
const slotNativeRoot = process.env.EMATE_TEST_NATIVE_ROOT ?? new URL('..', import.meta.url).pathname

test('portable runtime and Desktop materialization apply the same adapter set', () => {
  const local = new URL('..', import.meta.url).pathname
  const assembly = readFileSync(join(local, 'scripts/harness-runtime-adapters.mjs'), 'utf8')
  const desktop = readFileSync(join(local, 'scripts/harness-provenance.mjs'), 'utf8')
  const build = readFileSync(join(local, 'scripts/build-harness-runtime.mjs'), 'utf8')
  const shared = [
    'adaptHarnessFsBytesSource',
    'adaptHarnessSessionExportSource',
    'adaptHarnessArtifactLinksSource',
    'adaptHarnessArtifactDeliverablesSource',
    'adaptHarnessConversationSource',
    'adaptHarnessSessionTitleSource',
  ]
  for (const name of shared) {
    assert.match(desktop, new RegExp(`${name}\\(readFileSync`, 'u'), `${name} must adapt the Desktop materialization source`)
    assert.match(assembly, new RegExp(`${name}\\(await readFile`, 'u'), `${name} must adapt the portable runtime source`)
  }
  // The escalation adapter owns the copied tool-fs lib only; the Desktop
  // materialization resolves the same bytes through its own tree.
  assert.match(assembly, /adaptHarnessFsSource\(await readFile\(fsTarget/u)
  assert.match(build, /adapters_sha256: sha256\(adaptersPath\)/u)
  assert.match(build, /conversation_client_sha256/u)
})

test('native browser fetches SlotsService as a client plugin bundle, not a Vite source singleton', () => {
  const native = join(slotNativeRoot, 'upstream/deepseek-harness')
  const runtime = JSON.parse(readFileSync(join(native, 'packages/client/ui-renderer/package.json'), 'utf8'))
  assert.equal(runtime.exports['./client'].default, './lib/client.js')
  assert.equal(runtime.dsh.client.immediately, true)
  const seed = readFileSync(join(native, 'packages/client/web/src/seed.ts'), 'utf8')
  assert.doesNotMatch(seed, /@deepseek-ai\/dsh-client-runtime/u)
  const vite = readFileSync(join(native, 'apps/web/vite.config.ts'), 'utf8')
  assert.doesNotMatch(vite, /packages\/client\/ui-renderer\/src/u)
  const loader = readFileSync(join(native, 'packages/client/modules/src/client/system.ts'), 'utf8')
  assert.match(loader, /transport = this\.loadBundle\(url\)/u)
  const manifest = readFileSync(join(native, 'packages/client/modules/src/client/manifest.ts'), 'utf8')
  assert.match(manifest, /export function stripClientSuffix/u)
})


const titleNativeRoot = process.env.EMATE_TEST_NATIVE_ROOT ?? new URL('..', import.meta.url).pathname
const titleEntry = join(titleNativeRoot, 'upstream/deepseek-harness/packages/session/session-title/lib/index.js')
const titleNativeSource = readFileSync(titleEntry, 'utf8')
const titleRequire = createRequire(titleEntry)
const titleImport = name => import(pathToFileURL(titleRequire.resolve(name)).href)

async function titleHarness(mode = 'first-prompt', generate) {
  const [
    { Context }, { default: SessionStore, SessionId }, { createUserMessage }, { default: SessionProjection },
  ] = await Promise.all([
    titleImport('@deepseek-ai/cordis'), titleImport('@deepseek-ai/dsh-session'),
    titleImport('@deepseek-ai/dsh-llm'), titleImport('@deepseek-ai/dsh-session-projection'),
  ])
  const source = adaptHarnessSessionTitleSource(titleNativeSource).replace(/from "([^".][^"]*)"/gu,
    (_match, specifier) => `from ${JSON.stringify(pathToFileURL(titleRequire.resolve(specifier)).href)}`)
  const { default: TitleService } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  // 0.1.5 injects the projection seam, so the title fiber stays pending until
  // the registry is mounted and would never publish ctx.sessionTitle otherwise.
  await ctx.plugin(SessionProjection)
  await ctx.plugin(TitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  const calls = []
  ctx.sessionTitle.register({ id: 'test-title', automatic: mode, generate: async request => {
    calls.push(request)
    return generate ? generate(request) : { title: 'Generated long title', messageSeqs: request.messages.map(message => message.seq) }
  } })
  let serial = 0
  return {
    ctx, calls,
    create: () => ctx.sessions.create(SessionId(`title-adapter-${++serial}`)),
    prompt: (session, text, extra = {}) => session.append('user/message', createUserMessage({
      role: 'user', content: [{ type: 'text', text }, ...(extra.blocks ?? [])],
      source: { kind: 'user', ...(extra.mentions ? { mentions: extra.mentions } : {}) },
    }), { surfaceOp: 'append' }),
    route: session => session.append('request/header', { header: { config: { provider: 'test', model: 'test' } }, reason: 'initial' }),
  }
}
const settleTitle = () => new Promise(resolve => setImmediate(resolve))

test('title adapter preserves short human titles using native budgets and keeps long, multiline and attachment requests', async () => {
  const h = await titleHarness()
  try {
    for (const [text, extra, shouldGenerate] of [
      ['你好', {}, false], ['修复登录', {}, false], ['Fix login', {}, false],
      ['a b c d e', {}, false], ['a'.repeat(40), {}, false], ['中'.repeat(13), {}, false],
      ['a b c d e f', {}, true], ['a'.repeat(41), {}, true], ['中'.repeat(14), {}, true],
      ['hello\nworld', {}, true], ['hello\u2028world', {}, true],
      ['你好', { blocks: [{ type: 'image', attachmentId: 'sha256:test', mediaType: 'image/png' }] }, true],
      ['report', { mentions: [{ source: 'e-mate/file-import', ref: 'fixture' }] }, true],
    ]) {
      const session = h.create(), before = h.calls.length
      h.prompt(session, text, extra)
      h.route(session)
      await settleTitle()
      assert.equal(h.calls.length - before, shouldGenerate ? 1 : 0, text)
      const title = h.ctx.sessionTitle.get(session)
      assert.equal(title.source.kind, shouldGenerate ? 'provider' : 'fallback', text)
      if (!shouldGenerate) assert.equal(title.title, text)
      // A later request header must not replay the consumed/skipped automatic job.
      h.route(session)
      await settleTitle()
      assert.equal(h.calls.length - before, shouldGenerate ? 1 : 0)
    }
  } finally { await h.ctx.fiber.dispose() }
})

test('title adapter leaves explicit refresh, all-prompts and manually pinned titles native', async () => {
  const h = await titleHarness()
  try {
    const session = h.create()
    h.prompt(session, '你好'); h.route(session); await settleTitle()
    assert.equal(h.calls.length, 0)
    await h.ctx.sessionTitle.refresh(session)
    assert.equal(h.calls.length, 1)
    await h.ctx.sessionTitle.rename(session, 'My title')
    h.prompt(session, 'a lengthy new user prompt that requires a generated title')
    h.route(session); await settleTitle()
    assert.equal(h.ctx.sessionTitle.get(session).title, 'My title')
    assert.equal(h.calls.length, 1)
  } finally { await h.ctx.fiber.dispose() }
  const all = await titleHarness('all-prompts')
  try {
    const session = all.create()
    all.prompt(session, '你好'); all.route(session); await settleTitle()
    assert.equal(all.calls.length, 1)
  } finally { await all.ctx.fiber.dispose() }
})

test('title adapter refuses absent, duplicated or already adapted native seams', () => {
  assert.throws(() => adaptHarnessSessionTitleSource('future source'), /seam, found 0/)
  assert.throws(() => adaptHarnessSessionTitleSource(titleNativeSource + titleNativeSource), /seam, found 2/)
  assert.throws(() => adaptHarnessSessionTitleSource(adaptHarnessSessionTitleSource(titleNativeSource)), /seam, found 0/)
})


test('title adapter keeps an in-flight provider result from overwriting a manual rename', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const h = await titleHarness('first-prompt', async request => {
    await gate
    return { title: 'late unrelated title', messageSeqs: request.messages.map(message => message.seq) }
  })
  try {
    const session = h.create()
    h.prompt(session, 'This is a detailed task description exceeding the fallback word budget')
    h.route(session); await settleTitle()
    assert.equal(h.calls.length, 1)
    h.ctx.sessionTitle.rename(session, 'User title')
    assert.equal(h.calls[0].signal.aborted, true)
    release(); await settleTitle()
    assert.equal(h.ctx.sessionTitle.get(session).title, 'User title')
    assert.equal(h.ctx.sessionTitle.get(session).source.kind, 'user')
  } finally { release(); await h.ctx.fiber.dispose() }
})
