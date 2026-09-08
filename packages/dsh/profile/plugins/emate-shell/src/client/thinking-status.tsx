import { useEffect } from 'react'
import css from './thinking-status.module.css'

const TARGET_LABEL = 'Deep diving...'
const MARKER = 'data-emate-thinking-status'
const STATUS_SELECTOR = '[role="status"][aria-live="polite"]'

function targetLabel(node: HTMLElement): Text | undefined {
  return [...node.childNodes].find((child): child is Text =>
    child.nodeType === Node.TEXT_NODE && child.textContent?.trimStart().startsWith(TARGET_LABEL),
  )
}

function createDomino(): HTMLElement {
  const host = document.createElement('span')
  host.className = css.host
  host.setAttribute('aria-hidden', 'true')

  const loader = document.createElement('span')
  loader.className = css.loader
  const domino = document.createElement('span')
  domino.className = css.domino
  for (let index = 0; index < 4; index += 1) domino.append(document.createElement('i'))
  loader.append(domino)

  const label = document.createElement('span')
  label.textContent = '思考中'
  host.append(loader, label)
  return host
}

/** Brand-only projection over the target Harness running-turn status. */
export function ThinkingStatusBranding() {
  useEffect(() => {
    let active = true
    const decorated = new Map<HTMLElement, { host: HTMLElement; label: string | null; text: Text; value: string }>()
    const restore = (status: HTMLElement, entry: { host: HTMLElement; label: string | null; text: Text; value: string }) => {
      entry.host.remove()
      entry.text.data = entry.value
      status.removeAttribute(MARKER)
      if (entry.label === null) status.removeAttribute('aria-label')
      else status.setAttribute('aria-label', entry.label)
    }
    const sync = (candidates: Iterable<HTMLElement>) => {
      if (!active) return
      for (const [status, entry] of decorated) {
        if (!status.isConnected) decorated.delete(status)
        else if (!entry.host.isConnected) {
          restore(status, entry)
          decorated.delete(status)
        }
      }
      for (const status of candidates) {
        const text = targetLabel(status)
        if (text === undefined || decorated.has(status)) continue
        const host = createDomino()
        const label = status.getAttribute('aria-label')
        const value = text.data
        text.data = ''
        status.setAttribute(MARKER, '')
        status.setAttribute('aria-label', '思考中')
        status.append(host)
        decorated.set(status, { host, label, text, value })
      }
    }
    const addClosestStatus = (node: Node, candidates: Set<HTMLElement>) => {
      const element = node instanceof Element ? node : node.parentElement
      const status = element?.matches(STATUS_SELECTOR) === true ? element : element?.closest(STATUS_SELECTOR)
      if (status instanceof HTMLElement) candidates.add(status)
    }
    const scanAdded = (node: Node, candidates: Set<HTMLElement>) => {
      addClosestStatus(node, candidates)
      if (!(node instanceof Element) || node.childElementCount === 0) return
      for (const status of node.querySelectorAll<HTMLElement>(STATUS_SELECTOR)) candidates.add(status)
    }

    sync(document.querySelectorAll<HTMLElement>(STATUS_SELECTOR))
    const observer = new MutationObserver(records => {
      const candidates = new Set<HTMLElement>()
      for (const record of records) {
        addClosestStatus(record.target, candidates)
        for (const node of record.addedNodes) scanAdded(node, candidates)
      }
      sync(candidates)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      active = false
      observer.disconnect()
      for (const [status, entry] of decorated) restore(status, entry)
    }
  }, [])
  return null
}
