import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { deflateRawSync } from 'node:zlib'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import worker, { handleRequest, inspectSkillArchive, versionSort } from '../src/index.js'
import { normalizeVersionSort } from '../src/core.ts'

import { MemoryD1, MemoryR2, zip, skill, modelToken, environment, request, activeSession, direct, publicationBody } from './fixtures.mjs'

test('matches the DSH client canonical Skill digest', async () => {
  const payload = zip({
    'SKILL.md': [
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
    ].join('\n'),
    'guide/说明.md': 'hello\n',
  })
  const inspected = await inspectSkillArchive(payload)
  assert.equal(inspected.packageSha256, 'c268e7ed14e5aa798362b40d25a981d21b7c9d02e457ccc7f36d6da2150b7042')
})

test('publishes a bounded human-readable heading without changing canonical Skill identity', async () => {
  const env = environment()
  const payload = zip({ 'SKILL.md': '---\nname: xhs-note-analyzer\ndescription: Shared note analysis\nversion: 1.1.0\n---\n\n# 小红书笔记分析\n' })
  const published = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: publicationBody(payload, 'xhs-note-analyzer', 'content_creation', 'publish:xhs-title-0001'),
  }, 'user-1')
  assert.equal(published.status, 201)
  assert.equal((await published.clone().json()).title, '小红书笔记分析')
  const catalog = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills?query=%E5%B0%8F%E7%BA%A2%E4%B9%A6&limit=24', {}, 'user-2')
  assert.deepEqual((await catalog.json()).items, [await published.json()])
})

test('fixed forwarding needs root configuration and never falls back or follows a redirect', async () => {
  const previous = globalThis.fetch
  const env = { SKILL_HUB_FORWARD_ENABLED: 'true', SKILL_HUB_FORWARD_ORIGIN: 'https://fixed-service.example' }
  const calls = []
  globalThis.fetch = async (input) => { calls.push(input.url); return Response.json({ schema_version: 1, items: [], next_cursor: null }) }
  try {
    const response = await worker.fetch(request('/ecorex-agent/client/skill-hub/v1/skills?limit=1'), env)
    assert.equal(response.status, 200)
    assert.deepEqual(calls, ['https://fixed-service.example/ecorex-agent/client/skill-hub/v1/skills?limit=1'])
    assert.equal((await worker.fetch(request('/healthz'), env)).status, 200)
    assert.equal(calls.at(-1), 'https://fixed-service.example/ecorex-agent/client/skill-hub/v1/healthz')
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://other.example' } })
    assert.equal((await worker.fetch(request('/ecorex-agent/client/skill-hub/v1/skills'), env)).status, 503)
    globalThis.fetch = async () => { throw new Error('offline') }
    assert.equal((await worker.fetch(request('/ecorex-agent/client/skill-hub/v1/skills'), env)).status, 503)
    assert.equal((await worker.fetch(request('/ecorex-agent/client/skill-hub/v1/skills'), { ...env, SKILL_HUB_FORWARD_ENABLED: 'invalid' })).status, 503)
    assert.equal((await worker.fetch(request('/ecorex-agent/client/skill-hub/v1/skills', { method: 'POST' }), {
      SKILL_HUB_READ_ONLY: 'true',
    })).status, 503)
  } finally { globalThis.fetch = previous }
})

test('expired created intents fail while concurrent claim and completion append one log per transition', async () => {
  const env = environment()
  const slug = 'intent-race'
  const published = await direct(env, `/ecorex-agent/client/skill-hub/v1/skills`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: publicationBody(skill(slug, '1.0.0'), slug) })
  const card = await published.json()
  const create = async (requestId) => (await direct(env, `/ecorex-agent/client/skill-hub/v1/skills/${slug}/versions/1.0.0/install-intent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ package_sha256: card.package_sha256, client_request_id: requestId }),
  })).json()
  const expired = await create('intent:expired-request')
  env.DB.database.prepare('UPDATE skill_hub_install_intents SET expires_at=? WHERE intent_id=?').run('2000-01-01T00:00:00.000Z', expired.intent_id)
  const invoke = (path, body) => handleRequest(request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, activeSession)
  await assert.rejects(invoke('/ecorex-agent/client/skill-hub/v1/install-intents/consume', { install_intent: expired.install_intent }), (error) => error.status === 409)
  const fresh = await create('intent:concurrent-request')
  const originalBatch = env.DB.batch.bind(env.DB)
  const barrier = () => {
    let waiting = 0
    let release
    const ready = new Promise((resolve) => { release = resolve })
    env.DB.batch = async (statements) => {
      waiting++
      if (waiting === 2) release()
      await ready
      return originalBatch(statements)
    }
  }
  barrier()
  const claims = await Promise.allSettled([0, 1].map(() => invoke('/ecorex-agent/client/skill-hub/v1/install-intents/consume', { install_intent: fresh.install_intent })))
  assert.equal(claims.filter(({ status }) => status === 'fulfilled').length, 1)
  const claimed = claims.find(({ status }) => status === 'fulfilled')
  const receipt = await claimed.value.json()
  barrier()
  const completed = await Promise.all([0, 1].map(() => invoke('/ecorex-agent/client/skill-hub/v1/install-intents/complete', { completion_receipt: receipt.completion_receipt, status: 'installed' })))
  assert.deepEqual(completed.map(({ status }) => status), [200, 200])
  assert.deepEqual(env.DB.database.prepare('SELECT status FROM skill_hub_install_logs WHERE intent_id=? ORDER BY seq').all(fresh.intent_id).map(({ status }) => status), ['created', 'claimed', 'installed'])
})

test('rejects an existing R2 object whose full package metadata is not the published identity', async () => {
  const env = environment()
  const payload = skill('r2-identity', '1.0.0')
  const inspected = await inspectSkillArchive(payload)
  await env.PACKAGES.put(`packages/${inspected.packageSha256}.zip`, payload, {
    customMetadata: { archive_sha256: inspected.archiveSha256 },
  })
  const published = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: publicationBody(payload, 'r2-identity', 'third_party', 'publish:r2-meta-0001'),
  })
  assert.equal(published.status, 409)
  assert.equal((await published.json()).error.code, 'conflict')
})

test('stops decompression at the ZIP declared expansion boundary', async () => {
  const payload = Buffer.from(skill('bounded-inflate', '1.0.0'))
  const central = payload.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  assert.notEqual(central, -1)
  payload.writeUInt32LE(1, central + 24)
  await assert.rejects(inspectSkillArchive(payload), /declared expansion budget|cannot be decompressed/u)
})

test('publishes, discovers, downloads, installs, reconciles, and tombstones one immutable Skill', async () => {
  const env = environment()
  const v1 = skill('shared-notes', '1.0.0', ['office'])
  const published = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: publicationBody(v1, 'shared-notes'),
  })
  assert.equal(published.status, 201)
  const card = await published.json()
  assert.equal(card.slug, 'shared-notes')
  assert.equal(card.version, '1.0.0')
  assert.match(card.package_sha256, /^[0-9a-f]{64}$/u)

  const replay = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: publicationBody(v1, 'shared-notes'),
  })
  assert.deepEqual(await replay.json(), card)

  const catalog = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills?query=notes&tag=office&limit=24')
  assert.deepEqual((await catalog.json()).items, [card])
  const detail = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/shared-notes')
  assert.deepEqual((await detail.json()).versions, [card])

  const downloaded = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/shared-notes/versions/1.0.0/package')
  assert.equal(downloaded.headers.get('x-skill-content-sha256'), card.package_sha256)
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), v1)

  const created = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/shared-notes/versions/1.0.0/install-intent', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ package_sha256: card.package_sha256, client_request_id: 'install:request-0001' }),
  })
  const intent = await created.json()
  assert.equal(intent.install_intent.length, 64)
  const claimed = await direct(env, '/ecorex-agent/client/skill-hub/v1/install-intents/consume', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ install_intent: intent.install_intent }),
  })
  const receipt = await claimed.json()
  assert.equal(receipt.completion_receipt.length, 64)
  const completed = await direct(env, '/ecorex-agent/client/skill-hub/v1/install-intents/complete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ completion_receipt: receipt.completion_receipt, status: 'installed' }),
  })
  const completedReceipt = await completed.json()
  assert.equal(completedReceipt.status, 'installed')
  assert.equal(completedReceipt.slug, card.slug)
  assert.equal(completedReceipt.version, card.version)
  assert.equal(completedReceipt.package_sha256, card.package_sha256)
  assert.deepEqual(completedReceipt.uploader, card.uploader)
  const completionReplay = await direct(env, '/ecorex-agent/client/skill-hub/v1/install-intents/complete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ completion_receipt: receipt.completion_receipt, status: 'installed' }),
  })
  assert.equal(completionReplay.status, 200)
  const reconciled = await direct(env, '/ecorex-agent/client/skill-hub/v1/install-intents/reconcile', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ completion_receipt: receipt.completion_receipt }),
  })
  assert.deepEqual(await reconciled.json(), completedReceipt)

  const deleted = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/shared-notes/versions/1.0.0', {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ package_sha256: card.package_sha256, client_request_id: 'delete:request-0001' }),
  })
  assert.equal(deleted.status, 200)
  assert.deepEqual((await (await direct(env, '/ecorex-agent/client/skill-hub/v1/skills?query=&limit=24')).json()).items, [])
  const owned = await direct(env, '/ecorex-agent/client/skill-hub/v1/publications/mine?slug=shared-notes&version=1.0.0')
  assert.deepEqual((await owned.json()).items, [])
  const deletedReplay = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/shared-notes/versions/1.0.0', {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ package_sha256: card.package_sha256, client_request_id: 'delete:request-0001' }),
  })
  assert.equal(deletedReplay.status, 200)
})

test('keeps slug ownership account-bound and restores the previous SemVer latest after deletion', async () => {
  const env = environment()
  const publish = async (version, requestId, userId = 'user-1') => direct(env, '/ecorex-agent/client/skill-hub/v1/skills', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: publicationBody(skill('versioned-skill', version), 'versioned-skill', 'content_creation', requestId),
  }, userId)
  const one = await (await publish('1.0.0', 'publish:version-0001')).json()
  const prerelease = await (await publish('2.0.0-beta.1', 'publish:version-0002')).json()
  const two = await (await publish('2.0.0', 'publish:version-0003')).json()
  const buildOne = await (await publish('2.0.0+build.1', 'publish:version-0004')).json()
  const buildTwo = await (await publish('2.0.0+build.2', 'publish:version-0005')).json()
  const latest = await (await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/versioned-skill')).json()
  assert.equal(latest.skill.version, '2.0.0+build.2')
  assert.deepEqual(latest.versions.map(card => card.version), [
    '2.0.0+build.2', '2.0.0+build.1', '2.0.0', '2.0.0-beta.1', '1.0.0',
  ])
  await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/versioned-skill/versions/2.0.0%2Bbuild.2', {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ package_sha256: buildTwo.package_sha256, client_request_id: 'delete:version-0005' }),
  })
  assert.equal((await (await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/versioned-skill')).json()).skill.version, '2.0.0+build.1')
  await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/versioned-skill/versions/2.0.0%2Bbuild.1', {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ package_sha256: buildOne.package_sha256, client_request_id: 'delete:version-0004' }),
  })
  assert.equal((await (await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/versioned-skill')).json()).skill.version, '2.0.0')
  const hijack = await publish('3.0.0', 'publish:hijack-0001', 'user-2')
  assert.equal(hijack.status, 409)
  const forbiddenDelete = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/versioned-skill/versions/2.0.0', {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ package_sha256: two.package_sha256, client_request_id: 'delete:forbidden-0001' }),
  }, 'user-2')
  assert.equal(forbiddenDelete.status, 409)
  const deleted = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/versioned-skill/versions/2.0.0', {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ package_sha256: two.package_sha256, client_request_id: 'delete:version-0003' }),
  })
  assert.equal(deleted.status, 200)
  const restored = await (await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/versioned-skill')).json()
  assert.equal(restored.skill.version, prerelease.version)
  assert.equal(restored.versions.at(-1).package_sha256, one.package_sha256)
})

test('uses opaque keyset cursors for catalog and version history', async () => {
  const env = environment()
  const publish = (slug, version, requestId) => direct(env, '/ecorex-agent/client/skill-hub/v1/skills', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: publicationBody(skill(slug, version), slug, 'third_party', requestId),
  })
  await publish('alpha-skill', '1.0.0', 'publish:cursor-0001')
  await publish('version-pages', '1.0.0', 'publish:cursor-0002')
  await publish('version-pages', '2.0.0-beta', 'publish:cursor-0003')
  await publish('version-pages', '2.0.0', 'publish:cursor-0004')

  const firstCatalog = await (await direct(env, '/ecorex-agent/client/skill-hub/v1/skills?query=&limit=1')).json()
  assert.deepEqual(firstCatalog.items.map(item => item.slug), ['alpha-skill'])
  assert.equal(typeof firstCatalog.next_cursor, 'string')
  assert.notEqual(firstCatalog.next_cursor, 'alpha-skill')
  const secondCatalog = await (await direct(env, `/ecorex-agent/client/skill-hub/v1/skills?query=&limit=1&cursor=${encodeURIComponent(firstCatalog.next_cursor)}`)).json()
  assert.deepEqual(secondCatalog.items.map(item => item.slug), ['version-pages'])
  const wrongScope = await direct(env, `/ecorex-agent/client/skill-hub/v1/skills?query=changed&limit=1&cursor=${encodeURIComponent(firstCatalog.next_cursor)}`)
  assert.equal(wrongScope.status, 422)

  await publish('semver-pages', '1.0.0-aa', 'publish:semver-0001')
  await publish('semver-pages', '1.0.0-z', 'publish:semver-0002')
  await publish('semver-pages', '1.0.0-9007199254740992', 'publish:semver-0003')
  await publish('semver-pages', '1.0.0-9007199254740993', 'publish:semver-0004')
  const semverCatalog = await (await direct(env, '/ecorex-agent/client/skill-hub/v1/skills?query=semver-pages&limit=1')).json()
  assert.equal(semverCatalog.items[0].version, '1.0.0-z')
  const semverFirst = await (await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/semver-pages?limit=2')).json()
  const semverSecond = await (await direct(env, `/ecorex-agent/client/skill-hub/v1/skills/semver-pages?limit=2&cursor=${encodeURIComponent(semverFirst.next_cursor)}`)).json()
  assert.deepEqual([...semverFirst.versions, ...semverSecond.versions].map(item => item.version), [
    '1.0.0-z',
    '1.0.0-aa',
    '1.0.0-9007199254740993',
    '1.0.0-9007199254740992',
  ])
  assert.equal(semverFirst.skill.version, '1.0.0-z')

  const firstVersions = await (await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/version-pages?limit=2')).json()
  assert.deepEqual(firstVersions.versions.map(item => item.version), ['2.0.0', '2.0.0-beta'])
  assert.equal(typeof firstVersions.next_cursor, 'string')
  assert.notEqual(firstVersions.next_cursor, '2.0.0-beta')
  const secondVersions = await (await direct(env, `/ecorex-agent/client/skill-hub/v1/skills/version-pages?limit=2&cursor=${encodeURIComponent(firstVersions.next_cursor)}`)).json()
  assert.deepEqual(secondVersions.versions.map(item => item.version), ['1.0.0'])
  assert.equal(secondVersions.skill.version, '2.0.0')
  assert.equal(secondVersions.next_cursor, null)
  const legacyPayload = JSON.parse(Buffer.from(firstVersions.next_cursor.split('.')[0], 'base64url').toString())
  legacyPayload.version_sort = '0012.0010.0010.1004beta!'
  const signCursor = payload => {
    const bytes = Buffer.from(JSON.stringify(payload))
    return `${bytes.toString('base64url')}.${createHmac('sha256', env.AUTHOR_KEY).update(bytes).digest('base64url')}`
  }
  const legacyCursor = signCursor(legacyPayload)
  const legacySecond = await direct(env, `/ecorex-agent/client/skill-hub/v1/skills/version-pages?limit=2&cursor=${encodeURIComponent(legacyCursor)}`)
  assert.equal(legacySecond.status, 200)
  assert.deepEqual(await legacySecond.json(), secondVersions)
  const corruptCursor = signCursor({ ...legacyPayload, version_sort: '0012.0010.0010.1004oops!' })
  assert.equal((await direct(env, `/ecorex-agent/client/skill-hub/v1/skills/version-pages?cursor=${encodeURIComponent(corruptCursor)}`)).status, 422)
  const forgedCursor = `${Buffer.from(JSON.stringify({ ...legacyPayload, version: '1.0.0' })).toString('base64url')}.${legacyCursor.split('.')[1]}`
  assert.equal((await direct(env, `/ecorex-agent/client/skill-hub/v1/skills/version-pages?cursor=${encodeURIComponent(forgedCursor)}`)).status, 422)
  const exactVersion = await (await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/version-pages/versions/1.0.0')).json()
  assert.equal(exactVersion.version, '1.0.0')
})

test('keeps version sort keys exact beyond three-digit numeric identifier lengths', () => {
  assert.ok(versionSort(`1.0.0-${'9'.repeat(1_000)}`) > versionSort(`1.0.0-${'9'.repeat(999)}`))
  assert.ok(versionSort('1.0.0-a-') > versionSort('1.0.0-a.1'))
  assert.equal(normalizeVersionSort('1.0.0', '0011.0010.0010~'), versionSort('1.0.0'))
  assert.equal(normalizeVersionSort('0.0.1', '0010.0010.0011~'), versionSort('0.0.1'))
  assert.equal(normalizeVersionSort('1.0.0-rc.12', '0011.0010.0010.1002rc.000212!'), versionSort('1.0.0-rc.12'))
  assert.throws(() => normalizeVersionSort('1.0.0', '00011.00010.00010~'), /sort identity/)
})

test('rejects browser bearer transport and binds one-time install credentials to the authenticated session', async () => {
  const env = environment()
  const payload = skill('session-bound', '1.0.0')
  const card = await (await direct(env, '/ecorex-agent/client/skill-hub/v1/skills', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: publicationBody(payload, 'session-bound', 'third_party', 'publish:session-0001'),
  })).json()
  const host = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills?query=&limit=1', {
    headers: { 'sec-fetch-mode': 'cors' },
  })
  assert.equal(host.status, 200)
  assert.deepEqual((await host.json()).items, [card])
  const browser = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills?query=&limit=1', {
    headers: { origin: 'https://renderer.invalid', 'sec-fetch-mode': 'cors' },
  })
  assert.equal(browser.status, 403)
  assert.equal((await browser.clone().json()).error.code, 'auth')
  assert.equal(browser.headers.get('access-control-allow-origin'), null)
  const browserMetadata = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills?query=&limit=1', {
    headers: { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(browserMetadata.status, 403)

  const firstSession = '01234567-89ab-4def-8123-456789abcdef'
  const secondSession = '11234567-89ab-4def-8123-456789abcdef'
  const created = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/session-bound/versions/1.0.0/install-intent', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ package_sha256: card.package_sha256, client_request_id: 'install:session-0001' }),
  }, 'user-1', firstSession)
  const intent = await created.json()
  const duplicate = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/session-bound/versions/1.0.0/install-intent', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ package_sha256: card.package_sha256, client_request_id: 'install:session-0001' }),
  }, 'user-1', firstSession)
  assert.equal(duplicate.status, 409)
  assert.equal((await duplicate.json()).error.code, 'conflict')
  const wrongSession = await direct(env, '/ecorex-agent/client/skill-hub/v1/install-intents/consume', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ install_intent: intent.install_intent }),
  }, 'user-1', secondSession)
  assert.equal(wrongSession.status, 409)
  const claimed = await direct(env, '/ecorex-agent/client/skill-hub/v1/install-intents/consume', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ install_intent: intent.install_intent }),
  }, 'user-1', firstSession)
  const receipt = await claimed.json()
  assert.equal(receipt.slug, 'session-bound')
  assert.equal(receipt.version, '1.0.0')
  assert.equal(receipt.package_sha256, card.package_sha256)
  assert.deepEqual(receipt.uploader, card.uploader)
  const consumedAgain = await direct(env, '/ecorex-agent/client/skill-hub/v1/install-intents/consume', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ install_intent: intent.install_intent }),
  }, 'user-1', firstSession)
  assert.equal(consumedAgain.status, 409)
  const wrongCompletionSession = await direct(env, '/ecorex-agent/client/skill-hub/v1/install-intents/complete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ completion_receipt: receipt.completion_receipt, status: 'installed' }),
  }, 'user-1', secondSession)
  assert.equal(wrongCompletionSession.status, 409)
})

test('keeps legacy duplicate intent rows deployable while concurrent request identity stays unique', async () => {
  const env = environment()
  const insert = 'INSERT INTO skill_hub_install_intents(intent_id,account_ref,slug,version,package_sha256,client_request_id,install_token_sha256,completion_token_sha256,expires_at,status) VALUES (?,?,?,?,?,?,?,?,?,?)'
  for (const suffix of ['one', 'two']) await env.DB.prepare(insert).bind(
    `legacy_${suffix}`, 'legacy-account', 'legacy-skill', '1.0.0', 'a'.repeat(64), 'legacy:duplicate-request',
    `${suffix}${'0'.repeat(64 - suffix.length)}`, null, '2026-08-27T00:00:00.000Z', 'created',
  ).run()
  env.DB.database.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'))
  assert.equal(env.DB.database.prepare('SELECT COUNT(*) AS count FROM skill_hub_install_intents WHERE account_ref=? AND client_request_id=?')
    .get('legacy-account', 'legacy:duplicate-request').count, 2)

  const payload = skill('intent-race', '1.0.0')
  const card = await (await direct(env, '/ecorex-agent/client/skill-hub/v1/skills', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: publicationBody(payload, 'intent-race', 'third_party', 'publish:intent-race-0001'),
  })).json()
  const options = {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ package_sha256: card.package_sha256, client_request_id: 'install:intent-race-0001' }),
  }
  const create = async () => {
    try {
      return await handleRequest(request('/ecorex-agent/client/skill-hub/v1/skills/intent-race/versions/1.0.0/install-intent', options), env, activeSession)
    } catch (error) {
      return { status: error.status }
    }
  }
  const responses = await Promise.all([
    create(),
    create(),
  ])
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409])
  assert.equal(env.DB.database.prepare('SELECT COUNT(*) AS count FROM skill_hub_install_intents WHERE client_request_id=?')
    .get('install:intent-race-0001').count, 1)
})

test('does not report a tombstoned publication replay as published', async () => {
  const env = environment()
  const payload = skill('deleted-replay', '1.0.0')
  const body = publicationBody(payload, 'deleted-replay', 'third_party', 'publish:deleted-0001')
  const published = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  })
  const card = await published.json()
  await direct(env, '/ecorex-agent/client/skill-hub/v1/skills/deleted-replay/versions/1.0.0', {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ package_sha256: card.package_sha256, client_request_id: 'delete:deleted-0001' }),
  })
  const replay = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  })
  assert.equal(replay.status, 409)
  assert.equal((await replay.json()).error.code, 'conflict')
  const newRequestReplay = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: publicationBody(payload, 'deleted-replay', 'third_party', 'publish:deleted-0002'),
  })
  assert.equal(newRequestReplay.status, 409)
  assert.equal((await newRequestReplay.json()).error.code, 'conflict')
})

test('fails closed before storage for invalid identity and invalid archives', async () => {
  const env = environment()
  const unauthorized = await worker.fetch(new Request('https://hub.example/ecorex-agent/client/skill-hub/v1/skills?query=&limit=1'), env)
  assert.equal(unauthorized.status, 401)
  const invalid = await direct(env, '/ecorex-agent/client/skill-hub/v1/skills', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: publicationBody(Buffer.from('not-a-zip'), 'invalid-skill'),
  })
  assert.equal(invalid.status, 422)
  assert.equal(env.PACKAGES.objects.size, 0)
})
