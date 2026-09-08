import { useEffect } from 'react'
import css from './activity-fold.module.css'
import './thinking-status.module.css'

/** rc.7 hardcodes TurnStatus outside its slots. This presentation adapter retires
 * only that label; native turn lifecycle, clock, scrolling and approvals stay owned by DSH. */
export function ThinkingStatusBranding() {
  useEffect(() => {
    const entries = new Map<HTMLElement, { text: Text; value: string; label: string | null }>()
    const decorate = (node: HTMLElement) => {
      if (entries.has(node)) return
      const text = [...node.childNodes].find((child): child is Text =>
        child.nodeType === Node.TEXT_NODE && child.textContent?.trim().startsWith('Deep diving...') === true)
      if (!text) return
      entries.set(node, { text, value: text.data, label: node.getAttribute('aria-label') })
      text.data = '正在处理'
      node.setAttribute('data-emate-turn-status', '')
      node.setAttribute('aria-label', '正在处理')
      node.classList.add(css.shimmer)
    }
    const scan = (node: Node) => {
      if (!(node instanceof Element)) return
      if (node.matches('[role="status"][aria-live="polite"]')) decorate(node as HTMLElement)
      for (const status of node.querySelectorAll<HTMLElement>('[role="status"][aria-live="polite"]')) decorate(status)
    }
    scan(document.body)
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) scan(node)
      for (const node of entries.keys()) if (!node.isConnected) entries.delete(node)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      for (const [node, entry] of entries) {
        entry.text.data = entry.value
        node.classList.remove(css.shimmer)
        node.removeAttribute('data-emate-turn-status')
        if (entry.label === null) node.removeAttribute('aria-label')
        else node.setAttribute('aria-label', entry.label)
      }
    }
  }, [])
  return null
}
