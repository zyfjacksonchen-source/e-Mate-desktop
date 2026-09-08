import { useEffect, useState } from 'react'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import css from './chat-context.module.css'

const SOURCE = '聊天引用'
interface ChatQuote { text: string; sessionId: string; nodeKey: string }

function readQuote(ref: string): ChatQuote {
  const value = JSON.parse(ref)
  if (!value || typeof value.text !== 'string' || !value.text.trim()
    || typeof value.sessionId !== 'string' || typeof value.nodeKey !== 'string') throw new Error('聊天引用无效')
  return value
}

/** The native occurrence codec supplies the actual selected text on submission,
 * clipboard copy and draft persistence; no second attachment or draft store. */
export const chatQuoteSource: InputTriggerSource = {
  trigger: '@', name: SOURCE,
  async candidates() { return [] },
  onPick() { return undefined },
  codec: {
    clipboardText: ref => readQuote(ref).text,
    async serialize(ref, signal) {
      signal.throwIfAborted()
      const quote = readQuote(ref)
      return `\n引用的聊天内容：\n${quote.text.split('\n').map(line => `> ${line}`).join('\n')}\n`
    },
  },
}

export function addChatQuote(ctx: any, quote: ChatQuote): void {
  if (ctx.sessions.list.getSnapshot().current !== quote.sessionId) throw new Error('会话已切换，请重新选择内容。')
  const scope = ctx.sessions.scope(quote.sessionId)
  if (!scope) throw new Error('当前会话不可用。')
  const input = ctx.conversation.input.for(scope)
  const state = input.state.getSnapshot()
  if (state.phase !== 'plain') throw new Error('输入正在处理中，请稍后重试。')
  if (!input.insertReference({ source: SOURCE, ref: JSON.stringify(quote),
    label: `引用：${quote.text.replace(/\s+/g, ' ').slice(0, 48)}`, clipboardText: quote.text },
  { start: state.draft.length, end: state.draft.length, draftRev: state.draftRev })) {
    throw new Error('草稿已变化，请重新添加引用。')
  }
}

type Selection = ChatQuote & { left: number; top: number }
export function ChatSelection({ currentSession, addQuote, notify }: {
  currentSession: () => string | undefined
  addQuote: (quote: ChatQuote) => void
  notify: (message: string) => void
}) {
  const [selection, setSelection] = useState<Selection | null>(null)
  useEffect(() => {
    const update = () => {
      const selected = window.getSelection()
      const sessionId = currentSession()
      if (!selected || selected.isCollapsed || !selected.rangeCount || !sessionId) { setSelection(null); return }
      const range = selected.getRangeAt(0)
      const element = (node: Node) => node instanceof Element ? node : node.parentElement
      const start = element(range.startContainer)?.closest<HTMLElement>('[data-chat-flow-kind="assistant-step"], [data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]')
      const end = element(range.endContainer)?.closest('[data-chat-flow-kind]')
      const text = selected.toString().trim()
      if (!start || start !== end || !text || element(range.startContainer)?.closest('button,textarea,input,[contenteditable="true"]')) { setSelection(null); return }
      const rect = range.getBoundingClientRect()
      setSelection({ text, sessionId, nodeKey: start.dataset.chatAnchorKey ?? '',
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 160)), top: Math.max(8, rect.top - 40) })
    }
    const clear = () => setSelection(null)
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') clear() }
    document.addEventListener('selectionchange', update)
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', clear, true)
    window.addEventListener('resize', clear)
    window.addEventListener('popstate', clear)
    return () => {
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('keydown', key)
      window.removeEventListener('scroll', clear, true)
      window.removeEventListener('resize', clear)
      window.removeEventListener('popstate', clear)
    }
  }, [currentSession])
  if (!selection) return null
  return <div className={css.toolbar} style={{ left: selection.left, top: selection.top }} role="toolbar" aria-label="选中文本">
    <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => {
      try { addQuote(selection); window.getSelection()?.removeAllRanges(); setSelection(null) }
      catch (error) { notify(error instanceof Error ? error.message : '未能添加引用。') }
    }}><span aria-hidden>＋</span> 添加到聊天</button>
  </div>
}

export function registerChatContext(ctx: any): void {
  ctx.effect(() => ctx.inputTriggers.registerSource(chatQuoteSource), 'e-mate-shell: chat quote codec')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'e-mate-chat-selection',
    inject: () => ({
      currentSession: () => ctx.sessions.list.getSnapshot().current,
      addQuote: (quote: ChatQuote) => addChatQuote(ctx, quote),
      notify: (text: string) => {
        const id = ctx.sessions.list.getSnapshot().current
        const scope = id === undefined ? undefined : ctx.sessions.scope(id)
        if (scope) ctx.conversation.input.for(scope).notify('error', text)
      },
    }),
  }, ChatSelection))
}
