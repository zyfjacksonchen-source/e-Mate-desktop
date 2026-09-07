import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { createCalcRuntime, validateCalcWorkbook, CALC_PROFILE } from '../src/calc-runtime.ts'

async function workbook(extra = {}) {
 const zip = new JSZip()
 zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>')
 zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>')
 for (const [name, data] of Object.entries(extra)) zip.file(name, data)
 return zip.generateAsync({ type: 'nodebuffer' })
}
const signal = () => new AbortController().signal

test('accepts ordinary inline formulas; rejects macros, external relationships, active formulas and entities', async () => {
 await validateCalcWorkbook(await workbook({'xl/worksheets/sheet1.xml':'<worksheet><f>SUM(A1:A3)</f></worksheet>'}), signal())
 for (const extra of [
  {'xl/vbaProject.bin':'macro'}, {'xl/embeddings/ole.bin':'ole'}, {'xl/connections.xml':'<connections/>'},
  {'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Target="https://example.com/a.xlsx" TargetMode="External"/></Relationships>'},
  {'xl/worksheets/sheet1.xml':'<worksheet><f>_xlfn.WEBSERVICE("http://example.com")</f></worksheet>'},
  {'xl/workbook.xml':'<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><workbook/>'},
 ]) await assert.rejects(validateCalcWorkbook(await workbook(extra), signal()), /Calc/)
})

test('rejects malformed, oversized and path-traversal archives', async () => {
 await assert.rejects(validateCalcWorkbook(Buffer.from('no zip'), signal()))
 await assert.rejects(validateCalcWorkbook(await workbook({'../bad.xml':'<x/>'}), signal()), /unsafe/)
 await assert.rejects(validateCalcWorkbook(await workbook({'xl/large.xml':' '.repeat(16*1024*1024+1)}), signal()), /size/)
})

async function fixture(t, behavior='success') {
 const root = await mkdtemp(join(tmpdir(), 'calc-test-')); t.after(()=>rm(root,{recursive:true,force:true}))
 const executable=join(root,'soffice'), fontDirectory=join(root,'fonts')
 await writeFile(executable,'fixture'); await mkdir(fontDirectory)
 const original=await workbook(), requests=[], events=[]
 const controller=new AbortController()
 const services={fs:{resolve:async path=>path, readBytes:async()=>original},
 sandbox:{confine(argv,policy){events.push('confine'); return {argv:[...argv],enforcement:'full'}}},
 subprocess:{spawn(spec){requests.push(spec); let finish
  const done=new Promise((resolve,reject)=>{finish=resolve
   if(behavior==='cancel'){spec.signal.addEventListener('abort',()=>resolve({exitCode:null}),{once:true}); controller.abort(new Error('user cancelled'));return}
   const destination=spec.argv[spec.argv.indexOf('--outdir')+1]
   Promise.resolve().then(async()=>{assert.equal(await readFile(join(spec.cwd,'profile/user/registrymodifications.xcu'),'utf8'),CALC_PROFILE)
    if(behavior==='success')await writeFile(join(destination,'input.xlsx'),original)
    resolve({exitCode:behavior==='error'?1:0})
   }).catch(reject)
  })
  return {done,terminate(){events.push('terminate');finish({exitCode:null})},async waitForExit(){events.push('exit');return true},collected:{}}
 }}}
 return {runtime:createCalcRuntime(services,{executable,fontDirectory}),request:{sourcePath:'source.xlsx',workspaceRoot:root,output:'xlsx',signal:controller.signal},requests,events,original,services}
}

test('uses native snapshot/confinement, returns a new real XLSX and cleans only after tree exit',async t=>{
 const f=await fixture(t); const result=await f.runtime.convert(f.request)
 assert.deepEqual(result.bytes,f.original); assert.equal(result.format,'xlsx')
 assert.deepEqual(f.events,['confine','terminate','exit'])
 const spec=f.requests[0]; assert.equal(spec.stdio.stdin,'ignore'); assert.equal(spec.graceMs,3000)
 assert.match(spec.env.FONTCONFIG_FILE,/emate-calc-/)
 await assert.rejects(lstat(spec.cwd),{code:'ENOENT'})
})
for(const behavior of ['cancel','error','missing'])test(`${behavior} does not return an artifact and waits before cleanup`,async t=>{
 const f=await fixture(t,behavior); await assert.rejects(f.runtime.convert(f.request))
 assert.deepEqual(f.events,['confine','terminate','exit'])
 await assert.rejects(lstat(f.requests[0].cwd),{code:'ENOENT'})
})
test('pre-abort does not spawn',async t=>{const f=await fixture(t); await assert.rejects(f.runtime.convert({...f.request,signal:AbortSignal.abort()}));assert.equal(f.requests.length,0)})


test('rejects active workbooks before any Calc spawn',async t=>{
 const f=await fixture(t)
 f.services.fs.readBytes=async()=>workbook({'xl/worksheets/sheet1.xml':'<worksheet><f>WEBSERVICE("https://example.invalid/")</f></worksheet>'})
 await assert.rejects(f.runtime.convert(f.request),/active or external formulas/)
 assert.equal(f.requests.length,0)
})

test('confinement denial never retries without the native sandbox',async t=>{
 const f=await fixture(t)
 f.services.sandbox.confine=()=>{throw new Error('sandbox unavailable')}
 await assert.rejects(f.runtime.convert(f.request),/sandbox unavailable/)
 assert.equal(f.requests.length,0)
})
