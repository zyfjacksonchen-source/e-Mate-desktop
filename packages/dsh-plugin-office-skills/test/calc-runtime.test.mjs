import assert from 'node:assert/strict'
import { mkdtemp, writeFile, lstat, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
const { createCalcRuntime, validateCalcWorkbook, CALC_TIMEOUT_MS } = await import('../src/calc-runtime.ts')

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
 const executable=join(root,'python'), script=join(root,'recalculate.py')
 await writeFile(executable,'fixture'); await writeFile(script,'fixture')
 const original=await workbook(), requests=[], events=[]
 const controller=new AbortController()
 const services={fs:{resolve:async path=>path, readBytes:async()=>original},
 sandbox:{confine(argv,policy){events.push('confine'); return {argv:[...argv],enforcement:'full'}}},
 subprocess:{spawn(spec){requests.push(spec); let finish
  const done=new Promise((resolve,reject)=>{finish=resolve
   if(behavior==='cancel'){spec.signal.addEventListener('abort',()=>resolve({exitCode:null}),{once:true}); controller.abort(new Error('user cancelled'));return}
   const destination=spec.argv.at(-1)
   Promise.resolve().then(async()=>{assert.equal(spec.argv[1],'-I')
    if(['success','wait-false','wait-reject'].includes(behavior))await writeFile(destination,original)
    resolve({exitCode:behavior==='error'?1:0})
   }).catch(reject)
  })
  return {done,terminate(){events.push('terminate');finish({exitCode:null})},async waitForExit(){events.push('exit');if(behavior==='wait-reject')throw new Error('tree observation failed');return behavior!=='wait-false'},collected:{}}
 }}}
 return {runtime:createCalcRuntime(services,{executable,script}),request:{sourcePath:'source.xlsx',workspaceRoot:root,output:'xlsx',signal:controller.signal},requests,events,original,services}
}

test('uses native snapshot/confinement, returns a new real XLSX and cleans only after tree exit',async t=>{
 const f=await fixture(t); const result=await f.runtime.convert(f.request)
 assert.deepEqual(result.bytes,f.original); assert.equal(result.format,'xlsx')
 assert.deepEqual(f.events,['confine','terminate','exit'])
 const spec=f.requests[0]; assert.equal(spec.stdio.stdin,'ignore'); assert.equal(spec.graceMs,3000)
 assert.deepEqual(spec.env,{})
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


for(const behavior of ['wait-false','wait-reject'])test(`${behavior} retains the profile and fails instead of delivering an artifact`,async t=>{
 const f=await fixture(t,behavior)
 await assert.rejects(f.runtime.convert(f.request),/tree.*retained/)
 const directory=f.requests[0].cwd
 t.after(()=>rm(directory,{recursive:true,force:true}))
 assert.ok((await lstat(join(directory,'input.xlsx'))).isFile())
 assert.deepEqual(f.events,['confine','terminate','exit'])
})

test('preserves passive web hyperlinks but still rejects external images, workbooks and active formulas',async()=>{
 const type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
 const rel=(kind,url)=>`<Relationships><Relationship Type="${type}${kind}" TargetMode="External" Target="${url}"/></Relationships>`
 await validateCalcWorkbook(await workbook({'xl/worksheets/_rels/sheet1.xml.rels':rel('hyperlink','https://example.com/source'), 'xl/worksheets/sheet1.xml':'<worksheet><f>HYPERLINK("http://example.com/source","来源")</f></worksheet>'}),signal())
 for(const extra of [
  {'xl/worksheets/_rels/sheet1.xml.rels':rel('image','https://example.com/image.png')},
  {'xl/worksheets/_rels/sheet1.xml.rels':rel('externalLink','https://example.com/data.xlsx')},
  {'xl/worksheets/_rels/sheet1.xml.rels':rel('hyperlink','file:///tmp/source.xlsx')},
  {'xl/worksheets/sheet1.xml':'<worksheet><f>HYPERLINK(WEBSERVICE("https://example.com"),"来源")</f></worksheet>'},
 ])await assert.rejects(validateCalcWorkbook(await workbook(extra),signal()),/Calc/)
})

test('managed formulas computes caches, preserves OOXML and fails closed for unsupported calculations', async t => {
 const python = process.env.EMATE_TEST_PYTHON
 if (!python) return t.skip('Set EMATE_TEST_PYTHON to the fixed managed Python with formulas/openpyxl/lxml')
 const { spawnSync } = await import('node:child_process')
 const { fileURLToPath } = await import('node:url')
 const root = await mkdtemp(join(tmpdir(), 'formula-runtime-test-'))
 t.after(() => rm(root, { recursive: true, force: true }))
 const helper = fileURLToPath(new URL('../scripts/recalculate-workbook.py', import.meta.url))
 const result = spawnSync(python, ['-I', '-c', String.raw`
import sys, pathlib, zipfile, hashlib, subprocess, time, json
import openpyxl
from openpyxl.styles import Font, PatternFill
from lxml import etree as ET
root, helper = pathlib.Path(sys.argv[1]), sys.argv[2]
helper_timeout = float(sys.argv[3])

def run(src, dst):
 # Match the existing native per-operation deadline; retain separate cold-load timings.
 start=time.monotonic()
 result=subprocess.run([sys.executable, '-I', helper, str(src), str(dst)], capture_output=True, text=True, timeout=helper_timeout)
 print(json.dumps({'input':src.name,'seconds':round(time.monotonic()-start,3),'exit':result.returncode,'deadline':helper_timeout}),flush=True)
 return result

for amount in (17,18):
 source, target = root / ('source%d.xlsx'%amount), root / ('result%d.xlsx'%amount)
 w=openpyxl.Workbook(); s=w.active;s.title='数据';s['A1']=amount;s['A2']=23;s['B1']='=SUM(A1:A2)'
 s['B1'].font=Font(name='Noto Sans SC',bold=True);s['B1'].fill=PatternFill('solid',fgColor='FF8800')
 s.column_dimensions['B'].width=24
 q=w.create_sheet('汇总');q['A1']="='数据'!B1*2";q['B1']='=IF(A1>50,"通过","失败")';q['B2']='=IFERROR(1/0,7)';q['B3']='=ROUND(A1/3,2)'
 w.save(source)
 # Change part names to exercise workbook relationships, not guessed sheetN order.
 with zipfile.ZipFile(source) as z: parts={i.filename:(i,z.read(i.filename)) for i in z.infolist()}
 relname='xl/_rels/workbook.xml.rels'; info,body=parts[relname]
 parts[relname]=(info,body.replace(b'/xl/worksheets/sheet1.xml',b'/xl/worksheets/data.xml'))
 info,body=parts.pop('xl/worksheets/sheet1.xml');info.filename='xl/worksheets/data.xml';parts[info.filename]=(info,body)
 content='[Content_Types].xml';info,body=parts[content];parts[content]=(info,body.replace(b'/xl/worksheets/sheet1.xml',b'/xl/worksheets/data.xml'))
 with zipfile.ZipFile(source,'w') as z:
  for info,body in parts.values():z.writestr(info,body)
 before=hashlib.sha256(source.read_bytes()).hexdigest(); r=run(source,target);assert r.returncode==0,r.stderr
 raw=openpyxl.load_workbook(target,data_only=False);cached=openpyxl.load_workbook(target,data_only=True)
 assert raw['数据']['B1'].value=='=SUM(A1:A2)'
 assert raw['汇总']['A1'].value=="='数据'!B1*2"
 assert cached['数据']['B1'].value==amount+23;assert cached['汇总']['A1'].value==2*(amount+23)
 assert cached['汇总']['B1'].value=='通过';assert cached['汇总']['B2'].value==7
 assert raw['数据']['B1'].font.bold and raw['数据']['B1'].fill.fgColor.rgb=='00FF8800'
 assert raw['数据'].column_dimensions['B'].width==24
 with zipfile.ZipFile(source) as a,zipfile.ZipFile(target) as b:
  assert a.namelist()==b.namelist()
  for name in a.namelist():
   if not name.startswith('xl/worksheets/'):assert a.read(name)==b.read(name),name
 assert hashlib.sha256(source.read_bytes()).hexdigest()==before
 assert run(source,source).returncode!=0
 assert run(source,target).returncode!=0
for name,formula in [('unknown','=NOTKNOWN(1)'),('circular','=A1+1'),('external',"='[other.xlsx]Sheet1'!A1")]:
 source,target=root/(name+'.xlsx'),root/(name+'-result.xlsx')
 w=openpyxl.Workbook();w.active['A1']=formula;w.save(source)
 r=run(source,target);assert r.returncode!=0,(name,r.stderr);assert not target.exists(),name
 print(name+': '+r.stderr.strip())
for kind in ('array','quota'):
 source,target=root/(kind+'.xlsx'),root/(kind+'-result.xlsx')
 w=openpyxl.Workbook();w.active['A1']='=SUM(1,2)'
 if kind=='quota':w.active['Z100000']=1
 w.save(source)
 if kind=='array':
  with zipfile.ZipFile(source) as z:parts={i.filename:(i,z.read(i.filename)) for i in z.infolist()}
  info,body=parts['xl/worksheets/sheet1.xml'];parts[info.filename]=(info,body.replace(b'<f>',b'<f t="array" ref="A1:A2">'))
  with zipfile.ZipFile(source,'w') as z:
   for info,body in parts.values():z.writestr(info,body)
 r=run(source,target);assert r.returncode!=0,(kind,r.stderr);assert not target.exists()
print('SUM/cross-sheet/input-change/cache/style/relationship/source preservation PASS')
`, root, helper, String(CALC_TIMEOUT_MS / 1000)], { encoding: 'utf8', timeout: CALC_TIMEOUT_MS, env: { ...process.env, PATH: '' } })
 assert.equal(result.status, 0, result.error?.message ?? result.stderr)
 assert.match(result.stdout, /preservation PASS/)
 t.diagnostic(result.stdout.trim())
})


test('accepts the fixed owner interpreter symlink without consulting PATH', async t => {
 const f=await fixture(t)
 const link=join(f.request.workspaceRoot,'managed-python-link')
 await symlink(join(f.request.workspaceRoot,'python'),link)
 const runtime=createCalcRuntime(f.services,{executable:link,script:join(f.request.workspaceRoot,'recalculate.py')})
 const result=await runtime.convert(f.request)
 assert.equal(result.format,'xlsx')
 assert.equal(f.requests[0].argv[0],link)
})
