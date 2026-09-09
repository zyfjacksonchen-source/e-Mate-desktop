import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { inflateSync } from 'node:zlib'
import JSZip from 'jszip'
import { installProfilePackageResolver } from '../../../desktop/e-mate-desktop/src/module-resolution.ts'
const baseContract = JSON.parse(await readFile(new URL('../../../desktop/e-mate-desktop/base-contract.json', import.meta.url), 'utf8'))
const releaseBaseResolver = installProfilePackageResolver(
 new URL('../../../desktop/e-mate-desktop/lib/index.js', import.meta.url).href,
 [fileURLToPath(new URL('../', import.meta.url))], baseContract.runtime_imports,
)
const {
  apply,
  inject,
  OFFICE_ADAPTER_STATUS,
  OFFICE_CREATE_EXAMPLES,
  readOfficeBuffer,
  writeOfficeBuffer,
} = await import('../lib/index.js')
releaseBaseResolver()

test('registers six Skills with accurate runtime states and two target Tool/Job paths', async () => {
  let provider
  const capabilities = []
  const tools = []
  assert.deepEqual(inject, ['skills', 'tools', 'jobs', 'sandboxPolicy', 'emateCapabilities'])
  apply({
    inject() {},
    skills: { registerProvider(create) { provider = create(); return () => {} } },
    tools: { register(definition) { tools.push(definition); return () => {} } },
    jobs: { attachController() { return () => {} } },
    sandboxPolicy: { resolve() { return { mode: 'read-only', workspaceRoot: process.cwd() } } },
    emateCapabilities: { register(definition) { capabilities.push(definition); return () => {} } },
    effect(register) { register() },
  })
  assert.equal(provider.name, 'emate-office-skills')
  const skills = await provider.list({})
  assert.deepEqual(skills.map(skill => skill.name), ['documents', 'pdf', 'spreadsheets', 'ppt-master', 'meeting-summary', 'lieflat-charts'])
  for (const skill of skills) {
    assert.equal(skill.rank, 600)
    assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
    assert.equal(skill.metadata.state, ['pdf', 'spreadsheets', 'ppt-master'].includes(skill.name) ? 'needs-runtime' : 'ready')
    const loaded = await provider.get(skill, {})
    assert.ok(loaded.content.length > 300)
    assert.doesNotMatch(loaded.content, /^---/u)
    assert.doesNotMatch(loaded.content, /EMATE_OFFICE_EXECUTION_LAYER_UNAVAILABLE/u)
    if (skill.name === 'ppt-master') {
      assert.equal(skill.metadata.adapter, 'upstream')
      assert.ok(loaded.content.includes(loaded.resourceBase.path))
      assert.doesNotMatch(loaded.content, /\{\{SKILL_DIR\}\}/u)
      const original = await readFile(join(loaded.resourceBase.path, 'SKILL.md'))
      assert.equal(createHash('sha256').update(original).digest('hex'), 'e1c5a8c1af2c326bbe72de65b8a867c8099326bf2986ac76383d1fec0373f8fa')
    }
    if (skill.name === 'documents') {
      assert.equal(skill.metadata.adapter, 'docx-typescript')
      assert.ok(loaded.content.includes(loaded.resourceBase.path))
      assert.match(loaded.content, /office_write/u)
      assert.match(await readFile(join(loaded.resourceBase.path, 'LICENSE'), 'utf8'), /e-Mate contributors/u)
    }
    if (skill.name === 'spreadsheets') {
      assert.equal(skill.metadata.adapter, 'upstream')
      assert.ok(loaded.content.includes(loaded.resourceBase.path))
      assert.doesNotMatch(loaded.content, /\{\{SKILL_DIR\}\}/u)
      const original = await readFile(join(loaded.resourceBase.path, 'SKILL.md'))
      assert.equal(createHash('sha256').update(original).digest('hex'), 'd5d9e4b1863527e2577106e324815cc5c498bd9d8af304ad2f210c2ede985b39')
    }
    if (skill.name === 'pdf') {
      assert.equal(skill.metadata.adapter, 'upstream')
      assert.ok(loaded.content.includes(loaded.resourceBase.path))
      assert.doesNotMatch(loaded.content, /\{\{SKILL_DIR\}\}/u)
      assert.match(loaded.content, /DSH_EMATE_PYTHON/u)
      const original = await readFile(join(loaded.resourceBase.path, 'SKILL.md'))
      assert.equal(createHash('sha256').update(original).digest('hex'), 'afc4472ec4d625f703e9f414fe6814ce3cfa0ec51c7a07887fe587264c8b561e')
      const fontRoot = join(loaded.resourceBase.path, 'assets', 'noto-sans-sc')
      const fontSource = JSON.parse(await readFile(join(fontRoot, 'SOURCE.json'), 'utf8'))
      const font = await readFile(join(fontRoot, fontSource.file))
      assert.equal(font.length, fontSource.bytes)
      assert.equal(createHash('sha256').update(font).digest('hex'), fontSource.sha256)
      assert.match(await readFile(join(fontRoot, 'OFL.txt'), 'utf8'), /SIL OPEN FONT LICENSE/u)
    }
    if (skill.name === 'lieflat-charts') {
      assert.equal(skill.metadata.adapter, 'upstream')
      assert.ok(loaded.content.includes(loaded.resourceBase.path))
      assert.doesNotMatch(loaded.content, /\{\{SKILL_DIR\}\}/u)
      assert.match(loaded.content, /office_read/u)
      assert.match(loaded.content, /现有浏览器能力/u)
      const root = loaded.resourceBase.path
      const manifest = JSON.parse(await readFile(join(root, 'UPSTREAM.json'), 'utf8'))
      assert.equal(manifest.commit, 'eace082a317b696c5570c25826a53a7fa113e984')
      assert.equal(manifest.files.length, 125)
      assert.equal(manifest.distribution_basis.kind, 'user-confirmed-enterprise-authorization')
      assert.equal(manifest.distribution_basis.contract_document_in_repository, false)
      for (const file of manifest.files) {
        const bytes = await readFile(join(root, file.path))
        const expected = manifest.local_modifications?.find(item => item.path === file.path) ?? file
        assert.equal(bytes.length, expected.bytes, file.path)
        assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, file.path)
      }
      assert.equal(manifest.files.find(file => file.path === 'SKILL.md').sha256, '1d58a31343b0f38fed16a44a65fd2fac0588ca98ffc9e43b20263d886f3ee9ce')
      assert.deepEqual(manifest.local_modifications.map(file => file.path), ['SKILL.md'])
      assert.doesNotMatch(loaded.content, /本 skill 由|署名提示/u)
      assert.match(await readFile(join(root, 'LICENSE'), 'utf8'), /PolyForm Noncommercial License 1.0.0/u)
      const validation = spawnSync(process.execPath, [join(root, 'scripts/validate.mjs')], { encoding: 'utf8', timeout: 30_000 })
      assert.equal(validation.status, 0, validation.error?.message ?? validation.stderr + validation.stdout)
      const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
      assert.ok(pkg.files.includes('skills'))
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
  assert.equal(tools[0].presentCall({ format: 'png', filename: '预览.png' }).rawInput, '预览.png')
  assert.equal(tools.every(tool => tool.timeoutMs === 120_000), true)
  assert.deepEqual(tools[0].presentCall({ format: 'docx', filename: '交付.docx' }), {
    card: 'generic',
    title: '生成 Office 文件',
    kind: 'edit',
    rawInput: '交付.docx',
    locations: [{ path: '.e-mate/office/交付.docx' }],
  })
  assert.equal(tools[0].parameters.properties.document.type, 'object')
  const contract = tools[0].parameters.properties.document.description
  for (const [format, example] of Object.entries(OFFICE_CREATE_EXAMPLES)) {
    assert.ok(contract.includes(`${format}: ${JSON.stringify(example)}`))
  }
  assert.match(contract, /operation:"create"/u)
  assert.match(contract, /type:"table"/u)
  assert.match(contract, /literal text, NOT formulas/u)
  assert.match(contract, /optional notes:string\[\] for real speaker notes/u)
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

test('writes real speaker notes and reads them through slide relationships without page-number contamination', async () => {
  const input = { slides: [{ title: '办公验收', bullets: ['合计 40'], notes: ['17+23=40', '只在演讲者备注中显示'] }, { title: '无备注', bullets: [] }] }
  const buffer = await writeOfficeBuffer('pptx', input)
  const archive = await JSZip.loadAsync(buffer)
  const body = await archive.file('ppt/slides/slide1.xml').async('string')
  assert.doesNotMatch(body, /只在演讲者备注/u)
  const notes = await archive.file('ppt/notesSlides/notesSlide1.xml').async('string')
  assert.match(notes, /17\+23=40/u)
  const parsed = await readOfficeBuffer('pptx', buffer)
  assert.equal(parsed.slides[0].notes.join('\n'), input.slides[0].notes.join('\n'))
  assert.equal(parsed.slides[1].notes, undefined)
  const relations = archive.file('ppt/slides/_rels/slide1.xml.rels')
  archive.file('ppt/notesSlides/custom.xml', notes)
  archive.remove('ppt/notesSlides/notesSlide1.xml')
  archive.file(relations.name, (await relations.async('string')).replace('../notesSlides/notesSlide1.xml', '../notesSlides/custom.xml'))
  const renamed = await readOfficeBuffer('pptx', await archive.generateAsync({ type: 'nodebuffer' }))
  assert.deepEqual(renamed.slides[0].notes, parsed.slides[0].notes)
  archive.file(relations.name, (await archive.file(relations.name).async('string')).replace('../notesSlides/custom.xml', '../../../outside.xml'))
  await assert.rejects(readOfficeBuffer('pptx', await archive.generateAsync({ type: 'nodebuffer' })), /notes path is unsafe/u)
  await assert.rejects(writeOfficeBuffer('pptx', { slides: [{ bullets: [], notes: 'must be an array' }] }), /notes are invalid/u)
})

test('ships the pinned native pdf2json patch in both module formats and copied runtime', async () => {
  const config = await readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8')
  assert.match(config, /pdf2json@4\.0\.3: patches\/pdf2json@4\.0\.3\.patch/u)
  const patched = 'v.indexOf(x.tag)<0||(0!==x.length||x.tag==="glyf")&&(A[x.tag]=x)'
  for (const path of ['../node_modules/pdf2json/dist/pdfparser.js', '../node_modules/pdf2json/dist/pdfparser.cjs', '../assets/pdf2json/pdfparser.js']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8')
    assert.equal(source.split(patched).length - 1, 1, path)
  }
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.files.includes('patches') && manifest.files.includes('pnpm-workspace.yaml'))
})

test('preserves ToUnicode text when a subset font has an empty glyf table', async () => {
  // Installed feedback fixture: valid ToUnicode '=' with a present zero-length glyf table.
  const historical = await readFile(new URL('./fixtures/pdf-empty-glyf.pdf', import.meta.url))
  assert.deepEqual((await readOfficeBuffer('pdf', historical)).pages[0].lines, ['办公验收：17+23=40'])
  const lines = ['办公验收：17+23=40', 'A=B', '=']
  const bytes = await writeOfficeBuffer('pdf', { pages: [{ lines }] })
  assert.deepEqual((await readOfficeBuffer('pdf', bytes)).pages[0].lines, lines)
})

test('round-trips real DOCX, XLSX, PPTX, and Chinese PDF bytes', async () => {
  const fixtures = [
    ['docx', OFFICE_CREATE_EXAMPLES.docx, value => {
      assert.deepEqual(value.paragraphs, ['e-Mate 文档', '第一节', '正文内容'])
    }],
    ['xlsx', OFFICE_CREATE_EXAMPLES.xlsx, value => {
      assert.equal(value.sheets[0].name, '数据')
      assert.deepEqual(value.sheets[0].rows.slice(0, 2), [['项目', '数量'], ['e-Mate', 207]])
    }],
    ['pptx', OFFICE_CREATE_EXAMPLES.pptx, value => {
      assert.equal(value.slides.length, 1)
      assert.match(value.slides[0].bullets.join(' '), /e-Mate 演示/u)
      assert.match(value.slides[0].bullets.join(' '), /第一点/u)
      assert.deepEqual(value.slides[0].notes, OFFICE_CREATE_EXAMPLES.pptx.slides[0].notes)
    }],
    ['pdf', OFFICE_CREATE_EXAMPLES.pdf, value => {
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
  const previewCalls = []
  let clearNativeRenderer
  const previewPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKAAAAABJRU5ErkJggg==', 'base64')
  apply({
    inject(dependencies, callback) {
      if (dependencies.includes('connection') || dependencies.includes('sandbox')) return // Optional native preview services are absent in this CLI fixture.
      assert.deepEqual(dependencies, ['desktopRuntime'])
      callback({ desktopRuntime: { async renderSvgPage(request) {
        request.signal.throwIfAborted()
        previewCalls.push(request)
        return { png: previewPng, width: request.width, height: request.height }
      } }, effect(register) { clearNativeRenderer = register() } })
    },
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
  await writeFile(join(root, 'preview.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>')
  const previewArgs = { format: 'png', filename: '预览.png', document: { source_svg: 'preview.svg', width: 1, height: 1 } }
  const preview = await write.execute(previewArgs, execution)
  assert.equal(preview.format, 'png')
  assert.deepEqual(await readFile(join(root, preview.relative_path)), previewPng)
  assert.equal(previewCalls.length, 1)
  assert.match(previewCalls[0].svg, /<rect/u)
  await assert.rejects(write.execute({ ...previewArgs, document: { ...previewArgs.document, source_svg: '../outside.svg' } }, execution))
  assert.equal(previewCalls.length, 1)
  sandboxMode = 'read-only'
  await assert.rejects(write.execute(previewArgs, execution), /read-only sandbox policy/u)
  assert.equal(previewCalls.length, 1)
  sandboxMode = 'workspace-write'
  clearNativeRenderer()
  await assert.rejects(write.execute(previewArgs, execution), /Native Desktop SVG renderer is unavailable/u)
  assert.equal(previewCalls.length, 1)
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

  const styled = await write.execute({ format: 'docx', filename: '排版.docx', document: {
    operation: 'create', spec: { title: '商务报告', blocks: [
      { type: 'heading', text: '结论', level: 1 },
      { type: 'paragraph', text: '原始项目' },
      { type: 'table', headers: ['事项', '状态'], rows: [['交付', '完成']] },
    ] },
  } }, execution)
  const originalBytes = await readFile(join(root, styled.relative_path))
  const revised = await write.execute({ format: 'docx', filename: '排版.docx', document: {
    operation: 'replace', source_path: styled.relative_path,
    replacements: [{ find: '原始项目', replace: '修订项目' }],
  } }, execution)
  assert.notEqual(revised.relative_path, styled.relative_path)
  assert.deepEqual(await readFile(join(root, styled.relative_path)), originalBytes)
  assert.match(JSON.stringify((await read.execute({ path: revised.relative_path }, execution)).document), /修订项目/u)
  const filesBeforeFailure = await readdir(join(root, '.e-mate', 'office'))
  await writeFile(join(sandbox, 'outside.docx'), originalBytes)
  await writeFile(join(sandbox, 'outside.png'), 'outside image')
  await assert.rejects(write.execute({ format: 'docx', filename: '无效.docx', document: {
    operation: 'replace', source_path: '../outside.docx', replacements: [{ find: 'a', replace: 'b' }],
  } }, execution), /escapes the workspace/u)
  await assert.rejects(write.execute({ format: 'docx', filename: '无效.docx', document: {
    operation: 'create', spec: { blocks: [{ type: 'image', path: '../outside.png', width: 100, height: 100 }] },
  } }, execution), /escapes the workspace/u)
  assert.deepEqual(await readdir(join(root, '.e-mate', 'office')), filesBeforeFailure)

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

test('Calc writes use existing Jobs, native services and collision-safe publication', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'office-calc-tool-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const original = await writeOfficeBuffer('xlsx', { sheets: [{ name: '中文', rows: [['金额', 3]] }] })
  await writeFile(join(root, 'source.xlsx'), original)
  const executable = join(root, 'python')
  await writeFile(executable, 'fixture')
  const tools = [], calls = []
  let mode = 'workspace-write', fail = false, environment = {}, dispose
  apply({
    inject(dependencies, callback) {
      if (!dependencies.includes('sandbox')) return
      callback({
        shellEnv: { collect(execution) { assert.ok(execution.agent); return environment } },
        fs: { async resolve(path, options) { assert.equal(options.cwd, root); return join(root, path) }, async readBytes(path) { return await readFile(path) } },
        sandbox: { confine(argv, policy) { assert.equal(policy.mode, 'workspace-write'); assert.notEqual(policy.workspaceRoot, root); return { argv, enforcement: 'full' } } },
        subprocess: { spawn(spec) {
          calls.push(spec)
          const done = (async () => {
            if (fail) return { exitCode: 1 }
            const output = spec.argv.at(-1)
            assert.equal(spec.argv[1], '-I')
            await writeFile(output, original)
            return { exitCode: 0 }
          })()
          return { done, terminate() {}, async waitForExit() { return true }, collected: {} }
        } },
        effect(register) { dispose = register() },
      })
    },
    skills: { registerProvider() {} }, tools: { register(tool) { tools.push(tool) } },
    jobs: { attachController() {}, start(spec) { spec.run(); return 'calc-job' }, async wait() {} },
    sandboxPolicy: { resolve() { return { mode } } }, emateCapabilities: { register() {} }, effect(register) { register() },
  })
  assert.deepEqual(tools.map(tool => tool.name), ['office_write', 'office_read'])
  const writer = tools[0], execution = { agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal }
  const args = { format: 'xlsx', filename: '结果.xlsx', document: { operation: 'recalculate', source_path: 'source.xlsx' } }
  await assert.rejects(writer.execute(args, execution), /Python 公式运行时尚不可用/)
  environment = { DSH_EMATE_PYTHON: executable }
  for (const document of [{ operation: 'recalculate' }, { ...args.document, extra: true }, { ...args.document, source_path: '../escape.xlsx' }]) {
    await assert.rejects(writer.execute({ ...args, document }, execution))
  }
  await assert.rejects(writer.execute({ ...args, format: 'docx', filename: 'bad.docx' }, execution), /Calc recalculation output/)
  mode = 'read-only'; await assert.rejects(writer.execute(args, execution), /read-only/); mode = 'workspace-write'
  assert.equal(calls.length, 0)
  const first = await writer.execute(args, execution)
  const second = await writer.execute(args, execution)
  assert.equal(first.relative_path, '.e-mate/office/结果.xlsx'); assert.equal(second.relative_path, '.e-mate/office/结果-2.xlsx')
  assert.equal(first.job_id, 'calc-job')
  assert.deepEqual(await readFile(join(root, first.relative_path)), original)
  await assert.rejects(writer.execute({ ...args, format: 'pdf', filename: '结果.pdf' }, execution), /PDF pagination is not provided/)
  assert.equal(calls.length, 2)
  await writer.execute({ format: 'xlsx', filename: '普通.xlsx', document: { sheets: [{ name: '数据', rows: [[1]] }] } }, execution)
  assert.equal(calls.length, 2)
  fail = true; await assert.rejects(writer.execute({ ...args, filename: '失败.xlsx' }, execution), /Calc conversion failed/)
  await assert.rejects(readFile(join(root, '.e-mate/office/失败.xlsx')))
  const controller = new AbortController(); controller.abort(new Error('cancelled'))
  await assert.rejects(writer.execute({ ...args, filename: '取消.xlsx' }, { ...execution, signal: controller.signal }), /cancelled/)
  await assert.rejects(readFile(join(root, '.e-mate/office/取消.xlsx')))
  assert.deepEqual(await readFile(join(root, 'source.xlsx')), original)
  dispose(); await assert.rejects(writer.execute(args, execution), /Python 公式运行时尚不可用/)
})

test('PDF and spreadsheet Host commands run their original marker with managed Node outside PATH', { skip: process.platform === 'win32' }, async () => {
  const { installDesktopPnpmRuntime } = await import('../../../desktop/e-mate-desktop/src/desktop-runtime-environment.ts')
  const root = await mkdtemp(join(tmpdir(), 'office managed node '))
  const emptyPath = join(root, 'empty-path')
  await mkdir(emptyPath)
  const environment = { PATH: emptyPath }
  const runtime = installDesktopPnpmRuntime({
    stateDir: join(root, 'runtime'), platform: process.platform, environment,
    appExecutable: process.env.EMATE_TEST_NODE_EXECUTABLE ?? process.execPath,
    pnpmBinPath: join(root, 'unused-pnpm-entry.mjs'), electronVersion: '43.4.0',
  })
  try {
    const childEnv = { ...environment, DSH_EMATE_NODE: runtime.nodeShimPath }
    assert.equal(spawnSync('/bin/sh', ['-c', 'node --version'], { env: childEnv }).status, 127)
    let provider
    apply({ inject() {}, skills: { registerProvider(create) { provider = create(); return () => {} } },
      tools: { register() { return () => {} } }, jobs: { attachController() { return () => {} } },
      sandboxPolicy: { resolve() { return { mode: 'read-only', workspaceRoot: root } } },
      emateCapabilities: { register() { return () => {} } }, effect(register) { register() },
    })
    const skills = await provider.list({})
    for (const name of ['pdf', 'spreadsheets']) {
      const loaded = await provider.get(skills.find(skill => skill.name === name), {})
      const command = loaded.content.match(/"\$DSH_EMATE_NODE" "[^"\n]+\/mark_artifact_operation_started\.mjs" --operation-kind create --expected-output-count 1 --output-format (?:pdf|xlsx)/u)?.[0]
      assert.ok(command, `${name} must expose an executable Host command`)
      const success = spawnSync('/bin/sh', ['-c', command], { env: childEnv, cwd: root, encoding: 'utf8' })
      assert.equal(success.status, 0, success.stderr)
      assert.equal(success.stdout, '')
      const invalid = spawnSync('/bin/sh', ['-c', command.replace('--expected-output-count 1', '--expected-output-count 0')], { env: childEnv, cwd: root, encoding: 'utf8' })
      assert.equal(invalid.status, 2, invalid.stderr)
      assert.match(invalid.stderr, /usage:/u)
    }
  } finally { runtime.dispose(); await rm(root, { recursive: true, force: true }) }
})
