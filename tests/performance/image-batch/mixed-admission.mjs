#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { InMemoryUsageStore, InvocationAdmissionError } from '../../../enterprise/apps/model-gateway/src/server.ts'
import { normalizeImageBatchRequest } from '../../../packages/dsh/src/profile/image-batch.ts'

// Diagnostic against the existing admission owner. No HTTP, credentials, provider or new scheduler.
export async function measureMixedAdmission() {
  const source = readFileSync(new URL('../../../packages/dsh/src/profile/image-generation.ts', import.meta.url), 'utf8')
  const bound = name => {
    const matched = source.match(new RegExp(`const ${name} = ([0-9_]+)`))
    if (!matched) throw new Error('image admission bound is unavailable')
    return Number(matched[1].replaceAll('_', ''))
  }
  const waitBudgetMs = bound('IMAGE_ADMISSION_WAIT_BUDGET_MS')
  const maximumAttempts = bound('IMAGE_ADMISSION_MAX_ATTEMPTS')
  const fact = id => ({ tenantId: 'fixture-tenant', userId: 'fixture-user', taskId: id, traceId: id,
    modelId: 'gpt-image-2-pro', providerId: 'fixture-provider', requestDigest: 'd'.repeat(43), routeFingerprint: 'f'.repeat(43) })
  const defaultConcurrency = normalizeImageBatchRequest({ tasks: [{ prompt: 'one' }, { prompt: 'two' }] }).concurrency
  const measure = async concurrency => {
    let clock = 0
    const store = new InMemoryUsageStore({ tenantRequestsPerMinute: 1000, tenantBurst: 1000, tenantMaxConcurrent: 4, invocationLeaseMs: 600_000 }, () => clock)
    const prepared = []
    for (let index = 0; index < concurrency; index += 1) prepared.push(await store.prepare(fact(`batch-${index}`)))
    const admitSingle = async () => {
      try { return { status: (await store.prepare(fact('direct-single'))).status, retry_after_ms: null } }
      catch (error) {
        if (!(error instanceof InvocationAdmissionError)) throw error
        return { status: error.code, retry_after_ms: error.retryAfterMs }
      }
    }
    const first = await admitSingle()
    clock = 10_000
    await store.complete(prepared[0].invocationId, { ...fact('batch-0'), providerResponseId: 'fixture-result',
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 })
    const refill = await store.prepare(fact('batch-refill'))
    const afterRefill = await admitSingle()
    return { batch_concurrency: concurrency, first_single: first, batch_refill: refill.status, single_after_refill: afterRefill,
      first_hint_exceeds_local_wait_budget: first.retry_after_ms !== null && first.retry_after_ms > waitBudgetMs }
  }
  return { ticket: 'EM218-502', claim: 'local-in-memory-admission-diagnostic-not-provider-not-production-not-fairness-acceptance',
    network_calls: 0, provider_calls: 0, clock: 'injected integer milliseconds', local_wait_budget_ms: waitBudgetMs,
    maximum_attempts: maximumAttempts, scenarios: [await measure(defaultConcurrency), await measure(4)] }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  measureMixedAdmission().then(report => process.stdout.write(JSON.stringify(report, null, 2) + '\n'))
    .catch(error => { process.stderr.write((error instanceof Error ? error.message : 'admission diagnostic failed') + '\n'); process.exitCode = 1 })
}
