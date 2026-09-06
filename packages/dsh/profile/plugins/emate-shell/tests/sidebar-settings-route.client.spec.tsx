// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarRoot } from '../src/client/sidebar.tsx'
import { HeaderControls } from '../src/client/header-controls.tsx'
import { SettingsChrome, SettingsCloseLabel, SettingsTrigger } from '../src/client/settings-chrome.tsx'

vi.mock('../src/client/session-share.tsx', () => ({ SessionShareAction: () => null }))

const sessionState = {
  ids: ['long-chat', 'file-chat'], current: 'long-chat', phase: 'ready' as const,
  byId: {
    'long-chat': { id: 'long-chat', blank: false, displayTitle: '带目录的长消息', updatedAt: 2, running: false },
    'file-chat': { id: 'file-chat', blank: false, displayTitle: '文件页与子任务', updatedAt: 1, running: false },
  },
  subagentsByParent: { 'long-chat': { entries: [{ kind: 'child' as const, id: 'child-task' }] } },
  jobsBySession: {}, currentAddress: undefined,
}
const workspaceState = { items: [], archivedSessionIds: [], phase: 'ready' as const }
const Icon = () => <svg />

const props = (toggleSidebar: () => void) => ({
  useSessions: <T,>(selector: (state: typeof sessionState) => T) => selector(sessionState),
  useWorkspaces: <T,>(selector: (state: typeof workspaceState) => T) => selector(workspaceState),
  SearchIcon: Icon, ScheduleIcon: Icon, ChevronIcon: Icon, FolderIcon: Icon, PlusIcon: Icon,
  EllipsisIcon: Icon, CopyIcon: Icon, EditIcon: Icon, ArchiveIcon: Icon, CloseIcon: Icon,
  getThemeScheme: () => document.body.hasAttribute('data-ds-dark-theme') ? 'dark' as const : 'light' as const,
  subscribeTheme: () => () => {}, toggleTheme: () => {}, LightIcon: Icon, DarkIcon: Icon,
  openSession: () => {}, openSchedules: () => {}, pickWorkspace: async () => null,
  renameSession: async () => {}, deleteWorkspace: async () => {}, archiveSession: async () => {}, toggleSidebar,
})

afterEach(() => {
  cleanup()
  document.body.removeAttribute('data-ds-dark-theme')
  history.replaceState(null, '', '/')
})

describe('Settings route owns its navigation lifecycle', () => {
  it.each(['light', 'dark'] as const)('unmounts chat navigation on direct, repeated, and restored %s Settings routes', (scheme) => {
    if (scheme === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
    history.replaceState(null, '', '/chat/long-chat')
    const toggleSidebar = vi.fn()
    const openSettings = vi.fn()
    const view = render(<SidebarRoot
      {...props(toggleSidebar)} collapsed={false} width={248}
      renderSlot={(name) => name === 'sidebar.settings' ? <button type="button" onClick={openSettings}>设置</button> : null}
      createPortal={createPortal} NewChatIcon={Icon} PanelIcon={Icon} startSession={() => {}} />)

    expect(screen.getByRole('complementary', { name: '任务导航' })).not.toBeNull()
    expect(screen.getByRole('navigation', { name: '会话与项目' })).not.toBeNull()

    act(() => {
      history.pushState({ restored: true }, '', '/settings')
      dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(screen.queryByRole('complementary', { name: '任务导航' })).toBeNull()
    expect(screen.queryByRole('navigation', { name: '会话与项目' })).toBeNull()
    expect(screen.queryByText('带目录的长消息')).toBeNull()
    expect(screen.queryByText('文件页与子任务')).toBeNull()
    expect(document.querySelector('[data-emate-mobile-open]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(openSettings).toHaveBeenCalledOnce()
    expect(toggleSidebar).not.toHaveBeenCalled()

    act(() => {
      history.replaceState(null, '', '/chat/long-chat')
      dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(screen.getByRole('navigation', { name: '会话与项目' })).not.toBeNull()

    act(() => {
      history.pushState(null, '', '/settings')
      dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(screen.queryByRole('navigation', { name: '会话与项目' })).toBeNull()
    expect(toggleSidebar).not.toHaveBeenCalled()
    view.unmount()

    history.replaceState({ restored: true }, '', '/settings')
    render(<SidebarRoot
      {...props(toggleSidebar)} collapsed width={0}
      renderSlot={(name) => name === 'sidebar.settings' ? <button type="button">设置</button> : null}
      createPortal={createPortal} NewChatIcon={Icon} PanelIcon={Icon} startSession={() => {}} />)
    expect(screen.queryByRole('navigation', { name: '会话与项目' })).toBeNull()
    expect(document.querySelector('[data-emate-mobile-open]')).toBeNull()
    expect(toggleSidebar).not.toHaveBeenCalled()
  })

  it('keeps chat navigation out of the accessibility tree after an update-status refresh remount', () => {
    history.replaceState(null, '', '/settings')
    const toggleSidebar = vi.fn()

    function SettingsShell() {
      const [refresh, setRefresh] = React.useState(0)
      return <>
        <nav aria-label="设置分类">
          <button type="button">个人资料</button>
          <button type="button">通用设置</button>
          <button type="button">电脑操作</button>
          <button type="button">文件提及</button>
        </nav>
        <button type="button" onClick={() => { setRefresh(value => value + 1) }}>
          再次检查更新（已更新至 2.0.17）
        </button>
        <SidebarRoot key={refresh}
          {...props(toggleSidebar)} collapsed={false} width={248}
          renderSlot={(name) => name === 'sidebar.settings' ? <button type="button">设置</button> : null}
          createPortal={createPortal} NewChatIcon={Icon} PanelIcon={Icon} startSession={() => {}} />
      </>
    }

    render(<SettingsShell />)
    fireEvent.click(screen.getByRole('button', { name: '再次检查更新（已更新至 2.0.17）' }))

    expect(location.pathname).toBe('/settings')
    expect(screen.getByRole('navigation', { name: '设置分类' })).not.toBeNull()
    for (const category of ['个人资料', '通用设置', '电脑操作', '文件提及']) {
      expect(screen.getByRole('button', { name: category })).not.toBeNull()
    }
    expect(screen.queryByRole('complementary', { name: '任务导航' })).toBeNull()
    expect(screen.queryByRole('navigation', { name: '会话与项目' })).toBeNull()
    expect(screen.queryByText('带目录的长消息')).toBeNull()
    expect(screen.queryByText('文件页与子任务')).toBeNull()
    expect(document.querySelector('[data-emate-mobile-open]')).toBeNull()
    expect(toggleSidebar).not.toHaveBeenCalled()
  })

  it('keeps the native Settings owner stable through three theme projections', async () => {
    history.replaceState(null, '', '/chat/long-chat')
    const themeListeners = new Set<() => void>()
    let scheme: 'light' | 'dark' = 'light'
    const toggleTheme = () => {
      scheme = scheme === 'light' ? 'dark' : 'light'
      document.body.toggleAttribute('data-ds-dark-theme', scheme === 'dark')
      themeListeners.forEach(listener => { listener() })
    }
    function SettingsHarness() {
      const [open, setOpen] = React.useState(false)
      return <>
        <button type="button" onClick={() => { setOpen(true) }}><SettingsTrigger wide SettingsIcon={Icon} /></button>
        <HeaderControls
          getThemeScheme={() => scheme}
          subscribeTheme={listener => { themeListeners.add(listener); return () => { themeListeners.delete(listener) } }}
          toggleTheme={toggleTheme}
          useSessions={selector => selector(sessionState)}
          callShare={() => Promise.resolve({})} useSessionLogDownload={selector => selector({ bySession: {} })}
          requestDownload={() => {}} dismissDownload={() => {}} LightIcon={Icon} DarkIcon={Icon}
        />
        {open && <div role="dialog" aria-modal="true">
          <nav aria-label="设置导航"><button type="button">个人资料</button><button type="button">通用设置</button><button type="button">电脑操作</button><button type="button">文件提及</button></nav>
          <SettingsChrome />
          <button type="button" onClick={() => { setOpen(false) }}><SettingsCloseLabel /></button>
        </div>}
      </>
    }

    render(<SettingsHarness />)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    await vi.waitFor(() => { expect(location.pathname).toBe('/settings') })
    await vi.waitFor(() => { expect(screen.queryByRole('button', { name: '设置' })).toBeNull() })
    for (let index = 0; index < 3; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: scheme === 'dark' ? '切换到明亮模式' : '切换到暗色模式' }))
      expect(location.pathname).toBe('/settings')
      expect(screen.getAllByRole('button', { name: scheme === 'dark' ? '切换到明亮模式' : '切换到暗色模式' })).toHaveLength(1)
      expect(screen.getAllByRole('button', { name: '关闭设置' })).toHaveLength(1)
      expect(screen.queryByLabelText('应用工具')).toBeNull()
      expect(screen.queryByRole('complementary', { name: '任务导航' })).toBeNull()
      expect(screen.queryByRole('button', { name: '设置' })).toBeNull()
    }
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    await vi.waitFor(() => { expect(location.pathname).toBe('/chat/long-chat') })

    act(() => {
      history.replaceState(null, '', '/')
      dispatchEvent(new PopStateEvent('popstate'))
    })
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    await vi.waitFor(() => { expect(location.pathname).toBe('/settings') })
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    await vi.waitFor(() => { expect(location.pathname).toBe('/') })
  })

  it('keeps a populated recovery group collapsed across project, route, and window lifecycles', () => {
    const orphanRows = Array.from({ length: 67 }, (_, index) => ({
      id: `orphan-${String(index)}`, blank: false, displayTitle: `旧新会话 ${String(index + 1)}`, updatedAt: index, running: false,
    }))
    const sessions = {
      ...sessionState,
      ids: ['project-session', ...orphanRows.map(row => row.id)],
      current: 'project-session',
      byId: {
        'project-session': { id: 'project-session', blank: false, displayTitle: '项目新会话', updatedAt: 100, running: false },
        ...Object.fromEntries(orphanRows.map(row => [row.id, row])),
      },
    }
    let workspaces = {
      items: [{ workspaceId: 'project-1', path: '/work/project-1', title: '项目一', sessionIds: ['project-session'] }],
      archivedSessionIds: [], phase: 'ready' as const,
    }
    const toggleSidebar = vi.fn()
    const sidebar = () => <SidebarRoot
      {...props(toggleSidebar)} collapsed={false} width={248}
      useSessions={selector => selector(sessions)} useWorkspaces={selector => selector(workspaces)}
      renderSlot={() => null} createPortal={createPortal} NewChatIcon={Icon} PanelIcon={Icon} startSession={() => {}} />
    const expectCollapsed = () => {
      const recovery = screen.getByRole('region', { name: '未分组' })
      expect(within(recovery).getByRole('button', { name: /未分组/u }).getAttribute('aria-expanded')).toBe('false')
      expect(recovery.textContent).toContain('67')
      expect(screen.queryByRole('button', { name: '打开任务：旧新会话 1' })).toBeNull()
    }

    history.replaceState(null, '', '/chat/project-session')
    const view = render(sidebar())
    expectCollapsed()

    workspaces = { ...workspaces, items: [...workspaces.items, { workspaceId: 'project-2', path: '/work/project-2', title: '项目二', sessionIds: [] }] }
    view.rerender(sidebar())
    expectCollapsed()

    act(() => {
      history.pushState(null, '', '/settings')
      dispatchEvent(new PopStateEvent('popstate'))
      history.pushState(null, '', '/chat/project-session')
      dispatchEvent(new PopStateEvent('popstate'))
    })
    expectCollapsed()

    view.unmount()
    history.replaceState({ restored: true }, '', '/chat/project-session')
    const restored = render(sidebar())
    expectCollapsed()

    fireEvent.click(within(screen.getByRole('region', { name: '未分组' })).getByRole('button', { name: /未分组/u }))
    expect(screen.getByRole('button', { name: '打开任务：旧新会话 1' })).not.toBeNull()
    restored.rerender(sidebar())
    expect(screen.getByRole('button', { name: '打开任务：旧新会话 1' })).not.toBeNull()
  })
})
