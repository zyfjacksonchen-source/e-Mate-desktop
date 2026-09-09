import { mkdtemp, lstat, stat, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Readable } from 'node:stream'
import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'

const MAX_BYTES = 32 * 1024 * 1024
const MAX_OUTPUT = 64 * 1024 * 1024
const MAX_EXPANDED = 128 * 1024 * 1024
const MAX_XML = 16 * 1024 * 1024
export const CALC_TIMEOUT_MS = 120_000

export interface CalcRequest {
  sourcePath: string
  workspaceRoot: string
  output: 'xlsx'
  signal: AbortSignal
}

export interface CalcResult {
  bytes: Uint8Array
  format: 'xlsx'
  engine: 'formulas'
}

/** Paths are supplied by the Desktop's verified asset owner, never discovered on PATH. */
export interface CalcRuntimePaths {
  executable: string
  script: string
}

interface ProcessSpec {
  argv: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  graceMs: number
  stdio: { stdin: 'ignore'; stdout: { maxBytes: number }; stderr: { maxBytes: number } }
}
interface ProcessHandle {
  done: Promise<{ exitCode: number | null }>
  terminate(): void
  waitForExit(): Promise<boolean>
  collected: { stdout: { readFrom(offset: number): { text: string; lossy: boolean } }; stderr: { readFrom(offset: number): { text: string; lossy: boolean } } }
}

/** Existing native service seams; the caller retains session authorization and Job ownership. */
export interface CalcServices<Target> {
  fs: {
    resolve(path: string, options: { cwd: string; signal: AbortSignal }): Promise<Target>
    readBytes(target: Target, signal: AbortSignal, maxBytes: number): Promise<Uint8Array>
  }
  subprocess: { spawn(spec: ProcessSpec): ProcessHandle }
  sandbox: { confine(argv: readonly string[], policy: { mode: 'workspace-write'; workspaceRoot: string }): { argv: string[]; enforcement: 'full' | 'partial' } }
}

function isWebLink(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0
  } catch { return false }
}

/** Bounded ZIP streaming avoids trusting declared uncompressed sizes. No archive is extracted. */
export async function validateCalcWorkbook(bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (bytes.byteLength > MAX_OUTPUT || bytes.byteLength < 4) throw new Error('Calc workbook size is unsupported')
  const zip = await JSZip.loadAsync(bytes)
  const entries = Object.values(zip.files)
  if (entries.length > 4096) throw new Error('Calc workbook has too many parts')
  if (!zip.file('[Content_Types].xml') || !zip.file('xl/workbook.xml')) throw new Error('Calc requires an ordinary XLSX workbook')
  let expanded = 0
  let ordinaryWorkbook = false
  for (const entry of entries) {
    signal.throwIfAborted()
    const name = entry.name
    if (entry.dir) continue
    if (name !== (entry.unsafeOriginalName ?? name) || /(^\/|\\|(^|\/)\.\.?\/)/u.test(name)) throw new Error('Calc workbook contains unsafe part paths')
    if (/(?:vbaproject|macrosheet|dialogs\/|activex|embeddings\/|externallinks\/|connections\.xml|querytables\/|customui\/|webextensions\/)/iu.test(name)) throw new Error(`Calc does not support active or external content: ${name}`)
    const xml = /(?:\.xml|\.rels)$/iu.test(name)
    const parts: Buffer[] = []
    let size = 0
    await new Promise<void>((resolve, reject) => {
      const stream = entry.nodeStream() as Readable
      const abort = () => stream.destroy(signal.reason instanceof Error ? signal.reason : new Error('Calc cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      stream.on('data', (chunk: Buffer) => {
        expanded += chunk.length; size += chunk.length
        if (expanded > MAX_EXPANDED || (xml && size > MAX_XML)) {
          const error = new Error('Calc workbook expanded size exceeds limit')
          reject(error)
          stream.destroy(error)
        }
        else if (xml) parts.push(chunk)
      })
      stream.once('error', reject)
      stream.once('end', resolve)
      stream.once('close', () => signal.removeEventListener('abort', abort))
      stream.once('end', () => signal.removeEventListener('abort', abort))
      if (signal.aborted) abort()
    })
    if (!xml) continue
    const text = Buffer.concat(parts).toString('utf8')
    if (/<!DOCTYPE|<!ENTITY/iu.test(text) || text.includes('\u0000')) throw new Error('Calc workbook XML declarations or encoding are unsupported')
    const doc = new DOMParser({ onError: () => { throw new Error('Calc workbook XML is malformed') } }).parseFromString(text, 'application/xml')
    for (const element of Array.from(doc.getElementsByTagName('*'))) {
      const local = element.localName
      if (local === 'Override' || local === 'Default') {
        const content = element.getAttribute('ContentType') ?? ''
        if (/macroenabled|vba|oleobject|activex|externalLink|connections|queryTable/iu.test(content)) throw new Error('Calc does not support macros, active content or external data')
        if (element.getAttribute('PartName') === '/xl/workbook.xml' && content === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml') ordinaryWorkbook = true
      }
      if (local === 'Relationship') {
        const target = element.getAttribute('Target') ?? ''
        const type = element.getAttribute('Type') ?? ''
        const webHyperlink = /^(?:http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships|http:\/\/purl\.oclc\.org\/ooxml\/officeDocument\/relationships)\/hyperlink$/u.test(type) && isWebLink(target)
        if (!webHyperlink && (element.getAttribute('TargetMode')?.toLowerCase() === 'external' || /^(?:[a-z][a-z\d+.-]*:|\/\/|\\)/iu.test(target) || /externalLink|oleObject|vbaProject|attachedTemplate/iu.test(type))) throw new Error('Calc does not support active external relationships')
      }
      if (local === 'f' || local === 'definedName') {
        const formula = element.textContent ?? ''
        if (/(?:\b(?:WEBSERVICE|RTD|DDE|CALL|EXEC|REGISTER(?:\.ID)?|SQLREQUEST|IMAGE|STOCKHISTORY|CUBE\w*)\s*\(|\[[^\]]*\][^!]*!|\|[^!]*!)/iu.test(formula)) throw new Error('Calc does not support active or external formulas')
        for (const link of formula.matchAll(/\bHYPERLINK\s*\(/giu)) {
          const argument = /^\s*"((?:[^"]|"")*)"\s*[,;)]/u.exec(formula.slice(link.index + link[0].length))
          if (!argument || !isWebLink(argument[1]!.replaceAll('""', '"'))) throw new Error('Calc supports HYPERLINK formulas with literal HTTP or HTTPS destinations')
        }
      }
    }
  }
  if (!ordinaryWorkbook) throw new Error('Calc requires an ordinary XLSX content type')
  signal.throwIfAborted()
}

/** Converts a native-FS snapshot into a new artifact. Never publishes or overwrites the source. */
export function createCalcRuntime<Target>(services: CalcServices<Target>, paths: CalcRuntimePaths) {
  return {
    async convert(request: CalcRequest): Promise<CalcResult> {
      if (!isAbsolute(paths.executable) || !isAbsolute(paths.script) || !isAbsolute(request.workspaceRoot)) throw new Error('Calc requires fixed absolute managed Python, helper and workspace paths')
      if (request.output !== 'xlsx') throw new Error('Calc output format is unsupported')
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(CALC_TIMEOUT_MS)])
      signal.throwIfAborted()
      if (!(await stat(paths.executable)).isFile() || !(await lstat(paths.script)).isFile()) throw new Error('Managed Python runtime or formula helper is missing')
      const source = await services.fs.resolve(request.sourcePath, { cwd: request.workspaceRoot, signal })
      const bytes = await services.fs.readBytes(source, signal, MAX_BYTES)
      if (bytes.byteLength > MAX_BYTES) throw new Error('Calc input exceeds 32 MiB')
      await validateCalcWorkbook(bytes, signal)
      const temporary = await mkdtemp(join(tmpdir(), 'emate-calc-'))
      let mayRemoveTemporary = true
      try {
        const input = join(temporary, 'input.xlsx')
        const output = join(temporary, 'result.xlsx')
        await writeFile(input, bytes, { flag: 'wx', mode: 0o600, signal })
        const run = async () => {
          signal.throwIfAborted()
          const argv = [paths.executable, '-I', paths.script, input, output]
          // Native file-effect confinement is not a network or read-isolation guarantee.
          const confined = services.sandbox.confine(argv, { mode: 'workspace-write', workspaceRoot: temporary })
          const handle = services.subprocess.spawn({ argv: confined.argv, cwd: temporary, env: {}, signal, graceMs: 3000, stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } } })
          mayRemoveTemporary = false
          try {
            const result = await handle.done
            signal.throwIfAborted()
            if (result.exitCode !== 0) {
              const detail = handle.collected.stderr?.readFrom(0).text.trim().slice(-4096)
              throw new Error(`Calc conversion failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`)
            }
          } finally {
            // Also waits for descendants before the private snapshot is removed.
            try {
              handle.terminate()
              await handle.done.catch(() => {})
              mayRemoveTemporary = await handle.waitForExit() === true
            } catch (cause) {
              throw new Error(`Calc process tree exit could not be verified; retained ${temporary}`, { cause })
            }
            if (!mayRemoveTemporary) throw new Error(`Calc process tree has not exited; retained ${temporary}`)
          }
        }
        const readOutput = async (file: string) => {
          signal.throwIfAborted()
          const info = await lstat(file)
          if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > MAX_OUTPUT) throw new Error('Calc output is missing, unsafe or exceeds 64 MiB')
          return await readFile(file, { signal })
        }
        await run()
        const workbook = await readOutput(output)
        await validateCalcWorkbook(workbook, signal)
        signal.throwIfAborted()
        return { bytes: workbook, format: 'xlsx', engine: 'formulas' }
      } finally {
        if (mayRemoveTemporary) await rm(temporary, { recursive: true, force: true })
      }
    },
  }
}
