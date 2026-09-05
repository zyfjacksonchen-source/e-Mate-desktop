import assert from 'node:assert/strict'
import test from 'node:test'
import { loadPet } from '../src/client/resource.ts'
import { PetResources } from '../src/client/resources.ts'
import { baseManifest, officeManifest } from './support.mjs'
function io({office=true,badBase=false,badExtension=false}={}) {
  const base=baseManifest();const extension=officeManifest(base);if(badBase)base.atlas.width=123;if(badExtension)extension.scenes.pop()
  const revoked=[];const calls=[];let images=0
  return {calls,revoked,fetch:async path=>{calls.push(path);if(path.endsWith('xiaoxin-v2.json'))return new TextEncoder().encode(JSON.stringify(base));if(path.endsWith('xiaoxin-office.json')){if(!office)throw new Error('missing');return new TextEncoder().encode(JSON.stringify(extension))};return new Uint8Array(8)},digest:async()=>base.atlas.sha256,image:async()=>({width:1536,height:++images===1?2288:6240,dispose(){}}),url:()=>`blob:test-${images}`,revoke:url=>revoked.push(url)}
}
test('missing or malformed office extension falls back only after valid base verification',async()=>{
  for(const settings of [{office:false},{badExtension:true}]){const transport=io(settings);const pet=await loadPet(transport,new AbortController().signal);assert.equal(pet.extensionStatus,'unavailable');assert.equal(pet.base.spriteVersionNumber,2);pet.dispose();pet.dispose();assert.equal(transport.revoked.length,1)}
  const invalid=io({badBase:true});await assert.rejects(loadPet(invalid,new AbortController().signal));assert.equal(invalid.calls.length,1)
})
test('wrong digest or geometry cannot produce a drawable asset',async()=>{
  for(const field of ['digest','image']){const transport=io();transport[field]=field==='digest'?async()=>'bad':async()=>({width:1,height:1,dispose(){}});await assert.rejects(loadPet(transport,new AbortController().signal));assert.equal(transport.revoked.length,0)}
})
test('resource owner has zero startup fetch; pause/dispose reject late generations',async()=>{
  const transport=io();const owner=new PetResources(transport);assert.equal(transport.calls.length,0)
  let release;transport.fetch=()=>new Promise(resolve=>{release=resolve});owner.start();assert.equal(owner.getSnapshot().status,'loading');owner.pause();assert.equal(owner.getSnapshot().status,'idle')
  release(new TextEncoder().encode(JSON.stringify(baseManifest())));await new Promise(resolve=>setImmediate(resolve));assert.equal(owner.getSnapshot().status,'idle')
  owner.dispose();owner.start();assert.equal(owner.getSnapshot().status,'idle')
})
test('complete resource lifecycle revokes both URLs and supports explicit recovery',async()=>{
  const transport=io();const owner=new PetResources(transport);owner.start();while(owner.getSnapshot().status==='loading')await new Promise(resolve=>setImmediate(resolve));assert.equal(owner.getSnapshot().status,'ready');owner.retry();assert.equal(transport.revoked.length,2);assert.equal(owner.getSnapshot().status,'idle');owner.dispose()
})
