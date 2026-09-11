/**
 * The pinned credential seam against the product's composition. e-mate's
 * provider must implement every abstract member of `CredentialProvider` — the
 * value face from the OS store, the record face from the native file-backed
 * provider — because a missing member is invisible until the harness calls it
 * during profile boot.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Context } from '../../../upstream/deepseek-harness/vendor/cordis/lib/index.js'
import CredentialProvider, {
  credentialKey,
} from '../../../upstream/deepseek-harness/packages/credentials/credentials/lib/index.js'
import LocalCredentialProvider from '../../../upstream/deepseek-harness/packages/credentials/credentials-local/lib/index.js'
import { createOsCredentialProvider, mountRecordProvider } from '../profile/plugins/credentials-os.js'

const SEAM_MODULE = fileURLToPath(new URL(
  '../../../upstream/deepseek-harness/packages/credentials/credentials/lib/index.js',
  import.meta.url,
))
const SEAM_SOURCE = new URL(
  '../../../upstream/deepseek-harness/packages/credentials/credentials/src/index.ts',
  import.meta.url,
)

/** Abstract member names one seam source declares on `CredentialProvider`. */
function abstractMembers(source) {
  const declaration = source.indexOf('export abstract class CredentialProvider')
  assert.notEqual(declaration, -1, 'the pinned seam no longer declares CredentialProvider')
  const body = source.slice(declaration, source.indexOf('\n}', declaration))
  return [...body.matchAll(/^\s*abstract\s+([A-Za-z]+)\s*\(/gmu)].map(match => match[1])
}

// TypeScript erases abstract signatures, so the runtime class carries no member
// list to compare against; the seam's own source is the only authority.
const SEAM_MEMBERS = abstractMembers(readFileSync(SEAM_SOURCE, 'utf8'))

/** Fail loud when a provider omits any abstract member of the seam it extends. */
function assertProviderComplete(Provider, label) {
  const missing = SEAM_MEMBERS.filter(member => typeof Provider.prototype[member] !== 'function')
  assert.deepEqual(missing, [], `${label} does not implement the credential seam: ${missing.join(', ')}`)
}

function valueStore() {
  return {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }),
    set: async () => {},
    unset: async () => false,
  }
}

test('the pinned credential seam still declares exactly the nine verified members', () => {
  assert.deepEqual(SEAM_MEMBERS, [
    'resolve', 'describe', 'set', 'unset',
    'readRecord', 'describeRecord', 'listRecords', 'modifyRecord', 'deleteRecord',
  ])
})

test('the e-mate credentials provider implements every abstract member of the bound seam', () => {
  const Provider = createOsCredentialProvider(CredentialProvider, valueStore(), {
    readRecord: async () => undefined,
    describeRecord: async () => ({ configured: false, writable: true }),
    listRecords: async () => [],
    modifyRecord: async (_key, mutate) => mutate(undefined),
    deleteRecord: async () => {},
  })
  assertProviderComplete(Provider, 'emate-credentials-os')
})

test('the guard rejects the value-only provider that failed the profile boot', () => {
  class ValueOnlyProvider extends CredentialProvider {
    async resolve() { return undefined }
    async describe() { return { configured: false, writable: true } }
    async set() {}
    async unset() {}
  }
  assert.throws(
    () => assertProviderComplete(ValueOnlyProvider, 'value-only probe'),
    /value-only probe does not implement the credential seam: readRecord, describeRecord, listRecords, modifyRecord, deleteRecord/u,
  )
})

test('the record face is the native provider over the same harness home, behind one owner', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'emate-credentials-'))
  const ctx = new Context()
  const rootOwner = { owner: 'emate-credentials-os' }
  const updated = []
  ctx.provide('credentials', rootOwner)
  ctx.on('credentials/record-updated', key => { updated.push(key) })
  t.after(async () => {
    await ctx.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  await assert.rejects(
    async () => { await ctx.plugin(LocalCredentialProvider, { dshHome: home }) },
    /service "credentials" has been registered/u,
  )

  const records = await mountRecordProvider(ctx, SEAM_MODULE, home)
  assert.equal(ctx.get('credentials'), rootOwner)
  assertProviderComplete(records.constructor, 'native record provider')

  const key = credentialKey('contract-probe', 'record-1')
  assert.deepEqual(await records.listRecords(), [])
  assert.deepEqual(await records.describeRecord(key), { configured: false, writable: true })
  assert.deepEqual(
    await records.modifyRecord(key, async () => ({ kind: 'api-key', key: 'probe-secret' })),
    { kind: 'api-key', key: 'probe-secret' },
  )
  assert.deepEqual(await records.readRecord(key), { kind: 'api-key', key: 'probe-secret' })
  assert.deepEqual(await records.listRecords(), [{ key, kind: 'api-key' }])
  assert.deepEqual(updated, [key])
  assert.deepEqual(
    await records.modifyRecord(key, async () => undefined),
    { kind: 'api-key', key: 'probe-secret' },
  )
  assert.match(
    readFileSync(join(home, '.credentials.yaml'), 'utf8'),
    /^version: 1\nrecords:\n {2}contract-probe\/record-1:\n {4}kind: api-key\n {4}key: probe-secret\n$/u,
  )
  await records.deleteRecord(key)
  assert.deepEqual(await records.listRecords(), [])
  assert.deepEqual(await records.describeRecord(key), { configured: false, writable: true })
})
