import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HARNESS_COMMIT } from '../lib/e-mate.js'
import { apply, validateModelPolicy } from '../profile/plugins/model-policy.js'

const now = Date.now()
const policy = {
  schema_version: 1, account_subject: 'tenant:user', revision: 1,
  allowed_model_ids: ['gpt-5.6-luna', 'gpt-image2.5-flare'],
  default_chat_model_id: 'gpt-5.6-luna', default_chat_reasoning_effort: 'max',
  image_primary_model_id: 'gpt-image2.5-flare',
  issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 3600000).toISOString(),
  receipt_id: 'policy-receipt:flare',
}
const sign = value => ({ ...value, policy_sha256: createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])))).digest('hex') })

test('live model policy accepts only Flare with no legacy or fallback route', () => {
  assert.equal(validateModelPolicy(policy, 'tenant:user', now).image_primary_model_id, 'gpt-image2.5-flare')
  for (const model of ['gpt-image-2-pro', 'gpt-image-2']) {
    assert.throws(() => validateModelPolicy({ ...policy, image_primary_model_id: model }, 'tenant:user', now), /invalid/)
    assert.throws(() => validateModelPolicy({ ...policy, allowed_model_ids: [...policy.allowed_model_ids, model] }, 'tenant:user', now), /invalid/)
  }
})

test('native durable policy reads authenticated old formats and writes Flare without fallback', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'emate-flare-policy-'))
  const harness = fileURLToPath(new URL('../../../upstream/deepseek-harness/', import.meta.url))
  const require = createRequire(join(harness, 'packages/storage/storage-domain/package.json'))
  const binding = { schema_version: 1, product: 'e-Mate', version: '2.0.18', harness_commit: HARNESS_COMMIT, dsh_home: folder }
  for (const [key, path] of Object.entries({ tools_module: join(harness, 'packages/core/tools/lib/index.js'), storage_domain_module: join(harness, 'packages/storage/storage-domain/lib/index.js'), zod_module: realpathSync(require.resolve('zod')) })) {
    binding[key] = path
    binding[key + '_sha256'] = createHash('sha256').update(readFileSync(path)).digest('hex')
  }
  const bindingPath = join(folder, 'binding.json')
  writeFileSync(bindingPath, JSON.stringify(binding))
  const old = { ...policy, image_primary_model_id: 'gpt-image-2-pro', allowed_model_ids: ['gpt-5.6-luna', 'gpt-image-2-pro'] }
  const stop = new Error('migration checked before unrelated quota startup')
  try {
    for (const legacy of [old, { ...old, image_fallback_upstream_model_id: 'gpt-image-2', allowed_model_ids: [...old.allowed_model_ids, 'gpt-image-2'] }]) {
      let written
      const ctx = { effect() {}, storageDomain: { async open(definition) {
        if (definition.name !== 'emate_model_policy') throw stop
        return { close() {}, table() { return { get() { return sign(legacy) }, async put(key, value) { written = value } } } }
      } } }
      await assert.rejects(apply(ctx, { bindingPath }), error => error === stop)
      assert.equal(written.image_primary_model_id, 'gpt-image2.5-flare')
      assert.deepEqual(written.allowed_model_ids, ['gpt-5.6-luna', 'gpt-image2.5-flare'])
      assert.equal('image_fallback_upstream_model_id' in written, false)
      const { policy_sha256, ...payload } = written
      assert.equal(policy_sha256, sign(payload).policy_sha256)
      ctx.storageDomain.open = async () => ({ close() {}, table() { return { get() { return { ...sign(legacy), image_primary_model_id: 'gpt-image2.5-flare' } }, async put() { assert.fail('tampered policy must never be written') } } } })
      await assert.rejects(apply(ctx, { bindingPath }), /stored model policy is invalid/)
    }
  } finally { rmSync(folder, { recursive: true, force: true }) }
})
