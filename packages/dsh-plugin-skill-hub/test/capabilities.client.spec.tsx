// @vitest-environment jsdom
import React from 'react'
import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SlotTestRuntime } from '../../../upstream/deepseek-harness/packages/test-support/client-runtime/lib/index.js'
import { apply as registerNativeLayout, inject as nativeLayoutInject } from '../../../upstream/deepseek-harness/packages/client/ui-layout/src/client/index.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerRouteScopedConversationHeader } from '../../dsh/profile/plugins/emate-shell/src/client/index.ts'
import { CapabilitiesPage, CapabilityControl } from '../src/client/capabilities.tsx'
import { apply as registerSkillHub, inject as skillHubInject } from '../src/client/index.tsx'
import { skillHubSuccess } from '../src/result.ts'

const SHA256 = 'a'.repeat(64)
const Icon = () => <svg aria-hidden="true" />

const capabilityItems = [
  { id: 'office-live', title: 'Office', summary: '创建与编辑办公文档', icon_key: 'office', order: 2, state: 'ready', actions: [{ id: 'check', label: '自检', kind: 'secondary' }] },
  { id: 'image-live', title: '生图与改图', summary: '使用当前图像模型', icon_key: 'image', order: 1, state: 'setup-required', actions: [{ id: 'key', label: '配置凭据', kind: 'primary', input: 'credential', credential_ref: 'IMAGE_API_KEY' }] },
] as const

const hubCard = {
  slug: 'meeting-notes',
  version: '1.2.3',
  package_sha256: SHA256,
  title: '会议纪要',
  summary: '把会议内容整理成行动项。',
  category: 'office_productivity',
  tags: ['office', 'meeting'],
  package_size_bytes: 512,
  uploader: { nickname: '共享用户', author_ref: `author_${'b'.repeat(24)}` },
  provenance: { brand: 'e-Mate', original_platform: null, original_url: null },
  installation_status: 'not_installed',
  readiness: 'ready',
} as const

const installedSkill = {
  slug: 'installed-skill', version: '1.0.0', package_sha256: SHA256, status: 'installed',
  description: '真实 DSH Skill Hub Skill', invocation: { modelInvocable: true, userInvocable: true },
  ready: true, recovery_pending: false,
} as const

beforeEach(() => {
  history.replaceState(null, '', '/capabilities')
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.removeAttribute('data-ds-dark-theme')
  history.replaceState(null, '', '/')
})

function renderPage(callSkillHub = vi.fn(async (endpoint: string) => {
  if (endpoint === 'catalog.search') return { ok: true, value: { items: [hubCard], next_cursor: null } }
  if (endpoint === 'catalog.detail') return { ok: true, value: { schema_version: 1, skill: hubCard, versions: [hubCard], next_cursor: null } }
  if (endpoint === 'inventory.list') return { ok: true, value: { schema_version: 1, items: [installedSkill] } }
  if (endpoint === 'jobs.list') return { ok: true, value: { items: [] } }
  return { ok: true, value: { job_id: 'job-12345678', status: 'running' } }
})) {
  const callCapabilities = vi.fn(async (endpoint: string) => endpoint === 'list'
    ? { ok: true, value: { schema_version: 1, items: capabilityItems } }
    : { ok: true, value: { accepted: true } })
  const setCredential = vi.fn(async () => ({ ok: true, value: {} }))
  render(<><div data-phase="product" /><div data-shell-overlay=""><CapabilitiesPage
    callCapabilities={callCapabilities}
    callSkillHub={callSkillHub}
    setCredential={setCredential}
    SearchIcon={Icon}
    DownloadIcon={Icon}
    CloseIcon={Icon}
    RefreshIcon={Icon}
    SkillIcon={Icon}
    capabilityIcons={{ browser: Icon, collaboration: Icon, image: Icon, office: Icon, ocr: Icon }}
  /></div></>)
  return { callCapabilities, callSkillHub, setCredential }
}

describe('capability center fidelity surface', () => {
  it('uses stable primary-action identity with tooltip, selected state, and the existing route', () => {
    history.replaceState(null, '', '/')
    render(<CapabilityControl wide active SkillIcon={Icon} />)
    const control = screen.getByRole('button', { name: '能力中心' })
    expect(control.getAttribute('data-emate-primary-action')).toBe('')
    expect(control.getAttribute('title')).toBe('能力中心')
    expect(control.getAttribute('aria-current')).toBe('page')
    fireEvent.click(control)
    expect(location.pathname).toBe('/capabilities')
  })

  it('uses its registered overlay as the standalone page host and preserves the complete Skill Hub surface', async () => {
    renderPage()
    const page = document.querySelector<HTMLElement>('[data-emate-capabilities]')
    const hub = await screen.findByRole('region', { name: 'Skill Hub' })
    const builtins = screen.getByText('本机内置能力').closest('details')
    const overlay = document.querySelector('[data-shell-overlay]')

    expect(page?.parentElement).toBe(overlay)
    expect(hub.compareDocumentPosition(builtins!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('tab', { name: '发现' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /已安装/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '导入' })).toBeTruthy()

    const styles = readFileSync('src/client/capabilities.module.css', 'utf8')
    expect(styles).toMatch(/\.page\s*\{[\s\S]*?background:\s*var\(--workspace-surface\)/u)
    expect(styles).toMatch(/\.workspace\s*\{[\s\S]*?width:\s*min\(1180px, calc\(100% - 8px\)\);[\s\S]*?height:\s*calc\(100% - 16px\);[\s\S]*?margin:\s*8px auto;[\s\S]*?border:\s*1px solid var\(--rule\);[\s\S]*?border-radius:\s*16px;[\s\S]*?background:\s*var\(--workspace-surface\)/u)
  })

  it('keeps one page in the real root overlay while route-owned phase nodes turn over', async () => {
    const runtime = await SlotTestRuntime.create()
    const snapshot = (colorScheme: 'light' | 'dark') => {
      const active = { id: `${colorScheme}-test`, colorScheme, tokens: {} }
      return { preference: colorScheme, active, themes: [active], revision: colorScheme === 'light' ? 1 : 2 }
    }
    runtime.provide('theme', { getTheme: () => snapshot('light') } as never)
    runtime.provide('connection', {
      rpc: { call: vi.fn(async (route: string, endpoint: string) => {
        if (route === '/emate.capabilities') return { ok: true, value: { schema_version: 1, items: capabilityItems } }
        if (endpoint === 'catalog.search') return { ok: true, value: skillHubSuccess({ items: [hubCard], next_cursor: null }) }
        if (endpoint === 'inventory.list') return { ok: true, value: skillHubSuccess({ schema_version: 1, items: [installedSkill] }) }
        if (endpoint === 'jobs.list') return { ok: true, value: skillHubSuccess({ items: [] }) }
        return { ok: true, value: skillHubSuccess({}) }
      }) },
      api: { credentials: { set: vi.fn(async () => ({ result: { ok: true, value: {} } })) } },
    } as never)

    try {
      await runtime.mount({ inject: [...nativeLayoutInject], apply: registerNativeLayout })
      runtime.slots.register({ name: 'conversation' } as never, () => <div data-phase="active" />)
      const view = runtime.renderRoot()
      await runtime.mount({ inject: ['slots', 'layout'], apply: registerRouteScopedConversationHeader })
      await runtime.mount({ inject: [...skillHubInject], apply: registerSkillHub })
      await runtime.flush()
      const overlay = view.container.querySelector('[data-shell-overlay]')
      const overlaySlot = overlay?.querySelector('[data-slot="shell.overlay"]')
      const root = overlay?.parentElement
      let phase = view.container.querySelector('[data-phase]')

      await waitFor(() => expect(overlay?.querySelectorAll('[data-emate-capabilities]')).toHaveLength(1))
      expect(phase?.getAttribute('data-phase')).toBe('product')
      expect(view.container.querySelector('[data-emate-capabilities]')?.parentElement).toBe(overlaySlot)
      expect(view.container.querySelectorAll('[data-emate-capabilities]')).toHaveLength(1)
      for (let index = 0; index < 3; index += 1) {
        if (index > 0) runtime.ctx.emit('theme/change', snapshot(index === 1 ? 'dark' : 'light') as never)
        view.rerender(runtime.slots.renderSlot('root', {}))
        expect(view.container.querySelector('[data-shell-overlay]')?.parentElement).toBe(root)
        expect(view.container.querySelector('[data-shell-overlay]')).toBe(overlay)
        expect(overlay?.querySelector('[data-slot="shell.overlay"]')).toBe(overlaySlot)
        expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(index === 1)
        expect(overlaySlot?.querySelectorAll('[data-emate-capabilities]')).toHaveLength(1)
        expect(view.container.querySelector('[data-emate-capabilities]')?.parentElement).toBe(overlaySlot)

        history.pushState(null, '', `/chat/session-${index}`)
        fireEvent.popState(window)
        await runtime.flush()
        expect(view.container.querySelectorAll('[data-emate-capabilities]')).toHaveLength(0)
        const activePhase = view.container.querySelector('[data-phase]')
        expect(activePhase).not.toBe(phase)
        expect(activePhase?.getAttribute('data-phase')).toBe('active')
        expect(view.container.querySelector('[data-emate-product-surface]')).toBeNull()
        phase = activePhase

        history.pushState(null, '', '/capabilities')
        fireEvent.popState(window)
        await runtime.flush()
        await waitFor(() => expect(overlay?.querySelectorAll('[data-emate-capabilities]')).toHaveLength(1))
        expect(view.container.querySelectorAll('[data-emate-capabilities]')).toHaveLength(1)
        expect(view.container.querySelector('[data-emate-capabilities]')?.parentElement).toBe(overlaySlot)
        expect(view.container.querySelector('[data-phase]')).not.toBe(phase)
        phase = view.container.querySelector('[data-phase]')
        expect(phase?.getAttribute('data-phase')).toBe('product')
        expect(view.container.querySelectorAll('[data-emate-product-surface]')).toHaveLength(1)
      }
    } finally {
      await runtime.dispose()
    }
  })

  it('keeps dynamic capability categories and real capability actions live', async () => {
    const { callCapabilities } = renderPage()
    expect(await screen.findByText('生图与改图')).toBeTruthy()
    expect(screen.getByText('Office')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /办公能力/ }))
    expect(screen.queryByText('生图与改图')).toBeNull()
    expect(screen.getByText('Office')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '自检' }))
    await waitFor(() => expect(callCapabilities).toHaveBeenCalledWith('action', {
      capability_id: 'office-live',
      action_id: 'check',
      data: {},
    }))
    expect(await screen.findByText('Office 已提交操作。')).toBeTruthy()
  })

  it('writes secrets only through the native credential channel', async () => {
    const { callCapabilities, setCredential } = renderPage()
    fireEvent.click(await screen.findByRole('button', { name: '配置凭据' }))
    const input = screen.getByLabelText('API Key')
    expect(input.getAttribute('type')).toBe('password')
    fireEvent.change(input, { target: { value: 'secret-for-native-credential-channel' } })
    fireEvent.click(screen.getByRole('button', { name: '安全保存' }))
    await waitFor(() => expect(setCredential).toHaveBeenCalledWith('IMAGE_API_KEY', 'secret-for-native-credential-channel'))
    expect(callCapabilities.mock.calls.some(([, payload]) => JSON.stringify(payload).includes('secret-for-native-credential-channel'))).toBe(false)
    expect(await screen.findByText('生图与改图 凭据已安全保存。')).toBeTruthy()
  })

  it('opens the real Hub detail and starts its download job', async () => {
    const { callSkillHub } = renderPage()
    fireEvent.click(await screen.findByRole('button', { name: '查看详情' }))
    expect(await screen.findByRole('dialog', { name: '会议纪要' })).toBeTruthy()
    expect(screen.getByText(SHA256)).toBeTruthy()
    expect(screen.getByText('v1.2.3')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /下载 ZIP/ }))
    await waitFor(() => expect(callSkillHub).toHaveBeenCalledWith('skills.download', {
      slug: 'meeting-notes',
      version: '1.2.3',
    }))
  })

  it('fails closed until receipt inventory is ready and when it cannot be read', async () => {
    const installedHubCard = { ...installedSkill, slug: hubCard.slug, version: hubCard.version }
    let resolveInventory!: (value: { ok: true; value: { schema_version: number; items: typeof installedHubCard[] } }) => void
    const inventory = new Promise<{ ok: true; value: { schema_version: number; items: typeof installedHubCard[] } }>(resolve => { resolveInventory = resolve })
    const callSkillHub = vi.fn(async (endpoint: string) => {
      if (endpoint === 'catalog.search') return { ok: true, value: { items: [hubCard], next_cursor: null } }
      if (endpoint === 'catalog.detail') return { ok: true, value: { schema_version: 1, skill: hubCard, versions: [hubCard], next_cursor: null } }
      if (endpoint === 'inventory.list') return inventory
      if (endpoint === 'jobs.list') return { ok: true, value: { items: [] } }
      return { ok: true, value: { job_id: 'job-12345678', status: 'running' } }
    })

    renderPage(callSkillHub)

    expect((await screen.findByRole('button', { name: '正在核对安装状态' })).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
    expect(await screen.findByRole('dialog', { name: '会议纪要' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '正在核对安装状态' }).every(button => button.hasAttribute('disabled'))).toBe(true)

    resolveInventory({ ok: true, value: { schema_version: 1, items: [installedHubCard] } })
    expect(await screen.findByRole('tab', { name: '已安装 1' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '已安装并启用' }).every(button => button.hasAttribute('disabled'))).toBe(true)

    cleanup()
    const failedCall = vi.fn(async (endpoint: string) => {
      if (endpoint === 'catalog.search') return { ok: true, value: { items: [hubCard], next_cursor: null } }
      if (endpoint === 'catalog.detail') return { ok: true, value: { schema_version: 1, skill: hubCard, versions: [hubCard], next_cursor: null } }
      if (endpoint === 'inventory.list') return { ok: false, error: { message: '本机 Skill 清单暂时无法读取。' } }
      if (endpoint === 'jobs.list') return { ok: true, value: { items: [] } }
      return { ok: true, value: { job_id: 'job-12345678', status: 'running' } }
    })
    renderPage(failedCall)

    expect((await screen.findByRole('button', { name: '安装状态读取失败' })).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('本机 Skill 清单暂时无法读取。')
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
    expect(await screen.findByRole('dialog', { name: '会议纪要' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '安装状态读取失败' }).every(button => button.hasAttribute('disabled'))).toBe(true)
  })

  it('pages immutable version history and refreshes inventory after a terminal Job', async () => {
    const oldCard = { ...hubCard, version: '1.0.0', package_sha256: 'b'.repeat(64) }
    const callSkillHub = vi.fn(async (endpoint: string, payload: Record<string, unknown>) => {
      if (endpoint === 'catalog.search') return { ok: true, value: { items: [hubCard], next_cursor: null } }
      if (endpoint === 'catalog.detail') return payload.cursor === undefined
        ? { ok: true, value: { schema_version: 1, skill: hubCard, versions: [hubCard], next_cursor: 'opaque-version-cursor' } }
        : { ok: true, value: { schema_version: 1, skill: hubCard, versions: [oldCard], next_cursor: null } }
      if (endpoint === 'inventory.list') return { ok: true, value: { schema_version: 1, items: [installedSkill] } }
      if (endpoint === 'jobs.list') return { ok: true, value: { items: [] } }
      if (endpoint === 'jobs.read') return { ok: true, value: { status: 'completed', output: '{}' } }
      return { ok: true, value: { job_id: 'job-terminal', status: 'running' } }
    })
    renderPage(callSkillHub)
    fireEvent.click(await screen.findByRole('button', { name: '查看详情' }))
    fireEvent.click(await screen.findByRole('button', { name: '加载更多版本' }))
    expect(await screen.findByText('v1.0.0')).toBeTruthy()
    expect(callSkillHub).toHaveBeenCalledWith('catalog.detail', {
      slug: 'meeting-notes', cursor: 'opaque-version-cursor', limit: 24,
    })
    fireEvent.click(screen.getByLabelText('关闭 Skill 详情'))
    fireEvent.click(screen.getByRole('tab', { name: /已安装/ }))
    await screen.findByText('installed-skill')
    fireEvent.click(screen.getByRole('button', { name: '禁用' }))
    await waitFor(() => expect(callSkillHub.mock.calls.filter(([endpoint]) => endpoint === 'inventory.list').length).toBeGreaterThan(1), { timeout: 2_000 })
  })

  it('publishes the selected ZIP through the existing Skill Hub action', async () => {
    const { callSkillHub } = renderPage()
    fireEvent.click(screen.getByRole('tab', { name: '导入' }))
    const file = new File([new Uint8Array([80, 75, 3, 4])], 'office-helper.zip', { type: 'application/zip' })
    if (typeof file.arrayBuffer !== 'function') Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([80, 75, 3, 4]).buffer })
    fireEvent.change(screen.getByLabelText('选择 Skill ZIP'), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: '验证并发布' }))
    await waitFor(() => expect(callSkillHub).toHaveBeenCalledWith('skills.publish', {
      bundle_base64: 'UEsDBA==',
      category: 'office_productivity',
    }))
  })

  it('reads the Hub receipt inventory and uses the same lifecycle RPC for disable', async () => {
    const { callSkillHub } = renderPage()
    fireEvent.click(screen.getByRole('tab', { name: /已安装/ }))
    expect(await screen.findByText('installed-skill')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '禁用' }))
    await waitFor(() => expect(callSkillHub).toHaveBeenCalledWith('skills.disable', { slug: 'installed-skill' }))
  })
})


it('does not present failed catalog reads as an empty search, even after dismissing the error', async () => {
  let available = false
  const request = vi.fn(async (endpoint: string) => {
    if (endpoint === 'catalog.search') return available
      ? { ok: true, value: { items: [], next_cursor: null } }
      : { ok: false, error: { message: 'Skill Hub 服务暂时不可用，请稍后重试。' } }
    if (endpoint === 'inventory.list') return { ok: true, value: { schema_version: 1, items: [] } }
    return { ok: true, value: { items: [] } }
  })
  renderPage(request as never)
  expect(await screen.findByText('Skill Hub 服务暂时不可用，请稍后重试。')).toBeTruthy()
  expect(screen.queryByText('没有匹配的 Skill。')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '关闭错误' }))
  expect(screen.queryByText('没有匹配的 Skill。')).toBeNull()
  available = true
  fireEvent.submit(screen.getByPlaceholderText('搜索 Skill Hub').closest('form')!)
  expect(await screen.findByText('没有匹配的 Skill。')).toBeTruthy()
})
