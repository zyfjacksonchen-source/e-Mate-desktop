import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { validateBase, validateOffice } from '../src/assets.ts'
import { deriveScene, nextScene, motionPaused } from '../src/projection.ts'
import { OFFICE_SCENES } from '../src/scenes.ts'
import { decodeSettings, pixelPosition, normalizedPosition } from '../src/settings.ts'
import { baseManifest, officeManifest } from './support.mjs'
const task = {taskId:'a',revision:1,firstResponsePending:false,window:{visible:true,minimized:false}}
test('all 30 fixed office scenes and standard v2 metadata are mandatory',()=>{
  const base=baseManifest();assert.equal(validateBase(base),base);assert.equal(validateOffice(officeManifest(base),base).scenes.length,30)
  assert.equal(new Set(OFFICE_SCENES.map(s=>s[0])).size,30)
  for(const mutate of [v=>v.spriteVersionNumber=1,v=>v.directions.reverse(),v=>v.animations.pop(),v=>v.atlas.file='https://evil/atlas.webp',v=>v.atlas.width=1535,v=>v.extra=true]){const bad=structuredClone(base);mutate(bad);assert.throws(()=>validateBase(bad))}
  for(const mutate of [v=>v.scenes.pop(),v=>v.scenes[1].id=v.scenes[0].id,v=>v.baseSha256='b'.repeat(64),v=>v.scenes[3].frames=1,v=>v.scenes[0].durationsMs[0]=0]){const bad=officeManifest(base);mutate(bad);assert.throws(()=>validateOffice(bad,base))}
})
test('native status precedence never promotes missing or unknown activity to success',()=>{
  const full={...task,tool:{status:'approval'},job:{status:'failed'},goal:{status:'active'},queue:{pending:4},deliverable:{status:'completed'}}
  assert.equal(deriveScene(full),'waiting');delete full.tool;assert.equal(deriveScene(full),'error');delete full.job;assert.equal(deriveScene(full),'goal');delete full.goal;assert.equal(deriveScene(full),'queue');delete full.queue;assert.equal(deriveScene(full),'delivery')
  assert.equal(deriveScene({...task,tool:{status:'running',operation:'untrusted-name'}}),'running')
  assert.equal(deriveScene({...task,goal:{status:'active'},tool:{status:'running',operation:'image-edit'}}),'image-edit')
  assert.equal(deriveScene({...task,goal:{status:'active'},job:{status:'running',operation:'terminal'}}),'terminal')
  assert.equal(deriveScene({...task,tool:{status:'completed'}}),'idle')
  assert.equal(deriveScene({...task,tool:{status:'completed',operation:'spreadsheet'}}),'spreadsheet')
  assert.equal(deriveScene({...task,taskId:null,goal:{status:'active'}}),'idle')
})
test('750ms hysteresis suppresses thrash and never leaks a different task state',()=>{
  const previous={taskId:'a',revision:1,scene:'goal',since:100}
  const pending=nextScene(previous,{...task,revision:2,tool:{status:'approval'}},200)
  assert.equal(pending.state,previous);assert.equal(pending.delay,650)
  assert.equal(nextScene(previous,{...task,revision:2,tool:{status:'approval'}},850).state.scene,'waiting')
  assert.equal(nextScene(previous,{...task,taskId:'b'},200).state.scene,'idle')
  assert.equal(nextScene(previous,{...task,revision:0},1000).state,previous)
})
test('all pause conditions and corrupt persisted positions are bounded',()=>{
  assert.equal(motionPaused(task,false,false),false)
  for(const changed of [{...task,firstResponsePending:true},{...task,window:{visible:false,minimized:false}},{...task,window:{visible:true,minimized:true}}])assert.equal(motionPaused(changed,false,false),true)
  assert.equal(motionPaused(task,true,false),true);assert.equal(motionPaused(task,false,true),true)
  for(const value of [null,{}, {position:null},{position:{x:NaN,y:2}}])assert.equal(decodeSettings(value).enabled,true)
  const viewport={width:1000,height:800};const normalized=normalizedPosition({x:10000,y:-5},viewport);assert.deepEqual(normalized,{x:1,y:0});assert.equal(pixelPosition(normalized,viewport).x,888)
})
test('fixed license provenance and component boundaries remain explicit',async()=>{
  const root=new URL('../',import.meta.url);const pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8'))
  assert.equal(pkg.eMate.upstreamCommit,'f501139cfb155fd46717a79bb1c158da064dce15');assert.equal(pkg.eMate.harnessVersion,'0.1.0-rc.7')
  const sources=await Promise.all(['src/client/native-projection.ts','src/client/index.ts','src/index.ts'].map(path=>readFile(new URL(path,root),'utf8')))
  for(const source of sources)assert.doesNotMatch(source,/new WebSocket|EventSource|localStorage|sessionStorage|createRoot|defineTool|registerTool/)
  assert.match(sources[0],/faceOf\('goal'\)/);assert.match(sources[0],/faceOf\('todos'\)/)
  assert.doesNotMatch(sources[0],/\.argsRaw|\.blocks|\.title|\.label|\.content|\.preview/)
})
