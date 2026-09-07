import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Context } from '../../../upstream/deepseek-harness/vendor/cordis/lib/index.js'
import Timer from '../../../upstream/deepseek-harness/vendor/timer/lib/index.js'
import { mountAgentLoopTestDependencies } from '../../../upstream/deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js'
import AgentLoop from '../../../upstream/deepseek-harness/packages/core/agent-loop/lib/index.js'
import { LlmAdapter, createUserMessage } from '../../../upstream/deepseek-harness/packages/llm/llm/lib/index.js'
import { registerKnowledgeAgentTools } from '../src/agent-tools.ts'
import { createKnowledgeWorkflow } from '../src/workflow.ts'
import { digest } from '../src/imports.ts'
import { knowledgeFailure } from '../src/contract.ts'
const source={source_id:'11111111-1111-4111-8111-111111111111',source_version:'a'.repeat(64),parse_revision:'b'.repeat(64)}
const compilation='22222222-2222-4222-8222-222222222222'
class Adapter extends LlmAdapter {
  script=[]
  async resolveModel(provider,model){return {provider,id:model,name:model}}
  async *stream(){const args=this.script.shift();if(!args){yield {type:'finish',reason:{kind:'stop'}};return}
    const id=randomUUID(),json=JSON.stringify(args)
    yield* [{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id,name:'enterprise_knowledge',argumentsDelta:json},{type:'block-end',index:0,block:{type:'tool-call',id,name:'enterprise_knowledge',arguments:json}},{type:'finish',reason:{kind:'tool-calls'}}]
  }
}
async function fixture(t){
  const ctx=new Context();await ctx.plugin(Timer);await mountAgentLoopTestDependencies(ctx);await ctx.plugin(AgentLoop,{agents:[]})
  let identity={tenantId:'enterprise',userId:'user-a'}
  ctx.reflect.provide('emateIdentity',{localAccountPrincipal:()=>identity,request:async()=>{throw Error('No network in adapter tests')}})
  const authority=createKnowledgeWorkflow(ctx),adapter=new Adapter();ctx.llm.registerAdapter(['mock'],adapter)
  const agent=ctx.agentLoop.create(randomUUID(),{provider:'mock',model:'model'}),calls=[],batches=new Map()
  const owner=()=>digest([identity.tenantId,identity.userId])
  let read=async(endpoint,request)=>({scope_key:owner(),result:{endpoint,request}})
  const freeze=(action,options)=>{const key=action+':'+options.operationId,hash=digest(options);if(batches.has(key)&&batches.get(key)!==hash)throw Object.assign(Error('private conflict'),{code:'idempotency-conflict'});batches.set(key,hash)}
  const workflow={...authority,
    async recordUserPublicIntent(exec,paths){calls.push(['intent',paths,exec]);return 'native-user-intent'},
    async importFiles(exec,options){calls.push(['import',options,exec]);freeze('import',options);return {imports:[],scope:options.scope}},
    async start(exec,options){calls.push(['compile',options,exec]);freeze('compile',options);return {compilation_id:compilation,state:'pending'}},
    async importsStatus(exec,id,scope){calls.push(['import-status',id,scope,exec]);return {imports:[]}},
    async operationStatus(exec,id,scope){calls.push(['operation-status',id,scope,exec]);return {compilation_id:compilation,state:'pending'}},
    async status(exec,id,scope){calls.push(['status',id,scope,exec]);return {compilation_id:id,state:'pending'}},
    async resume(exec,id,scope){calls.push(['resume',id,scope,exec]);return {compilation_id:id,state:'running'}},
    async stop(exec,id,scope){calls.push(['stop',id,scope,exec]);return {compilation_id:id,state:'paused'}},
  }
  const selection={provider:'mock',model:'native-effective',reasoningEffort:'medium'}
  ctx.reflect.provide('emateKnowledgeSelection',async exec=>{calls.push(['selection',exec]);return {...selection}})
  const unregister=registerKnowledgeAgentTools(ctx,{workflow,read:(...args)=>read(...args)})
  t.after(async()=>{unregister();await authority.dispose();await ctx.fiber.dispose()})
  return {ctx,agent,calls,workflow,selection,owner,setRead(fn){read=fn},change(){identity={...identity,userId:'user-b'};authority.changed()},
    async run(actions,text='请整理本次指定资料'){
      const before=agent.session.events.length;adapter.script.push(...actions)
      const message=createUserMessage({content:[{type:'text',text}],source:{kind:'user'}});agent.followup(message);await agent.whenIdle()
      const events=agent.session.events.slice(before)
      const results=events.filter(e=>e.type==='tool/result').flatMap(e=>e.data.message.content).filter(c=>c.type==='tool-result').map(c=>JSON.parse(c.content[0].text))
      return {message,events,results}
    },
  }
}
test('native ToolRuntime renders safe output and exposes no caller identity or model knobs',async t=>{
  const f=await fixture(t),schema=f.ctx.tools.schemas().find(x=>x.name==='enterprise_knowledge');assert(schema)
  for(const key of ['token','url','tenant_id','user_id','model','publicIntentId','lease_token'])assert.equal(schema.parameters.properties[key],undefined)
  const run=await f.run([{action:'read',endpoint:'revisions',request:{scope:'public',question:'方法'}}])
  assert.equal(run.results[0].status,'success');assert.deepEqual(run.results[0].value.result,{endpoint:'revisions',request:{scope:'public',question:'方法'}});assert.equal(run.results[0].value.scope_key,f.owner())
  const result=await f.ctx.tools.execute({callId:'without-agent',signal:new AbortController().signal,name:'enterprise_knowledge',arguments:{action:'read',endpoint:'catalog'}})
  assert.equal(result.value.error.code,'unauthorized')
})
test('one native user message keeps one import ID; different bodies conflict in the workflow',async t=>{
  const f=await fixture(t),first={action:'import',paths:['/files/a.pdf','/files/b.pdf']}
  const run=await f.run([first,first,{...first,paths:['/files/c.pdf']}]),imports=f.calls.filter(c=>c[0]==='import')
  assert.equal(imports.length,3)
  const expected=digest(['enterprise_knowledge',f.owner(),f.agent.session.header.id,run.message.id,'import'])
  assert(imports.every(c=>c[1].operationId===expected));assert.equal(run.results[0].value.result.operation_id,expected);assert.deepEqual(imports[0][1].paths,first.paths);assert.deepEqual(imports[0][1].scope,{kind:'uploader-private'})
  assert.deepEqual(run.results.map(r=>r.status),['success','success','failure']);assert.equal(run.results[2].error.code,'idempotency-conflict')
  await f.run([first]);assert.notEqual(f.calls.filter(c=>c[0]==='import').at(-1)[1].operationId,expected)
})
test('named batches share one native message without losing retry conflicts',async t=>{
  const f=await fixture(t),first={action:'import',paths:['/files/a.pdf'],batch_key:'private-001'},second={...first,paths:['/files/b.pdf'],batch_key:'private-002'}
  const run=await f.run([first,second,first,{...first,paths:['/files/changed.pdf']},{...first,batch_key:''},{...first,batch_key:'x'.repeat(65)}])
  const imports=f.calls.filter(c=>c[0]==='import')
  assert.equal(imports.length,4)
  assert.notEqual(imports[0][1].operationId,imports[1][1].operationId)
  assert.equal(imports[0][1].operationId,imports[2][1].operationId)
  assert.equal(imports[0][1].operationId,imports[3][1].operationId)
  assert.deepEqual(run.results.map(r=>r.status),['success','success','success','failure','failure','failure'])
  assert.equal(run.results[3].error.code,'idempotency-conflict')
  assert.equal(run.results[4].error.code,'invalid-request')
  assert.equal(run.results[5].error.code,'invalid-request')
})
test('public imports obtain native intent first; project imports preserve explicit scope',async t=>{
  const f=await fixture(t)
  await f.run([{action:'import',paths:['/files/public.pdf'],scope:{kind:'public'}}],'请把 /files/public.pdf 导入公共知识库')
  assert.deepEqual(f.calls.map(c=>c[0]),['intent','import']);assert.equal(f.calls[1][1].publicIntentId,'native-user-intent');assert(f.calls[0][2].rootCallId)
  f.calls.length=0;await f.run([{action:'import',paths:['/files/project.pdf'],scope:{kind:'project',project_id:42}}])
  assert.deepEqual(f.calls.map(c=>c[0]),['import']);assert.deepEqual(f.calls[0][1].scope,{kind:'project',project_id:42})
})
test('compile takes the native effective model and stable operation; model parameters cannot override it',async t=>{
  const f=await fixture(t),input={action:'compile',source_versions:[source],topics:[{key:'method'}],scope:{kind:'public'},benchmark_query_ids:[]}
  const run=await f.run([input,input,{...input,topics:[{key:'changed'}]}]),calls=f.calls.filter(c=>c[0]==='compile')
  assert.equal(calls.length,3);assert(calls.every(c=>c[1].operationId===digest(['enterprise_knowledge',f.owner(),f.agent.session.header.id,run.message.id,'compile'])))
  assert.deepEqual(calls[0][1].model,{id:'native-effective',reasoning_effort:'medium'});assert.equal(run.results[2].error.code,'idempotency-conflict')
  const before=f.calls.length,bad=await f.run([{...input,model:{id:'model-supplied'}}])
  assert.equal(bad.results[0].error.code,'invalid-request');assert.equal(f.calls.length,before)
  const batchA={...input,batch_key:'topic-001'},batchB={...input,batch_key:'topic-002',topics:[{key:'second'}]}
  const named=await f.run([batchA,batchB,batchA,{...batchA,topics:[{key:'changed'}]}])
  const namedCalls=f.calls.filter(c=>c[0]==='compile').slice(-4)
  assert.notEqual(namedCalls[0][1].operationId,namedCalls[1][1].operationId)
  assert.equal(namedCalls[0][1].operationId,namedCalls[2][1].operationId)
  assert.deepEqual(named.results.map(r=>r.status),['success','success','success','failure'])
  assert.equal(named.results[3].error.code,'idempotency-conflict')
})
test('status actions keep caller IDs and scope on the existing workflow',async t=>{
  const f=await fixture(t),op='stable-operation-id',scope={kind:'project',project_id:42}
  const run=await f.run([{action:'import-status',operation_id:op,scope},{action:'status',operation_id:op,scope},{action:'status',compilation_id:compilation,scope},{action:'resume',compilation_id:compilation,scope},{action:'stop',compilation_id:compilation,scope}])
  assert(run.results.every(r=>r.status==='success'));assert.deepEqual(f.calls.map(c=>c[0]),['import-status','operation-status','status','resume','stop']);assert.deepEqual(f.calls.map(c=>c[2]),Array(5).fill(scope))
})
test('late account changes and mismatched read scopes cannot return the old result',async t=>{
  const f=await fixture(t),old=f.owner();f.setRead(async()=>{f.change();return {scope_key:old,result:{text:'private-old-response'}}})
  const first=await f.run([{action:'read',endpoint:'catalog'}]);assert.equal(first.results[0].error.code,'scope-changed');assert(!JSON.stringify(first.events).includes('private-old-response'))
  f.setRead(async()=>({scope_key:old,result:{text:'private-cache-response'}}))
  const second=await f.run([{action:'read',endpoint:'catalog'}]);assert.equal(second.results[0].error.code,'scope-changed');assert(!JSON.stringify(second.events).includes('private-cache-response'))
})
test('private Host protocol fields and raw errors never enter native Session results',async t=>{
  const f=await fixture(t);f.workflow.status=async()=>({compilation_id:compilation,lease_token:'private-host-lease'})
  const first=await f.run([{action:'status',compilation_id:compilation}]);assert.equal(first.results[0].error.code,'invalid-response');assert(!JSON.stringify(first.events).includes('private-host-lease'))
  f.setRead(async()=>{throw Object.assign(Error('Authorization: private-oauth-token'),{code:'unavailable'})})
  const second=await f.run([{action:'read',endpoint:'catalog'}]);assert.equal(second.results[0].error.code,'unavailable');assert(!JSON.stringify(second.events).includes('private-oauth-token'))
  const schema=f.ctx.tools.schemas().find(x=>x.name==='enterprise_knowledge')
  for(const key of ['token','url','tenant_id','user_id','lease_token'])assert.equal(schema.parameters.properties.request.properties[key],undefined)
})

test('native input validation rejects additional identity, URL and secret fields before either injected owner is called',async t=>{
  const f=await fixture(t);let reads=0
  f.setRead(async()=>{reads++;return {scope_key:f.owner(),result:{}}})
  const invalid=[
    {action:'read',endpoint:'catalog',token:'not-a-real-token'},
    {action:'read',endpoint:'catalog',request:{tenant_id:'other'}},
    {action:'read',endpoint:'catalog',request:{user_id:'other'}},
    {action:'read',endpoint:'original',request:{url:'https://unrelated.invalid/file'}},
    {action:'import',paths:['/files/a.pdf'],scope:{kind:'uploader-private',token:'not-a-real-token'}},
    {action:'compile',source_versions:[{...source,lease_token:'not-a-real-token'}],topics:[{key:'method'}]},
    {action:'import',paths:['/files/a.pdf'],operation_id:'model-chosen-operation'},
  ]
  const run=await f.run(invalid)
  assert.equal(run.results.length,invalid.length)
  assert(run.results.every(r=>r.status==='failure'&&r.error.code==='invalid-request'))
  assert.equal(reads,0);assert.deepEqual(f.calls,[])
})

test('account change during public intent validation prevents the import action itself',async t=>{
  const f=await fixture(t)
  f.workflow.recordUserPublicIntent=async()=>{f.change();return 'old-intent'}
  const run=await f.run([{action:'import',paths:['/files/public.pdf'],scope:{kind:'public'}}])
  assert.equal(run.results[0].error.code,'scope-changed')
  assert.deepEqual(f.calls,[])
})


test('Host-resolved max effort reaches the workflow unchanged without a duplicate model directory',async t=>{
  const f=await fixture(t);f.selection.model='gpt-5.6-luna';f.selection.reasoningEffort='max'
  const result=await f.run([{action:'compile',source_versions:[source],topics:[{key:'method'}]}])
  assert.equal(result.results[0].status,'success')
  assert.deepEqual(f.calls.find(c=>c[0]==='compile')[1].model,{id:'gpt-5.6-luna',reasoning_effort:'max'})
})

test('workflow failures preserve the current contract codes and fixed safe messages',async t=>{
  const f=await fixture(t)
  for(const code of ['public-intent-required','conflict','idempotency-conflict','source-changed']){
    f.workflow.status=async()=>{throw Object.assign(Error('private service detail must not escape'),{code})}
    const result=await f.run([{action:'status',compilation_id:compilation}])
    assert.equal(result.results[0].error.code,code)
    assert.deepEqual(result.results[0],knowledgeFailure({code}))
    assert(!JSON.stringify(result.events).includes('private service detail'))
  }
})


test('existing knowledge Tool passes frozen graph paths through without registering another Tool', async t => {
  const f = await fixture(t)
  const graph_path = { namespace_id: randomUUID(), relative_path: '资料/原文.md', layer: 'source', expected_binding: null }
  const graph_files = [{ path: '/files/原文.md', graph_path, source_ref: source }]
  const run = await f.run([{ action: 'import', paths: ['/files/原文.md'], graph_files }])
  assert.equal(run.results[0].status, 'success'); assert.deepEqual(f.calls.find(call => call[0] === 'import')[1].graph_files, graph_files)
  assert.equal(f.ctx.tools.schemas().filter(tool => tool.name === 'enterprise_knowledge').length, 1)
})
