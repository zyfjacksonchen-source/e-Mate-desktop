import assert from 'node:assert/strict'
import test from 'node:test'
import { NativePetProjection, documentVisibility } from '../src/client/native-projection.ts'
import { deriveScene } from '../src/projection.ts'
import { store } from './support.mjs'
// Session lifecycle and Turn facts come from the native owners: the Session
// snapshot, ui-session's pending map, and ui-conversation's chat target.
function fixture(id='a') {
  const goal=store(undefined);const todos=store(undefined);const images=store(undefined);const batches=store(undefined);const nodes=new Map();const keys=[]
  const turn={status:'open',start:{time:100},data:{get:()=>undefined}}
  const chat=store({timeline:{turnOrder:[1],turns:new Map([[1,turn]])},locations:{getTurn:()=>keys},nodes:{get:key=>nodes.get(key)},legacy:{runningCalls:[]}})
  const snapshot=store({sessionId:id,openState:'open',running:false,lastAgentError:null,queue:[],promptAttempted:false,awaitingFirstTurn:false})
  const faces={goal,todos,eMateImageReceipts:images,eMateImageBatches:batches}
  return {goal,todos,images,batches,chat,snapshot,nodes,keys,turn,target:{target:()=>chat},
    session:{getSnapshot:snapshot.getSnapshot,subscribe:snapshot.subscribe,projections:{faceOf:key=>faces[key]}}}
}
function services(a,b,list,pending) {
  return {sessions:{list,binding:id=>({session:(id==='a'?a:b).session})},
    uiSession:{pendingInteractions:pending},uiConversation:{binding:id=>(id==='a'?a:b).target}}
}
function context() {
  const a=fixture();const b=fixture('b');const list=store({current:'a',phase:'ready',byId:{a:{},b:{}},jobsBySession:{}})
  const visible=store(true);const pending=store(new Map())
  const projection=new NativePetProjection(services(a,b,list,pending),visible)
  return {a,b,list,visible,pending,projection}
}
test('subscribes actual native faces and unhooks old routes and disposal',()=>{
  const {a,b,list,projection}=context();assert.equal(a.snapshot.listeners.size,1);assert.equal(a.chat.listeners.size,1)
  a.goal.set({goal:{phase:'active'}});assert.equal(deriveScene(projection.getSnapshot()),'goal')
  list.set({...list.getSnapshot(),current:'b'});assert.equal(a.snapshot.listeners.size,0);assert.equal(a.chat.listeners.size,0)
  assert.equal(b.snapshot.listeners.size,1);assert.equal(b.chat.listeners.size,1);assert.equal(deriveScene(projection.getSnapshot()),'idle')
  a.goal.set({goal:{phase:'blocked'}});assert.equal(deriveScene(projection.getSnapshot()),'idle')
  projection.dispose();assert.equal(list.listeners.size,0);assert.equal(b.goal.listeners.size,0);assert.equal(b.snapshot.listeners.size,0);assert.equal(b.chat.listeners.size,0)
})
test('first-response pause uses native session and turn metadata without reading any content',()=>{
  const {a,projection}=context();a.snapshot.set({...a.snapshot.getSnapshot(),running:true})
  assert.equal(projection.getSnapshot().firstResponsePending,true)
  const node={kind:'assistant-step',visibility:'visible',get data(){throw new Error('content accessed')}}
  a.nodes.set('assistant',node);a.keys.push('assistant');a.chat.set({...a.chat.getSnapshot()})
  assert.equal(projection.getSnapshot().firstResponsePending,false)
  let updates=0;projection.subscribe(()=>updates++)
  a.chat.set({...a.chat.getSnapshot()});assert.equal(updates,0)
  a.snapshot.set({...a.snapshot.getSnapshot(),running:false,promptAttempted:true,awaitingFirstTurn:true})
  assert.equal(projection.getSnapshot().firstResponsePending,true)
  projection.dispose()
})
test('tool state reads the chat target and the native pending-interaction owner',()=>{
  const {a,projection,pending}=context()
  const call={get name(){throw new Error('name inspected')},callId:'run',turn:1}
  a.chat.set({...a.chat.getSnapshot(),legacy:{runningCalls:[call]}})
  a.snapshot.set({...a.snapshot.getSnapshot(),running:true})
  assert.equal(deriveScene(projection.getSnapshot()),'running')
  assert.equal(projection.getSnapshot().tool.status,'running')
  pending.set(new Map([['a',{key:'request',kind:'approval',sessionId:'a',get payload(){throw new Error('payload inspected')}}]]))
  assert.equal(deriveScene(projection.getSnapshot()),'waiting')
  pending.set(new Map([['b',{key:'request',kind:'approval',sessionId:'b'}]]))
  a.snapshot.set({...a.snapshot.getSnapshot(),lastAgentError:'provider down'})
  assert.equal(deriveScene(projection.getSnapshot()),'error')
  a.snapshot.set({...a.snapshot.getSnapshot(),lastAgentError:null})
  const failed={kind:'tool-call',visibility:'visible',data:{root:{kind:'tool-result',isError:true}}}
  a.nodes.set('failed',failed);a.keys.push('failed')
  a.chat.set({...a.chat.getSnapshot(),legacy:{runningCalls:[]}})
  a.snapshot.set({...a.snapshot.getSnapshot(),running:false})
  assert.equal(deriveScene(projection.getSnapshot()),'error')
  projection.dispose()
})
test('queue, current job failures and delivered output use native status only',()=>{
  const {a,list,projection}=context();a.snapshot.set({...a.snapshot.getSnapshot(),queue:[{get content(){throw new Error('queue content read')}}]})
  assert.equal(deriveScene(projection.getSnapshot()),'queue')
  list.set({...list.getSnapshot(),jobsBySession:{a:[{status:'failed',startedAt:80,finishedAt:90}]}});assert.equal(deriveScene(projection.getSnapshot()),'queue')
  list.set({...list.getSnapshot(),jobsBySession:{a:[{status:'failed',startedAt:101}]}});assert.equal(deriveScene(projection.getSnapshot()),'queue')
  list.set({...list.getSnapshot(),jobsBySession:{a:[{status:'failed',startedAt:80,finishedAt:101}]}});assert.equal(deriveScene(projection.getSnapshot()),'error')
  list.set({...list.getSnapshot(),jobsBySession:{}});a.snapshot.set({...a.snapshot.getSnapshot(),queue:[]})
  a.turn.status='closed';a.turn.data={get:()=>({produced:[{get path(){throw new Error('path read')}}]})};a.turn.end={data:{reason:{kind:'aborted'}}};a.chat.set({...a.chat.getSnapshot()});assert.equal(deriveScene(projection.getSnapshot()),'idle')
  a.turn.end={data:{reason:{kind:'completed'}}};a.chat.set({...a.chat.getSnapshot()});assert.equal(deriveScene(projection.getSnapshot()),'idle');projection.dispose()
})
test('background/minimized visibility and route mismatch pause without polling',()=>{
  const {a,visible,projection,list}=context();visible.set(false);assert.equal(projection.getSnapshot().window.visible,false)
  a.snapshot.set({...a.snapshot.getSnapshot(),sessionId:'old'});assert.equal(projection.getSnapshot().firstResponsePending,true)
  list.set({...list.getSnapshot(),current:undefined});assert.equal(projection.getSnapshot().taskId,null);assert.equal(projection.getSnapshot().firstResponsePending,false);projection.dispose()
})

test('disabled and hidden pets detach detailed native subscriptions',()=>{
  const {a,projection,visible}=context();projection.setEnabled(false);assert.equal(a.snapshot.listeners.size,0);projection.setEnabled(true);assert.equal(a.snapshot.listeners.size,1);visible.set(false);assert.equal(a.snapshot.listeners.size,0);visible.set(true);assert.equal(a.snapshot.listeners.size,1);projection.dispose()
})

test('browser focus and visibility pause state and all listeners dispose',()=>{
  let focused=true;const view=new EventTarget();const doc=Object.assign(new EventTarget(),{visibilityState:'visible',hasFocus:()=>focused,defaultView:view});const visibility=documentVisibility(doc);let notifications=0;const stop=visibility.subscribe(()=>notifications++);assert.equal(visibility.getSnapshot(),true);focused=false;view.dispatchEvent(new Event('blur'));assert.equal(visibility.getSnapshot(),false);assert.equal(notifications,1);stop();view.dispatchEvent(new Event('focus'));assert.equal(notifications,1)
})


test('Cordis work facts refresh from native faces and disconnect with the current session',()=>{
  const a=fixture();const b=fixture('b');const list=store({current:'a',phase:'ready',byId:{a:{},b:{}},jobsBySession:{}});const visible=store(true);const pending=store(new Map())
  let facts={operation:'image-edit',delivered:false};let calls=0
  const projection=new NativePetProjection(services(a,b,list,pending),visible,id=>{assert.equal(id,'a');calls++;return facts})
  a.goal.set({goal:{phase:'active'}});a.snapshot.set({...a.snapshot.getSnapshot(),running:true});a.chat.set({...a.chat.getSnapshot(),legacy:{runningCalls:[{callId:'image',name:'edit_image',turn:1}]}})
  assert.equal(deriveScene(projection.getSnapshot()),'image-edit')
  facts={delivered:true};a.goal.set(undefined);a.snapshot.set({...a.snapshot.getSnapshot(),running:false});a.chat.set({...a.chat.getSnapshot(),legacy:{runningCalls:[]}});a.images.set([])
  assert.equal(deriveScene(projection.getSnapshot()),'delivery')
  facts={completedOperation:'document-read',delivered:false};a.chat.set({...a.chat.getSnapshot()})
  assert.equal(projection.getSnapshot().tool.status,'completed');assert.equal(deriveScene(projection.getSnapshot()),'document-read')
  facts={needsAttention:true,failed:false,delivered:false,hasUsableOutput:true};a.images.set([])
  list.set({...list.getSnapshot(),jobsBySession:{a:[{status:'failed',finishedAt:101}]}})
  assert.equal(deriveScene(projection.getSnapshot()),'waiting')
  facts={needsAttention:false,failed:true,delivered:false,hasUsableOutput:true};a.images.set([])
  assert.equal(deriveScene(projection.getSnapshot()),'error')
  const before=calls;visible.set(false);a.images.set([]);assert.equal(calls,before);assert.equal(a.images.listeners.size,0);assert.equal(a.batches.listeners.size,0);assert.equal(a.chat.listeners.size,0)
  projection.dispose();assert.equal(list.listeners.size,0);assert.equal(pending.listeners.size,0)
})
