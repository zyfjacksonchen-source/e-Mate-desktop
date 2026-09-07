import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

interface SkillReference {
  kind: 'skill'
  sessionId: string
  name: string
}

interface SkillEntry {
  name: string
  description: string
}

interface ComputerUseCapability {
  state: 'ready' | 'setup-required' | 'blocked' | 'failed'
  detail?: string
  actions: readonly { id: string; label: string }[]
}

async function skillsOf(ctx: any, sessionId: string, signal: AbortSignal): Promise<readonly SkillEntry[]> {
  signal.throwIfAborted()
  const { result } = await ctx.connection.api.skills.list({ sessionId }, signal)
  if (!result.ok) throw new Error(result.error.message)
  return result.value.skills
}

async function computerUseOf(ctx: any, signal: AbortSignal): Promise<ComputerUseCapability | undefined> {
  const result = await ctx.connection.rpc.call('/emate.capabilities', 'list', {}, signal)
  if (!result?.ok) throw new Error(result?.error?.message ?? '无法读取 Computer Use 状态')
  const item = result.value?.items?.find((candidate: any) => candidate?.id === 'computer-use')
  if (item === undefined) return undefined
  if (!['ready', 'setup-required', 'blocked', 'failed'].includes(item.state)
    || !Array.isArray(item.actions)
    || item.actions.some((action: any) => typeof action?.id !== 'string' || typeof action?.label !== 'string')) {
    throw new Error('Computer Use 状态无效')
  }
  return item
}

const computerCandidate = (description: string, hint: string) => [{ name: '电脑操控', description, hint }]

/** Keep explicit Computer Use on the same native @ registry as every other reference. */
export function registerComputerUseTrigger(ctx: any): void {
  const source: InputTriggerSource = {
    trigger: '@',
    name: '电脑操控',
    order: -10,
    async candidates(_session, { query, signal }) {
      if (!'电脑操控'.includes(query)) return []
      if (!['darwin', 'win32'].includes(document.body.dataset.dshDesktopPlatform ?? '')) {
        return computerCandidate('当前桌面平台未提供 Computer Use。', '不可用')
      }
      try {
        const capability = await computerUseOf(ctx, signal)
        if (capability === undefined) return computerCandidate('Computer Use 能力未加载。', '不可用')
        if (capability.state === 'ready') return computerCandidate(capability.detail ?? 'Computer Use 已就绪。', '可插入')
        if (capability.state === 'setup-required' && capability.actions.length > 0) {
          return computerCandidate(capability.detail ?? '需要在 macOS 系统设置中开启权限。', '打开系统设置')
        }
        if (capability.state === 'setup-required') {
          // A selected reference expresses intent, not an application lease.
          // Native ComputerLeaseManager still approves or rejects the action.
          return computerCandidate(`${capability.detail ?? '尚未授权应用操作。'} 实际操作仍需原生应用授权。`, '可插入')
        }
        return computerCandidate(capability.detail ?? 'Computer Use 当前不可用。', '不可用')
      } catch (reason) {
        signal.throwIfAborted()
        return computerCandidate(reason instanceof Error ? reason.message : '无法读取 Computer Use 状态。', '不可用')
      }
    },
    lexicon() { return ['电脑操控'] },
    onPick({ candidate }) {
      if (!['darwin', 'win32'].includes(document.body.dataset.dshDesktopPlatform ?? '')) return 'handled'
      if (candidate.hint === '可插入') {
        return { insert: { source: '电脑操控', ref: 'computer-use', label: '@电脑操控', clipboardText: '@电脑操控' } }
      }
      if (candidate.hint === '打开系统设置') {
        const signal = AbortSignal.timeout(10_000)
        void computerUseOf(ctx, signal).then(async (capability) => {
          const action = capability?.state === 'setup-required' ? capability.actions[0] : undefined
          if (action === undefined) return
          const result = await ctx.connection.rpc.call('/emate.capabilities', 'action', {
            capability_id: 'computer-use', action_id: action.id, data: {},
          }, signal)
          if (!result?.ok) throw new Error(result?.error?.message ?? '无法打开 macOS 系统设置')
        }).catch((reason) => { ctx.logger?.warn?.('Computer Use setup action failed', reason) })
      }
      return 'handled'
    },
    codec: {
      clipboardText: () => '@电脑操控',
      serialize: (_ref, signal) => {
        signal.throwIfAborted()
        return Promise.resolve('@电脑操控')
      },
    },
  }
  ctx.effect(() => ctx.inputTriggers.registerSource(source), 'e-mate-shell: @电脑操控 source')
}

function parseRef(ref: string, kind: string): Record<string, unknown> {
  const value: unknown = JSON.parse(ref)
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (value as { kind?: unknown }).kind !== kind) throw new Error('引用无效')
  return value as Record<string, unknown>
}

/** Add native Goal/Plan actions and Skill references to the InputTrigger roster. */
export function registerMentionSources(ctx: any): void {
  const goal: InputTriggerSource = {
    trigger: '@',
    name: '目标',
    order: -20,
    async candidates(_session, { query, signal }) {
      signal.throwIfAborted()
      return '目标'.includes(query) ? [{ name: '目标', description: '填写当前目标' }] : []
    },
    onPick({ candidate, session, position, span }) {
      if (candidate.name !== '目标') return undefined
      const scope = ctx.sessions.scope(session.sessionId)
      if (scope === undefined) return 'handled'
      const input = ctx.conversation.input.for(scope)
      const snapshot = input.state.getSnapshot()
      if (position !== 'leading' || span.start !== 0 || span.end !== 1
        || span.draftRev !== snapshot.draftRev || snapshot.draft !== '@') {
        input.notify('error', '请在空白输入框中使用 @目标，当前草稿已保留。')
        return 'handled'
      }
      const triggers = ctx.inputTriggers.sessionOf(scope)
      void triggers.adjudicate('/goal', AbortSignal.timeout(10_000)).then((outcome: any) => {
        if (outcome === undefined || outcome === 'handled' || !('claim' in outcome)) {
          input.notify('error', '目标入口暂不可用，当前草稿已保留。')
          return
        }
        if (scope.bail(scope, 'slash/input-begin-command', { claim: outcome.claim, span }) !== true) {
          input.notify('info', '目标入口已就绪；输入已变化，未替换 @。')
        }
      }).catch((reason: unknown) => {
        input.notify('error', reason instanceof Error ? reason.message : '目标入口暂不可用，当前草稿已保留。')
      })
      return 'handled'
    },
  }

  const plan: InputTriggerSource = {
    trigger: '@',
    name: '计划',
    order: -19,
    async candidates(_session, { query, signal }) {
      signal.throwIfAborted()
      return '计划'.includes(query) ? [{ name: '计划', description: '开启计划模式' }] : []
    },
    onPick({ candidate, session, span }) {
      if (candidate.name !== '计划') return undefined
      const scope = ctx.sessions.scope(session.sessionId)
      if (scope === undefined) return 'handled'
      const input = ctx.conversation.input.for(scope)
      const snapshot = input.state.getSnapshot()
      if (span.draftRev !== snapshot.draftRev || snapshot.draft.slice(span.start, span.end) !== '@') {
        input.notify('error', '输入已变化，未开启计划模式。')
        return 'handled'
      }
      void ctx.remote.commands.execute(session.sessionId, '/plan').then((result: any) => {
        if (!result?.ok || result.value?.result?.kind !== 'success') {
          const message = result?.ok ? result.value?.result?.text : result?.error?.message
          input.notify('error', message || '无法开启计划模式，当前草稿已保留。')
          return
        }
        if (!scope.bail(scope, 'slash/input-consume-token', { guard: { kind: 'span', span } })) {
          input.notify('info', '计划模式已开启；输入已变化，未移除 @。')
        }
      }).catch((reason: unknown) => {
        input.notify('error', reason instanceof Error ? reason.message : '无法开启计划模式，当前草稿已保留。')
      })
      return 'handled'
    },
  }

  const skill: InputTriggerSource = {
    trigger: '@',
    name: 'Skill',
    order: -8,
    async candidates(session, { query, signal }) {
      const needle = query.toLocaleLowerCase()
      try {
        const items = (await skillsOf(ctx, session.sessionId, signal))
          .filter(item => item.name.toLocaleLowerCase().includes(needle))
          .map(item => ({ name: item.name, description: item.description }))
        return items.length === 0 && query === ''
          ? [{ name: '暂无可用 Skill', description: '当前会话没有可引用的 Skill' }] : items
      } catch {
        signal.throwIfAborted()
        return [{ name: 'Skill 暂时无法读取', description: '请稍后重试' }]
      }
    },
    onPick({ candidate, session }) {
      if (candidate.name === '暂无可用 Skill' || candidate.name === 'Skill 暂时无法读取') return undefined
      const ref: SkillReference = { kind: 'skill', sessionId: session.sessionId, name: candidate.name }
      return { insert: { source: 'Skill', ref: JSON.stringify(ref), label: `@${candidate.name}`, clipboardText: `/${candidate.name}` } }
    },
    codec: {
      clipboardText: ref => `/${(parseRef(ref, 'skill') as unknown as SkillReference).name}`,
      async serialize(ref, signal) {
        const saved = parseRef(ref, 'skill') as unknown as SkillReference
        if (!(await skillsOf(ctx, saved.sessionId, signal)).some(item => item.name === saved.name)) {
          throw new Error('Skill 已不可用，请重新选择')
        }
        return `/${saved.name}`
      },
    },
  }

  for (const source of [goal, plan, skill]) {
    ctx.effect(() => ctx.inputTriggers.registerSource(source), `e-mate-shell: @${source.name} source`)
  }
}

/** Open the complete native @ roster by changing the native draft and feeding its owning controller. */
export function openMentionMenu(
  ctx: any,
  sessionId: string,
  selection: { start: number; end: number },
): void {
  const scope = ctx.sessions.scope(sessionId)
  if (scope === undefined) throw new Error('会话已不可用')
  const input = ctx.conversation.input.for(scope)
  const before = input.state.getSnapshot()
  if (before.phase === 'adjudicating' || before.phase === 'submitting') return
  const start = Math.max(0, Math.min(selection.start, before.draft.length))
  const end = Math.max(start, Math.min(selection.end, before.draft.length))
  const prefix = start > 0 && !/\s/u.test(before.draft[start - 1] ?? '') ? ' @' : '@'
  const draft = `${before.draft.slice(0, start)}${prefix}${before.draft.slice(end)}`
  const caret = start + prefix.length
  input.setDraft(draft)
  const after = input.state.getSnapshot()
  ctx.inputTriggers.sessionOf(scope).track(draft, caret, {
    tier: after.phase === 'claimed' ? 'claimed' : 'plain',
  }, after.draftRev)
}
