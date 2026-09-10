// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-api-session-controller/client'
import { InputTriggerController } from '../../../../../../upstream/deepseek-harness/packages/client/ui-input-trigger/src/client/controller.ts'
import { SessionInputShell } from '../../../../../../upstream/deepseek-harness/packages/client/ui-conversation/src/client/input/facade.ts'
import { deriveDecorations } from '../../../../../../upstream/deepseek-harness/packages/client/ui-conversation/src/client/input/decorations.ts'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { openMentionMenu, registerComputerUseTrigger, registerMentionSources } from '../src/client/composer-mentions.ts'

afterEach(() => { delete document.body.dataset.dshDesktopPlatform; vi.restoreAllMocks() })

describe('native e-Mate @ references', () => {
  it('waits for the native command Remote used by the Plan action', () => {
    expect(readFileSync('src/client/index.ts', 'utf8'))
      .toMatch(/export const inject = \[[^\]]*'remote\.commands'[^\]]*\]/u)
  })

  it('keeps the naked @ roster ordered with Goal and Plan as native command actions', async () => {
    const sources: InputTriggerSource[] = []
    const listSkills = vi.fn(async () => ({ result: { ok: true, value: { skills: [] } } }))
    const execute = vi.fn(async (): Promise<any> => ({ ok: true, value: { result: { kind: 'success', text: 'Plan mode on.' } } }))
    let snapshot: { draft: string; draftRev: number; phase: 'plain' | 'claimed' } = {
      draft: '@', draftRev: 1, phase: 'plain',
    }
    const setDraft = vi.fn((draft: string) => { snapshot = { ...snapshot, draft, draftRev: snapshot.draftRev + 1 } })
    const notify = vi.fn()
    const submit = vi.fn()
    const claim = {
      token: '/goal ',
      hint: '目标内容',
      submit: vi.fn(async () => ({ kind: 'success' as const })),
    }
    const bail = vi.fn((_scope, event: string, request: any) => {
      if (event === 'slash/input-begin-command') {
        if (request.span.draftRev !== snapshot.draftRev) return undefined
        const { start, end } = request.span
        snapshot = {
          draft: snapshot.draft.slice(0, start) + request.claim.token + snapshot.draft.slice(end),
          draftRev: snapshot.draftRev + 1,
          phase: 'claimed',
        }
        return true
      }
      if (event !== 'slash/input-consume-token' || request.guard.span.draftRev !== snapshot.draftRev) return undefined
      const { start, end } = request.guard.span
      if (snapshot.draft.slice(start, end) !== '@') return undefined
      snapshot = { ...snapshot, draft: snapshot.draft.slice(0, start) + snapshot.draft.slice(end), draftRev: snapshot.draftRev + 1 }
      return true
    })
    const scope = { bail }
    const track = vi.fn()
    const onSpace = vi.fn(() => false)
    const adjudicate = vi.fn(async () => ({ claim }))
    const binding = vi.fn(() => { throw new Error('Goal and Plan actions must not read projections') })
    const ctx = {
      effect(run: () => () => void) { return run() },
      inputTriggers: {
        registerSource(source: InputTriggerSource) { sources.push(source); return () => {} },
        sessionOf: () => ({ track, onSpace, adjudicate }),
      },
      sessions: { binding, scope: () => scope },
      conversation: { input: { for: () => ({ state: { getSnapshot: () => snapshot }, setDraft, notify, actions: { submit } }) } },
      remote: { commands: { execute } },
      connection: {
        rpc: { call: vi.fn(async () => ({ ok: true, value: { schema_version: 1, items: [] } })) },
        api: { skills: { list: listSkills } },
      },
      logger: { warn: vi.fn() },
    }

    registerComputerUseTrigger(ctx)
    registerMentionSources(ctx)
    const roster = [{ name: '文件', order: -30 }, ...sources]
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
      .map(source => source.name)
    expect(roster).toEqual(['文件', '目标', '计划', '电脑操控', 'Skill'])

    const signal = new AbortController().signal
    const request = { query: '', position: 'inline' as const, signal }
    const session = { sessionId: 'session-1' as never }
    const goal = sources.find(source => source.name === '目标')!
    const plan = sources.find(source => source.name === '计划')!
    const skill = sources.find(source => source.name === 'Skill')!
    const goalAction = (await goal.candidates(session, request))[0]!
    const planAction = (await plan.candidates(session, request))[0]!
    const skillEmpty = (await skill.candidates(session, request))[0]!
    expect(goalAction).toEqual({ name: '目标', description: '填写当前目标' })
    expect(planAction).toEqual({ name: '计划', description: '开启计划模式' })
    expect(skillEmpty).toEqual({ name: '暂无可用 Skill', description: '当前会话没有可引用的 Skill' })
    const span = { start: 0, end: 1, draftRev: 1 }
    expect(goal.onPick({ candidate: goalAction, session, position: 'leading', via: 'menu', span })).toBe('handled')
    await vi.waitFor(() => expect(adjudicate).toHaveBeenCalledWith('/goal', expect.any(AbortSignal)))
    expect(bail).toHaveBeenCalledWith(scope, 'slash/input-begin-command', { claim, span })
    expect(snapshot).toEqual({ draft: '/goal ', draftRev: 2, phase: 'claimed' })
    expect(setDraft).not.toHaveBeenCalled()
    expect(track).not.toHaveBeenCalled()
    expect(onSpace).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(goal.codec).toBeUndefined()

    snapshot = { draft: '保留 @ 草稿', draftRev: 3, phase: 'plain' }
    setDraft.mockClear()
    const planSpan = { start: 3, end: 4, draftRev: 3 }
    expect(plan.onPick({ candidate: planAction, session, position: 'inline', via: 'menu', span: planSpan })).toBe('handled')
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith('session-1', '/plan'))
    expect(bail).toHaveBeenCalledWith(scope, 'slash/input-consume-token', {
      guard: { kind: 'span', span: planSpan },
    })
    expect(snapshot.draft).toBe('保留  草稿')
    expect(setDraft).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(plan.codec).toBeUndefined()
    expect(binding).not.toHaveBeenCalled()

    // InputTriggerPick has no model gate: this is also the action path while
    // ordinary message submission is blocked by an unavailable model.
    snapshot = { draft: '@', draftRev: 5, phase: 'plain' }
    execute.mockClear()
    bail.mockClear()
    const emptySpan = { start: 0, end: 1, draftRev: 5 }
    expect(plan.onPick({
      candidate: planAction, session, position: 'leading', via: 'menu', span: emptySpan,
    })).toBe('handled')
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith('session-1', '/plan'))
    expect(bail).toHaveBeenCalledWith(scope, 'slash/input-consume-token', {
      guard: { kind: 'span', span: emptySpan },
    })
    expect(snapshot.draft).toBe('')
    expect(submit).not.toHaveBeenCalled()

    snapshot = { draft: '不能覆盖 @ 原稿', draftRev: 7, phase: 'plain' }
    setDraft.mockClear()
    notify.mockClear()
    expect(goal.onPick({
      candidate: goalAction, session, position: 'inline', via: 'menu',
      span: { start: 5, end: 6, draftRev: 7 },
    })).toBe('handled')
    expect(snapshot.draft).toBe('不能覆盖 @ 原稿')
    expect(setDraft).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('error', '请在空白输入框中使用 @目标，当前草稿已保留。')

    snapshot = { draft: '失败也保留 @ 原稿', draftRev: 9, phase: 'plain' }
    execute.mockResolvedValueOnce({ ok: true, value: { result: { kind: 'error', text: '计划模式不可用' } } })
    bail.mockClear()
    notify.mockClear()
    expect(plan.onPick({
      candidate: planAction, session, position: 'inline', via: 'menu',
      span: { start: 6, end: 7, draftRev: 9 },
    })).toBe('handled')
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('error', '计划模式不可用'))
    expect(snapshot.draft).toBe('失败也保留 @ 原稿')
    expect(bail).not.toHaveBeenCalled()

    execute.mockClear()
    notify.mockClear()
    expect(plan.onPick({
      candidate: planAction, session, position: 'inline', via: 'menu',
      span: { start: 6, end: 7, draftRev: 8 },
    })).toBe('handled')
    expect(execute).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('error', '输入已变化，未开启计划模式。')

    expect(skill.onPick({ candidate: skillEmpty, session, position: 'inline', via: 'menu', span })).toBeUndefined()

    listSkills.mockRejectedValueOnce(new Error('offline') as never)
    await expect(skill.candidates(session, request)).resolves.toEqual([
      { name: 'Skill 暂时无法读取', description: '请稍后重试' },
    ])
  })

  it('uses native Computer Use metadata for ready, setup, failed, and Windows candidates', async () => {
    let item: any = {
      id: 'computer-use', state: 'ready', detail: '原生 Computer Use 已就绪。', actions: [],
    }
    const call = vi.fn(async (_channel: string, endpoint: string) => endpoint === 'list'
      ? { ok: true, value: { schema_version: 1, items: [item] } }
      : { ok: true, value: { schema_version: 1 } })
    const sources: InputTriggerSource[] = []
    registerComputerUseTrigger({
      effect(run: () => () => void) { return run() },
      inputTriggers: { registerSource(source: InputTriggerSource) { sources.push(source); return () => {} } },
      connection: { rpc: { call } },
      logger: { warn: vi.fn() },
    })
    const source = sources[0]!
    const signal = new AbortController().signal
    const setupSignal = new AbortController().signal
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(setupSignal)
    const session = { sessionId: 'session-1' as never }
    const request = { query: '', position: 'inline' as const, signal }
    const pick = (candidate: any) => source.onPick({
      candidate, session, position: 'inline', via: 'menu', span: { start: 0, end: 1, draftRev: 1 },
    })

    document.body.dataset.dshDesktopPlatform = 'darwin'
    const ready = (await source.candidates(session, request))[0]!
    expect(ready).toMatchObject({ name: '电脑操控', description: '原生 Computer Use 已就绪。', hint: '可插入' })
    expect(pick(ready)).toMatchObject({ insert: { ref: 'computer-use', label: '@电脑操控' } })

    item = {
      id: 'computer-use', state: 'setup-required', detail: '需要开启辅助功能。',
      actions: [{ id: 'open-accessibility-settings', label: '打开辅助功能设置' }],
    }
    const setup = (await source.candidates(session, request))[0]!
    expect(setup).toMatchObject({ description: '需要开启辅助功能。', hint: '打开系统设置' })
    expect(pick(setup)).toBe('handled')
    expect(timeout).toHaveBeenCalledWith(10_000)
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/emate.capabilities', 'action', {
      capability_id: 'computer-use', action_id: 'open-accessibility-settings', data: {},
    }, setupSignal))

    item = { id: 'computer-use', state: 'failed', detail: 'provider failed', actions: [] }
    const failed = (await source.candidates(session, request))[0]!
    expect(failed).toMatchObject({ description: 'provider failed', hint: '不可用' })
    const actionCalls = call.mock.calls.filter(([, endpoint]) => endpoint === 'action').length
    expect(pick(failed)).toBe('handled')
    expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'action')).toHaveLength(actionCalls)

    call.mockClear()
    document.body.dataset.dshDesktopPlatform = 'win32'
    item = { id: 'computer-use', state: 'ready', detail: 'Windows 已就绪。', actions: [] }
    const windows = (await source.candidates(session, request))[0]!
    expect(windows).toMatchObject({ description: 'Windows 已就绪。', hint: '可插入' })
    expect(pick(windows)).toMatchObject({ insert: { source: '电脑操控', ref: 'computer-use' } })
    expect(call).toHaveBeenCalledOnce()
    call.mockClear()
    document.body.dataset.dshDesktopPlatform = 'linux'
    const unsupported = (await source.candidates(session, request))[0]!
    expect(unsupported).toMatchObject({ hint: '不可用' })
    expect(pick(unsupported)).toBe('handled')
    expect(call).not.toHaveBeenCalled()
    delete document.body.dataset.dshDesktopPlatform
    timeout.mockRestore()
  })

  it('keeps enabled Skills as references while Goal and Plan stay action-only', async () => {
    let skills = [{ name: 'office-review', description: '复核办公文档', modelInvocable: true }]
    const sources: InputTriggerSource[] = []
    const ctx = {
      effect(run: () => () => void) { return run() },
      inputTriggers: { registerSource(source: InputTriggerSource) { sources.push(source); return () => {} } },
      connection: {
        api: { skills: { list: vi.fn(async () => ({ result: { ok: true, value: { skills } } })) } },
      },
    }

    registerMentionSources(ctx)
    expect(sources.map(source => source.name)).toEqual(['目标', '计划', 'Skill'])
    const signal = new AbortController().signal
    const goalSource = sources[0]!
    const planSource = sources[1]!
    const skillSource = sources[2]!
    expect(goalSource.codec).toBeUndefined()
    expect(planSource.codec).toBeUndefined()

    expect(await skillSource.candidates({ sessionId: 'session-1' as never }, { query: 'office', position: 'inline', signal }))
      .toEqual([{ name: 'office-review', description: '复核办公文档' }])
    const skillPick = skillSource.onPick({
      candidate: { name: 'office-review' }, session: { sessionId: 'session-1' as never }, position: 'inline', via: 'menu',
      span: { start: 0, end: 1, draftRev: 1 },
    }) as { insert: { ref: string } }
    await expect(skillSource.codec?.serialize(skillPick.insert.ref, signal)).resolves.toBe('/office-review')
    skills = []
    await expect(skillSource.codec?.serialize(skillPick.insert.ref, signal)).rejects.toThrow('Skill 已不可用')
  })

  it('opens the complete native @ roster through the owning draft and InputTrigger controller', () => {
    let snapshot = { draft: '请处理', draftRev: 7, phase: 'plain' as const }
    const setDraft = vi.fn((draft: string) => { snapshot = { ...snapshot, draft, draftRev: snapshot.draftRev + 1 } })
    const track = vi.fn()
    const scope = {}
    const ctx = {
      sessions: { scope: (sessionId: string) => sessionId === 'session-1' ? scope : undefined },
      conversation: { input: { for: () => ({ state: { getSnapshot: () => snapshot }, setDraft }) } },
      inputTriggers: { sessionOf: () => ({ track }) },
    }

    openMentionMenu(ctx, 'session-1', { start: 3, end: 3 })
    expect(setDraft).toHaveBeenCalledWith('请处理 @')
    expect(track).toHaveBeenCalledWith('请处理 @', 5, { tier: 'plain' }, 8)
  })
})

it.each(['darwin', 'win32'])('native %s pick inserts and submits a selected CU reference, including application grants still pending', async platform => {
  for (const state of ['ready', 'setup-required', 'blocked', 'failed', ...(platform === 'darwin' ? ['os-setup'] : [])]) {
    document.body.dataset.dshDesktopPlatform = platform
    const sources: InputTriggerSource[] = []
    const ctx = new Context(), scope = createScope(ctx, `cu-${platform}-${state}` as never)
    const controller = new InputTriggerController({ actx: scope.ctx, sessionId: `cu-${platform}-${state}` as never,
      roster: { sources: trigger => sources.filter(source => source.trigger === trigger), all: () => sources } })
    const sent = vi.fn(), input = new SessionInputShell({ actx: scope.ctx, inputTriggers: () => controller, defaultSink: sent })
    const off = scope.ctx.on('slash/input-insert-reference', req => input.insertReference(req.reference, req.span) ? true : undefined)
    const call = vi.fn(async (_channel: string, endpoint: string, _data: unknown, _signal: AbortSignal) => endpoint === 'list'
      ? { ok: true, value: { items: [{ id: 'computer-use', state: state === 'os-setup' ? 'setup-required' : state,
        actions: state === 'os-setup' ? [{ id: 'open-accessibility-settings', label: '打开辅助功能设置' }] : [], detail: '原生状态说明' }] } }
      : { ok: true })
    registerComputerUseTrigger({ effect: (run: () => unknown) => run(), inputTriggers: { registerSource: (source: InputTriggerSource) => {
      sources.push(source); controller.sourceAdded(source); return () => {}
    } }, connection: { rpc: { call } } })
    try {
      input.setDraft('请保留正文 @ 后续文字')
      input.addAttachments(['attachment-image', 'attachment-file'] as never)
      const initial = input.state.getSnapshot(), caret = initial.draft.indexOf('@') + 1
      controller.track(initial.draft, caret, { tier: 'plain' }, initial.draftRev)
      await vi.waitFor(() => expect(controller.menu.getSnapshot().groups[0]?.status).toBe('ready'))
      const candidate = controller.menu.getSnapshot().groups[0]!.items[0]!
      if (state === 'blocked' || state === 'failed' || state === 'os-setup') {
        expect(candidate).toMatchObject({ description: '原生状态说明', hint: state === 'os-setup' ? '打开系统设置' : '不可用' })
        controller.pick('电脑操控', 0)
        if (state === 'os-setup') await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/emate.capabilities', 'action', {
          capability_id: 'computer-use', action_id: 'open-accessibility-settings', data: {},
        }, expect.any(AbortSignal)))
        else expect(call).toHaveBeenCalledOnce()
        expect(input.state.getSnapshot().draft).toBe(initial.draft)
        expect(input.state.getSnapshot().imageIds).toEqual(initial.imageIds)
        expect(input.state.getSnapshot().occurrences).toEqual([])
        expect(sent).not.toHaveBeenCalled()
        continue
      }
      expect(candidate.hint).toBe('可插入') // actual native menu retains the owner metadata
      if (state === 'setup-required') expect(candidate.description).toContain('实际操作仍需原生应用授权')
      controller.pick('电脑操控', 0)
      const selected = input.state.getSnapshot()
      expect(selected.draft).toBe('请保留正文 \ufffc 后续文字')
      expect(selected.imageIds).toEqual(['attachment-image', 'attachment-file'])
      expect(selected.occurrences).toMatchObject([{ source: '电脑操控', ref: 'computer-use', selected: true }])
      expect(deriveDecorations(selected).chips).toMatchObject([{ label: '@电脑操控', invalid: false }])
      input.actions.submit()
      await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce())
      expect(sent).toHaveBeenCalledWith('请保留正文 @电脑操控 后续文字', ['attachment-image', 'attachment-file'], 'queue', [{ source: '电脑操控', ref: 'computer-use' }])
      expect(call.mock.calls).toHaveLength(1) // insertion is intent; no grant/settings action was requested

      // Verify the delivered source/ref against the actual Host explicit gate,
      // without invoking any native tool or granting an application lease.
      const builder = readFileSync('../../../../dsh-plugin-computer-use/scripts/build.mjs', 'utf8')
      const start = builder.indexOf('`const COMPUTER_USE_MENTION') + 1
      const end = builder.indexOf('const DIRECT_AUTOMATION', start)
      const gate = new Function('session', builder.slice(start, end).replaceAll('export function ', 'function ') + '\nreturn hasExplicitComputerUseRequest(session)')
      const event = { type: 'user/message', data: { source: { kind: 'user', mentions: sent.mock.calls[0][3] } } }
      expect(gate({ events: [event] })).toBe(true)
      expect(gate({ events: [{ type: 'user/message', data: { source: { kind: 'user' }, content: '@电脑操控' } }] })).toBe(false)
      expect(gate({ events: [event, { type: 'user/message', data: { source: { kind: 'user' } } }] })).toBe(false)
    } finally { off(); input.dispose(); controller.dispose(); await scope.fiber.dispose() }
  }
})
