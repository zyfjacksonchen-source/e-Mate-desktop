import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { inflateSync } from 'node:zlib'
import JSZip from 'jszip'
import {
  apply,
  inject,
  OFFICE_ADAPTER_STATUS,
  readOfficeBuffer,
  writeOfficeBuffer,
} from '../lib/index.js'

test('registers five ready Skills and two target Tool/Job paths', async () => {
  let provider
  const capabilities = []
  const tools = []
  assert.deepEqual(inject, ['skills', 'tools', 'jobs', 'sandboxPolicy', 'emateCapabilities'])
  apply({
    skills: { registerProvider(create) { provider = create(); return () => {} } },
    tools: { register(definition) { tools.push(definition); return () => {} } },
    jobs: { attachController() { return () => {} } },
    sandboxPolicy: { resolve() { return { mode: 'read-only', workspaceRoot: process.cwd() } } },
    emateCapabilities: { register(definition) { capabilities.push(definition); return () => {} } },
    effect(register) { register() },
  })
  assert.equal(provider.name, 'emate-office-skills')
  const skills = await provider.list({})
  assert.deepEqual(skills.map(skill => skill.name), ['documents', 'pdf', 'spreadsheets', 'presentations', 'meeting-summary'])
  for (const skill of skills) {
    assert.equal(skill.rank, 600)
    assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
    assert.equal(skill.metadata.state, skill.name === 'documents' ? 'needs-runtime' : 'ready')
    const loaded = await provider.get(skill, {})
    assert.ok(loaded.content.length > 300)
    assert.doesNotMatch(loaded.content, /^---/u)
    assert.doesNotMatch(loaded.content, /EMATE_OFFICE_EXECUTION_LAYER_UNAVAILABLE/u)
    if (skill.name === 'documents') {
      assert.equal(skill.metadata.adapter, 'upstream')
      assert.ok(loaded.content.includes(loaded.resourceBase.path))
      assert.match(loaded.content, /python-docx/u)
      assert.match(await readFile(join(loaded.resourceBase.path, 'LICENSE'), 'utf8'), /Nous Research/u)
    }
    if (skill.name === 'meeting-summary') {
      assert.match(skill.description, /^会议总结/u)
      assert.equal(skill.metadata.adapter, 'upstream')
      assert.equal(skill.metadata.format, undefined)
      assert.equal(loaded.resourceBase.kind, 'directory')
      assert.ok(loaded.content.includes(loaded.resourceBase.path))
      assert.doesNotMatch(loaded.content, /\{\{SKILL_DIR\}\}/u)
      assert.match(loaded.content, /原文是事实和引用的权威来源/u)
      assert.match(loaded.content, /清洗不是必需步骤/u)
      assert.match(loaded.content, /# Meeting Transcript Summary Skill/u)
      const upstream = await readFile(join(loaded.resourceBase.path, 'SKILL.md'))
      assert.equal(createHash('sha256').update(upstream).digest('hex'), '852f8724aafd16de632326fb7aa12437bf8129b919f80180de71e216902694ca')
      assert.match(await readFile(join(loaded.resourceBase.path, 'LICENSE'), 'utf8'), /Apache License/u)
      for (const resource of ['references/canvas_ui_guide.md', 'references/quality_checklist.md', 'references/transcript_formats.md', 'templates/meeting_dashboard_template.html']) {
        assert.ok((await readFile(join(loaded.resourceBase.path, resource))).length > 0)
      }
    }
  }
  assert.deepEqual(tools.map(tool => tool.name), ['office_write', 'office_read'])
  assert.equal(tools.every(tool => tool.timeoutMs === 120_000), true)
  assert.deepEqual(tools[0].presentCall({ format: 'docx', filename: '交付.docx' }), {
    card: 'generic',
    title: '生成 Office 文件',
    kind: 'edit',
    rawInput: '交付.docx',
    locations: [{ path: '.e-mate/office/交付.docx' }],
  })
  assert.equal(tools[0].parameters.properties.document.type, 'object')
  assert.equal(tools[1].output.schema.properties.document.type, 'object')
  assert.deepEqual(capabilities.map(capability => capability.id), ['office-skills'])
  assert.deepEqual(await capabilities[0].status(), {
    state: 'ready',
    detail: 'DOCX / XLSX / PPTX / PDF · local rc.7 Tools',
    action_ids: [],
  })
  assert.deepEqual(OFFICE_ADAPTER_STATUS, {
    state: 'ready',
    harnessVersion: '0.1.0-rc.7',
    runtimeInstalled: true,
    toolsRegistered: 2,
    reason: 'Pure JavaScript DOCX, XLSX, PPTX, and PDF execution is installed locally; unsupported lossless binary edits fail closed.',
  })
})

test('meeting transcript helper preserves Chinese speakers and standalone numeric facts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'emate-meeting-summary-'))
  t.after(async () => await rm(directory, { recursive: true, force: true }))
  const input = join(directory, '会议 转录.txt')
  const output = join(directory, '会议 整理.txt')
  const transcript = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\n张三：预算金额如下\n300\n李四：客户数量\n25\n王五：责任人未定，截止日期未提供。\n'
  await writeFile(input, transcript)
  const python = process.env.EMATE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  const result = spawnSync(python, [fileURLToPath(new URL('../skills/meeting-summary/scripts/clean_transcript.py', import.meta.url)),
    input, '--output', output], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  const cleaned = await readFile(output, 'utf8')
  assert.match(cleaned, /张三：预算金额如下 300 李四：客户数量 25 王五：责任人未定/u)
  assert.doesNotMatch(cleaned, /WEBVTT|00:00:01|(?:^|\s)1(?:\s|$)/u)
  assert.equal(await readFile(input, 'utf8'), transcript)
})

test('round-trips real DOCX, XLSX, PPTX, and Chinese PDF bytes', async () => {
  const fixtures = [
    ['docx', { title: 'e-Mate 文档', paragraphs: [{ text: '第一节', heading: 1 }, '正文内容'] }, value => {
      assert.deepEqual(value.paragraphs, ['e-Mate 文档', '第一节', '正文内容'])
    }],
    ['xlsx', { sheets: [{ name: '数据', rows: [['项目', '数量'], ['e-Mate', 207]] }] }, value => {
      assert.equal(value.sheets[0].name, '数据')
      assert.deepEqual(value.sheets[0].rows.slice(0, 2), [['项目', '数量'], ['e-Mate', 207]])
    }],
    ['pptx', { slides: [{ title: 'e-Mate 演示', bullets: ['第一点', '第二点'] }] }, value => {
      assert.equal(value.slides.length, 1)
      assert.match(value.slides[0].bullets.join(' '), /e-Mate 演示/u)
      assert.match(value.slides[0].bullets.join(' '), /第一点/u)
    }],
    ['pdf', { title: 'e-Mate PDF', pages: [{ lines: ['中文 PDF 内容', '第二行'] }] }, value => {
      assert.equal(value.pages.length, 1)
      assert.deepEqual(value.pages[0].lines, ['中文 PDF 内容', '第二行'])
    }],
  ]
  for (const [format, input, verify] of fixtures) {
    const buffer = await writeOfficeBuffer(format, input)
    assert.ok(Buffer.isBuffer(buffer) && buffer.byteLength > 500, format)
    verify(await readOfficeBuffer(format, buffer))
  }
})

test('renders PDF text visibly and preserves ASCII punctuation', async t => {
  const sandbox = await mkdtemp(join(tmpdir(), 'emate-office-pdf-'))
  t.after(async () => await rm(sandbox, { recursive: true, force: true }))
  const path = join(sandbox, 'render.pdf')
  const buffer = await writeOfficeBuffer('pdf', { pages: [{ lines: ['PDF_TOOL_OK', '中文正文'] }] })
  await writeFile(path, buffer)

  assert.deepEqual(await readOfficeBuffer('pdf', buffer), { pages: [{ lines: ['PDF_TOOL_OK', '中文正文'] }] })
  const streams = Array.from(buffer.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/gu), match => {
    try { return inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1') } catch { return match[1] }
  }).join('\n')
  assert.match(streams, /BT[\s\S]*Tj[\s\S]*ET/u, 'PDF semantic text stream is missing')
  assert.match(streams, /\bm\b[\s\S]*\bf\b/u, 'PDF visible glyph paths are missing')
  if (spawnSync('pdfinfo', ['-v'], { stdio: 'ignore' }).error || spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).error) return

  const info = execFileSync('pdfinfo', [path], { encoding: 'utf8' })
  assert.match(info, /^Pages:\s+1$/mu)
  assert.match(info, /^Page size:\s+595\.28 x 841\.89 pts \(A4\)$/mu)
  const ppmPath = join(sandbox, 'render')
  execFileSync('pdftoppm', ['-f', '1', '-l', '1', '-r', '144', '-singlefile', path, ppmPath])
  const ppm = await readFile(`${ppmPath}.ppm`)
  const header = /^P6\s+(?:#.*\s+)*\d+\s+\d+\s+255\s/u.exec(ppm.toString('latin1'))
  assert.notEqual(header, null, 'Poppler returned an invalid PPM image')
  const pixels = ppm.subarray(header[0].length)
  assert.ok(pixels.some(value => value < 245), 'Poppler rendered a blank page')
})

test('OOXML readers reject archive bombs before unbounded XML parsing', async () => {
  const oversizedXml = new JSZip()
  oversizedXml.file('word/document.xml', Buffer.alloc(9 * 1024 * 1024, 0x61))
  await assert.rejects(
    readOfficeBuffer('docx', await oversizedXml.generateAsync({ type: 'nodebuffer', compression: 'STORE' })),
    /XML exceeds the parsing limit/u,
  )

  const highRatio = new JSZip()
  highRatio.file('word/document.xml', 'x'.repeat(2 * 1024 * 1024))
  await assert.rejects(
    readOfficeBuffer('docx', await highRatio.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })),
    /compression-ratio limit/u,
  )

  const manyEntries = new JSZip()
  manyEntries.file('word/document.xml', '<document/>')
  for (let index = 0; index < 2_048; index += 1) manyEntries.file(`extra/${index}.xml`, '')
  await assert.rejects(
    readOfficeBuffer('docx', await manyEntries.generateAsync({ type: 'nodebuffer', compression: 'STORE' })),
    /too many entries/u,
  )
})

test('package pins a distributable JS-only closure and bundled OFL font', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dsh.officeSkills.adapterState, 'ready')
  assert.equal(manifest.dsh.officeSkills.toolsRegistered, 2)
  assert.equal(manifest.eMate.harnessVersion, '0.1.0-rc.7')
  assert.deepEqual(manifest.dependencies, {
    '@pdf-lib/fontkit': '1.1.1',
    '@xmldom/xmldom': '0.9.11',
    docx: '9.7.1',
    jszip: '3.10.1',
    'pdf-lib': '1.17.1',
    pdf2json: '4.0.3',
    pptxgenjs: '4.0.1',
  })
  assert.equal(manifest.devDependencies['@fontsource-variable/noto-sans-sc'], '5.3.0')
  const fontLicense = await readFile(new URL('../assets/noto-sans-sc/LICENSE', import.meta.url), 'utf8')
  assert.match(fontLicense, /SIL OPEN FONT LICENSE Version 1\.1/u)
  const pdfParser = await readFile(new URL('../assets/pdf2json/pdfparser.js', import.meta.url), 'utf8')
  assert.ok(pdfParser.length > 500_000)
  const pdfLicense = await readFile(new URL('../assets/pdf2json/LICENSE', import.meta.url), 'utf8')
  assert.match(pdfLicense, /Apache License/u)
  assert.doesNotMatch(pdfLicense, /\r/u)
  const bundle = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(bundle, /^import .* from ["'](?:@pdf-lib\/fontkit|@xmldom\/xmldom|docx|jszip|pdf-lib|pdf2json|pptxgenjs)["'];?$/mu)
  assert.doesNotMatch(bundle, /\bexceljs\b|\bbuffers@0\.1\.1\b/iu)
  assert.doesNotMatch(JSON.stringify(manifest), /libreoffice|microsoft office|python|chromium|rapidocr/i)
})

test('Tools stay inside the current workspace and never overwrite output', async t => {
  const sandbox = await mkdtemp(join(tmpdir(), 'emate-office-'))
  t.after(async () => await rm(sandbox, { recursive: true, force: true }))
  const root = join(sandbox, 'workspace')
  await mkdir(root)
  const tools = []
  let jobIndex = 0
  let sandboxMode = 'read-only'
  apply({
    skills: { registerProvider() { return () => {} } },
    tools: { register(definition) { tools.push(definition); return () => {} } },
    jobs: {
      attachController() { return () => {} },
      start(specification) { jobIndex += 1; specification.run(); return `office-job-${jobIndex}` },
      async wait() {},
    },
    sandboxPolicy: { resolve() { return { mode: sandboxMode, workspaceRoot: root } } },
    emateCapabilities: { register() { return () => {} } },
    effect(register) { register() },
  })
  const owner = { session: { header: { cwd: root } } }
  const execution = { agent: owner, signal: new AbortController().signal }
  const write = tools.find(tool => tool.name === 'office_write')
  const read = tools.find(tool => tool.name === 'office_read')
  const document = { title: '轻量 Office', paragraphs: ['第一版'] }
  await assert.rejects(
    write.execute({ format: 'docx', filename: '交付.docx', document }, execution),
    /read-only sandbox policy/u,
  )
  assert.equal(jobIndex, 0)
  sandboxMode = 'workspace-write'
  const cancelled = new AbortController()
  cancelled.abort(new Error('cancelled before start'))
  await assert.rejects(
    write.execute({ format: 'docx', filename: 'cancelled.docx', document }, { agent: owner, signal: cancelled.signal }),
    /cancelled before start/u,
  )
  await assert.rejects(readFile(join(root, '.e-mate', 'office', 'cancelled.docx')))
  const first = await write.execute({ format: 'docx', filename: '交付.docx', document }, execution)
  sandboxMode = 'danger-full-access'
  const second = await write.execute({ format: 'docx', filename: '交付.docx', document }, execution)
  assert.equal(first.relative_path, '.e-mate/office/交付.docx')
  assert.equal(second.relative_path, '.e-mate/office/交付-2.docx')
  const writeMeta = write.output.presentationMeta({ filename: '交付.docx' }, second)
  assert.deepEqual(writeMeta, {operation:'write',format:'docx',job_id:second.job_id,relative_path:second.relative_path,bytes:second.bytes})
  assert.notEqual(writeMeta.relative_path, write.presentCall({format:'docx',filename:'交付.docx'}).locations[0].path)
  assert.ok((await readFile(join(root, first.relative_path))).byteLength > 500)
  assert.match(JSON.stringify((await read.execute({ path: first.relative_path }, execution)).document), /轻量 Office/u)

  for (const [format, filename, content, expected] of [
    ['xlsx', '数据.xlsx', { sheets: [{ name: '数据', rows: [['项目', '数量'], ['e-Mate', 16]] }] }, 'e-Mate'],
    ['pptx', '演示.pptx', { slides: [{ title: 'T16', bullets: ['真实产物'] }] }, '真实产物'],
    ['pdf', '报告.pdf', { title: 'T16 PDF', pages: [{ lines: ['真实 PDF 产物'] }] }, '真实 PDF 产物'],
  ]) {
    const artifact = await write.execute({ format, filename, document: content }, execution)
    assert.equal(artifact.relative_path, `.e-mate/office/${filename}`)
    assert.ok((await readFile(join(root, artifact.relative_path))).byteLength > 500)
    const reopened = await read.execute({ path: artifact.relative_path }, execution)
    assert.equal(reopened.format, format)
    assert.match(JSON.stringify(reopened.document), new RegExp(expected, 'u'))
    const guarded = {...reopened, get document(){throw new Error('presentation must not read Office body')}}
    assert.deepEqual(read.output.presentationMeta({},guarded), {operation:'read',format,job_id:reopened.job_id,relative_path:reopened.relative_path,bytes:reopened.bytes})
    assert.deepEqual(Object.keys(write.output.presentationMeta({},artifact)).sort(), ['bytes','format','job_id','operation','relative_path'])
  }

  const beforeMalformed = await readdir(join(root, '.e-mate', 'office'))
  await assert.rejects(
    write.execute({ format: 'xlsx', filename: 'bad.xlsx', document: { sheets: [] } }, execution),
    /XLSX sheets are invalid/u,
  )
  assert.deepEqual(await readdir(join(root, '.e-mate', 'office')), beforeMalformed)

  const outside = join(sandbox, 'outside.docx')
  await writeFile(outside, 'not an office file')
  await assert.rejects(read.execute({ path: '../outside.docx' }, execution), /escapes the workspace/u)
  await symlink(join(root, first.relative_path), join(root, 'linked.docx'))
  await assert.rejects(read.execute({ path: 'linked.docx' }, execution), /unavailable or too large/u)
})
