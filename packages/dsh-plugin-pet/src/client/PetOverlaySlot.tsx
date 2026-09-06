/** The same session-maybe overlay seat as upstream, with admitted asset loading. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { deriveScene, nextScene, motionPaused, type SceneState } from '../projection.ts'
import { decodeSettings } from '../settings.ts'
import { setPetSetting } from './settings-write.ts'
import { NativePetProjection } from './native-projection.ts'
import { PetResources } from './resources.ts'
import { PetOverlay } from './PetOverlay.tsx'
import type { PetDetails, PetSettingsScope } from './runtime-types.ts'
export interface OverlayProps { projection: NativePetProjection; resources: PetResources; settings: PetSettingsScope; details: PetDetails }
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => { const media = matchMedia('(prefers-reduced-motion: reduce)'); const change = () => setReduced(media.matches); media.addEventListener('change', change); change(); return () => media.removeEventListener('change', change) }, [])
  return reduced
}
export function PetOverlaySlot({ projection, resources, settings, details }: OverlayProps) {
  const task = useSyncExternalStore(projection.subscribe, projection.getSnapshot, projection.getSnapshot)
  const asset = useSyncExternalStore(resources.subscribe, resources.getSnapshot, resources.getSnapshot)
  const preferences = useSyncExternalStore(useCallback(listener => settings.subscribe(listener), [settings]), useCallback(() => settings.getSnapshot(), [settings]))
  const reduced = useReducedMotion()
  const selected = decodeSettings(preferences.value)
  const paused = motionPaused(task, document.visibilityState !== 'visible', reduced)
  const eligible = selected.enabled && preferences.status === 'ready' && !task.firstResponsePending && task.window.visible && !task.window.minimized
  const initial: SceneState = { taskId: task.taskId, revision: task.revision, scene: deriveScene(task), since: performance.now() }
  const stateRef = useRef(initial)
  const [state, setState] = useState(initial)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const apply = () => { const next = nextScene(stateRef.current, task, performance.now()); stateRef.current = next.state; setState(next.state); if (next.delay !== null && task.window.visible && task.window.minimized !== true) timer = setTimeout(apply, next.delay) }
    apply()
    return () => { if (timer !== undefined) clearTimeout(timer) }
  }, [task, paused])
  useEffect(() => {
    if (!eligible) { resources.pause(); return }
    if (asset.status !== 'idle') return
    // Never force an idle callback with a timeout into a first-response frame.
    const start = () => { const latest = projection.getSnapshot(); if (!latest.firstResponsePending && latest.window.visible && !latest.window.minimized) resources.start() }
    const request = typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback(start)
      : window.setTimeout(start, 750)
    return () => { if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(request); else window.clearTimeout(request) }
  }, [eligible, resources, asset.status, projection])
  useEffect(() => () => resources.pause(), [resources])
  if (!selected.enabled || asset.pet === undefined) return null
  const scene = state.taskId === task.taskId ? state.scene : deriveScene(task)
  return <PetOverlay pet={asset.pet} scene={scene} paused={paused} completed={task.tool?.status === 'completed' && task.tool.operation === scene}
    movable={preferences.status === 'ready' && preferences.writable} position={selected.position} save={position => setPetSetting(settings, 'position', position)} taskId={task.taskId}
    open={taskId => { if (projection.getSnapshot().taskId === taskId) details.openTaskDetails(taskId) }} />
}
