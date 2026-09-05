import { OFFICE_SCENES } from './scenes.ts'
import { CODEX_PET_ANIMATION_FRAMES } from './client/pet-animation.ts'
export const ASSET_PREFIX = '/assets/e-mate/pet/'
export const ASSET_FILES = ['xiaoxin-v2.json', 'xiaoxin-v2.webp', 'xiaoxin-office.json', 'xiaoxin-office.webp'] as const
export type AssetFile = typeof ASSET_FILES[number]
export interface Atlas { readonly file: 'xiaoxin-v2.webp' | 'xiaoxin-office.webp'; readonly sha256: string; readonly bytes: number; readonly width: number; readonly height: number; readonly cellWidth: 192; readonly cellHeight: 208; readonly columns: 8; readonly rows: 11 | 30 }
export interface BaseManifest { readonly schemaVersion: 1; readonly id: 'xiaoxin'; readonly displayName: '小芯'; readonly spriteVersionNumber: 2; readonly atlas: Atlas; readonly animations: readonly { readonly id: string; readonly row: number; readonly frames: number; readonly durationsMs: readonly number[] }[]; readonly directions: readonly number[] }
export interface OfficeManifest { readonly schemaVersion: 1; readonly id: 'xiaoxin-office'; readonly baseSha256: string; readonly atlas: Atlas; readonly scenes: readonly { readonly id: string; readonly row: number; readonly frames: 8; readonly durationsMs: readonly number[] }[] }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
function atlas(value: unknown, file: Atlas['file'], rows: 11 | 30): asserts value is Atlas {
  assert(exact(value, ['file', 'sha256', 'bytes', 'width', 'height', 'cellWidth', 'cellHeight', 'columns', 'rows']), 'Invalid pet atlas envelope')
  assert(value.file === file && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256), 'Invalid pet atlas identity')
  assert(Number.isSafeInteger(value.bytes) && (value.bytes as number) > 0 && (value.bytes as number) <= 32 * 1024 * 1024, 'Pet atlas byte bound exceeded')
  assert(value.width === 1536 && value.height === rows * 208 && value.cellWidth === 192 && value.cellHeight === 208 && value.columns === 8 && value.rows === rows, 'Invalid pet atlas geometry')
}
export function validateBase(value: unknown): BaseManifest {
  assert(exact(value, ['schemaVersion', 'id', 'displayName', 'spriteVersionNumber', 'atlas', 'animations', 'directions']), 'Invalid v2 pet manifest')
  assert(value.schemaVersion === 1 && value.id === 'xiaoxin' && value.displayName === '小芯' && value.spriteVersionNumber === 2, 'Only Xiaoxin sprite v2 is admitted')
  atlas(value.atlas, 'xiaoxin-v2.webp', 11)
  const rows = Object.entries(CODEX_PET_ANIMATION_FRAMES).sort((left, right) => left[1][0].rowIndex - right[1][0].rowIndex)
  assert(Array.isArray(value.animations) && value.animations.length === 9, 'Nine standard animation rows are required')
  for (const [index, [id, frames]] of rows.entries()) {
    const row = value.animations[index]
    assert(exact(row, ['id', 'row', 'frames', 'durationsMs']) && row.id === id && row.row === index && row.frames === frames.length
      && Array.isArray(row.durationsMs) && row.durationsMs.length === frames.length && frames.every((frame, i) => (row.durationsMs as unknown[])[i] === frame.frameDurationMs), 'Invalid standard animation row')
  }
  assert(Array.isArray(value.directions) && value.directions.length === 16 && value.directions.every((angle, i) => angle === i * 22.5), 'Sixteen clockwise look directions are required')
  return value as unknown as BaseManifest
}
export function validateOffice(value: unknown, base: BaseManifest): OfficeManifest {
  assert(exact(value, ['schemaVersion', 'id', 'baseSha256', 'atlas', 'scenes']) && value.schemaVersion === 1 && value.id === 'xiaoxin-office' && value.baseSha256 === base.atlas.sha256, 'Invalid office extension identity')
  atlas(value.atlas, 'xiaoxin-office.webp', 30)
  assert(Array.isArray(value.scenes) && value.scenes.length === 30, 'All thirty office scenes are required')
  for (const [index, [id]] of OFFICE_SCENES.entries()) {
    const row = value.scenes[index]
    assert(exact(row, ['id', 'row', 'frames', 'durationsMs']) && row.id === id && row.row === index && row.frames === 8
      && Array.isArray(row.durationsMs) && row.durationsMs.length === 8 && row.durationsMs.every(ms => Number.isSafeInteger(ms) && ms >= 80 && ms <= 2000), 'Invalid office scene row')
  }
  return value as unknown as OfficeManifest
}
