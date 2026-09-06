import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { handleRequest } from '../../skill-hub-worker/src/core.ts'
import { environment, request, activeSession, publicationBody, skill } from '../../skill-hub-worker/tests/fixtures.mjs'
import { TABLES } from '../src/postgres.ts'

test('D1 hold rejects late writes and conflict clauses; pre-cutover thaw preserves history guards', async () => {
  const env = environment()
  const db = env.DB.database
  const base = '/ecorex-agent/client/skill-hub/v1'
  const call = (path: string, options: object) => handleRequest(request(base + path, options), env, activeSession)
  try {
    const published = await call('/skills', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: publicationBody(skill('hold-test', '1.0.0'), 'hold-test') })
    assert.equal(published.status, 201)
    const card = await published.json()
    assert.equal((await call('/skills/hold-test/versions/1.0.0/install-intent', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ package_sha256: card.package_sha256, client_request_id: 'hold:intent-0001' }),
    })).status, 200)
    assert.equal((await call('/skills/hold-test/versions/1.0.0', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ package_sha256: card.package_sha256, client_request_id: 'hold:delete-0001' }),
    })).status, 200)
    const snapshot = () => TABLES.map(table => db.prepare(`SELECT * FROM ${table}`).all())
    const before = snapshot()
    assert(before.every(rows => rows.length > 0))
    db.exec(readFileSync(new URL('../../../deploy/skill-hub-freeze-d1.sql', import.meta.url), 'utf8'))
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND name GLOB 'emate218_hold_*'").get().n, 18)
    for (const table of TABLES) {
      const row = db.prepare(`SELECT * FROM ${table} LIMIT 1`).get()
      const columns = Object.keys(row)
      const values = columns.map(column => row[column])
      const insert = `INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      for (const verb of ['INSERT', 'INSERT OR IGNORE', 'INSERT OR REPLACE']) {
        assert.throws(() => db.prepare(`${verb} ${insert}`).run(...values), /EM218_MIGRATION_HOLD/)
      }
      assert.throws(() => db.exec(`UPDATE ${table} SET ${columns[0]}=${columns[0]}`), /EM218_MIGRATION_HOLD/)
      assert.throws(() => db.exec(`DELETE FROM ${table}`), /EM218_MIGRATION_HOLD/)
    }
    assert.deepEqual(snapshot(), before)
    db.exec(readFileSync(new URL('../../../deploy/skill-hub-thaw-d1-before-cutover.sql', import.meta.url), 'utf8'))
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND name GLOB 'emate218_hold_*'").get().n, 0)
    assert.doesNotThrow(() => db.exec('UPDATE skill_hub_skills SET latest_version=latest_version'))
    assert.throws(() => db.exec('DELETE FROM skill_hub_versions'), /immutable/)
    assert.deepEqual(snapshot(), before)
  } finally { db.close() }
})
