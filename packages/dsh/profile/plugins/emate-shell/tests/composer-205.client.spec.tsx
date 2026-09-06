// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMPOSER_PLACEHOLDER, ComposerConnectors, ComposerMentions } from '../src/client/composer-connectors.tsx'
import { registerComputerUseTrigger } from '../src/client/composer-mentions.ts'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { PlanChip, type PlanChipProps } from '../../../../../../upstream/deepseek-harness/packages/client/ui-plan/src/client/PlanModeControl.tsx'
import { FileImportControl } from '../../../../../dsh-plugin-file-import/src/client/index.tsx'

const Icon = () => <svg />

function applyHomeStyles(): void {
  const style = document.createElement('style')
  style.dataset.emateHomeTest = ''
  style.textContent = readFileSync('src/client/home.module.css', 'utf8').replaceAll(':global(', ':is(')
    // jsdom does not resolve custom properties inside border shorthands.
    .replaceAll('var(--emate-color-rule)', '#777')
  document.head.append(style)
}

function applyFileImportStyles(button: HTMLButtonElement): void {
  const style = document.createElement('style')
  style.dataset.emateFileImportTest = ''
  style.textContent = readFileSync('../../../../dsh-plugin-file-import/src/client/style.module.css', 'utf8')
    .replaceAll('.button', `.${button.className}`)
  document.head.append(style)
}

afterEach(() => {
  cleanup()
  document.head.querySelector('[data-emate-home-test]')?.remove()
  document.head.querySelector('[data-emate-file-import-test]')?.remove()
  delete document.body.dataset.dshDesktopPlatform
})

describe('e-Mate 2.0.17 composer projection', () => {
  it('shows actual connector states and fills a service-specific draft without navigating', async () => {
    const prepareDraft = vi.fn()
    const loadConnections = vi.fn(async () => [
      { id: 'feishu' as const, state: 'connected' as const },
      { id: 'dingtalk' as const, state: 'not-connected' as const },
      { id: 'tencent_docs' as const, state: 'expired' as const },
    ])
    const before = location.href
    render(<ComposerConnectors LinkIcon={Icon} sessionId="s1" loadConnections={loadConnections} prepareDraft={prepareDraft} />)
    fireEvent.click(screen.getByRole('button', { name: '外部连接' }))
    await waitFor(() => expect(screen.getByText('已连接')).toBeTruthy())
    expect(screen.getByText('未连接')).toBeTruthy()
    expect(screen.getByText('授权失效')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /飞书.*已连接/u }))
    expect(prepareDraft).toHaveBeenCalledOnce()
    expect(prepareDraft.mock.calls[0]?.[0]).toContain('connect-feishu-cli')
    expect(location.href).toBe(before)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('connects Xin directly and displays verified binding/permissions without editing the chat draft', async () => {
    const ready = {
      schema_version: 1 as const, service: 'xin-business-assistant' as const, name: 'xin-business-assistant' as const, transport: 'streamable-http' as const,
      state: 'ready' as const, active: true, authorized: true,
      binding: { tenant_id: 'xin-tenant', user_id: 8, principal_id: 12 },
      permissions: { tools: ['query_projects'], project_count: 2, knowledge_project_count: 3, writable_project_count: 1, scope_revision: 'r1' },
      verified_at: '2026-09-07T01:00:00.000Z',
    }
    const idle = { ...ready, state: 'authorization-required' as const, active: false, authorized: false, binding: undefined, permissions: undefined, verified_at: undefined }
    let current = idle as typeof ready | typeof idle
    const prepareDraft = vi.fn()
    const ensureXin = vi.fn(async () => { current = ready; return ready })
    const disconnectXin = vi.fn(async () => { current = idle; return idle })
    render(<ComposerConnectors LinkIcon={Icon} sessionId="s1" loadConnections={async () => []} prepareDraft={prepareDraft} loadXin={async () => current} ensureXin={ensureXin} disconnectXin={disconnectXin} />)
    fireEvent.click(screen.getByRole('button', { name: '外部连接' }))
    await waitFor(() => expect(screen.getByText('待授权')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '连接芯助手' }))
    await waitFor(() => expect(screen.getByText('xin-tenant / 用户 8')).toBeTruthy())
    expect(screen.getByText('经营项目 2 · 知识项目 3 · 可维护项目 1')).toBeTruthy()
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe(ready.verified_at)
    expect(prepareDraft).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '重新连接芯助手' }))
    await waitFor(() => expect(ensureXin).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: '断开芯助手' }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '断开芯助手' }))
    await waitFor(() => expect(screen.queryByText('xin-tenant / 用户 8')).toBeNull())
    expect(disconnectXin).toHaveBeenCalledOnce()
  })

  it('deduplicates pending ensure, allows native authorization outside the popup, and rejects results after identity change', async () => {
    const idle = { schema_version: 1 as const, service: 'xin-business-assistant' as const, name: 'xin-business-assistant' as const, transport: 'streamable-http' as const, state: 'authorization-required' as const, active: false, authorized: false }
    let finish: (value: any) => void = () => {}
    let signal: AbortSignal | undefined
    const ensureXin = vi.fn((value: AbortSignal) => { signal = value; return new Promise<typeof idle>(resolve => { finish = resolve }) })
    let identityChanged: () => void = () => {}
    const prepareDraft = vi.fn()
    render(<ComposerConnectors LinkIcon={Icon} sessionId="s1" loadConnections={async () => []} prepareDraft={prepareDraft} loadXin={async () => idle} ensureXin={ensureXin}
      subscribeIdentity={listener => { identityChanged = listener; return () => {} }} />)
    fireEvent.click(screen.getByRole('button', { name: '外部连接' }))
    await waitFor(() => expect(screen.getByText('待授权')).toBeTruthy())
    const button = screen.getByRole('button', { name: '连接芯助手' })
    act(() => { fireEvent.click(button); fireEvent.click(button) })
    expect(ensureXin).toHaveBeenCalledOnce()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(signal?.aborted).toBe(false)
    act(() => identityChanged())
    expect(signal?.aborted).toBe(true)
    await act(async () => finish({ ...idle, state: 'ready', active: true, authorized: true, binding: { tenant_id: 'old-private-tenant', user_id: 999, principal_id: 1 } }))
    fireEvent.click(screen.getByRole('button', { name: '外部连接' }))
    expect(screen.queryByText(/old-private-tenant/)).toBeNull()
    expect(prepareDraft).not.toHaveBeenCalled()
  })

  it('cancel waits for fresh status instead of displaying a late success as the current connection', async () => {
    const idle = { schema_version: 1 as const, service: 'xin-business-assistant' as const, name: 'xin-business-assistant' as const, transport: 'streamable-http' as const, state: 'authorization-required' as const, active: false, authorized: false }
    let finish: (value: typeof idle) => void = () => {}
    let signal: AbortSignal | undefined
    const loadXin = vi.fn(async () => idle)
    render(<ComposerConnectors LinkIcon={Icon} sessionId="s1" loadConnections={async () => []} prepareDraft={vi.fn()} loadXin={loadXin}
      ensureXin={value => { signal = value; return new Promise(resolve => { finish = resolve }) }} />)
    fireEvent.click(screen.getByRole('button', { name: '外部连接' }))
    await waitFor(() => expect(screen.getByText('待授权')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '连接芯助手' }))
    fireEvent.click(screen.getByRole('button', { name: '取消等待' }))
    expect(signal?.aborted).toBe(true)
    await act(async () => finish(idle))
    await waitFor(() => expect(loadXin.mock.calls.length).toBeGreaterThan(1))
    expect(screen.queryByText('芯助手已连接，账号和权限已验证。')).toBeNull()
  })

  it('ignores a stale status read while direct ensure settles and aborts on a session switch', async () => {
    const idle = { schema_version: 1 as const, service: 'xin-business-assistant' as const, name: 'xin-business-assistant' as const, transport: 'streamable-http' as const, state: 'authorization-required' as const, active: false, authorized: false }
    let finishRead: (value: typeof idle) => void = () => {}
    let finishAction: (value: typeof idle) => void = () => {}
    let signal: AbortSignal | undefined
    const loadXin = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve })).mockResolvedValue(idle)
    const props = { LinkIcon: Icon, sessionId: 's1', loadConnections: async () => [], prepareDraft: vi.fn(), loadXin,
      ensureXin: (value: AbortSignal) => { signal = value; return new Promise<typeof idle>(resolve => { finishAction = resolve }) } }
    const view = render(<ComposerConnectors {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '外部连接' }))
    fireEvent.click(screen.getByRole('button', { name: '连接芯助手' }))
    await act(async () => finishRead(idle))
    expect(screen.getByText('连接处理中')).toBeTruthy()
    view.rerender(<ComposerConnectors {...props} sessionId="s2" />)
    expect(signal?.aborted).toBe(true)
    await act(async () => finishAction(idle))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '外部连接' }))
    await waitFor(() => expect(screen.getByText('待授权')).toBeTruthy())
    expect(screen.queryByText('连接已取消。')).toBeNull()
  })

  it('keeps the resident live Harness textarea placeholder', () => {
    render(<div data-composer-card="">
      <textarea defaultValue="" placeholder="描述你想要构建的内容" />
      <ComposerMentions openMentions={() => {}} />
    </div>)
    expect(screen.getByPlaceholderText(COMPOSER_PLACEHOLDER)).toBeTruthy()
  })

  it('keeps the target blocker reason on a disabled textarea', () => {
    render(<div data-composer-card="">
      <textarea disabled placeholder="当前模型不可用，请先选择模型" />
      <ComposerMentions openMentions={() => {}} />
    </div>)
    expect(screen.getByPlaceholderText('当前模型不可用，请先选择模型')).toBeTruthy()
  })

  it('has one visible native @ launcher, no visible slash affordance, and returns focus to the textarea', () => {
    const openMentions = vi.fn()
    render(<div data-composer-card="">
      <textarea defaultValue="请处理" />
      <ComposerMentions openMentions={openMentions} />
    </div>)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    textarea.setSelectionRange(3, 3)
    fireEvent.click(screen.getByRole('button', { name: '插入引用' }))
    expect(openMentions).toHaveBeenCalledWith({ start: 3, end: 3 })
    expect(document.activeElement).toBe(textarea)
    expect(screen.getAllByText('@')).toHaveLength(1)
    const styles = readFileSync('src/client/home.module.css', 'utf8')
    expect(styles).not.toContain("content: '/'")
    expect(styles).toMatch(/button:first-child[\s\S]*display:\s*none !important/u)
  })

  it('keeps the rc.7 Plan and Goal surfaces visible while hiding only native permission and command controls', () => {
    const exitPlanMode = vi.fn(() => new Promise<string | null>(() => {}))
    const planProps = {
      useProjection: () => ({ active: true, pending: false }),
      locked: false,
      exitPlanMode,
      t: (key: string) => key === 'chip.on.aria' ? 'plan mode active' : key,
    } as unknown as PlanChipProps
    render(<div>
      <div data-slot="conversation.input.dock"><div data-goal-bar data-testid="goal" /></div>
      <div data-slot="conversation.composer.bar">
        <div>
          <div data-composer-card="">
            <div data-input-area="" />
            <div>
              <div>
                <button type="button" data-testid="command">Command</button>
                <div data-testid="modes">
                  <span data-testid="permission"><button type="button">Full access</button></span>
                  <div data-slot="conversation.input.plan">
                    <PlanChip {...planProps} />
                  </div>
                </div>
                <button type="button" aria-label="添加本地图片或文件"><svg width="16" height="16" /></button>
                <button type="button" data-emate-composer-mentions=""><span aria-hidden="true">@</span></button>
              </div>
              <div />
            </div>
          </div>
        </div>
      </div>
    </div>)

    applyHomeStyles()
    expect(getComputedStyle(screen.getByTestId('command')).display).toBe('none')
    expect(getComputedStyle(screen.getByTestId('permission')).display).toBe('none')
    expect(getComputedStyle(screen.getByTestId('modes')).display).not.toBe('none')
    const plan = screen.getByRole('button', { name: 'plan mode active' })
    expect(getComputedStyle(plan).display).not.toBe('none')
    fireEvent.click(plan)
    expect(exitPlanMode).toHaveBeenCalledOnce()
    expect(getComputedStyle(screen.getByTestId('goal')).display).not.toBe('none')
  })

  it('matches the resident file control with a 32px launcher and 16px @ glyph at every width', () => {
    render(<div data-composer-card="">
      <textarea defaultValue="" />
      <FileImportControl
        sessionId="session-1"
        input={{
          draft: '', phase: 'plain', fileRefs: [], imageIds: [], imageRefs: [], hydratedImageKeys: [],
          runtimeOnlyImageIds: [], imageStagePending: false,
        }}
        inputActions={{
          addFiles: () => true, removeFile() {}, beginImageStage: () => true, cancelImageStage() {},
          addDurableImages: () => true, hydrateDurableImage: () => true, removeDurableImage: () => undefined,
        }}
        isLoopback
        call={async () => ({ ok: true })}
        createDraftImages={() => []}
        draftImages={() => []}
        releaseDraftImages={() => {}}
        readAttachment={async () => ({ ok: false, error: { code: 'internal', message: 'unused', details: {} } })}
        imageLimits={() => undefined}
        notify={() => {}}
        renderComposer={({ controls }) => <>{controls}</>}
      />
      <ComposerMentions openMentions={() => {}} />
    </div>)
    const fileButton = screen.getByRole('button', { name: '添加本地图片或文件' })
    const mentionButton = screen.getByRole('button', { name: '插入引用' })
    applyFileImportStyles(fileButton)
    applyHomeStyles()
    const fileStyle = getComputedStyle(fileButton)
    const mentionStyle = getComputedStyle(mentionButton)
    const icon = fileButton.querySelector('svg')!
    const glyphStyle = getComputedStyle(mentionButton.querySelector('span[aria-hidden="true"]')!)
    const controlSize = (style: CSSStyleDeclaration) => [style.width, style.minWidth, style.minHeight, style.padding]

    expect(controlSize(fileStyle)).toEqual(['32px', '32px', '32px', '0px'])
    expect(controlSize(mentionStyle)).toEqual(controlSize(fileStyle))
    expect([icon.getAttribute('width'), icon.getAttribute('height')]).toEqual(['16', '16'])
    expect([glyphStyle.fontSize, glyphStyle.lineHeight]).toEqual(['16px', '16px'])
  })

  it('keeps a picked @电脑操控 reference visible in the native composer', async () => {
    document.body.dataset.dshDesktopPlatform = 'darwin'
    let registered: InputTriggerSource | undefined
    registerComputerUseTrigger({
      effect(run: () => () => void) { return run() },
      inputTriggers: {
        registerSource(source: InputTriggerSource) {
          registered = source
          return () => {}
        },
      },
    })
    expect(registered?.onPick({
      candidate: { name: '电脑操控', hint: '可插入' },
      session: { sessionId: 'session-1' as never },
      position: 'inline',
      via: 'menu',
      span: { start: 0, end: 5, draftRev: 1 },
    })).toEqual({
      insert: { source: '电脑操控', ref: 'computer-use', label: '@电脑操控', clipboardText: '@电脑操控' },
    })
    const signal = new AbortController().signal
    await expect(registered?.codec?.serialize('computer-use', signal)).resolves.toBe('@电脑操控')
    expect(readFileSync('src/client/home.module.css', 'utf8')).toContain("font-family: 'DshChipCell', -apple-system")
  })

  it('keeps one frame and a flush workspace footer when slots add wrappers around the native card', () => {
    const composer = (depth: number) => {
      let body = <div data-testid="native-root"><div data-composer-card data-testid="card">
        <div aria-label="附件">文件缩略卡</div><textarea defaultValue="正文" /><div><button>发送</button></div>
      </div></div>
      for (let i = 0; i < depth; i++) body = <div>{body}</div>
      return <div data-emate-composer-frame-host data-testid="frame">
        <div data-slot="conversation.composer.bar">{body}</div>
        <div data-testid="workspace-row"><div data-slot="conversation.hero.workspace"><button>通用会话</button></div></div>
      </div>
    }
    const view = render(composer(0))
    applyHomeStyles()
    for (const depth of [0, 3]) {
      view.rerender(composer(depth))
      const frame = getComputedStyle(screen.getByTestId('frame'))
      const nativeRoot = getComputedStyle(screen.getByTestId('native-root'))
      const card = getComputedStyle(screen.getByTestId('card'))
      const footer = getComputedStyle(screen.getByTestId('workspace-row'))
      expect([frame.gap, frame.padding, frame.boxSizing, frame.borderWidth]).toEqual(['0px', '0px', 'border-box', '2px'])
      expect(nativeRoot.padding).toBe('0px')
      expect([card.borderWidth, card.borderRadius, card.backgroundColor]).toEqual(['0px', '0px', 'rgba(0, 0, 0, 0)'])
      expect([footer.marginTop, footer.borderTopWidth, footer.backgroundColor]).toEqual(['0px', '1px', 'rgba(0, 0, 0, 0)'])
    }
  })

  it('uses the target input trigger and input-bar contracts without a parallel transport', async () => {
    const source = readFileSync('src/client/index.ts', 'utf8')
    const home = readFileSync('src/client/home.tsx', 'utf8')
    const styles = readFileSync('src/client/home.module.css', 'utf8')
    const nativeRoot = readFileSync('../../../../../upstream/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx', 'utf8')
    expect(source).toContain("ctx.slots.inject('conversation.input.right'")
    expect(source).toContain("ctx.slots.inject('conversation.input.left'")
    expect(source).toMatch(/id: 'e-mate-mentions',[\s\S]*?order: 11/u)
    expect(source).toContain("appendConnectionDraft(ctx, sessionId, prompt)")
    const mentions = readFileSync('src/client/composer-mentions.ts', 'utf8')
    expect(mentions).toContain("name: '电脑操控'")
    expect(mentions).toContain("label: '@电脑操控'")
    expect(source).not.toContain('<computer-use explicit="true">')
    expect(mentions).not.toMatch(/faceOf\('(?:goal|todos)'\)|kind: 'goal'|kind: 'plan'|<goal|<plan-item/u)
    expect(mentions).toContain("execute(session.sessionId, '/plan')")
    expect(mentions).toContain("'slash/input-consume-token'")
    expect(source).not.toMatch(/\b(?:fetch|WebSocket|EventSource)\s*\(/u)
    await waitFor(() => expect(styles).toContain('[data-composer-card]'))
    expect(nativeRoot).toMatch(/className=\{clsx\(css\.composerStack[\s\S]*?data-emate-composer-frame-host=""/u)
    expect(home).not.toContain('data-emate-composer-frame-host')
    expect(styles).toMatch(/\[data-emate-composer-frame-host\][\s\S]*?\[data-slot='conversation\.composer\.bar'\]/u)
    expect(styles).toMatch(/\[data-emate-composer-frame-host\][\s\S]*?\[data-slot='conversation\.hero\.workspace'\]/u)
    expect(styles).toMatch(/\[data-phase='active'\] \[data-emate-composer-frame-host\][\s\S]*?align-self:\s*center;[\s\S]*?width:\s*min\(var\(--dsh-composer-card-max-width\), 100%\)/u)
    expect(styles).toMatch(/\[data-emate-composer-frame-host\] :has\(> \[data-composer-card\]\)\)[^{]*\{[^}]*padding:\s*0 !important/u)
    expect(styles).not.toContain('2 * var(--dsh-composer-side-clearance)')
    expect(styles).toMatch(/\[data-phase='hero'\] \[data-composer-seat\][\s\S]*?padding-bottom:\s*32px/u)
    expect(styles).toMatch(/\[data-emate-composer-frame-host\][^{]*\{[^}]*--emate-composer-frame-radius:\s*24px;[^}]*position:\s*relative;[^}]*border-radius:\s*var\(--emate-composer-frame-radius\)/u)
    expect(styles).not.toContain("[data-slot='conversation.composer.bar'] > div")
    expect(styles).not.toContain('margin-top: -12px')
    expect(styles).not.toContain('--emate-composer-frame-bottom')
  })
})
