/** DSH pet animation sequences for package-owned and Codex-compatible atlases. */

import {
  CODEX_PET_ATLASES, type PetSpriteVersion, type PetState,
} from '../pet-contract.ts'

/** Hover, drag, and task states with dedicated rows in a Codex atlas. */
export type PetAnimationState =
  | PetState
  | 'jumping'
  | 'running-left'
  | 'running-right'
  | 'waving'

/** One timed cell in a Codex pet atlas. */
export interface PetAnimationFrame {
  /** Zero-based atlas row. */
  readonly rowIndex: number
  /** Zero-based atlas column. */
  readonly columnIndex: number
  /** Time to retain this cell before advancing. */
  readonly frameDurationMs: number
}

/** Non-empty frame list guaranteed by every supported Codex animation state. */
export type PetAnimationFrames = readonly [PetAnimationFrame, ...PetAnimationFrame[]]

/** Timed cells plus the index to revisit after the final cell. */
export interface PetAnimationSequence {
  /** Cells in playback order. */
  readonly frames: PetAnimationFrames
  /** Loop target, or null for a finite sequence. */
  readonly loopStartIndex: number | null
}

/** Number of full task-action passes before the renderer settles into slow idle. */
export const CODEX_PET_NON_IDLE_REPEAT_COUNT = 3

/** Duration multiplier applied to the idle tail after a task animation. */
export const CODEX_PET_SLOW_IDLE_MULTIPLIER = 6

const IDLE_FRAMES: PetAnimationFrames = Object.freeze([
  Object.freeze({ rowIndex: 0, columnIndex: 0, frameDurationMs: 280 }),
  Object.freeze({ rowIndex: 0, columnIndex: 1, frameDurationMs: 110 }),
  Object.freeze({ rowIndex: 0, columnIndex: 2, frameDurationMs: 110 }),
  Object.freeze({ rowIndex: 0, columnIndex: 3, frameDurationMs: 140 }),
  Object.freeze({ rowIndex: 0, columnIndex: 4, frameDurationMs: 140 }),
  Object.freeze({ rowIndex: 0, columnIndex: 5, frameDurationMs: 320 }),
])

function uniformFrames(
  rowIndex: number,
  count: number,
  frameDurationMs: number,
  finalFrameDurationMs: number,
): PetAnimationFrames {
  return Object.freeze(Array.from({ length: count }, (_, columnIndex) => Object.freeze({
    rowIndex,
    columnIndex,
    frameDurationMs: columnIndex === count - 1 ? finalFrameDurationMs : frameDurationMs,
  }))) as PetAnimationFrames
}

/** Exact row, cell count, and timing table used by Codex pet animations. */
export const CODEX_PET_ANIMATION_FRAMES: Readonly<
  Record<PetAnimationState, PetAnimationFrames>
> = Object.freeze({
  failed: uniformFrames(5, 8, 140, 240),
  idle: IDLE_FRAMES,
  jumping: uniformFrames(4, 5, 140, 280),
  review: uniformFrames(8, 6, 150, 280),
  running: uniformFrames(7, 6, 120, 220),
  'running-left': uniformFrames(2, 8, 120, 220),
  'running-right': uniformFrames(1, 8, 120, 220),
  waving: uniformFrames(3, 4, 140, 280),
  waiting: uniformFrames(6, 6, 150, 260),
})

const SLOW_IDLE_FRAMES = Object.freeze(IDLE_FRAMES.map(frame =>
  Object.freeze({ ...frame, frameDurationMs: frame.frameDurationMs * CODEX_PET_SLOW_IDLE_MULTIPLIER }),
)) as PetAnimationFrames

/**
 * Build Codex's finite action lead-in and slow-idle loop.
 * @param state - task, hover, or drag animation to play.
 * @param reducedMotion - whether playback must remain on the state's first cell.
 * @returns frame order and loop target for the renderer's timer.
 */
export function getPetAnimationSequence(
  state: PetAnimationState,
  reducedMotion: boolean,
): PetAnimationSequence {
  const frames = CODEX_PET_ANIMATION_FRAMES[state]
  if (reducedMotion) return { frames: [frames[0]], loopStartIndex: null }
  if (state === 'idle') return { frames, loopStartIndex: 0 }

  const actionFrames = Array.from(
    { length: CODEX_PET_NON_IDLE_REPEAT_COUNT },
    () => frames,
  ).flat()
  return {
    frames: [...actionFrames, ...SLOW_IDLE_FRAMES] as unknown as PetAnimationFrames,
    loopStartIndex: actionFrames.length,
  }
}

/**
 * Convert one atlas cell to CSS `background-position` percentages.
 * @param frame - cell selected by the animation sequence.
 * @param spriteVersion - atlas layout used by the selected pet.
 * @returns horizontal and vertical background-position percentages.
 */
export function petFrameBackgroundPosition(
  frame: Pick<PetAnimationFrame, 'columnIndex' | 'rowIndex'>,
  spriteVersion: PetSpriteVersion,
): string {
  const atlas = CODEX_PET_ATLASES[spriteVersion]
  return `${frame.columnIndex / (atlas.columns - 1) * 100}% ${frame.rowIndex / (atlas.rows - 1) * 100}%`
}
