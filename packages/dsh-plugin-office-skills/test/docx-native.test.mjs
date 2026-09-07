import test from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import { Document, Packer, Paragraph, TextRun, ImageRun } from 'docx'
import { createDocxBuffer, replaceDocxBuffer, templateDocxBuffer } from '../src/docx-native.ts'
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64')
async function part(buffer, name = 'word/document.xml') { return (await JSZip.loadAsync(buffer)).file(name).async('string') }
function xml(text) { return new DOMParser().parseFromString(text, 'application/xml') }
function strings(text) { return Array.from(xml(text).getElementsByTagNameNS(W, 't')).map(n => n.textContent).join('') }
async function fixture() {
 return Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun({ text: '前{{na', bold: true }), new TextRun({text:'me}}后',italics:true}), new ImageRun({data:png,type:'png',transformation:{width:10,height:10}})] })] }] }))
}
test('native creation has Chinese design, A4, tables, bytes images, header/footer fields', async () => {
 const buffer = await createDocxBuffer({title:'中文报告',header:'部门周报',footer:'内部资料',blocks:[{type:'heading',text:'核心结果'},{type:'paragraph',runs:[{text:'增长',bold:true},{text:'20%'}]},{type:'table',headers:['指标','数值'],rows:[['营收','100']]},{type:'image',data:png,imageType:'png',width:100,height:100,caption:'示意图'}]})
 const document = await part(buffer)
 assert.match(document,/11906/); assert.match(document,/16838/)
 assert.match(document,/<w:tbl>/); assert.match(document,/<w:drawing>/)
 assert.match(await part(buffer,'word/styles.xml'),/w:eastAsia="Microsoft YaHei"/)
 assert.match(strings(document),/中文报告.*核心结果.*增长20%/)
 assert.match(strings(await part(buffer,'word/header1.xml')),/部门周报/)
 assert.match(await part(buffer,'word/footer1.xml'),/NUMPAGES/)
})
test('template patch uses original styles and preserves media and unrelated ZIP bytes', async () => {
 const source = await fixture()
 const output = await templateDocxBuffer(source,{name:'品牌'})
 assert.equal(strings(await part(output)),'前品牌后')
 const before = await JSZip.loadAsync(source), after = await JSZip.loadAsync(output)
 for (const name of Object.keys(before.files).filter(n=>!before.files[n].dir&&n!=='word/document.xml')) assert.deepEqual(await after.file(name).async('nodebuffer'),await before.file(name).async('nodebuffer'),name)
 assert.match(await part(output),/<w:b\/>/)
 assert.match(await part(output),/<w:drawing>/)
 await assert.rejects(templateDocxBuffer(source,{}),/Invalid Word replacements/)
 await assert.rejects(templateDocxBuffer(source,{other:'错误'}),/missing/)
})
test('text edits use original matches across runs and do not replay inserted content', async () => {
 const source = await fixture()
 const output = await replaceDocxBuffer(source,[{find:'{{name}}',replace:'报告报告'}])
 assert.equal(strings(await part(output)),'前报告报告后')
 const twice = await replaceDocxBuffer(output,[{find:'报告',replace:'年度报告'}])
 await assert.rejects(replaceDocxBuffer(output,[{find:'报告',replace:'年度报告'},{find:'年度报告',replace:'不应出现'}]),/not found/)
 assert.equal(strings(await part(twice)),'前年度报告年度报告后')
 assert.match(await part(twice),/<w:drawing>/)
 assert.equal(strings(await part(await replaceDocxBuffer(output,[{find:'报告',replace:'报告'}]))),'前报告报告后')
})
test('Chinese template keys fill and missing Chinese values fail', async () => {
 const source=await createDocxBuffer({title:'{{客户名称}}',blocks:[{type:'paragraph',text:'日期：{{日期}}'}]})
 const output=await templateDocxBuffer(source,{'客户名称':'示例公司','日期':'2026-09-07'})
 assert.equal(strings(await part(output)),'示例公司日期：2026-09-07')
 await assert.rejects(templateDocxBuffer(source,{'客户名称':'示例公司'}),/missing/)
})
test('same-run media remains and crossing media is rejected without changing source bytes', async () => {
 let source = await fixture()
 const zip = await JSZip.loadAsync(source)
 let text = await zip.file('word/document.xml').async('string')
 const drawing = text.match(/<w:drawing>[\s\S]*?<\/w:drawing>/)[0]
 text = text.replace(drawing,'').replace('<w:t xml:space="preserve">前{{na</w:t>',`<w:t xml:space="preserve">报告</w:t>${drawing}<w:t>后</w:t>`)
 zip.file('word/document.xml',text); source = await zip.generateAsync({type:'nodebuffer'})
 const before = Buffer.from(source)
 const output = await replaceDocxBuffer(source,[{find:'报告',replace:'年度报告'}])
 assert.match(await part(output),/<w:drawing>/)
 await assert.rejects(replaceDocxBuffer(source,[{find:'报告后',replace:'错'}]),/protected/)
 assert.deepEqual(source,before)
})
test('unknown fields, invalid sizes, missing replacement and hostile XML fail', async () => {
 for (const value of [null,[],{blocks:[],extra:true},{blocks:[{type:'paragraph',text:'a',extra:1}]},{blocks:[{type:'image',data:png,imageType:'png',width:NaN,height:2}]}]) await assert.rejects(createDocxBuffer(value))
 const source = await fixture()
 await assert.rejects(replaceDocxBuffer(source,[{find:'a'}]))
 const zip=await JSZip.loadAsync(source);zip.file('word/document.xml','<!DOCTYPE x [<!ENTITY x "evil">]><x/>')
 await assert.rejects(replaceDocxBuffer(await zip.generateAsync({type:'nodebuffer'}),[{find:'a',replace:'b'}]),/declarations/)
})
test('field codes, result text, tabs and breaks remain; protected replacements fail', async () => {
 const zip=await JSZip.loadAsync(await fixture())
 let value=await zip.file('word/document.xml').async('string')
 value=value.replace('<w:t xml:space="preserve">前{{na</w:t>','<w:t>报告</w:t><w:tab/><w:t>附页</w:t><w:br/><w:fldChar w:fldCharType="begin"/><w:instrText> PAGE </w:instrText><w:fldChar w:fldCharType="separate"/><w:t>1</w:t><w:fldChar w:fldCharType="end"/>')
 zip.file('word/document.xml',value)
 const source=await zip.generateAsync({type:'nodebuffer'})
 const output=await replaceDocxBuffer(source,[{find:'报告',replace:'年度报告'}])
 const result=await part(output)
 assert.match(result,/<w:tab\/>/);assert.match(result,/<w:br\/>/)
 assert.match(result,/<w:instrText> PAGE <\/w:instrText>/)
 assert.equal((result.match(/<w:fldChar /g)||[]).length,3)
 await assert.rejects(replaceDocxBuffer(source,[{find:'1',replace:'2'}]),/protected/)
 await assert.rejects(replaceDocxBuffer(source,[{find:'报告\t附页',replace:'删除'}]),/protected/)
})
test('headers and footer content edit without regenerating template styles', async () => {
 const source=await createDocxBuffer({title:'{{title}}',header:'{{department}}',footer:'保留信息',blocks:[{type:'table',headers:['名称'],rows:[['{{title}}']]}]})
 const output=await templateDocxBuffer(source,{title:'季度复盘',department:'市场部'})
 assert.match(strings(await part(output)),/季度复盘.*季度复盘/)
 assert.match(strings(await part(output,'word/header1.xml')),/市场部/)
 assert.deepEqual(await part(source,'word/styles.xml'),await part(output,'word/styles.xml'))
 const edited=await replaceDocxBuffer(output,[{find:'保留信息',replace:'更新信息'}])
 assert.match(strings(await part(edited,'word/footer1.xml')),/更新信息/)
 assert.match(await part(edited,'word/footer1.xml'),/NUMPAGES/)
})
test('existing ZIP limits reject highly compressed giant parts before patching', async () => {
 const zip=await JSZip.loadAsync(await fixture())
 zip.file('word/oversized.xml','<w>'+ 'A'.repeat(2*1024*1024)+'</w>')
 const source=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'})
 await assert.rejects(replaceDocxBuffer(source,[{find:'a',replace:'b'}]),/compression-ratio/)
})
test('field result spanning paragraphs is protected from replacement', async () => {
 const zip=await JSZip.loadAsync(await fixture())
 const value=await zip.file('word/document.xml').async('string')
 zip.file('word/document.xml',value.replace(/<w:p>[\s\S]*?<\/w:p>/,'<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText> TOC </w:instrText><w:fldChar w:fldCharType="separate"/></w:r></w:p><w:p><w:r><w:t>自动目录</w:t></w:r></w:p><w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'))
 const source=await zip.generateAsync({type:'nodebuffer'})
 await assert.rejects(replaceDocxBuffer(source,[{find:'自动目录',replace:'不允许改'}]),/protected/)
})
