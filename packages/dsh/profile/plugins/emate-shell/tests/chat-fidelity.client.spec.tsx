// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AssistantMarkdown } from '../../../../../../upstream/deepseek-harness/packages/client/ui-conversation/src/client/chat/AssistantMarkdown.tsx'
import { installDomFenceRenderer } from '../../../../../../upstream/plugins/dsh-genui/src/client/dom-fence.tsx'
import { toolImagesDefinition } from '../src/client/image-gallery.tsx'
import { ThinkingStatusBranding } from '../src/client/thinking-status.tsx'

vi.mock('@deepseek-ai/dsh-client-runtime/client', () => ({
  isAppendSurfaceEvent: (event: { surfaceOp?: string }) => event.surfaceOp === 'append',
}))

vi.mock('@deepseek-ai/dsh-client-ui-attachment', () => ({
  ImageGallery: ({ images }: { images: unknown[] }) => <div data-target-image-gallery="">{images.length} images</div>,
}))

const source = readFileSync(resolve('src/client/index.ts'), 'utf8')
const gallery = readFileSync(resolve('src/client/image-gallery.tsx'), 'utf8')
const galleryCss = readFileSync(resolve('src/client/image-gallery.module.css'), 'utf8')
const chatCss = readFileSync(resolve('src/client/chat-chrome.module.css'), 'utf8')
const activityFold = readFileSync(resolve('src/client/activity-fold.tsx'), 'utf8')
const activityFoldCss = readFileSync(resolve('src/client/activity-fold.module.css'), 'utf8')
const thinkingCss = readFileSync(resolve('src/client/thinking-status.module.css'), 'utf8')
const homeCss = readFileSync(resolve('src/client/home.module.css'), 'utf8')
const targetRoot = resolve('../../../../../upstream/deepseek-harness/packages/client')
const targetMessage = readFileSync(resolve(targetRoot, 'ui-conversation/src/client/chat/MessageItem.tsx'), 'utf8')
const targetAssistant = readFileSync(resolve(targetRoot, 'ui-conversation/src/client/chat/AssistantMarkdown.tsx'), 'utf8')
const targetChat = readFileSync(resolve(targetRoot, 'ui-conversation/src/client/chat/ChatView.tsx'), 'utf8')
const targetTool = readFileSync(resolve(targetRoot, 'ui-tool/src/client/tool/components/ToolRow.tsx'), 'utf8')
const targetImages = readFileSync(resolve(targetRoot, 'ui-attachment/src/MessageImage.tsx'), 'utf8')
const targetLightbox = readFileSync(resolve(targetRoot, 'ui-attachment/src/ImageLightbox.tsx'), 'utf8')
const targetBundlePatch = readFileSync(resolve(targetRoot, '../bundle/web-app/cordis.patch.yml'), 'utf8')
const genuiClient = readFileSync(resolve('../../../../../upstream/plugins/dsh-genui/src/client/index.tsx'), 'utf8')

describe('target conversation fidelity contract', () => {
  it('leaves Message, Retry, Turn status and Tool disclosure to the pinned target', () => {
    expect(source).not.toMatch(/activity-header|retry-attempts|long-message-disclosure|e-mate-message-disclosure/u)
    expect(source).not.toContain("key: 'model-retry'")
    expect(targetMessage).toContain('export const RetryNodeView')
    expect(targetMessage).toContain('<ModelRetryItem node={data.current}')
    expect(targetMessage).toContain('function UserStyleBubble')
    expect(targetAssistant).toContain('<ReasoningRow')
    expect(targetChat).toContain('<ChatNodeSeat')
    expect(targetChat).toContain('<TurnStatus startTime={runningTurnStart}')
    expect(targetTool).toContain('<DisclosureRow')
    expect(targetBundlePatch).toContain('id: ui-deliverables')
  })

  it('keeps target renderers and durable events while folding raw process rows in the Shell projection', () => {
    expect(chatCss).not.toMatch(/data-chat-flow-kind='(?:steering|model-retry|turn-error|command)'/u)
    expect(chatCss).not.toMatch(/data-turn-tail|data-emate-activity/u)
    expect(chatCss).toContain('--dsw-font-markdown-base: 14px/22px')
    expect(chatCss).toContain("[data-chat-flow-kind='user'] [data-time-hover-root]")
    expect(chatCss).toContain('"PingFang SC"')
    expect(chatCss).toContain('font-size: 14px !important;')
    expect(chatCss).not.toContain(":global([data-chat-flow-kind='tool-call']) {\n  display: none;")
    expect(chatCss).toContain("[data-chat-flow-kind='tool-call'] [data-disclosure-row]")
    expect(chatCss).toContain('font-size: 13px;')
    expect(chatCss).toContain('width: 14px;')
    expect(chatCss).toContain("[data-chat-flow-kind='assistant-step'] [data-align='start']")
    expect(chatCss).toContain('[data-produced-files-row] > button[title]')
    expect(chatCss).toContain('Beautiful UI Tool Chips icon geometry (MIT)')
    expect(activityFold).toContain("'assistant-step' | 'tool-call' | 'context'")
    expect(chatCss).toContain("[data-sample='bash'] + div > button")
    expect(chatCss).toMatch(/\[data-slot='conversation'\] \[aria-expanded\]:focus-visible[^}]*outline: none;[^}]*box-shadow: none;/u)
    expect(homeCss).toContain('--dsw-static-deepseek-500: var(--emate-color-brand);')
    expect(homeCss).toContain('--dsw-alias-state-business-primary: var(--emate-color-brand);')
    expect(source).toContain("ctx.slots.inject('conversation.composer.dock'")
    expect(source).toMatch(/id: 'stats',[\s\S]*?priority: -1/u)
  })

  it('keeps native streaming prose and GenUI together while process detail has one fold owner', async () => {
    const text = '原生流式正文\n\n```dsh-ui\n{"title":"卡片","items":[{"type":"text","content":"GenUI 内容"}]}\n```'
    const view = render(
      <div data-chat-anchor-key="14:assistant-step1:0" data-chat-flow-kind="assistant-step">
        <AssistantMarkdown
          blocks={[{ kind: 'reasoning', text: '正在分析' }, { kind: 'text', text }]}
          streaming
          t={((key: string) => key) as never}
        />
      </div>,
    )
    const dispose = installDomFenceRenderer({
      sessions: { list: { getSnapshot: () => ({ current: 'session-native' }) } },
    } as never, vi.fn())
    try {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
      expect(screen.getByText('原生流式正文')).toBeTruthy()
      expect(screen.getByText('正在分析')).toBeTruthy()
      expect(view.container.querySelector('[data-streaming]')).not.toBeNull()
      const stockFence = view.container.querySelector<HTMLElement>('.md-code-block')!
      expect(stockFence.hasAttribute('data-genui-rendered')).toBe(true)
      expect(stockFence.style.display).toBe('none')
      expect(view.container.querySelector('.genui-dom-fence')?.textContent).toContain('GenUI 内容')
    } finally {
      dispose()
    }
    expect(activityFold).toContain("key: kind")
    expect(activityFold).toContain('priority: -1')
    expect(activityFold).toContain("return renderNative(ctx, kind, props)")
    expect(activityFold).toContain("kind === 'text'")
    expect(activityFold).toContain("block.kind === 'reasoning'")
    expect(activityFoldCss).not.toContain("[data-emate-process-collapsed] :global([data-variant='think'])")
    expect(targetAssistant).toContain('streaming={streaming}')
    expect(targetAssistant).toContain('<ReasoningRow')
    expect(genuiClient).toContain("ctx.slots.inject('tool.call.toolview'")
    expect(genuiClient).toContain("ctx.slots.inject('conversation.input.dock'")
    expect(genuiClient).not.toContain('conversation.chat.node')
  })

  it('owns one pure priority -1 turn-tail terminal without DOM relocation', () => {
    expect(source).toContain("ctx.slots.inject('conversation.chat.turnTail'")
    expect(source).toMatch(/name: 'conversation\.chat\.turnTail',[\s\S]*?priority: -1/u)
    expect(gallery).not.toContain('querySelector')
    expect(gallery).not.toContain('createPortal')
    expect(gallery).not.toContain('MutationObserver')
  })

  it('keeps native MessageImage loading, retry and lightbox without relocating its DOM', () => {
    expect(targetImages).toContain('export function ImageGallery')
    expect(targetImages).toContain('<MessageImage')
    expect(targetImages).toContain('<ImageLightbox')
    expect(targetLightbox).toContain('role="dialog"')
    expect(gallery).toContain('<MessageImage')
    expect(gallery).toContain("visibility: 'hidden'")
    expect(galleryCss).toContain('scroll-snap-type: x mandatory')
  })

  it('stores a durable custom image event as a hidden terminal receipt', () => {
    const attachment = {
      attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 10, width: 1, height: 1, name: 'e-Mate-image.png',
    }
    const event = {
      type: 'emate/image-output', seq: 8, time: 8,
      data: { call_id: 'call-1', content: [{ type: 'image', attachment }] },
    }
    expect(toolImagesDefinition.match(event as never)).toEqual({ id: 'tool-images:call-1', role: 'start' })
    const state = toolImagesDefinition.start({} as never, { event } as never, {} as never)
    const node = toolImagesDefinition.buildViewNode?.({
      key: 'receipt:1', id: 'tool-images:call-1', kind: 'e-mate-tool-images', state,
      start: { event, location: { kind: 'unresolved' } }, matches: [], current: new Map(),
    } as never, 'chat') as { visibility?: string; data?: { item?: { attachment?: unknown } } }
    expect(node.visibility).toBe('hidden')
    expect(node.data?.item?.attachment).toEqual(attachment)
  })

  it('brands only target running statuses without rescanning the document during token streaming', async () => {
    const view = render(<>
      <ThinkingStatusBranding />
      <div role="status" aria-live="polite">Deep diving...<span>15秒</span></div>
      <div role="status" aria-live="polite">正在上传</div>
    </>)
    const target = screen.getByRole('status', { name: '思考中' })
    const unrelated = [...view.container.querySelectorAll<HTMLElement>('[role="status"]')]
      .find(node => node.textContent === '正在上传')!
    expect(target.hasAttribute('data-emate-thinking-status')).toBe(true)
    expect(target.textContent).not.toContain('Deep diving...')
    expect(target.textContent).toContain('思考中')
    expect(target.querySelectorAll('i')).toHaveLength(4)
    expect(unrelated.hasAttribute('data-emate-thinking-status')).toBe(false)
    expect(thinkingCss).toContain('var(--dsw-alias-label-secondary)')
    expect(thinkingCss).toContain('@keyframes emate-domino')
    expect(thinkingCss).toContain('width: 16px')

    const documentQuery = vi.spyOn(document, 'querySelectorAll')
    const stream = document.createElement('div')
    view.container.append(stream)
    await act(async () => {
      for (let index = 0; index < 50; index += 1) stream.append(document.createElement('span'))
      await Promise.resolve()
    })
    expect(documentQuery).not.toHaveBeenCalled()

    const lateTarget = document.createElement('div')
    lateTarget.setAttribute('role', 'status')
    lateTarget.setAttribute('aria-live', 'polite')
    lateTarget.append('Deep diving...')
    await act(async () => {
      view.container.append(lateTarget)
      await Promise.resolve()
    })
    expect(lateTarget.hasAttribute('data-emate-thinking-status')).toBe(true)
    expect(documentQuery).not.toHaveBeenCalled()
    documentQuery.mockRestore()

    view.unmount()
    expect(target.hasAttribute('data-emate-thinking-status')).toBe(false)
    expect(target.textContent).toContain('Deep diving...')
  })
})
