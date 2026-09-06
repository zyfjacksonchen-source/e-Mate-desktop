import assert from 'node:assert/strict'
import test from 'node:test'
import { NativePetProjection, documentVisibility } from '../src/client/native-projection.ts'
import { deriveScene } from '../src/projection.ts'
import { store } from './support.mjs'
function fixture(id='a') {
  const goal=store(undefined);const todos=store(undefined);const images=store(undefined);const batches=store(undefined);const nodes=new Map();const keys=[]
  const turn={status:'open',start:{time:100},data:{get:()=>undefined}}
  const conversation=store({sessionId:id,openState:'open',composerPhase:'active',running:false,lastAgentError:null,runningCalls:[],pending:[],queue:[],chat:{timeline:{turnOrder:[1],turns:new Map([[1,turn]])},locations:{getTurn:()=>keys},nodes:{get:key=>nodes.get(key)}}})
  const faces={goal,todos,eMateImageReceipts:images,eMateImageBatches:batches}
  const face={...conversation,projections:{faceOf:key=>faces[key]}}
  return {goal,todos,images,batches,conversation,face,nodes,keys,turn}
}
function context() {
  const a=fixture();const b=fixture('b');const list=store({current:'a',phase:'ready',byId:{a:{running:false},b:{running:false}},jobsBySession:{}});const visible=store(true)
  const sources={list,binding:id=>({session:id==='a'?a.face:b.face})}
  const projection=new NativePetProjection(sources,visible)
  return {a,b,list,visible,projection}
}
test('subscribes actual native faces and unhooks old routes and disposal',()=>{
  const {a,b,list,projection}=context();assert.equal(a.conversation.listeners.size,1)
  a.goal.set({goal:{phase:'active'}});assert.equal(deriveScene(projection.getSnapshot()),'goal')
  list.set({...list.getSnapshot(),current:'b'});assert.equal(a.conversation.listeners.size,0);assert.equal(b.conversation.listeners.size,1);assert.equal(deriveScene(projection.getSnapshot()),'idle')
  a.goal.set({goal:{phase:'blocked'}});assert.equal(deriveScene(projection.getSnapshot()),'idle')
  projection.dispose();assert.equal(list.listeners.size,0);assert.equal(b.goal.listeners.size,0);assert.equal(b.conversation.listeners.size,0)
})
test('first-response pause uses native visibility metadata without reading any content',()=>{
  const {a,projection}=context();a.conversation.set({...a.conversation.getSnapshot(),running:true})
  assert.equal(projection.getSnapshot().firstResponsePending,true)
  const node={kind:'assistant-step',visibility:'visible',get data(){throw new Error('content accessed')}}
  a.nodes.set('assistant',node);a.keys.push('assistant');a.conversation.set({...a.conversation.getSnapshot()})
  assert.equal(projection.getSnapshot().firstResponsePending,false)
  let updates=0;projection.subscribe(()=>updates++)
  a.conversation.set({...a.conversation.getSnapshot()});assert.equal(updates,0)
  projection.dispose()
})
test('tool categories are presentation metadata only and unknown calls stay generic',()=>{
  const {a,projection}=context()
  const call={get name(){throw new Error('name inspected')},get argsRaw(){throw new Error('args inspected')},callView:{card:'terminal',get title(){throw new Error('title inspected')}}}
  a.conversation.set({...a.conversation.getSnapshot(),running:true,runningCalls:[call]})
  assert.equal(deriveScene(projection.getSnapshot()),'terminal')
  a.conversation.set({...a.conversation.getSnapshot(),runningCalls:[{...Object.getOwnPropertyDescriptors(call),callView:null}]})
  assert.equal(deriveScene(projection.getSnapshot()),'running')
  a.conversation.set({...a.conversation.getSnapshot(),runningCalls:[{callView:{card:'generic',kind:'read',get title(){throw new Error('title inspected')}}}]})
  assert.equal(deriveScene(projection.getSnapshot()),'running')
  a.conversation.set({...a.conversation.getSnapshot(),pending:[{kind:'approval',get payload(){throw new Error('payload inspected')}}]})
  assert.equal(deriveScene(projection.getSnapshot()),'waiting');projection.dispose()
})
test('queue, current job failures and delivered output use native status only',()=>{
  const {a,list,projection}=context();a.conversation.set({...a.conversation.getSnapshot(),queue:[{get content(){throw new Error('queue content read')}}]})
  assert.equal(deriveScene(projection.getSnapshot()),'queue')
  list.set({...list.getSnapshot(),jobsBySession:{a:[{status:'failed',startedAt:80,finishedAt:90}]}});assert.equal(deriveScene(projection.getSnapshot()),'queue')
  list.set({...list.getSnapshot(),jobsBySession:{a:[{status:'failed',startedAt:101}]}});assert.equal(deriveScene(projection.getSnapshot()),'queue')
  list.set({...list.getSnapshot(),jobsBySession:{a:[{status:'failed',startedAt:80,finishedAt:101}]}});assert.equal(deriveScene(projection.getSnapshot()),'error')
  list.set({...list.getSnapshot(),jobsBySession:{}});a.conversation.set({...a.conversation.getSnapshot(),queue:[]})
  a.turn.status='closed';a.turn.data={get:()=>({produced:[{get path(){throw new Error('path read')}}]})};a.turn.end={data:{reason:{kind:'aborted'}}};a.conversation.set({...a.conversation.getSnapshot()});assert.equal(deriveScene(projection.getSnapshot()),'idle')
  a.turn.end={data:{reason:{kind:'completed'}}};a.conversation.set({...a.conversation.getSnapshot()});assert.equal(deriveScene(projection.getSnapshot()),'idle');projection.dispose()
})
test('background/minimized visibility and route mismatch pause without polling',()=>{
  const {a,visible,projection,list}=context();visible.set(false);assert.equal(projection.getSnapshot().window.visible,false)
  a.conversation.set({...a.conversation.getSnapshot(),sessionId:'old'});assert.equal(projection.getSnapshot().firstResponsePending,true)
  list.set({...list.getSnapshot(),current:undefined});assert.equal(projection.getSnapshot().taskId,null);assert.equal(projection.getSnapshot().firstResponsePending,false);projection.dispose()
})

test('disabled and hidden pets detach detailed native subscriptions',()=>{
  const {a,projection,visible}=context();projection.setEnabled(false);assert.equal(a.conversation.listeners.size,0);projection.setEnabled(true);assert.equal(a.conversation.listeners.size,1);visible.set(false);assert.equal(a.conversation.listeners.size,0);visible.set(true);assert.equal(a.conversation.listeners.size,1);projection.dispose()
})

test('browser focus and visibility pause state and all listeners dispose',()=>{
  let focused=true;const view=new EventTarget();const doc=Object.assign(new EventTarget(),{visibilityState:'visible',hasFocus:()=>focused,defaultView:view});const visibility=documentVisibility(doc);let notifications=0;const stop=visibility.subscribe(()=>notifications++);assert.equal(visibility.getSnapshot(),true);focused=false;view.dispatchEvent(new Event('blur'));assert.equal(visibility.getSnapshot(),false);assert.equal(notifications,1);stop();view.dispatchEvent(new Event('focus'));assert.equal(notifications,1)
})


test('Cordis work facts refresh from native faces and disconnect with the current session',()=>{
  const a=fixture();const b=fixture('b');const list=store({current:'a',phase:'ready',byId:{a:{running:false},b:{running:false}},jobsBySession:{}});const visible=store(true)
  let facts={operation:'image-edit',delivered:false};let calls=0
  const projection=new NativePetProjection({list,binding:id=>({session:id==='a'?a.face:b.face})},visible,id=>{assert.equal(id,'a');calls++;return facts})
  a.goal.set({goal:{phase:'active'}});a.conversation.set({...a.conversation.getSnapshot(),running:true,runningCalls:[{callId:'image',turn:1,callView:null}]})
  assert.equal(deriveScene(projection.getSnapshot()),'image-edit')
  facts={delivered:true};a.goal.set(undefined);a.conversation.set({...a.conversation.getSnapshot(),running:false,runningCalls:[]});a.images.set([])
  assert.equal(deriveScene(projection.getSnapshot()),'delivery')
  facts={completedOperation:'document-read',delivered:false};a.conversation.set({...a.conversation.getSnapshot()})
  assert.equal(projection.getSnapshot().tool.status,'completed');assert.equal(deriveScene(projection.getSnapshot()),'document-read')
  facts={needsAttention:true,failed:false,delivered:false,hasUsableOutput:true};a.images.set([])
  list.set({...list.getSnapshot(),jobsBySession:{a:[{status:'failed',finishedAt:101}]}})
  assert.equal(deriveScene(projection.getSnapshot()),'waiting')
  facts={needsAttention:false,failed:true,delivered:false,hasUsableOutput:true};a.images.set([])
  assert.equal(deriveScene(projection.getSnapshot()),'error')
  const before=calls;visible.set(false);a.images.set([]);assert.equal(calls,before);assert.equal(a.images.listeners.size,0);assert.equal(a.batches.listeners.size,0)
  projection.dispose();assert.equal(list.listeners.size,0)
})
