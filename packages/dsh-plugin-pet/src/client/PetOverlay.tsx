/** Window-local drag and keyboard interaction adapted from the pinned MIT host. */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { bounds, normalizedPosition, pixelPosition, DEFAULT_SETTINGS, PET_SIZE, type Position } from '../settings.ts'
import { OFFICE_SCENES, type PetScene, type StandardState } from '../scenes.ts'
import { PetSprite, lookDirection } from './PetSprite.tsx'
import type { LoadedPet } from './resource.ts'
import css from './PetOverlay.module.css'
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight })
export function PetOverlay({ pet, scene, paused, position: saved, save, open, taskId, movable = true, completed = false, close, openSettings, freeMotion = false }: {
  pet: LoadedPet; scene: PetScene; paused: boolean; position: Position; save(position: Position): Promise<void>; open(taskId: string): void; taskId: string | null; movable?: boolean; completed?: boolean
  close?(): Promise<void>; openSettings?(): void
  freeMotion?: boolean
}) {
  const [position, setPosition] = useState(() => pixelPosition(saved, viewport()))
  const positionRef = useRef(position)
  const place = (next: Position) => { positionRef.current = next; setPosition(next) }
  const [dragAnimation, setDragAnimation] = useState<StandardState | null>(null)
  const [look, setLook] = useState<number | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const [actionError, setActionError] = useState('')
  const [menu, setMenu] = useState<Position | null>(null)
  const [motionScene, setMotionScene] = useState<PetScene>('idle')
  const motionCurrent = useRef<PetScene>('idle')
  const motionBag = useRef<PetScene[]>([])
  const officeReady = pet.office !== undefined && pet.officeUrl !== undefined
  useEffect(() => { motionBag.current = [] }, [officeReady])
  useEffect(() => {
    if (!freeMotion || paused || dragAnimation !== null || menu !== null) return
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      timer = setTimeout(() => {
        if (!motionBag.current.length) {
          const choices: PetScene[] = officeReady
            ? ['idle', ...OFFICE_SCENES.filter(([id]) => id !== 'error' && id !== 'waiting').map(([id]) => id)]
            : ['idle', 'startup', 'delivery', 'document-read', 'running']
          for (let i = choices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1)); [choices[i], choices[j]] = [choices[j]!, choices[i]!]
          }
          if (choices.at(-1) === motionCurrent.current) [choices[0], choices[choices.length - 1]] = [choices.at(-1)!, choices[0]!]
          motionBag.current = choices
        }
        const next = motionBag.current.pop()!
        motionCurrent.current = next; setMotionScene(next); schedule()
      }, 8000 + Math.floor(Math.random() * 8000))
    }
    schedule()
    return () => clearTimeout(timer)
  }, [freeMotion, paused, dragAnimation !== null, menu !== null, officeReady])
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; x: number; y: number; origin: Position; moved: boolean; position: Position } | null>(null)
  const suppressClick = useRef(false)
  const writeRevision = useRef(0)
  const pending = useRef<{ revision: number; point: Position } | null>(null)
  const mounted = useRef(true)
  const savedRef = useRef(saved)
  savedRef.current = saved
  const release = (id: number) => {
    const button = buttonRef.current
    if (button?.hasPointerCapture(id)) button.releasePointerCapture(id)
  }
  const cancelDrag = () => {
    const active = drag.current
    if (!active) return
    drag.current = null
    suppressClick.current = active.moved
    setDragAnimation(null)
    release(active.id)
    place(pixelPosition(pending.current?.point ?? savedRef.current, viewport()))
  }
  const closeMenu = (restoreFocus: boolean) => { setMenu(null); if (restoreFocus) buttonRef.current?.focus({ preventScroll: true }) }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; drag.current = null } }, [])
  useEffect(() => {
    // Earlier native writes may publish while a later gesture is queued. Their
    // readback is authoritative history, but must not snap the latest gesture back.
    if (drag.current === null && pending.current === null) place(pixelPosition(saved, viewport()))
  }, [saved.x, saved.y])
  useEffect(() => {
    const resize = () => {
      cancelDrag()
      place(pixelPosition(pending.current?.point ?? savedRef.current, viewport()))
      closeMenu(false)
    }
    const blur = () => { cancelDrag(); closeMenu(false) }
    window.addEventListener('resize', resize); window.addEventListener('blur', blur)
    return () => { window.removeEventListener('resize', resize); window.removeEventListener('blur', blur) }
  }, [])
  useEffect(() => { if (!movable) cancelDrag() }, [movable])
  useEffect(() => {
    if (!menu) return
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !buttonRef.current?.contains(event.target)) closeMenu(false)
    }
    window.addEventListener('pointerdown', outside)
    return () => window.removeEventListener('pointerdown', outside)
  }, [menu])
  useLayoutEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [menu !== null])
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    const x = Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))
    const y = Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))
    if (x !== menu.x || y !== menu.y) setMenu({ x, y })
  }, [menu, closing, actionError, movable])
  const persist = (next: Position, point = normalizedPosition(next, viewport())) => {
    const revision = ++writeRevision.current
    pending.current = { revision, point }
    setSaveFailed(false)
    void save(point).then(() => {
      if (!mounted.current || revision !== writeRevision.current) return
      pending.current = null
    }, () => {
      if (!mounted.current || revision !== writeRevision.current) return
      pending.current = null
      setSaveFailed(true)
      if (!drag.current) place(pixelPosition(savedRef.current, viewport()))
    })
  }
  const showMenu = (point?: Position) => {
    cancelDrag()
    setLook(null); setActionError('')
    const rect = buttonRef.current?.getBoundingClientRect()
    setMenu({ x: Math.max(8, Math.min(point?.x ?? rect?.left ?? 8, window.innerWidth - 200)), y: Math.max(8, Math.min(point?.y ?? rect?.bottom ?? 8, window.innerHeight - 168)) })
  }
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); showMenu(); return }
    if (event.key === 'Escape') { event.preventDefault(); cancelDrag(); return }
    if ((event.key === 'Enter' || event.key === ' ') && !drag.current) suppressClick.current = false
    if (!movable || drag.current) return
    const step = event.shiftKey ? 24 : 8
    const deltas: Record<string, readonly number[]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const delta = deltas[event.key]
    if (delta === undefined) return
    event.preventDefault(); event.stopPropagation()
    const previous = positionRef.current
    const next = bounds({ x: previous.x + delta[0]!, y: previous.y + delta[1]! }, viewport())
    place(next); persist(next)
  }
  const begin = (event: PointerEvent<HTMLButtonElement>) => {
    if (!movable || event.button !== 0 || drag.current) return
    event.preventDefault(); event.stopPropagation(); closeMenu(false)
    buttonRef.current?.focus({ preventScroll: true })
    suppressClick.current = false
    const origin = positionRef.current
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin, position: origin, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current
    if (active === null) { const rect = event.currentTarget.getBoundingClientRect(); setLook(lookDirection(event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2)); return }
    if (active.id !== event.pointerId) return
    event.preventDefault(); event.stopPropagation()
    const dx = event.clientX - active.x; const dy = event.clientY - active.y
    active.moved ||= Math.hypot(dx, dy) >= 4
    if (!active.moved) return
    setDragAnimation(dx < 0 ? 'running-left' : 'running-right')
    active.position = bounds({ x: active.origin.x + dx, y: active.origin.y + dy }, viewport()); place(active.position)
  }
  const end = (event: PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const active = drag.current; if (active === null || active.id !== event.pointerId) return
    if (cancelled) { cancelDrag(); return }
    drag.current = null; suppressClick.current = active.moved; setDragAnimation(null)
    release(event.pointerId)
    if (active.moved) persist(active.position)
  }
  const menuKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); return }
    if (event.key === 'Tab') { closeMenu(false); return }
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length : null
    if (next !== null) { event.preventDefault(); event.stopPropagation(); buttons[next]?.focus() }
  }
  const hide = () => {
    if (!close || !movable || closingRef.current) return
    closingRef.current = true; setClosing(true); setActionError('')
    void close().then(() => { if (mounted.current) closeMenu(true) }, () => {
      if (mounted.current) setActionError('关闭未保存，请重试。')
    }).finally(() => { closingRef.current = false; if (mounted.current) setClosing(false) })
  }
  const label = OFFICE_SCENES.find(row => row[0] === scene)?.[1] ?? (scene === 'running' ? '正在处理任务' : '待命')
  const visualScene = freeMotion ? motionScene : scene
  return <div className={css.overlay} data-pet-overlay>
    <button ref={buttonRef} type="button" className={css.pet} style={{ width: PET_SIZE, left: position.x, top: position.y, right: 'auto', bottom: 'auto' }}
      title={completed ? `最近完成：${label}` : label}
      aria-label={`小芯：${completed ? '最近完成：' : ''}${label}。${taskId === null ? '暂无当前任务。' : '打开任务详情。'}${movable ? '方向键移动，Shift 加速。' : ''}右键或 Shift+F10 打开菜单。`} data-pet-id="xiaoxin" data-movable={movable} aria-haspopup="menu" aria-expanded={menu !== null}
      onKeyDown={keyboard} onPointerDown={begin} onPointerMove={move} onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)}
      onLostPointerCapture={event => { if (drag.current !== null) end(event, true) }} onPointerLeave={() => setLook(null)}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); showMenu(event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined) }}
      onClick={() => { if (suppressClick.current) { suppressClick.current = false; return }; if (taskId !== null) open(taskId) }}>
      <PetSprite pet={pet} scene={visualScene} drag={dragAnimation} look={visualScene === 'idle' ? look : null} paused={paused} />
      {saveFailed && <span role="status" className={css.saveError}>位置未保存</span>}
    </button>
    {menu && <div ref={menuRef} role="menu" aria-label="小芯菜单" className={css.menu} style={{ left: menu.x, top: menu.y }} onKeyDown={menuKeyboard} onContextMenu={event => event.preventDefault()}>
      <button type="button" role="menuitem" disabled={!openSettings || closing} onClick={() => { closeMenu(false); openSettings?.() }}>小芯设置</button>
      <button type="button" role="menuitem" disabled={!movable || closing} onClick={() => { closeMenu(true); const next = pixelPosition(DEFAULT_SETTINGS.position, viewport()); place(next); persist(next, DEFAULT_SETTINGS.position) }}>重置位置</button>
      <button type="button" role="menuitem" disabled={!movable || !close || closing} onClick={hide}>{closing ? '正在关闭…' : '关闭小芯'}</button>
      {!movable && <span className={css.menuNote}>设置暂不可写，位置和显示状态无法保存。</span>}
      {actionError && <span role="status" className={css.menuNote}>{actionError}</span>}
    </div>}
  </div>
}
