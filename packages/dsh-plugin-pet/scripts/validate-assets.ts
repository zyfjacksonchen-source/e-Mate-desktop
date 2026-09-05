/** Read-only release input validation. Missing art is an error, never a placeholder. */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { validateBase, validateOffice, type Atlas } from '../src/assets.ts'
const root = resolve(process.argv[2] ?? new URL('../assets/', import.meta.url).pathname)
function dimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('Invalid static WebP container')
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4); const length = bytes.readUInt32LE(offset + 4); const start = offset + 8
    if (start + length > bytes.length) throw new Error('Truncated WebP chunk')
    if (kind === 'VP8X' && length >= 10) { if ((bytes[start]! & 2) !== 0) throw new Error('Animated files cannot be atlases'); return { width: 1 + bytes.readUIntLE(start + 4, 3), height: 1 + bytes.readUIntLE(start + 7, 3) } }
    if (kind === 'VP8L' && length >= 5 && bytes[start] === 47) { const packed = bytes.readUInt32LE(start + 1); return { width: 1 + (packed & 0x3fff), height: 1 + ((packed >>> 14) & 0x3fff) } }
    if (kind === 'VP8 ' && length >= 10 && bytes.toString('hex', start + 3, start + 6) === '9d012a') return { width: bytes.readUInt16LE(start + 6) & 0x3fff, height: bytes.readUInt16LE(start + 8) & 0x3fff }
    offset = start + length + length % 2
  }
  throw new Error('Missing WebP raster header')
}
async function check(atlas: Atlas) {
  const bytes = await readFile(resolve(root, atlas.file))
  if (bytes.length !== atlas.bytes || createHash('sha256').update(bytes).digest('hex') !== atlas.sha256) throw new Error(`${atlas.file}: integrity mismatch`)
  const decoded = dimensions(bytes)
  if (decoded.width !== atlas.width || decoded.height !== atlas.height) throw new Error(`${atlas.file}: geometry mismatch`)
}
const base = validateBase(JSON.parse(await readFile(resolve(root, 'xiaoxin-v2.json'), 'utf8')))
const office = validateOffice(JSON.parse(await readFile(resolve(root, 'xiaoxin-office.json'), 'utf8')), base)
await check(base.atlas); await check(office.atlas)
console.log(JSON.stringify({ metadataAndBytes: 'valid', standardRows: 9, directions: 16, officeScenes: 30, visualAcceptance: 'requires-pixel-and-independent-semantic-QA' }))
