import { useEffect, useRef, type ComponentType } from 'react'
import type { DesktopUpdateTriggerBridge } from '../../../../../../../desktop/e-mate-desktop/src/desktop-update-trigger-contract.ts'
import { UpdateControl } from './header-controls.tsx'
import css from './settings-chrome.module.css'

const SETTINGS_PATH = '/settings'
const SETTINGS_RETURN_KEY = 'eMateSettingsReturn'
const SETTINGS_CONTENT_SELECTOR = '[data-emate-settings-content]'
const HIDDEN_SETTINGS_SECTION_IDS = new Set(['models', 'plugins', 'agent-presets', 'vision-toolkit'])

export function applySettingsSectionVisibility(root: ParentNode): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-settings-section-id]')) {
    const hidden = HIDDEN_SETTINGS_SECTION_IDS.has(button.dataset.settingsSectionId ?? '')
    button.hidden = hidden
    button.style.display = hidden ? 'none' : ''
    if (hidden) button.setAttribute('aria-hidden', 'true')
    else button.removeAttribute('aria-hidden')
  }
}

interface TriggerProps {
  wide: boolean
  SettingsIcon: ComponentType<{ size?: number }>
  beforeNavigate?: () => Promise<void> | undefined
  onNavigationError?: () => void
}

export function SettingsTrigger({ wide, SettingsIcon, beforeNavigate, onNavigationError }: TriggerProps) {
  const label = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const trigger = label.current?.closest('button')
    if (!(trigger instanceof HTMLButtonElement)) return undefined
    trigger.dataset.emateSettingsTrigger = ''

    let generation = 0
    let approvedClick = false
    const guardOpen = (event: MouseEvent) => {
      if (approvedClick || document.querySelector(SETTINGS_CONTENT_SELECTOR)) return
      const request = ++generation
      const saving = beforeNavigate?.()
      if (!saving) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const path = location.pathname
      void saving.then(() => {
        if (request !== generation || location.pathname !== path || !trigger.isConnected) return
        approvedClick = true
        trigger.click()
        approvedClick = false
      }).catch(() => { if (request === generation) onNavigationError?.() })
    }
    trigger.addEventListener('click', guardOpen, true)
    let open = document.querySelector(SETTINGS_CONTENT_SELECTOR) !== null
    const projectTrigger = (panelOpen: boolean) => {
      trigger.inert = panelOpen
      if (panelOpen) trigger.setAttribute('aria-hidden', 'true')
      else trigger.removeAttribute('aria-hidden')
    }
    const syncPanel = () => {
      const shouldOpen = location.pathname === SETTINGS_PATH
      const isOpen = document.querySelector(SETTINGS_CONTENT_SELECTOR) !== null
      projectTrigger(isOpen)
      if (shouldOpen && !isOpen) trigger.click()
      if (!shouldOpen && isOpen) {
        document.querySelector<HTMLElement>('[data-emate-settings-close]')?.closest('button')?.click()
      }
    }
    const observer = new MutationObserver(records => {
      const changed = records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
        node instanceof Element
        && (node.matches(SETTINGS_CONTENT_SELECTOR) || node.querySelector(SETTINGS_CONTENT_SELECTOR) !== null),
      ))
      if (!changed) return
      const isOpen = document.querySelector(SETTINGS_CONTENT_SELECTOR) !== null
      projectTrigger(isOpen)
      if (isOpen === open) {
        syncPanel()
        return
      }
      open = isOpen
      if (isOpen && location.pathname !== SETTINGS_PATH) {
        const returnPath = `${location.pathname}${location.search}${location.hash}`
        history.pushState({ [SETTINGS_RETURN_KEY]: returnPath }, '', SETTINGS_PATH)
        dispatchEvent(new PopStateEvent('popstate'))
      } else if (!isOpen && location.pathname === SETTINGS_PATH) {
        const returnPath = history.state?.[SETTINGS_RETURN_KEY]
        history.replaceState(null, '', typeof returnPath === 'string' ? returnPath : '/')
        dispatchEvent(new PopStateEvent('popstate'))
      }
    })

    observer.observe(document.body, { childList: true, subtree: true })
    addEventListener('popstate', syncPanel)
    syncPanel()
    return () => {
      generation++
      trigger.removeEventListener('click', guardOpen, true)
      observer.disconnect()
      removeEventListener('popstate', syncPanel)
      projectTrigger(false)
      delete trigger.dataset.emateSettingsTrigger
    }
  }, [beforeNavigate, onNavigationError])

  return (
    <>
      <SettingsIcon size={18} />
      <span ref={label} className={wide ? css.triggerLabel : css.visuallyHidden}>设置</span>
    </>
  )
}

export function SettingsTitle() {
  return <>设置</>
}

export function SettingsCloseLabel() {
  return <span data-emate-settings-close="">关闭设置</span>
}

export function SettingsChrome({ updates, UpdateIcon }: {
  updates?: DesktopUpdateTriggerBridge
  UpdateIcon?: ComponentType<{ size?: number }>
} = {}) {
  const heading = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const dialog = heading.current?.closest('[role="dialog"]')
    if (dialog === null || dialog === undefined) return undefined
    applySettingsSectionVisibility(dialog)
    return undefined
  }, [])
  return (
    <div ref={heading} className={css.heading} data-emate-settings-header="" data-emate-settings-content="">
      <div><h1>设置</h1>
        <p>管理个人资料、常规设置、知识和记忆。</p>
      </div>
      {updates !== undefined && UpdateIcon !== undefined
        ? <UpdateControl updates={updates} UpdateIcon={UpdateIcon} compact={false} />
        : null}
    </div>
  )
}


/** Open the existing native Settings shell and select its registered pet section. */
export async function openNativePetSettings(): Promise<void> {
  const select = () => {
    const section = document.querySelector<HTMLButtonElement>('[data-settings-section-id="appearance-motion"]')
    if (!section) return false
    section.click()
    return true
  }
  if (select()) return
  const trigger = document.querySelector<HTMLButtonElement>('[data-emate-settings-trigger]')
  if (!trigger) throw new Error('Settings unavailable')
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => { observer.disconnect(); clearTimeout(timeout); error ? reject(error) : resolve() }
    const observer = new MutationObserver(() => { if (select()) finish() })
    const timeout = setTimeout(() => finish(new Error('Settings unavailable')), 5000)
    observer.observe(document.body, { childList: true, subtree: true })
    trigger.click()
    if (select()) finish()
  })
}
