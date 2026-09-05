import { OFFICE_SCENES } from '../src/scenes.ts'
import { CODEX_PET_ANIMATION_FRAMES } from '../src/client/pet-animation.ts'
export function baseManifest() {
  return { schemaVersion: 1, id: 'xiaoxin', displayName: '小芯', spriteVersionNumber: 2,
    atlas: { file: 'xiaoxin-v2.webp', sha256: 'a'.repeat(64), bytes: 8, width: 1536, height: 2288, cellWidth: 192, cellHeight: 208, columns: 8, rows: 11 },
    animations: Object.entries(CODEX_PET_ANIMATION_FRAMES).sort((a,b) => a[1][0].rowIndex - b[1][0].rowIndex).map(([id,frames])=>({id,row:frames[0].rowIndex,frames:frames.length,durationsMs:frames.map(frame=>frame.frameDurationMs)})),
    directions: Array.from({length:16},(_,i)=>i*22.5),
  }
}
export function officeManifest(base=baseManifest()) {
  return { schemaVersion:1,id:'xiaoxin-office',baseSha256:base.atlas.sha256,atlas:{...base.atlas,file:'xiaoxin-office.webp',height:6240,rows:30},scenes:OFFICE_SCENES.map(([id],row)=>({id,row,frames:8,durationsMs:[140,140,140,140,140,140,140,260]})) }
}
export function store(initial) { let value=initial; const listeners=new Set();return {getSnapshot:()=>value,subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener)},set(next){value=next;for(const listener of [...listeners])listener()},listeners} }
