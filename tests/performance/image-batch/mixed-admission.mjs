#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { InMemoryUsageStore, InvocationAdmissionError } from '../../../enterprise/apps/model-gateway/src/server.ts'

// Diagnostic against the existing admission owner. No HTTP, credentials, provider or new scheduler.
export async function measureMixedAdmission() {
  const source = readFileSync(new URL('../../../packages/dsh-plugin-imagegen/src/upstream/generation-runtime.ts', import.meta.url), 'utf8')
  assert.match(source, /GenerationTaskQueue/u)
  const fact = (id, imageTraffic = 'single') => ({ tenantId: 'fixture-tenant', userId: 'fixture-user', taskId: id, traceId: id, imageTraffic,
    modelId: 'gpt-image-2.5-flare', providerId: 'fixture-provider', requestDigest: 'd'.repeat(43), routeFingerprint: 'f'.repeat(43) })
  const measure = async concurrency => {
    let clock = 0
    const store = new InMemoryUsageStore({ tenantRequestsPerMinute: 1000, tenantBurst: 1000, tenantMaxConcurrent: 4, invocationLeaseMs: 600_000 }, () => clock)
    const prepared = []
    for (let index = 0; index < concurrency; index += 1) prepared.push(await store.prepare(fact(`batch-${index}`)))
    const admit = async value => {
      try { return { status: (await store.prepare(value)).status, retry_after_ms: null } }
      catch (error) {
        if (!(error instanceof InvocationAdmissionError)) throw error
        return { status: error.code, retry_after_ms: error.retryAfterMs }
      }
    }
    const first = await admit(fact('direct-single', 'single'))
    clock = 10_000
    await store.complete(prepared[0].invocationId, { ...fact('batch-0'), providerResponseId: 'fixture-result',
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 })
    const refill = await admit(fact('batch-refill'))
    const afterRefill = await admit(fact('direct-single', 'single'))
    assert.equal(first.status, concurrency === 4 ? 'TENANT_CONCURRENCY_LIMITED' : 'STARTED')
    assert.equal(refill.status, 'STARTED')
    assert.equal(afterRefill.status, concurrency === 4 ? 'TENANT_CONCURRENCY_LIMITED' : 'PENDING')
    return { batch_concurrency: concurrency, first_single: first, batch_refill: refill.status, single_after_refill: afterRefill,
      slot_released_at_ms: clock }
  }
  return { ticket: 'EM218-502', claim: 'local-in-memory-admission-diagnostic-not-provider-not-production-not-fairness-acceptance',
    network_calls: 0, provider_calls: 0, clock: 'injected integer milliseconds',
    legacy_default_three_and_auto_retry: 'SUPERSEDED', native_http_capacity: 4,
    mixed_fairness_acceptance: 'OPEN: this in-memory HTTP admission probe does not prove queue wait or installed responsiveness',
    admission_semantics: 'All native image HTTP calls use single-image admission; local safe-failure is tested separately, no retry is injected.',
    scenarios: [await measure(3), await measure(4)] }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  measureMixedAdmission().then(report => process.stdout.write(JSON.stringify(report, null, 2) + '\n'))
    .catch(error => { process.stderr.write((error instanceof Error ? error.message : 'admission diagnostic failed') + '\n'); process.exitCode = 1 })
}
