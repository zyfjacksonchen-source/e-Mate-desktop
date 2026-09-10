import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { Script } from 'node:vm'
import { createRequire } from 'node:module'
import { adaptHarnessConversationSource } from './harness-conversation-adapter.mjs'
import { adaptHarnessArtifactLinksSource, adaptHarnessArtifactDeliverablesSource } from './harness-artifact-links-adapter.mjs'

const native = readFileSync(process.env.EMATE_TEST_NATIVE_ROOT ? join(process.env.EMATE_TEST_NATIVE_ROOT, 'upstream/deepseek-harness/packages/client/ui-conversation/lib/client.js') : new URL('../upstream/deepseek-harness/packages/client/ui-conversation/lib/client.js', import.meta.url), 'utf8')
const adapted = adaptHarnessConversationSource(native)

test('terminal errors remain visible after retries through native replay, append and paged prepend', () => {
  const root = process.env.EMATE_TEST_NATIVE_ROOT ?? new URL('..', import.meta.url).pathname
  const harness = join(root, 'upstream/deepseek-harness')
  const requireNative = createRequire(join(harness, 'packages/client/ui-conversation/package.json'))
  let runtime
  new Function('window', readFileSync(join(harness, 'packages/client/runtime/lib/client.js'), 'utf8'))({ __ModuleLoader__: { load: module => { runtime = module.factory(requireNative) } } })
  const region = (source, name) => {
    const start = source.indexOf('//#region lib/types/client/' + name + '.js')
    assert(start >= 0, name)
    return source.slice(start, source.indexOf('//#endregion', start))
  }
  const definitions = source => new Function('_deepseek_ai_dsh_client_runtime_client', [
    region(source, 'conversation-nodes/common'),
    region(source, 'contract/chat-nodes'),
    region(source, 'conversation-nodes/chat-snapshot-builder'),
    region(source, 'conversation-nodes/retry'),
    region(source, 'conversation-nodes/turn-error'),
    'return { retryDefinition, turnErrorDefinition, chatViewDefinition }',
  ].join('\n'))(runtime)
  const assembler = source => {
    const d = definitions(source)
    return new runtime.ConversationNodeAssembler(
      { entries: () => [d.retryDefinition, d.turnErrorDefinition], fallbackEntry: () => undefined },
      { entries: () => [d.chatViewDefinition] },
    )
  }
  const event = (seq, type, data) => ({ event: { seq, type, time: 1000 + seq, data } })
  const finalError = { code: 'PI_AI_ERROR', message: 'OpenAI API error (409): INVOCATION_RECONCILIATION_REQUIRED' }
  const start = [event(180, 'turn/start', { turn: 7 }), event(182, 'step/start', { turn: 7, step: 1 })]
  const retry = [
    event(189, 'llm/retry', { retryId: 'retry-7', turn: 7, step: 1, provider: 'fake', mode: 'normal', policyKey: 'fake', retry: 1, maxRetries: 2, delayMs: 540,
      failure: { code: 'SERVER', message: 'OpenAI API error (502): UPSTREAM_REJECTED' } }),
    event(190, 'llm/retry-started', { retryId: 'retry-7', turn: 7, step: 1, retry: 1 }),
  ]
  const end = reason => [event(193, 'step/end', { turn: 7, step: 1 }), event(194, 'turn/end', { turn: 7, reason })]
  const nodes = value => value.snapshot('chat').nodes.values()
  const terminal = value => nodes(value).filter(node => node.kind === 'turn-error' && node.visibility === 'visible')
  const assertFailure = value => {
    assert.equal(terminal(value).length, 1)
    assert.deepEqual(terminal(value)[0].data, { kind: 'turn-error', seq: 194, time: 1194, turn: 7, step: 1, ...finalError })
  }
  // Prove the pinned behavior loses the terminal error for this exact retry shape.
  const before = assembler(native)
  before.replaceWindow([...start, ...retry, ...end({ kind: 'error', error: finalError })], false); before.flush()
  assert.equal(terminal(before).length, 0)
  for (const withRetry of [false, true]) {
    for (const mode of ['replay', 'append', 'paged']) {
      for (const failed of [false, true]) {
        const entries = [...start, ...(withRetry ? retry : []), ...end(failed ? { kind: 'error', error: finalError } : { kind: 'completed' })]
        const value = assembler(adapted)
        if (mode === 'append') {
          for (const entry of entries) {
            value.append(entry); value.flush()
            if (entry.event.type !== 'turn/end') assert.equal(terminal(value).length, 0)
          }
        } else if (mode === 'paged') {
          const cut = withRetry ? 3 : 2
          value.replaceWindow(entries.slice(cut), true); value.flush()
          if (failed) assertFailure(value)
          else assert.equal(terminal(value).length, 0)
          value.prepend(entries.slice(0, cut), false); value.flush()
        } else {
          value.replaceWindow(entries, false); value.flush()
        }
        if (failed) assertFailure(value)
        else assert.equal(terminal(value).length, 0)
        const retries = nodes(value).filter(node => node.kind === 'model-retry')
        assert.equal(retries.length, withRetry ? 1 : 0)
        if (withRetry) assert.equal(retries[0].data.current.failure.code, 'SERVER')
      }
    }
  }
})

// Execute the actual transformed native machine/facade/hub. The only fixture is
// its observable-store dependency; no substitute input machine or send path.
const section = (start, end) => adapted.slice(adapted.indexOf(start), adapted.indexOf(end))
const owners = new Function('_deepseek_ai_dsh_client_runtime_client', [
  section('function emateDraftFiles(', '\t\t//#endregion'),
  section('\t\t//#region lib/types/client/queue/store.js', '\t\t//#region ../../../vendor/cosmokit/src/misc.ts'),
  'return { SessionInputShell, InputHub, createChatStore, emateDraftImages, emateImportedText, emateFileDisplay, emateQueuePreview, emateArtifactFileMentions, emateCanvasNavigationRequest, emateCanvasBeforeView, emateAssistantImageBlocks }',
].join('\n'))({
  defineStore: value => value,
  createSnapshotStore(initial) {
    let state = initial
    return { getSnapshot: () => state, set: value => { state = value }, subscribe: () => () => {} }
  },
})

const file = (stored = '报告_带空格_验证.txt', display = '报告 带空格@验证.txt') => ({
  stored_name: stored, display_name: display, media_type: 'text/plain', relative_path: '.e-mate/imports/' + stored,
})
const imageRef = (bytes = 1, digit = 'a') => ({
  attachmentId: `sha256:${digit.repeat(64)}`, mediaType: 'image/png', bytes, width: 1, height: 1, name: '像素.png',
})
const draftImage = (key = '00000000-0000-4000-8000-000000000001', attachment = imageRef()) => ({ schema_version: 1, draft_key: key, attachment })
function setup(sendSession = async () => {}) {
  const released = []
  const conversation = { sendSession, releaseDraftImage(id) { released.push(id) } }
  const hub = new owners.InputHub({ get: name => name === 'conversation' ? conversation : undefined }, value => value)
  const session = { sessionId: 'one' }
  const shell = new owners.SessionInputShell({
    actx: {}, defaultSink: (text, ids, mode, mentions) => hub.sink(session, text, ids, mode, mentions),
  })
  hub.shells.set('one', shell)
  return { shell, hub, released }
}

test('every pinned seam fails closed on missing, duplicate or already adapted input', () => {
  assert.doesNotThrow(() => new Script(adapted))
  const terminalSeam = native.slice(native.indexOf('if (!state.hidden) return chatNode'), native.indexOf('\n\t\t\t}', native.indexOf('if (!state.hidden) return chatNode')))
  for (const replacement of ['', terminalSeam + terminalSeam]) {
    assert.throws(() => adaptHarnessConversationSource(native.replace(terminalSeam, replacement)), /turn-error\/terminal-after-retry: expected one rc\.7 seam/u)
  }
  assert.throws(() => adaptHarnessConversationSource('future'), /expected one rc\.7 seam/u)
  assert.throws(() => adaptHarnessConversationSource(native + native), /found 2/u)
  assert.throws(() => adaptHarnessConversationSource(adapted), /expected one rc\.7 seam/u)
  assert.match(adapted, /const empty = .*input\?\.fileRefs.length/u)
  assert.match(adapted, /inputActions.restoreDraft\(storedDraft, storedFiles \?\? \[\], storedImages \?\? \[\]\)/u)
  assert.match(adapted, /const storedImages = useStore\(\(s\) => s\.imageRefs\)/u)
  assert.match(adapted, /inputState\.fileRefs\.length === 0 && inputState\.imageRefs\.length === 0/u)
  assert.match(adapted, /const durableImages = shell\?\.commitSend\(imageIds, files\) \?\? \[\]/u)
  assert.match(adapted, /shell\?\.restoreImages\(imageIds, durableImages\)/u)
  assert.match(adapted, /this\.durableImages\.flatMap\(item =>/u)
  assert.match(adapted, /write\(this\.snapshot\.draft, this\.fileRefs, this\.durableImages\)/u)
  assert.throws(() => adaptHarnessConversationSource(native.replace('}, InputBar);', '}, ChangedInputBar);')), /apply\/composer-body: expected one rc\.7 seam/u)
  assert.match(adapted, /"e-mate\.conversation\.composer": \{ kind: "single", scope: "session-maybe" \}/u)
})

test('live image tail keeps the native definition and fails closed when its pinned seams change', () => {
  for (const [seam, owner] of [
    ['kind: "turn-tail",', 'images/job-tail-match'],
    ['function closingAnchor(context) {', 'images/live-tail-anchor'],
    ['if (end?.event.type !== "turn/end") return null;', 'images/live-tail-data'],
  ]) {
    assert.throws(() => adaptHarnessConversationSource(native.replace(seam, 'changed seam')), error =>
      error.message.includes(owner + ': expected one rc.7 seam'))
  }
  const definition = bundle => {
    const start = bundle.indexOf('//#region lib/types/client/conversation-nodes/turn-tail.js')
    return new Function('_deepseek_ai_dsh_client_runtime_client', 'deriveTurnMetrics', 'CHAT_SYNTHETIC_SEQ_OFFSETS',
      bundle.slice(start, bundle.indexOf('//#endregion', start)) + '\nreturn { turnTailDefinition, closingAnchor }',
    )({ isAppendSurfaceEvent: event => event.surfaceOp === 'append', toAssistantBlocks: content => content },
      () => new Map(), { finalizedFollowup: 0.1 })
  }
  const original = definition(native), live = definition(adapted)
  const start = { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }
  const assistant = { type: 'assistant/message', seq: 2, time: 2, surfaceOp: 'append', data: {
    turn: 1, step: 1, message: { content: [{ kind: 'text', text: '正在生成。' }] },
  } }
  const call = { type: 'tool/call', seq: 3, time: 3, data: { turn: 1, step: 1 } }
  const context = (imageTool, status = 'open', matches = [assistant, call]) => {
    const turn = { turn: 1, status, steps: [{ data: new Map([['assistant-step', {
      finalNode: { seq: 2 }, blocks: [{ kind: 'text', text: '正在生成。' }],
    }]]) }], data: new Map([['deliverables', { produced: [{ path: 'report.pdf', seq: 3 }] }]]) }
    const location = { kind: 'turn', turn }
    return { start: { event: start, location }, matches: matches.map(event => ({
      event: event.type === 'tool/call' ? { ...event, data: { ...event.data, name: imageTool ?? 'read_file' } } : event,
      location,
    })), state: { turn: 1 } }
  }
  const data = ctx => live.turnTailDefinition.buildLocationData(ctx, 'turn')
  assert.equal(data(context(undefined)), null, 'ordinary file/text turn stays closed-only')
  assert.equal(data(context('subagent')), null, 'background work does not claim a direct image tail')
  assert.equal(data(context('imagegen', 'closed')), null, 'missing closed boundary is not a live tail')
  assert.equal(data({ matches: [] }), null, 'missing Turn is not inferred')
  for (const imageTool of ['generate_image', 'edit_image', 'get_image_generation_task', 'imagegen', 'image_batch']) {
    const ctx = context(imageTool)
    assert.deepEqual(data(ctx).value, { turn: 1, seq: 3, time: 3, closing: null, branchUnavailable: true })
    assert.equal(live.closingAnchor(ctx), 3.1)
  }
  const receipt = { type: 'emate/image-output', seq: 4, time: 4, data: { schema_version: 3, turn: 1, tool_name: 'generate_image' } }
  assert.deepEqual(live.turnTailDefinition.match(receipt), { id: '1', role: 'update' })
  assert.equal(data(context('run_code', 'open', [assistant, call, receipt])).value.seq, 4)
  assert.equal(live.turnTailDefinition.match({ ...receipt, data: { ...receipt.data, turn: undefined } }), null)
  const result = { type: 'tool/result', seq: 4, time: 4, surfaceOp: 'append', data: { turn: 1, message: { content: [
    { type: 'tool-result', isError: false, content: [{ type: 'image', attachment: imageRef() }] },
  ] } } }
  assert.equal(data(context(undefined, 'open', [assistant, call, result])).value.seq, 4)
  result.data.message.content[0].isError = true
  assert.equal(data(context(undefined, 'open', [assistant, call, result])), null)
  for (const ending of ['completed', 'error', 'interrupted']) {
    const end = { type: 'turn/end', seq: 8, time: 8, data: { turn: 1, reason: { kind: ending } } }
    const ctx = context('imagegen', 'closed', [assistant, call, end])
    assert.deepEqual(data(ctx), original.turnTailDefinition.buildLocationData(ctx, 'turn'))
    assert.equal(live.closingAnchor(ctx), original.closingAnchor(ctx), 'closed prose anchor remains native')
    assert.equal(live.turnTailDefinition.publication({ event: end }), 'immediate')
  }
  assert.equal(live.turnTailDefinition.publication({ event: call }), original.turnTailDefinition.publication({ event: call }))
  assert.equal(live.turnTailDefinition.publication({ event: result }), original.turnTailDefinition.publication({ event: result }))
})

test('native scoped chat store persists one file list, cold restores names, and removes only the selected ref', () => {
  const store = owners.createChatStore()
  assert.equal(store.persist, 'dsh.conversation.chat')
  const persisted = store.init()
  const { shell } = setup()
  shell.bindMirror((text, files) => store.actions.setDraft(persisted, text, files))
  shell.addFiles([file(), file('报告_带空格_验证-2.txt')], '请读')
  assert.equal(shell.snapshot.draft, '请读')
  assert.equal(persisted.fileRefs.length, 2)
  const cold = setup().shell
  cold.restoreDraft(persisted.draft, JSON.parse(JSON.stringify(persisted.fileRefs)))
  assert.equal(cold.snapshot.fileRefs[0].display_name, '报告 带空格@验证.txt')
  cold.removeFile(file().relative_path)
  assert.deepEqual(cold.snapshot.fileRefs.map(value => value.stored_name), ['报告_带空格_验证-2.txt'])
  assert.equal(cold.snapshot.draft, '请读')
  assert.equal(shell.snapshot.fileRefs.length, 2)
  assert.throws(() => cold.addFiles([{ ...file(), relative_path: '../secret.txt' }]), /附件草稿无效/u)
  const damaged = setup().shell
  damaged.restoreDraft('正文必须保留', [{ ...file(), relative_path: '../secret.txt' }])
  assert.equal(damaged.snapshot.draft, '正文必须保留')
  assert.match(damaged.notices.getSnapshot().text, /附件草稿无法恢复/u)
})

test('mirror bind repairs corrupt persisted images once and adopts sanitized current state', () => {
  const store = owners.createChatStore()
  const persisted = store.init()
  const validFile = file()
  store.actions.setDraft(persisted, '正文保留', [validFile], [{ ...draftImage(), attachment: { ...imageRef(), bytes: 0 } }])

  const first = setup().shell
  first.restoreDraft(persisted.draft, persisted.fileRefs, persisted.imageRefs)
  assert.match(first.notices.getSnapshot().text, /图片草稿无法恢复/u)
  const unbind = first.bindMirror((text, files, images) => store.actions.setDraft(persisted, text, files, images))
  assert.equal(persisted.draft, '正文保留')
  assert.deepEqual(persisted.fileRefs, [validFile])
  assert.deepEqual(persisted.imageRefs, [])
  unbind()

  const second = setup().shell
  second.restoreDraft(persisted.draft, persisted.fileRefs, persisted.imageRefs)
  second.bindMirror((text, files, images) => store.actions.setDraft(persisted, text, files, images))
  assert.equal(second.notices.getSnapshot(), null)
  assert.equal(second.snapshot.draft, '正文保留')
  assert.deepEqual(second.snapshot.fileRefs, [validFile])
  assert.deepEqual(second.snapshot.imageRefs, [])

  const validPersisted = store.init()
  store.actions.setDraft(validPersisted, '冷恢复', [validFile], [draftImage()])
  const valid = setup().shell
  valid.restoreDraft(validPersisted.draft, validPersisted.fileRefs, validPersisted.imageRefs)
  valid.hydrateDurableImage(draftImage().draft_key, 'fresh-runtime-id')
  valid.bindMirror((text, files, images) => store.actions.setDraft(validPersisted, text, files, images))
  assert.deepEqual(validPersisted.imageRefs, [draftImage()])
  assert.doesNotMatch(JSON.stringify(validPersisted), /fresh-runtime-id|blob:|base64|previewUrl/u)
})

test('durable image metadata persists without runtime ids and cold hydration creates fresh ordered ids', () => {
  const store = owners.createChatStore()
  const persisted = store.init()
  const first = setup().shell
  first.bindMirror((text, files, images) => store.actions.setDraft(persisted, text, files, images))
  const firstDraft = draftImage()
  const secondDraft = draftImage('00000000-0000-4000-8000-000000000002', imageRef(2, 'b'))
  assert.equal(first.addDurableImages([firstDraft, secondDraft], ['runtime-old-a', 'runtime-old-b']), true)
  assert.deepEqual(persisted.imageRefs, [firstDraft, secondDraft])
  assert.deepEqual(Object.keys(persisted.imageRefs[0]).sort(), ['attachment', 'draft_key', 'schema_version'])
  const persistedJson = JSON.stringify(persisted)
  assert.match(persistedJson, /sha256:[a-f0-9]{64}/u)
  assert.doesNotMatch(persistedJson, /runtime-old|blob:|base64|data:|previewUrl|arrayBuffer|lastModified/u)

  const cold = setup().shell
  cold.restoreDraft('正文', [file()], JSON.parse(JSON.stringify(persisted.imageRefs)))
  assert.deepEqual(cold.snapshot.imageIds, [])
  assert.deepEqual(cold.snapshot.hydratedImageKeys, [])
  cold.submit()
  const notice = cold.notices.getSnapshot()
  cold.submit()
  assert.equal(cold.notices.getSnapshot().seq, notice.seq)
  assert.match(notice.text, /正在恢复/u)
  assert.equal(cold.hydrateDurableImage(secondDraft.draft_key, 'runtime-new-b'), true)
  assert.deepEqual(cold.snapshot.imageIds, ['runtime-new-b'])
  assert.equal(cold.hydrateDurableImage(firstDraft.draft_key, 'runtime-new-a'), true)
  assert.deepEqual(cold.snapshot.imageIds, ['runtime-new-a', 'runtime-new-b'])
  assert.deepEqual(cold.snapshot.hydratedImageKeys, [firstDraft.draft_key, secondDraft.draft_key])
  assert.deepEqual(cold.snapshot.imageRefs, [firstDraft, secondDraft])
})

test('durable image parser preserves valid text and files while rejecting duplicates and exact hard-limit overflow', () => {
  const shell = setup().shell
  shell.restoreDraft('正文保留', [file()], [{ ...draftImage(), attachment: { ...imageRef(), bytes: 0 } }])
  assert.equal(shell.snapshot.draft, '正文保留')
  assert.equal(shell.snapshot.fileRefs.length, 1)
  assert.deepEqual(shell.snapshot.imageRefs, [])
  assert.match(shell.notices.getSnapshot().text, /图片草稿无法恢复/u)
  assert.throws(() => owners.emateDraftImages([draftImage(), draftImage()]), /图片草稿无效/u)
  for (const attachment of [
    { ...imageRef(), width: 40_000_001 }, { ...imageRef(), width: 10_000, height: 4_001 },
    { ...imageRef(), name: '.' }, { ...imageRef(), name: 'e\u0301.png' }, { ...imageRef(), name: `${'界'.repeat(84)}.png` },
  ]) assert.throws(() => owners.emateDraftImages([draftImage(undefined, attachment)]), /图片草稿无效/u)
  assert.equal(owners.emateDraftImages([draftImage('00000000-0000-4000-8000-000000000001', imageRef(5 * 1024 * 1024))])[0].attachment.bytes, 5 * 1024 * 1024)
  assert.throws(() => owners.emateDraftImages([draftImage('00000000-0000-4000-8000-000000000001', imageRef(5 * 1024 * 1024 + 1))]), /图片草稿无效/u)
  const twenty = Array.from({ length: 20 }, (_, index) => draftImage(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, imageRef(5 * 1024 * 1024, index % 2 ? 'a' : 'b')))
  assert.equal(owners.emateDraftImages(twenty).length, 20)
  assert.throws(() => owners.emateDraftImages([...twenty, draftImage('00000000-0000-4000-8000-000000000020')]), /图片草稿无效/u)
})

test('removing durable images clears associations and mirrors refs but no native ids', () => {
  const store = owners.createChatStore()
  const persisted = store.init()
  const shell = setup().shell
  shell.bindMirror((text, files, images) => store.actions.setDraft(persisted, text, files, images))
  shell.addImages(['runtime-only'])
  shell.addDurableImages([draftImage()], ['runtime-durable'])
  shell.removeImage('runtime-durable')
  assert.deepEqual(shell.snapshot.imageIds, ['runtime-only'])
  assert.deepEqual(shell.snapshot.imageRefs, [])
  assert.deepEqual(persisted.imageRefs, [])
  assert.deepEqual(shell.snapshot.runtimeOnlyImageIds, ['runtime-only'])
  assert.doesNotMatch(JSON.stringify(persisted), /runtime-only|runtime-durable/u)
})

test('runtime image-stage reservation blocks submit and clears on failure or association', () => {
  const sent = []
  const store = owners.createChatStore()
  const persisted = store.init()
  const { shell } = setup(async (...args) => { sent.push(args) })
  shell.bindMirror((text, files, images) => store.actions.setDraft(persisted, text, files, images))
  shell.setDraft('待发送')
  assert.equal(shell.actions.beginImageStage(), true)
  assert.equal(shell.snapshot.imageStagePending, true)
  assert.doesNotMatch(JSON.stringify(persisted), /imageStagePending|runtime-only/u)
  shell.actions.submit()
  shell.submit('steer')
  assert.deepEqual(sent, [])
  shell.actions.cancelImageStage()
  assert.equal(shell.snapshot.imageStagePending, false)
  shell.submit()
  assert.equal(sent.length, 1)

  const successful = setup(async (...args) => { sent.push(args) }).shell
  successful.setDraft('带图')
  assert.equal(successful.actions.beginImageStage(), true)
  assert.equal(successful.actions.addDurableImages([draftImage()], ['staged-id']), true)
  assert.equal(successful.snapshot.imageStagePending, false)
  successful.actions.submit()
  assert.equal(sent.at(-1)[2][0], 'staged-id')
})

test('native registry pruning retains refs but makes the missing association pending', () => {
  const shell = setup().shell
  const drafts = [draftImage(), draftImage('00000000-0000-4000-8000-000000000002', imageRef(2, 'b'))]
  shell.addDurableImages(drafts, ['id-a', 'id-b'])
  shell.pruneImages(['id-b'])
  assert.deepEqual(shell.snapshot.imageRefs, drafts)
  assert.deepEqual(shell.snapshot.imageIds, ['id-b'])
  assert.deepEqual(shell.snapshot.hydratedImageKeys, [drafts[1].draft_key])
  shell.submit()
  assert.match(shell.notices.getSnapshot().text, /正在恢复/u)
})

test('file-only submit and mixed steering use the native sink and exact paths', async () => {
  const sent = []
  const { shell } = setup(async (...args) => { sent.push(args) })
  shell.addFiles([file()])
  shell.submit()
  assert.equal(sent[0][1], '@.e-mate/imports/报告_带空格_验证.txt')
  assert.equal(sent[0][3], 'queue')
  assert.deepEqual(Object.keys(sent[0][4][0]), ['source', 'ref'])
  assert.equal(JSON.parse(sent[0][4][0].ref).display_name, '报告 带空格@验证.txt')
  assert.deepEqual(shell.snapshot.fileRefs, [])
  shell.addFiles([file('next.txt', 'next.txt')])
  shell.addImages(['native-image'])
  shell.setDraft('继续')
  shell.submit('steer')
  assert.equal(sent[1][1], '继续\n@.e-mate/imports/next.txt')
  assert.deepEqual(sent[1][2], ['native-image'])
  assert.equal(sent[1][3], 'steer')
})

test('durable image send clears refs on success and same-shell failure restores refs with ids', async () => {
  const rc7Rollback = '\t\t\t\t\t\tshell?.restoreImages(imageIds);\n\t\t\t\t\t\tif (shell?.snapshot.draft === "") shell.setDraft(text);'
  const durableRollback = '\t\t\t\t\t\tshell?.restoreFiles(files);\n\t\t\t\t\t\tshell?.restoreImages(imageIds, durableImages);\n\t\t\t\t\t\tif (shell?.snapshot.draft === "") shell.setDraft(draftText);'
  assert.equal(native.includes(rc7Rollback), true)
  assert.equal(adapted.includes(rc7Rollback), false)
  assert.equal(adapted.includes(durableRollback), true)

  const successStore = owners.createChatStore()
  const successPersisted = successStore.init()
  const successful = setup()
  successful.shell.bindMirror((text, files, images) => successStore.actions.setDraft(successPersisted, text, files, images))
  successful.shell.addDurableImages([draftImage()], ['success-id'])
  successful.shell.submit()
  assert.deepEqual(successful.shell.snapshot.imageRefs, [])
  assert.deepEqual(successful.shell.snapshot.imageIds, [])
  assert.deepEqual(successPersisted.imageRefs, [])

  const failedStore = owners.createChatStore()
  const failedPersisted = failedStore.init()
  let reject
  const failed = setup(() => new Promise((_resolve, fail) => { reject = fail }))
  failed.shell.bindMirror((text, files, images) => failedStore.actions.setDraft(failedPersisted, text, files, images))
  const failedDrafts = [draftImage(), draftImage('00000000-0000-4000-8000-000000000002', imageRef(2, 'b'))]
  failed.shell.addDurableImages(failedDrafts, ['failed-a', 'failed-b'])
  failed.shell.setDraft('发送')
  failed.shell.submit()
  assert.deepEqual(failed.shell.snapshot.imageRefs, [])
  assert.deepEqual(failedPersisted.imageRefs, [])
  reject(new Error('offline'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(failed.shell.snapshot.imageRefs, failedDrafts)
  assert.deepEqual(failedPersisted.imageRefs, failedDrafts)
  assert.deepEqual(failed.shell.snapshot.imageIds, ['failed-a', 'failed-b'])
  assert.deepEqual(failed.shell.snapshot.hydratedImageKeys, failedDrafts.map(item => item.draft_key))

  let rejectLate
  const late = setup(() => new Promise((_resolve, fail) => { rejectLate = fail }))
  late.shell.addDurableImages([draftImage()], ['late-id'])
  late.shell.submit()
  const replacement = setup().shell
  late.hub.shells.set('one', replacement)
  rejectLate(new Error('gone'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(late.released, ['late-id'])
  assert.deepEqual(replacement.snapshot.imageRefs, [])
})

test('failed native send restores files and images without overwriting subsequent edits or crossing sessions', async () => {
  let reject
  const { shell, hub } = setup(() => new Promise((_resolve, fail) => { reject = fail }))
  shell.addFiles([file()])
  shell.addImages(['native-image'])
  shell.setDraft('原文')
  shell.submit()
  shell.setDraft('发送后编辑')
  shell.addFiles([file('new.txt', 'new.txt')])
  reject(new Error('offline'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(shell.snapshot.draft, '发送后编辑')
  assert.equal(shell.snapshot.fileRefs.length, 2)
  assert.deepEqual(shell.snapshot.imageIds, ['native-image'])
  shell.setDraft('')
  shell.submit()
  reject(new Error('offline'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(shell.snapshot.draft, '')
  assert.equal(shell.snapshot.fileRefs.length, 2)
  shell.submit()
  const replacement = setup().shell
  hub.shells.set('one', replacement)
  reject(new Error('gone'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(replacement.snapshot.fileRefs, [])
})

test('pending steering and queue projection hide import paths while native queue edits retain them', async () => {
  const raw = `请读\n@${file().relative_path}`
  assert.equal(owners.emateFileDisplay(raw), '请读\n报告_带空格_验证.txt')
  const row = { content: [{ type: 'image' }, { type: 'text', text: raw }], preview: 'unused', text: null }
  assert.equal(owners.emateQueuePreview(row), '[image] 请读 报告_带空格_验证.txt')
  const editing = { id: 'queued-one', ...owners.emateImportedText(raw) }
  editing.text = '编辑后的正文'
  const at = adapted.indexOf('const saveEdit = async () => {')
  const body = adapted.slice(at, adapted.indexOf('\n\t\t\treturn (0, react_jsx_runtime.jsx)', at))
  let saved
  await new Function('editing', 'applyAction', 't', 'setEditing', `${body}\nreturn saveEdit();`)(
    editing, async (_id, action) => { saved = action; return true }, value => value, () => {},
  )
  assert.equal(saved.content[0].text, `编辑后的正文\n@${file().relative_path}`)
  assert.match(adapted, /children: emateQueuePreview\(row\)/u)
  assert.match(adapted, /\.\.\.editing,\s+text: event.currentTarget.value/u)
})

test('packaged runtime verifies the adapter and actual client hashes instead of falling back', () => {
  const directory = mkdtempSync(join(tmpdir(), 'emate-conversation-provenance-'))
  try {
    const source = readFileSync(new URL('../packages/dsh/src/e-mate.ts', import.meta.url), 'utf8')
    const body = source.slice(source.indexOf('function harnessFromPackage() {'), source.indexOf('\nexport function resolveHarness()'))
    const resolvePackage = new Function('packageRoot', 'join', 'existsSync', 'readJson', 'createHash', 'readFileSync', `${body}\nreturn harnessFromPackage;`)(
      directory, join, existsSync, path => JSON.parse(readFileSync(path, 'utf8')), createHash, readFileSync,
    )
    const root = join(directory, 'runtime/harness')
    const client = join(root, 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js')
    mkdirSync(join(root, 'apps/cli/lib'), { recursive: true })
    mkdirSync(join(root, 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib'), { recursive: true })
    writeFileSync(join(root, 'apps/cli/lib/bin.js'), '')
    writeFileSync(join(root, 'apps/cli/package.json'), JSON.stringify({ version: '0.1.5-rc.1' }))
    const adapter = readFileSync(new URL('./harness-conversation-adapter.mjs', import.meta.url))
    writeFileSync(join(root, 'e-mate-conversation-adapter.mjs'), adapter)
    writeFileSync(client, adapted)
    const digest = bytes => createHash('sha256').update(bytes).digest('hex')
    const artifactAdapter = readFileSync(new URL('./harness-artifact-links-adapter.mjs', import.meta.url))
    const artifactNative = readFileSync(join(process.env.EMATE_TEST_NATIVE_ROOT ?? new URL('..', import.meta.url).pathname, 'upstream/deepseek-harness/packages/client/ui-primitives/lib/index.js'), 'utf8')
    const artifactClient = adaptHarnessArtifactLinksSource(artifactNative)
    mkdirSync(join(root, 'node_modules/@deepseek-ai/dsh-client-ui-primitives/lib'), { recursive: true })
    writeFileSync(join(root, 'node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js'), artifactClient)
    writeFileSync(join(root, 'e-mate-artifact-links-adapter.mjs'), artifactAdapter)
    const manifest = { commit: 'pinned', artifact_links_adapter_sha256: digest(artifactAdapter), artifact_links_client_sha256: digest(artifactClient), conversation_adapter_sha256: digest(adapter), conversation_client_sha256: digest(adapted) }
    const additional = [
      ['artifact_deliverables_client_sha256', 'node_modules/@deepseek-ai/dsh-client-ui-deliverables/lib/client.js', 'verified deliverables fixture'],
    ]
    for (const [field, relative, bytes] of additional) {
      mkdirSync(dirname(join(root, relative)), { recursive: true })
      writeFileSync(join(root, relative), bytes)
      manifest[field] = digest(bytes)
    }
    writeFileSync(join(directory, 'runtime/source-manifest.json'), JSON.stringify(manifest))
    assert.equal(resolvePackage().source, 'packaged-runtime')
    for (const [field, relative, bytes] of additional) {
      writeFileSync(join(root, relative), 'changed')
      assert.throws(resolvePackage, /provenance is missing or mismatched/u)
      writeFileSync(join(root, relative), bytes)
      const missing = { ...manifest }; delete missing[field]
      writeFileSync(join(directory, 'runtime/source-manifest.json'), JSON.stringify(missing))
      assert.throws(resolvePackage, /provenance is missing or mismatched/u)
      writeFileSync(join(directory, 'runtime/source-manifest.json'), JSON.stringify(manifest))
      assert.equal(resolvePackage().source, 'packaged-runtime')
    }
    writeFileSync(client, native)
    assert.throws(resolvePackage, /provenance is missing or mismatched/u)
    writeFileSync(client, adapted)
    writeFileSync(join(root, 'e-mate-conversation-adapter.mjs'), 'changed')
    assert.throws(resolvePackage, /provenance is missing or mismatched/u)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

function pendingSave() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function nativeHeader(beforeViewNavigate) {
  const cleanups = []
  const events = new Map()
  const hooks = { useRef: value => ({ current: value }), useEffect: callback => { const cleanup = callback(); if (cleanup) cleanups.push(cleanup) }, useSyncExternalStore() {} }
  const jsx = (type, props) => ({ type, props })
  const Header = new Function('react', 'react_jsx_runtime', 'clsx', 'ConversationRoot_module_css_default', 'emateCanvasNavigationRequest', 'addEventListener', 'removeEventListener',
    section('\t\tconst DEFAULT_VIEW_ID =', '\t\tfunction ConversationSession({') + '\nreturn ConversationSessionHeader;')(
    hooks, { jsx, jsxs: jsx, Fragment: 'fragment' }, (...args) => args.filter(Boolean).join(' '), {}, owners.emateCanvasNavigationRequest, (name, callback) => events.set(name, callback), (name, callback) => { if (events.get(name) === callback) events.delete(name) },
  )
  let selected = 'e-mate-canvas', current = 'one'
  const writes = [], errors = [], opens = []
  const tree = Header({ sessionId: 'one', views: { list: () => [{ id: 'chat', label: '对话' }, { id: 'e-mate-gallery', label: '画廊' }, { id: 'e-mate-canvas', label: '画布' }], subscribe() {}, version() {} },
    useStore: selector => selector({ view: selected }), useSessions: selector => selector({ byId: { one: { id: 'one', displayTitle: 'Current task', origin: 'subagent', parentId: 'parent' }, parent: { id: 'parent', displayTitle: 'Parent task' } } }),
    useSession: selector => selector({ composerPhase: 'active', blank: false }), actions: { setView: view => { selected = view; writes.push(view) } },
    renderSlot: () => null, open(id) { opens.push(id); current = id }, t: value => value, beforeViewNavigate,
    isCurrentViewSession: () => current === 'one', reportViewError: error => errors.push(error.message),
  })
  const nodes = []
  const walk = node => { if (Array.isArray(node)) return node.forEach(walk); if (!node || typeof node !== 'object') return; nodes.push(node); walk(node.props?.children) }
  walk(tree)
  return { click: label => nodes.find(node => node.props?.role === 'tab' && node.props.children === label).props.onClick(),
    clickParent: () => nodes.find(node => node.type === 'button' && node.props.children === 'Parent task').props.onClick(),
    identityChanged: () => events.get('emate:identity-changed')?.(),
    current: () => current, opens, selected: () => selected, writes, errors, switchSession: () => { current = 'two' }, unmount: () => cleanups.forEach(callback => callback()) }
}

test('native canvas tab awaits save; conflict holds the old view and success commits its native action', async () => {
  let save = pendingSave()
  const h = nativeHeader(view => view === 'e-mate-canvas' ? undefined : save.promise)
  h.click('画廊')
  assert.equal(h.selected(), 'e-mate-canvas')
  assert.deepEqual(h.writes, [])
  save.reject(new Error('save conflict')); await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.selected(), 'e-mate-canvas')
  assert.deepEqual(h.errors, ['save conflict'])
  save = pendingSave(); h.click('对话'); save.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.writes, ['chat'])
})

test('late tab saves cannot overrule a newer click, a different session or an unmounted header', async () => {
  for (const mode of ['new-click', 'session', 'unmount']) {
    const save = pendingSave()
    const h = nativeHeader(view => view === 'e-mate-canvas' ? undefined : save.promise)
    h.click('对话')
    if (mode === 'new-click') h.click('画布')
    else if (mode === 'session') h.switchSession()
    else h.unmount()
    save.resolve(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.selected(), 'e-mate-canvas')
    assert.equal(h.writes.includes('chat'), false)
  }
})

test('only the current canvas requests a guard; ordinary tabs retain synchronous native selection', () => {
  let calls = 0
  const ctx = { get: () => ({ activeSessionId: () => 'one', beforeNavigate: () => { calls++; return Promise.resolve() } }) }
  assert.equal(owners.emateCanvasBeforeView(ctx, 'one', 'e-mate-canvas'), undefined)
  assert.equal(owners.emateCanvasBeforeView(ctx, 'two', 'chat'), undefined)
  assert.equal(owners.emateCanvasBeforeView({ get: () => undefined }, 'one', 'chat'), undefined)
  assert.equal(calls, 0)
  assert.ok(owners.emateCanvasBeforeView(ctx, 'one', 'chat') instanceof Promise)
  assert.equal(calls, 1)
  const h = nativeHeader(() => undefined)
  h.click('画廊')
  assert.equal(h.selected(), 'e-mate-gallery')
})

test('native composer hiding uses active view projection and keeps pending interaction overlays', async t => {
  const browserPath = process.env.EMATE_CANVAS_BROWSER ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (!existsSync(browserPath)) { t.skip('local component browser is unavailable'); return }
  const root = process.env.EMATE_TEST_NATIVE_ROOT ?? new URL('..', import.meta.url).pathname
  const { chromium } = await import(pathToFileURL(join(root, 'upstream/deepseek-harness/node_modules/.pnpm/node_modules/playwright/index.mjs')))
  const browser = await chromium.launch({ executablePath: browserPath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.route('**/*', route => route.abort())
  await page.setContent('<div data-conversation-scroll><div data-slot="conversation.session"><div data-emate-active-view="e-mate-canvas"></div></div><div data-composer-seat data-emate-has-interactions="false"><div data-emate-composer-fallback><textarea>untouched draft</textarea></div><div data-conversation-composer-overlay>Approval question</div></div></div>')
  const cssStart = adapted.indexOf('\t\tconst css$6 =')
  const cssEnd = adapted.indexOf('\t\t//#endregion', cssStart)
  await page.addScriptTag({ content: adapted.slice(cssStart, cssEnd) })
  assert.equal(await page.locator('[data-composer-seat]').isVisible(), false)
  await page.locator('[data-composer-seat]').evaluate(node => node.setAttribute('data-emate-has-interactions', 'true'))
  assert.equal(await page.locator('[data-conversation-composer-overlay]').isVisible(), true)
  assert.equal(await page.locator('[data-emate-composer-fallback]').isVisible(), false)
  await page.locator('[data-emate-active-view]').evaluate(node => node.setAttribute('data-emate-active-view', 'chat'))
  assert.equal(await page.locator('[data-emate-composer-fallback]').isVisible(), true)
  assert.equal(await page.locator('textarea').inputValue(), 'untouched draft')
  // These attrs are emitted by native owners; no DOM listener or duplicate
  // composer implementation supplies view or interaction state.
  assert.match(adapted, /"data-emate-active-view": active\?\.id \?\? "chat"/u)
  assert.match(adapted, /"data-emate-has-interactions": pending\.length > 0 \? "true" : "false"/u)
  assert.match(adapted, /beforeViewNavigate: \(view\) => emateCanvasBeforeView\(ctx, sessionId, view\)/u)
})

test('native parent-session breadcrumb shares the save guard and commits only after success', async () => {
  let save = pendingSave()
  const h = nativeHeader(() => save.promise)
  h.clickParent()
  assert.equal(h.current(), 'one')
  assert.deepEqual(h.opens, [])
  save.reject(new Error('conflict')); await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.current(), 'one')
  assert.deepEqual(h.errors, ['conflict'])
  save = pendingSave(); h.clickParent(); save.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.current(), 'parent')
  assert.deepEqual(h.opens, ['parent'])
})

test('tabs and parent-session clicks share one generation so only the latest destination wins', async () => {
  for (const latest of ['tab', 'parent']) {
    const save = pendingSave()
    const h = nativeHeader(() => save.promise)
    if (latest === 'tab') { h.clickParent(); h.click('画廊') }
    else { h.click('画廊'); h.clickParent() }
    save.resolve(); await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(h.opens, latest === 'parent' ? ['parent'] : [])
    assert.deepEqual(h.writes, latest === 'tab' ? ['e-mate-gallery'] : [])
  }
  const save = pendingSave()
  const h = nativeHeader(() => save.promise)
  h.clickParent(); h.switchSession(); save.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.opens, [])
})

test('identity changes invalidate native tab and breadcrumb saves even before the session or URL changes', async () => {
  for (const action of ['tab', 'parent']) {
    const save = pendingSave()
    const h = nativeHeader(() => save.promise)
    if (action === 'tab') h.click('画廊'); else h.clickParent()
    h.identityChanged(); save.resolve()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(h.writes, [])
    assert.deepEqual(h.opens, [])
    assert.equal(h.current(), 'one')
  }
  assert.match(adapted, /isCurrentViewSession:.*!document\.querySelector\("\[data-emate-identity-gate\]"\)/u)
})


test('native chat opener reports failed artifact opening through its own input notice', async () => {
  const original = adapted.slice(adapted.indexOf('openFile: (path) => {'), adapted.indexOf('loadOlder:', adapted.indexOf('openFile: (path) => {')))
  const notices = []
  const inputHub = { for: () => ({ notify: (...args) => notices.push(args) }) }
  // Both callbacks share the native apply closure's existing input hub.
  // Cordis rejects property access because the plugin cannot inject itself.
  const ctx = { get conversation() { throw Error('cannot get property "conversation" without inject') } }
  const openFile = new Function('sessions', 'sessionId', 'workspaces', 'ctx', 'inputHub', '_deepseek_ai_dsh_client_runtime_client', `return ({${original}}).openFile`)(
    { list: { getSnapshot: () => ({ byId: { current: { cwd: '/project' } } }) }, scope: () => ({}) }, 'current',
    { openPath: async () => { throw Error('synthetic missing artifact /private/not-for-ui') } },
    ctx, inputHub,
    { resolveWorkspacePath: (cwd, path) => cwd + '/' + path },
  )
  openFile('missing.pdf')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(notices, [['error', '文件不存在、已移出项目或无法打开，请检查原产物后重试。']])
})

test('native canvas header reports save failures without self-service property access', () => {
  const start = adapted.indexOf('reportViewError: (error) => {')
  const original = adapted.slice(start, adapted.indexOf('\n', start))
  const notices = []
  let scope = {}
  const report = new Function('sessions', 'sessionId', 'ctx', 'inputHub', `return ({${original}}).reportViewError`)(
    { scope: () => scope }, 'current',
    { get conversation() { throw Error('cannot get property "conversation" without inject') } },
    { for: () => ({ notify: (...args) => notices.push(args) }) },
  )
  report(Error('画布尚未保存，请重试。'))
  assert.deepEqual(notices, [['error', '画布尚未保存，请重试。']])
  scope = undefined
  report(Error('late failure'))
  assert.equal(notices.length, 1)
})


test('explicit Markdown paths reuse native chat opener without promoting unknown inline-code mentions', () => {
  const opened = []
  const mentions = owners.emateArtifactFileMentions({ get: () => ({ forClosing: () => ({ resolve: value => value === 'known.pdf' ? { open: () => opened.push('known-owner'), label: 'known', title: 'known.pdf' } : undefined }) }) }, { openFile: value => opened.push(value) })
  assert.equal(mentions.resolve('/project/copied.png'), undefined)
  mentions.resolveLink('/project/copied.png').open()
  mentions.resolveLink('known.pdf').open()
  assert.deepEqual(opened, ['/project/copied.png', 'known-owner'])
})


test('native multi-turn receipts support exact follow-up mentions without creating new deliverables', () => {
  const root = process.env.EMATE_TEST_NATIVE_ROOT ?? new URL('..', import.meta.url).pathname
  const harness = join(root, 'upstream/deepseek-harness')
  const requireNative = createRequire(join(harness, 'packages/client/ui-conversation/package.json'))
  let runtime
  new Function('window', readFileSync(join(harness, 'packages/client/runtime/lib/client.js'), 'utf8'))({ __ModuleLoader__: { load: module => { runtime = module.factory(requireNative) } } })
  const source = adaptHarnessArtifactDeliverablesSource(readFileSync(join(harness, 'packages/client/ui-deliverables/lib/client.js'), 'utf8'))
  const begin = source.indexOf('function producedPaths('), end = source.indexOf('//#region', source.indexOf('function onlyPathWithBasename('))
  const real = new Function('_deepseek_ai_dsh_client_runtime_client', source.slice(begin, end) + '\nreturn { deliverablesDefinition, selectProducedFiles, producedFileMentions }')(runtime)
  const serviceStart = source.indexOf('ctx.provide("chatFileMentions", '), serviceEnd = source.indexOf('} });', serviceStart) + 5
  let service
  new Function('ctx', 'selectProducedFiles', 'producedFileMentions', 't', source.slice(serviceStart, serviceEnd))({ get: () => undefined, provide: (_, value) => { service = value } }, real.selectProducedFiles, real.producedFileMentions, (_, args) => args.name)
  const path = 'exports/中文演示.pptx', futurePath = 'exports/未来.pptx'
  let seq = 0
  const events = []
  function event(type, data) { events.push({ seq: ++seq, type, time: seq, surfaceOp: 'append', data }) }
  function turn(number, producedPath, operation = 'write') {
    event('turn/start', { turn: number })
    if (producedPath) {
      event('tool/call', { turn: number, callId: 'office-' + number, name: 'office_' + operation })
      event('tool/result', { turn: number, message: { source: { callId: 'office-' + number }, content: [{ type: 'tool-result', isError: false }] },
        meta: { operation, format: 'pptx', job_id: 'emate-office-' + number, bytes: 100, relative_path: producedPath } })
    }
    event('assistant/message', { turn: number, message: { content: [{ type: 'text', text: '`' + (producedPath ?? path) + '`' }] } })
    event('turn/end', { turn: number, reason: { kind: 'completed' } })
  }
  turn(2, path); turn(3, path, 'read'); turn(4); turn(5, futurePath)
  for (const incremental of [false, true]) {
    // Only the view transport is a fixture: the actual rc.7 assembler owns
    // event order, turn boundaries and all deliverables Location data.
    const assembler = new runtime.ConversationNodeAssembler({ entries: () => [real.deliverablesDefinition], fallbackEntry: () => undefined },
      { entries: () => [{ target: 'chat', create: () => ({ replace: value => value, apply: value => value }) }] })
    if (incremental) for (const event of events) { assembler.append({ event }); assembler.flush() }
    else { assembler.replaceWindow(events.map(event => ({ event })), false); assembler.flush() }
    const chat = assembler.snapshot('chat'), opened = []
    const currentTurn = chat.timeline.turns.get(4), closing = events.find(event => event.type === 'assistant/message' && event.data.turn === 4)
    const owner = { turn: currentTurn, seq: closing.seq, openFile: value => opened.push(value) }
    const session = { getSnapshot: () => ({ sessionId: 'one', openState: 'open', chat }) }
    let current = 'one', binding = { session }, gated = false
    const sessions = { binding: id => id === 'one' ? binding : undefined, list: { getSnapshot: () => ({ current }) } }
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => gated ? {} : null } })
    try {
      const ctx = { get: () => service }
      const injected = adapted.slice(adapted.indexOf('fileMentions: (owner) =>'), adapted.indexOf('openFile: (path) =>', adapted.indexOf('fileMentions: (owner) =>')))
      const mentions = new Function('ctx', 'sessions', 'sessionId', 'emateArtifactFileMentions', `return ({${injected}}).fileMentions`)(ctx, sessions, 'one', owners.emateArtifactFileMentions)(owner)
      assert.equal(chat.timeline.turns.get(3).data.get('deliverables').produced[0].path, path, 'read receipt plus exact final prose remains authoritative')
      assert.equal(real.selectProducedFiles(owner), null)
      assert.equal(mentions.resolve(path)?.title, path, incremental ? 'incremental follow-up' : 'cold follow-up')
      mentions.resolve(path).open(); assert.deepEqual(opened, [path])
      assert.equal(mentions.resolve('中文演示.pptx'), undefined, 'no prior basename guessing')
      assert.equal(mentions.resolve(futurePath), undefined, 'future turn excluded')
      assert.equal(mentions.resolve('exports/unverified.pptx'), undefined)
      assert.equal(real.selectProducedFiles(owner), null, 'follow-up has no produced card')
      const old = mentions.resolve(path)
      current = 'two'; assert.equal(mentions.resolve(path), undefined); old.open(); assert.equal(opened.length, 1)
      current = 'one'; gated = true; assert.equal(mentions.resolve(path), undefined); old.open(); assert.equal(opened.length, 1)
      gated = false; binding = { session: { getSnapshot: () => ({ chat }) } }
      assert.equal(mentions.resolve(path), undefined); old.open(); assert.equal(opened.length, 1)
      binding = undefined; assert.equal(mentions.resolve(path), undefined)
    } finally { if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document }
  }
})


test('assistant echo filtering is same-turn, successful native output only and responds to late images', () => {
  const image = id => ({ kind: 'image', attachment: { attachmentId: id } })
  const text = { kind: 'text', text: '保留说明' }
  const a = image('a'), b = image('b'), c = image('c')
  const node = { location: { kind: 'turn', turn: { turn: 1 } }, data: { blocks: [text, a, b, c] } }
  const nodes = new Map()
  const snapshot = { chat: { nodes, locations: { getTurn: turn => [...nodes.keys()].filter(key => key.startsWith(turn + ':')) } } }
  const output = (id, isError = false, subCalls = []) => ({ kind: 'result', isError, content: [{ type: 'image', attachment: { attachmentId: id } }], subCalls })
  assert.deepEqual(owners.emateAssistantImageBlocks(snapshot, node), node.data.blocks)
  nodes.set('1:tool', { kind: 'tool-call', data: { root: output('a', false, [output('b', true)]) } })
  nodes.set('2:tool', { kind: 'tool-call', data: { root: output('c') } })
  assert.deepEqual(owners.emateAssistantImageBlocks(snapshot, node), [text, b, c])
  nodes.set('1:late', { kind: 'tool-call', data: { root: output('b') } })
  assert.deepEqual(owners.emateAssistantImageBlocks(snapshot, node), [text, c])
  nodes.delete('1:late')
  assert.deepEqual(owners.emateAssistantImageBlocks(snapshot, node), [text, b, c])
  nodes.set('1:receipt', { kind: 'e-mate-tool-images', visibility: 'hidden', data: { items: [
    { status: 'completed', attachment: { attachmentId: 'b' } },
    { status: 'failed', attachment: { attachmentId: 'c' } },
  ] } })
  assert.deepEqual(owners.emateAssistantImageBlocks(snapshot, node), [text, c])
  nodes.set('1:query', { kind: 'tool-call', data: { root: { kind: 'result', isError: false, content: [],
    resultView: { card: 'generic', content: [{ type: 'image', attachment: { attachmentId: 'c' } }] } } } })
  assert.deepEqual(owners.emateAssistantImageBlocks(snapshot, node), [text])
  const marker = '//#region lib/types/client/conversation-nodes/assistant.js'
  const part = value => { const start = value.indexOf(marker); assert.notEqual(start, -1); return value.slice(start, value.indexOf('//#endregion', start)) }
  assert.equal(part(adapted), part(native), 'render filtering must not change native assistant projection')
})
