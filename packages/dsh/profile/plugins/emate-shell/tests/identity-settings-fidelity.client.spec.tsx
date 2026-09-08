// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountControl, AccountSettings } from '../src/client/account.tsx'
import { auraMorphProgress, auraPointCount } from '../src/client/aura-field.tsx'
import { IdentityGate, type IdentityBootstrap, type RpcResult } from '../src/client/identity.tsx'
import { SessionRouteProjection } from '../src/client/session-route.tsx'
import { SettingsChrome, SettingsCloseLabel, SettingsTrigger } from '../src/client/settings-chrome.tsx'

const useReadyWorkspaces = <T,>(selector: (state: { baselinesReady: boolean }) => T) => selector({ baselinesReady: true })

const agreements = {
  ready: true,
  bundle_sha256: 'bundle',
  required_acknowledgements: ['legal'],
  acknowledgements: [{ id: 'legal', label: '我已阅读并同意' }],
  documents: [],
}

const signedIn: IdentityBootstrap = {
  schema_version: 1,
  ready: true,
  authenticated: true,
  workspace_unlocked: true,
  display_name: '测试用户',
  account_status: 'active',
  weekly_token_limit: 10_000,
  agreement_receipt_id: 'agreement-receipt',
  agreements,
}

afterEach(() => {
  cleanup()
  document.querySelectorAll('[data-emate-identity-gate]').forEach(element => { element.remove() })
  history.replaceState(null, '', '/')
})

describe('e-Mate 2.0.17 identity and settings fidelity', () => {
  it('distinguishes a pending identity bootstrap from an unavailable service without unlocking early', async () => {
    let settle!: (value: RpcResult) => void
    const callIdentity = vi.fn(() => new Promise<RpcResult>(resolve => { settle = resolve }))
    render(<IdentityGate callIdentity={callIdentity} />)
    expect(screen.getByRole('heading', { name: '正在连接企业身份服务' })).toBeTruthy()
    expect(screen.queryByText('登录服务尚未就绪')).toBeNull()
    expect(screen.getByRole('button', { name: '正在检查…' }).getAttribute('disabled')).not.toBeNull()
    expect(document.querySelector('[data-emate-identity-gate]')).not.toBeNull()
    expect(callIdentity).toHaveBeenCalledTimes(1)
    await act(async () => { settle({ ok: false, error: { message: '身份服务连接失败' } }) })
    expect(screen.getByRole('heading', { name: '登录服务尚未就绪' })).toBeTruthy()
    expect(screen.getByText('身份服务连接失败')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新检查' }).getAttribute('disabled')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }))
    expect(screen.getByRole('heading', { name: '正在连接企业身份服务' })).toBeTruthy()
    await act(async () => { settle({ ok: true, value: signedIn }) })
    expect(document.querySelector('[data-emate-identity-gate]')).toBeNull()
  })

  it('keeps the AURA login contract and current SettingsDialog copy', () => {
    const identity = readFileSync(join(process.cwd(), 'src/client/identity.module.css'), 'utf8')
    const identityView = readFileSync(join(process.cwd(), 'src/client/identity.tsx'), 'utf8')
    const aura = readFileSync(join(process.cwd(), 'src/client/aura-field.tsx'), 'utf8')
    const sidebar = readFileSync(join(process.cwd(), 'src/client/sidebar.module.css'), 'utf8')

    expect(auraPointCount(640)).toBe(4_200)
    expect(auraPointCount(641)).toBe(11_000)
    expect(auraMorphProgress(3)).toBe(1)
    expect(auraMorphProgress(8)).toBe(0)
    expect(aura).toContain('vec3 fieldColor = vec3(0.5, 0.5, 0.5);')
    expect(aura).toContain('narrow ? 0 : aspect * 0.34')
    expect(aura).toContain('const widthFraction = narrow ? 0.74 : 0.46')
    expect(aura).toContain('const maximumWordHeight = narrow ? 0.18 : 0.32')
    expect(aura).toContain('narrow ? -0.74 : -0.36')
    expect(identityView).toContain("import { AuraField } from './aura-field.tsx'")
    expect(identityView).not.toContain("import('./aura-field")
    expect(identityView).not.toContain('lazy(() =>')
    expect(identity).toContain('grid-template-columns: minmax(0, 1fr) minmax(360px, 456px);')
    expect(identity).toContain('width: min(456px, 100%);')
    expect(identity).toContain('border-radius: 12px;')
    expect(aura).toContain("document.addEventListener('visibilitychange', updateVisibility)")
    expect(aura).toContain('cancelAnimationFrame(frame)')
    expect(aura).toContain("gl.getExtension('WEBGL_lose_context')?.loseContext()")
    expect(sidebar).not.toContain(":global(body[data-dsh-desktop-mode='advanced']) .root")
    expect(sidebar).toContain('background: var(--emate-canvas);')
    expect(sidebar).not.toContain('backdrop-filter')

    render(<SettingsChrome />)
    expect(screen.getByRole('heading', { name: '设置' })).toBeTruthy()
    expect(screen.getByText('管理个人资料、常规设置、知识和记忆。')).toBeTruthy()
  })

  it('renders the branded AURA login copy on the explicit login route without changing the RPC seam', async () => {
    history.replaceState(null, '', '/login')
    const callIdentity = vi.fn(async (endpoint: string): Promise<RpcResult> => endpoint === 'identity.bootstrap'
      ? {
          ok: true,
          value: {
            schema_version: 1,
            ready: true,
            authenticated: false,
            workspace_unlocked: false,
            agreements,
          },
        }
      : { ok: false, error: { message: 'unexpected call' } })

    const view = render(<IdentityGate callIdentity={callIdentity} />)
    expect(await screen.findByRole('heading', { name: '欢迎回来' })).toBeTruthy()
    expect(screen.getByText('登录 e-Mate，继续与小芯协作')).toBeTruthy()
    expect(screen.getByText('全场景办公 AI Agent')).toBeTruthy()
    expect(screen.getByText(/e‑Mate 是由亦芯打造的桌面端 AI Agent/)).toBeTruthy()
    expect(screen.getByAltText('e-Mate')).toBeTruthy()
    expect(document.querySelector('[data-aura-field]')).toBeTruthy()
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy()
    view.unmount()
  })

  it('does not rewrite native localized Settings content', () => {
    render(<div role="dialog"><button type="button">插件</button><p>DeepSeek 搜索提供方。</p><SettingsChrome /></div>)
    expect(screen.getByText('插件')).toBeTruthy()
    expect(screen.getByText('DeepSeek 搜索提供方。')).toBeTruthy()
  })

  it('hides only stable engineering section ids without removing their native buttons or observing text', () => {
    render(<div role="dialog">
      <nav>
        <button type="button" data-settings-section-id="general">个人资料</button>
        <button type="button" data-settings-section-id="models">模型</button>
        <button type="button" data-settings-section-id="plugins">插件</button>
        <button type="button" data-settings-section-id="agent-presets">Agent 预设</button>
        <button type="button" data-settings-section-id="vision-toolkit">视觉工具</button>
        <button type="button" data-settings-section-id="capabilities">能力中心</button>
      </nav>
      <SettingsChrome />
    </div>)
    const profile = screen.getByRole('button', { name: '个人资料' }) as HTMLButtonElement
    const models = screen.getByText('模型').closest('button') as HTMLButtonElement
    const plugins = screen.getByText('插件').closest('button') as HTMLButtonElement
    const presets = screen.getByText('Agent 预设').closest('button') as HTMLButtonElement
    const visionToolkit = screen.getByText('视觉工具').closest('button') as HTMLButtonElement
    const capabilities = screen.getByRole('button', { name: '能力中心' }) as HTMLButtonElement
    expect(profile.hidden).toBe(false)
    expect(capabilities.hidden).toBe(false)
    expect(models.hidden).toBe(true)
    expect(plugins.hidden).toBe(true)
    expect(presets.hidden).toBe(true)
    expect(visionToolkit.hidden).toBe(true)
    expect(document.querySelectorAll('[data-settings-section-id]')).toHaveLength(6)
    const source = readFileSync(join(process.cwd(), 'src/client/settings-chrome.tsx'), 'utf8')
    expect(source).not.toContain('SETTINGS_BRAND_COPY')
    expect(source).not.toContain('createTreeWalker')
    expect(source).not.toContain('characterData')
  })

  it('ignores unrelated token mutations while retaining settings route synchronization', async () => {
    const Icon = () => <svg />
    const view = render(<button type="button"><SettingsTrigger wide SettingsIcon={Icon} /></button>)
    const documentQuery = vi.spyOn(document, 'querySelector')
    const stream = document.createElement('div')
    view.container.append(stream)
    await act(async () => {
      for (let index = 0; index < 50; index += 1) stream.append(document.createElement('span'))
      await Promise.resolve()
    })
    expect(documentQuery).not.toHaveBeenCalled()

    const settings = document.createElement('div')
    settings.dataset.emateSettingsContent = ''
    await act(async () => {
      view.container.append(settings)
      await Promise.resolve()
    })
    expect(location.pathname).toBe('/settings')
    expect(documentQuery).toHaveBeenCalled()
    documentQuery.mockRestore()
  })

  it('returns from the native Settings close control to the chat route without browser Back', async () => {
    const Icon = () => <svg />
    function NativeSettingsHarness() {
      const [open, setOpen] = React.useState(false)
      return <>
        <button type="button" onClick={() => { setOpen(true) }}><SettingsTrigger wide SettingsIcon={Icon} /></button>
        {open && <div role="dialog" aria-modal="true">
          <button type="button" onClick={() => { setOpen(false) }}><SettingsCloseLabel /></button>
          <SettingsChrome />
        </div>}
      </>
    }

    history.replaceState(null, '', '/chat/session-21')
    const browserBack = vi.spyOn(history, 'back').mockImplementation(() => {})
    render(<NativeSettingsHarness />)

    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    await waitFor(() => { expect(location.pathname).toBe('/settings') })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '设置' })).toBeNull()
    const trigger = document.querySelector('[data-emate-settings-trigger]')?.closest('button')
    expect(trigger?.inert).toBe(true)
    expect(trigger?.getAttribute('aria-hidden')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    await waitFor(() => {
      expect(location.pathname).toBe('/chat/session-21')
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.getByRole('button', { name: '设置' })).toBeTruthy()
    })
    expect(browserBack).not.toHaveBeenCalled()
  })

  it('keeps registration, verification and pending approval on the target RPC seam', async () => {
    history.replaceState(null, '', '/login')
    const shellRoot = document.createElement('div')
    shellRoot.id = 'root'
    shellRoot.style.width = '432px'
    document.body.append(shellRoot)
    const targetPortal = document.createElement('button')
    targetPortal.setAttribute('aria-label', '关闭任务导航')
    const initialPortalInert = targetPortal.inert
    document.body.append(targetPortal)
    const callIdentity = vi.fn(async (endpoint: string): Promise<RpcResult> => {
      if (endpoint === 'identity.bootstrap') return {
        ok: true,
        value: {
          schema_version: 1,
          ready: true,
          authenticated: false,
          workspace_unlocked: false,
          agreements,
        },
      }
      if (endpoint === 'verification.issue') return {
        ok: true,
        value: {
          schema_version: 1,
          challenge_id: 'challenge',
          image_data_url: 'data:image/png;base64,AA==',
          expires_at: '2026-08-15T00:00:00Z',
        },
      }
      if (endpoint === 'session.register') return {
        ok: true,
        value: { schema_version: 1, registration_id: 'registration', status: 'pending_approval' },
      }
      return { ok: false, error: { message: 'unexpected call' } }
    })

    const view = render(<IdentityGate callIdentity={callIdentity} />)
    await waitFor(() => {
      expect(shellRoot.hidden).toBe(true)
      expect(targetPortal.hidden).toBe(true)
      expect(targetPortal.inert).toBe(true)
    })
    fireEvent.click(await screen.findByRole('button', { name: '注册新账号' }))
    fireEvent.change(await screen.findByLabelText('账号'), { target: { value: 'test@example.com' } })
    fireEvent.change(screen.getByLabelText('真实姓名'), { target: { value: '测试用户' } })
    fireEvent.change(screen.getByLabelText('密码（至少 10 位）'), { target: { value: 'safe-password' } })
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'different-password' } })
    fireEvent.change(await screen.findByLabelText('验证码'), { target: { value: 'ABCD' } })
    expect(screen.getByRole('alert').textContent).toBe('两次输入的密码不一致。')
    expect((screen.getByRole('button', { name: '提交注册申请' }) as HTMLButtonElement).disabled).toBe(true)
    expect(callIdentity).not.toHaveBeenCalledWith('session.register', expect.anything())
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'safe-password' } })
    fireEvent.click(screen.getByRole('button', { name: '提交注册申请' }))

    expect(await screen.findByRole('heading', { name: '注册申请已提交' })).toBeTruthy()
    expect(callIdentity).toHaveBeenCalledWith('session.register', {
      account: 'test@example.com',
      real_name: '测试用户',
      password: 'safe-password',
      challenge_id: 'challenge',
      verification_code: 'ABCD',
    })
    view.unmount()
    expect(shellRoot.hidden).toBe(false)
    expect(targetPortal.hidden).toBe(false)
    expect(targetPortal.inert).toBe(initialPortalInert)
    targetPortal.remove()
    shellRoot.remove()
  })

  it('keeps a local chat deep link available while enterprise identity refresh is pending', async () => {
    history.replaceState(null, '', '/chat/performance-session')
    let unlock!: (result: RpcResult) => void
    const callIdentity = vi.fn(() => new Promise<RpcResult>(resolve => { unlock = resolve }))
    const openSession = vi.fn()
    let markSessionsReady!: () => void

    function Runtime() {
      const [sessions, setSessions] = React.useState<{
        phase: 'pending' | 'ready'
        current?: string
        byId: Record<string, unknown>
      }>({ phase: 'pending', byId: {} })
      const latest = React.useRef(sessions)
      latest.current = sessions
      markSessionsReady = () => {
        setSessions({ phase: 'ready', byId: { 'performance-session': {} } })
      }
      return <>
        <IdentityGate callIdentity={callIdentity} />
        <SessionRouteProjection
          useSessions={selector => selector(sessions)}
          useWorkspaces={useReadyWorkspaces}
          getSessions={() => latest.current}
          openSession={openSession}
        />
      </>
    }

    render(<Runtime />)

    expect(location.pathname).toBe('/chat/performance-session')
    act(() => { markSessionsReady() })
    await waitFor(() => { expect(openSession).toHaveBeenCalledWith('performance-session') })
    unlock({ ok: true, value: signedIn })
    await act(async () => { await Promise.resolve() })
    expect(location.pathname).toBe('/chat/performance-session')
  })

  it('keeps a true no-Session Home inert and preserves exact chat deep links', async () => {
    const openSession = vi.fn()
    const state = { phase: 'ready' as const, current: undefined, byId: { other: {} } }
    const view = render(<SessionRouteProjection
      useSessions={selector => selector(state)}
      useWorkspaces={useReadyWorkspaces}
      getSessions={() => state}
      openSession={openSession}
    />)

    expect(location.pathname).toBe('/')
    expect(openSession).not.toHaveBeenCalled()

    history.pushState(null, '', '/chat/missing')
    act(() => { dispatchEvent(new PopStateEvent('popstate')) })
    expect(location.pathname).toBe('/')
    expect(openSession).not.toHaveBeenCalled()

    history.pushState(null, '', '/chat/other')
    act(() => { dispatchEvent(new PopStateEvent('popstate')) })
    expect(openSession).toHaveBeenCalledWith('other')
    view.unmount()
  })

  it('waits for the native Workspace baseline before projecting the current Session route', async () => {
    const state = { phase: 'ready' as const, current: 'project', byId: { project: {} } }
    let workspacesReady = false
    const route = () => <SessionRouteProjection
      useSessions={selector => selector(state)}
      useWorkspaces={selector => selector({ baselinesReady: workspacesReady })}
      getSessions={() => state}
      openSession={() => {}}
    />

    const view = render(route())
    expect(location.pathname).toBe('/')
    workspacesReady = true
    view.rerender(route())
    await waitFor(() => { expect(location.pathname).toBe('/chat/project') })
    view.unmount()
  })

  it('keeps a standalone product route when the current Session changes behind it', async () => {
    history.replaceState(null, '', '/capabilities?category=collaboration')
    let selectSession!: (id: string) => void
    const popstate = vi.fn()
    addEventListener('popstate', popstate)

    function Runtime() {
      const [current, setCurrent] = React.useState('session-1')
      selectSession = setCurrent
      const state = { phase: 'ready' as const, current, byId: { 'session-1': {}, 'session-2': {} } }
      return <SessionRouteProjection
        useSessions={selector => selector(state)}
        useWorkspaces={useReadyWorkspaces}
        getSessions={() => state}
        openSession={() => {}}
      />
    }

    const view = render(<Runtime />)
    expect(location.pathname).toBe('/capabilities')
    act(() => { selectSession('session-2') })
    expect(location.pathname).toBe('/capabilities')
    expect(popstate).not.toHaveBeenCalled()
    removeEventListener('popstate', popstate)
    view.unmount()
  })

  it('keeps the same stable route before and after a blank Session sends its first prompt', async () => {
    history.replaceState(null, '', '/')
    let markSent!: () => void

    function Runtime() {
      const [blank, setBlank] = React.useState(true)
      markSent = () => { setBlank(false) }
      const state = {
        phase: 'ready' as const,
        current: 'session-1',
        byId: { 'session-1': { blank } },
      }
      return <SessionRouteProjection
        useSessions={selector => selector(state)}
        useWorkspaces={useReadyWorkspaces}
        getSessions={() => state}
        openSession={() => {}}
      />
    }

    const view = render(<Runtime />)
    await waitFor(() => { expect(location.pathname).toBe('/chat/session-1') })
    act(markSent)
    expect(location.pathname).toBe('/chat/session-1')
    view.unmount()
  })

  it('notifies Shell route consumers when session selection pushes a chat URL', () => {
    history.replaceState(null, '', '/chat/session-1')
    let selectSession!: (id: string) => void
    const popstate = vi.fn()
    addEventListener('popstate', popstate)

    function Runtime() {
      const [current, setCurrent] = React.useState('session-1')
      selectSession = setCurrent
      const state = { phase: 'ready' as const, current, byId: { 'session-1': {}, 'session-2': {} } }
      return <SessionRouteProjection
        useSessions={selector => selector(state)}
        useWorkspaces={useReadyWorkspaces}
        getSessions={() => state}
        openSession={() => {}}
      />
    }

    const view = render(<Runtime />)
    act(() => { selectSession('session-2') })
    expect(location.pathname).toBe('/chat/session-2')
    expect(popstate).toHaveBeenCalledOnce()
    removeEventListener('popstate', popstate)
    view.unmount()
  })

  it('keeps account password on the existing identity RPC seam', async () => {
    const callIdentity = vi.fn(async (endpoint: string): Promise<RpcResult> => {
      if (endpoint === 'identity.bootstrap') return { ok: true, value: signedIn }
      if (endpoint === 'identity.usage') return {
        ok: true,
        value: {
          schema_version: 1,
          scope: 'account',
          timezone: 'Asia/Shanghai',
          week: { total_tokens: 2_500 },
          week_started_at: '2026-08-10T16:00:00.000Z',
          calculated_at: '2026-08-15T00:00:00.000Z',
        },
      }
      return { ok: false, error: { message: '测试改密拒绝' } }
    })
    const Icon = () => <svg />
    const account = render(<AccountControl
      callIdentity={callIdentity}
      wide
      UserIcon={Icon}
      expandSidebar={() => {}}
    />)
    fireEvent.click(await screen.findByLabelText('用户中心，测试用户'))
    expect(await screen.findByText('2.5K / 10K Token')).toBeTruthy()
    expect((screen.getByRole('progressbar', { name: '本周 Token 用量' }) as HTMLProgressElement).value).toBe(2_500)
    fireEvent.click(await screen.findByRole('button', { name: '退出登录' }))
    expect(await screen.findByRole('dialog', { name: '退出 e-Mate？' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: '退出 e-Mate？' })).toBeNull() })
    account.unmount()

    const { unmount } = render(<AccountSettings callIdentity={callIdentity} />)

    expect(await screen.findByText('测试用户')).toBeTruthy()
    expect(screen.getByText(/每周 Token 额度 10K/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'old-password' } })
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'new-password' } })
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'new-password' } })
    fireEvent.click(screen.getByRole('button', { name: '修改密码' }))
    await waitFor(() => { expect(callIdentity).toHaveBeenCalledWith('session.password', expect.objectContaining({
      current_password: 'old-password',
      new_password: 'new-password',
    })) })
    unmount()

    const administrator = render(<AccountSettings callIdentity={vi.fn(async (): Promise<RpcResult> => ({
      ok: true,
      value: { ...signedIn, agreement_exempt: true, agreement_receipt_id: undefined },
    }))} />)
    expect(await screen.findByText(/管理员无需签署用户协议/u)).toBeTruthy()
    administrator.unmount()

  })

  it('projects an unknown remote logout as locally signed out without a receipt or a 500 error', async () => {
    const signedOut: IdentityBootstrap = {
      schema_version: 1,
      ready: true,
      authenticated: false,
      workspace_unlocked: false,
      agreements,
    }
    let loggedOut = false
    const callIdentity = vi.fn(async (endpoint: string): Promise<RpcResult> => {
      if (endpoint === 'identity.bootstrap') return { ok: true, value: loggedOut ? signedOut : signedIn }
      if (endpoint === 'session.logout') {
        loggedOut = true
        return {
          ok: true,
          value: {
            schema_version: 1,
            remote_revocation: 'unknown',
            state: signedOut,
          },
        }
      }
      return { ok: false, error: { message: '用量暂不可用' } }
    })
    const Icon = () => <svg />

    render(<IdentityGate callIdentity={callIdentity} />)
    render(<AccountControl callIdentity={callIdentity} wide UserIcon={Icon} expandSidebar={() => {}} />)
    fireEvent.click(await screen.findByLabelText('用户中心，测试用户'))
    fireEvent.click(await screen.findByRole('button', { name: '退出登录' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '退出登录' }))

    await waitFor(() => { expect(location.pathname).toBe('/login') })
    expect(screen.getByRole('heading', { name: '欢迎回来' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('本机已退出；企业会话撤销状态未知，请稍后重新登录确认。')
    expect(document.body.textContent).not.toContain('500')
    expect(callIdentity.mock.calls.filter(([endpoint]) => endpoint === 'session.logout')).toHaveLength(1)
  })

  it('locks the workspace when Host logout succeeds but its RPC response is lost', async () => {
    history.replaceState(null, '', '/chat/logout-response-lost')
    let loggedOut = false
    const signedOut = { ...signedIn, authenticated: false, workspace_unlocked: false }
    const callIdentity = vi.fn(async (endpoint: string): Promise<RpcResult> => {
      if (endpoint === 'identity.bootstrap') return { ok: true, value: loggedOut ? signedOut : signedIn }
      if (endpoint === 'session.logout') {
        loggedOut = true
        throw new Error('synthetic response lost after Host cleared credentials')
      }
      return { ok: false }
    })
    const Icon = () => <svg />
    render(<IdentityGate callIdentity={callIdentity} />)
    render(<AccountControl callIdentity={callIdentity} wide UserIcon={Icon} expandSidebar={() => {}} />)
    fireEvent.click(await screen.findByLabelText('用户中心，测试用户'))
    fireEvent.click(await screen.findByRole('button', { name: '退出登录' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '退出登录' }))
    await waitFor(() => expect(location.pathname).toBe('/login'))
    expect(screen.getByRole('heading', { name: '欢迎回来' })).toBeTruthy()
    expect(callIdentity.mock.calls.filter(([endpoint]) => endpoint === 'session.logout')).toHaveLength(1)
  })

  it('rejects mismatched logout receipt states without restoring or fabricating identity', async () => {
    const signedOut: IdentityBootstrap = {
      schema_version: 1,
      ready: true,
      authenticated: false,
      workspace_unlocked: false,
      agreements,
    }
    const Icon = () => <svg />
    for (const invalid of [
      { schema_version: 1, remote_revocation: 'revoked', state: signedOut },
      { schema_version: 1, remote_revocation: 'unknown', receipt_id: 'fabricated-receipt', state: signedOut },
    ]) {
      const callIdentity = vi.fn(async (endpoint: string): Promise<RpcResult> => endpoint === 'identity.bootstrap'
        ? { ok: true, value: signedIn }
        : endpoint === 'session.logout'
          ? { ok: true, value: invalid }
          : { ok: false, error: { message: '用量暂不可用' } })
      const view = render(<AccountControl callIdentity={callIdentity} wide UserIcon={Icon} expandSidebar={() => {}} />)
      fireEvent.click(await screen.findByLabelText('用户中心，测试用户'))
      fireEvent.click(await screen.findByRole('button', { name: '退出登录' }))
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '退出登录' }))
      expect((await within(screen.getByRole('dialog')).findByRole('alert')).textContent).toBe('退出登录暂未完成，请稍后重试。')
      expect(callIdentity.mock.calls.filter(([endpoint]) => endpoint === 'session.logout')).toHaveLength(1)
      view.unmount()
    }
  })

  it('renders an unlimited weekly quota without exposing its numeric sentinel', async () => {
    const unlimitedState = { ...signedIn, weekly_token_limit: Number.MAX_SAFE_INTEGER }
    const callIdentity = vi.fn(async (endpoint: string): Promise<RpcResult> => endpoint === 'identity.usage'
      ? {
          ok: true,
          value: {
            schema_version: 1,
            scope: 'account',
            timezone: 'Asia/Shanghai',
            week: { total_tokens: 2_500 },
            week_started_at: '2026-08-10T16:00:00.000Z',
            calculated_at: '2026-08-15T00:00:00.000Z',
          },
        }
      : { ok: true, value: unlimitedState })
    const Icon = () => <svg />

    const account = render(<AccountControl callIdentity={callIdentity} wide UserIcon={Icon} expandSidebar={() => {}} />)
    fireEvent.click(await screen.findByLabelText('用户中心，测试用户'))
    expect(await screen.findByText('2.5K Token · 不限额度')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '本周 Token 用量' }).getAttribute('aria-valuetext')).toBe('无限额度，已使用 2.5K Token')
    expect(document.body.textContent).not.toContain(Number.MAX_SAFE_INTEGER.toLocaleString('zh-CN'))
    account.unmount()

    render(<AccountSettings callIdentity={callIdentity} />)
    expect(await screen.findByText(/每周 Token 额度 不限；/u)).toBeTruthy()
    expect(document.body.textContent).not.toContain(Number.MAX_SAFE_INTEGER.toLocaleString('zh-CN'))
  })

  it('previews a validated avatar locally without adding an identity RPC', async () => {
    const callIdentity = vi.fn(async (): Promise<RpcResult> => ({ ok: true, value: signedIn }))
    render(<AccountSettings callIdentity={callIdentity} />)

    const input = await screen.findByLabelText('选择头像图片')
    await waitFor(() => { expect(callIdentity).toHaveBeenCalledTimes(2) })
    expect(screen.getByText('头像').closest('div')?.parentElement?.querySelectorAll('svg')).toHaveLength(2)
    fireEvent.change(input, { target: { files: [new File(['not-an-image'], 'avatar.gif', { type: 'image/gif' })] } })
    expect(await screen.findByText('请选择 PNG、JPEG 或 WebP 图片。')).toBeTruthy()

    fireEvent.change(input, { target: { files: [new File(['avatar'], 'avatar.png', { type: 'image/png' })] } })
    expect((await screen.findByRole('img', { name: '当前头像' })).getAttribute('src')).toMatch(/^data:image\/png;base64,/u)
    expect(callIdentity).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    expect(screen.queryByRole('img', { name: '当前头像' })).toBeNull()
  })
})
