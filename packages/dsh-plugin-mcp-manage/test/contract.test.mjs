import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { readCollectedOutput } from '../lib/collected-output.mjs'
import { parseOAuthCallback } from '../lib/oauth-callback.mjs'
import { validatePluginInstall, validatePluginPackageName } from '../lib/plugin-source.mjs'
import { isMcpServerActive, validXinPrincipal, verifiedXinCapabilities, hasUnexpiredOAuthAccess, oauthFailureKind, parseXinCapabilities } from '../lib/status.mjs'
import { createXinConnection, XIN_SERVICE, oauthRequestFetch } from '../lib/index.mjs'
import { feishuConnectionState, readFeishuConnection } from '../lib/feishu-status.mjs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const statusSource = readFileSync(new URL('../src/status.ts', import.meta.url), 'utf8')
const runtime = readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8')

test('Feishu readiness requires verified structured user authority and never merely configured credentials', () => {
  assert.equal(feishuConnectionState({ identities: { user: { available: true, verified: true, status: 'needs_refresh' } } }), 'connected')
  assert.equal(feishuConnectionState({ ok: true, data: { identity: 'user', verified: true, identities: { user: { available: true } } } }), 'connected')
  assert.equal(feishuConnectionState({ identities: { user: { available: true, verified: false } } }), 'failed')
  assert.equal(feishuConnectionState({ identities: { user: { available: false, tokenStatus: 'revoked' } } }), 'expired')
  assert.equal(feishuConnectionState({ status: 'not_configured' }), 'not-connected')
  assert.equal(feishuConnectionState({ ok: false, data: { identities: { user: { available: true, verified: true } } } }), 'failed')
})

test('Feishu status uses the pinned native offline runner and never starts setup or returns credential fields', async () => {
  let args
  const runner = { run(value) {
    args = value
    return {
      stdout: (async function* () { yield JSON.stringify({ identities: { user: { available: true, verified: true, userName: 'private-name', openId: 'private-id' } } }) })(),
      stderr: (async function* () {})(),
      done: Promise.resolve({ exitCode: 0 }), cancel() {},
    }
  } }
  assert.deepEqual(await readFeishuConnection(runner, undefined, new URL('../src/', import.meta.url)), { state: 'connected' })
  assert.deepEqual(args, ['--config.offline=true', 'dlx', '@larksuite/cli@1.0.88', 'auth', 'status', '--json', '--verify'])
})

test('MCP management keeps native DSH ownership and secrets out of settings', () => {
  assert.equal(manifest.version, '2.0.18')
  assert.equal(manifest.eMate.runtime, '@deepseek-ai/dsh-mcp-client')
  assert.equal(manifest.eMate.mcpSdkVersion, '1.29.0')
  assert.match(source, /ctx\.loader\.(?:create|update)/u)
  assert.match(source, /name: MCP_CLIENT/u)
  assert.match(source, /ctx\.credentials\.set/u)
  assert.match(source, /ctx\.userQuestions\.ask/u)
  assert.match(source, /ctx\.userQuestions\.ask\(\{\s*agent,/u)
  assert.match(source, /exec\.signal, exec\.agent/u)
  assert.match(source, /isMcpServerActive\(ctx\.loader, ctx\.tools/u)
  assert.match(statusSource, /tools\.schemas\(\)/u)
  assert.match(source, /servers: previousServers/u)
  assert.match(source, /authority: 'loopback'/u)
  assert.match(source, /authorizeMcp/u)
  assert.match(source, /OAUTH_CALLBACK_PORT/u)
  assert.match(source, /codeVerifier/u)
  assert.match(source, /ctx\.subprocess\.spawn/u)
  assert.match(source, /ctx\.interval/u)
  assert.match(source, /enum: \['list', 'install', 'connect', 'ensure', 'remove'\]/u)
  assert.match(source, /name: 'dsh_plugin_manage'/u)
  assert.match(source, /AUDITED_PLUGIN_SOURCES\.get\(packageName\)/u)
  assert.match(source, /MCP_CATALOG\.get\(args\.name\)/u)
  assert.match(source, /current\(\)\.servers\.filter\(supportedServer\)/u)
  assert.match(source, /if \(!supportedServer\(existing\)\) throw new Error\(UNSUPPORTED_MCP\)/u)
  assert.match(source, /该 MCP 不在 2\.0\.18 受审计 HTTPS catalog 中/u)
  assert.doesNotMatch(source, /transport: 'stdio', serverName/u)
  assert.doesNotMatch(source, /transport: \{ type: 'string'/u)
  assert.doesNotMatch(source, /command: \{ type: 'string'/u)
  assert.doesNotMatch(source, /args: \{ type: 'array'/u)
  assert.doesNotMatch(source, /url: \{ type: 'string'/u)
  assert.match(source, /spec\.name === 'tencent_docs' \? token : `Bearer \$\{token\}`/u)
  assert.match(source, /Get-Clipboard -Raw/u)
  assert.match(source, /process\.platform === 'darwin' \? 'pbpaste'/u)
  assert.match(source, /Token 只会从系统剪贴板写入本机凭据库/u)
  assert.match(source, /handle\.collected\.stdout/u)
  assert.match(source, /handle\.terminate\(\)/u)
  assert.doesNotMatch(source, /readBounded\(handle\.stdout\)/u)
  assert.doesNotMatch(source, /handle\.cancel\(\)/u)
  assert.match(source, /runPluginInstall\(args, process\.cwd\(\), recovery, signal\)/u)
  assert.match(source, /rollbackPluginInstall\(receiptId\)/u)
  assert.doesNotMatch(source, /if \(previous === undefined\) await runProfilePlugin/u)
  assert.doesNotMatch(source, /source: \{ type: 'string' \}/u)
  assert.doesNotMatch(source, /status: 'installed', packageName, source/u)
  assert.doesNotMatch(runtime, /^import .* from ["']@modelcontextprotocol\/sdk(?:\/[^"']*)?["'];?$/mu)
  assert.match(source, /runtime\.requestRestart/u)
  assert.match(source, /item\?\.active !== true/u)
  assert.doesNotMatch(source, /token:\s*z\./u)
  assert.doesNotMatch(source, /authorizationCode: \{ type:/u)
})

test('status is active only for a live native fiber with a registered server Tool', () => {
  const tools = { schemas: () => [{ name: 'mcp__docs__read' }] }
  assert.equal(isMcpServerActive({ resolve: () => ({ fiber: { state: 2 } }) }, tools, 'entry', 'docs'), true)
  assert.equal(isMcpServerActive({ resolve: () => ({ fiber: { state: 1 } }) }, tools, 'entry', 'docs'), false)
  assert.equal(isMcpServerActive({ resolve: () => ({ fiber: { state: 2 } }) }, { schemas: () => [] }, 'entry', 'docs'), false)
  assert.equal(isMcpServerActive({ resolve: () => { throw new Error('entry disappeared') } }, tools, 'entry', 'docs'), false)
  assert.equal(isMcpServerActive({ resolve: () => ({ fiber: { state: 2 } }) }, tools, undefined, 'docs'), false)
})

test('collected subprocess output rejects missing or truncated clipboard data', () => {
  assert.equal(readCollectedOutput({ readFrom: offset => ({ text: offset === 0 ? 'token' : '', lossy: false }) }, 'stdout'), 'token')
  assert.throws(() => readCollectedOutput(undefined, 'stdout'), /未启用收集输出/u)
  assert.throws(
    () => readCollectedOutput({ readFrom: () => ({ text: 'tail', lossy: true }) }, 'stdout'),
    /超过安全上限/u,
  )
})

test('optional DSH plugins require a valid package name and exact GitHub commit', () => {
  assert.doesNotThrow(() => validatePluginInstall(
    '@xmanrui/dsh-im',
    'github:zyfjacksonchen-source/dsh-im#f984f73dcd67692141d4e475c8fbe887e2ce7062',
  ))
  assert.doesNotThrow(() => validatePluginPackageName('dsh-example'))
  assert.throws(() => validatePluginInstall('@xmanrui/dsh-im', 'github:zyfjacksonchen-source/dsh-im#main'), /固定 GitHub 提交/u)
  assert.throws(() => validatePluginInstall('@xmanrui/dsh-im', 'https://user:secret@example.com/plugin.git'), /固定 GitHub 提交/u)
  assert.throws(() => validatePluginPackageName('../plugin'), /包名无效/u)
})

test('OAuth callback accepts one matching state and rejects callback smuggling', () => {
  assert.deepEqual(
    parseOAuthCallback('/oauth/callback/tencent-docs?code=ok&state=nonce', '/oauth/callback/tencent-docs', 'nonce'),
    { code: 'ok' },
  )
  assert.deepEqual(
    parseOAuthCallback('/oauth/callback/tencent-docs?error=access_denied&state=nonce', '/oauth/callback/tencent-docs', 'nonce'),
    { error: 'access_denied' },
  )
  assert.throws(() => parseOAuthCallback(
    '/oauth/callback/tencent-docs?code=a&code=b&state=nonce', '/oauth/callback/tencent-docs', 'nonce',
  ), /Invalid OAuth callback/u)
  assert.throws(() => parseOAuthCallback(
    '/oauth/callback/tencent-docs?code=a&state=wrong', '/oauth/callback/tencent-docs', 'nonce',
  ), /Invalid OAuth callback/u)
  assert.throws(() => parseOAuthCallback(
    '/oauth/callback/feishu?code=a&state=nonce', '/oauth/callback/tencent-docs', 'nonce',
  ), /Invalid OAuth callback/u)
})

function xinHarness() {
  let principal = { tenantId: 'tenant-a', userId: 'user-a' }
  const credentials = new Map()
  const seenRefs = []
  const entries = new Map()
  const calls = []
  const guards = []
  const posts = []
  const preSteps = []
  let configured = false
  let nextCall = 0
  let authorizeCount = 0
  let confirmCount = 0
  let tokenGate
  let authorityGate
  let authorizeGate
  let authority = { tenant_id: 'xin-tenant', user_id: 1, principal_id: 2, scope_revision: 'scope-1', tools: ['query_projects'], project_ids: [1], knowledge_project_ids: [1,2], writable_project_ids: [], project_scope_revisions: { '1': 'r1' } }
  const ctx = {
    get: () => ({ localAccountPrincipal: () => principal }),
    credentials: {
      async resolve(ref) { seenRefs.push(ref); return credentials.has(ref) ? { value: credentials.get(ref) } : undefined },
      async describe(ref) { return { configured: credentials.has(ref), writable: true } },
      async set(ref, value) { credentials.set(ref, value) },
      async unset(ref) { credentials.delete(ref) },
    },
    loader: {
      async create(value) { calls.push(['create', value.id]); entries.set(value.id, { ...value, fiber: { state: 2 } }); return value.id },
      async remove(id) { calls.push(['remove', id]); entries.delete(id) },
      resolve: id => entries.get(id) ?? {},
    },
    on(name, fn) { const list = name === 'tools/post-execute' ? posts : name === 'agent/pre-step' ? preSteps : []; list.push(fn); return () => { const index = list.indexOf(fn); if (index >= 0) list.splice(index, 1) } },
    tools: {
      schemas: () => entries.size ? [{ name: `mcp__${XIN_SERVICE}__get_capabilities` }, { name: `mcp__${XIN_SERVICE}__query_projects` }] : [],
      guard(fn) { guards.push(fn); return () => { const index = guards.indexOf(fn); if (index >= 0) guards.splice(index, 1) } },
      async execute(input) {
        calls.push(['execute', input.name])
        const denial = guards.map(fn => fn(input)).find(Boolean)
        if (denial) return { isError: true, error: { message: denial }, content: [] }
        await authorityGate?.()
        let value = { isError: false, value: { structuredContent: authority }, content: [] }
        for (const post of posts) {
          const decision = await post(input, value, async () => ({ kind: 'accept' }))
          if (decision.kind === 'block') value = { isError: true, error: { message: 'identity changed' }, content: decision.feedback }
        }
        return value
      },
    },
  }
  const owner = createXinConnection(ctx, {
    async token(lease) { await tokenGate?.(); lease.assertCurrent(); return credentials.has(lease.ref) ? JSON.parse(credentials.get(lease.ref)).tokens?.access_token ?? '' : '' },
    async authorize(lease) { authorizeCount++; await authorizeGate?.(); lease.assertCurrent(); await ctx.credentials.set(lease.ref, JSON.stringify({ schema_version: 1, tokens: { access_token: 'synthetic-access-token' } })); lease.assertCurrent() },
    async confirm() { confirmCount++; return true },
    configured: () => configured,
    async install() { configured = true },
  })
  return { owner, ctx, entries, credentials, seenRefs, calls, guards, posts,
    principal: value => { principal = value },
    execution(agent, turn = 1, callId = `call-${++nextCall}`) {
      agent.session ??= { events: [] }
      for (const pre of preSteps) pre({ agent, turn }, async () => ({ kind: 'accept' }))
      agent.session.events.push({ type: 'tool/call', data: { turn, callId } })
      return { agent, callId, rootCallId: callId, signal: new AbortController().signal }
    },
    tokenGate: fn => { tokenGate = fn },
    authorityGate: fn => { authorityGate = fn },
    authorizeGate: fn => { authorizeGate = fn },
    authority: value => { authority = value },
    counts: () => ({ authorizeCount, confirmCount }),
  }
}

test('Xin ensure shares one authorization between UI and Agent and reuses a verified native connection', async t => {
  const h = xinHarness(); t.after(() => h.owner.dispose())
  const agent = {}
  const [ui, agentResult] = await Promise.all([h.owner.ensure(), h.owner.ensure(h.execution(agent))])
  assert.equal(ui.state, 'ready'); assert.deepEqual(ui, agentResult)
  assert.deepEqual(ui.binding, { tenant_id: 'xin-tenant', user_id: 1, principal_id: 2 })
  assert.deepEqual(ui.permissions, { tools: ['query_projects'], project_count: 1, knowledge_project_count: 2, writable_project_count: 0, scope_revision: 'scope-1' })
  assert(Number.isFinite(Date.parse(ui.verified_at)))
  assert.deepEqual(h.counts(), { authorizeCount: 1, confirmCount: 1 })
  assert.equal(h.entries.size, 1)
  assert.equal(h.calls.filter(([kind]) => kind === 'create').length, 1)
  assert.equal((await h.owner.ensure(h.execution(agent))).state, 'ready')
  assert.deepEqual(h.counts(), { authorizeCount: 1, confirmCount: 1 })
  assert.equal(h.calls.filter(([kind]) => kind === 'create').length, 1)
  assert.equal((await h.ctx.tools.execute({ name: `mcp__${XIN_SERVICE}__query_projects`, ...h.execution(agent, 1, 'business-read') })).isError, false)
  assert.doesNotMatch(JSON.stringify(ui), /synthetic-access-token|tokens|Authorization|https:/)
})

test('Xin owner tuple separates tenant, user and delimiter collisions; old global credentials are never inherited', async t => {
  const h = xinHarness(); t.after(() => h.owner.dispose())
  h.credentials.set('EMATE_MCP_XIN_BUSINESS_ASSISTANT_OAUTH', 'legacy-secret-must-not-be-read')
  const scopes = [{ tenantId: 'tenant:a', userId: 'b' }, { tenantId: 'tenant', userId: 'a:b' }, { tenantId: 'tenant:a', userId: 'other' }]
  for (const principal of scopes) { h.principal(principal); h.owner.changed(); assert.equal((await h.owner.ensure()).state, 'ready') }
  const scoped = [...h.credentials.keys()].filter(key => key.startsWith('EMATE_MCP_XIN_') && !key.includes('BUSINESS_ASSISTANT'))
  assert.equal(scoped.length, 3); assert.equal(new Set(scoped).size, 3)
  assert(!h.seenRefs.includes('EMATE_MCP_XIN_BUSINESS_ASSISTANT_OAUTH'))
  await h.owner.disconnect(); assert.equal(h.credentials.size, 3)
  h.principal(scopes[0]); h.owner.changed(); assert.equal((await h.owner.ensure()).state, 'ready')
  assert.deepEqual(h.counts(), { authorizeCount: 3, confirmCount: 3 })
})

test('expired or missing enterprise identity cannot use retained Xin tools or credentials', async t => {
  const h = xinHarness(); t.after(() => h.owner.dispose())
  const agent = {}; await h.owner.ensure(h.execution(agent))
  h.principal(undefined); h.owner.changed()
  assert.equal((await h.owner.status()).state, 'authorization-required')
  assert.equal((await h.owner.ensure(h.execution(agent))).state, 'authorization-required')
  assert.equal((await h.ctx.tools.execute({ name: `mcp__${XIN_SERVICE}__query_projects`, ...h.execution(agent, 1, 'after-logout') })).isError, true)
  await h.owner.disconnect(); assert.equal(h.credentials.size, 1)
})

test('an old Agent and late native result cannot cross into the next account', async t => {
  const h = xinHarness(); t.after(() => h.owner.dispose())
  const agent = {}; await h.owner.ensure(h.execution(agent))
  h.authorityGate(async () => { h.principal({ tenantId: 'tenant-a', userId: 'user-b' }); h.owner.changed() })
  const late = await h.ctx.tools.execute({ name: `mcp__${XIN_SERVICE}__query_projects`, ...h.execution(agent, 1, 'late-result') })
  assert.equal(late.isError, true)
  h.authorityGate(undefined)
  assert.equal((await h.owner.ensure(h.execution(agent))).state, 'unavailable')
  assert.equal((await h.owner.ensure(h.execution({}))).state, 'ready')
  assert.equal((await h.ctx.tools.execute({ name: `mcp__${XIN_SERVICE}__query_projects`, ...h.execution(agent, 1, 'old-agent') })).isError, true)
})

test('late refresh/authorization after account change is cancelled before native activation', async t => {
  const h = xinHarness(); t.after(() => h.owner.dispose())
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let finish
  h.tokenGate(() => { entered(); return new Promise(resolve => { finish = resolve }) })
  const pending = h.owner.ensure()
  await started
  h.principal({ tenantId: 'tenant-b', userId: 'user-a' }); h.owner.changed(); finish()
  assert.equal((await pending).state, 'cancelled')
  assert.equal(h.entries.size, 0); assert.equal(h.credentials.size, 0)
})

test('failed native readiness recreates the same scoped entry and malformed authority never reports ready', async t => {
  const h = xinHarness(); t.after(() => h.owner.dispose())
  await h.owner.ensure()
  const entry = [...h.entries.values()][0]; entry.fiber.state = 3
  assert.equal((await h.owner.ensure()).state, 'ready')
  assert.equal(h.calls.filter(([kind]) => kind === 'create').length, 2)
  h.authority({ status: 'ok', token: 'not-an-authority' })
  assert.equal((await h.owner.ensure()).state, 'unavailable')
  assert.equal(h.entries.size, 0)
})

test('Xin protocol accepts only verified capability principals and never a caller-supplied owner', () => {
  assert.equal(validXinPrincipal({ tenantId: 'a', userId: 'b' }), true)
  assert.equal(validXinPrincipal({ tenantId: '', userId: 'b' }), false)
  assert.equal(verifiedXinCapabilities({ structuredContent: { tenant_id: 'a', user_id: 1, principal_id: 0, scope_revision: 'r', tools: [], project_ids: [], knowledge_project_ids: [], writable_project_ids: [], project_scope_revisions: {} } }), true)
  assert.equal(verifiedXinCapabilities({ content: [{ type: 'text', text: JSON.stringify({ tenant_id: 'a', user_id: 1, principal_id: 2, scope_revision: 'r', tools: [], project_ids: [], knowledge_project_ids: [], writable_project_ids: [], project_scope_revisions: {} }) }] }), true)
  assert.equal(verifiedXinCapabilities({ content: [{ type: 'text', text: 'connected' }] }), false)
  assert.match(source, /endpoint === 'xin.ensure'.*xin.ensure\(\{ signal \}\)/)
  assert.match(source, /localAccountPrincipal/)
  assert.match(source, /tools\/post-execute/)
})


test('same-account session refresh keeps its connection; caller cancellation does not leave a partial authorization', async t => {
  const h = xinHarness(); t.after(() => h.owner.dispose())
  h.credentials.set('EMATE_MCP_TENCENT_DOCS_TOKEN', 'synthetic-other-service')
  await h.owner.ensure()
  h.owner.changed()
  assert.equal((await h.owner.status()).state, 'ready')
  assert.equal(h.calls.filter(([kind]) => kind === 'create').length, 1)
  let entered; const started = new Promise(resolve => { entered = resolve })
  let finish
  h.authorizeGate(() => { entered(); return new Promise(resolve => { finish = resolve }) })
  const before = new Map(h.credentials)
  const controller = new AbortController()
  const pending = h.owner.ensure({ signal: controller.signal }, { reauthorize: true })
  await started; controller.abort(); finish()
  assert.equal((await pending).state, 'cancelled')
  assert.deepEqual(h.credentials, before)
  assert.equal(h.entries.size, 0)
  h.authorizeGate(undefined)
  assert.equal((await h.owner.ensure()).state, 'ready')
  assert.equal(h.credentials.get('EMATE_MCP_TENCENT_DOCS_TOKEN'), 'synthetic-other-service')
})

test('noninteractive restore never opens OAuth and invalid ready proofs roll back only the captured credential', async t => {
  const h = xinHarness(); t.after(() => h.owner.dispose())
  assert.equal((await h.owner.ensure({}, { interactive: false })).state, 'authorization-required')
  assert.deepEqual(h.counts(), { authorizeCount: 0, confirmCount: 0 })
  h.authority({ tenant_id: 'xin', user_id: -1, principal_id: 2, scope_revision: 'r', tools: [], project_ids: [], knowledge_project_ids: [], writable_project_ids: [], project_scope_revisions: {} })
  const failed = await h.owner.ensure()
  assert.equal(failed.state, 'unavailable'); assert.equal(h.credentials.size, 0); assert.equal(h.entries.size, 0)
  assert(!JSON.stringify(failed).includes('synthetic-access-token'))
})


test('an explicit ensure arriving during background restore can continue into one OAuth authorization', async t => {
  const h = xinHarness(); t.after(() => h.owner.dispose())
  let entered; const started = new Promise(resolve => { entered = resolve })
  let finish
  h.tokenGate(() => { entered(); return new Promise(resolve => { finish = resolve }) })
  const background = h.owner.ensure({}, { interactive: false })
  await started
  const clicked = h.owner.ensure()
  h.tokenGate(undefined); finish()
  assert.equal((await background).state, 'authorization-required')
  assert.equal((await clicked).state, 'ready')
  assert.deepEqual(h.counts(), { authorizeCount: 1, confirmCount: 1 })
})


test('SDK invalid_grant invalidation cannot reuse stale access; committed token rotation can be recovered from native readback', () => {
  assert.equal(hasUnexpiredOAuthAccess({ tokens: { access_token: 'synthetic-old' }, expires_at: 2000 }, 1000), true)
  assert.equal(hasUnexpiredOAuthAccess({ tokens: undefined, expires_at: undefined }, 1000), false)
  assert.equal(hasUnexpiredOAuthAccess({ tokens: { access_token: 'synthetic-new' }, expires_at: 4000 }, 1000), true)
  assert.equal(hasUnexpiredOAuthAccess({ tokens: { access_token: 'synthetic-expired' }, expires_at: 999 }, 1000), false)
  assert.match(source, /const latest = await readOAuthState\(ctx, spec.name, lease\)/)
  assert.match(source, /fetchFn: oauthRequestFetch\(signal, lease\)/)
})

test('OAuth cancellation and failure classes keep only transient network fallback and never invalid grants', async () => {
  assert.equal(oauthFailureKind({ errorCode: 'invalid_grant' }), 'reauthorize')
  assert.equal(oauthFailureKind({ errorCode: 'invalid_token' }), 'reauthorize')
  assert.equal(oauthFailureKind(new Error('SDK redirected after invalidation'), { invalidated: true }), 'reauthorize')
  assert.equal(oauthFailureKind(new TypeError('fetch failed')), 'transient')
  assert.equal(oauthFailureKind({ errorCode: 'server_error' }), 'transient')
  assert.equal(oauthFailureKind(new Error('not a network error')), 'failed')
  assert.equal(oauthFailureKind(new Error(), { aborted: true, transient: true }), 'cancelled')
  const controller = new AbortController()
  let signal
  const fetcher = oauthRequestFetch(controller.signal, undefined, async (_input, init) => {
    signal = init.signal
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  const pending = fetcher('https://fixture.invalid/token')
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(signal.aborted, true)
})

test('capability summary requires the actual project permission shape and never invents a display name', () => {
  const principal = { tenant_id: 'xin', user_id: 4, principal_id: 5, project_ids: [3], knowledge_project_ids: [3,8], writable_project_ids: [], project_scope_revisions: { '3': 'rev' }, tools: ['search_knowledge'], scope_revision: 'live-revision' }
  const proof = parseXinCapabilities({ structuredContent: principal })
  assert.equal(proof.permissions.knowledge_project_count, 2)
  assert.equal(proof.permissions.writable_project_count, 0)
  assert(!('display_name' in proof.binding))
  assert.equal(parseXinCapabilities({ structuredContent: { ...principal, project_ids: [3,3] } }), undefined)
  assert.equal(parseXinCapabilities({ structuredContent: { ...principal, access_token: 'synthetic-secret' } }), undefined)
})

async function nativeXinHarness(t) {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-tools'))
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
  const { default: SystemPrompt } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')).href)
  const { createScope } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-scope')).href)
  const { default: ToolRuntime, defineTool } = await import('@deepseek-ai/dsh-tools')
  const runtime = new Context()
  await runtime.plugin(SystemPrompt); await runtime.plugin(ToolRuntime)
  const h = xinHarness()
  await h.owner.dispose() // Keep only the native runtime coordinator below.
  const nativeEntries = new Map()
  const writes = []
  const capability = { tenant_id: 'xin', user_id: 1, principal_id: 2, project_ids: [], knowledge_project_ids: [], writable_project_ids: [], project_scope_revisions: {}, tools: ['mutate_project'], scope_revision: 'r' }
  const context = {
    ...h.ctx,
    tools: runtime.tools,
    on: runtime.on.bind(runtime),
    loader: {
      resolve: id => nativeEntries.has(id) ? { fiber: { state: 2 } } : {},
      async create(value) {
        const current = h.ctx.get().localAccountPrincipal()
        const registrations = [
          runtime.tools.register(defineTool({ name: `mcp__${XIN_SERVICE}__get_capabilities`, description: 'read capability', parameters: {}, output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, execute: async () => ({ content: [], structuredContent: capability }) })),
          runtime.tools.register(defineTool({ name: `mcp__${XIN_SERVICE}__mutate_project`, description: 'synthetic write', parameters: {}, output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, execute: async () => { writes.push(current.userId); return { status: 'changed' } } })),
        ]
        nativeEntries.set(value.id, registrations)
        return value.id
      },
      async remove(id) { for (const stop of nativeEntries.get(id) ?? []) stop(); nativeEntries.delete(id) },
    },
  }
  const owner = createXinConnection(context, {
    async token() { return 'synthetic-native-token' }, async authorize() {}, async confirm() { return true }, configured: () => true, async install() {},
  })
  t.after(async () => { await owner.dispose(); await runtime.fiber.dispose() })
  return { ...h, owner, runtime, writes, async agent(id) {
    const agent = { id, session: { events: [] } }
    let scope
    await runtime.plugin(Object.assign(inner => { scope = createScope(inner, agent) }, { inject: ['tools','systemPrompt'] }))
    await runtime.waterfall(agent, 'agent/pre-step', { agent, turn: 1, step: 1, messages: [], signal: new AbortController().signal }, async () => ({ kind: 'accept' }))
    const callId = `ensure-${id}`
    agent.session.events.push({ type: 'tool/call', data: { turn: 1, callId } }, { type: 'tool/call', data: { turn: 1, callId: 'old-write' } }, { type: 'tool/call', data: { turn: 1, callId: 'restricted-write' } })
    return { agent, scope, exec: { agent, callId, rootCallId: callId } }
  } }
}

test('native around dispatch cancels an already guarded old-account write before resolving the next account tool', async t => {
  const h = await nativeXinHarness(t)
  const old = await h.agent('a'); await h.owner.ensure(old.exec)
  let entered; const started = new Promise(resolve => { entered = resolve })
  let finish
  const waiting = new Promise(resolve => { finish = resolve })
  h.runtime.on('tools/execute', async (exec, next) => {
    if (exec.callId === 'old-write') { entered(); await waiting }
    return next()
  })
  const pending = h.runtime.tools.execute({ callId: 'old-write', name: `mcp__${XIN_SERVICE}__mutate_project`, arguments: {}, agent: old.agent, signal: new AbortController().signal })
  await started
  h.principal({ tenantId: 'tenant-b', userId: 'user-b' }); h.owner.changed()
  const fresh = await h.agent('b'); assert.equal((await h.owner.ensure(fresh.exec)).state, 'ready')
  finish()
  assert.equal((await pending).isError, true)
  assert.deepEqual(h.writes, [])
})

test('native Host capabilities proof works before Tool Search disclosure without widening Agent restrictions', async t => {
  const h = await nativeXinHarness(t)
  const { agent, scope, exec } = await h.agent('restricted')
  scope.ctx.tools.restrict({ allow: [] })
  assert.equal((await h.owner.ensure(exec)).state, 'ready')
  const denied = await h.runtime.tools.execute({ callId: 'restricted-write', name: `mcp__${XIN_SERVICE}__mutate_project`, arguments: {}, agent, signal: new AbortController().signal })
  assert.equal(denied.isError, true)
  assert.deepEqual(h.writes, [])
})


test('cancelled reauthorization never restores tokens cleared by invalid_grant during refresh', async t => {
  const h = xinHarness(); t.after(() => h.owner.dispose())
  await h.owner.ensure()
  const ref = [...h.credentials.keys()][0]
  h.tokenGate(async () => { h.credentials.set(ref, JSON.stringify({ schema_version: 1, client: { client_id: 'synthetic' } })); h.tokenGate(undefined) })
  let entered; const started = new Promise(resolve => { entered = resolve })
  let finish
  h.authorizeGate(() => { entered(); return new Promise(resolve => { finish = resolve }) })
  const controller = new AbortController()
  const pending = h.owner.ensure({ signal: controller.signal })
  await started; controller.abort(); finish()
  assert.equal((await pending).state, 'cancelled')
  assert.equal(JSON.parse(h.credentials.get(ref)).tokens, undefined)
  assert.equal(h.entries.size, 0)
})

test('pinned SDK refresh retains or rotates refresh token and concurrent ensure commits one complete credential value', async t => {
  const { refreshAuthorization } = await import('@modelcontextprotocol/sdk/client/auth.js')
  let requests = 0
  const refresh = (rotate) => refreshAuthorization(new URL('https://fixture.invalid'), {
    metadata: { token_endpoint: 'https://fixture.invalid/token' },
    clientInformation: { client_id: 'synthetic-client' },
    refreshToken: 'synthetic-old-refresh',
    fetchFn: async () => { requests++; return Response.json({ access_token: 'synthetic-new-access', token_type: 'Bearer', expires_in: 3600, ...(rotate ? { refresh_token: 'synthetic-new-refresh' } : {}) }) },
  })
  assert.equal((await refresh(false)).refresh_token, 'synthetic-old-refresh')
  const h = xinHarness(); t.after(() => h.owner.dispose())
  await h.owner.ensure()
  const ref = [...h.credentials.keys()][0]
  const before = requests
  h.tokenGate(async () => { const tokens = await refresh(true); await h.ctx.credentials.set(ref, JSON.stringify({ schema_version: 1, client: { client_id: 'synthetic-client' }, tokens, expires_at: Date.now() + 3600000 })) })
  const results = await Promise.all([h.owner.ensure(), h.owner.ensure(h.execution({}))])
  assert(results.every(result => result.state === 'ready'))
  assert.equal(requests - before, 1)
  const stored = JSON.parse(h.credentials.get(ref))
  assert.equal(stored.tokens.refresh_token, 'synthetic-new-refresh')
  assert.equal(stored.tokens.access_token, 'synthetic-new-access')
  assert.equal(stored.client.client_id, 'synthetic-client')
  assert(!JSON.stringify(results).includes('synthetic-new-access'))
})


test('an old turn never first-binds to the next account; a new native turn can reuse the same task', async t => {
  const h = xinHarness(); t.after(() => h.owner.dispose())
  const agent = {}
  const oldCall = h.execution(agent, 1)
  h.principal({ tenantId: 'tenant-b', userId: 'user-b' }); h.owner.changed()
  const denied = await h.owner.ensure(oldCall)
  assert.equal(denied.state, 'unavailable'); assert.equal(denied.binding, undefined)
  assert.deepEqual(h.counts(), { authorizeCount: 0, confirmCount: 0 })
  assert.equal((await h.owner.ensure(h.execution(agent, 2))).state, 'ready')
  assert.equal((await h.owner.ensure(oldCall)).state, 'unavailable')
  assert.equal((await h.owner.status(oldCall)).binding, undefined)
})

test('UI ensure followers cannot restart authorization under another account after delayed old cleanup', async t => {
  const h = xinHarness(); t.after(() => h.owner.dispose())
  await h.owner.ensure(); h.credentials.clear()
  let entered; const started = new Promise(resolve => { entered = resolve })
  let finish; const waiting = new Promise(resolve => { finish = resolve })
  const remove = h.ctx.loader.remove
  h.ctx.loader.remove = async id => { entered(); await waiting; await remove(id) }
  const background = h.owner.ensure({}, { interactive: false })
  await started
  const ui = h.owner.ensure()
  const reconnect = h.owner.ensure({}, { reauthorize: true })
  h.principal({ tenantId: 'tenant-b', userId: 'user-b' }); h.owner.changed(); finish()
  for (const value of await Promise.all([background, ui, reconnect])) { assert.equal(value.state, 'cancelled'); assert.equal(value.binding, undefined) }
  assert.deepEqual(h.counts(), { authorizeCount: 1, confirmCount: 1 })
  assert.equal(h.calls.filter(([kind]) => kind === 'create').length, 1)
})


test('a late old-turn disconnect cannot delete the new account credential or expose its binding', async t => {
  const h = xinHarness(); t.after(() => h.owner.dispose())
  const agent = {}; const old = h.execution(agent, 1)
  await h.owner.ensure(old)
  h.principal({ tenantId: 'tenant-b', userId: 'user-b' }); h.owner.changed()
  await h.owner.ensure()
  const before = new Map(h.credentials)
  const refused = await h.owner.disconnect(old)
  assert.equal(refused.state, 'unavailable'); assert.equal(refused.binding, undefined)
  assert.deepEqual(h.credentials, before)
  assert.equal((await h.owner.status()).state, 'ready')
})


test('a failed native activation that rolled back its entry cannot strand subsequent ensure cleanup', async t => {
  const h = xinHarness(); t.after(() => h.owner.dispose())
  const create = h.ctx.loader.create
  let fail = true
  h.ctx.loader.create = async value => { if (fail) { fail = false; throw new Error('synthetic initial transport failure') } return create(value) }
  h.ctx.loader.resolve = id => { if (!h.entries.has(id)) throw new Error('entry not found'); return h.entries.get(id) }
  assert.equal((await h.owner.ensure()).state, 'unavailable')
  assert.equal(h.entries.size, 0)
  assert.equal((await h.owner.ensure()).state, 'ready')
  assert.equal(h.entries.size, 1)
})


test('stored OAuth client metadata without tokens remains authorization-required after invalidation', async t => {
  const h = xinHarness(); t.after(() => h.owner.dispose())
  await h.owner.ensure({}, { interactive: false })
  const ref = h.seenRefs[0]
  h.credentials.set(ref, JSON.stringify({ schema_version: 1, client: { client_id: 'synthetic-client' } }))
  assert.equal((await h.owner.status()).state, 'authorization-required')
  h.credentials.set(ref, JSON.stringify({ schema_version: 1, tokens: { access_token: 'synthetic-expired' }, expires_at: 1 }))
  assert.equal((await h.owner.status()).state, 'authorization-required')
})
