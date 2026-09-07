/** Adapted from pinned MIT dsh-pet's timer-based sprite renderer. */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { getPetAnimationSequence, PET_FRAME_DURATION_MULTIPLIER, type PetAnimationFrame } from './pet-animation.ts'
import { OFFICE_SCENES, standardState, type PetScene, type StandardState } from '../scenes.ts'
import type { LoadedPet } from './resource.ts'
import css from './PetSprite.module.css'
export function lookDirection(dx: number, dy: number): number | null {
  if (Math.hypot(dx, dy) < 20) return null
  return Math.round(((Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360) / 22.5) % 16
}
export function PetSprite({ pet, scene, drag, look, paused }: { pet: LoadedPet; scene: PetScene; drag: StandardState | null; look: number | null; paused: boolean }) {
  const officeIndex = drag === null ? OFFICE_SCENES.findIndex(row => row[0] === scene) : -1
  const office = officeIndex >= 0 && pet.office !== undefined && pet.officeUrl !== undefined
  const lookCell = scene === 'idle' && drag === null ? look : null
  const sequence = useMemo(() => {
    if (lookCell !== null) return { frames: [{ rowIndex: 9 + Math.floor(lookCell / 8), columnIndex: lookCell % 8, frameDurationMs: 150 }], loopStartIndex: null }
    if (office) return { frames: pet.office!.scenes[officeIndex]!.durationsMs.map((frameDurationMs, columnIndex) => ({ rowIndex: officeIndex, columnIndex, frameDurationMs: frameDurationMs * PET_FRAME_DURATION_MULTIPLIER })), loopStartIndex: null }
    return getPetAnimationSequence(drag ?? standardState(scene), false)
  }, [scene, drag, lookCell, office, officeIndex, pet])
  const [index, setIndex] = useState(0)
  const playback = useRef({ sequence, cursor: 0 })
  useEffect(() => {
    if (playback.current.sequence !== sequence) { playback.current = { sequence, cursor: 0 }; setIndex(0) }
    if (paused || sequence.frames.length <= 1) return
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      const cursor = playback.current.cursor
      if (cursor === sequence.frames.length - 1 && sequence.loopStartIndex === null) return
      const frame = sequence.frames[cursor]!
      timer = setTimeout(() => { playback.current.cursor = cursor + 1 < sequence.frames.length ? cursor + 1 : sequence.loopStartIndex!; setIndex(playback.current.cursor); schedule() }, frame.frameDurationMs)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [sequence, paused])
  const frame = sequence.frames[Math.min(index, sequence.frames.length - 1)] as PetAnimationFrame
  const rows = office ? 30 : 11
  return <span aria-hidden="true" className={css.sprite} data-frame-row={frame.rowIndex} data-frame-column={frame.columnIndex} data-pet-scene={scene}
    style={{ '--pet-atlas': `url(${JSON.stringify(office ? pet.officeUrl : pet.baseUrl)})`, '--pet-atlas-rows': `${rows * 100}%`, '--pet-frame-position': `${frame.columnIndex / 7 * 100}% ${frame.rowIndex / (rows - 1) * 100}%` } as CSSProperties} />
}
