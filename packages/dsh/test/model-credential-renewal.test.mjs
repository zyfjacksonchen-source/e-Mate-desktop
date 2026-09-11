/**
 * The product half of the pinned credential-renewal seam.
 *
 * Every attempt of a model request resolves its credential through
 * `CredentialProvider.resolveCurrent` (packages/llm/llm-deepseek/src/index.ts,
 * packages/llm/llm-pi-ai/src/index.ts), whose seam default is the stored value.
 * e-Mate's model credential is an enterprise gateway session token that carries
 * its own expiry, so the product provider must make it current at the moment of
 * use — by delegating to the identity provider that already owns the lease, its
 * due margin and its single-flight refresh — and must leave every other
 * reference exactly as the native default resolves it.
 *
 * The composition under test is the one `apply` mounts: the OS value face, the
 * product identity owner behind `emateIdentity`, and a real adapter driven by a
 * real Agent Loop against a real mock provider.
 */

import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { Context } from '../../../upstream/deepseek-harness/vendor/cordis/lib/index.js'
import Timer from '../../../upstream/deepseek-harness/vendor/timer/lib/index.js'
// The harness build emits each module to `lib/types` and then bundles the
// package entry (`lib/index.js`) from it, so both carry the same code; the
// emitted module is read directly here because a worktree that has only been
// type-checked since the fork commit still has the previous entry bundle.
import CredentialProvider from '../../../upstream/deepseek-harness/packages/credentials/credentials/lib/types/index.js'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '../../../upstream/deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js'
import { startMockLlmServer } from '../../../upstream/deepseek-harness/packages/test-support/llm-mock-server/lib/index.js'
import * as LlmDeepSeek from '../../../upstream/deepseek-harness/packages/llm/llm-deepseek/lib/types/index.js'
import { createUserMessage } from '../../../upstream/deepseek-harness/packages/llm/llm/lib/index.js'
import { SessionId } from '../../../upstream/deepseek-harness/packages/core/session/lib/index.js'
import * as identityPlugin from '../profile/plugins/identity/index.js'
import {
  CredentialStore,
  MODEL_SESSION_CREDENTIAL_REF,
  createOsCredentialProvider,
  mountProductCredentialProvider,
} from '../profile/plugins/credentials-os.js'

const SESSION_REF = 'E_MATE_ENTERPRISE_SESSION'
const PRODUCT_REF = MODEL_SESSION_CREDENTIAL_REF
const STATIC_REF = 'DEEPSEEK_API_KEY'
const MODEL_ROOT = 'https://mvdcm.ecoremedia.net/e-mate/model-api'
const AUTH_ROOT = 'https://mvdcm.ecoremedia.net/e-mate/auth-api'
const NOW = Date.parse('2030-01-08T12:00:00.000Z')
const HOUR_MS = 3_600_000
const STALE_TOKEN = 'stale.gateway.token'
const FRESH_TOKEN = 'fresh.gateway.token'
const SUCCESS_TEXT = 'the request authenticated with the renewed credential'
const USAGE_PUBLIC_KEY = generateKeyPairSync('ed25519')
  .publicKey.export({ type: 'spki', format: 'pem' }).toString()

/** One enterprise session in exactly the shape the identity provider validates. */
function modelSession(token, modelExpiresAt, suffix) {
  return {
    schemaVersion: 1,
    sessionId: `session-${suffix}`,
    accessToken: 'access.payload.signature',
    refreshToken: `emate_rt_${suffix.repeat(43)}`,
    expiresAt: new Date(NOW + HOUR_MS).toISOString(),
    identity: {
      tenantId: 'tenant-test',
      userId: 'user-a',
      displayName: '测试用户',
      roles: ['AUDIT_ADMIN'],
      weeklyTokenLimit: 10_000,
    },
    modelGateway: {
      baseUrl: MODEL_ROOT,
      sessionToken: token,
      expiresAt: new Date(modelExpiresAt).toISOString(),
      usageKeyId: 'usage-key-test',
      usagePublicKey: USAGE_PUBLIC_KEY,
      allowedModelIds: ['gpt-5.6-luna'],
    },
  }
}

/**
 * A lease on disk whose gateway token already expired, plus the projection the
 * identity provider wrote for it — the state a request used to go out with.
 */
function seededExpiredLease(modelExpiresAt) {
  return {
    [SESSION_REF]: JSON.stringify({
      schema_version: 1,
      remember_login: true,
      received_at: new Date(NOW - 60_000).toISOString(),
      session: modelSession(STALE_TOKEN, modelExpiresAt, 'a'),
    }),
    [PRODUCT_REF]: STALE_TOKEN,
  }
}

/** An in-memory OS store: the value face, with the same backend contract. */
function memoryBackend(seed) {
  const values = new Map(Object.entries(seed))
  return {
    source: 'keychain',
    values,
    async get(ref) { return values.get(ref) },
    async has(ref) { return values.has(ref) },
    async set(ref, value) { values.set(ref, value) },
    async unset(ref) { return values.delete(ref) },
  }
}

const RECORDS_STUB = {
  readRecord: async () => undefined,
  describeRecord: async () => ({ configured: false, writable: true }),
  listRecords: async () => [],
  modifyRecord: async (_key, mutate) => mutate(undefined),
  deleteRecord: async () => {},
}

/**
 * The enterprise control plane, answering only the one call a renewal makes.
 * Any other path fails loud, so an unintended round trip can never pass as a
 * successful renewal.
 */
function controlPlane() {
  const calls = []
  const fetchImplementation = async input => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = new URL(href).pathname
    calls.push(path)
    if (!path.endsWith('/v1/auth/refresh')) throw new Error(`unexpected enterprise call: ${path}`)
    return new Response(JSON.stringify(modelSession(FRESH_TOKEN, NOW + HOUR_MS, 'b')), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchImplementation, calls }
}

/**
 * Compose the product provider stack the way `apply` does — value face, native
 * seam, product identity owner, native model adapter — without the managed
 * binding a packaged runtime supplies.
 */
async function productContext(t, { seed, baseURL, apiKeyEnv }) {
  const ctx = new Context()
  const backend = memoryBackend(seed)
  const store = new CredentialStore({ getFrom: () => undefined }, backend)
  const control = controlPlane()
  t.after(async () => { await ctx.fiber.dispose() })

  await mountAgentLoopTestDependencies(ctx)
  ctx.provide('webServer', {})
  ctx.provide('connection', { rpc: { handle: () => () => {} } })
  await ctx.plugin(Timer)
  await mountProductCredentialProvider(ctx, CredentialProvider, store, RECORDS_STUB)
  await ctx.plugin(
    { name: 'emate-identity', inject: identityPlugin.inject, apply: identityPlugin.apply },
    {
      providerLegalName: '亦芯',
      enterprise: {
        authBaseUrl: AUTH_ROOT,
        modelBaseUrl: MODEL_ROOT,
        clientId: 'e-mate-desktop',
        organization: 'emate-v2',
      },
      fetchImplementation: control.fetchImplementation,
      now: () => NOW,
    },
  )
  if (baseURL !== undefined) {
    await ctx.plugin(LlmDeepSeek, {
      baseURL,
      apiKeyEnv,
      retryPolicy: {
        mode: 'normal',
        maxRetries: 2,
        backoff: { initialDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
      },
    })
  }
  return { ctx, backend, control }
}

/** Run one real turn and return the assistant text it produced. */
async function runTurn(ctx, sessionId) {
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(sessionId), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'authenticate this turn' }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  const message = agent.session.deriveMessages().at(-1)
  return message?.role === 'assistant'
    ? message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    : undefined
}

test('a model request renews an expired product credential once and then succeeds', async (t) => {
  // The provider accepts only the renewed token, so a request that went out with
  // the stored one is rejected instead of passing as a success.
  const server = await startMockLlmServer({
    sequence: ['success'],
    successText: SUCCESS_TEXT,
    apiKey: FRESH_TOKEN,
  })
  t.after(async () => { await server.close() })
  const { ctx, backend, control } = await productContext(t, {
    seed: seededExpiredLease(NOW - 1_000),
    baseURL: server.baseURL,
    apiKeyEnv: PRODUCT_REF,
  })

  assert.equal(await runTurn(ctx, 'product-credential-renewal'), SUCCESS_TEXT)

  assert.equal(control.calls.length, 1, 'the lease owner renewed exactly once')
  assert.equal(server.requests.length, 1, 'the turn made exactly one model request')
  assert.equal(server.requests[0].headers.authorization, `Bearer ${FRESH_TOKEN}`)
  assert.equal(backend.values.get(PRODUCT_REF), FRESH_TOKEN, 'the renewed token is projected back')
  assert.equal((await ctx.get('credentials').resolve(PRODUCT_REF)).value, FRESH_TOKEN)
})

test('a non-product reference resolves as before and never wakes the lease owner', async (t) => {
  const server = await startMockLlmServer({
    sequence: ['success'],
    successText: SUCCESS_TEXT,
    apiKey: 'static-key',
  })
  t.after(async () => { await server.close() })
  const { ctx, backend, control } = await productContext(t, {
    seed: { ...seededExpiredLease(NOW - 1_000), [STATIC_REF]: 'static-key' },
    baseURL: server.baseURL,
    apiKeyEnv: STATIC_REF,
  })

  assert.equal(await runTurn(ctx, 'static-credential'), SUCCESS_TEXT)

  assert.equal(server.requests[0].headers.authorization, 'Bearer static-key')
  assert.deepEqual(control.calls, [], 'a static reference must not reach the lease owner')
  assert.equal(backend.values.get(PRODUCT_REF), STALE_TOKEN, 'nothing rewrote the product reference')
})

test('renewal belongs to the resolve-for-use path and runs once per due lease', async (t) => {
  const { ctx, backend, control } = await productContext(t, {
    seed: { ...seededExpiredLease(NOW - 1_000), [STATIC_REF]: 'static-key' },
  })
  const credentials = ctx.get('credentials')
  assert.equal(typeof ctx.get('emateIdentity')?.renewModelCredential, 'function')

  // Reading the stored value still means reading the stored value: this is the
  // credential the request used to authenticate with, and what it still is for
  // every consumer that only reads.
  assert.equal((await credentials.resolve(PRODUCT_REF)).value, STALE_TOKEN)
  assert.deepEqual(control.calls, [])

  // Resolving for use renews through the owner, then returns the renewed value.
  assert.equal((await credentials.resolveCurrent(PRODUCT_REF)).value, FRESH_TOKEN)
  assert.equal(control.calls.length, 1)
  assert.equal(backend.values.get(PRODUCT_REF), FRESH_TOKEN)

  // The renewed lease is no longer due, so the next request costs no round trip.
  assert.equal((await credentials.resolveCurrent(PRODUCT_REF)).value, FRESH_TOKEN)
  assert.equal(control.calls.length, 1)

  // Every other reference keeps the native default: the stored value and source.
  assert.deepEqual(await credentials.resolveCurrent(STATIC_REF), { value: 'static-key', source: 'keychain' })
  assert.equal(control.calls.length, 1)
})

test('the wiring still targets a seam default the product actually overrides', () => {
  assert.equal(typeof CredentialProvider.prototype.resolveCurrent, 'function')
  const Provider = createOsCredentialProvider(
    CredentialProvider,
    { resolve: async () => undefined },
    RECORDS_STUB,
  )
  assert.notEqual(
    Provider.prototype.resolveCurrent,
    CredentialProvider.prototype.resolveCurrent,
    'without this override the renewal never runs and the model path stays a no-op',
  )
  assert.equal(MODEL_SESSION_CREDENTIAL_REF, identityPlugin.MODEL_SESSION_REF)
})
