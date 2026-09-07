import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { adaptHarnessFsSource, applyHarnessRuntimeAdapters } from './harness-runtime-adapters.mjs'
import { adaptHarnessFsBytesSource, FS_BYTES_PACKAGE } from './harness-fs-bytes-adapter.mjs'
import { adaptHarnessSessionExportSource, SESSION_EXPORT_PACKAGE } from './harness-session-export-adapter.mjs'
import { adaptHarnessConversationSource, CONVERSATION_PACKAGE } from './harness-conversation-adapter.mjs'
import { adaptHarnessArtifactLinksSource, ARTIFACT_LINKS_PACKAGE, adaptHarnessArtifactDeliverablesSource, ARTIFACT_DELIVERABLES_PACKAGE } from './harness-artifact-links-adapter.mjs'
import { adaptHarnessSlotErrorSource, SLOT_ERROR_PACKAGE } from './harness-slot-error-adapter.mjs'

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
  const nativeSlots = await fs.readFile(join(nativeRoot, 'upstream/deepseek-harness/packages/client/runtime/lib/client.js'), 'utf8')
  const nativeConversation = await fs.readFile(join(nativeRoot, 'upstream/deepseek-harness/packages/client/ui-conversation/lib/client.js'), 'utf8')
  const nativeExport = await fs.readFile(join(nativeRoot, 'upstream/deepseek-harness/packages/host/apiproxy/lib/index.js'), 'utf8')
  const nativeBytes = await fs.readFile(join(nativeRoot, 'upstream/deepseek-harness/packages/fs/fs-local/lib/index.js'), 'utf8')
  const entries = [
    { name: '@deepseek-ai/dsh-tool-fs', file: 'index.js', input: rc7Seam, adapt: adaptHarnessFsSource },
    { name: FS_BYTES_PACKAGE, file: 'index.js', input: nativeBytes, adapt: adaptHarnessFsBytesSource },
    { name: SESSION_EXPORT_PACKAGE, file: 'index.js', input: nativeExport, adapt: adaptHarnessSessionExportSource },
    { name: ARTIFACT_LINKS_PACKAGE, file: 'index.js', input: nativeArtifactLinks, adapt: adaptHarnessArtifactLinksSource },
    { name: ARTIFACT_DELIVERABLES_PACKAGE, file: 'client.js', input: nativeDeliverables, adapt: adaptHarnessArtifactDeliverablesSource },
    { name: SLOT_ERROR_PACKAGE, file: 'client.js', input: nativeSlots, adapt: adaptHarnessSlotErrorSource },
    { name: CONVERSATION_PACKAGE, file: 'client.js', input: nativeConversation, adapt: adaptHarnessConversationSource },
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

const slotNativeRoot = process.env.EMATE_TEST_NATIVE_ROOT ?? new URL('..', import.meta.url).pathname
const source = readFileSync(join(slotNativeRoot, 'upstream/deepseek-harness/packages/client/runtime/lib/client.js'), 'utf8')

test('pinned SlotsService delegates supervision to the existing core without altering arguments or errors', () => {
  const adapted = adaptHarnessSlotErrorSource(source)
  const method = adapted.match(/reportEntryError\(key, entry, error, info\) \{\s*return this\._core\.reportEntryError\(key, entry, error, info\);\s*\}/u)?.[0]
  assert.ok(method)
  const service = new Function(`return ({ ${method} })`)()
  const args = ['tool.call.toolview', {}, new Error('tool crashed'), { abdicate: true }]
  const sentinel = {}
  service._core = { reportEntryError: (...actual) => { assert.deepEqual(actual, args); return sentinel } }
  assert.equal(service.reportEntryError(...args), sentinel)
  const failure = new Error('native supervision failed')
  service._core.reportEntryError = () => { throw failure }
  assert.throws(() => service.reportEntryError(...args), error => error === failure)
  assert.match(adapted, /reportEntryError: \(key, entry, error, info\) => \{\s*this\.reportEntryError\(key, entry, error, info\);/u)
  assert.equal(readFileSync(join(slotNativeRoot, 'upstream/deepseek-harness/packages/client/runtime/lib/client.js'), 'utf8'), source)
})

test('slot adapter rejects missing, duplicated or previously adapted pinned seams', () => {
  assert.throws(() => adaptHarnessSlotErrorSource('future runtime'), /observer seam, found 0/u)
  assert.throws(() => adaptHarnessSlotErrorSource(source + source), /observer seam, found 2/u)
  assert.throws(() => adaptHarnessSlotErrorSource(adaptHarnessSlotErrorSource(source)), /host seam, found 0/u)
})

test('portable runtime and Desktop materialization verify the same adapter bytes', () => {
  const local = new URL('..', import.meta.url).pathname
  const assembly = readFileSync(join(local, 'scripts/harness-runtime-adapters.mjs'), 'utf8')
  const desktop = readFileSync(join(local, 'scripts/harness-provenance.mjs'), 'utf8')
  const build = readFileSync(join(local, 'scripts/build-harness-runtime.mjs'), 'utf8')
  assert.match(assembly, /replaceRuntimeFile\(slotTarget, adaptHarnessSlotErrorSource/u)
  assert.match(desktop, /writeFileSync\(client, adaptHarnessSlotErrorSource/u)
  assert.match(desktop, /!== adaptHarnessSlotErrorSource\(readFileSync\(join\(sourceLib, 'client.js'/u)
  assert.match(desktop, /SLOT_ERROR_PACKAGE \? SLOT_ERROR_ADAPTER_PATH/u)
  assert.match(build, /slot_error_adapter_sha256: sha256\(slotErrorAdapter\)/u)
  assert.match(build, /slot_error_client_sha256: sha256\(join\(assembled, 'node_modules', SLOT_ERROR_PACKAGE/u)
})

test('native browser fetches SlotsService as a client plugin bundle, not a Vite source singleton', () => {
  const native = join(slotNativeRoot, 'upstream/deepseek-harness')
  const runtime = JSON.parse(readFileSync(join(native, 'packages/client/runtime/package.json'), 'utf8'))
  assert.equal(runtime.exports['./client'].default, './lib/client.js')
  assert.equal(runtime.dsh.client.immediately, true)
  const seed = readFileSync(join(native, 'packages/client/web/src/seed.ts'), 'utf8')
  assert.doesNotMatch(seed, /@deepseek-ai\/dsh-client-runtime/u)
  const vite = readFileSync(join(native, 'apps/web/vite.config.ts'), 'utf8')
  assert.doesNotMatch(vite, /packages\/client\/runtime\/src/u)
  const loader = readFileSync(join(native, 'packages/client/modules/src/client/system.ts'), 'utf8')
  assert.match(loader, /const task = this\.loadBundle\(url\)/u)
  const route = readFileSync(join(native, 'packages/client/modules/src/index.ts'), 'utf8')
  assert.match(route, /const bundleSuffix = '\/client\.js'/u)
})
