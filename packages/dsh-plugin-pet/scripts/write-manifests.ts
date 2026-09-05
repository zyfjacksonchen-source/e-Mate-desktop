/** Main-agent asset handoff: writes metadata only after both real image files exist. */
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { OFFICE_SCENES } from '../src/scenes.ts'
import { CODEX_PET_ANIMATION_FRAMES } from '../src/client/pet-animation.ts'
const root = resolve(process.argv[2] ?? new URL('../assets/', import.meta.url).pathname)
async function atlas(file: string, rows: number) {
  const data = await readFile(resolve(root, file))
  if (data.length < 30 || data.length > 32 * 1024 * 1024 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') throw new Error('A real bounded WebP asset is required')
  return { file, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, width: 1536, height: rows * 208, cellWidth: 192, cellHeight: 208, columns: 8, rows }
}
const baseAtlas = await atlas('xiaoxin-v2.webp', 11)
const officeAtlas = await atlas('xiaoxin-office.webp', 30)
const base = { schemaVersion: 1, id: 'xiaoxin', displayName: '小芯', spriteVersionNumber: 2, atlas: baseAtlas,
  animations: Object.entries(CODEX_PET_ANIMATION_FRAMES).sort((a, b) => a[1][0].rowIndex - b[1][0].rowIndex).map(([id, frames]) => ({ id, row: frames[0].rowIndex, frames: frames.length, durationsMs: frames.map(frame => frame.frameDurationMs) })),
  directions: Array.from({ length: 16 }, (_, index) => index * 22.5),
}
const office = { schemaVersion: 1, id: 'xiaoxin-office', baseSha256: baseAtlas.sha256, atlas: officeAtlas,
  scenes: OFFICE_SCENES.map(([id], row) => ({ id, row, frames: 8, durationsMs: [140, 140, 140, 140, 140, 140, 140, 260] })),
}
await writeFile(resolve(root, 'xiaoxin-v2.json'), JSON.stringify(base, null, 2) + '\n')
await writeFile(resolve(root, 'xiaoxin-office.json'), JSON.stringify(office, null, 2) + '\n')
console.log(JSON.stringify({ manifests: 'written', acceptance: 'requires-validate-assets-and-pixel-and-semantic-QA' }))
