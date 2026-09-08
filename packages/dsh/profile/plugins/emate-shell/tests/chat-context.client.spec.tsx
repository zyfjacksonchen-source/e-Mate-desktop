// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionInputShell } from '../../../../../../upstream/deepseek-harness/packages/client/ui-conversation/src/client/input/facade.ts'
import { addChatQuote, chatQuoteSource, ChatSelection } from '../src/client/chat-context.tsx'

afterEach(cleanup)

it('serializes the full selected text through the native input facade and retains image ids, undo and redo', async () => {
  const sink = vi.fn()
  const input = new SessionInputShell({ actx: {} as never, defaultSink: sink, inputTriggers: () => ({
    dismiss: () => {},
    serializeReference: (_source: string, ref: string, signal: AbortSignal) => chatQuoteSource.codec!.serialize(ref, signal),
  }) as never })
  const ctx = { sessions: { list: { getSnapshot: () => ({ current: 's1' }) }, scope: () => ({}) }, conversation: { input: { for: () => input } } }
  input.setDraft('请比较 ')
  input.addImages(['image-one' as never])
  const quote = { text: '完整选文\n第二行 <script>literal</script>', sessionId: 's1', nodeKey: 'assistant-1' }
  addChatQuote(ctx, quote)
  expect(input.state.getSnapshot().occurrences).toHaveLength(1)
  expect(input.state.getSnapshot().draft).toContain('\uFFFC')
  input.undo()
  expect(input.state.getSnapshot().draft).toBe('请比较 ')
  input.redo()
  expect(input.state.getSnapshot().occurrences).toHaveLength(1)
  input.submit()
  await waitFor(() => expect(sink).toHaveBeenCalledTimes(1))
  expect(sink.mock.calls[0][0]).toContain('> 完整选文\n> 第二行 <script>literal</script>')
  expect(sink.mock.calls[0][0]).toContain('请比较 ')
  expect(sink.mock.calls[0][1]).toEqual(['image-one'])
  input.dispose()
})

it('rejects stale-session and busy drafts without replacing user input', () => {
  const insertReference = vi.fn()
  const state = { phase: 'submitting', draft: 'keep', draftRev: 3 }
  const ctx = { sessions: { list: { getSnapshot: () => ({ current: 's1' }) }, scope: () => ({}) },
    conversation: { input: { for: () => ({ state: { getSnapshot: () => state }, insertReference }) } } }
  expect(() => addChatQuote(ctx, { text: 'quote', sessionId: 's2', nodeKey: 'n' })).toThrow('会话已切换')
  expect(() => addChatQuote(ctx, { text: 'quote', sessionId: 's1', nodeKey: 'n' })).toThrow('输入正在处理中')
  expect(insertReference).not.toHaveBeenCalled()
  expect(state.draft).toBe('keep')
})

it('shows a selection-anchored action only for a single native chat message', () => {
  const addQuote = vi.fn(), currentSession = () => 's1'
  const view = render(<><ChatSelection currentSession={currentSession} addQuote={addQuote} notify={vi.fn()} />
    <div data-chat-flow-kind="assistant-step" data-chat-anchor-key="n"><p>选择这段文本</p></div></>)
  const range = document.createRange()
  range.selectNodeContents(screen.getByText('选择这段文本'))
  range.getBoundingClientRect = () => ({ left: 30, top: 120 }) as DOMRect
  act(() => { window.getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange')) })
  fireEvent.click(screen.getByRole('button', { name: '添加到聊天' }))
  expect(addQuote).toHaveBeenCalledWith(expect.objectContaining({ text: '选择这段文本', sessionId: 's1', nodeKey: 'n' }))
  expect(screen.queryByRole('toolbar')).toBeNull()
  view.unmount()
})

it('sends image bytes as native image content and releases drafts only after prompt acceptance', async () => {
  const { ConversationController } = await import('../../../../../../upstream/deepseek-harness/packages/client/ui-conversation/src/client/service.ts')
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const file = new File([bytes], '参考图.png', { type: 'image/png' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer })
  const attachments = [{ id: 'image-1', file }]
  const service = Object.create(ConversationController.prototype)
  service.draftImages = () => attachments
  service.releaseDraftImages = vi.fn()
  const prompt = vi.fn(async () => ({ ok: false, error: { code: 'offline', message: 'offline' } }))
  await expect(service.sendSession({ prompt }, '根据参考图修改', ['image-1'], 'queue')).rejects.toThrow('offline')
  expect(service.releaseDraftImages).not.toHaveBeenCalled()
  prompt.mockResolvedValue({ ok: true } as never)
  await service.sendSession({ prompt }, '根据参考图修改', ['image-1'], 'queue')
  expect(prompt).toHaveBeenLastCalledWith([
    { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: '参考图.png' },
    { type: 'text', text: '根据参考图修改' },
  ], 'queue', undefined)
  expect(service.releaseDraftImages).toHaveBeenCalledWith(attachments)
})
