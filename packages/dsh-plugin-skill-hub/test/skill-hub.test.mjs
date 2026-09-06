import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { apply, nativeCandidate } from '../lib/index.js'
import {
  compareSkillVersions,
  createSkillHubClient,
  createSkillHubStore,
  inspectSkillArchive,
  parseSkillHubRpcResult,
  skillHubFailure,
  skillHubSuccess,
  SkillHubRecoveryPendingError,
} from '../lib/skill-hub.js'

const roots = []
test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryHome() {
  const root = mkdtempSync(join(tmpdir(), 'emate-skill-hub-'))
  roots.push(root)
  return root
}

function skillArchive(slug, version, invocation = '', description = `${slug} behavior test`) {
  const markdown = `---\nname: ${slug}\ndescription: ${description}\nversion: ${version}\n${invocation}---\n\nRun ${slug} ${version}.\n`
  const payload = Buffer.from(zipSync({ 'SKILL.md': strToU8(markdown) }, { level: 6 }))
  const inspected = inspectSkillArchive(payload)
  return {
    payload,
    card: {
      slug,
      version,
      package_sha256: inspected.packageSha256,
    },
  }
}

function nativeContext() {
  return { get: () => undefined, logger: { warn() {} } }
}

function lifecycleStore(dshHome) {
  const ctx = nativeContext()
  return createSkillHubStore({
    dshHome,
    validateCandidate: (root, slug, signal) => nativeCandidate(ctx, root, slug, signal),
    validateActive: (path, slug, signal) => nativeCandidate(ctx, dirname(path), slug, signal),
    validateAbsent: async (path) => {
      if (existsSync(path)) throw new Error('Skill remains at its active path')
    },
    invalidate() {},
  })
}

function acceptedCompletion() {
  return { state: 'accepted', value: { schema_version: 1, status: 'installed' } }
}

async function install(store, archive, options = {}) {
  return store.install({
    ...archive,
    claim: async () => options.receipt ?? `receipt-${archive.card.version}`,
    complete: options.complete ?? (async () => acceptedCompletion()),
  })
}

test('matches the authoritative e-Mate 2.0.5 normalized Skill CAS digest', () => {
  const markdown = [
    '---',
    'name: cas-vector',
    'description: Canonical 内容',
    'version: 1.2.3',
    'license: MIT',
    'compatibility: ">=0.1.0,<1.0.0"',
    'tags: ["office","shared"]',
    '---',
    '',
    'Use it.',
    '',
  ].join('\n')
  const payload = Buffer.from(zipSync({
    'SKILL.md': strToU8(markdown),
    'guide/说明.md': strToU8('hello\n'),
  }, { level: 6 }))
  const inspected = inspectSkillArchive(payload)
  assert.equal(inspected.packageSha256, 'c268e7ed14e5aa798362b40d25a981d21b7c9d02e457ccc7f36d6da2150b7042')
  assert.equal(inspected.archiveSha256, createHash('sha256').update(payload).digest('hex'))
  assert.notEqual(inspected.packageSha256, inspected.archiveSha256)
})

test('catalog search omits empty optional filters but rejects a non-string cursor', async () => {
  const requests = []
  const hub = createSkillHubClient({
    dshHome: temporaryHome(),
    store: {},
    async request(url) {
      requests.push(url)
      return Response.json({ schema_version: 1, items: [], next_cursor: null })
    },
  })

  assert.deepEqual(await hub.search({
    category: 'office_productivity',
    cursor: '',
    limit: 20,
    query: '',
    tag: '',
  }), { items: [], next_cursor: null })
  assert.equal(requests[0].origin, 'https://mvdcm.ecoremedia.net')
  assert.equal(requests[0].pathname, '/ecorex-agent/client/skill-hub/v1/skills')
  assert.equal(requests[0].searchParams.get('category'), 'office_productivity')
  assert.equal(requests[0].searchParams.get('cursor'), null)
  assert.equal(requests[0].searchParams.get('tag'), null)
  assert.equal(requests[0].searchParams.get('limit'), '20')

  await assert.rejects(hub.search({ cursor: 0 }), /Skill search filters are invalid/u)
})

test('shared result parser rejects the installed bad payload and unknown discriminators while preserving a normal installed list', () => {
  const installed = { schema_version: 1, items: [{ slug: 'installed-skill', status: 'installed', ready: true }] }
  assert.deepEqual(
    parseSkillHubRpcResult({ ok: true, value: skillHubSuccess(installed) }),
    { ok: true, value: installed },
  )

  const installedBadPayload = {
    ok: false,
    error: { code: 'network', message: 'raw upstream failure', details: { issues: [] } },
  }
  const badPayload = parseSkillHubRpcResult(installedBadPayload)
  assert.equal(badPayload.ok, false)
  assert.equal(badPayload.error.code, 'invalid-response')
  assert.doesNotMatch(badPayload.error.message, /raw upstream|invalid_union|Invalid input/u)

  const unknown = parseSkillHubRpcResult({
    ok: true,
    value: { schema_version: 1, status: 'future-result', diagnostic: 'ZodError: invalid_union Invalid input' },
  })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'invalid-response')
  assert.doesNotMatch(unknown.error.message, /ZodError|invalid_union|Invalid input/u)
})

test('keeps operation failures typed across service, transport, integrity, recovery, and native provider boundaries', async () => {
  for (const [status, code] of [[401, 'auth'], [409, 'conflict'], [422, 'integrity']]) {
    const hub = createSkillHubClient({
      dshHome: temporaryHome(),
      store: {},
      request: async () => Response.json({ detail: code, error: { code, message: code } }, { status }),
    })
    await assert.rejects(hub.search(), error => error.code === code)
  }
  const offline = createSkillHubClient({ dshHome: temporaryHome(), store: {}, request: async () => { throw new Error('offline') } })
  await assert.rejects(offline.search(), error => error.code === 'network')
  assert.throws(() => inspectSkillArchive(Buffer.from('bad zip')), error => error.code === 'integrity')
  assert.equal(skillHubFailure(new SkillHubRecoveryPendingError('pending')).code, 'recovery')
})

test('native rc.7 parser is the install commit gate', async () => {
  const dshHome = temporaryHome()
  const store = lifecycleStore(dshHome)
  const invalid = skillArchive('invalid-policy', '1.0.0', '', 'true')
  let claimed = false

  await assert.rejects(store.install({
    ...invalid,
    claim: async () => { claimed = true; return 'must-not-be-issued' },
    complete: async () => acceptedCompletion(),
  }), error => error.code === 'native-provider' && /native DSH parser/u.test(error.message))
  assert.equal(claimed, false)
  assert.equal(existsSync(join(dshHome, 'skills', 'invalid-policy')), false)
  assert.equal(existsSync(join(dshHome, 'e-mate', 'skill-hub', 'transactions', 'invalid-policy')), false)
})

test('one Skill Hub owner closes install, disable, enable, and uninstall through native readback', async () => {
  const dshHome = temporaryHome()
  const store = lifecycleStore(dshHome)
  const archive = skillArchive('meeting-notes', '1.0.0')

  assert.equal((await install(store, archive)).status, 'installed')
  assert.equal((await store.inventory()).at(0).ready, true)
  assert.equal((await store.disable('meeting-notes')).status, 'disabled')
  assert.equal(existsSync(join(dshHome, 'skills', 'meeting-notes')), false)
  assert.equal((await store.inventory()).at(0).ready, false)
  assert.equal((await store.enable('meeting-notes')).status, 'installed')
  assert.equal((await store.uninstall('meeting-notes')).status, 'uninstalled')
  assert.deepEqual(await store.inventory(), [])
  assert.equal(existsSync(join(dshHome, 'skills', 'meeting-notes')), false)
})

test('an installed Skill loads through the real rc.7 model-facing skill Tool', async () => {
  const dshHome = temporaryHome()
  await install(lifecycleStore(dshHome), skillArchive('agent-loadable', '1.0.0'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  ctx.skills.registerProvider(control => new FileSystemSkillProvider(ctx, control, {
    providerName: 'emate-skill-hub-acceptance',
    includeDefaultRoots: false,
    customSkillDirs: [join(dshHome, 'skills')],
    dshHome,
    watch: false,
  }))
  await ctx.plugin(ToolSkill)
  try {
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'skill-hub-load',
      name: 'skill',
      arguments: { name: 'agent-loadable' },
    })
    assert.equal(result.isError, false)
    assert.equal(result.content[0]?.type, 'text')
    assert.match(result.content[0].text, /Run agent-loadable 1\.0\.0\./u)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('same-slug mutations serialize so an earlier failure cannot roll back a later success', async () => {
  const dshHome = temporaryHome()
  const store = lifecycleStore(dshHome)
  await install(store, skillArchive('serial-skill', '1.0.0'))

  let releaseSecond
  let completionStarted
  const completionGate = new Promise(resolve => { releaseSecond = resolve })
  const reachedCompletion = new Promise(resolve => { completionStarted = resolve })
  const claimed = []
  const second = skillArchive('serial-skill', '2.0.0')
  const third = skillArchive('serial-skill', '3.0.0')
  const updateTwo = store.update({
    ...second,
    claim: async () => { claimed.push('2.0.0'); return 'receipt-2' },
    complete: async (_receipt, status) => {
      if (status === 'failed') return acceptedCompletion()
      completionStarted()
      await completionGate
      return { state: 'rejected', error: new Error('server rejected v2') }
    },
  })
  await reachedCompletion
  const updateThree = store.update({
    ...third,
    claim: async () => { claimed.push('3.0.0'); return 'receipt-3' },
    complete: async () => acceptedCompletion(),
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(claimed, ['2.0.0'])
  releaseSecond()
  await assert.rejects(updateTwo, /server rejected v2/)
  assert.equal((await updateThree).version, '3.0.0')
  assert.deepEqual(claimed, ['2.0.0', '3.0.0'])
  assert.match(readFileSync(join(dshHome, 'skills', 'serial-skill', 'SKILL.md'), 'utf8'), /3\.0\.0/)
})

test('install cannot silently become update while exact same-version revalidation stays idempotent', async () => {
  const dshHome = temporaryHome()
  const store = lifecycleStore(dshHome)
  const first = skillArchive('explicit-update', '1.0.0')
  await install(store, first)
  assert.equal((await install(store, first)).unchanged, true)
  let claimed = false
  await assert.rejects(store.install({
    ...skillArchive('explicit-update', '2.0.0'),
    claim: async () => { claimed = true; return 'must-not-claim' },
    complete: async () => acceptedCompletion(),
  }), /explicit update action/)
  assert.equal(claimed, false)
})

test('a prerelease downgrade requires the explicit downgrade choice', async () => {
  const dshHome = temporaryHome()
  const store = lifecycleStore(dshHome)
  await install(store, skillArchive('prerelease-order', '1.0.0-beta'))
  let claimed = false

  await assert.rejects(store.update({
    ...skillArchive('prerelease-order', '1.0.0-alpha'),
    claim: async () => { claimed = true; return 'must-not-claim' },
    complete: async () => acceptedCompletion(),
  }), /explicit downgrade choice/u)
  assert.equal(claimed, false)
})

test('SemVer precedence keeps arbitrary-size numeric and ASCII prerelease identifiers exact', () => {
  assert.equal(compareSkillVersions('9007199254740992.0.0', '9007199254740993.0.0'), -1)
  assert.equal(compareSkillVersions('1.0.0-9007199254740992', '1.0.0-9007199254740993'), -1)
  assert.equal(compareSkillVersions('1.0.0-z', '1.0.0-aa'), 1)
  assert.equal(compareSkillVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(compareSkillVersions('1.0.0-1', '1.0.0-alpha'), -1)
  assert.equal(compareSkillVersions('1.0.0+one', '1.0.0+two'), 0)
})

test('restart repairs crashes after candidate activation, during rollback staging, and after recovery commit', async () => {
  for (const phase of ['claimed', 'switched', 'committed']) {
    const dshHome = temporaryHome()
    const store = lifecycleStore(dshHome)
    const first = skillArchive('switch-crash', '1.0.0')
    const next = skillArchive('switch-crash', '2.0.0')
    await install(store, first)

    const transaction = join(dshHome, 'e-mate', 'skill-hub', 'transactions', 'switch-crash')
    const candidate = join(transaction, 'candidate', 'switch-crash')
    const active = join(dshHome, 'skills', 'switch-crash')
    const backup = join(transaction, 'backup')
    const receiptPath = join(dshHome, 'e-mate', 'migrations', 'skill-switch-crash.json')
    const previousReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    const nextReceipt = { ...previousReceipt, version: '2.0.0', package_sha256: next.card.package_sha256 }
    mkdirSync(candidate, { recursive: true })
    for (const [path, content] of Object.entries(unzipSync(next.payload))) writeFileSync(join(candidate, path), content)
    writeFileSync(join(transaction, 'wal.json'), JSON.stringify({
      schema_version: 1,
      owner_pid: 999_999,
      phase,
      slug: 'switch-crash',
      action: 'update',
      previous_receipt: previousReceipt,
      next_receipt: nextReceipt,
      desired_completion: 'installed',
      completion_receipt: 'completion-after-switch-crash',
    }))
    renameSync(active, backup)
    renameSync(candidate, active)
    if (phase === 'switched') renameSync(active, candidate)
    if (phase === 'committed') writeFileSync(receiptPath, JSON.stringify(nextReceipt))

    assert.deepEqual(await store.recover({ reconcile: async () => 'installed' }), [
      { slug: 'switch-crash', status: 'recovered' },
    ])
    assert.match(readFileSync(join(active, 'SKILL.md'), 'utf8'), /2\.0\.0/u)
    assert.equal(JSON.parse(readFileSync(receiptPath, 'utf8')).version, '2.0.0')
    assert.equal(existsSync(transaction), false)
  }
})

test('lost completion response preserves the old Skill and restart reconciliation commits the candidate', async () => {
  const dshHome = temporaryHome()
  const store = lifecycleStore(dshHome)
  await install(store, skillArchive('recoverable', '1.0.0'))
  const next = skillArchive('recoverable', '2.0.0')

  await assert.rejects(store.update({
    ...next,
    claim: async () => 'receipt-response-lost',
    complete: async () => ({ state: 'unknown', error: new Error('response lost') }),
  }), SkillHubRecoveryPendingError)
  assert.match(readFileSync(join(dshHome, 'skills', 'recoverable', 'SKILL.md'), 'utf8'), /1\.0\.0/)
  assert.equal((await store.inventory()).at(0).recovery_pending, true)

  assert.deepEqual(await store.recover({ reconcile: async () => 'installed' }), [
    { slug: 'recoverable', status: 'recovered' },
  ])
  assert.match(readFileSync(join(dshHome, 'skills', 'recoverable', 'SKILL.md'), 'utf8'), /2\.0\.0/)
  assert.equal((await store.inventory()).at(0).version, '2.0.0')
})

test('restart reconciliation refuses a terminal receipt for another immutable Skill identity', async () => {
  const expected = {
    slug: 'expected-skill',
    version: '2.0.0',
    package_sha256: 'a'.repeat(64),
    uploader: { nickname: 'Expected', author_ref: `author_${'b'.repeat(24)}` },
  }
  const hub = createSkillHubClient({
    dshHome: temporaryHome(),
    store: {
      inventory: async () => [],
      async recover({ reconcile }) {
        return [{ slug: expected.slug, status: await reconcile('completion-receipt', expected) }]
      },
    },
    async request() {
      return Response.json({
        schema_version: 1,
        status: 'installed',
        intent_id: 'intent_wrong',
        slug: 'another-skill',
        version: expected.version,
        package_sha256: expected.package_sha256,
        uploader: expected.uploader,
      })
    },
  })
  assert.deepEqual(await hub.recover(), [{ slug: expected.slug, status: 'unknown' }])
})

test('publication confirmation can bind the exact immutable bytes before upload', async () => {
  const dshHome = temporaryHome()
  const skill = join(dshHome, 'skills', 'share-me')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: share-me\ndescription: share me\nversion: 1.2.3\n---\n\nOriginal.\n')
  const uploads = []
  const store = {
    inventory: async () => [],
    validatePublication: async payload => inspectSkillArchive(payload),
  }
  const hub = createSkillHubClient({
    dshHome,
    store,
    baseUrl: 'https://emate-skill-hub.emate-zyfjacksonchen.workers.dev/ecorex-agent/client/skill-hub/v1',
    async request(url, init) {
      assert.equal(url.pathname, '/ecorex-agent/client/skill-hub/v1/skills')
      const uploaded = JSON.parse(init.body)
      uploads.push(uploaded)
      const payload = Buffer.from(uploaded.bundle_base64, 'base64')
      const sha256 = inspectSkillArchive(payload).packageSha256
      return Response.json({
        slug: 'share-me', version: '1.2.3', package_sha256: sha256,
        title: 'Share me', summary: 'Published behavior test', package_size_bytes: payload.byteLength,
        category: 'third_party', tags: [],
        uploader: { nickname: 'Owner', author_ref: `author_${'b'.repeat(24)}` },
        provenance: { brand: 'e-Mate', original_platform: null, original_url: null },
        installation_status: 'installed_enabled', readiness: 'ready',
      })
    },
  })

  const originalNow = Date.now
  let preview
  let restartedPreview
  try {
    Date.now = () => Date.UTC(2026, 7, 20, 0, 0, 0)
    preview = hub.previewPublication('share-me')
    Date.now = () => Date.UTC(2026, 7, 20, 0, 0, 4)
    restartedPreview = hub.previewPublication('share-me')
  } finally {
    Date.now = originalNow
  }
  assert.equal(restartedPreview.archive_sha256, preview.archive_sha256)
  assert.equal(restartedPreview.package_sha256, preview.package_sha256)
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: share-me\ndescription: changed\nversion: 9.9.9\n---\n\nChanged.\n')
  const receipt = await hub.publishPrepared(preview, 'third_party')
  await hub.publishPrepared(preview, 'third_party')
  assert.equal(receipt.version, '1.2.3')
  assert.equal(uploads[0].slug, 'share-me')
  assert.equal(uploads[0].client_request_id, uploads[1].client_request_id)
  assert.equal(createHash('sha256').update(Buffer.from(uploads[0].bundle_base64, 'base64')).digest('hex'), preview.archive_sha256)
})

test('a lost publish response replays the persisted archive after restart', async () => {
  const dshHome = temporaryHome()
  const skill = join(dshHome, 'skills', 'publish-retry')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: publish-retry\ndescription: publish restart recovery\nversion: 1.0.0\n---\n\nRetry.\n')
  const uploads = []
  const store = {
    inventory: async () => [],
    recover: async () => [],
    validatePublication: async payload => inspectSkillArchive(payload),
  }
  const request = async (_url, init) => {
    const body = JSON.parse(init.body)
    uploads.push(body)
    if (uploads.length === 1) throw new Error('publish response lost after commit')
    const payload = Buffer.from(body.bundle_base64, 'base64')
    const inspected = inspectSkillArchive(payload)
    return Response.json({
      slug: inspected.name, version: inspected.version, package_sha256: inspected.packageSha256,
      title: 'Publish retry', summary: inspected.description, package_size_bytes: payload.byteLength,
      category: body.category, tags: [],
      uploader: { nickname: 'Owner', author_ref: `author_${'f'.repeat(24)}` },
      provenance: { brand: 'e-Mate', original_platform: null, original_url: null },
      installation_status: 'not_installed', readiness: 'ready',
    }, { status: 201 })
  }
  const client = () => createSkillHubClient({
    dshHome,
    store,
    request,
    baseUrl: 'https://emate-skill-hub.emate-zyfjacksonchen.workers.dev/ecorex-agent/client/skill-hub/v1',
  })
  const first = client()
  await assert.rejects(
    first.publishPrepared(first.previewPublication('publish-retry'), 'third_party'),
    /pending authenticated server reconciliation/,
  )
  assert.deepEqual(await client().recover(), [
    { slug: 'publish-retry', action: 'publish', status: 'recovered' },
  ])
  assert.equal(uploads[0].client_request_id, uploads[1].client_request_id)
  assert.equal(uploads[0].bundle_base64, uploads[1].bundle_base64)
})

test('a lost delete response retries the exact owned publication with one stable request identity', async () => {
  const archive = skillArchive('delete-retry', '1.0.0+build.1')
  const card = {
    ...archive.card,
    title: 'Delete retry', summary: 'Idempotent remote deletion', package_size_bytes: archive.payload.byteLength,
    category: 'third_party', tags: [],
    uploader: { nickname: 'Owner', author_ref: `author_${'e'.repeat(24)}` },
    provenance: { brand: 'e-Mate', original_platform: null, original_url: null },
    installation_status: 'not_installed', readiness: 'ready',
  }
  const requests = []
  const dshHome = temporaryHome()
  const client = () => createSkillHubClient({
    dshHome,
    store: { inventory: async () => [], recover: async () => [] },
    baseUrl: 'https://emate-skill-hub.emate-zyfjacksonchen.workers.dev/ecorex-agent/client/skill-hub/v1',
    async request(url, init = {}) {
      if (url.pathname.endsWith('/publications/mine')) {
        assert.equal(url.searchParams.get('version'), card.version)
        return Response.json({ schema_version: 1, items: [card] })
      }
      const body = JSON.parse(init.body)
      requests.push(body)
      if (requests.length === 1) throw new Error('delete response lost after commit')
      return Response.json({
        schema_version: 1, status: 'deleted',
        slug: card.slug, version: card.version, package_sha256: card.package_sha256, uploader: card.uploader,
      })
    },
  })
  const hub = client()
  const first = await hub.ownedPublication(card.slug, card.version)
  await assert.rejects(hub.deletePublication(first), /pending authenticated server reconciliation/)
  assert.deepEqual(await client().recover(), [
    { slug: card.slug, action: 'delete', status: 'recovered' },
  ])
  assert.equal(requests[0].client_request_id, requests[1].client_request_id)
})

test('Agent natural language surface registers the complete typed lifecycle and confirms exact publication bytes', async () => {
  const dshHome = temporaryHome()
  await install(lifecycleStore(dshHome), skillArchive('shared-download', '5.0.0'))
  const skill = join(dshHome, 'skills', 'natural-share')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: natural-share\ndescription: natural language publication\nversion: 2.3.4\n---\n\nShare.\n')
  const tools = []
  const prompts = []
  const questions = []
  const jobs = []
  const routes = []
  const remoteMutations = []
  let publishedRemoteCard
  const download = skillArchive('shared-download', '4.5.6')
  const downloadCard = {
    ...download.card,
    title: 'Shared download', summary: 'Natural language download', package_size_bytes: download.payload.byteLength,
    category: 'third_party', tags: ['shared'],
    uploader: { nickname: 'Other user', author_ref: `author_${'c'.repeat(24)}` },
    provenance: { brand: 'e-Mate', original_platform: null, original_url: null },
    installation_status: 'not_installed', readiness: 'ready',
  }
  let provider
  let skillHubRpcHandler
  const ctx = {
    get: name => name === 'emateIdentity' ? { request: async (url, init = {}) => {
      if (url.pathname.endsWith('/skills/shared-download')) {
        return Response.json({ schema_version: 1, skill: downloadCard, versions: [downloadCard] })
      }
      if (url.pathname.endsWith('/skills/shared-download/versions/4.5.6') && init.method === undefined) {
        return Response.json(downloadCard)
      }
      if (url.pathname.endsWith('/skills/shared-download/versions/4.5.6/package')) {
        return new Response(download.payload, { headers: { 'x-skill-content-sha256': download.card.package_sha256 } })
      }
      if (url.pathname.endsWith('/skills') && init.method === 'POST') {
        const body = JSON.parse(init.body)
        const inspected = inspectSkillArchive(Buffer.from(body.bundle_base64, 'base64'))
        remoteMutations.push({ action: 'publish', body })
        publishedRemoteCard = {
          slug: inspected.name, version: inspected.version, package_sha256: inspected.packageSha256,
          title: 'Natural share', summary: inspected.description, package_size_bytes: Buffer.from(body.bundle_base64, 'base64').byteLength,
          category: body.category, tags: [],
          uploader: { nickname: 'Agent owner', author_ref: `author_${'d'.repeat(24)}` },
          provenance: { brand: 'e-Mate', original_platform: null, original_url: null },
          installation_status: 'not_installed', readiness: 'ready',
        }
        return Response.json(publishedRemoteCard, { status: 201 })
      }
      if (url.pathname.endsWith('/publications/mine') && init.method === undefined) {
        assert.equal(url.searchParams.get('slug'), 'natural-share')
        assert.equal(url.searchParams.get('version'), '2.3.4')
        return Response.json({ schema_version: 1, items: [publishedRemoteCard] })
      }
      if (url.pathname.endsWith('/skills/natural-share/versions/2.3.4') && init.method === 'DELETE') {
        const body = JSON.parse(init.body)
        remoteMutations.push({ action: 'delete', body })
        return Response.json({
          schema_version: 1,
          status: 'deleted',
          slug: 'natural-share',
          version: '2.3.4',
          package_sha256: body.package_sha256,
          uploader: publishedRemoteCard.uploader,
        })
      }
      throw new Error('network mutation must start only inside the Job')
    } } : undefined,
    logger: { warn() {} },
    skills: {
      registerProvider(factory) {
        provider = factory({ signal: new AbortController().signal, invalidate() {} })
      },
      async get(slug, options) {
        const observed = await provider.list(options)
        const candidates = Array.isArray(observed) ? observed : observed.candidates
        const candidate = candidates.find(value => value.name === slug)
        return candidate === undefined ? undefined : provider.get(candidate, options)
      },
    },
    jobs: {
      attachController() {},
      start(specification) { jobs.push(specification); return `job-${jobs.length}` },
      list: () => [],
      get() { throw new Error('not used') },
      read() { throw new Error('not used') },
      kill() { throw new Error('not used') },
    },
    userQuestions: {
      async ask({ questions: asked }) {
        questions.push(...asked)
        return { answers: [{ selected: [asked[0].options[0].label] }] }
      },
    },
    systemPrompt: { section(value) { prompts.push(value); return () => {} } },
    connection: { rpc: { handle(_channel, handler) { skillHubRpcHandler = handler; return () => {} } } },
    webServer: { register(value) { routes.push(value); return () => {} } },
    tools: { register(value) { tools.push(value) } },
    effect(callback) { return callback() },
  }
  await apply(ctx, { dshHome, baseUrl: 'https://emate-skill-hub.emate-zyfjacksonchen.workers.dev/ecorex-agent/client/skill-hub/v1' })

  const failedCatalog = await skillHubRpcHandler('catalog.search', { query: '', limit: 24 }, new AbortController().signal)
  assert.equal(failedCatalog.ok, true)
  assert.equal(failedCatalog.value.schema_version, 1)
  assert.equal(failedCatalog.value.status, 'failure')
  assert.equal(failedCatalog.value.error.code, 'network')
  assert.doesNotMatch(failedCatalog.value.error.message, /network mutation|fetch failed|invalid_union|Invalid input/u)

  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'e_mate_skill_hub_delete_publication',
    'e_mate_skill_hub_detail',
    'e_mate_skill_hub_disable',
    'e_mate_skill_hub_download',
    'e_mate_skill_hub_enable',
    'e_mate_skill_hub_install',
    'e_mate_skill_hub_inventory',
    'e_mate_skill_hub_publish',
    'e_mate_skill_hub_search',
    'e_mate_skill_hub_uninstall',
    'e_mate_skill_hub_update',
  ])
  assert.match(prompts.at(0).text, /natural language/)
  assert.match(prompts.at(0).text, /install\/update\/enable\/disable\/uninstall/)
  assert.match(prompts.at(0).text, /e_mate_skill_hub_publish/)

  const publish = tools.find(tool => tool.name === 'e_mate_skill_hub_publish')
  const started = await publish.execute({ source: 'installed', identity: 'natural-share', category: 'third_party' }, {
    agent: { id: 'agent-test' },
    signal: new AbortController().signal,
  })
  assert.deepEqual(started, { job_id: 'job-1', status: 'running' })
  assert.match(questions.at(0).question, /natural-share@2\.3\.4/)
  assert.match(questions.at(0).detail, /内容 SHA-256: [0-9a-f]{64}/)
  assert.match(questions.at(0).detail, /ZIP SHA-256: [0-9a-f]{64}/)
  assert.equal(jobs.length, 1)
  const published = await jobs[0].run().done
  assert.equal(published.status, 'completed')
  const publishedCard = JSON.parse(published.output)
  assert.equal(publishedCard.slug, 'natural-share')
  assert.equal(remoteMutations.at(0).action, 'publish')

  const downloadTool = tools.find(tool => tool.name === 'e_mate_skill_hub_download')
  assert.deepEqual(await downloadTool.execute({ slug: 'shared-download', version: '4.5.6' }, {
    agent: { id: 'agent-test' },
    signal: new AbortController().signal,
  }), { job_id: 'job-2', status: 'running' })
  const execution = jobs[1].run()
  const terminal = await execution.done
  assert.equal(terminal.status, 'completed')
  const result = JSON.parse(terminal.output)
  let responseStatus
  let responseBody
  routes.at(0).handler({ method: 'HEAD', url: `/api/e-mate/skill-hub.download?id=${result.download_id}` }, {
    writeHead(status) { responseStatus = status },
    end(body) { responseBody = body },
  })
  assert.equal(responseStatus, 200)
  assert.equal(responseBody, undefined)
  routes.at(0).handler({ method: 'GET', url: `/api/e-mate/skill-hub.download?id=${result.download_id}` }, {
    writeHead(status) { responseStatus = status },
    end(body) { responseBody = body },
  })
  assert.equal(responseStatus, 200)
  assert.deepEqual(Buffer.from(responseBody), download.payload)
  routes.at(0).handler({ method: 'GET', url: `/api/e-mate/skill-hub.download?id=${result.download_id}` }, {
    writeHead(status) { responseStatus = status },
    end() {},
  })
  assert.equal(responseStatus, 404)

  const deleteTool = tools.find(tool => tool.name === 'e_mate_skill_hub_delete_publication')
  assert.deepEqual(await deleteTool.execute({
    slug: 'natural-share',
    version: '2.3.4',
  }, {
    agent: { id: 'agent-test' },
    signal: new AbortController().signal,
  }), { job_id: 'job-3', status: 'running' })
  assert.match(questions.at(-1).question, /删除你发布的 natural-share@2\.3\.4/u)
  assert.match(questions.at(-1).detail, new RegExp(publishedCard.package_sha256, 'u'))
  const deleted = await jobs[2].run().done
  assert.equal(deleted.status, 'completed')
  assert.deepEqual(JSON.parse(deleted.output), {
    schema_version: 1,
    status: 'deleted',
    slug: 'natural-share',
    version: '2.3.4',
    package_sha256: publishedCard.package_sha256,
    uploader: publishedRemoteCard.uploader,
  })
  assert.equal(existsSync(join(dshHome, 'skills', 'natural-share', 'SKILL.md')), true)
  const workspace = join(dshHome, 'workspace')
  const imports = join(workspace, '.e-mate', 'imports')
  mkdirSync(imports, { recursive: true })
  const artifact = skillArchive('artifact-share', '1.0.0')
  writeFileSync(join(imports, 'artifact-share.zip'), artifact.payload)
  symlinkSync('artifact-share.zip', join(imports, 'artifact-link.zip'))
  await assert.rejects(publish.execute({
    source: 'workspace-artifact',
    identity: '/tmp/arbitrary-host-path.zip',
    category: 'third_party',
  }, {
    agent: { id: 'agent-test', session: { header: { cwd: workspace } } },
    signal: new AbortController().signal,
  }), /artifact identity is invalid/u)
  await assert.rejects(publish.execute({
    source: 'workspace-artifact',
    identity: '.e-mate/imports/artifact-link.zip',
    category: 'third_party',
  }, {
    agent: { id: 'agent-test', session: { header: { cwd: workspace } } },
    signal: new AbortController().signal,
  }), /bounded regular ZIP/u)
  assert.deepEqual(await publish.execute({
    source: 'workspace-artifact',
    identity: '.e-mate/imports/artifact-share.zip',
    category: 'third_party',
  }, {
    agent: { id: 'agent-test', session: { header: { cwd: workspace } } },
    signal: new AbortController().signal,
  }), { job_id: 'job-4', status: 'running' })
  assert.match(questions.at(-1).detail, /当前会话产物 \.e-mate\/imports\/artifact-share\.zip/u)
  assert.equal((await jobs[3].run().done).status, 'completed')
  assert.deepEqual(remoteMutations.map(item => item.action), ['publish', 'delete', 'publish'])

  const updateTool = tools.find(tool => tool.name === 'e_mate_skill_hub_update')
  const updateExec = { agent: { id: 'agent-test' }, signal: new AbortController().signal }
  await assert.rejects(
    updateTool.execute({ slug: 'shared-download', version: '4.5.6' }, updateExec),
    /set allow_downgrade only after the user explicitly chooses/u,
  )
  assert.deepEqual(await updateTool.execute({
    slug: 'shared-download', version: '4.5.6', allow_downgrade: true,
  }, updateExec), { job_id: 'job-5', status: 'running' })
  assert.match(questions.at(-1).question, /降级 shared-download@4\.5\.6/u)
  assert.match(questions.at(-1).detail, /当前版本: 5\.0\.0/u)
  assert.match(questions.at(-1).detail, new RegExp(downloadCard.uploader.author_ref, 'u'))
  const failedUpdate = await jobs[4].run().done
  assert.equal(failedUpdate.status, 'failed')
  assert.equal(JSON.parse(failedUpdate.output).error.code, 'network')
})
