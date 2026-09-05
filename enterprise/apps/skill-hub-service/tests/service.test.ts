import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, type TestContext } from 'node:test'
import { Pool } from 'pg'
import type { PoolClient } from 'pg'
import { environment, direct, skill, publicationBody } from '../../skill-hub-worker/tests/fixtures.mjs'
import { createModelGatewayHandler, InMemoryUsageStore } from '../../model-gateway/src/server.ts'
import { createSessionTokenVerifier } from '../../model-gateway/src/session-auth.ts'
import { InMemoryConsentStore } from '../../../packages/consent-store/src/index.ts'
import { migrate } from '../src/migrate.ts'
import { inspectSnapshot } from '../src/snapshot.ts'
import { createService, start } from '../src/server.ts'
import { FilePackages, sha256 } from '../src/packages.ts'
import { TABLES, postgresQuery } from '../src/postgres.ts'
import type { PackageMetadata } from '../../skill-hub-worker/src/ports.ts'
import { MAX_BODY_BYTES } from '../../skill-hub-worker/src/core.ts'

const databaseUrl = process.env.E_MATE_TEST_POSTGRES_URL
const integration = databaseUrl ? test : test.skip
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5000 }) : undefined
after(async () => { await pool?.end() })
const prefix = '/ecorex-agent/client/skill-hub/v1'
const sessionId = '01234567-89ab-4def-8123-456789abcdef'

async function snapshotFixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'skill-hub-fixture-')))
  const snapshotDirectory = join(directory, 'snapshot')
  await mkdir(join(snapshotDirectory, 'packages'), { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = environment()
  t.after(() => source.DB.database.close())
  const publish = async (slug: string, version: string) => {
    const response = await direct(source, `${prefix}/skills`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: publicationBody(skill(slug, version, ['office']), slug, 'office_productivity', `publish:${slug}:${version}`) }, 'user-1')
    assert.equal(response.status, 201)
    return response.json()
  }
  const alpha = await publish('alpha-skill', '1.0.0')
  const newer = await publish('alpha-skill', '2.0.0')
  await publish('beta-skill', '1.0.0')
  const intent = await direct(source, `${prefix}/skills/alpha-skill/versions/1.0.0/install-intent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ package_sha256: alpha.package_sha256, client_request_id: 'install:seed-request' }),
  }, 'user-2', sessionId)
  assert.equal(intent.status, 200)
  const installation = await intent.json()
  assert.equal((await direct(source, `${prefix}/skills/alpha-skill/versions/2.0.0`, { method: 'DELETE',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ package_sha256: newer.package_sha256, client_request_id: 'delete:seed-request' }) }, 'user-1')).status, 200)
  let sql = readFileSync(new URL('../../skill-hub-worker/schema.sql', import.meta.url), 'utf8')
  const counts: Record<string, number> = {}
  for (const table of TABLES) {
    const rows = source.DB.database.prepare(`SELECT * FROM ${table}`).all() as Record<string, string | number | null>[]
    counts[table] = rows.length
    for (const row of rows) {
      const values = Object.values(row).map((value) => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`)
      sql += `\nINSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${values.join(',')});`
    }
  }
  await writeFile(join(snapshotDirectory, 'd1.snapshot'), sql, { mode: 0o600 })
  const objects: PackageMetadata[] = []
  for (const object of source.PACKAGES.objects.values()) {
    await writeFile(join(snapshotDirectory, object.key), object.bytes, { mode: 0o600 })
    objects.push({ key: object.key, size: object.size, customMetadata: object.customMetadata, httpMetadata: object.httpMetadata })
  }
  await writeFile(join(snapshotDirectory, 'manifest.json'), JSON.stringify({ schema_version: 1,
    d1_sha256: sha256(sql), author_key_sha256: sha256(source.AUTHOR_KEY), table_counts: counts, objects }), { mode: 0o600 })
  const schema = `sh_test_${randomUUID().replaceAll('-', '')}`
  t.after(async () => { if (pool) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) })
  return { directory, snapshotDirectory, volume: join(directory, 'volume'), source, schema, installation, alpha }
}

async function realGateway(t: TestContext) {
  const keys = generateKeyPairSync('ed25519')
  const verifier = createSessionTokenVerifier({ issuer: 'https://fixture.auth', audience: 'e-mate-model-gateway', publicKeys: new Map([['fixture-key', keys.publicKey]]) })
  const policy = { schemaVersion: 1 as const, agreementId: 'fixture-agreement', agreementVersion: '1.0.0', disclaimerVersion: '1.0.0', contentHash: 'a'.repeat(64) }
  const handler = createModelGatewayHandler({
    routes: [{ id: 'gpt-5.6-sol', upstreamModelId: 'gpt-5.6-sol', upstreamBaseUrl: 'https://unused.example/v1', upstreamApiKey: 'synthetic-key-never-used-for-inference',
      providerId: 'fixture-provider', label: 'fixture', buttonLabel: 'fixture', provider: 'fixture', providerMark: 'F', reasoning: true, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
    authenticate: verifier, consentStore: new InMemoryConsentStore(policy), usageStore: new InMemoryUsageStore({
      tenantRequestsPerMinute: 10, tenantBurst: 10, tenantMaxConcurrent: 1, invocationLeaseMs: 180000 }),
    usageKeyId: 'fixture-key', usagePrivateKey: keys.privateKey,
    fetchImplementation: async () => { throw new Error('Inference is outside this fixture') },
  })
  const server = createServer((request, response) => {
    void handler(request, response)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
  const address = server.address()
  assert(address && typeof address === 'object')
  const token = (userId = 'user-1', sid = sessionId) => {
    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'e-mate-model-session+jwt', kid: 'fixture-key' })).toString('base64url')
    const claims = Buffer.from(JSON.stringify({ schemaVersion: 1, iss: 'https://fixture.auth', aud: 'e-mate-model-gateway', sub: userId, sid,
      tenantId: 'tenant-1', scopes: ['models:read', 'responses:create', 'usage:read'], modelIds: ['gpt-5.6-sol'], iat: now, nbf: now, exp: now + 900, jti: randomUUID() })).toString('base64url')
    return `${header}.${claims}.${sign(null, Buffer.from(`${header}.${claims}`), keys.privateKey).toString('base64url')}`
  }
  return { validationUrl: `http://127.0.0.1:${address.port}/v1/consents/current`, token }
}

test('fixed Gateway endpoints distinguish the direct internal route from the HTTPS proxy route', () => {
  const options = { pool: {} as Pool, schema: 'sh_endpoint_test', volume: '/unused', authorKey: 'synthetic-key'.repeat(4) }
  for (const validationUrl of ['http://model-gateway:8080/v1/consents/current', 'http://127.0.0.1:8080/v1/consents/current',
    'http://[::1]:8080/v1/consents/current', 'https://gateway.example/e-mate/model-api/v1/consents/current']) {
    assert.doesNotThrow(() => createService({ ...options, validationUrl }))
  }
  for (const validationUrl of ['http://other-service:8080/v1/consents/current', 'http://model-gateway:8080/e-mate/model-api/v1/consents/current',
    'https://gateway.example/v1/consents/current', 'http://model-gateway:8080/v1/consents/current?target=other',
    'http://user:password@model-gateway:8080/v1/consents/current']) {
    assert.throws(() => createService({ ...options, validationUrl }), /Invalid model validation endpoint/)
  }
})

test('offline preflight validates six table counts, every archive and the original owner key', async (t) => {
  const fixture = await snapshotFixture(t)
  const snapshot = await inspectSnapshot(fixture.snapshotDirectory, fixture.source.AUTHOR_KEY)
  assert.equal(snapshot.summary.objects.count, 3)
  assert.equal(snapshot.summary.tables.skill_hub_versions.count, 3)
  assert.equal(snapshot.summary.tables.skill_hub_publication_tombstones.count, 1)
  await assert.rejects(inspectSnapshot(fixture.snapshotDirectory, 'wrong-owner-key-never-accepted'), /owner key/)
  const manifestPath = join(fixture.snapshotDirectory, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.table_counts.skill_hub_skills++
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(inspectSnapshot(fixture.snapshotDirectory, fixture.source.AUTHOR_KEY), /row count/)
})

test('snapshot SQL cannot attach a host file, and missing or corrupt object bytes never validate', async (t) => {
  const fixture = await snapshotFixture(t)
  const manifestPath = join(fixture.snapshotDirectory, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const original = await readFile(join(fixture.snapshotDirectory, 'd1.snapshot'), 'utf8')
  const forbidden = `${original}\nATTACH DATABASE '${join(fixture.directory, 'forbidden.sqlite')}' AS outside;`
  manifest.d1_sha256 = sha256(forbidden)
  await writeFile(join(fixture.snapshotDirectory, 'd1.snapshot'), forbidden)
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(inspectSnapshot(fixture.snapshotDirectory, fixture.source.AUTHOR_KEY), /authorized/)
  await assert.rejects(readFile(join(fixture.directory, 'forbidden.sqlite')), { code: 'ENOENT' })
  manifest.d1_sha256 = sha256(original)
  await writeFile(join(fixture.snapshotDirectory, 'd1.snapshot'), original)
  await writeFile(manifestPath, JSON.stringify(manifest))
  await rm(join(fixture.snapshotDirectory, manifest.objects[0].key))
  await assert.rejects(inspectSnapshot(fixture.snapshotDirectory, fixture.source.AUTHOR_KEY))
})

integration('a lost PostgreSQL activation reply preserves the committed generation and identical apply replays safely', async (t) => {
  const fixture = await snapshotFixture(t)
  let injected = false
  const uncertain = new Proxy(pool!, {
    get(target, property) {
      if (property === 'connect') return async () => {
        const client = await target.connect()
        let activating = false
        return new Proxy(client, {
          get(connection, key) {
            if (key === 'query') return async (sql: string, values?: unknown[]) => {
              if (sql.startsWith('ALTER SCHEMA ') && sql.includes(' RENAME TO ')) activating = true
              const result = await connection.query(sql, values)
              if (sql === 'COMMIT' && activating && !injected) { injected = true; throw new Error('simulated committed response loss') }
              return result
            }
            const value = Reflect.get(connection, key)
            return typeof value === 'function' ? value.bind(connection) : value
          },
        }) as PoolClient
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const options = { ...fixture, authorKey: fixture.source.AUTHOR_KEY, pool: uncertain, apply: true }
  await assert.rejects(migrate(options), /activation/)
  assert.equal(injected, true)
  const receipt = await migrate({ ...options, pool: pool! })
  assert.equal(receipt.status, 'applied')
  const row = (await pool!.query(`SELECT generation FROM "${fixture.schema}".skill_hub_control`)).rows[0]
  const packages = new FilePackages(join(fixture.volume, 'generations', row.generation))
  assert.equal((await packages.list()).objects.length, 3)
  assert.equal((await pool!.query(`SELECT count(*)::int AS n FROM "${fixture.schema}".skill_hub_versions`)).rows[0].n, 3)
  const archive = join(packages.directory, fixture.alpha.package_sha256, 'archive.zip')
  const original = await readFile(archive)
  await writeFile(archive, Buffer.from('damaged'))
  await assert.rejects(migrate({ ...options, pool: pool! }), /active-readback/)
  await writeFile(archive, original)
  await pool!.query(`UPDATE "${fixture.schema}".skill_hub_skills SET updated_at='changed-after-migration' WHERE slug='alpha-skill'`)
  await assert.rejects(migrate({ ...options, pool: pool! }), /active-readback/)
  assert.equal((await pool!.query(`SELECT generation FROM "${fixture.schema}".skill_hub_control`)).rows[0].generation, row.generation)
})

integration('a lost staging COMMIT response cleans only its private schema and files before activation', async (t) => {
  const fixture = await snapshotFixture(t)
  let stage = ''
  let injected = false
  const uncertain = new Proxy(pool!, {
    get(target, property) {
      if (property === 'connect') return async () => {
        const client = await target.connect()
        let staging = false
        return new Proxy(client, {
          get(connection, key) {
            if (key === 'query') return async (sql: string, values?: unknown[]) => {
              const match = /^CREATE SCHEMA "(sh_stage_[a-f0-9]+)"$/.exec(sql)
              if (match) { staging = true; stage = match[1]! }
              const result = await connection.query(sql, values)
              if (sql === 'COMMIT' && staging && !injected) { injected = true; throw new Error('simulated staging response loss') }
              return result
            }
            const value = Reflect.get(connection, key)
            return typeof value === 'function' ? value.bind(connection) : value
          },
        }) as PoolClient
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  await assert.rejects(migrate({ ...fixture, authorKey: fixture.source.AUTHOR_KEY, pool: uncertain, apply: false }), /database-staging/)
  assert.equal(injected, true)
  for (const name of [stage, fixture.schema]) assert.equal((await pool!.query('SELECT to_regnamespace($1)::text AS name', [name])).rows[0].name, null)
  assert.deepEqual(await readdir(join(fixture.volume, '.staging')), [])
})

integration('actual PostgreSQL and fs migrate atomically and serve the unchanged protocol through real Gateway verification', async (t) => {
  const fixture = await snapshotFixture(t)
  const gateway = await realGateway(t)
  const options = { ...fixture, authorKey: fixture.source.AUTHOR_KEY, pool: pool!, apply: false }
  const checked = await migrate(options)
  assert.equal(checked.status, 'validated')
  assert.equal((await pool!.query('SELECT to_regnamespace($1)::text AS name', [fixture.schema])).rows[0].name, null)
  const applied = await migrate({ ...options, apply: true })
  assert.equal(applied.status, 'applied')
  assert.deepEqual(await migrate({ ...options, apply: true }), applied)
  const service = createService({ ...options, ...gateway })
  const call = (path: string, init: RequestInit = {}, user = 'user-1', sid = sessionId) => service.fetch(new Request(`https://hub.example${path}`, {
    ...init, headers: { authorization: `Bearer ${gateway.token(user, sid)}`, ...init.headers },
  }))
  assert.equal((await call('/readyz')).status, 200)
  const writer = await pool!.connect()
  try {
    await writer.query('BEGIN')
    await writer.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`e-mate-skill-hub:${fixture.schema}`])
    const began = performance.now()
    assert.equal((await call('/readyz')).status, 503)
    assert(performance.now() - began < 5000, 'readiness must not wait for the business write lock')
    assert.equal((await call('/livez')).status, 200)
  } finally { await writer.query('ROLLBACK'); writer.release() }
  for (const path of [`${prefix}/skills?limit=1`, `${prefix}/skills?query=ALPHA&tag=office`, `${prefix}/skills/alpha-skill?limit=1`, `${prefix}/publications/mine`]) {
    const old = await direct(fixture.source, path, {}, 'user-1')
    const current = await call(path)
    assert.equal(current.status, old.status)
    assert.deepEqual(await current.json(), await old.json())
  }
  const bytes = await call(`${prefix}/skills/alpha-skill/versions/1.0.0/package`)
  assert.equal(bytes.headers.get('x-skill-content-sha256'), fixture.alpha.package_sha256)
  assert.equal(sha256(new Uint8Array(await bytes.arrayBuffer())), (await inspectSnapshot(fixture.snapshotDirectory, fixture.source.AUTHOR_KEY)).objects
    .find((object) => object.customMetadata?.package_sha256 === fixture.alpha.package_sha256)?.customMetadata?.archive_sha256)
  const json = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  assert.equal((await call(`${prefix}/install-intents/consume`, json({ install_intent: fixture.installation.install_intent }), 'user-2', 'different-session')).status, 409)
  const claimed = await call(`${prefix}/install-intents/consume`, json({ install_intent: fixture.installation.install_intent }), 'user-2')
  assert.equal(claimed.status, 200)
  const claim = await claimed.json() as { completion_receipt: string }
  const complete = () => call(`${prefix}/install-intents/complete`, json({ completion_receipt: claim.completion_receipt, status: 'installed' }), 'user-2')
  assert.equal((await complete()).status, 200)
  assert.equal((await complete()).status, 200)
  assert.equal((await call(`${prefix}/install-intents/reconcile`, json({ completion_receipt: claim.completion_receipt }), 'user-2')).status, 200)
  const publish = (user: string) => call(`${prefix}/skills`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: publicationBody(skill('race-skill', '1.0.0'), 'race-skill', 'third_party', 'publish:race-request') }, user)
  assert.deepEqual((await Promise.all([publish('user-1'), publish('user-1')])).map(({ status }) => status), [201, 201])
  assert.equal((await publish('user-2')).status, 409)
  const bad = await service.fetch(new Request(`https://hub.example${prefix}/skills`, { headers: { authorization: `Bearer ${gateway.token().slice(0, -3)}bad` } }))
  assert.equal(bad.status, 401)
  const generation = (await pool!.query(`SELECT generation FROM "${fixture.schema}".skill_hub_control`)).rows[0].generation as string
  const archive = join(fixture.volume, 'generations', generation, fixture.alpha.package_sha256, 'archive.zip')
  const corrupted = Buffer.from(await readFile(archive)); corrupted[0] = 0
  await writeFile(archive, corrupted)
  assert((await call(`${prefix}/skills/alpha-skill/versions/1.0.0/package`)).status >= 500)
})

test('CAS fails closed on disk budget, never replaces an existing package and verifies download bytes', async (t) => {
  const fixture = await snapshotFixture(t)
  const snapshot = await inspectSnapshot(fixture.snapshotDirectory, fixture.source.AUTHOR_KEY)
  const object = snapshot.objects[0]!
  const bytes = await readFile(join(fixture.snapshotDirectory, object.key))
  const full = new FilePackages(join(fixture.directory, 'full'), Number.MAX_SAFE_INTEGER)
  await full.initialize()
  await assert.rejects(full.put(object.key, bytes, object), /full/)
  assert.equal((await full.list()).objects.length, 0)
  const files = new FilePackages(join(fixture.directory, 'cas'), 0)
  await files.initialize()
  await Promise.all([files.put(object.key, bytes, object), files.put(object.key, bytes, object)])
  assert.equal((await files.list()).objects.length, 1)
  assert.deepEqual((await files.get(object.key))?.customMetadata, object.customMetadata)
})

test('SQL adapter keeps placeholders out of literals and retains SQLite-compatible ASCII search', () => {
  assert.equal(postgresQuery("SELECT '?' AS literal WHERE ? IS NULL OR v.title LIKE ?"), "SELECT '?' AS literal WHERE CAST($1 AS TEXT) IS NULL OR v.title ILIKE $2")
  assert.equal(postgresQuery('INSERT OR IGNORE INTO skill_hub_skills(slug,latest_version) VALUES (?,?)'), 'INSERT INTO skill_hub_skills(slug,latest_version) VALUES ($1,$2) ON CONFLICT DO NOTHING')
  assert.equal(postgresQuery('SELECT 1 WHERE changes()=1', 0), 'SELECT 1 WHERE 0=1')
})

test('one readiness probe stays outside the four business slots and liveness requires no storage', async () => {
  let connections = 0
  let rejectConnection!: (error: Error) => void
  const connection = new Promise<PoolClient>((_resolve, reject) => { rejectConnection = reject })
  const fixturePool = { idleCount: 1, totalCount: 1, options: { max: 4 }, connect() { connections++; return connection } } as unknown as Pool
  const service = createService({ pool: fixturePool, schema: 'sh_probe_test', volume: '/unused', authorKey: 'synthetic-key'.repeat(4),
    validationUrl: 'http://model-gateway:8080/v1/consents/current' })
  const probe = service.fetch(new Request('http://hub/readyz'))
  assert.equal((await service.fetch(new Request('http://hub/readyz'))).status, 503)
  const business = Array.from({ length: 4 }, () => service.fetch(new Request(`http://hub${prefix}/skills`)))
  assert.equal(connections, 5)
  assert.equal((await service.fetch(new Request('http://hub/livez'))).status, 200)
  rejectConnection(new Error('synthetic unavailable storage'))
  assert((await Promise.all([probe, ...business])).every((response) => response.status === 503))
})

test('the real HTTP listener rejects declared and chunked oversized bodies and shuts down idempotently', async (t) => {
  const fixture = await snapshotFixture(t)
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  assert(address && typeof address === 'object')
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const running = await start({ SKILL_HUB_DATABASE_URL: databaseUrl ?? 'postgresql://postgres@127.0.0.1:1/unavailable',
    SKILL_HUB_AUTHOR_KEY: fixture.source.AUTHOR_KEY, SKILL_HUB_SCHEMA: fixture.schema,
    SKILL_HUB_VOLUME: fixture.volume, SKILL_HUB_MODEL_VALIDATION_URL: 'http://127.0.0.1:1/v1/consents/current',
    SKILL_HUB_PORT: String(address.port) })
  t.after(running.shutdown)
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/livez`)).status, 200)
  let resolveAdmitted!: () => void
  const admitted = new Promise<void>((resolve) => { resolveAdmitted = resolve })
  let holding = 0
  const observe = (request: import('node:http').IncomingMessage) => {
    if (request.headers['x-test-held'] === 'true' && ++holding === 4) resolveAdmitted()
  }
  running.server.on('request', observe)
  const held = Array.from({ length: 4 }, () => {
    const request = httpRequest({ host: '127.0.0.1', port: address.port, path: `${prefix}/skills`, method: 'POST',
      headers: { 'x-test-held': 'true', 'transfer-encoding': 'chunked' } })
    request.on('error', () => {})
    request.write(' ')
    return request
  })
  try {
    await admitted
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/livez`)).status, 200)
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/readyz`)).status, 503)
  } finally {
    running.server.off('request', observe)
    await Promise.all(held.map((request) => new Promise<void>((resolve) => { request.once('close', resolve); request.destroy() })))
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  for (const chunked of [false, true]) {
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port: address.port, path: `${prefix}/skills`, method: 'POST',
        headers: { 'content-type': 'application/json', ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': String(MAX_BODY_BYTES + 1) }) } }, (response) => {
        let body = ''
        response.on('data', (chunk) => { body += chunk.toString() })
        response.on('end', () => resolve({ status: response.statusCode!, body }))
      })
      request.on('error', reject)
      request.end(chunked ? Buffer.alloc(MAX_BODY_BYTES + 1, 32) : undefined)
    })
    assert.equal(response.status, 413)
    assert.equal(JSON.parse(response.body).error.code, 'bad-request')
  }
  await Promise.all([running.shutdown(), running.shutdown()])
})
