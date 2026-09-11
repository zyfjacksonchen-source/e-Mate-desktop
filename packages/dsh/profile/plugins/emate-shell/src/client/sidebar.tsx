import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import css from './sidebar.module.css'
import { collectInternalSubagentIds, highlightedProductSessionId, isTopLevelProductSession } from './session-visibility.ts'

export function newestSessionFirst(left: Pick<SessionSummary, 'id' | 'updatedAt'>, right: Pick<SessionSummary, 'id' | 'updatedAt'>): number {
  const leftTime = Number.isFinite(left.updatedAt) ? left.updatedAt : Number.NEGATIVE_INFINITY
  const rightTime = Number.isFinite(right.updatedAt) ? right.updatedAt : Number.NEGATIVE_INFINITY
  if (leftTime !== rightTime) return rightTime > leftTime ? 1 : -1
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

interface WorkspaceRow {
  workspaceId: string
  path: string
  title: string
  sessionIds: SessionSummary['id'][]
}

interface WorkspaceState {
  items: readonly WorkspaceRow[]
  archivedSessionIds: readonly string[]
  phase: 'pending' | 'ready'
}

export function isGeneralWorkspace(workspace: Pick<WorkspaceRow, 'path' | 'title'>): boolean {
  return workspace.title === '通用会话' && /(?:^|[\\/])e-mate[\\/]general$/u.test(workspace.path)
}

type Icon = ComponentType<{ size?: number; className?: string }>

interface Props {
  collapsed: boolean
  width: number
  renderSlot: (name: string, props: Record<string, unknown>) => ReactNode
  createPortal: (children: ReactNode, container: Element) => ReactNode
  useSessions: <T>(selector: (state: SessionListState) => T) => T
  useWorkspaces: <T>(selector: (state: WorkspaceState) => T) => T
  NewChatIcon: Icon
  PanelIcon: Icon
  SearchIcon: Icon
  ScheduleIcon: Icon
  ChevronIcon: Icon
  FolderIcon: Icon
  PlusIcon: Icon
  EllipsisIcon: Icon
  CopyIcon: Icon
  EditIcon: Icon
  ArchiveIcon: Icon
  CloseIcon: Icon
  startSession: (workspaceId?: string) => void | Promise<unknown>
  openSchedules: () => void
  openSession: (id: string) => void
  pickWorkspace: () => Promise<string | null>
  renameSession: (id: string, title: string) => Promise<void>
  archiveSession: (id: string) => Promise<void>
  deleteWorkspace: (workspaceId: string) => Promise<void>
  toggleSidebar: () => void
}

const COLLAPSED_SESSION_LIMIT = 10

export function SidebarRoot({
  collapsed,
  width,
  renderSlot,
  createPortal,
  useSessions,
  useWorkspaces,
  NewChatIcon,
  PanelIcon,
  SearchIcon,
  ScheduleIcon,
  ChevronIcon,
  FolderIcon,
  PlusIcon,
  EllipsisIcon,
  CopyIcon,
  EditIcon,
  ArchiveIcon,
  CloseIcon,
  startSession,
  openSchedules,
  openSession,
  pickWorkspace,
  renameSession,
  archiveSession,
  deleteWorkspace,
  toggleSidebar,
}: Props) {
  const wide = !collapsed
  const root = useRef<HTMLElement>(null)
  const mobileOpen = useRef<HTMLButtonElement>(null)
  const sessionSnapshot = useSessions(state => state)
  const workspaces = useWorkspaces(state => state.items)
  const archivedSessionIds = useWorkspaces(state => state.archivedSessionIds)
  const workspacePhase = useWorkspaces(state => state.phase)
  const [projectsCollapsed, setProjectsCollapsed] = useState(false)
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false)
  const [unassignedCollapsed, setUnassignedCollapsed] = useState(true)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [showAll, setShowAll] = useState<Record<string, boolean>>({})
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [picking, setPicking] = useState(false)
  const [renameTarget, setRenameTarget] = useState<SessionSummary | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [busySession, setBusySession] = useState<string | null>(null)
  const [batchMode, setBatchMode] = useState(false)
  const [batchSelected, setBatchSelected] = useState<Set<string>>(() => new Set())
  const [batchConfirming, setBatchConfirming] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Pick<WorkspaceRow, 'workspaceId' | 'title'> | null>(null)
  const [deletingWorkspace, setDeletingWorkspace] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const deleteInFlight = useRef(false)
  const deleteDialog = useRef<HTMLElement>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pathname, setPathname] = useState(() => location.pathname)

  const archived = useMemo(() => new Set(archivedSessionIds), [archivedSessionIds])
  const projectWorkspaces = useMemo(() => workspaces.filter(workspace => !isGeneralWorkspace(workspace)), [workspaces])
  const internalSubagentIds = useMemo(() => collectInternalSubagentIds(sessionSnapshot), [sessionSnapshot])
  const visibleRows = useMemo(() => sessionSnapshot.ids
    .map(id => sessionSnapshot.byId[id])
    .filter((row): row is SessionSummary => row !== undefined
      && isTopLevelProductSession(row, internalSubagentIds)
      && !archived.has(row.id))
    .sort(newestSessionFirst),
  [archived, internalSubagentIds, sessionSnapshot])
  const visibleById = useMemo(() => new Map(visibleRows.map(row => [row.id, row])), [visibleRows])
  const highlightedSessionId = highlightedProductSessionId(sessionSnapshot)
  const generalWorkspace = useMemo(() => workspaces.find(isGeneralWorkspace), [workspaces])
  const assignedSessionIds = useMemo(() => new Set(workspaces.flatMap(workspace => workspace.sessionIds)), [workspaces])
  const generalRows = useMemo(() => workspacePhase === 'ready'
    ? (generalWorkspace?.sessionIds.flatMap(id => visibleById.get(id) ?? []).sort(newestSessionFirst) ?? [])
    : [],
  [generalWorkspace, visibleById, workspacePhase])
  const unassignedRows = useMemo(() => workspacePhase === 'ready'
    ? visibleRows.filter(row => !assignedSessionIds.has(row.id))
    : [],
  [assignedSessionIds, visibleRows, workspacePhase])
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')
  const searchRows = normalizedQuery === ''
    ? []
    : visibleRows.filter(row => row.displayTitle.toLocaleLowerCase('zh-CN').includes(normalizedQuery))
  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every(row => batchSelected.has(row.id))

  useEffect(() => {
    const sync = () => { setPathname(location.pathname) }
    addEventListener('popstate', sync)
    return () => { removeEventListener('popstate', sync) }
  }, [])

  useEffect(() => {
    const closeOutsideMenus = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      root.current?.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(details => {
        if (!details.contains(target)) details.removeAttribute('open')
      })
    }
    document.addEventListener('pointerdown', closeOutsideMenus)
    return () => { document.removeEventListener('pointerdown', closeOutsideMenus) }
  }, [])

  useEffect(() => {
    if (!deleteTarget) return
    const previous = document.activeElement
    deleteDialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [deleteTarget])

  if (pathname === '/settings') return <>{renderSlot('sidebar.settings', { wide })}</>

  const requestWorkspaceDelete = (workspace: WorkspaceRow, menu: HTMLDetailsElement | null) => {
    if (deleteInFlight.current) return
    menu?.removeAttribute('open')
    menu?.querySelector<HTMLElement>('summary')?.focus()
    setDeleteError(null)
    setDeleteTarget({ workspaceId: workspace.workspaceId, title: workspace.title })
  }

  const removeWorkspace = async () => {
    if (!deleteTarget || deleteInFlight.current) return
    const target = deleteTarget
    deleteInFlight.current = true
    setDeletingWorkspace(true)
    setDeleteError(null)
    try {
      await deleteWorkspace(target.workspaceId)
      setDeleteTarget(null)
      setUnassignedCollapsed(false)
      setNotice('项目已从列表移除。本地文件和会话已保留，会话可在“未分组”中查看。')
    } catch {
      setDeleteError('项目暂时无法删除，请重试。')
    } finally {
      deleteInFlight.current = false
      setDeletingWorkspace(false)
    }
  }

  const addWorkspace = async () => {
    if (picking) return
    setPicking(true)
    setNotice(null)
    try {
      const workspaceId = await pickWorkspace()
      if (workspaceId === null) return
      try {
        await startSession(workspaceId)
      } catch {
        setNotice('项目文件夹已添加，但新任务暂时无法创建。请稍后从项目中重试。')
      }
    } catch {
      setNotice('项目文件夹暂时无法添加，请重试。')
    } finally {
      setPicking(false)
    }
  }

  const beginSession = async (workspaceId?: string) => {
    if (creating) return
    setCreating(true)
    setNotice(null)
    try {
      await (workspaceId === undefined ? startSession() : startSession(workspaceId))
    } catch {
      setNotice('新任务暂时无法创建，请重试。')
    } finally {
      setCreating(false)
    }
  }

  const submitRename = async () => {
    const title = renameDraft.trim()
    if (renameTarget === null || title === '' || busySession !== null) return
    setBusySession(renameTarget.id)
    setNotice(null)
    try {
      await renameSession(renameTarget.id, title)
      setRenameTarget(null)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '重命名失败。')
    } finally {
      setBusySession(null)
    }
  }

  const archive = async (id: string) => {
    if (busySession !== null || batchBusy) return
    setBusySession(id)
    setNotice(null)
    try {
      await archiveSession(id)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '归档失败。')
    } finally {
      setBusySession(null)
    }
  }

  const leaveBatchMode = () => {
    setBatchMode(false)
    setBatchSelected(new Set())
    setBatchConfirming(false)
  }

  const archiveSelected = async () => {
    const targets = [...batchSelected]
    if (targets.length === 0 || batchBusy) return
    setBatchBusy(true)
    setNotice(null)
    try {
      const results = await Promise.allSettled(targets.map(archiveSession))
      const failed = targets.filter((_, index) => results[index]?.status === 'rejected')
      if (failed.length === 0) {
        setNotice(`已删除 ${targets.length} 个会话。`)
        leaveBatchMode()
      } else {
        setBatchSelected(new Set(failed))
        setNotice(`已删除 ${targets.length - failed.length} 个会话，${failed.length} 个失败，请重试。`)
      }
    } finally {
      setBatchBusy(false)
      setBatchConfirming(false)
    }
  }

  const copyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id)
      setNotice('任务 ID 已复制。')
    } catch {
      setNotice('浏览器未允许复制任务 ID。')
    }
  }

  const sessionRow = (row: SessionSummary) => (
    <div className={css.taskEntry} key={row.id}>
      {batchMode ? (
        <label className={`${css.taskRow} ${css.batchTaskRow} ${row.id === highlightedSessionId ? css.current : ''}`}>
          <input
            type="checkbox"
            aria-label={`选择会话：${row.blank ? '新会话' : row.displayTitle}`}
            checked={batchSelected.has(row.id)}
            disabled={batchBusy}
            onChange={() => {
              setBatchSelected((selected) => {
                const next = new Set(selected)
                if (next.has(row.id)) next.delete(row.id)
                else next.add(row.id)
                return next
              })
            }}
          />
          <span>{row.blank ? '新会话' : row.displayTitle}</span>
        </label>
      ) : <>
      <button
        className={`${css.taskRow} ${row.id === highlightedSessionId ? css.current : ''}`}
        type="button"
        title={row.blank ? '新会话' : row.displayTitle}
        aria-label={`打开任务：${row.blank ? '新会话' : row.displayTitle}`}
        aria-current={row.id === highlightedSessionId ? 'page' : undefined}
        disabled={busySession === row.id}
        onClick={() => { openSession(row.id) }}
      >
        <span>{row.blank ? '新会话' : row.displayTitle}</span>
        {/* 0.1.5's SessionSummary publishes no per-session pending-interaction fact:
            that state is session-scoped (ui-session's pending-interaction hook), and the
            waiting affordance lives with the session's own panel rather than a list row. */}
        {row.running
          ? <i className={css.activity} aria-label="任务正在进行" />
          : null}
      </button>
      <details className={css.taskMenu}>
        <summary aria-label={`管理任务：${row.blank ? '新会话' : row.displayTitle}`}><EllipsisIcon size={16} /></summary>
        <div>
          <button type="button" onClick={() => { void copyId(row.id) }}><CopyIcon size={16} />复制任务 ID</button>
          <button type="button" onClick={() => { setRenameTarget(row); setRenameDraft(row.displayTitle) }}><EditIcon size={16} />重命名</button>
          <button type="button" className={css.danger} onClick={() => { void archive(row.id) }}><ArchiveIcon size={16} />归档</button>
        </div>
      </details>
      </>}
    </div>
  )

  const mobileLayer = createPortal(
    <>
      {wide && <button className={css.scrim} type="button" title="关闭任务导航" aria-label="关闭任务导航" onClick={toggleSidebar} />}
      {collapsed && (
        <button
          className={css.mobileOpen}
          type="button"
          title="打开任务导航"
          aria-label="打开任务导航"
          data-emate-mobile-open=""
          ref={mobileOpen}
          onClick={toggleSidebar}
        >
          <PanelIcon size={20} />
        </button>
      )}
    </>,
    document.body,
  )

  return (
    <>
      <aside ref={root} className={`${css.root} ${collapsed ? css.collapsed : ''}`} style={wide ? { width } : undefined} aria-label="任务导航">
        <div className={css.brandRow}>
          {wide
            ? <span className={css.brand}><img className={css.logo} src="/assets/e-mate/logo.png" alt="e-Mate" /><small className={css.version}>2.0.18</small></span>
            : <button className={css.brand} type="button" title="展开任务导航" aria-label="展开任务导航" onClick={toggleSidebar}><img className={css.mark} src="/assets/e-mate/xiaoxin-avatar.png" alt="" aria-hidden="true" /></button>}
          <button className={css.closeButton} type="button" title={collapsed ? '展开任务导航' : '收起任务导航'} aria-label={collapsed ? '展开任务导航' : '收起任务导航'} onClick={toggleSidebar}>
            {wide ? <CloseIcon size={18} /> : <PanelIcon size={18} />}
          </button>
        </div>

        <button className={css.newSession} type="button" title="新建任务" aria-label="新建任务" aria-busy={creating || undefined} disabled={creating} aria-current={pathname === '/' ? 'page' : undefined} onClick={() => { void beginSession() }}>
          <NewChatIcon size={18} />
          {wide && <span>新任务</span>}
        </button>

        <div className={css.primaryActions}>
          <button
            className={css.searchAction}
            data-emate-primary-action=""
            type="button"
            title="搜索会话"
            aria-label="搜索会话"
            aria-expanded={searchOpen}
            onClick={() => {
              if (!wide) toggleSidebar()
              setSearchOpen(value => !value)
            }}
          >
            <SearchIcon size={18} />
            {wide && <span>搜索</span>}
          </button>
          <button
            className={css.scheduleAction}
            data-emate-primary-action=""
            type="button"
            title="定时任务"
            aria-label="定时任务"
            aria-current={pathname === '/schedules' ? 'page' : undefined}
            onClick={openSchedules}
          >
            <ScheduleIcon size={18} />
            {wide && <span>定时任务</span>}
          </button>
          {renderSlot('sidebar.primary.action', { wide, active: pathname === '/capabilities' })}
        </div>

        {wide && searchOpen && (
          <label className={css.search}>
            <SearchIcon size={16} />
            <input autoFocus type="text" aria-label="搜索会话" placeholder="搜索会话" value={query} onChange={event => { setQuery(event.target.value) }} />
            <button type="button" title="关闭搜索" aria-label="关闭搜索" onClick={() => { setQuery(''); setSearchOpen(false) }}><CloseIcon size={16} /></button>
          </label>
        )}

        <nav className={css.taskNav} aria-label="会话与项目">
          {searchOpen && normalizedQuery !== '' ? (
            <section className={css.sidebarSection} aria-label="搜索结果">
              <div className={css.navHeading}><strong>搜索结果</strong><small>{searchRows.length}</small></div>
              <div className={css.taskList}>{searchRows.length ? searchRows.map(sessionRow) : <p className={css.empty}>没有匹配的会话</p>}</div>
            </section>
          ) : (
            <>
              <section className={css.sidebarSection} aria-label="项目" data-dsh-workspace-drop-target="">
                <div className={css.navHeading}>
                  <button className={css.sectionToggle} type="button" aria-expanded={!projectsCollapsed} onClick={() => { setProjectsCollapsed(value => !value) }}>
                    <ChevronIcon className={projectsCollapsed ? css.rotated : undefined} size={14} /><span>项目</span>
                  </button>
                  <button className={css.iconButton} type="button" title={picking ? '正在选择项目文件夹' : '添加项目文件夹'} aria-label={picking ? '正在选择项目文件夹' : '添加项目文件夹'} aria-busy={picking || undefined} disabled={picking} onClick={() => { void addWorkspace() }}>
                    <FolderIcon size={16} />
                  </button>
                </div>
                {!projectsCollapsed && (workspacePhase === 'pending'
                  ? <p className={css.empty}>正在加载项目…</p>
                  : projectWorkspaces.length === 0
                    ? <button className={css.projectEmpty} type="button" disabled={picking} onClick={() => { void addWorkspace() }}><FolderIcon size={16} /><span>添加项目文件夹</span></button>
                    : <div className={css.projectList}>{projectWorkspaces.map(workspace => {
                      const rows = workspace.sessionIds.flatMap(id => {
                        const row = visibleById.get(id)
                        return row === undefined ? [] : [row]
                      }).sort(newestSessionFirst)
                      const open = expanded[workspace.workspaceId] !== false
                      const shown = showAll[workspace.workspaceId] ? rows : rows.slice(0, COLLAPSED_SESSION_LIMIT)
                      return (
                        <div className={css.projectGroup} key={workspace.workspaceId}>
                          <div className={css.projectRow} onContextMenu={event => {
                            event.preventDefault()
                            const menu = event.currentTarget.querySelector<HTMLDetailsElement>('details')
                            if (menu) { menu.open = true; menu.querySelector<HTMLButtonElement>('button')?.focus() }
                          }}>
                            <button className={css.projectMain} type="button" title={`${workspace.title}\n${workspace.path}`} onClick={() => { rows[0] ? openSession(rows[0].id) : void beginSession(workspace.workspaceId) }}><FolderIcon size={16} /><span>{workspace.title}</span></button>
                            <button className={css.iconButton} type="button" title={open ? `折叠 ${workspace.title} 会话` : `展开 ${workspace.title} 会话`} aria-label={open ? `折叠 ${workspace.title} 会话` : `展开 ${workspace.title} 会话`} onClick={() => { setExpanded(value => ({ ...value, [workspace.workspaceId]: !open })) }}><ChevronIcon className={!open ? css.rotated : undefined} size={14} /></button>
                            <button className={css.iconButton} type="button" title={`为 ${workspace.title} 创建新会话`} aria-label={`为 ${workspace.title} 创建新会话`} aria-busy={creating || undefined} disabled={creating} onClick={() => { void beginSession(workspace.workspaceId) }}><PlusIcon size={16} /></button>
                            <details className={`${css.taskMenu} ${css.projectMenu}`} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector<HTMLElement>('summary')?.focus() } }}>
                              <summary aria-label={`管理项目：${workspace.title}`}><EllipsisIcon size={16} /></summary>
                              <div><button type="button" className={css.danger} disabled={deletingWorkspace} onClick={event => { requestWorkspaceDelete(workspace, event.currentTarget.closest('details')) }}>删除项目</button></div>
                            </details>
                          </div>
                          {open && <div className={css.projectSessions}>{rows.length ? shown.map(sessionRow) : <button className={css.projectEmpty} type="button" onClick={() => { void beginSession(workspace.workspaceId) }}><PlusIcon size={16} /><span>新建项目会话</span></button>}{rows.length > COLLAPSED_SESSION_LIMIT && <button className={css.showMore} type="button" onClick={() => { setShowAll(value => ({ ...value, [workspace.workspaceId]: !value[workspace.workspaceId] })) }}>{showAll[workspace.workspaceId] ? '收起' : `查看更多（${rows.length - shown.length}）`}</button>}</div>}
                        </div>
                      )
                    })}</div>)}
              </section>

              <section className={css.sidebarSection} aria-label="会话">
                <div className={css.navHeading}>
                  <button className={css.sectionToggle} type="button" aria-expanded={!sessionsCollapsed} onClick={() => { setSessionsCollapsed(value => !value) }}><ChevronIcon className={sessionsCollapsed ? css.rotated : undefined} size={14} /><span>会话</span><small>{generalRows.length}</small></button>
                  <div className={css.batchActions}>
                    {batchMode ? <>
                      <button type="button" disabled={batchBusy || visibleRows.length === 0} onClick={() => { setBatchSelected(allVisibleSelected ? new Set() : new Set(visibleRows.map(row => row.id))) }}>{allVisibleSelected ? '取消全选' : '全选'}</button>
                      <button type="button" disabled={batchBusy} onClick={leaveBatchMode}>取消</button>
                      <button type="button" className={css.danger} disabled={batchBusy || batchSelected.size === 0} onClick={() => { setBatchConfirming(true) }}>删除{batchSelected.size > 0 ? `（${batchSelected.size}）` : ''}</button>
                    </> : <button type="button" disabled={visibleRows.length === 0} onClick={() => { setSearchOpen(false); setQuery(''); setBatchMode(true); setBatchSelected(new Set()) }}>批量删除</button>}
                  </div>
                </div>
                {!sessionsCollapsed && (sessionSnapshot.phase === 'pending'
                  ? <p className={css.empty}>正在加载会话…</p>
                  : <div className={css.taskList}>{generalRows.length ? generalRows.map(sessionRow) : <p className={css.empty}>暂无会话</p>}</div>)}
              </section>

              {unassignedRows.length > 0 && <section className={css.sidebarSection} aria-label="未分组">
                <div className={css.navHeading}>
                  <button className={css.sectionToggle} type="button" aria-expanded={!unassignedCollapsed} onClick={() => { setUnassignedCollapsed(value => !value) }}><ChevronIcon className={unassignedCollapsed ? css.rotated : undefined} size={14} /><span>未分组</span><small>{unassignedRows.length}</small></button>
                </div>
                {!unassignedCollapsed && <div className={css.taskList}>{unassignedRows.map(sessionRow)}</div>}
              </section>}
            </>
          )}
          {notice && <p className={css.notice} role="status">{notice}</p>}
        </nav>

        <div className={css.footer} data-emate-sidebar-footer="">
          {renderSlot('sidebar.footer.action', { wide })}
          {renderSlot('sidebar.settings', { wide })}
        </div>

      </aside>
      {deleteTarget && createPortal(
        <div className={css.dialogBackdrop} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !deleteInFlight.current) setDeleteTarget(null) }}>
          <section ref={deleteDialog} className={css.dialog} role="alertdialog" aria-modal="true" aria-labelledby="emate-project-delete-title" aria-describedby="emate-project-delete-description" aria-busy={deletingWorkspace || undefined} onKeyDown={event => {
            if (event.key === 'Escape' && !deleteInFlight.current) { event.preventDefault(); setDeleteTarget(null) }
            if (event.key === 'Tab') {
              const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
              const next = event.shiftKey ? buttons.at(-1) : buttons[0]
              if (!next || (event.shiftKey ? document.activeElement === buttons[0] : document.activeElement === buttons.at(-1))) { event.preventDefault(); next?.focus() }
            }
          }}>
            <h2 id="emate-project-delete-title">删除项目“{deleteTarget.title}”？</h2>
            <p id="emate-project-delete-description">仅从项目列表中移除。本地文件夹、文件和会话记录都会保留，会话将显示在“未分组”下。</p>
            {deleteError && <p role="alert">{deleteError}</p>}
            <div><button type="button" disabled={deletingWorkspace} onClick={() => { setDeleteTarget(null) }}>取消</button><button type="button" className={css.dangerButton} disabled={deletingWorkspace} onClick={() => { void removeWorkspace() }}>{deletingWorkspace ? '正在删除项目' : '确认删除项目'}</button></div>
          </section>
        </div>,
        document.body,
      )}
      {renameTarget && createPortal(
        <div className={css.dialogBackdrop} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && busySession === null) setRenameTarget(null) }}>
          <form className={css.dialog} role="dialog" aria-modal="true" aria-labelledby="emate-rename-title" onSubmit={event => { event.preventDefault(); void submitRename() }}>
            <h2 id="emate-rename-title">重命名任务</h2>
            <input autoFocus aria-label="任务名称" value={renameDraft} disabled={busySession !== null} onChange={event => { setRenameDraft(event.target.value) }} />
            <div><button type="button" disabled={busySession !== null} onClick={() => { setRenameTarget(null) }}>取消</button><button type="submit" disabled={busySession !== null || renameDraft.trim() === ''}>重命名</button></div>
          </form>
        </div>,
        document.body,
      )}
      {batchConfirming && createPortal(
        <div className={css.dialogBackdrop} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !batchBusy) setBatchConfirming(false) }}>
          <section className={css.dialog} role="dialog" aria-modal="true" aria-labelledby="emate-batch-delete-title">
            <h2 id="emate-batch-delete-title">删除 {batchSelected.size} 个会话？</h2>
            <p>所选会话会从侧栏移除，本地历史记录仍由 e-Mate 保留。</p>
            <div><button type="button" disabled={batchBusy} onClick={() => { setBatchConfirming(false) }}>取消</button><button type="button" className={css.dangerButton} disabled={batchBusy} onClick={() => { void archiveSelected() }}>{batchBusy ? '正在删除' : '确认删除'}</button></div>
          </section>
        </div>,
        document.body,
      )}
      {mobileLayer}
    </>
  )
}
