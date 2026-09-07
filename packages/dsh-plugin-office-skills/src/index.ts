/** Lightweight, local Office execution for the e-Mate rc.7 Harness profile. */

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
interface OfficeContext {
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
  format: OfficeFormat
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
}

const skillRoot = fileURLToPath(new URL('../skills/', import.meta.url))
const SPECS: readonly SkillSpec[] = [
  { name: 'documents', description: 'Word 文档：创建、编辑和套用模板，支持中文排版、批注与修订。', whenToUse: '用于 Word 文档创建、模板填充、格式保留编辑、批注和修订；使用前验证 Python 依赖。', directory: `${skillRoot}documents`, format: 'docx', hostGuide: 'HOST.md', runtimePending: true },
  { name: 'pdf', description: 'PDF 文档：创建、提取、填写和检查版式，交付前渲染验证。', whenToUse: '用于 PDF 阅读、生成、表单填写及视觉检查；使用前验证 Python 和渲染依赖。', directory: `${skillRoot}pdf`, format: 'pdf', hostGuide: 'HOST.md', runtimePending: true },
  { name: 'spreadsheets', description: 'Create, read, and safely regenerate XLSX workbooks locally.', whenToUse: 'Use for tabular XLSX authoring, reading, analysis, and supported edits.', directory: `${skillRoot}spreadsheets`, format: 'xlsx' },
  { name: 'presentations', description: 'Create, read, and safely regenerate PPTX presentations locally.', whenToUse: 'Use for text-first PPTX authoring, extraction, review, and supported edits.', directory: `${skillRoot}presentations`, format: 'pptx' },
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
    metadata: { eMateCapability: 'office', ...(spec.format === undefined ? {} : { format: spec.format }), adapter: spec.hostGuide === undefined ? 'clean-room' : 'upstream', state: spec.runtimePending ? 'needs-runtime' : 'ready' },
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

function filename(value: unknown, expected: OfficeFormat): string {
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

async function publish(root: string, requestedName: string, data: Buffer, requestedFormat: OfficeFormat, signal: AbortSignal): Promise<PublishedFile> {
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

async function sourceFile(root: string, relativePath: unknown): Promise<{ buffer: Buffer; format: OfficeFormat; name: string; path: string }> {
  if (typeof relativePath !== 'string' || relativePath.trim() !== relativePath || relativePath === ''
    || isAbsolute(relativePath) || relativePath.includes('\0')) throw new Error('Office path must be workspace-relative')
  const requested = join(root, relativePath)
  const path = await realpath(requested)
  if (!inside(root, path)) throw new Error('Office path escapes the workspace')
  const info = await lstat(requested)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw new Error('Office source is unavailable or too large')
  const extension = extname(path).toLowerCase().slice(1)
  const sourceFormat = format(extension)
  return { buffer: await readFile(path), format: sourceFormat, name: path.split(sep).at(-1) as string, path: relative(root, path).split(sep).join('/') }
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
  presentationMeta: (_args: unknown, value: PublishedFile & { job_id: string }) => ({
    operation: 'read', format: value.format, job_id: value.job_id, relative_path: value.relative_path, bytes: value.bytes,
  }),
}

/** Register bundled Skills and two real Tool/Job paths on target Harness seams. */
export function apply(ctx: OfficeContext): void {
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
    description: 'Create a new local DOCX, XLSX, PPTX, or PDF from normalized JSON in the current workspace. Never overwrites a source file; supported edits are read → modify JSON → write a new file.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['document', 'filename', 'format'],
      properties: {
        document: { type: 'object', description: 'Normalized format-specific content described by the Office Skill.' },
        filename: { type: 'string', description: 'Safe output filename with the matching extension.' },
        format: { type: 'string', enum: ['docx', 'xlsx', 'pptx', 'pdf'] },
      },
    },
    output: writeOutput,
    isConcurrencySafe: () => true,
    timeoutMs: OFFICE_TIMEOUT_MS,
    async execute(args: unknown, exec: ToolExecution) {
      assertWorkspaceWrite(ctx, exec.agent)
      const input = args as Record<string, unknown>
      const targetFormat = format(input.format)
      const targetName = filename(input.filename, targetFormat)
      const root = await workspace(exec.agent)
      const started = startJob(ctx, exec.agent, exec.signal, `Write ${targetName}`, async jobSignal => {
        jobSignal.throwIfAborted()
        const data = await writeOfficeBuffer(targetFormat, input.document)
        jobSignal.throwIfAborted()
        return await publish(root, targetName, data, targetFormat, jobSignal)
      })
      const [file] = await Promise.all([started.result, ctx.jobs.wait(started.id, OFFICE_TIMEOUT_MS, exec.agent as AgentOwner, exec.signal)])
      return { ...file, job_id: started.id }
    },
    presentCall: (args: unknown) => {
      const input = args as Record<string, unknown>
      const targetName = filename(input.filename, format(input.format))
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
    description: 'Read one workspace-relative DOCX, XLSX, PPTX, or PDF into normalized JSON. This extracts content, not a lossless editable rendering of arbitrary third-party layout.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: { path: { type: 'string', description: 'Workspace-relative .docx, .xlsx, .pptx, or .pdf path.' } },
    },
    output: readOutput,
    isConcurrencySafe: () => true,
    timeoutMs: OFFICE_TIMEOUT_MS,
    async execute(args: unknown, exec: ToolExecution) {
      const root = await workspace(exec.agent)
      const source = await sourceFile(root, (args as Record<string, unknown>).path)
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
