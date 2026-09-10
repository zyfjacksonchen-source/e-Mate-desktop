import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { stripTypeScriptTypes } from 'node:module'

const SESSION_REF = 'E_MATE_ENTERPRISE_SESSION'
const MODEL_SESSION_REF = 'E_MATE_MODEL_SESSION_TOKEN'
const MANAGED_REFS = [
  SESSION_REF,
  MODEL_SESSION_REF,
  'E_MATE_MODEL_KEY_GPT',
  'E_MATE_MODEL_KEY_DEEPSEEK',
  'E_MATE_MODEL_KEY_DOUBAO',
  'E_MATE_SEARCH_KEY_DEEPSEEK',
]
const NOW = Date.parse('2030-01-08T12:00:00.000Z')
const usagePublicKey = generateKeyPairSync('ed25519')
  .publicKey.export({ type: 'spki', format: 'pem' }).toString()

function session(now = NOW, suffix = 'a') {
  return {
    schemaVersion: 1,
    sessionId: `session-${suffix}`,
    accessToken: 'access.payload.signature',
    refreshToken: `emate_rt_${suffix.repeat(43)}`,
    expiresAt: new Date(now + 3_600_000).toISOString(),
    identity: {
      tenantId: 'tenant-test',
      userId: `user-${suffix}`,
      displayName: '测试用户',
      roles: ['AUDIT_ADMIN'],
      weeklyTokenLimit: 10_000,
    },
    modelGateway: {
      baseUrl: 'https://mvdcm.ecoremedia.net/e-mate/model-api',
      sessionToken: 'model.payload.signature',
      expiresAt: new Date(now + 3_600_000).toISOString(),
      usageKeyId: 'usage-key-test',
      usagePublicKey,
      allowedModelIds: ['gpt-5.6-luna'],
    },
  }
}

function stored(now = NOW, suffix = 'a') {
  return JSON.stringify({
    schema_version: 1,
    remember_login: true,
    received_at: new Date(now - 60_000).toISOString(),
    session: session(now, suffix),
  })
}

function options(credentials, fetchImplementation, now = () => NOW) {
  return {
    credentials,
    enterprise: {
      authBaseUrl: 'https://mvdcm.ecoremedia.net/e-mate/auth-api',
      modelBaseUrl: 'https://mvdcm.ecoremedia.net/e-mate/model-api',
      clientId: 'e-mate-desktop',
      organization: 'emate-v2',
    },
    fetchImplementation,
    now,
  }
}

function mapCredentials(values, overrides = {}) {
  return {
    resolve: async ref => values.has(ref) ? { value: values.get(ref), source: 'test' } : undefined,
    set: async (ref, value) => { values.set(ref, value) },
    unset: async ref => { values.delete(ref) },
    ...overrides,
  }
}

async function loadModelPolicySource() {
  const source = readFileSync(new URL('../src/profile/model-policy.ts', import.meta.url), 'utf8')
    .replace(
      "import { LOGGED_OUT_CREDENTIAL } from './credentials-os.js'",
      `const LOGGED_OUT_CREDENTIAL = '${LOGGED_OUT_CREDENTIAL}'`,
    )
    .replace(
      "import { loadTargetStorageDomain } from './target-runtime.js'",
      "const loadTargetStorageDomain = () => { throw new Error('unused in lifecycle test') }",
    )
    .replace('function createService(ctx, table, projectionTable, quota)',
      'export function createService(ctx, table, projectionTable, quota)')
  const compiled = stripTypeScriptTypes(source, { mode: 'transform' })
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}

async function loadEnterpriseProviderSource() {
  const source = readFileSync(new URL('../src/profile/identity/enterprise-provider.ts', import.meta.url), 'utf8')
    .replace(
      `import {
  agreementBundleSha256,
  agreementDocuments,
} from './agreements.js'`,
      "const agreementBundleSha256 = ''\nconst agreementDocuments = []",
    )
    .replace(
      "import { LOGGED_OUT_CREDENTIAL } from '../credentials-os.js'",
      `const LOGGED_OUT_CREDENTIAL = '${LOGGED_OUT_CREDENTIAL}'`,
    )
    .replace('function policyFor(value: StoredSession, runtime: readonly RuntimeModel[])',
      'export function policyFor(value: StoredSession, runtime: readonly RuntimeModel[])')
  const compiled = stripTypeScriptTypes(source, { mode: 'transform' })
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}

async function loadCredentialsSource() {
  const source = readFileSync(new URL('../src/profile/credentials-os.ts', import.meta.url), 'utf8')
    .replace(
      "import { loadTargetCredentials } from './target-runtime.js'",
      "const loadTargetCredentials = () => { throw new Error('unused in lifecycle test') }",
    )
  const compiled = stripTypeScriptTypes(source, { mode: 'transform' })
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}

async function loadIdentitySource() {
  const source = readFileSync(new URL('../src/profile/identity/index.ts', import.meta.url), 'utf8')
    .replace(
      /import \{[\s\S]*?\} from '\.\/agreements\.js'/u,
      "const agreementBundleSha256 = ''; const requiredAcknowledgements = []; const describeAgreements = () => ({ ready: true, bundle_sha256: '', required_acknowledgements: [], acknowledgements: [], documents: [] })",
    )
    .replace(
      /import \{[\s\S]*?\} from '\.\/enterprise-provider\.js'/u,
      "class IdentityServiceUnavailable extends Error { static [Symbol.hasInstance](value) { return value?.constructor?.name === 'IdentityServiceUnavailable' } }; const createEnterpriseIdentityProvider = () => { throw new Error('unused in lifecycle test') }; const loginRejectionMessage = () => undefined; const registrationRejectionMessage = () => undefined",
    )
    .replace(/export \{[^}]+\} from '\.\/enterprise-provider\.js'/u, '')
  const compiled = stripTypeScriptTypes(source, { mode: 'transform' })
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}

const { CredentialStore, LOGGED_OUT_CREDENTIAL } = await loadCredentialsSource()
const { createEnterpriseIdentityProvider } = await loadEnterpriseProviderSource()
const { apply: applyIdentity } = await loadIdentitySource()

test('remembered lease load is retryable and refresh retries reuse one opaque request id', async () => {
  let failProjection = true
  let clock = NOW
  const values = new Map([[SESSION_REF, stored()]])
  const credentials = mapCredentials(values, {
    set: async (ref, value) => {
      if (failProjection && ref === MODEL_SESSION_REF) throw new Error('simulated credential projection failure')
      values.set(ref, value)
    },
  })
  const refreshIds = []
  let refreshAttempt = 0
  const provider = createEnterpriseIdentityProvider(options(credentials, async (input, init) => {
    assert.equal(new URL(input).pathname.endsWith('/v1/auth/refresh'), true)
    const body = JSON.parse(String(init.body))
    refreshIds.push(body.refreshRequestId)
    refreshAttempt += 1
    if (refreshAttempt === 1) {
      return new Response(JSON.stringify({ error: { code: 'RATE_LIMITED' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (refreshAttempt === 2) throw new Error('simulated response loss')
    return new Response(JSON.stringify(session(clock, 'b')), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }, () => clock))

  await assert.rejects(provider.bootstrap(), /credential projection failure/u)
  failProjection = false
  assert.equal((await provider.bootstrap()).authenticated, true)

  clock += 3_600_001
  await assert.rejects(provider.keepAlive())
  assert.equal(values.has(SESSION_REF), true, 'a retryable refresh failure must retain the remembered lease')
  await assert.rejects(provider.keepAlive())
  await provider.keepAlive()
  assert.equal(refreshIds.length, 3)
  assert.equal(new Set(refreshIds).size, 1)
  assert.match(refreshIds[0], /^refresh-v1-[A-Za-z0-9_-]{43}$/u)
  assert.equal(JSON.parse(values.get(SESSION_REF)).session.sessionId, 'session-b')
})

test('expired remembered identity stays locally available but cannot claim enterprise authentication', async () => {
  const { createEnterpriseIdentityProvider: createProvider } = await loadEnterpriseProviderSource()
  const values = new Map([[SESSION_REF, stored()]])
  const provider = createProvider(options(mapCredentials(values), async () => { throw new Error('control plane offline') }, () => NOW + 3_600_001))
  assert.deepEqual(await provider.bootstrap(), { authenticated: false, workspace_unlocked: false })
  await assert.rejects(provider.modelRuntimePolicy(), /暂时不可用/u)
  assert.equal(values.has(SESSION_REF), true, 'nonauthoritative remembered metadata may remain refreshable')
})

test('an unexpired remembered identity keeps enterprise authentication when the control plane is unreachable', async () => {
  const { createEnterpriseIdentityProvider: createProvider } = await loadEnterpriseProviderSource()
  const provider = createProvider(options(mapCredentials(new Map([[SESSION_REF, stored()]])), async () => {
    throw new Error('control plane offline')
  }))
  // The installed client shows its login page only for a bootstrap that reports authenticated=false.
  // A control-plane outage must therefore never be reported as a signed-out state while a usable
  // remembered lease exists; only the expiry case above may drop enterprise authentication.
  const state = await provider.bootstrap()
  assert.equal(state.authenticated, true)
  assert.equal(state.workspace_unlocked, true)
})

test('a valid model lease reaches the live Gateway during control outage but not at expiry', async () => {
  const { createEnterpriseIdentityProvider: createProvider } = await loadEnterpriseProviderSource()
  let clock = NOW
  const remembered = JSON.parse(stored())
  remembered.session.modelGateway.expiresAt = new Date(NOW + 30_000).toISOString()
  const values = new Map([[SESSION_REF, JSON.stringify(remembered)], [MODEL_SESSION_REF, 'model.payload.signature']])
  let gatewayRequests = 0
  const provider = createProvider(options(mapCredentials(values), async input => {
    const path = new URL(input).pathname
    if (path.endsWith('/v1/auth/refresh')) throw new Error('control plane offline')
    assert.equal(path.endsWith('/v1/runtime-models'), true)
    gatewayRequests += 1
    return Response.json({
      schemaVersion: 1,
      models: [{
        id: 'gpt-5.6-luna', apiMode: 'responses', upstreamModelId: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna', input: ['text', 'image'], reasoning: true,
        contextWindow: 1_050_000, maxTokens: 128_000,
      }],
      searchCredentialGrant: {
        schemaVersion: 1, status: 'denied', purpose: 'web-search',
        provider: 'deepseek-official', credentialRef: 'E_MATE_SEARCH_KEY_DEEPSEEK',
      },
    })
  }, () => clock))

  const live = await provider.modelRuntimePolicy()
  assert.equal(live.models[0].credentialRef, MODEL_SESSION_REF)
  assert.equal(live.models[0].upstreamBaseUrl, 'https://mvdcm.ecoremedia.net/e-mate/model-api/v1')
  assert.equal('upstreamApiKey' in live.models[0], false)
  assert.equal(gatewayRequests, 1)

  clock = NOW + 30_000
  await assert.rejects(provider.modelRuntimePolicy(), /暂时不可用/u)
  assert.equal(gatewayRequests, 1)
})

test('terminal refresh revocation clears every managed ref before access expiry', async () => {
  const { createEnterpriseIdentityProvider: createProvider } = await loadEnterpriseProviderSource()
  for (const code of ['INVALID_GRANT', 'SESSION_REVOKED', 'TOKEN_REUSED']) {
    const remembered = JSON.parse(stored())
    remembered.session.modelGateway.expiresAt = new Date(NOW + 30_000).toISOString()
    const values = new Map(MANAGED_REFS.map(ref => [ref, ref === SESSION_REF ? JSON.stringify(remembered) : `managed-${ref}`]))
    const provider = createProvider(options(mapCredentials(values), async input => {
      assert.equal(new URL(input).pathname.endsWith('/v1/auth/refresh'), true)
      return new Response(JSON.stringify({ error: { code } }), {
        status: 401, headers: { 'content-type': 'application/json' },
      })
    }))
    await assert.rejects(provider.bootstrap(), error => {
      assert.equal(error.code, code)
      return true
    })
    assert.equal(values.size, 0)
    assert.deepEqual(await provider.bootstrap(), { authenticated: false, workspace_unlocked: false })
  }
})

test('logout clears all six local refs before the network and only a valid receipt proves remote revocation', async () => {
  let clock = NOW
  const values = new Map(MANAGED_REFS.map(ref => [ref, ref === SESSION_REF ? stored() : `managed-${ref}`]))
  const requests = []
  const provider = createEnterpriseIdentityProvider(options(mapCredentials(values), async input => {
    requests.push(new URL(input).pathname)
    assert.equal(values.size, 0, 'the device must be stopped before remote revocation is awaited')
    return new Response('private upstream body', { status: 503 })
  }, () => clock))
  assert.equal((await provider.bootstrap()).authenticated, true)
  clock += 3_600_001

  const first = provider.logout({ client_request_id: 'logout-test-one' })
  const repeated = provider.logout({ client_request_id: 'logout-test-one' })
  assert.deepEqual(await Promise.all([first, repeated]), [
    { remote_revocation: 'unknown' },
    { remote_revocation: 'unknown' },
  ])
  assert.deepEqual(requests, ['/e-mate/auth-api/v1/auth/logout'])
  assert.equal(values.size, 0)
  assert.deepEqual(await provider.bootstrap(), { authenticated: false, workspace_unlocked: false })

  const remoteCases = [
    [new Response(JSON.stringify({
      schemaVersion: 1,
      receiptId: 'logout-receipt-test',
      reauthenticationRequired: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } }), {
      remote_revocation: 'revoked', receipt_id: 'logout-receipt-test',
    }],
    [new Response(JSON.stringify({ schemaVersion: 1, receiptId: '' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }), { remote_revocation: 'unknown' }],
    [new Response(JSON.stringify({ error: { code: 'SESSION_REVOKED', message: 'private detail' } }), {
      status: 401, headers: { 'content-type': 'application/json' },
    }), { remote_revocation: 'unknown' }],
  ]
  for (const [response, expected] of remoteCases) {
    const remoteValues = new Map([[SESSION_REF, stored()], [MODEL_SESSION_REF, 'model.payload.signature']])
    const remote = createEnterpriseIdentityProvider(options(mapCredentials(remoteValues), async () => response.clone()))
    assert.equal((await remote.bootstrap()).authenticated, true)
    const result = await remote.logout({ client_request_id: 'logout-remote-case' })
    assert.deepEqual(result, expected)
    assert.doesNotMatch(JSON.stringify(result), /private|HTTP|upstream/u)
  }
})

test('managed refs ignore environment fallbacks and a per-ref delete failure stays closed after restart', async () => {
  const environment = { getFrom: () => ({ value: 'environment-secret', source: 'project-env' }) }
  const environmentOnly = new CredentialStore(environment, {
    source: 'keychain',
    get: async () => undefined,
    has: async () => false,
    set: async () => {},
    unset: async () => false,
  })
  for (const ref of MANAGED_REFS) {
    assert.equal(await environmentOnly.resolve(ref), undefined)
    assert.deepEqual(await environmentOnly.describe(ref), { configured: false, writable: true })
  }
  for (const failedRef of MANAGED_REFS) {
    const values = new Map(MANAGED_REFS.map(ref => [ref, ref === SESSION_REF ? stored() : `managed-${ref}`]))
    const backend = {
      source: 'keychain',
      get: async ref => values.get(ref),
      has: async ref => values.has(ref),
      set: async (ref, value) => { values.set(ref, value) },
      unset: async ref => {
        if (ref === failedRef) throw new Error('raw keychain delete failure')
        return values.delete(ref)
      },
    }
    const credentials = new CredentialStore(environment, backend)
    const provider = createEnterpriseIdentityProvider(options(credentials, async () => new Response('', { status: 503 })))
    assert.equal((await provider.bootstrap()).authenticated, true)
    await assert.rejects(
      provider.logout({ client_request_id: `logout-failed-${failedRef}` }),
      /credentials could not be cleared/u,
    )
    assert.equal(values.get(failedRef), LOGGED_OUT_CREDENTIAL)
    assert.equal(await credentials.resolve(failedRef), undefined)
    assert.deepEqual(await credentials.describe(failedRef), { configured: false, writable: true })

    const restartedCredentials = new CredentialStore(environment, backend)
    assert.equal(await restartedCredentials.resolve(failedRef), undefined)
    const restartedProvider = createEnterpriseIdentityProvider(options(
      restartedCredentials,
      async () => { throw new Error('a closed restart must not use the network') },
    ))
    assert.deepEqual(await restartedProvider.bootstrap(), {
      authenticated: false,
      workspace_unlocked: false,
    })
  }
})

test('marker and delete double rejection remains an explicit cold-restart release blocker', async () => {
  const values = new Map([[SESSION_REF, stored()], [MODEL_SESSION_REF, 'model.payload.signature']])
  const credentials = mapCredentials(values, {
    set: async (ref, value) => {
      if (ref === SESSION_REF) throw new Error('raw keychain marker failure')
      values.set(ref, value)
    },
    unset: async ref => {
      if (ref === SESSION_REF) throw new Error('raw keychain delete failure')
      values.delete(ref)
    },
  })
  const provider = createEnterpriseIdentityProvider(options(credentials, async () => new Response('', { status: 503 })))
  assert.equal((await provider.bootstrap()).authenticated, true)
  await assert.rejects(
    provider.logout({ client_request_id: 'logout-double-rejection' }),
    /credentials could not be cleared/u,
  )
  assert.deepEqual(await provider.bootstrap(), { authenticated: false, workspace_unlocked: false })
  assert.equal(values.get(SESSION_REF), stored(), 'the durable lease remains unresolved and must block release')

  const restarted = createEnterpriseIdentityProvider(options(credentials, async () => {
    throw new Error('the unresolved keystore failure must remain visible')
  }))
  assert.equal((await restarted.bootstrap()).authenticated, true)
})

test('late load and older login generations cannot revive or replace the current lease', async () => {
  const loadingValues = new Map([[SESSION_REF, stored()]])
  let releaseLoad
  let markLoadStarted
  const loadStarted = new Promise(resolve => { markLoadStarted = resolve })
  const loadGate = new Promise(resolve => { releaseLoad = resolve })
  const loadingProvider = createEnterpriseIdentityProvider(options(mapCredentials(loadingValues, {
    resolve: async ref => {
      const hit = loadingValues.has(ref) ? { value: loadingValues.get(ref), source: 'test' } : undefined
      if (ref === SESSION_REF) {
        markLoadStarted()
        await loadGate
      }
      return hit
    },
  }), async () => new Response('', { status: 503 })))
  const loading = loadingProvider.bootstrap()
  await loadStarted
  assert.deepEqual(await loadingProvider.logout({ client_request_id: 'logout-during-load' }), {
    remote_revocation: 'unknown',
  })
  releaseLoad()
  await assert.rejects(loading, /session mutation was superseded/u)
  assert.deepEqual(await loadingProvider.bootstrap(), { authenticated: false, workspace_unlocked: false })

  const values = new Map()
  let resolveFirst
  let resolveLater
  const first = new Promise(resolve => { resolveFirst = resolve })
  const later = new Promise(resolve => { resolveLater = resolve })
  const provider = createEnterpriseIdentityProvider(options(mapCredentials(values), async (_input, init) => {
    const identifier = JSON.parse(String(init.body)).user
    return identifier === 'first-user' ? first : later
  }))
  const olderLogin = provider.login({ identifier: 'first-user', password: 'first-password', remember_login: true })
  const olderRejected = assert.rejects(olderLogin, /session mutation was superseded/u)
  const newerLogin = provider.login({ identifier: 'later-user', password: 'later-password', remember_login: true })
  resolveLater(new Response(JSON.stringify(session(NOW, 'b')), {
    status: 200, headers: { 'content-type': 'application/json' },
  }))
  await newerLogin
  resolveFirst(new Response(JSON.stringify(session(NOW, 'a')), {
    status: 200, headers: { 'content-type': 'application/json' },
  }))
  await olderRejected
  assert.equal(JSON.parse(values.get(SESSION_REF)).session.sessionId, 'session-b')
})

test('late refresh and runtime policy responses cannot revive credentials after logout or a newer login', async () => {
  let clock = NOW
  const values = new Map([[SESSION_REF, stored()], [MODEL_SESSION_REF, 'model.payload.signature']])
  let releaseRefresh
  let markRefreshStarted
  const refreshStarted = new Promise(resolve => { markRefreshStarted = resolve })
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve })
  const provider = createEnterpriseIdentityProvider(options(mapCredentials(values), async (input, init) => {
    const path = new URL(input).pathname
    if (path.endsWith('/v1/auth/refresh')) {
      markRefreshStarted()
      await refreshGate
      return new Response(JSON.stringify(session(clock, 'a')), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (path.endsWith('/v1/auth/password')) {
      return new Response(JSON.stringify(session(clock, 'b')), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    assert.equal(path.endsWith('/v1/auth/logout'), true)
    return new Response('', { status: 503 })
  }, () => clock))
  assert.equal((await provider.bootstrap()).authenticated, true)
  clock += 3_600_001
  const staleRefresh = provider.bootstrap()
  const refreshRejected = assert.rejects(staleRefresh, /session mutation was superseded/u)
  await refreshStarted
  assert.deepEqual(await provider.logout({ client_request_id: 'logout-during-refresh' }), {
    remote_revocation: 'unknown',
  })
  await provider.login({ identifier: 'newer-user', password: 'newer-password', remember_login: true })
  releaseRefresh()
  await refreshRejected
  assert.equal(JSON.parse(values.get(SESSION_REF)).session.sessionId, 'session-b')

  let releasePolicy
  let markPolicyStarted
  const policyStarted = new Promise(resolve => { markPolicyStarted = resolve })
  const policyGate = new Promise(resolve => { releasePolicy = resolve })
  const policyValues = new Map([[SESSION_REF, stored()], [MODEL_SESSION_REF, 'model.payload.signature']])
  const policyProvider = createEnterpriseIdentityProvider(options(mapCredentials(policyValues), async input => {
    const path = new URL(input).pathname
    if (path.endsWith('/v1/runtime-models')) {
      assert.equal(new URL(input).searchParams.get('client_version'), '2.0.17')
      markPolicyStarted()
      await policyGate
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    assert.equal(path.endsWith('/v1/auth/logout'), true)
    return new Response('', { status: 503 })
  }))
  assert.equal((await policyProvider.bootstrap()).authenticated, true)
  const stalePolicy = policyProvider.modelRuntimePolicy()
  const policyRejected = assert.rejects(stalePolicy, /session mutation was superseded/u)
  await policyStarted
  assert.deepEqual(await policyProvider.logout({ client_request_id: 'logout-during-policy' }), {
    remote_revocation: 'unknown',
  })
  releasePolicy()
  await policyRejected
  assert.equal(policyValues.size, 0)
})

test('identity RPC returns only legal redacted rc.7 logout envelopes', async () => {
  let handler
  let mode = 'unknown'
  const warnings = []
  applyIdentity({
    connection: { rpc: { handle: (_channel, candidate) => {
      handler = candidate
      return async () => {}
    } } },
    provide: () => {},
    effect: effect => effect(),
    logger: { warn: value => { warnings.push(value) } },
  }, {
    providerLegalName: '亦芯测试主体',
    identityProvider: {
      logout: async () => {
        if (mode === 'cleanup') throw new Error('private raw keychain detail /Users/example')
        return mode === 'revoked'
          ? { remote_revocation: 'revoked', receipt_id: 'receipt-test' }
          : { remote_revocation: 'unknown' }
      },
      bootstrap: async () => {
        if (mode === 'bootstrap') throw new Error('private bootstrap transport detail')
        return { authenticated: false, workspace_unlocked: false }
      },
      login: async () => { throw new Error('private upstream HTTP 500 /Users/example') },
    },
  })

  const carry = result => {
    if (!result.ok) assert.ok(['bad-request', 'cancelled', 'internal'].includes(result.error.code))
    return structuredClone(result)
  }
  for (const [nextMode, expected] of [
    ['unknown', { remote_revocation: 'unknown' }],
    ['revoked', { remote_revocation: 'revoked', receipt_id: 'receipt-test' }],
  ]) {
    mode = nextMode
    const result = await handler('session.logout', {
      client_request_id: `session_logout:${nextMode}`,
      confirmed: true,
    })
    const carried = carry(result)
    assert.equal(carried.value.state.authenticated, false)
    assert.equal(carried.value.state.workspace_unlocked, false)
    assert.deepEqual(carried, {
      ok: true,
      value: {
        schema_version: 1,
        ...expected,
        state: result.value.state,
      },
    })
  }

  mode = 'cleanup'
  const cleanup = carry(await handler('session.logout', {
    client_request_id: 'session_logout:cleanup',
    confirmed: true,
  }))
  assert.equal(cleanup.ok, false)
  assert.equal(cleanup.error.code, 'internal')
  assert.deepEqual(cleanup.error.details, {})
  assert.doesNotMatch(JSON.stringify(cleanup), /private|keychain|Users/u)

  mode = 'login'
  const login = carry(await handler('session.login', {
    identifier: 'test-user', password: 'secret-value', remember_login: true,
  }))
  assert.deepEqual(login, {
    ok: false,
    error: { code: 'internal', message: '企业身份服务暂时不可用，请稍后重试。', details: {} },
  })
  assert.doesNotMatch(JSON.stringify(login), /private|HTTP|Users|secret-value/u)
  assert.doesNotMatch(warnings.join('\n'), /private|HTTP|Users|secret-value/u)
})

test('identity activity RPC validates the range, maps exact private-free buckets and types unavailability', async () => {
  const values = new Map([[SESSION_REF, stored()]])
  let unavailable = false
  const requests = []
  const provider = createEnterpriseIdentityProvider(options(mapCredentials(values), async input => {
    const url = new URL(input)
    requests.push(url)
    if (unavailable) {
      return new Response(JSON.stringify({ error: { code: 'USAGE_ACTIVITY_UNAVAILABLE' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({
      schemaVersion: 1,
      timezone: 'Asia/Shanghai',
      startDate: '2024-02-29',
      endDate: '2024-03-01',
      days: [
        {
          date: '2024-02-29',
          total: '9007199254741005',
          input: '9007199254740993',
          output: '7',
          cacheRead: '3',
          cacheWrite: '2',
        },
        { date: '2024-03-01', total: '0', input: '0', output: '0', cacheRead: '0', cacheWrite: '0' },
      ],
      periodTotal: '9007199254741005',
      calculatedAt: '2024-03-02T00:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  let handler
  applyIdentity({
    connection: { rpc: { handle: (_channel, candidate) => {
      handler = candidate
      return async () => {}
    } } },
    provide: () => {},
    effect: effect => effect(),
    logger: { warn: () => {} },
  }, { providerLegalName: '亦芯测试主体', identityProvider: provider })

  const result = await handler('identity.usage.activity', {
    timezone: 'Asia/Shanghai', start_date: '2024-02-29', end_date: '2024-03-01',
  })
  assert.deepEqual(result, {
    ok: true,
    value: {
      schema_version: 1,
      timezone: 'Asia/Shanghai',
      start_date: '2024-02-29',
      end_date: '2024-03-01',
      days: [
        {
          date: '2024-02-29',
          total: '9007199254741005',
          input: '9007199254740993',
          output: '7',
          cache_read: '3',
          cache_write: '2',
        },
        { date: '2024-03-01', total: '0', input: '0', output: '0', cache_read: '0', cache_write: '0' },
      ],
      period_total: '9007199254741005',
      calculated_at: '2024-03-02T00:00:00.000Z',
    },
  })
  assert.equal(requests[0].pathname.endsWith('/v1/usage/activity'), true)
  assert.deepEqual([...requests[0].searchParams], [
    ['timezone', 'Asia/Shanghai'],
    ['start_date', '2024-02-29'],
    ['end_date', '2024-03-01'],
  ])
  assert.doesNotMatch(JSON.stringify(result), /account|subject|prompt|session|title|file|tool|plugin|content/i)

  for (const payload of [
    { timezone: 'UTC+8', start_date: '2024-02-29', end_date: '2024-03-01' },
    { timezone: 'UTC', start_date: '2023-01-01', end_date: '2024-01-02' },
  ]) {
    assert.equal((await handler('identity.usage.activity', payload)).error.code, 'bad-request')
  }
  assert.equal(requests.length, 1)

  unavailable = true
  assert.deepEqual(await handler('identity.usage.activity', {
    timezone: 'Asia/Shanghai', start_date: '2024-02-29', end_date: '2024-03-01',
  }), {
    ok: false,
    error: {
      code: 'unavailable',
      message: 'Token 使用数据暂时不可用，请稍后重试。',
      details: { reason: 'usage-service-unavailable' },
    },
  })
})

test('image input contract trusts exact model metadata and preserves native attachments unless text-only is confirmed', async () => {
  const { modelImageInputContract } = await loadModelPolicySource()
  const durable = Object.freeze({
    type: 'image',
    attachment: Object.freeze({ attachmentId: 'att-1', mediaType: 'image/png', bytes: 3 }),
  })
  const before = structuredClone(durable)
  assert.deepEqual(modelImageInputContract({
    provider: 'enterprise', id: 'plain-name', inputModalities: ['text', 'image'],
  }, 'enterprise', 'plain-name'), {
    schema_version: 1,
    capability: 'image-capable',
    request_boundary: 'preserve-native',
  })
  assert.deepEqual(modelImageInputContract({
    provider: 'enterprise', id: 'vision-in-name', inputModalities: ['text'],
  }, 'enterprise', 'vision-in-name'), {
    schema_version: 1,
    capability: 'text-only',
    request_boundary: 'convert-at-request-boundary',
  })
  for (const metadata of [
    { provider: 'enterprise', id: 'unknown' },
    { provider: 'other', id: 'unknown', inputModalities: ['text'] },
    { provider: 'enterprise', id: 'unknown', inputModalities: ['text', 'audio'] },
  ]) {
    assert.deepEqual(modelImageInputContract(metadata, 'enterprise', 'unknown'), {
      schema_version: 1,
      capability: 'unknown',
      request_boundary: 'preserve-native',
    })
  }
  assert.deepEqual(durable, before, 'capability resolution must never rewrite durable image blocks')
})

test('client and enterprise identity image policies expose only gpt-image-2-pro without fallback', async () => {
  const { validateModelPolicy } = await loadModelPolicySource()
  const { policyFor } = await loadEnterpriseProviderSource()
  const accountSubject = 'tenant-test:user-a'
  const rawPolicy = {
    schema_version: 1,
    account_subject: accountSubject,
    revision: 1,
    allowed_model_ids: ['gpt-5.6-luna', 'gpt-image-2-pro'],
    default_chat_model_id: 'gpt-5.6-luna',
    default_chat_reasoning_effort: 'max',
    image_primary_model_id: 'gpt-image-2-pro',
    issued_at: new Date(NOW - 60_000).toISOString(),
    expires_at: new Date(NOW + 3_600_000).toISOString(),
    receipt_id: 'policy-receipt:test-user',
  }
  const policy = validateModelPolicy(rawPolicy, accountSubject, NOW)
  assert.deepEqual(policy.allowed_model_ids.filter(id => id.startsWith('gpt-image-')), ['gpt-image-2-pro'])
  assert.equal('image_fallback_upstream_model_id' in policy, false)
  assert.throws(() => validateModelPolicy({
    ...rawPolicy,
    allowed_model_ids: [...rawPolicy.allowed_model_ids, 'gpt-image-2'],
  }, accountSubject, NOW), /policy is invalid/u)
  assert.throws(() => validateModelPolicy({
    ...rawPolicy,
    image_fallback_upstream_model_id: 'gpt-image-2',
  }, accountSubject, NOW), /policy is invalid/u)

  const remembered = JSON.parse(stored())
  remembered.session.modelGateway.allowedModelIds = ['gpt-5.6-luna', 'gpt-image-2-pro', 'gpt-image-2']
  const identityPolicy = policyFor(remembered, [{ id: 'gpt-5.6-luna' }])
  assert.deepEqual(identityPolicy.allowed_model_ids, ['gpt-5.6-luna', 'gpt-image-2-pro'])
  assert.deepEqual(identityPolicy.allowed_model_ids.filter(id => id.startsWith('gpt-image-')), ['gpt-image-2-pro'])
  assert.equal('image_fallback_upstream_model_id' in identityPolicy, false)
})

test('identity credential generation fences a late runtime projection without permanently dropping models', async () => {
  const { createService } = await loadModelPolicySource()
  const credentials = new Map([[MODEL_SESSION_REF, 'model.payload.signature']])
  const policyRecords = new Map()
  const projectionRecords = new Map()
  const settings = new Map()
  let failDefaultModelWrite = false
  const settingRevisions = new Map([
    ['llm-pi-ai', 0],
    ['agent-default-model', 0],
  ])
  const handlers = new Map()
  let releaseCatalog
  let markCatalogStarted
  const catalogStarted = new Promise(resolve => { markCatalogStarted = resolve })
  const catalogGate = new Promise(resolve => { releaseCatalog = resolve })
  let catalogDelay = { started: markCatalogStarted, wait: catalogGate }
  const now = Date.now()
  const policy = {
    schema_version: 1,
    account_subject: 'account:test-user',
    revision: 1,
    allowed_model_ids: ['gpt-5.6-luna', 'gpt-image-2-pro'],
    default_chat_model_id: 'gpt-5.6-luna',
    default_chat_reasoning_effort: 'max',
    image_primary_model_id: 'gpt-image-2-pro',
    issued_at: new Date(now - 1_000).toISOString(),
    expires_at: new Date(now + 3_600_000).toISOString(),
    receipt_id: 'policy-receipt:test-user',
  }
  const runtime = {
    policy,
    models: [{
      id: 'gpt-5.6-luna',
      provider: 'e-mate-enterprise',
      credentialRef: MODEL_SESSION_REF,
      api: 'openai-responses',
      upstreamModelId: 'gpt-5.6-luna',
      upstreamBaseUrl: 'https://mvdcm.ecoremedia.net/e-mate/model-api/v1',
      label: 'GPT-5.6 Luna',
      input: ['text', 'image'],
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    }],
    searchCredentialGrant: {
      schemaVersion: 1,
      status: 'granted',
      purpose: 'web-search',
      provider: 'deepseek-official',
      credentialRef: 'E_MATE_SEARCH_KEY_DEEPSEEK',
      upstreamApiKey: 'runtime-search-key-redacted-for-test',
    },
  }
  let runtimeOffline = false
  const ctx = {
    emateIdentity: {
      state: async () => ({
        authenticated: true,
        workspace_unlocked: true,
        account_subject: policy.account_subject,
      }),
      modelRuntimePolicy: async () => {
        if (runtimeOffline) throw new Error('simulated offline runtime policy')
        const response = structuredClone(runtime)
        const delay = catalogDelay
        catalogDelay = undefined
        if (delay !== undefined) {
          delay.started()
          await delay.wait
        }
        return response
      },
      localAccountSubject: () => policy.account_subject,
    },
    credentials: {
      resolve: async ref => credentials.has(ref) ? { value: credentials.get(ref), source: 'test' } : undefined,
      set: async (ref, value) => { credentials.set(ref, value) },
      unset: async ref => { credentials.delete(ref) },
    },
    settings: {
      get: name => structuredClone(settings.get(name)),
      describe: () => [...settingRevisions].map(([ns, revision]) => ({ ns, revision })),
      replace: async (name, value, revision) => {
        assert.equal(revision, settingRevisions.get(name))
        if (name === 'agent-default-model' && failDefaultModelWrite) {
          failDefaultModelWrite = false
          throw new Error('simulated default model failure')
        }
        settings.set(name, structuredClone(value))
        settingRevisions.set(name, revision + 1)
      },
    },
    llm: {
      resolveModelInfo: async (provider, model) => ({
        provider,
        id: model,
        inputModalities: ['text', 'image'],
      }),
    },
    on: (event, handler) => {
      handlers.set(event, handler)
      return () => { handlers.delete(event) }
    },
    logger: { warn: () => {} },
  }
  const table = {
    entries: () => policyRecords.entries(),
    put: async (key, value) => { policyRecords.set(key, structuredClone(value)) },
  }
  const projectionTable = {
    get: key => projectionRecords.get(key),
    put: async (key, value) => { projectionRecords.set(key, structuredClone(value)) },
    delete: async key => { projectionRecords.delete(key) },
  }
  const service = createService(ctx, table, projectionTable, { refresh: async () => {} })
  assert.equal(typeof handlers.get('credentials/updated'), 'function')

  const lateProjection = service.refresh({ force: true })
  const lateRejected = assert.rejects(lateProjection, /superseded/u)
  await catalogStarted
  handlers.get('credentials/updated')(SESSION_REF)
  releaseCatalog()
  await lateRejected
  for (const ref of MANAGED_REFS.slice(2)) assert.equal(credentials.has(ref), false)
  assert.equal(credentials.get(MODEL_SESSION_REF), 'model.payload.signature')
  assert.equal(projectionRecords.has('active'), false)

  settings.set('llm-pi-ai', {
    providers: { legacy: { apiKeyEnv: 'E_MATE_MODEL_KEY_GPT', baseURL: 'https://provider.example/v1' } },
  })
  for (const ref of ['E_MATE_MODEL_KEY_GPT', 'E_MATE_MODEL_KEY_DEEPSEEK', 'E_MATE_MODEL_KEY_DOUBAO']) {
    credentials.set(ref, `obsolete-${ref}`)
  }
  failDefaultModelWrite = true
  await assert.rejects(service.refresh({ force: true }), /default model failure/u)
  assert.deepEqual(settings.get('llm-pi-ai'), { providers: {} })
  for (const ref of ['E_MATE_MODEL_KEY_GPT', 'E_MATE_MODEL_KEY_DEEPSEEK', 'E_MATE_MODEL_KEY_DOUBAO']) {
    assert.equal(credentials.has(ref), false)
  }

  assert.equal((await service.refresh({ force: true })).revision, 1)
  for (const ref of ['E_MATE_MODEL_KEY_GPT', 'E_MATE_MODEL_KEY_DEEPSEEK', 'E_MATE_MODEL_KEY_DOUBAO']) {
    assert.equal(credentials.has(ref), false)
  }
  assert.equal(credentials.get(MODEL_SESSION_REF), 'model.payload.signature')
  assert.equal(credentials.get('E_MATE_SEARCH_KEY_DEEPSEEK'), runtime.searchCredentialGrant.upstreamApiKey)
  assert.deepEqual(settings.get('llm-pi-ai').providers['e-mate-enterprise'].models[0].input, ['text', 'image'])
  assert.deepEqual(await service.imageInputContract('e-mate-enterprise', 'gpt-5.6-luna'), {
    schema_version: 1,
    capability: 'image-capable',
    request_boundary: 'preserve-native',
  })

  runtime.policy.revision = 2
  runtime.searchCredentialGrant = {
    schemaVersion: 1,
    status: 'denied',
    purpose: 'web-search',
    provider: 'deepseek-official',
    credentialRef: 'E_MATE_SEARCH_KEY_DEEPSEEK',
  }
  await service.refresh({ force: true })
  assert.equal(credentials.has('E_MATE_SEARCH_KEY_DEEPSEEK'), false)
  assert.equal(credentials.has('E_MATE_MODEL_KEY_GPT'), false)
  assert.equal(projectionRecords.get('active').search_status, 'denied')

  runtime.policy.revision = 3
  runtime.searchCredentialGrant.status = 'unavailable'
  await service.refresh({ force: true })
  assert.equal(credentials.has('E_MATE_SEARCH_KEY_DEEPSEEK'), false)
  assert.equal(projectionRecords.get('active').search_status, 'unavailable')
  runtimeOffline = true
  assert.equal((await service.refresh({ force: true })).revision, 3)
  assert.equal(credentials.has('E_MATE_SEARCH_KEY_DEEPSEEK'), false)
  assert.equal(credentials.has('E_MATE_MODEL_KEY_GPT'), false)
  runtimeOffline = false

  let releaseSupersededCatalog
  let markSupersededCatalogStarted
  const supersededCatalogStarted = new Promise(resolve => { markSupersededCatalogStarted = resolve })
  catalogDelay = {
    started: markSupersededCatalogStarted,
    wait: new Promise(resolve => { releaseSupersededCatalog = resolve }),
  }
  const staleA = service.refresh({ force: true })
  await supersededCatalogStarted
  policy.account_subject = 'account:next-user'
  policy.revision = 4
  policy.receipt_id = 'policy-receipt:next-user'
  handlers.get('credentials/updated')(SESSION_REF)
  const freshB = service.refresh({ force: true })
  releaseSupersededCatalog()
  await assert.rejects(staleA, /superseded/u)
  const b = await freshB
  assert.equal(b.account_subject, 'account:next-user')
  assert.equal(policyRecords.get('active').account_subject, 'account:next-user')

  const originalNow = Date.now
  let clock = now
  Date.now = () => clock
  try {
    policy.revision = 5
    policy.issued_at = new Date(clock - 1_000).toISOString()
    policy.expires_at = new Date(clock + 1_000).toISOString()
    await service.refresh({ force: true })
    assert.equal(policyRecords.get('active').revision, 5)

    let releaseExpiringCatalog
    let markExpiringCatalogStarted
    const expiringCatalogStarted = new Promise(resolve => { markExpiringCatalogStarted = resolve })
    catalogDelay = {
      started: markExpiringCatalogStarted,
      wait: new Promise(resolve => { releaseExpiringCatalog = resolve }),
    }
    policy.revision = 6
    const expiring = service.refresh({ force: true })
    await expiringCatalogStarted
    clock += 1_000
    releaseExpiringCatalog()
    await assert.rejects(expiring, /lifetime is invalid/u)
    assert.equal(policyRecords.get('active').revision, 5)
    assert.equal(projectionRecords.get('active').policy_revision, 5)
  } finally {
    Date.now = originalNow
  }
})
