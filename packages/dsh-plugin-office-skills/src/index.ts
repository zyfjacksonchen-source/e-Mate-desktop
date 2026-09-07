/** Lightweight, local Office execution for the e-Mate rc.7 Harness profile. */

import { createCalcRuntime } from './calc-runtime.ts'
import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import {
  type OfficeFormat,
  readOfficeBuffer,
  writeOfficeBuffer,
} from './office-runtime.ts'
import { createOfficePreview, PREVIEW_CHANNEL } from './preview.ts'
import { createDocxBuffer, replaceDocxBuffer, templateDocxBuffer, type NativeDocxSpec } from './docx-native.ts'

interface SkillLookupOptions { signal?: AbortSignal }
interface SkillCandidate {
  name: string
  description: string
  whenToUse: string
  invocation: typeof INVOCATION
  source: 'bundled'
  provider: string
  resourceBase: { kind: 'directory'; path: string }
  rank: number
  locator: unknown
  path: string
  metadata: Readonly<Record<string, unknown>>
}
interface SkillDefinition extends Omit<SkillCandidate, 'rank' | 'locator'> { content: string }
interface SkillProvider {
  name: string
  list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]>
  get(skill: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined>
}

interface AgentOwner { session?: { header?: { cwd?: string } } }
interface ToolExecution { agent?: AgentOwner; signal: AbortSignal }
interface SvgRenderer {
  renderSvgPage(request: { svg: string; width: number; height: number; signal?: AbortSignal }): Promise<{ png: Uint8Array; width: number; height: number }>
}
interface OfficeContext {
  inject(dependencies: string[], callback: (context: any) => void): unknown
  skills: { registerProvider(create: () => SkillProvider): () => void }
  tools: { register(definition: unknown): () => void }
  jobs: {
    attachController(kind: string): () => void
    start(specification: unknown): string
    wait(id: string, timeoutMs: number, owner: AgentOwner, signal: AbortSignal): Promise<unknown>
  }
  sandboxPolicy: SandboxPolicyService
  emateCapabilities: { register(definition: unknown): () => void }
  effect(effect: () => () => void, label: string): void
}

interface PublishedFile {
  bytes: number
  format: OfficeFormat | 'png'
  name: string
  relative_path: string
}

export const name = 'emate-office-skills'
export const inject = ['skills', 'tools', 'jobs', 'sandboxPolicy', 'emateCapabilities']
export const OFFICE_ADAPTER_STATUS = Object.freeze({
  state: 'ready' as const,
  harnessVersion: '0.1.0-rc.7' as const,
  runtimeInstalled: true as const,
  toolsRegistered: 2 as const,
  reason: 'Pure JavaScript DOCX, XLSX, PPTX, and PDF execution is installed locally; unsupported lossless binary edits fail closed.',
})

const PROVIDER_NAME = name
const BUNDLED_SKILL_RANK = 600
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const MAX_FILE_BYTES = 32 * 1024 * 1024
const OFFICE_TIMEOUT_MS = 120_000
const formats = new Set<OfficeFormat>(['docx', 'xlsx', 'pptx', 'pdf'])

interface SkillSpec {
  name: string
  description: string
  whenToUse: string
  directory: string
  format?: OfficeFormat
  hostGuide?: string
  runtimePending?: boolean
  adapter?: string
}

const skillRoot = fileURLToPath(new URL('../skills/', import.meta.url))
const SPECS: readonly SkillSpec[] = [
  { name: 'documents', description: 'Word 文档：中文商务排版、模板填充和保留图片样式的文字修改。', whenToUse: '用于创建 Word 报告、填充 DOCX 模板和定向替换文字，使用内置 TypeScript 工具。', directory: `${skillRoot}documents`, format: 'docx', hostGuide: 'HOST.md', adapter: 'docx-typescript' },
  { name: 'pdf', description: 'PDF 文档：创建、提取、填写和检查版式，交付前渲染验证。', whenToUse: '用于 PDF 阅读、生成、表单填写及视觉检查；使用前验证 Python 和渲染依赖。', directory: `${skillRoot}pdf`, format: 'pdf', hostGuide: 'HOST.md', runtimePending: true },
  { name: 'spreadsheets', description: '电子表格：创建、编辑、分析和检查工作簿，保留公式与格式。', whenToUse: '用于 XLSX/CSV 数据、公式、图表和排版；按预置指南检查真实运行依赖。', directory: `${skillRoot}spreadsheets`, format: 'xlsx', hostGuide: 'HOST.md', runtimePending: true },
  { name: 'ppt-master', description: 'PPT Master：演示文稿设计、模板制作、图表编排和可编辑 PPTX 交付。', whenToUse: '用于创建、修改与审阅 PPT 演示文稿；按预置流程核验运行依赖、真实渲染和可编辑性。', directory: `${skillRoot}ppt-master`, format: 'pptx', hostGuide: 'HOST.md', runtimePending: true },
  { name: 'meeting-summary', description: '会议总结：从本地转录文本整理会议纪要、决策与行动项，保留事实来源。', whenToUse: '用于会议转录文本、VTT、SRT 的总结和行动项整理；不负责录音或音频转录。', directory: `${skillRoot}meeting-summary`, hostGuide: 'HOST.md' },
]

function candidate(spec: SkillSpec): SkillCandidate {
  return {
    name: spec.name,
    description: spec.description,
    whenToUse: spec.whenToUse,
    invocation: INVOCATION,
    source: 'bundled',
    provider: PROVIDER_NAME,
    resourceBase: { kind: 'directory', path: spec.directory },
    rank: BUNDLED_SKILL_RANK,
    locator: spec.name,
    path: `${spec.directory}/SKILL.md`,
    metadata: { eMateCapability: 'office', ...(spec.format === undefined ? {} : { format: spec.format }), adapter: spec.adapter ?? (spec.hostGuide === undefined ? 'clean-room' : 'upstream'), state: spec.runtimePending ? 'needs-runtime' : 'ready' },
  }
}

async function loadDefinition(spec: SkillSpec, options: SkillLookupOptions): Promise<SkillDefinition> {
  const path = `${spec.directory}/SKILL.md`
  const raw = await readFile(path, options.signal === undefined
    ? { encoding: 'utf8' }
    : { encoding: 'utf8', signal: options.signal })
  const lines = raw.replace(/^\uFEFF/u, '').split(/\r?\n/u)
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1
  if (end < 0) throw new Error(`${PROVIDER_NAME}: malformed skill frontmatter in ${path}`)
  const summary = candidate(spec)
  const hostGuide = spec.hostGuide === undefined ? '' : (await readFile(join(spec.directory, spec.hostGuide), {
    encoding: 'utf8', ...(options.signal === undefined ? {} : { signal: options.signal }),
  })).replaceAll('{{SKILL_DIR}}', spec.directory)
  return { ...summary, content: `${hostGuide}${lines.slice(end + 1).join('\n').trim()}` }
}

function inside(root: string, candidatePath: string): boolean {
  const rel = relative(root, candidatePath)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function format(value: unknown): OfficeFormat {
  if (typeof value !== 'string' || !formats.has(value as OfficeFormat)) throw new Error('Office format is invalid')
  return value as OfficeFormat
}

function filename(value: unknown, expected: OfficeFormat | 'png'): string {
  if (typeof value !== 'string' || value !== value.normalize('NFC') || value !== value.trim()
    || value === '' || value.startsWith('.') || Buffer.byteLength(value, 'utf8') > 160
    || /[<>:"/\\|?*\u0000-\u001f]/u.test(value) || /[. ]$/u.test(value)
    || extname(value).toLowerCase() !== `.${expected}`) {
    throw new Error(`Office filename must be a safe .${expected} name`)
  }
  return value
}

async function workspace(owner: AgentOwner | undefined): Promise<string> {
  const cwd = owner?.session?.header?.cwd
  if (cwd === undefined || !isAbsolute(cwd)) throw new Error('Office execution requires a current workspace')
  const root = await realpath(cwd)
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Current workspace is unavailable')
  return root
}

function assertWorkspaceWrite(ctx: OfficeContext, owner: AgentOwner | undefined): void {
  const session = owner?.session
  if (session === undefined) throw new Error('Office execution requires an owning Agent session')
  if (ctx.sandboxPolicy.resolve({ session: session as never }).mode === 'read-only') {
    throw new Error('Office write is blocked by the current read-only sandbox policy')
  }
}

async function officeDirectory(root: string): Promise<string> {
  let current = root
  for (const segment of ['.e-mate', 'office']) {
    const path = join(current, segment)
    await mkdir(path, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Office output directory is unsafe')
    current = await realpath(path)
    if (!inside(root, current)) throw new Error('Office output directory escapes the workspace')
  }
  return current
}

function collisionName(name: string, index: number): string {
  if (index === 1) return name
  const extension = extname(name)
  return `${name.slice(0, -extension.length)}-${index}${extension}`
}

async function publish(root: string, requestedName: string, data: Buffer, requestedFormat: OfficeFormat | 'png', signal: AbortSignal): Promise<PublishedFile> {
  if (data.byteLength < 1 || data.byteLength > MAX_FILE_BYTES) throw new Error('Office output exceeds the 32 MiB limit')
  const directory = await officeDirectory(root)
  const temporary = join(directory, `.office-${randomUUID()}.tmp`)
  await writeFile(temporary, data, { flag: 'wx', flush: true, mode: 0o600, signal })
  try {
    for (let index = 1; index <= 999; index += 1) {
      signal.throwIfAborted()
      const name = collisionName(requestedName, index)
      const target = join(directory, name)
      try {
        await link(temporary, target)
        const info = await lstat(target)
        if (!info.isFile() || info.isSymbolicLink()) {
          await unlink(target).catch(() => {})
          throw new Error('Office output is not a regular file')
        }
        return { bytes: data.byteLength, format: requestedFormat, name, relative_path: ['.e-mate', 'office', name].join('/') }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    throw new Error('Too many Office files use the same name')
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

async function workspaceFile(root: string, relativePath: unknown): Promise<{ buffer: Buffer; name: string; path: string }> {
  if (typeof relativePath !== 'string' || relativePath.trim() !== relativePath || relativePath === ''
    || isAbsolute(relativePath) || relativePath.includes('\0')) throw new Error('Office path must be workspace-relative')
  const requested = join(root, relativePath)
  const path = await realpath(requested)
  if (!inside(root, path)) throw new Error('Office path escapes the workspace')
  const info = await lstat(requested)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw new Error('Office source is unavailable or too large')
  return { buffer: await readFile(path), name: path.split(sep).at(-1) as string, path: relative(root, path).split(sep).join('/') }
}

async function sourceFile(root: string, relativePath: unknown): Promise<{ buffer: Buffer; format: OfficeFormat; name: string; path: string }> {
  const source = await workspaceFile(root, relativePath)
  return { ...source, format: format(extname(source.path).toLowerCase().slice(1)) }
}

async function writeWord(root: string, document: unknown, signal: AbortSignal): Promise<Buffer> {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) throw new Error('Word document must be an object')
  const input = document as Record<string, unknown>
  if (input.operation === undefined) return await writeOfficeBuffer('docx', input)
  const keys = input.operation === 'create' ? ['operation', 'spec']
    : input.operation === 'template' ? ['operation', 'source_path', 'values']
      : ['operation', 'source_path', 'replacements']
  if (Object.keys(input).some(key => !keys.includes(key))) throw new Error('Word operation contains an unsupported field')
  if (input.operation === 'create') {
    const spec = input.spec as Record<string, unknown> | undefined
    if (spec === undefined || spec === null || typeof spec !== 'object' || !Array.isArray(spec.blocks) || spec.blocks.length > 10_000) throw new Error('Word creation spec is invalid')
    let imageBytes = 0
    const blocks = []
    for (const value of spec.blocks) {
      signal.throwIfAborted()
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Word block is invalid')
      const block = value as Record<string, unknown>
      if (block.type !== 'image') { blocks.push(block); continue }
      if ('data' in block) throw new Error('Word images require a workspace path')
      if (Object.keys(block).some(key => !['type', 'path', 'width', 'height', 'caption'].includes(key))) throw new Error('Word image contains an unsupported field')
      const source = await workspaceFile(root, block.path)
      const extension = extname(source.path).toLowerCase()
      if (!['.png', '.jpg', '.jpeg'].includes(extension)) throw new Error('Word images must be PNG or JPEG')
      imageBytes += source.buffer.byteLength
      if (imageBytes > MAX_FILE_BYTES) throw new Error('Word images exceed the size limit')
      const { path: _path, ...properties } = block
      blocks.push({ ...properties, type: 'image', data: source.buffer, imageType: extension === '.png' ? 'png' : 'jpg' })
    }
    return await createDocxBuffer({ ...spec, blocks } as unknown as NativeDocxSpec)
  }
  if (input.operation !== 'template' && input.operation !== 'replace') throw new Error('Word operation is invalid')
  const source = await sourceFile(root, input.source_path)
  if (source.format !== 'docx') throw new Error('Word source must be a DOCX file')
  signal.throwIfAborted()
  return input.operation === 'template'
    ? await templateDocxBuffer(source.buffer, input.values as Record<string, string>)
    : await replaceDocxBuffer(source.buffer, input.replacements as readonly { find: string; replace: string }[])
}

function startJob<T>(ctx: OfficeContext, owner: AgentOwner | undefined, signal: AbortSignal, label: string, run: (signal: AbortSignal) => Promise<T>): { id: string; result: Promise<T> } {
  if (owner === undefined) throw new Error('Office execution requires an owning Agent')
  let result!: Promise<T>
  const id = ctx.jobs.start({
    kind: 'emate-office', label, owner, outputLimitBytes: 4096,
    run() {
      const controller = new AbortController()
      const onAbort = () => controller.abort(signal.reason)
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', onAbort, { once: true })
      result = Promise.resolve().then(() => run(controller.signal)).finally(() => {
        signal.removeEventListener('abort', onAbort)
      })
      return {
        cancel: (reason: unknown) => controller.abort(reason),
        done: result.then(
          value => ({ status: 'completed', detail: label, output: JSON.stringify(value).slice(0, 4096) }),
          error => ({ status: controller.signal.aborted ? 'killed' : 'failed', detail: error instanceof Error ? error.message : String(error) }),
        ),
      }
    },
  })
  return { id, result }
}

const writeOutput = {
  schema: {
    type: 'object', additionalProperties: false, required: ['bytes', 'format', 'job_id', 'name', 'relative_path'],
    properties: {
      bytes: { type: 'integer' }, format: { type: 'string' }, job_id: { type: 'string' },
      name: { type: 'string' }, relative_path: { type: 'string' },
    },
  },
  render: (_args: unknown, value: PublishedFile & { job_id: string }) => [{ type: 'text', text: `Office 文件已生成：${value.relative_path}（${value.bytes} bytes）。` }],
  presentationMeta: (_args: unknown, value: PublishedFile & { job_id: string }) => ({
    operation: 'write', format: value.format, job_id: value.job_id, relative_path: value.relative_path, bytes: value.bytes,
  }),
}

const readOutput = {
  schema: {
    type: 'object', additionalProperties: false, required: ['bytes', 'document', 'format', 'job_id', 'name', 'relative_path'],
    properties: {
      bytes: { type: 'integer' }, document: { type: 'object' }, format: { type: 'string' }, job_id: { type: 'string' },
      name: { type: 'string' }, relative_path: { type: 'string' },
    },
  },
  render: (_args: unknown, value: { document: unknown; format: OfficeFormat; relative_path: string }) => [{
    type: 'text', text: `已读取 ${value.relative_path}。规范化内容：\n${JSON.stringify(value.document)}`,
  }],
  presentationMeta: (args: unknown, value: PublishedFile & { job_id: string; document?: { kind?: string } }) =>
    (args as { operation?: string } | undefined)?.operation === 'preview'
      ? { operation: 'preview', job_id: value.job_id, preview: value.document }
      : { operation: 'read', format: value.format, job_id: value.job_id, relative_path: value.relative_path, bytes: value.bytes },
}

/** Register bundled Skills and two real Tool/Job paths on target Harness seams. */
export function apply(ctx: OfficeContext): void {
  let calcHost: any | undefined
  ctx.inject(['fs', 'subprocess', 'sandbox', 'shellEnv'], host => {
    calcHost = host
    host.effect(() => () => { if (calcHost === host) calcHost = undefined })
  })
  let svgRenderer: Partial<SvgRenderer> | undefined
  let preview: ReturnType<typeof createOfficePreview> | undefined
  ctx.inject(['desktopRuntime', 'emateIdentity', 'emateAudit', 'connection', 'workspaceRegistry', 'sessions', 'subprocess', 'shellEnv', 'fs'], host => {
    const service = createOfficePreview(host); preview = service
    host.effect(() => host.connection.rpc.handle(PREVIEW_CHANNEL, async (action: string, payload: unknown, signal: AbortSignal) => {
      try { return { ok: true, value: await service.call(action, payload, signal) } }
      catch (error) {
        const code = error instanceof Error && 'code' in error && (error.code === 'preview-expired' || error.code === 'preview-unauthorized') ? error.code : 'preview-failed'
        // Native RPC errors have a closed enum; preview failures belong to the channel value.
        return { ok: true, value: { error: { code, message: error instanceof Error ? error.message : '预览失败。' } } }
      }
    }, { authority: 'loopback' }))
    host.on('credentials/updated', (ref: string) => { if (String(ref) === 'E_MATE_ENTERPRISE_SESSION') { service.changed(); host.timeout(() => service.changed(), 0) } })
    host.effect(() => () => { service.dispose(); if (preview === service) preview = undefined })
  })
  // Native injection stays optional to the existing CLI Office workflows.
  ctx.inject(['desktopRuntime'], host => {
    const runtime = host.desktopRuntime
    svgRenderer = runtime
    host.effect(() => () => { if (svgRenderer === runtime) svgRenderer = undefined })
  })
  ctx.skills.registerProvider((): SkillProvider => ({
    name: PROVIDER_NAME,
    async list(options) { options.signal?.throwIfAborted(); return SPECS.map(candidate) },
    async get(skill, options) {
      options.signal?.throwIfAborted()
      const spec = SPECS.find(item => item.name === skill.name && item.name === skill.locator)
      return spec === undefined ? undefined : await loadDefinition(spec, options)
    },
  }))
  ctx.effect(() => ctx.jobs.attachController('emate-office'), 'emate.office: target Job controller')
  ctx.effect(() => ctx.tools.register({
    name: 'office_write',
    description: 'Create a local Office file. DOCX supports styled creation, template filling and text replacement. PNG renders a standalone workspace SVG using the native Desktop renderer: document={source_svg,width,height}. XLSX/PDF also accept document={operation:"recalculate",source_path:"workspace.xlsx"} using managed Calc; other formats use normalized JSON. Always writes a new file and preserves the source.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['document', 'filename', 'format'],
      properties: {
        document: { type: 'object', description: 'Normalized format-specific content described by the Office Skill.' },
        filename: { type: 'string', description: 'Safe output filename with the matching extension.' },
        format: { type: 'string', enum: ['docx', 'xlsx', 'pptx', 'pdf', 'png'] },
      },
    },
    output: writeOutput,
    isConcurrencySafe: () => true,
    timeoutMs: OFFICE_TIMEOUT_MS,
    async execute(args: unknown, exec: ToolExecution) {
      assertWorkspaceWrite(ctx, exec.agent)
      const input = args as Record<string, unknown>
      const targetFormat = input.format === 'png' ? 'png' : format(input.format)
      const targetName = filename(input.filename, targetFormat)
      const root = await workspace(exec.agent)
      const started = startJob(ctx, exec.agent, exec.signal, `Write ${targetName}`, async jobSignal => {
        jobSignal.throwIfAborted()
        let data: Buffer
        const document = input.document as Record<string, unknown> | null
        if (document?.operation === 'recalculate') {
          if (targetFormat !== 'xlsx' && targetFormat !== 'pdf') throw new Error('Calc output must be XLSX or PDF')
          if (Array.isArray(document) || Object.keys(document).some(key => !['operation', 'source_path'].includes(key))) throw new Error('Calc operation contains an unsupported field')
          const source = await workspaceFile(root, document.source_path)
          if (extname(source.name).toLowerCase() !== '.xlsx') throw new Error('Calc source must be an XLSX file')
          const host = calcHost
          const environment = host?.shellEnv.collect(exec)
          const executable = environment?.DSH_EMATE_CALC
          const fontDirectory = environment?.DSH_EMATE_CALC_FONTS
          if (typeof executable !== 'string' || !isAbsolute(executable) || typeof fontDirectory !== 'string' || !isAbsolute(fontDirectory)) throw new Error('受管 Calc 运行时尚不可用。')
          const runtime = createCalcRuntime({ fs: host.fs, subprocess: host.subprocess, sandbox: host.sandbox }, { executable, fontDirectory })
          const result = await runtime.convert({ sourcePath: source.path, workspaceRoot: root, output: targetFormat, signal: jobSignal })
          data = Buffer.from(result.bytes)
        } else if (targetFormat === 'png') {
          const renderer = svgRenderer
          if (renderer?.renderSvgPage === undefined) throw new Error('Native Desktop SVG renderer is unavailable')
          const document = input.document as Record<string, unknown> | null
          if (document === null || typeof document !== 'object' || Array.isArray(document)
            || Object.keys(document).some(key => !['source_svg', 'width', 'height'].includes(key))
            || typeof document.width !== 'number' || typeof document.height !== 'number') {
            throw new Error('SVG preview requires source_svg, width and height')
          }
          const source = await workspaceFile(root, document.source_svg)
          if (extname(source.name).toLowerCase() !== '.svg') throw new Error('SVG preview source must be an SVG file')
          const svg = new TextDecoder('utf-8', { fatal: true }).decode(source.buffer)
          jobSignal.throwIfAborted()
          const rendered = await renderer.renderSvgPage({ svg, width: document.width, height: document.height, signal: jobSignal })
          if (rendered.width !== document.width || rendered.height !== document.height) throw new Error('SVG preview dimensions do not match the request')
          data = Buffer.from(rendered.png)
        } else data = targetFormat === 'docx'
          ? await writeWord(root, input.document, jobSignal)
          : await writeOfficeBuffer(targetFormat, input.document)
        jobSignal.throwIfAborted()
        return await publish(root, targetName, data, targetFormat, jobSignal)
      })
      const [file] = await Promise.all([started.result, ctx.jobs.wait(started.id, OFFICE_TIMEOUT_MS, exec.agent as AgentOwner, exec.signal)])
      return { ...file, job_id: started.id }
    },
    presentCall: (args: unknown) => {
      const input = args as Record<string, unknown>
      const targetName = filename(input.filename, input.format === 'png' ? 'png' : format(input.format))
      return {
        card: 'generic',
        title: '生成 Office 文件',
        kind: 'edit',
        rawInput: targetName,
        locations: [{ path: ['.e-mate', 'office', targetName].join('/') }],
      }
    },
  }), 'emate.office: write Tool')
  ctx.effect(() => ctx.tools.register({
    name: 'office_read',
    description: 'Read one workspace-relative DOCX, XLSX, PPTX, or PDF into normalized JSON. This extracts content. operation=preview opens the current workspace PPT Master project for native continuous preview; path is then its directory, even before its first SVG exists. No extra server.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: { path: { type: 'string', description: 'Workspace-relative Office file, or PPT project directory for preview.' }, operation: { type: 'string', enum: ['read', 'preview'] } },
    },
    output: readOutput,
    isConcurrencySafe: () => true,
    timeoutMs: OFFICE_TIMEOUT_MS,
    async execute(args: unknown, exec: ToolExecution) {
      const root = await workspace(exec.agent)
      const input = args as Record<string, unknown>
      if (input.operation === 'preview') {
        if (!preview) throw new Error('原生 PPT 预览尚不可用。')
        const service = preview
        const started = startJob(ctx, exec.agent, exec.signal, '准备 PPT 持续预览', async signal => {
          const document = await service.open(input.path, { ...exec, signal })
          return { bytes: 0, document, format: 'pptx' as const, name: 'PPT 持续预览', relative_path: document.project_path }
        })
        const [result] = await Promise.all([started.result, ctx.jobs.wait(started.id, OFFICE_TIMEOUT_MS, exec.agent as AgentOwner, exec.signal)])
        return { ...result, job_id: started.id }
      }
      const source = await sourceFile(root, input.path)
      const started = startJob(ctx, exec.agent, exec.signal, `Read ${source.name}`, async jobSignal => {
        jobSignal.throwIfAborted()
        const document = await readOfficeBuffer(source.format, source.buffer)
        jobSignal.throwIfAborted()
        return {
          bytes: source.buffer.byteLength,
          document,
          format: source.format,
          name: source.name,
          relative_path: source.path,
        }
      })
      const [result] = await Promise.all([started.result, ctx.jobs.wait(started.id, OFFICE_TIMEOUT_MS, exec.agent as AgentOwner, exec.signal)])
      return { ...result, job_id: started.id }
    },
    presentCall: (args: unknown) => {
      const input = args as Record<string, unknown>
      return { card: 'generic', title: '读取 Office 文件', kind: 'read', rawInput: typeof input.path === 'string' ? input.path : undefined }
    },
  }), 'emate.office: read Tool')
  ctx.effect(() => ctx.emateCapabilities.register({
    id: 'office-skills', title: 'Office 办公',
    summary: '本地创建、读取并以规范化内容安全生成 DOCX、XLSX、PPTX 和 PDF；复杂第三方版式不做伪无损覆盖。',
    icon_key: 'office', order: 20, actions: [],
    status: async () => ({ state: 'ready', detail: 'DOCX / XLSX / PPTX / PDF · local rc.7 Tools', action_ids: [] }),
  }), 'emate.office-skills: capability metadata')
}

export { readOfficeBuffer, writeOfficeBuffer } from './office-runtime.ts'
