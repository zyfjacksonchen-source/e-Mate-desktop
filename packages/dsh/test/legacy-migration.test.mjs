import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { createServer } from 'node:http'
import { Context } from '../../../upstream/deepseek-harness/vendor/cordis/lib/index.js'
import SessionStore from '../../../upstream/deepseek-harness/packages/core/session/lib/index.js'
import JsonlSessionPersistence from '../../../upstream/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import Storage from '../../../upstream/deepseek-harness/packages/storage/storage/lib/index.js'
import { DomainFacility } from '../../../upstream/deepseek-harness/packages/storage/storage-domain/lib/index.js'
import { JsonStorageBackend } from '../../../upstream/deepseek-harness/packages/storage/storage-json/lib/index.js'
import WorkspaceRegistry from '../../../upstream/deepseek-harness/packages/workspace/workspace/lib/index.js'
import { sessionFormatCatalog } from '../../../upstream/deepseek-harness/packages/session/session-format-catalog/lib/index.js'
import { defaultLegacySources, migrateLegacySessions } from '../lib/legacy-migration.js'
import { registerLegacyArtifactDownload, runOptionalLegacyMigration } from '../profile/plugins/legacy-migration.js'
import { apply as applyGeneralWorkspace } from '../profile/plugins/general-workspace.js'

const temporary = []

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

function scratch() {
  const path = mkdtempSync(join(tmpdir(), 'e-mate-legacy-test-'))
  temporary.push(path)
  return path
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function harnessPersistence(root) {
  const ctx = new Context()
  const sessionsFiber = await ctx.plugin(SessionStore)
  const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return {
    ctx,
    async dispose() {
      await persistenceFiber.dispose()
      await sessionsFiber.dispose()
    },
  }
}

const CURRENT_HEADER = { version: 3, isSeeded: false, delegationDepth: 0 }

// A current session must be flushed before its handle closes, or the backend
// forgets a session that never materialized and list() silently loses it.
async function createCurrentSession(sessionPersistence, header) {
  const handle = await sessionPersistence.create({ ...CURRENT_HEADER, ...header })
  await handle.flush()
  await handle.close()
}

async function readCurrentSession(sessionPersistence, id) {
  const handle = await sessionPersistence.open(id, 'read')
  try {
    const { events } = await handle.read()
    return { meta: handle.header, events }
  } finally {
    await handle.close()
  }
}

// Harness surface vocabulary: the v2->v3 migration refuses any of these that precedes the
// stream's first step/start (packages/session/session-format-v2-to-v3/src/migration.ts:56),
// and every native v0 record in the user store opens its step before its first surface event.
const SURFACE_EVENT_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

function firstSurfaceBeforeStep(events) {
  let opened = false
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].type === 'step/start') opened = true
    else if (SURFACE_EVENT_TYPES.has(events[index].type) && !opened) return index
  }
  return -1
}

// Replay imported rows through the shipped released-v0 -> v3 catalog: the same migration chain
// the Session reader runs for a stored v0 artifact.
function restoreReleasedV0Rows(header, events) {
  const restore = sessionFormatCatalog.createRestore(
    { type: 'session', version: 0, id: header.id, createdAt: header.createdAt, cwd: header.cwd, delegationDepth: header.delegationDepth },
    { recovery: 'strict', validation: 'current' },
  )
  for (const event of events) restore.decodeRow(event)
  return restore.finish()
}

function cowDatabase(path, projectPath, artifactPath) {
  const database = new DatabaseSync(path)
  database.exec(`
    CREATE TABLE sessions (
      session_id TEXT NOT NULL,
      title TEXT,
      project_path TEXT,
      created_at INTEGER NOT NULL,
      last_active INTEGER NOT NULL
    );
    CREATE TABLE messages (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      extras TEXT,
      created_at INTEGER NOT NULL
    );
  `)
  database.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)')
    .run('cow-session', '旧会话', projectPath, 1_700_000_000, 1_700_000_003)
  database.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)')
    .run('cow-session', 1, 'user', JSON.stringify({ text: '你好' }), '{}', 1_700_000_001)
  database.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      'cow-session',
      2,
      'assistant',
      JSON.stringify([{ text: '你好，我是 e-Mate' }]),
      artifactPath === undefined ? '{}' : JSON.stringify({
        artifacts: [
          { path: artifactPath, title: '报告.docx', status: 'ready', intent: 'deliverable' },
          { path: join(artifactPath, '..', 'missing.docx'), title: '缺失.docx', status: 'ready', intent: 'deliverable' },
        ],
      }),
      1_700_000_002,
    )
  database.close()
}

function runtimeDatabase(path, projectPath) {
  const artifactBytes = Buffer.from('legacy runtime PDF bytes')
  const artifactDigest = createHash('sha256').update(artifactBytes).digest('hex')
  const artifactPath = join(
    dirname(path),
    'artifacts',
    'blobs',
    artifactDigest.slice(0, 2),
    artifactDigest.slice(2, 4),
    artifactDigest,
  )
  mkdirSync(dirname(artifactPath), { recursive: true })
  writeFileSync(artifactPath, artifactBytes)
  const database = new DatabaseSync(path)
  database.exec(`
    CREATE TABLE threads (
      thread_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      title TEXT,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE turns (
      turn_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_text TEXT NOT NULL,
      agent_model_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE items (
      item_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE projects (project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL);
    CREATE TABLE project_thread_bindings (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
  `)
  const insertThread = database.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)')
  insertThread.run('active-thread', 'active', '运行态会话', '{}', '2026-08-01T00:00:00Z', '2026-08-01T00:00:03Z')
  insertThread.run('deleted-thread', 'deleted', '已删除', '{}', '2026-08-01T00:00:00Z', '2026-08-01T00:00:03Z')
  database.prepare('INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('turn-1', 'active-thread', 'completed', '生成报告', 'ecorex-chat', '2026-08-01T00:00:01Z', '2026-08-01T00:00:03Z')
  const insertItem = database.prepare('INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?)')
  insertItem.run('assistant-1', 'active-thread', 'turn-1', 'message', 'completed', JSON.stringify({ role: 'assistant', text: '报告已生成' }), '2026-08-01T00:00:02Z')
  insertItem.run('tool-1', 'active-thread', 'turn-1', 'tool_call', 'completed', JSON.stringify({ name: 'legacy_tool', arguments: '{}' }), '2026-08-01T00:00:02Z')
  insertItem.run('runtime-artifact', 'active-thread', 'turn-1', 'artifact', 'completed', JSON.stringify({
    artifact: {
      role: 'deliverable',
      status: 'ready',
      display_name: 'runtime.pdf',
      mime_type: 'application/pdf',
      size_bytes: artifactBytes.byteLength,
      sha256: artifactDigest,
    },
  }), '2026-08-01T00:00:02Z')
  database.prepare('INSERT INTO projects VALUES (?, ?)').run('project-1', projectPath)
  database.prepare('INSERT INTO project_thread_bindings VALUES (?, ?)').run('active-thread', 'project-1')
  database.close()
  return { artifactDigest, artifactPath }
}

test('default legacy discovery resolves candidate roots without Array.map callback arguments', () => {
  const root = scratch()
  assert.deepEqual(defaultLegacySources({
    dshHome: join(root, 'dsh'),
    home: join(root, 'home'),
    environment: {},
    platform: 'darwin',
  }), [])
})

test('an optional legacy source disappearing after discovery is a bounded no-op', async () => {
  const root = scratch()
  const sourceRoot = join(root, 'cow')
  const dshHome = join(root, 'dsh')
  const source = join(sourceRoot, 'conversations.db')
  const harness = await harnessPersistence(join(dshHome, 'sessions'))
  try {
    await createCurrentSession(harness.ctx.sessionPersistence, {
      id: 'current-session',
      createdAt: 1_700_000_000_000,
      cwd: join(root, 'current'),
    })
    const before = await harness.ctx.sessionPersistence.list()
    const result = await runOptionalLegacyMigration({
      sessionPersistence: harness.ctx.sessionPersistence,
      logger: { warn: assert.fail },
    }, {
      sessionPersistence: harness.ctx.sessionPersistence,
      dshHome,
      sources: [{ family: 'cowagent', root: sourceRoot, database: source }],
    })

    assert.equal(result.source_found, false)
    assert.equal(result.unavailable_sources, 1)
    assert.deepEqual(await harness.ctx.sessionPersistence.list(), before)
  } finally {
    await harness.dispose()
  }
})

test('a corrupt optional legacy source fails closed without leaking its path or changing current sessions', async () => {
  const root = scratch()
  const sourceRoot = join(root, 'cow-private')
  const dshHome = join(root, 'dsh')
  mkdirSync(sourceRoot)
  const source = join(sourceRoot, 'conversations.db')
  writeFileSync(source, 'not sqlite')
  const harness = await harnessPersistence(join(dshHome, 'sessions'))
  const warnings = []
  try {
    await createCurrentSession(harness.ctx.sessionPersistence, {
      id: 'current-session',
      createdAt: 1_700_000_000_000,
      cwd: join(root, 'current'),
    })
    const before = await harness.ctx.sessionPersistence.list()
    await assert.rejects(runOptionalLegacyMigration({
      sessionPersistence: harness.ctx.sessionPersistence,
      logger: { warn(...args) { warnings.push(args) } },
    }, {
      sessionPersistence: harness.ctx.sessionPersistence,
      dshHome,
      sources: [{ family: 'cowagent', root: sourceRoot, database: source }],
    }), error => error?.message === 'e-Mate legacy session migration rejected')

    assert.deepEqual(warnings, [[
      'e-Mate legacy session migration rejected; current sessions remain authoritative',
      { event: 'migration-rejected' },
    ]])
    assert.equal(JSON.stringify(warnings).includes(sourceRoot), false)
    assert.deepEqual(await harness.ctx.sessionPersistence.list(), before)
  } finally {
    await harness.dispose()
  }
})

test('imports CowAgent sessions through the real Harness SessionPersistence and replays idempotently', async () => {
  const root = scratch()
  const sourceRoot = join(root, 'cow')
  const dshHome = join(root, 'dsh')
  const project = join(root, 'project')
  mkdirSync(sourceRoot, { recursive: true })
  mkdirSync(project)
  const source = join(sourceRoot, 'conversations.db')
  const artifact = join(sourceRoot, 'outputs', 'report.docx')
  mkdirSync(join(sourceRoot, 'outputs'))
  writeFileSync(artifact, 'legacy office bytes')
  cowDatabase(source, project, artifact)
  const before = digest(source)
  const artifactDigest = digest(artifact)
  const harness = await harnessPersistence(join(dshHome, 'sessions'))
  const { ctx } = harness
  try {
    const options = {
      sessionPersistence: ctx.sessionPersistence,
      dshHome,
      sources: [{ family: 'cowagent', root: sourceRoot, database: source }],
    }
    const first = await migrateLegacySessions(options)
    assert.equal(first.imported_sessions, 1)
    assert.equal(first.reused_sessions, 0)
    const [snapshot] = await ctx.sessionPersistence.list()
    const header = snapshot.header
    assert.equal(header.cwd, project)
    const loaded = await readCurrentSession(ctx.sessionPersistence, header.id)
    assert.deepEqual(loaded.meta, {
      version: 3,
      id: header.id,
      createdAt: 1_700_000_000_000,
      cwd: project,
      isSeeded: false,
      delegationDepth: 0,
    })
    assert.deepEqual(loaded.events.map(event => event.type), [
      'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
      'emate/legacy-artifacts', 'session/title',
    ])
    assert.equal(loaded.events.find(event => event.type === 'assistant/message').data.message.content[0].text, '你好，我是 e-Mate')
    const artifactEvent = loaded.events.find(event => event.type === 'emate/legacy-artifacts')
    assert.equal(artifactEvent.data.items[0].artifact_id, `legacy-sha256:${artifactDigest}`)
    assert.deepEqual(artifactEvent.data.items[1], {
      status: 'unavailable',
      reason: 'missing-or-unsafe',
      kind: 'artifact',
      message_seq: '2',
      name: '缺失.docx',
    })
    const object = join(dshHome, 'e-mate', 'attachments', 'legacy-v1', 'objects', artifactDigest.slice(0, 2), artifactDigest.slice(2, 4), artifactDigest)
    assert.equal(readFileSync(object, 'utf8'), 'legacy office bytes')
    const second = await migrateLegacySessions(options)
    assert.equal(second.imported_sessions, 0)
    assert.equal(second.reused_sessions, 1)
    assert.equal((await ctx.sessionPersistence.list()).length, 1)
    assert.equal(digest(source), before)
    assert.equal(digest(artifact), artifactDigest)
  } finally {
    await harness.dispose()
  }
})

test('imports only non-deleted ECoreX Runtime threads and preserves tool history as evidence', async () => {
  const root = scratch()
  const sourceRoot = join(root, 'ECoreX')
  const dshHome = join(root, 'dsh')
  const project = join(root, 'project')
  mkdirSync(sourceRoot, { recursive: true })
  mkdirSync(project)
  const source = join(sourceRoot, 'runtime.sqlite3')
  const runtimeArtifact = runtimeDatabase(source, project)
  const before = digest(source)
  const harness = await harnessPersistence(join(dshHome, 'sessions'))
  const { ctx } = harness
  try {
    const result = await migrateLegacySessions({
      sessionPersistence: ctx.sessionPersistence,
      dshHome,
      sources: [{ family: 'ecorex-runtime', root: sourceRoot, database: source }],
    })
    assert.equal(result.imported_sessions, 1)
    const [snapshot] = await ctx.sessionPersistence.list()
    const header = snapshot.header
    assert.equal(header.cwd, project)
    const loaded = await readCurrentSession(ctx.sessionPersistence, header.id)
    assert.equal(loaded.events.some(event => event.type === 'tool/call'), false)
    assert.equal(
      loaded.events.find(event => event.type === 'emate/legacy-artifacts').data.items[0].artifact_id,
      `legacy-sha256:${runtimeArtifact.artifactDigest}`,
    )
    assert.equal(digest(runtimeArtifact.artifactPath), runtimeArtifact.artifactDigest)
    const evidence = JSON.parse(readFileSync(join(dshHome, 'e-mate', 'migrations', 'legacy-evidence-v1', `${header.id}.json`), 'utf8'))
    assert.equal(evidence.omitted_items.some(item => item.item_id === 'tool-1'), true)
    assert.equal(digest(source), before)
  } finally {
    await harness.dispose()
  }
})

test('real WorkspaceRegistry groups unprojected legacy sessions under managed general without crossing projects', async () => {
  const root = scratch()
  const dshHome = join(root, 'dsh')
  const general = join(dshHome, 'e-mate', 'general')
  const project = join(root, 'project')
  const cowRoot = join(root, 'cow')
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(general, { recursive: true })
  mkdirSync(project)
  mkdirSync(cowRoot)
  mkdirSync(runtimeRoot)
  const cowSource = join(cowRoot, 'conversations.db')
  const runtimeSource = join(runtimeRoot, 'runtime.sqlite3')
  cowDatabase(cowSource, null)
  runtimeDatabase(runtimeSource, project)
  const before = new Map([[cowSource, digest(cowSource)], [runtimeSource, digest(runtimeSource)]])
  const harness = await harnessPersistence(join(dshHome, 'sessions'))
  const { ctx } = harness
  let registryFiber
  let storageFiber
  let backend
  try {
    const options = {
      sessionPersistence: ctx.sessionPersistence,
      dshHome,
      sources: [
        { family: 'cowagent', root: cowRoot, database: cowSource },
        { family: 'ecorex-runtime', root: runtimeRoot, database: runtimeSource },
      ],
    }
    assert.deepEqual(
      await migrateLegacySessions(options).then(result => [result.imported_sessions, result.reused_sessions]),
      [2, 0],
    )
    assert.deepEqual(
      await migrateLegacySessions(options).then(result => [result.imported_sessions, result.reused_sessions]),
      [0, 2],
    )

    storageFiber = await ctx.plugin(Storage)
    backend = new JsonStorageBackend(join(dshHome, 'state'))
    ctx.storage.backend.register('json', backend)
    const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    registryFiber = await ctx.plugin(WorkspaceRegistry)
    await applyGeneralWorkspace(ctx, { dshHome })

    const headers = (await ctx.sessionPersistence.list()).map(snapshot => snapshot.header)
    const generalSession = headers.find(header => header.cwd === general)
    const projectSession = headers.find(header => header.cwd === project)
    assert.ok(generalSession)
    assert.ok(projectSession)
    const generalWorkspace = ctx.workspaceRegistry.list().find(workspace => workspace.path === realpathSync(general))
    const projectWorkspace = ctx.workspaceRegistry.list().find(workspace => workspace.path === realpathSync(project))
    assert.equal(generalWorkspace.title, '通用会话')
    assert.deepEqual(generalWorkspace.sessionIds, [generalSession.id])
    assert.deepEqual(projectWorkspace.sessionIds, [projectSession.id])
    assert.equal(generalWorkspace.sessionIds.includes(projectSession.id), false)
    assert.equal(projectWorkspace.sessionIds.includes(generalSession.id), false)
    for (const [path, sha256] of before) assert.equal(digest(path), sha256)
  } finally {
    await registryFiber?.dispose()
    await backend?.close()
    await storageFiber?.dispose()
    await harness.dispose()
  }
})

test('serves imported artifacts only by their verified content identity', async () => {
  const root = scratch()
  const dshHome = join(root, 'dsh')
  const content = Buffer.from('verified legacy artifact')
  const sha256 = createHash('sha256').update(content).digest('hex')
  const object = join(dshHome, 'e-mate', 'attachments', 'legacy-v1', 'objects', sha256.slice(0, 2), sha256.slice(2, 4), sha256)
  mkdirSync(dirname(object), { recursive: true })
  writeFileSync(object, content, { mode: 0o600 })
  let route
  registerLegacyArtifactDownload({ webServer: { register(value) { route = value; return () => {} } } }, dshHome)
  const server = createServer((request, response) => { route.handler(request, response) })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const base = `http://127.0.0.1:${server.address().port}${route.path}`
  try {
    const downloaded = await fetch(`${base}?id=${sha256}`)
    assert.equal(downloaded.status, 200)
    assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream')
    assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), content)
    const head = await fetch(`${base}?id=${sha256}`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(content.byteLength))
    assert.equal((await head.arrayBuffer()).byteLength, 0)
    assert.equal((await fetch(`${base}?id=bad`)).status, 400)
    assert.equal((await fetch(`${base}?id=${sha256}`, { method: 'POST' })).status, 405)
    writeFileSync(object, 'tampered')
    assert.equal((await fetch(`${base}?id=${sha256}`)).status, 404)
  } finally {
    await new Promise(resolveClose => server.close(resolveClose))
  }
})

test('fails closed before creating a Harness session when a source is not SQLite', async () => {
  const root = scratch()
  const sourceRoot = join(root, 'cow')
  const dshHome = join(root, 'dsh')
  mkdirSync(sourceRoot)
  const source = join(sourceRoot, 'conversations.db')
  writeFileSync(source, 'not sqlite')
  const harness = await harnessPersistence(join(dshHome, 'sessions'))
  const { ctx } = harness
  try {
    await assert.rejects(migrateLegacySessions({
      sessionPersistence: ctx.sessionPersistence,
      dshHome,
      sources: [{ family: 'cowagent', root: sourceRoot, database: source }],
    }))
    assert.deepEqual(await ctx.sessionPersistence.list(), [])
  } finally {
    await harness.dispose()
  }
})

test('validates every existing target identity before importing another source session', async () => {
  const root = scratch()
  const sourceRoot = join(root, 'cow')
  const dshHome = join(root, 'dsh')
  const project = join(root, 'project')
  mkdirSync(sourceRoot, { recursive: true })
  mkdirSync(project)
  const source = join(sourceRoot, 'conversations.db')
  cowDatabase(source, project)
  const harness = await harnessPersistence(join(dshHome, 'sessions'))
  const { ctx } = harness
  const options = {
    sessionPersistence: ctx.sessionPersistence,
    dshHome,
    sources: [{ family: 'cowagent', root: sourceRoot, database: source }],
  }
  try {
    await migrateLegacySessions(options)
    const [snapshot] = await ctx.sessionPersistence.list()
    const write = await ctx.sessionPersistence.open(snapshot.header.id, 'write')
    try {
      const nextSeq = (await write.read()).events.length
      await write.append([
        { type: 'turn/start', seq: nextSeq, time: 1_700_000_004_000, data: { turn: 2 } },
        { type: 'turn/end', seq: nextSeq + 1, time: 1_700_000_004_000, data: { turn: 2, reason: { kind: 'completed' } } },
      ])
    } finally {
      await write.close()
    }
    const database = new DatabaseSync(source)
    database.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)')
      .run('new-session', '新增会话', project, 1_700_000_010, 1_700_000_010)
    database.close()
    await assert.rejects(migrateLegacySessions(options), /conflicts with its stable legacy identity/)
    assert.equal((await ctx.sessionPersistence.list()).length, 1)
  } finally {
    await harness.dispose()
  }
})

test('opens a step before the first surface event of every imported session', async () => {
  const root = scratch()
  const dshHome = join(root, 'dsh')
  const project = join(root, 'project')
  const cowRoot = join(root, 'cow')
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(project)
  mkdirSync(cowRoot)
  mkdirSync(runtimeRoot)
  const cowSource = join(cowRoot, 'conversations.db')
  const runtimeSource = join(runtimeRoot, 'runtime.sqlite3')
  const artifact = join(cowRoot, 'outputs', 'report.docx')
  mkdirSync(join(cowRoot, 'outputs'))
  writeFileSync(artifact, 'legacy office bytes')
  cowDatabase(cowSource, project, artifact)
  runtimeDatabase(runtimeSource, project)
  const harness = await harnessPersistence(join(dshHome, 'sessions'))
  const { ctx } = harness
  try {
    const result = await migrateLegacySessions({
      sessionPersistence: ctx.sessionPersistence,
      dshHome,
      sources: [
        { family: 'cowagent', root: cowRoot, database: cowSource },
        { family: 'ecorex-runtime', root: runtimeRoot, database: runtimeSource },
      ],
    })
    assert.equal(result.imported_sessions, 2)
    for (const snapshot of await ctx.sessionPersistence.list()) {
      const { events } = await readCurrentSession(ctx.sessionPersistence, snapshot.header.id)
      const offending = firstSurfaceBeforeStep(events)
      assert.equal(
        offending,
        -1,
        `${snapshot.header.id}: ${events[offending]?.type} at ${offending} precedes the first step/start (${events.map(event => event.type).join(' ')})`,
      )
    }
  } finally {
    await harness.dispose()
  }
})

test('replays an imported session as released v0 without a surface before its step', async () => {
  const root = scratch()
  const sourceRoot = join(root, 'cow')
  const dshHome = join(root, 'dsh')
  const project = join(root, 'project')
  mkdirSync(sourceRoot, { recursive: true })
  mkdirSync(project)
  const source = join(sourceRoot, 'conversations.db')
  // No attachments: the emitted stream stays inside the released vocabulary a v0 reader admits,
  // so the shipped migration chain must restore it end to end.
  cowDatabase(source, project)
  const harness = await harnessPersistence(join(dshHome, 'sessions'))
  const { ctx } = harness
  try {
    await migrateLegacySessions({
      sessionPersistence: ctx.sessionPersistence,
      dshHome,
      sources: [{ family: 'cowagent', root: sourceRoot, database: source }],
    })
    const [snapshot] = await ctx.sessionPersistence.list()
    const { meta, events } = await readCurrentSession(ctx.sessionPersistence, snapshot.header.id)
    const offending = firstSurfaceBeforeStep(events)
    assert.equal(offending, -1, `${events[offending]?.type} at ${offending} precedes the first step/start`)
    const restored = restoreReleasedV0Rows(meta, events)
    assert.deepEqual(
      restored.events.map(event => event.type).filter(type => type === 'user/message' || type === 'assistant/message'),
      ['user/message', 'assistant/message'],
    )
  } finally {
    await harness.dispose()
  }
})
