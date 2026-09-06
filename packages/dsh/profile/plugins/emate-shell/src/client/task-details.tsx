import type { ConversationSnapshot, UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import css from './task-details.module.css'
import { openNativePetSettings } from './settings-chrome.tsx'
import { createPetWorkFactsReader } from './pet-image-facts.ts'

const phaseLabels: Record<string, string> = {
  active: '进行中', blocked: '等待处理', paused: '已暂停', completed: '已完成',
  pending: '待处理', in_progress: '进行中', running: '进行中', stopping: '正在停止',
  failed: '失败', cancelled: '已取消',
}

interface TaskDetailsProps {
  sessionId: string
  taskId: string
  close(): void
  useSession<T>(selector: (snapshot: ConversationSnapshot) => T): T
  useSessions<T>(selector: (snapshot: any) => T): T
  useProjection: UseProjection
}

/** Read the selected native session and its projection faces; keep no task snapshot of our own. */
export function TaskDetails({ sessionId, taskId, close, useSession, useSessions, useProjection }: TaskDetailsProps) {
  const snapshot = useSession(value => value)
  const list = useSessions(value => value)
  const goalState = useProjection('goal') as { goal?: { objective: string; phase: string } } | undefined
  const todos = useProjection('todos') as readonly { content: string; status: string }[] | undefined
  if (sessionId !== taskId) return <section className={css.root} aria-label="任务详情">
    <p>已切换任务，请点击小芯查看当前任务。</p><button type="button" onClick={close}>关闭</button>
  </section>
  const jobs = list.jobsBySession[taskId] ?? []
  const waiting = snapshot.pending.length > 0 || list.byId[taskId]?.pendingInteraction !== undefined
  const state = waiting ? '等待处理' : snapshot.running ? '进行中'
    : jobs.some((job: { status: string }) => job.status === 'running' || job.status === 'stopping') ? '后台作业进行中'
    : snapshot.lastAgentError ? '执行出错' : goalState?.goal?.phase === 'active' ? '目标进行中' : '当前未执行'
  return <section className={css.root} aria-label="任务详情">
    <header><strong>任务详情</strong><button type="button" onClick={close}>关闭</button></header>
    <h2>{list.byId[taskId]?.title || '当前任务'}</h2>
    <p role="status">{state}</p>
    {goalState?.goal && <div><h3>目标 · {phaseLabels[goalState.goal.phase] ?? '状态待同步'}</h3><p>{goalState.goal.objective}</p></div>}
    {todos && todos.length > 0 && <div><h3>计划</h3><ul>{todos.map((item, index) =>
      <li key={`${index}:${item.content}`}><span>{phaseLabels[item.status] ?? '状态待同步'}</span> {item.content}</li>)}</ul></div>}
    <dl>
      <dt>正在执行的工具</dt><dd>{snapshot.runningCalls.length}</dd>
      <dt>排队消息</dt><dd>{snapshot.queue.length}</dd>
      <dt>等待处理事项</dt><dd>{snapshot.pending.length}</dd>
    </dl>
    {jobs.length > 0 && <div><h3>后台作业</h3><ul>{jobs.map((job: { jobId: string; status: string }, index: number) =>
      <li key={job.jobId ?? index}>作业 {index + 1} · {phaseLabels[job.status] ?? '状态待同步'}</li>)}</ul></div>}
  </section>
}

export function registerPetTaskDetails(ctx: any, notify: (level: 'info' | 'error', text: string) => void): void {
  const readWorkFacts = createPetWorkFactsReader(ctx)
  let disposePanel: (() => void) | undefined
  let generation = 0
  const release = () => { generation++; disposePanel?.(); disposePanel = undefined }
  const open = async (taskId: string) => {
    const request = ++generation
    if (ctx.sessions.list.getSnapshot().current !== taskId) return
    if (!ctx.sessions.binding(taskId)?.session) throw new Error('Task unavailable')
    await ctx.get('emateCanvas')?.beforeNavigate()
    if (request !== generation || ctx.sessions.list.getSnapshot().current !== taskId
      || !ctx.sessions.binding(taskId)?.session) return
    disposePanel?.()
    disposePanel = ctx.slots.register({ name: 'details', id: 'e-mate-task-details', priority: -2,
      inject: () => ({ taskId, close: () => { release(); ctx.layout.closeDetails() } }),
    }, TaskDetails)
    ctx.sessions.open(taskId)
    ctx.layout.openDetails()
  }
  ctx.effect(() => {
    const dispose = ctx.reflect.provide('ematePetDetails', { release, readWorkFacts,
      openPetSettings() {
        const request = ++generation
        const path = location.pathname
        const sessionId = ctx.sessions.list.getSnapshot().current
        void (async () => {
          await ctx.get('emateCanvas')?.beforeNavigate()
          if (request === generation && location.pathname === path
            && ctx.sessions.list.getSnapshot().current === sessionId) await openNativePetSettings()
        })().catch(() => notify('error', '设置未能打开，请先处理画布保存问题或稍后重试。'))
      },
      openTaskDetails(taskId: string) { void open(taskId).catch(() => notify('error', '任务详情未能打开，请先处理画布保存问题或稍后重试。')) },
    })
    return () => { release(); void dispose() }
  }, 'e-mate.pet: native task details')
}
