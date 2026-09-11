import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(root, '../..')

test('projects real native Schedule events without owning execution or storage', async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'e-mate-schedules-'))
  t.after(() => { rmSync(temporary, { recursive: true, force: true }) })
  const component = join(temporary, 'node_modules', '@e-mate', 'dsh-plugin-schedules')
  mkdirSync(join(component, 'lib'), { recursive: true })
  cpSync(join(root, 'lib', 'index.js'), join(component, 'lib', 'index.js'))
  cpSync(join(root, 'package.json'), join(component, 'package.json'))
  const deepseek = join(temporary, 'node_modules', '@deepseek-ai')
  mkdirSync(deepseek, { recursive: true })
  symlinkSync(join(repository, 'upstream', 'deepseek-harness', 'packages', 'schedule', 'schedule'), join(deepseek, 'dsh-schedule'), 'dir')
  const { apply, SCHEDULES_CHANNEL } = await import(pathToFileURL(join(component, 'lib', 'index.js')).href)
  // 0.1.5 moved the RPC envelope schema from host/apiproxy's api/rpc.schema to client/connection.
  const { serverResponseSchema } = await import(pathToFileURL(join(
    repository, 'upstream', 'deepseek-harness', 'packages', 'client', 'connection', 'src', 'rpc-schema.ts',
  )).href)
  let route
  let inspectCount = 0
  let listFailure
  let sessionPersistence
  apply({
    connection: { rpc: { handle: (channel, handler, options) => {
      route = { channel, handler, options }
      return () => {}
    } } },
    sessionPersistence: sessionPersistence = {
      listSnapshots: async () => {
        if (listFailure !== undefined) throw listFailure
        return [
          { header: { id: 'session-1' }, revision: 'revision-1' },
          { header: { id: 'session-bad' }, revision: 'revision-bad' },
        ]
      },
      inspect: async id => {
        inspectCount += 1
        if (String(id) === 'session-bad') throw new Error('corrupt session')
        return {
          meta: { cwd: '/tmp/project', seedLength: 0 },
          events: [
            { type: 'session/title', seq: 0, time: 1, data: { title: '日报会话' } },
            { type: 'schedule/change', seq: 1, time: 1, data: { version: 1, operation: 'create', schedule: {
              id: 'schedule-1', kind: 'every', prompt: '生成日报', everySeconds: 3600,
              scheduledAt: '2099-08-19T12:00:00.000Z',
            } } },
            { type: 'schedule/change', seq: 2, time: 2, data: {
              version: 1, operation: 'dispatch', id: 'schedule-1', acceptedAt: '2099-08-19T12:00:01.000Z',
            } },
            { type: 'schedule/change', seq: 3, time: 3, data: { version: 1, operation: 'create', schedule: {
              id: 'schedule-2', kind: 'at', prompt: '提交周报', scheduledAt: '2026-08-19T12:00:00.000Z',
            } } },
            { type: 'schedule/change', seq: 4, time: Date.parse('2026-08-19T12:00:01.000Z'), data: {
              version: 1, operation: 'dispatch', id: 'schedule-2',
            } },
            { type: 'schedule/change', seq: 5, time: 5, data: { version: 1, operation: 'create', schedule: {
              id: 'schedule-3', kind: 'at', prompt: '逾期提醒', scheduledAt: '2020-08-19T12:00:00.000Z',
            } } },
            { type: 'schedule/change', seq: 6, time: 6, data: { version: 1, operation: 'create', schedule: {
              id: 'schedule-4', kind: 'after', prompt: '检查交付', afterSeconds: 600,
              scheduledAt: '2099-08-19T14:00:00.000Z',
            } } },
            { type: 'schedule/change', seq: 7, time: 7, data: { version: 1, operation: 'create', schedule: {
              id: 'schedule-5', kind: 'at', prompt: '取消提醒', scheduledAt: '2099-08-20T12:00:00.000Z',
            } } },
            { type: 'schedule/change', seq: 8, time: 8, data: {
              version: 1, operation: 'delete', id: 'schedule-5',
            } },
          ],
        }
      },
    },
    effect: callback => callback(),
  })
  assert.equal(route.channel, SCHEDULES_CHANNEL)
  assert.deepEqual(route.options, { authority: 'loopback' })
  const first = await route.handler('list', {})
  assert.equal(first.ok, true)
  assert.deepEqual(first.value.errors, [{ session_id: 'session-bad', message: '该会话的定时任务日志无法读取。' }])
  assert.deepEqual(first.value.items.find(item => item.id === 'schedule-1'), {
    session_id: 'session-1', session_title: '日报会话', id: 'schedule-1', kind: 'every',
    prompt: '生成日报', everySeconds: 3600, scheduledAt: '2099-08-19T13:00:00.000Z',
    state: 'scheduled', deliveryMode: 'session-local',
  })
  assert.equal(first.value.items.find(item => item.id === 'schedule-3').state, 'overdue')
  assert.deepEqual(first.value.items.find(item => item.id === 'schedule-4'), {
    session_id: 'session-1', session_title: '日报会话', id: 'schedule-4', kind: 'after',
    prompt: '检查交付', afterSeconds: 600, scheduledAt: '2099-08-19T14:00:00.000Z',
    state: 'scheduled', deliveryMode: 'session-local',
  })
  assert.equal(first.value.items.some(item => item.id === 'schedule-5'), false)
  assert.deepEqual(first.value.completed, [{
    session_id: 'session-1', session_title: '日报会话', id: 'schedule-2', kind: 'at',
    prompt: '提交周报', scheduledAt: '2026-08-19T12:00:00.000Z', state: 'completed',
    deliveryMode: 'session-local', completedAt: '2026-08-19T12:00:01.000Z',
  }])
  assert.deepEqual(first.value.recent_runs, [{
    session_id: 'session-1', session_title: '日报会话', id: 'schedule-1', kind: 'every',
    prompt: '生成日报', everySeconds: 3600, scheduledAt: '2099-08-19T12:00:00.000Z',
    ranAt: '2099-08-19T12:00:01.000Z',
  }, {
    session_id: 'session-1', session_title: '日报会话', id: 'schedule-2', kind: 'at',
    prompt: '提交周报', scheduledAt: '2026-08-19T12:00:00.000Z', ranAt: '2026-08-19T12:00:01.000Z',
  }])
  const badRequest = await route.handler('unknown', {})
  assert.deepEqual(badRequest, {
    ok: false,
    error: { code: 'bad-request', message: 'unknown e-Mate schedules endpoint', details: { issues: [] } },
  })
  assert.doesNotThrow(() => serverResponseSchema.parse({
    type: 'server-response', rpcId: 'schedule-bad-request', result: badRequest,
  }))
  const second = await route.handler('list', {})
  assert.deepEqual(second.value.errors, [{ session_id: 'session-bad', message: '该会话的定时任务日志无法读取。' }])
  assert.equal(inspectCount, 3)

  apply({
    connection: { rpc: { handle: (channel, handler, options) => {
      route = { channel, handler, options }
      return () => {}
    } } },
    sessionPersistence,
    effect: callback => callback(),
  })
  const restarted = await route.handler('list', {})
  assert.deepEqual(restarted.value, first.value)
  assert.equal(inspectCount, 5)

  listFailure = new Error('private persistence path /Users/example/.dsh/session.jsonl')
  const internal = await route.handler('list', {})
  assert.deepEqual(internal, {
    ok: false,
    error: { code: 'internal', message: '定时任务暂时无法读取。', details: {} },
  })
  assert.doesNotMatch(JSON.stringify(internal), /private persistence|\/Users\/example|session\.jsonl/u)
  assert.doesNotThrow(() => serverResponseSchema.parse({
    type: 'server-response', rpcId: 'schedule-internal', result: internal,
  }))

  const source = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  assert.match(source, /from '@deepseek-ai\/dsh-schedule'/u)
  assert.match(source, /decodeScheduleChange/u)
  assert.match(source, /resolveEveryOccurrence/u)
  assert.doesNotMatch(source, /setInterval|setTimeout|schedule_create|schedule_delete/u)
})
