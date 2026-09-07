import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PassThrough, Writable } from 'node:stream'
import * as loaderYaml from '../../../upstream/deepseek-harness/vendor/include/node_modules/js-yaml/dist/js-yaml.mjs'
import { WindowsBackend, WindowsHelperClient, sanitizeWindowsObservation } from '../src/windows.ts'

const root = new URL('../', import.meta.url)
const target = { bundleId: 'c:\\apps\\editor.exe', pid: 42, name: 'editor', executablePath: 'C:\\Apps\\editor.exe', processStartTime: '638000000000000000', windowId: 1001 }
const frame = { x: 10, y: 20, width: 800, height: 600 }
const hash = 'a'.repeat(64)
const options = { screenshot: 'none', maxNodes: 500, maxDepth: 14, maxTextBytes: 64000 }
const rawObservation = { app: target, stateHash: hash, frontmost: true, window: { id: target.windowId, title: 'Document', frame }, treeText: '[0] Window Document', truncated: false, elements: [{ index: 0, locator: [], role: 'Window', actions: [], enabled: true, focused: true, frame }], permissions: { accessibility: 'granted', screenRecording: 'granted' } }
const hiddenConfig = { actionTimeoutMs: 15000, maxNodes: 500, maxDepth: 14, maxTextBytes: 64000, interaction: { focusPolicy: 'preserve', keyboardPolicy: 'preserve', pointerInputPolicy: 'targeted', cursorVisualization: 'hidden', cursorMotionMs: 0, cursorAutoHideMs: 0 } }

function persistentHandle(reply = () => ({ ok: true, value: null }), options = {}) {
  const requests = []; const stdout = new PassThrough(); let exits; let terminated = 0; let waited = 0
  let stderrText = ''; let stderrLossy = false
  const done = new Promise(resolve => { exits = resolve })
  const respond = (request, envelope) => stdout.write(JSON.stringify({ protocolVersion: 2, requestId: request.requestId, ...envelope }) + '\n')
  const stdin = new Writable({ write(chunk, _encoding, callback) {
    const request = JSON.parse(chunk.toString()); requests.push(request); callback()
    queueMicrotask(() => {
      if (request.command === 'hello') respond(request, options.hello ?? { ok: true, value: { helperVersion: '1.0.0', protocolVersion: 2 } })
      else { const result = reply(request, { respond, stdout }); if (result !== undefined) respond(request, result) }
    })
  } })
  const handle = { pid: 123, stdin, stdout, done, collected: { stderr: { readFrom: () => ({ text: stderrText, lossy: stderrLossy, nextOffset: Buffer.byteLength(stderrText) }) } },
    terminate() { terminated += 1; exits({ exitCode: 1, signal: null }) }, async waitForExit() { waited += 1; return options.reaped !== false } }
  return { handle, requests, respond, stdout, terminated: () => terminated, waited: () => waited, exit: () => exits({ exitCode: 2, signal: null }), stderr(text, lossy = false) { stderrText = text; stderrLossy = lossy } }
}
async function withClient(callback, reply, settings = {}) {
  const managedRoot = await fixtureRoot(); const calls = []; const checked = []; const children = []
  const client = new WindowsHelperClient({ subprocess: { spawn(spec) { calls.push(spec); const child = persistentHandle(reply, settings); children.push(child); return child.handle } } }, settings.timeoutMs ?? 15000, managedRoot, 'win32', { environment: { SystemRoot: 'C:\\Windows', WINDIR: 'c:\\windows' }, validateExecutable: async path => { checked.push(path) } })
  try { await callback({ client, managedRoot, calls, checked, children }) }
  finally { await client.dispose().catch(() => {}); await rm(managedRoot, { recursive: true, force: true }) }
}
const freshSignal = () => new AbortController().signal
async function fixtureRoot() { const path = await mkdtemp(join(tmpdir(), 'emate-win-helper-')); await cp(new URL('native/windows/', root), path, { recursive: true }); return path }
function backendWithReplies(replies, config = hiddenConfig) {
  const backend = new WindowsBackend({ subprocess: {} }, config, { platform: 'win32' }); const calls = []
  backend.client.canReleaseInput = () => true
  backend.client.invoke = async request => { calls.push(structuredClone(request)); const next = replies.shift(); if (next instanceof Error) throw next; return next }
  return { backend, calls }
}

test('public app, summary, and observation never enumerate private Windows target facts', async () => {
  const listRow = { ...target, frontmost: true, accessibility: 'granted', screenRecording: 'granted' }
  const { backend } = backendWithReplies([target, rawObservation, [listRow]])
  const app = await backend.resolveApp({ pid: 42 }, new AbortController().signal)
  assert.deepEqual(Object.keys(app), ['bundleId', 'pid', 'name'])
  assert.match(app.bundleId, /^win32:sha256:[a-f0-9]{64}$/u)
  for (const secret of [target.executablePath, target.processStartTime]) assert.equal(JSON.stringify(app).includes(secret), false)
  const observation = await backend.observe(app, options, new AbortController().signal)
  assert.strictEqual(observation.app, app)
  assert.deepEqual(Object.keys(observation.app), ['bundleId', 'pid', 'name'])
  assert.deepEqual(Object.keys(observation.window), ['title', 'frame'])
  assert.equal(JSON.stringify(observation).includes(target.executablePath), false)
  assert.equal(JSON.stringify(observation).includes(target.processStartTime), false)
  assert.equal(JSON.stringify(observation).includes('windowId'), false)
  const rows = await backend.listApps(new AbortController().signal)
  assert.deepEqual(Object.keys(rows[0]), ['bundleId', 'pid', 'name', 'frontmost', 'accessibility', 'screenRecording'])
  assert.deepEqual({ frontmost: rows[0].frontmost, accessibility: rows[0].accessibility, screenRecording: rows[0].screenRecording }, { frontmost: true, accessibility: 'granted', screenRecording: 'granted' })
  assert.equal(JSON.stringify(rows).includes(target.executablePath), false)
})

test('resolveApp accepts only exact opaque bundle ids and never sends an empty fallback selector', async () => {
  const listRow = { ...target, frontmost: true, accessibility: 'granted', screenRecording: 'granted' }
  const opaque = 'win32:sha256:' + createHash('sha256').update(target.executablePath.toLowerCase()).digest('hex')
  const { backend, calls } = backendWithReplies([[listRow]])
  const app = await backend.resolveApp({ bundleId: opaque, pid: 42, name: 'editor' }, new AbortController().signal)
  assert.equal(app.bundleId, opaque)
  assert.equal(calls[0].command, 'list-apps')
  for (const bundleId of [target.executablePath, 'win32:sha256:' + 'A'.repeat(64), 'win32:sha256:abc', 'other:' + 'a'.repeat(64)]) {
    const invalid = backendWithReplies([])
    await assert.rejects(invalid.backend.resolveApp({ bundleId }, new AbortController().signal), /opaque win32 SHA-256/u)
    assert.equal(invalid.calls.length, 0)
  }
  const empty = backendWithReplies([])
  await assert.rejects(empty.backend.resolveApp({}, new AbortController().signal), /requires bundleId, pid, or name/u)
  assert.equal(empty.calls.length, 0)
})

test('private mapping rejects cloned public identity before reobserve', async () => {
  const { backend, calls } = backendWithReplies([target])
  const app = await backend.resolveApp({ pid: 42 }, new AbortController().signal)
  await assert.rejects(backend.observe({ ...app }, options, new AbortController().signal), /cloned, expired/u)
  assert.equal(calls.length, 1)
})

test('observation sanitizer rejects replacement, extras, and hostile scalar coercion', () => {
  const app = { bundleId: 'win32:sha256:' + 'b'.repeat(64), pid: 42, name: 'editor' }
  assert.equal(sanitizeWindowsObservation(rawObservation, target, app, options).app, app)
  for (const changed of [
    { ...rawObservation, extra: true }, { ...rawObservation, app: { ...target, pid: 43 } },
    { ...rawObservation, window: { ...rawObservation.window, id: 1002 } }, { ...rawObservation, stateHash: 'not-a-hash' },
    { ...rawObservation, permissions: { ...rawObservation.permissions, accessibility: { toString() { throw new Error('coerced') } } } },
    { ...rawObservation, elements: [{ ...rawObservation.elements[0], extra: true }] },
  ]) assert.throws(() => sanitizeWindowsObservation(changed, target, app, options), /invalid/u)
  const screenshotOptions = { ...options, screenshot: 'required', screenshotPath: 'C:\\workspace\\observation.png' }
  assert.throws(() => sanitizeWindowsObservation(rawObservation, target, app, screenshotOptions), /omitted/u)
  assert.throws(() => sanitizeWindowsObservation({ ...rawObservation, screenshot: { path: 'C:\\other\\stolen.png', width: 800, height: 600 } }, target, app, screenshotOptions), /invalid screenshot/u)
})

test('action result requires exact keys and primitive enum strings', async () => {
  const action = { kind: 'press-key', key: 'A', modifiers: ['control'], observationId: 'o' }
  for (const bad of [
    { channel: { toString() { throw new Error('coerced') } }, activation: 'already-frontmost', pointerInput: false, pointerRouting: 'none', cleanupComplete: true, targetVerified: true, target: { ...target, preStateHash: hash } },
    { channel: 'keyboard', activation: 'already-frontmost', pointerInput: false, pointerRouting: 'none', cleanupComplete: true, targetVerified: true, target: { ...target, preStateHash: hash }, extra: true },
  ]) {
    const { backend } = backendWithReplies([target, bad, { cleanupComplete: true, target }]); const app = await backend.resolveApp({ pid: 42 }, new AbortController().signal)
    await assert.rejects(backend.act({ action, app, expectedStateHash: hash, interaction: hiddenConfig.interaction, window: { title: 'Document', frame } }, new AbortController().signal), /invalid action/u)
  }
})

test('failed action cleanup carries exact original action and private target', async () => {
  const action = { kind: 'press-key', key: 'A', modifiers: ['control'], observationId: 'o' }
  const { backend, calls } = backendWithReplies([target, new Error('partial input'), { cleanupComplete: true, target }])
  const app = await backend.resolveApp({ pid: 42 }, new AbortController().signal)
  await assert.rejects(backend.act({ action, app, expectedStateHash: hash, interaction: hiddenConfig.interaction, window: { title: 'Document', frame } }, new AbortController().signal), /partial input/u)
  assert.equal(calls[2].command, 'release-input'); assert.deepEqual(calls[2].action, action); assert.deepEqual(calls[2].app, target); assert.equal(calls[2].window.id, target.windowId)
})

test('a terminated action cannot claim cleanup from a replacement helper', async () => {
  const { backend, calls } = backendWithReplies([target, new Error('helper terminated')])
  backend.client.canReleaseInput = () => false
  const app = await backend.resolveApp({ pid: 42 }, freshSignal())
  await assert.rejects(backend.act({ action: { kind: 'press-key', key: 'arrowleft', observationId: 'o' }, app, expectedStateHash: hash, interaction: hiddenConfig.interaction, window: { title: 'Document', frame } }, freshSignal()), /cleanup is unverified/u)
  assert.equal(calls.length, 2)
})

test('hot requests share one integrity-checked process, handshake and serial response identity', async () => {
  await withClient(async ({ client, calls, checked, children, managedRoot }) => {
    const responses = await Promise.all(Array.from({ length: 30 }, (_, number) => client.invoke({ command: 'health', number }, freshSignal())))
    assert.deepEqual(responses, Array.from({ length: 30 }, (_, number) => number))
    assert.equal(calls.length, 1); assert.equal(checked.length, 1)
    assert.equal(calls[0].argv[0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.equal(calls[0].stdio.stdin, 'pipe'); assert.equal(calls[0].stdio.stdout, 'pipe'); assert.equal(calls[0].stdio.stderr.maxBytes, 64 * 1024)
    assert.equal(children[0].requests[0].command, 'hello')
    assert.equal(new Set(children[0].requests.map(row => row.requestId)).size, 31)
    // Editing the source cannot mutate an already loaded process. A new generation rechecks bytes.
    await writeFile(join(managedRoot, 'dsh-computer-use-helper.ps1'), '# tampered after launch\n')
    assert.equal(await client.invoke({ command: 'health', number: 30 }, freshSignal()), 30)
    children[0].exit(); await new Promise(resolve => setImmediate(resolve))
    await assert.rejects(client.invoke({ command: 'health' }, freshSignal()), /hash does not match/u)
    assert.equal(calls.length, 1)
    await assert.rejects(client.invoke({ command: 'health', data: 'x'.repeat(256 * 1024) }, freshSignal()), /request exceeded/u)
    await assert.rejects(client.invoke({ command: 'health', protocolVersion: 1 }, freshSignal()), /invalid Windows helper command/u)
  }, request => ({ ok: true, value: request.number }))
})

test('invalid Windows environment fails before spawn', async () => {
  const managedRoot = await fixtureRoot()
  try {
    for (const environment of [{}, { SystemRoot: 'Windows' }, { SystemRoot: 'C:\\Windows\\..\\Temp' }, { SystemRoot: 'C:\\Windows\0bad' }, { SystemRoot: 'C:\\Windows', WINDIR: 'D:\\Windows' }]) {
      let spawned = false
      const client = new WindowsHelperClient({ subprocess: { spawn() { spawned = true } } }, 15000, managedRoot, 'win32', { environment, validateExecutable: async () => {} })
      await assert.rejects(client.invoke({ command: 'health' }, freshSignal()), /SystemRoot|WINDIR/u); assert.equal(spawned, false)
      await client.dispose()
    }
  } finally { await rm(managedRoot, { recursive: true, force: true }) }
})

test('malformed, wrong-id, duplicate, overlong and lossy frames terminate and reap', async () => {
  for (const reply of [
    () => ({ ok: true, value: null, extra: true }),
    () => ({ ok: true, value: null, requestId: 'other:1' }),
    () => ({ ok: false, error: { code: 'COMPUTER_ACTION_BLOCKED', message: 'denied', extra: true } }),
    (_request, { stdout }) => { stdout.write('{}\n{}\n') },
    (_request, { stdout }) => { stdout.write('x'.repeat(4 * 1024 * 1024 + 1)) },
  ]) await withClient(async ({ client, children }) => {
    await assert.rejects(client.invoke({ command: 'health' }, freshSignal()), /invalid envelope|protocol limit/u)
    assert.ok(children[0].terminated() >= 1); assert.equal(children[0].waited(), 1)
  }, reply)
  await withClient(async ({ client, children }) => {
    await client.invoke({ command: 'health' }, freshSignal()); children[0].stderr('private stderr', true)
    await assert.rejects(client.invoke({ command: 'health' }, freshSignal()), /invalid envelope/u)
  })
})

test('handshake mismatch rejects before dispatching the action', async () => {
  await withClient(async ({ client, children }) => {
    await assert.rejects(client.invoke({ command: 'act' }, freshSignal()), /handshake/u)
    assert.deepEqual(children[0].requests.map(row => row.command), ['hello'])
    assert.equal(children[0].waited(), 1)
  }, undefined, { hello: { ok: true, value: { helperVersion: 'wrong', protocolVersion: 2 } } })
})

test('split UTF-8 JSONL frames are reassembled and provider errors remain sanitized', async () => {
  await withClient(async ({ client, calls }) => {
    assert.equal(await client.invoke({ command: 'health' }, freshSignal()), '中文')
    await assert.rejects(client.invoke({ command: 'observe' }, freshSignal()), error => {
      assert.equal(error.code, 'COMPUTER_ACTION_BLOCKED'); assert.equal(error.message.includes('Alice'), false); return true
    })
    assert.equal(await client.invoke({ command: 'health' }, freshSignal()), '中文')
    assert.equal(calls.length, 1)
  }, (request, { stdout }) => {
    if (request.command === 'observe') return { ok: false, error: { code: 'COMPUTER_ACTION_BLOCKED', message: 'C:\\Users\\Alice\\secret.txt' } }
    const frame = Buffer.from(JSON.stringify({ protocolVersion: 2, requestId: request.requestId, ok: true, value: '中文' }) + '\n')
    const split = frame.indexOf(Buffer.from('中')) + 1; stdout.write(frame.subarray(0, split)); stdout.write(frame.subarray(split))
  })
})

test('cancellation during asynchronous preparation is rejected before spawn', async () => {
  const managedRoot = await fixtureRoot(); const controller = new AbortController(); let spawns = 0
  const client = new WindowsHelperClient({ subprocess: { spawn() { spawns += 1 } } }, 120000, managedRoot, 'win32', {
    environment: { SystemRoot: 'C:\\Windows' }, validateExecutable: async () => controller.abort(),
  })
  try { await assert.rejects(client.invoke({ command: 'health' }, controller.signal), /COMPUTER_CANCELLED/u); assert.equal(spawns, 0) }
  finally { await client.dispose(); await rm(managedRoot, { recursive: true, force: true }) }
})

test('in-flight cancellation and timeout reap before returning and restart only with a new handshake', async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController(); let first = true
    await withClient(async ({ client, children }) => {
      const pending = client.invoke({ command: 'act' }, controller.signal)
      await assert.rejects(pending, cancel ? /COMPUTER_CANCELLED/u : /COMPUTER_TIMEOUT/u)
      assert.equal(children[0].waited(), 1); assert.ok(children[0].terminated() >= 1)
      assert.equal(await client.invoke({ command: 'health' }, freshSignal()), 'fresh')
      assert.deepEqual(children[1].requests.map(row => row.command), ['hello', 'health'])
      assert.equal(children.flatMap(row => row.requests).filter(row => row.command === 'act').length, 1)
    }, () => { if (first) { first = false; if (cancel) controller.abort(); return undefined }; return { ok: true, value: 'fresh' } }, { timeoutMs: 80 })
  }
})

test('queued cancellation does not terminate another caller and dispose is deterministic', async () => {
  let finish
  await withClient(async ({ client, children }) => {
    const active = client.invoke({ command: 'act' }, freshSignal())
    while (finish === undefined) await new Promise(resolve => setImmediate(resolve))
    const controller = new AbortController(); const queued = client.invoke({ command: 'health' }, controller.signal); controller.abort()
    await assert.rejects(queued, /COMPUTER_CANCELLED/u); assert.equal(children[0].terminated(), 0)
    finish(); await active
    await client.dispose(); await client.dispose()
    assert.equal(children[0].waited(), 1)
    await assert.rejects(client.invoke({ command: 'health' }, freshSignal()), /COMPUTER_CANCELLED/u)
  }, (request, { respond }) => { finish = () => respond(request, { ok: true, value: true }) })
})

test('unreaped helper fails closed without creating another generation', async () => {
  await withClient(async ({ client, calls }) => {
    await assert.rejects(client.invoke({ command: 'act' }, freshSignal()), /could not be reaped/u)
    await assert.rejects(client.invoke({ command: 'health' }, freshSignal()), /could not be reaped/u)
    assert.equal(calls.length, 1)
    await assert.rejects(client.dispose(), /could not be reaped/u)
  }, () => undefined, { timeoutMs: 30, reaped: false })
})

test('Windows cursor configuration is hidden and visible mode cannot silently no-op', async () => {
  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8'); assert.ok(patch.includes("process.platform === 'win32' ? 'hidden' : 'visible'"))
  const hidden = new WindowsBackend({ subprocess: {} }, hiddenConfig, { platform: 'win32' }); await hidden.visualizeCursor({}, 'before', new AbortController().signal)
  const visible = new WindowsBackend({ subprocess: {} }, { ...hiddenConfig, interaction: { ...hiddenConfig.interaction, cursorVisualization: 'visible' } }, { platform: 'win32' })
  await assert.rejects(visible.visualizeCursor({}, 'before', new AbortController().signal), /visualization is unavailable/u)
})

test('composition keeps one owner, bounded health probes, exact cleanup, and no candidate plugin layer', async () => {
  const [patch, source, helper, manifest, build, service, leases, confirmations] = await Promise.all([
    readFile(new URL('cordis.patch.yml', root), 'utf8'), readFile(new URL('src/windows.ts', root), 'utf8'), readFile(new URL('native/windows/dsh-computer-use-helper.ps1', root), 'utf8'), readFile(new URL('native/windows/manifest.json', root), 'utf8'), readFile(new URL('scripts/build.mjs', root), 'utf8'), readFile(new URL('../../upstream/plugins/dsh-computer-use/src/service.ts', root), 'utf8'), readFile(new URL('../../upstream/plugins/dsh-computer-use/src/leases.ts', root), 'utf8'), readFile(new URL('../../upstream/plugins/dsh-computer-use/src/confirmations.ts', root), 'utf8'),
  ])
  const jsExpr = new loaderYaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: data => typeof data === 'string', construct: data => ({ __jsExpr: data }) })
  const parsedPatch = loaderYaml.load(patch, { schema: loaderYaml.JSON_SCHEMA.extend(jsExpr) })
  const rows = parsedPatch.flatMap(operation => operation.insert ?? []).filter(row => row.id === 'emate-computer-use')
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].disabled, { __jsExpr: "Array.of('darwin', 'win32').includes(process.platform) === false" })
  assert.deepEqual(rows[0].config.interaction.cursorVisualization, { __jsExpr: "process.platform === 'win32' ? 'hidden' : 'visible'" })
  assert.equal(rows[0].config.interaction.focusPolicy, 'preserve')
  assert.equal(rows[0].config.interaction.keyboardPolicy, 'preserve')
  assert.match(helper, /if\(\$policy -ne 'activate'\)\{throw/u)
  assert.match(helper, /preserve focus policy denies AXRaise/u)
  assert.match(helper, /background raw pointer input is unavailable/u)
  assert.match(helper, /GetGUIThreadInfo/u)
  assert.match(helper, /ScrollPattern/u)
  assert.match(helper, /GetUpdatedCache\(\$cache\)/u)
  assert.match(helper, /GetFirstChild\(\$element,\$cache\)/u)
  assert.match(helper, /TryGetCachedPattern/u)
  assert.match(helper, /ToggleState|ExpandCollapseState|HorizontalScrollPercent/u)
  assert.match(helper, /Invoke-Semantic/u)
  assert.doesNotMatch(helper, /SendInput|SetCursorPos|SetClipboardData|GetClipboardData|CopyFromScreen|\.SetFocus\(/u)
  const disabled = platform => Function('process', 'return (' + rows[0].disabled.__jsExpr + ')')({ platform })
  assert.equal(disabled('darwin'), false)
  assert.equal(disabled('win32'), false)
  assert.equal(disabled('linux'), true)
  assert.doesNotMatch(patch, /!!js\s+!/u)
  for (const excluded of ['node:child_process', 'spawnSync', 'src/ps.js', 'computer_set_mode']) assert.equal(source.includes(excluded), false)
  for (const excluded of ['computer_set_mode', 'output-guard', 'src\\index.js']) assert.equal(helper.includes(excluded), false)
  assert.ok(helper.includes('SPDX-License-Identifier: MIT'))
  const encoding = helper.indexOf('$utf8 = [System.Text.UTF8Encoding]::new($false)')
  const input = helper.indexOf('[Console]::InputEncoding = $utf8')
  const output = helper.indexOf('[Console]::OutputEncoding = $utf8')
  const pipeline = helper.indexOf('$OutputEncoding = $utf8')
  const read = helper.indexOf('[EmateWin32]::ReadRequest([Console]::In)')
  assert.ok(encoding >= 0 && input > encoding && output > input && pipeline > output && read > pipeline)
  for (const fact of ['RootElement', 'PrintWindow', 'SetProcessDpiAwarenessContext', 'Release-Input $request.app $request.window $request.action', 'Release-Held', 'SendMessageTimeout', 'secure desktop', 'locked session', 'RDP', 'elevated', 'UIPI']) assert.ok(helper.includes(fact))
  assert.equal(build.includes('executablePath?: string'), false)
  assert.equal((build.match(/\$\{'\$\{process\.platform\}'\}/gu) ?? []).length, 2)
  assert.equal((build.match(/current platform is \$\{process\.platform\}\\`/gu) ?? []).length, 0)
  assert.ok(build.includes('try {'))
  assert.ok(build.includes('} finally {'))
  assert.ok(build.includes('rm(runtimeBundle'))
  assert.ok(build.includes('rm(runtimeSource'))
  assert.match(service, /const screenshotPath[\s\S]*allocateScreenshotPath\(context\.workspace/u)
  assert.ok(service.includes('latest = await this.backend.observe(stored.backend.app'))
  assert.ok(leases.includes("approvalPolicy(this.ctx, agent) === 'never'")); assert.ok(leases.includes('this.controlGrants.get(agent)?.get(app.bundleId) === turn')); assert.ok(confirmations.includes('agentRecords?.delete(token)'))
  assert.equal(createHash('sha256').update(helper).digest('hex'), JSON.parse(manifest).source.sha256)
})

test('blocked reasons distinguish unsupported input from desktop authority without exposing native messages', async () => {
  const cases = [
    ['unsupported-key', /does not support this targeted key/u], ['unsupported-control', /does not support reliable targeted input/u],
    ['background-pointer', /in the background/u], ['uia-unavailable', /pattern is unavailable/u],
    ['focus-policy', /current focus or pointer policy/u], ['desktop-unavailable', /locked, noninteractive/u],
    ['integrity-unavailable', /elevated\/UIPI/u], ['capture-unavailable', /cannot be captured/u],
  ]
  let index = 0
  await withClient(async ({ client, calls, children }) => {
    for (const [, message] of cases) await assert.rejects(client.invoke({ command: 'act' }, freshSignal()), error => {
      assert.equal(error.code, 'COMPUTER_ACTION_BLOCKED'); assert.match(error.message, message)
      assert.equal(error.message.includes('private-user'), false); return true
    })
    assert.equal(calls.length, 1)
    assert.equal(children[0].requests.length, cases.length + 1) // one handshake, no action replay
    assert.equal(children[0].terminated(), 0)
  }, () => ({ ok: false, error: { code: 'COMPUTER_ACTION_BLOCKED', reason: cases[index++][0], message: 'C:\\private-user\\secret.txt' } }))
  const helper = await readFile(new URL('native/windows/dsh-computer-use-helper.ps1', root), 'utf8')
  for (const [reason] of cases) assert.ok(helper.includes(`return '${reason}'`))
  assert.match(helper, /\$reason=Get-BlockedReason \$message/u)
  assert.match(helper, /\$errorBody\.code='COMPUTER_ACTION_BLOCKED';\$errorBody\.reason=\$reason/u)
})

test('legacy, unknown and mismatched reason fields keep safe error classification; malformed fields fail closed', async () => {
  for (const reason of [undefined, 'future-reason-private-user', '__proto__']) {
    await withClient(async ({ client, calls }) => {
      await assert.rejects(client.invoke({ command: 'act' }, freshSignal()), error => {
        assert.equal(error.code, 'COMPUTER_ACTION_BLOCKED')
        assert.match(error.message, /current target, input route or permissions/u)
        assert.doesNotMatch(error.message, /private-user|integrity authority is unavailable/u); return true
      })
      assert.equal(calls.length, 1)
    }, () => ({ ok: false, error: { code: 'COMPUTER_ACTION_BLOCKED', message: 'private-user', ...(reason === undefined ? {} : { reason }) } }))
  }
  await withClient(async ({ client }) => {
    await assert.rejects(client.invoke({ command: 'act' }, freshSignal()), error => {
      assert.equal(error.code, 'COMPUTER_STALE_OBSERVATION'); assert.match(error.message, /state changed/u); return true
    })
  }, () => ({ ok: false, error: { code: 'COMPUTER_STALE_OBSERVATION', message: 'private-user', reason: 'unsupported-key' } }))
  for (const reason of [{ value: 'unsupported-key' }, 'x'.repeat(129)]) await withClient(async ({ client, children }) => {
    await assert.rejects(client.invoke({ command: 'act' }, freshSignal()), error => error.code === 'COMPUTER_PROVIDER_FAILURE')
    assert.equal(children[0].waited(), 1)
  }, () => ({ ok: false, error: { code: 'COMPUTER_ACTION_BLOCKED', message: 'private-user', reason } }))
})

test('the actual build Skill adaptation teaches Windows supported input and truthful UIA alternatives', async () => {
  const build = await readFile(new URL('scripts/build.mjs', root), 'utf8')
  const original = await readFile(new URL('../../upstream/plugins/dsh-computer-use/lib/skill.js', root), 'utf8')
  const replaceOwner = build.slice(build.indexOf('function replaceExactlyOnce('), build.indexOf('const exposurePath ='))
  const skillOwner = build.slice(build.indexOf('const skillPath ='), build.indexOf('const runtimeSource ='))
  let output
  // Execute only the existing pure Skill materialization section, with in-memory
  // read/write seams; never invoke native builder, subprocess or application UI.
  await new Function('root', 'join', 'readText', 'writeFile', `return (async () => { ${replaceOwner}\n${skillOwner} })()`)(
    '/fixture', join, async () => original, async (_path, text) => { output = text },
  )
  assert.match(output, /Windows input scope \(takes precedence/u)
  assert.match(output, /UIA Invoke, Value, Toggle, SelectionItem, ExpandCollapse and/u)
  assert.match(output, /Ctrl\+A only/u)
  assert.match(output, /Tab, Escape, Space,[\s\S]*other modifier chords are unavailable/u)
  assert.match(output, /there is no\ngeneric replacement/u)
  assert.match(output, /do not infer permission denial from an unsupported input route/u)
  assert.match(output, /e-Mate @电脑操控 trigger/u)
  assert.match(output, /use the CDP browser tools first/u)
})
