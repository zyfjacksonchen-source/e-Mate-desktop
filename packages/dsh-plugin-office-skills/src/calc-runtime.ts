import { mkdir, mkdtemp, lstat, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Readable } from 'node:stream'
import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import { PDFDocument } from 'pdf-lib'
import { prepareCalcFontEnvironment } from '@e-mate/desktop/vision-toolkit'

const MAX_BYTES = 32 * 1024 * 1024
const MAX_OUTPUT = 64 * 1024 * 1024
const MAX_EXPANDED = 128 * 1024 * 1024
const MAX_XML = 16 * 1024 * 1024
const TIMEOUT = 120_000

export interface CalcRequest {
  sourcePath: string
  workspaceRoot: string
  output: 'xlsx' | 'pdf'
  signal: AbortSignal
}

export interface CalcResult {
  bytes: Uint8Array
  format: 'xlsx' | 'pdf'
  engine: 'LibreOffice Calc'
}

/** Paths are supplied by the Desktop's verified asset owner, never discovered on PATH. */
export interface CalcRuntimePaths {
  executable: string
  fontDirectory: string
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

export const CALC_PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
 <item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
 <item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item>
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
  <prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
  <prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop>
 </item>
</oor:items>`

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
      if (!isAbsolute(paths.executable) || !isAbsolute(paths.fontDirectory) || !isAbsolute(request.workspaceRoot)) throw new Error('Calc requires fixed absolute runtime, font and workspace paths')
      if (request.output !== 'xlsx' && request.output !== 'pdf') throw new Error('Calc output format is unsupported')
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT)])
      signal.throwIfAborted()
      if (!(await lstat(paths.executable)).isFile() || !(await lstat(paths.fontDirectory)).isDirectory()) throw new Error('Managed Calc runtime or fonts are missing')
      const source = await services.fs.resolve(request.sourcePath, { cwd: request.workspaceRoot, signal })
      const bytes = await services.fs.readBytes(source, signal, MAX_BYTES)
      if (bytes.byteLength > MAX_BYTES) throw new Error('Calc input exceeds 32 MiB')
      await validateCalcWorkbook(bytes, signal)
      const temporary = await mkdtemp(join(tmpdir(), 'emate-calc-'))
      let mayRemoveTemporary = true
      try {
        const profile = join(temporary, 'profile')
        const input = join(temporary, 'input.xlsx')
        const calculated = join(temporary, 'calculated')
        const rendered = join(temporary, 'rendered')
        await Promise.all([mkdir(join(profile, 'user'), { recursive: true }), mkdir(calculated), mkdir(rendered)])
        await writeFile(input, bytes, { flag: 'wx', mode: 0o600, signal })
        await writeFile(join(profile, 'user', 'registrymodifications.xcu'), CALC_PROFILE, { flag: 'wx', mode: 0o600, signal })
        const fontEnvironment = await prepareCalcFontEnvironment(paths.fontDirectory, temporary, signal)
        const run = async (file: string, filter: string, out: string) => {
          signal.throwIfAborted()
          const argv = [paths.executable, `-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--nologo', '--nodefault', '--norestore', '--convert-to', filter, '--outdir', out, file]
          // Native file-effect confinement is not a network or read-isolation guarantee.
          const confined = services.sandbox.confine(argv, { mode: 'workspace-write', workspaceRoot: temporary })
          const handle = services.subprocess.spawn({ argv: confined.argv, cwd: temporary, env: { ...fontEnvironment, XDG_CACHE_HOME: join(temporary, 'font-cache') }, signal, graceMs: 3000, stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } } })
          mayRemoveTemporary = false
          try {
            const result = await handle.done
            signal.throwIfAborted()
            if (result.exitCode !== 0) throw new Error(`Calc conversion failed (exit ${result.exitCode})`)
          } finally {
            // Also waits for descendants before the private profile is removed.
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
        await run(input, 'xlsx:Calc MS Excel 2007 XML', calculated)
        const xlsx = join(calculated, 'input.xlsx')
        const workbook = await readOutput(xlsx)
        await validateCalcWorkbook(workbook, signal)
        if (request.output === 'xlsx') return { bytes: workbook, format: 'xlsx', engine: 'LibreOffice Calc' }
        await run(xlsx, 'pdf:calc_pdf_Export', rendered)
        const pdf = await readOutput(join(rendered, 'input.pdf'))
        if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) || (await PDFDocument.load(pdf)).getPageCount() === 0) throw new Error('Calc did not produce a valid PDF')
        signal.throwIfAborted()
        return { bytes: pdf, format: 'pdf', engine: 'LibreOffice Calc' }
      } finally {
        if (mayRemoveTemporary) await rm(temporary, { recursive: true, force: true })
      }
    },
  }
}
