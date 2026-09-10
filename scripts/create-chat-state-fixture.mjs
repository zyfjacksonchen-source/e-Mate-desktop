import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Context } from '../upstream/deepseek-harness/vendor/cordis/lib/index.js'
import SessionStore, { SESSION_FORMAT_VERSION } from '../upstream/deepseek-harness/packages/core/session/lib/index.js'
import JsonlSessionPersistence from '../upstream/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'

const DEFAULT_SESSION_ID = 'e-mate-chat-states-v1'
const BASE_TIME = Date.UTC(2026, 0, 2)
const RUNTIME_TAIL_TYPES = new Set([
  'approval/policy',
  'permission/preset',
  'sandbox/mode',
  'session/end-seed',
])

const STATES = [
  { key: 'completed', label: '任务已完成', reason: { kind: 'completed' }, isError: false },
  {
    key: 'failed', label: '任务执行失败', isError: true,
    error: { name: 'AcceptanceToolError', code: 'ACCEPTANCE_TOOL_FAILURE' },
    reason: { kind: 'error', error: { message: '受控验收失败', code: 'ACCEPTANCE_UPSTREAM_FAILURE' } },
  },
  {
    key: 'blocked', label: '任务被策略阻塞', isError: true,
    error: { name: 'PolicyBlockedError', code: 'POLICY_BLOCKED' },
    reason: { kind: 'blocked' },
  },
  {
    key: 'cancelled', label: '任务由用户取消', isError: true,
    error: { name: 'AbortError', code: 'ABORTED' },
    reason: { kind: 'aborted', reason: { kind: 'user' } },
  },
  {
    key: 'interrupted', label: '任务因进程中断', isError: true,
    error: { name: 'ToolInterruptedError', code: 'TOOL_OUTCOME_UNKNOWN' },
    reason: { kind: 'interrupted' },
  },
  { key: 'max-tokens', label: '任务达到输出上限', reason: { kind: 'max-tokens' }, isError: false },
]

function message(id, role, content, source) {
  return { id, role, content, source }
}

function fixtureEvents() {
  const events = []
  const push = (type, data, options = {}) => {
    const seq = events.length
    events.push({ type, seq, time: BASE_TIME + seq * 1_000, data, ...options })
    return seq
  }

  for (const [index, state] of STATES.entries()) {
    const turn = index + 1
    const step = 1
    const callId = `chat-state-${state.key}`
    push('turn/start', { turn })
    push('user/message', message(
      `chat-state-user-${state.key}`,
      'user',
      [{ type: 'text', text: `Computer Use 验收：${state.label}` }],
      { kind: 'user' },
    ), { surfaceOp: 'append' })
    push('step/start', { turn, step })
    push('assistant/message', {
      turn,
      step,
      message: message(
        `chat-state-tool-request-${state.key}`,
        'assistant',
        [{ type: 'tool-call', id: callId, name: 'acceptance_fixture', arguments: JSON.stringify({ state: state.key }) }],
        { kind: 'model', provider: 'acceptance-fixture', model: 'acceptance-fixture' },
      ),
    }, { surfaceOp: 'append' })
    const callSeq = push('tool/call', {
      turn,
      step,
      callId,
      name: 'acceptance_fixture',
      arguments: JSON.stringify({ state: state.key }),
    })
    push('tool/result', {
      turn,
      step,
      message: message(
        `chat-state-tool-result-${state.key}`,
        'user',
        [{
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: state.isError ? `${state.label}：真实失败结果` : `${state.label}：真实成功结果` }],
          isError: state.isError,
        }],
        { kind: 'tool', callId },
      ),
      ...(state.error === undefined ? {} : { error: state.error }),
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    if (!state.isError) {
      push('assistant/message', {
        turn,
        step,
        message: message(
          `chat-state-assistant-${state.key}`,
          'assistant',
          [{ type: 'text', text: state.key === 'max-tokens' ? '输出到这里达到模型上限…' : '任务已按真实事件完成。' }],
          { kind: 'model', provider: 'acceptance-fixture', model: 'acceptance-fixture' },
        ),
      }, { surfaceOp: 'append' })
    }
    push('step/end', { turn, step })
    push('turn/end', { turn, reason: state.reason })
  }
  return events
}

function digest(events) {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex')
}

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    cwd: { type: 'string' },
    'session-id': { type: 'string' },
  },
  strict: true,
})
if (values.root === undefined) throw new Error('--root is required')
const sessionId = values['session-id'] ?? DEFAULT_SESSION_ID
if (!/^[a-zA-Z0-9._-]+$/.test(sessionId)) throw new Error('--session-id contains unsupported characters')

const root = resolve(values.root)
const cwd = resolve(values.cwd ?? process.cwd())
const events = fixtureEvents()
const expectedDigest = digest(events)
const ctx = new Context()
const sessionFiber = await ctx.plugin(SessionStore)
const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })

try {
  const existing = (await ctx.sessionPersistence.list()).find(item => item.id === sessionId)
  if (existing === undefined) {
    // 0.1.5 encodes only the current Session format, its header validator
    // requires the seeded flag rc.7 derived, and the returned handle owns the
    // append/flush/close lifecycle instead of a persistence-level append.
    const handle = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: BASE_TIME, cwd, isSeeded: false,
    })
    try {
      await handle.append(events)
      await handle.flush()
    } finally {
      await handle.close()
    }
  }
  const inspected = await ctx.sessionPersistence.inspect(sessionId)
  const fixture = inspected.events.slice(0, events.length)
  const observedDigest = digest(fixture)
  if (fixture.length !== events.length || observedDigest !== expectedDigest) {
    throw new Error(`existing ${sessionId} does not match the fixed chat-state fixture`)
  }
  const runtimeTail = inspected.events.slice(events.length)
  const invalidTail = runtimeTail.find((event, index) =>
    event.seq !== events.length + index || !RUNTIME_TAIL_TYPES.has(event.type))
  if (invalidTail !== undefined) {
    throw new Error(`existing ${sessionId} has a non-runtime tail event ${String(invalidTail.type)} at ${String(invalidTail.seq)}`)
  }
  process.stdout.write(`${JSON.stringify({
    schema_version: 1,
    session_id: sessionId,
    event_count: events.length,
    events_sha256: observedDigest,
    states: STATES.map((state, index) => ({ turn: index + 1, key: state.key, reason: state.reason.kind })),
    runtime_tail_event_count: runtimeTail.length,
    root,
    cwd,
    reused: existing !== undefined,
  })}\n`)
} finally {
  await persistenceFiber.dispose()
  await sessionFiber.dispose()
  await ctx.fiber.dispose()
}
