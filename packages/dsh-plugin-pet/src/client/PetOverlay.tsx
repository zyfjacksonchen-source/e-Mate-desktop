/** Window-local drag and keyboard interaction adapted from the pinned MIT host. */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { bounds, normalizedPosition, pixelPosition, PET_SIZE, type Position } from '../settings.ts'
import { OFFICE_SCENES, type PetScene, type StandardState } from '../scenes.ts'
import { PetSprite, lookDirection } from './PetSprite.tsx'
import type { LoadedPet } from './resource.ts'
import css from './PetOverlay.module.css'
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight })
export function PetOverlay({ pet, scene, paused, position: saved, save, open, taskId, movable = true }: {
  pet: LoadedPet; scene: PetScene; paused: boolean; position: Position; save(position: Position): Promise<void>; open(taskId: string): void; taskId: string | null; movable?: boolean
}) {
  const [position, setPosition] = useState(() => pixelPosition(saved, viewport()))
  const [dragAnimation, setDragAnimation] = useState<StandardState | null>(null)
  const [look, setLook] = useState<number | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const drag = useRef<{ id: number; x: number; y: number; origin: Position; moved: boolean; position: Position } | null>(null)
  const suppressClick = useRef(false)
  const writeRevision = useRef(0)
  const mounted = useRef(true)
  const savedRef = useRef(saved)
  savedRef.current = saved
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; drag.current = null } }, [])
  useEffect(() => { if (drag.current === null) setPosition(pixelPosition(saved, viewport())) }, [saved.x, saved.y])
  useEffect(() => { const resize = () => setPosition(previous => bounds(previous, viewport())); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize) }, [])
  const persist = (next: Position) => { const revision = ++writeRevision.current; setSaveFailed(false); void save(normalizedPosition(next, viewport())).catch(() => { if (!mounted.current || revision !== writeRevision.current) return; setSaveFailed(true); setPosition(pixelPosition(savedRef.current, viewport())) }) }
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!movable) return
    const step = event.shiftKey ? 24 : 8
    const deltas: Record<string, readonly number[]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const delta = deltas[event.key]
    if (delta === undefined) return
    event.preventDefault(); const next = bounds({ x: position.x + delta[0]!, y: position.y + delta[1]! }, viewport()); setPosition(next); persist(next)
  }
  const begin = (event: PointerEvent<HTMLButtonElement>) => { if (!movable || event.button !== 0) return; suppressClick.current = false; drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: position, position, moved: false }; event.currentTarget.setPointerCapture(event.pointerId) }
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current
    if (active === null) { const rect = event.currentTarget.getBoundingClientRect(); setLook(lookDirection(event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2)); return }
    if (active.id !== event.pointerId) return
    const dx = event.clientX - active.x; const dy = event.clientY - active.y
    active.moved ||= Math.hypot(dx, dy) >= 4
    if (!active.moved) return
    setDragAnimation(dx < 0 ? 'running-left' : 'running-right')
    active.position = bounds({ x: active.origin.x + dx, y: active.origin.y + dy }, viewport()); setPosition(active.position)
  }
  const end = (event: PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const active = drag.current; if (active === null || active.id !== event.pointerId) return
    drag.current = null; suppressClick.current = active.moved && !cancelled; setDragAnimation(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (cancelled) setPosition(pixelPosition(saved, viewport())); else if (active.moved) persist(active.position)
  }
  const label = OFFICE_SCENES.find(row => row[0] === scene)?.[1] ?? (scene === 'running' ? '正在处理任务' : '待命')
  return <div className={css.overlay} data-pet-overlay>
    <button type="button" className={css.pet} style={{ width: PET_SIZE, left: position.x, top: position.y, right: 'auto', bottom: 'auto' }}
      aria-label={`小芯：${label}。${taskId === null ? '暂无当前任务。' : '打开任务详情。'}${movable ? '方向键移动，Shift 加速。' : ''}`} data-pet-id="xiaoxin"
      onKeyDown={keyboard} onPointerDown={begin} onPointerMove={move} onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)}
      onLostPointerCapture={event => { if (drag.current !== null) end(event, true) }} onPointerLeave={() => setLook(null)}
      onClick={() => { if (suppressClick.current) { suppressClick.current = false; return }; if (taskId !== null) open(taskId) }}>
      <PetSprite pet={pet} scene={scene} drag={dragAnimation} look={scene === 'idle' ? look : null} paused={paused} />
      {saveFailed && <span role="status" className={css.saveError}>位置未保存</span>}
    </button>
  </div>
}
