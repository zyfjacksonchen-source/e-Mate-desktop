import type { UseProjection, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import css from './task-details.module.css'
import { openNativePetSettings } from './settings-chrome.tsx'
import { createPetWorkFactsReader } from './pet-image-facts.ts'

const phaseLabels: Record<string, string> = {
  active: '进行中', blocked: '等待处理', paused: '已暂停', completed: '已完成',
  pending: '待处理', in_progress: '进行中', running: '进行中', stopping: '正在停止',
  failed: '失败', cancelled: '已取消', killed: '已取消',
}

/** The tab type's implementation identity: the key its body and title register under. */
const TASK_DETAILS_TAB_ID = 'e-mate.task-details'
/** The page kind the pet opens; the native registry records one page per kind per pane. */
const TASK_DETAILS_KIND = 'e-mate-task-details'

/** What one task-details page carries: the Session whose facts it shows. */
interface TaskDetailsParams { readonly taskId: string }

interface TaskDetailsProps {
  sessionId: string
  taskId: string
  close(): void
  useSession: <T>(selector: (snapshot: SessionSnapshot) => T) => T
  useSessions: <T>(selector: (snapshot: any) => T) => T
  useProjection: UseProjection
  /** Session-scoped pending interactions, keyed by Session; the owner of "a person must answer". */
  useSessionPendingInteraction: <T>(selector: (pending: ReadonlyMap<string, unknown>) => T) => T
}

/** Read the selected native session and its projection faces; keep no task snapshot of our own. */
export function TaskDetails({
  sessionId, taskId, close, useSession, useSessions, useProjection, useSessionPendingInteraction,
}: TaskDetailsProps) {
  const snapshot = useSession(value => value)
  const list = useSessions(value => value)
  const goalState = useProjection('goal') as { goal?: { objective: string; phase: string } } | undefined
  const todos = useProjection('todos') as readonly { content: string; status: string }[] | undefined
  const waiting = useSessionPendingInteraction(pending => pending.has(taskId))
  if (sessionId !== taskId) return <section className={css.root} aria-label="任务详情">
    <p>已切换任务，请点击小芯查看当前任务。</p><button type="button" onClick={close}>关闭</button>
  </section>
  const jobs = list.jobsBySession[taskId] ?? []
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
      <dt>排队消息</dt><dd>{snapshot.queue.length}</dd>
      <dt>等待处理事项</dt><dd>{waiting ? 1 : 0}</dd>
    </dl>
    {jobs.length > 0 && <div><h3>后台作业</h3><ul>{jobs.map((job: { jobId: string; status: string }, index: number) =>
      <li key={job.jobId ?? index}>作业 {index + 1} · {phaseLabels[job.status] ?? '状态待同步'}</li>)}</ul></div>}
  </section>
}

/** Everything the native tab seats hand the panel beyond the framework's standard shares. */
interface TaskDetailsTabProps {
  sessionId: string
  useSession: TaskDetailsProps['useSession']
  useSessions: TaskDetailsProps['useSessions']
  useProjection: UseProjection
  useSessionPendingInteraction: TaskDetailsProps['useSessionPendingInteraction']
  useTabInfo: () => { tab: { id: string; navigation: { params?: unknown } } }
  closeTab(tabId: string): void
}

/** The page body the native right column dispatches; the task id rides the tab's own navigation. */
function TaskDetailsTab({ useTabInfo, closeTab, ...props }: TaskDetailsTabProps) {
  const { tab } = useTabInfo()
  const params = tab.navigation.params as Partial<TaskDetailsParams> | undefined
  return <TaskDetails {...props} taskId={params?.taskId ?? ''} close={() => { closeTab(tab.id) }} />
}

/** The chip title: the live tab record's own title, as the shipped guide's title reads it. */
function TaskDetailsTitle({ useTabInfo }: Pick<TaskDetailsTabProps, 'useTabInfo'>) {
  return useTabInfo().tab.title
}

export function registerPetTaskDetails(ctx: any, notify: (level: 'info' | 'error', text: string) => void): void {
  const readWorkFacts = createPetWorkFactsReader(ctx)
  ctx.effect(() => {
    // One page type, registered through the two stages the shipped guide uses:
    // the definition into the registry, then its body and chip title into the
    // keyed seats under the definition's own id.
    const disposeType = ctx.sidebarRightTabs.register({
      id: TASK_DETAILS_TAB_ID,
      kind: TASK_DETAILS_KIND,
      title: () => '任务详情',
    })
    const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TASK_DETAILS_TAB_ID,
      inject: () => ({ closeTab: (tabId: string) => { ctx.sidebarRight.close(tabId) } }),
    }, TaskDetailsTab))
    const disposeTitle = ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: TASK_DETAILS_TAB_ID,
    }, TaskDetailsTitle))
    /** Invalidates a pending open; the tab itself belongs to the native column. */
    let generation = 0
    const open = async (taskId: string) => {
      const request = ++generation
      if (ctx.sessions.list.getSnapshot().current !== taskId) return
      if (!ctx.sessions.binding(taskId)?.session) throw new Error('Task unavailable')
      await ctx.get('emateCanvas')?.beforeNavigate()
      if (request !== generation || ctx.sessions.list.getSnapshot().current !== taskId
        || !ctx.sessions.binding(taskId)?.session) return
      ctx.sessions.open(taskId)
      ctx.sidebarRight.openTab(TASK_DETAILS_KIND, { params: { taskId } })
    }
    const dispose = ctx.reflect.provide('ematePetDetails', { readWorkFacts,
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
    return () => {
      generation++
      disposeTitle()
      disposeBody()
      disposeType()
      void dispose()
    }
  }, 'e-mate.pet: native task details')
}
