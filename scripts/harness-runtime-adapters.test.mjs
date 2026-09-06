import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { adaptHarnessFsSource, applyHarnessRuntimeAdapters } from './harness-runtime-adapters.mjs'
import { adaptHarnessSessionExportSource, SESSION_EXPORT_PACKAGE } from './harness-session-export-adapter.mjs'
import { adaptHarnessConversationSource, CONVERSATION_PACKAGE } from './harness-conversation-adapter.mjs'

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
  const nativeConversation = await fs.readFile(join(nativeRoot, 'upstream/deepseek-harness/packages/client/ui-conversation/lib/client.js'), 'utf8')
  const nativeExport = await fs.readFile(join(nativeRoot, 'upstream/deepseek-harness/packages/host/apiproxy/lib/index.js'), 'utf8')
  const entries = [
    { name: '@deepseek-ai/dsh-tool-fs', file: 'index.js', input: rc7Seam, adapt: adaptHarnessFsSource },
    { name: SESSION_EXPORT_PACKAGE, file: 'index.js', input: nativeExport, adapt: adaptHarnessSessionExportSource },
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
