import { isOfficeScene, type OfficeScene, type PetScene } from './scenes.ts'

/** Read-only Cordis callback supplied by the Shell's existing work owners. */
export type PetWorkOperation = 'image-generate' | 'image-edit' | 'web-search' | 'file-search' | 'browser' | 'code-write'
  | 'document-write' | 'document-read' | 'spreadsheet' | 'slides' | 'pdf-read'
export interface PetWorkFacts {
  readonly operation?: PetWorkOperation
  readonly completedOperation?: PetWorkOperation
  readonly delivered: boolean
  readonly needsAttention?: boolean
  readonly failed?: boolean
  /** A retained output is not evidence that the whole task or batch succeeded. */
  readonly hasUsableOutput?: boolean
}
export type PetWorkFactsReader = (sessionId: string) => PetWorkFacts

/** Glue consumes the existing native projections; never text, DOM, tokens or Tool args.
 * operation is an admitted semantic category from the native Tool/Job owner.
 * Unknown/private providers must omit it, never classify from names or content.
 */
export interface PetTaskProjection {
  readonly taskId: string | null
  readonly revision: number
  readonly firstResponsePending: boolean
  readonly window: { readonly visible: boolean; readonly minimized?: boolean }
  readonly goal?: { readonly status: 'active' | 'completed' | 'blocked' }
  readonly todo?: { readonly status: 'pending' | 'in_progress' | 'completed'; readonly operation?: OfficeScene }
  readonly queue?: { readonly pending: number }
  readonly job?: { readonly status: 'running' | 'waiting' | 'failed' | 'completed'; readonly operation?: OfficeScene }
  readonly tool?: { readonly status: 'running' | 'approval' | 'waiting' | 'failed' | 'completed'; readonly operation?: OfficeScene }
  readonly deliverable?: { readonly status: 'building' | 'completed' | 'failed' }
}
/** Implemented by Shell glue over the existing shared structured task surface. */
export interface PetTaskService {
  getSnapshot(): PetTaskProjection
  subscribe(listener: () => void): () => void
  openTaskDetails(taskId: string): void
}
export const EMPTY_PROJECTION: PetTaskProjection = Object.freeze({
  taskId: null, revision: 0, firstResponsePending: true,
  window: Object.freeze({ visible: false, minimized: false }),
})
const OPERATIONS = new Set<OfficeScene>([
  'startup', 'requirements', 'planning', 'file-search', 'document-read', 'code-write',
  'terminal', 'build', 'test', 'debug', 'code-review', 'web-search', 'browser', 'form-fill',
  'download', 'data-analysis', 'spreadsheet', 'document-write', 'slides', 'pdf-read',
  'image-generate', 'image-edit', 'canvas', 'meeting', 'upload',
])
function operation(value: unknown): PetScene {
  return isOfficeScene(value) && OPERATIONS.has(value) ? value : 'running'
}
/** Precedence is contractual. Missing native facts remain idle, never invented success. */
export function deriveScene(value: PetTaskProjection): PetScene {
  if (value.taskId === null) return 'idle'
  if (value.tool?.status === 'approval' || value.tool?.status === 'waiting' || value.job?.status === 'waiting' || value.goal?.status === 'blocked') return 'waiting'
  if (value.tool?.status === 'failed' || value.job?.status === 'failed' || value.deliverable?.status === 'failed') return 'error'
  if (value.tool?.status === 'running') return operation(value.tool.operation)
  if (value.job?.status === 'running') return operation(value.job.operation)
  if (value.todo?.status === 'in_progress') return operation(value.todo.operation)
  if (value.goal?.status === 'active') return 'goal'
  if ((value.queue?.pending ?? 0) > 0) return 'queue'
  if (value.tool?.status === 'completed' && value.tool.operation !== undefined) return operation(value.tool.operation)
  if (value.deliverable?.status === 'completed' || value.deliverable?.status === 'building') return 'delivery'
  return 'idle'
}
export const MIN_DWELL_MS = 750
export interface SceneState { readonly taskId: string | null; readonly revision: number; readonly scene: PetScene; readonly since: number }
/** Pure presentation hysteresis. A route switch never retains another task's scene. */
export function nextScene(previous: SceneState, projection: PetTaskProjection, now: number): { state: SceneState; delay: number | null } {
  if (projection.taskId === previous.taskId && projection.revision < previous.revision) return { state: previous, delay: null }
  const scene = deriveScene(projection)
  if (projection.taskId !== previous.taskId) return { state: { taskId: projection.taskId, revision: projection.revision, scene, since: now }, delay: null }
  if (scene === previous.scene) return { state: { ...previous, revision: projection.revision }, delay: null }
  const remaining = MIN_DWELL_MS - (now - previous.since)
  if (remaining > 0) return { state: previous, delay: remaining }
  return { state: { taskId: projection.taskId, revision: projection.revision, scene, since: now }, delay: null }
}
export function motionPaused(projection: PetTaskProjection, documentHidden: boolean, reducedMotion: boolean): boolean {
  return projection.firstResponsePending || !projection.window.visible || projection.window.minimized === true || documentHidden || reducedMotion
}
