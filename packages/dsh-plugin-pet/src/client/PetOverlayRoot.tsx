/** Root overlay entry that declares the current-session-aware pet seat. */

import type { ReactNode } from 'react'
import type { PetOverlayRootRuntimeProps } from './runtime-types.ts'

/** Full props for the root-scoped overlay declaration entry. */
export type PetOverlayRootProps = PetOverlayRootRuntimeProps

/**
 * Render the session-maybe child seat at the frame-wide overlay position.
 * @param props - slot dispatcher authorized by this entry's child declaration.
 * @returns the current pet contribution, or null when no occupant is present.
 */
export function PetOverlayRoot({ renderSlot }: PetOverlayRootProps): ReactNode {
  return renderSlot('shell.overlay.pet', {})
}
