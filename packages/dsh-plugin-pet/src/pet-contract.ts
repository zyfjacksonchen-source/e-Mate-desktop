/** V2-only atlas contract adapted from the pinned MIT dsh-pet metadata. */
export type PetSpriteVersion = 2
export type PetState = 'idle' | 'running' | 'waiting' | 'failed' | 'review'
export const CODEX_PET_ATLAS_V2 = Object.freeze({ version: 2, width: 1536, height: 2288, cellWidth: 192, cellHeight: 208, columns: 8, rows: 11, requiredFramesByRow: Object.freeze([6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]) })
export const CODEX_PET_ATLASES = Object.freeze({ 2: CODEX_PET_ATLAS_V2 })
