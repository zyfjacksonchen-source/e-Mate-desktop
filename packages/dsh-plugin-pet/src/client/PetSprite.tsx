/** Adapted from pinned MIT dsh-pet's timer-based sprite renderer. */
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { getPetAnimationSequence, type PetAnimationFrame } from './pet-animation.ts'
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
  const sequence = useMemo(() => {
    if (scene === 'idle' && drag === null && look !== null) return { frames: [{ rowIndex: 9 + Math.floor(look / 8), columnIndex: look % 8, frameDurationMs: 150 }], loopStartIndex: null }
    if (office) return { frames: pet.office!.scenes[officeIndex]!.durationsMs.map((frameDurationMs, columnIndex) => ({ rowIndex: officeIndex, columnIndex, frameDurationMs })), loopStartIndex: 0 }
    return getPetAnimationSequence(drag ?? standardState(scene), false)
  }, [scene, drag, look, office, officeIndex, pet])
  const [index, setIndex] = useState(0)
  useEffect(() => {
    setIndex(0)
    if (paused || sequence.frames.length <= 1) return
    let timer: ReturnType<typeof setTimeout>; let cursor = 0
    const schedule = () => {
      const frame = sequence.frames[cursor]!
      timer = setTimeout(() => { if (cursor + 1 < sequence.frames.length) cursor += 1; else if (sequence.loopStartIndex !== null) cursor = sequence.loopStartIndex; else return; setIndex(cursor); schedule() }, frame.frameDurationMs)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [sequence, paused])
  const frame = sequence.frames[paused ? 0 : Math.min(index, sequence.frames.length - 1)] as PetAnimationFrame
  const rows = office ? 30 : 11
  return <span aria-hidden="true" className={css.sprite} data-frame-row={frame.rowIndex} data-frame-column={frame.columnIndex} data-pet-scene={scene}
    style={{ '--pet-atlas': `url(${JSON.stringify(office ? pet.officeUrl : pet.baseUrl)})`, '--pet-atlas-rows': `${rows * 100}%`, '--pet-frame-position': `${frame.columnIndex / 7 * 100}% ${frame.rowIndex / (rows - 1) * 100}%` } as CSSProperties} />
}
