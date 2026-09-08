import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import fontkit from '@pdf-lib/fontkit'
import { DOMParser, type Document as XmlDocument, type Element as XmlElement } from '@xmldom/xmldom'
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
} from 'docx'
import JSZip from 'jszip'
import { PDFDocument, rgb } from 'pdf-lib'
import type { Output as ParsedPdf } from 'pdf2json'
import PptxGenJS from 'pptxgenjs'

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf'
export type Scalar = string | number | boolean | null

export interface TextDocument {
  title?: string
  paragraphs: Array<string | { text: string; heading?: 1 | 2 | 3 }>
}

export interface WorkbookDocument {
  sheets: Array<{ name: string; rows: Scalar[][] }>
}

export interface SlidesDocument {
  slides: Array<{ title?: string; bullets: string[] }>
}

export interface PdfDocumentInput {
  title?: string
  pages: Array<{ lines: string[] }>
}

export type OfficeDocument = TextDocument | WorkbookDocument | SlidesDocument | PdfDocumentInput

// Model-facing examples belong beside the format validators, and are exercised
// by the existing real-byte round-trip tests.
export const OFFICE_CREATE_EXAMPLES: Readonly<Record<OfficeFormat, OfficeDocument>> = {
  docx: { title: 'e-Mate 文档', paragraphs: [{ text: '第一节', heading: 1 }, '正文内容'] },
  xlsx: { sheets: [{ name: '数据', rows: [['项目', '数量'], ['e-Mate', 207]] }] },
  pptx: { slides: [{ title: 'e-Mate 演示', bullets: ['第一点', '第二点'] }] },
  pdf: { title: 'e-Mate PDF', pages: [{ lines: ['中文 PDF 内容', '第二行'] }] },
}

const MAX_TEXT_BYTES = 1_000_000
const MAX_ROWS = 10_000
const MAX_COLUMNS = 256
const MAX_SLIDES = 200
const MAX_PAGES = 500
const MAX_ZIP_ENTRIES = 2_048
const MAX_ZIP_ENTRY_BYTES = 16 * 1024 * 1024
const MAX_ZIP_TOTAL_BYTES = 64 * 1024 * 1024
const MAX_XML_ENTRY_BYTES = 8 * 1024 * 1024
const MAX_ZIP_COMPRESSION_RATIO = 200
const fontRoot = fileURLToPath(new URL('../assets/noto-sans-sc/', import.meta.url))

export interface OfficeZip {
  zip: JSZip
  remainingXmlBytes: number
}

interface ZipMetadata {
  compressedSize?: unknown
  uncompressedSize?: unknown
}

export async function loadOfficeZip(buffer: Buffer): Promise<OfficeZip> {
  const zip = await JSZip.loadAsync(buffer)
  const entries = Object.values(zip.files)
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error('Office archive contains too many entries')
  let total = 0
  for (const entry of entries) {
    if (entry.dir) continue
    const metadata = (entry as unknown as { _data?: ZipMetadata })._data
    const compressed = metadata?.compressedSize
    const uncompressed = metadata?.uncompressedSize
    if (!Number.isSafeInteger(compressed) || !Number.isSafeInteger(uncompressed)
      || (compressed as number) < 0 || (uncompressed as number) < 0) {
      throw new Error('Office archive entry metadata is invalid')
    }
    if ((uncompressed as number) > MAX_ZIP_ENTRY_BYTES) throw new Error('Office archive entry exceeds the size limit')
    total += uncompressed as number
    if (total > MAX_ZIP_TOTAL_BYTES) throw new Error('Office archive exceeds the total size limit')
    if ((uncompressed as number) > 1024 * 1024
      && (uncompressed as number) > Math.max(1, compressed as number) * MAX_ZIP_COMPRESSION_RATIO) {
      throw new Error('Office archive entry exceeds the compression-ratio limit')
    }
  }
  return { zip, remainingXmlBytes: MAX_ZIP_TOTAL_BYTES }
}

export async function readZipXml(archive: OfficeZip, entry: JSZip.JSZipObject): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  const stream = entry.nodeStream('nodebuffer') as Readable
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      stream.destroy()
      reject(error)
    }
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > MAX_XML_ENTRY_BYTES || bytes > archive.remainingXmlBytes) {
        fail(new Error('Office XML exceeds the parsing limit'))
        return
      }
      chunks.push(chunk)
    })
    stream.once('error', error => { fail(error instanceof Error ? error : new Error('Office XML decompression failed')) })
    stream.once('end', () => {
      if (settled) return
      settled = true
      archive.remainingXmlBytes -= bytes
      resolve()
    })
  })
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))
  } catch (cause) {
    throw new Error('Office XML is not valid UTF-8', { cause })
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Office document must be an object')
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error('Office document contains an unsupported field')
  }
}

function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES
    || (!allowEmpty && value.trim() === '')) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function optionalTitle(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value, 'title')
}

function normalizedTextDocument(value: unknown): TextDocument {
  const input = record(value)
  exactKeys(input, ['paragraphs', 'title'])
  if (!Array.isArray(input.paragraphs) || input.paragraphs.length > MAX_ROWS) {
    throw new Error('DOCX paragraphs are invalid')
  }
  const paragraphs = input.paragraphs.map((entry): TextDocument['paragraphs'][number] => {
    if (typeof entry === 'string') return text(entry, 'paragraph', true)
    const item = record(entry)
    exactKeys(item, ['heading', 'text'])
    const content = text(item.text, 'paragraph', true)
    if (item.heading === undefined) return { text: content }
    if (item.heading !== 1 && item.heading !== 2 && item.heading !== 3) {
      throw new Error('DOCX heading must be 1, 2, or 3')
    }
    return { text: content, heading: item.heading }
  })
  const title = optionalTitle(input.title)
  return { ...(title === undefined ? {} : { title }), paragraphs }
}

function scalar(value: unknown): Scalar {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new Error('XLSX cells accept only string, number, boolean, or null')
}

function normalizedWorkbook(value: unknown): WorkbookDocument {
  const input = record(value)
  exactKeys(input, ['sheets'])
  if (!Array.isArray(input.sheets) || input.sheets.length < 1 || input.sheets.length > 100) {
    throw new Error('XLSX sheets are invalid')
  }
  const seen = new Set<string>()
  const sheets = input.sheets.map(entry => {
    const item = record(entry)
    exactKeys(item, ['name', 'rows'])
    const name = text(item.name, 'sheet name')
    if (name.length > 31 || /[\\/*?:\[\]]/u.test(name) || seen.has(name)) throw new Error('XLSX sheet name is invalid')
    seen.add(name)
    if (!Array.isArray(item.rows) || item.rows.length > MAX_ROWS) throw new Error('XLSX rows are invalid')
    const rows = item.rows.map(row => {
      if (!Array.isArray(row) || row.length > MAX_COLUMNS) throw new Error('XLSX row is invalid')
      return row.map(scalar)
    })
    return { name, rows }
  })
  return { sheets }
}

function normalizedSlides(value: unknown): SlidesDocument {
  const input = record(value)
  exactKeys(input, ['slides'])
  if (!Array.isArray(input.slides) || input.slides.length < 1 || input.slides.length > MAX_SLIDES) {
    throw new Error('PPTX slides are invalid')
  }
  return {
    slides: input.slides.map(entry => {
      const item = record(entry)
      exactKeys(item, ['bullets', 'title'])
      if (!Array.isArray(item.bullets) || item.bullets.length > 100) throw new Error('PPTX bullets are invalid')
      const title = optionalTitle(item.title)
      return {
        ...(title === undefined ? {} : { title }),
        bullets: item.bullets.map(item => text(item, 'slide bullet', true)),
      }
    }),
  }
}

function normalizedPdf(value: unknown): PdfDocumentInput {
  const input = record(value)
  exactKeys(input, ['pages', 'title'])
  if (!Array.isArray(input.pages) || input.pages.length < 1 || input.pages.length > MAX_PAGES) {
    throw new Error('PDF pages are invalid')
  }
  const title = optionalTitle(input.title)
  return {
    ...(title === undefined ? {} : { title }),
    pages: input.pages.map(entry => {
      const item = record(entry)
      exactKeys(item, ['lines'])
      if (!Array.isArray(item.lines) || item.lines.length > 500) throw new Error('PDF lines are invalid')
      return { lines: item.lines.map(line => text(line, 'PDF line', true)) }
    }),
  }
}

export function normalizeOfficeDocument(format: OfficeFormat, value: unknown): OfficeDocument {
  const serialized = JSON.stringify(value)
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_TEXT_BYTES) {
    throw new Error('Office document exceeds the 1 MB structured-content limit')
  }
  switch (format) {
    case 'docx': return normalizedTextDocument(value)
    case 'xlsx': return normalizedWorkbook(value)
    case 'pptx': return normalizedSlides(value)
    case 'pdf': return normalizedPdf(value)
  }
}

function heading(level: 1 | 2 | 3): typeof HeadingLevel[keyof typeof HeadingLevel] {
  return level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3
}

async function writeDocx(value: TextDocument): Promise<Buffer> {
  const children: Paragraph[] = []
  if (value.title !== undefined) children.push(new Paragraph({ text: value.title, heading: HeadingLevel.TITLE }))
  for (const paragraph of value.paragraphs) {
    children.push(typeof paragraph === 'string'
      ? new Paragraph({ text: paragraph })
      : new Paragraph({ text: paragraph.text, ...(paragraph.heading === undefined ? {} : { heading: heading(paragraph.heading) }) }))
  }
  return Buffer.from(await Packer.toBuffer(new Document({ sections: [{ children }] })))
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function columnName(index: number): string {
  let value = index
  let output = ''
  while (value > 0) {
    value -= 1
    output = String.fromCharCode(65 + value % 26) + output
    value = Math.floor(value / 26)
  }
  return output
}

function xlsxCell(value: Scalar, row: number, column: number): string {
  const reference = `${columnName(column)}${row}`
  if (value === null) return `<c r="${reference}"/>`
  if (typeof value === 'string') return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
  if (typeof value === 'boolean') return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`
  return `<c r="${reference}"><v>${String(value)}</v></c>`
}

async function writeXlsx(value: WorkbookDocument): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${value.sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`)
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${value.sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${value.sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`)
  value.sheets.forEach((sheet, sheetIndex) => {
    const rows = sheet.rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, columnIndex) => xlsxCell(cell, rowIndex + 1, columnIndex + 1)).join('')}</row>`).join('')
    zip.file(`xl/worksheets/sheet${sheetIndex + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`)
  })
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function writePptx(value: SlidesDocument): Promise<Buffer> {
  const deck = new PptxGenJS()
  deck.layout = 'LAYOUT_WIDE'
  deck.author = 'e-Mate'
  deck.subject = 'Generated locally by e-Mate'
  deck.theme = { headFontFace: 'Arial', bodyFontFace: 'Arial' }
  for (const source of value.slides) {
    const slide = deck.addSlide()
    slide.background = { color: '111111' }
    if (source.title !== undefined) {
      slide.addText(source.title, { x: 0.7, y: 0.55, w: 11.9, h: 0.7, fontSize: 26, bold: true, color: 'FFFFFF', margin: 0 })
    }
    slide.addText(source.bullets.map(item => ({ text: item, options: { bullet: { indent: 18 }, breakLine: true } })), {
      x: 0.9, y: 1.55, w: 11.4, h: 5.3, fontSize: 18, color: 'E7E7E7', breakLine: false, margin: 0.08,
    })
  }
  return Buffer.from(await deck.write({ outputType: 'nodebuffer' }) as ArrayBuffer)
}

interface FontRange { end: number; start: number }
interface FontSegment { file: string; ranges: FontRange[] }

let fontSegmentsPromise: Promise<FontSegment[]> | undefined

function parseRange(value: string): FontRange[] {
  return value.split(',').map(part => {
    const match = /^U\+([0-9a-f]+)(?:-([0-9a-f]+))?$/iu.exec(part.trim())
    if (match === null) throw new Error('Bundled Noto Sans SC unicode map is invalid')
    const start = Number.parseInt(match[1] as string, 16)
    return { start, end: Number.parseInt(match[2] ?? match[1] as string, 16) }
  })
}

function fontSegments(): Promise<FontSegment[]> {
  return fontSegmentsPromise ??= readFile(`${fontRoot}unicode.json`, 'utf8').then(raw => {
    const map = JSON.parse(raw) as Record<string, string>
    return Object.entries(map).map(([key, ranges]) => {
      const id = /^\[(\d+)\]$/u.exec(key)?.[1] ?? key
      if (!/^(?:\d+|cyrillic|latin|latin-ext|vietnamese)$/u.test(id)) {
        throw new Error('Bundled Noto Sans SC unicode map is invalid')
      }
      return { file: `${fontRoot}files/noto-sans-sc-${id}-wght-normal.woff2`, ranges: parseRange(ranges) }
    })
  })
}

function segmentFor(segments: readonly FontSegment[], codePoint: number): FontSegment {
  const segment = segments.find(item => item.ranges.some(range => codePoint >= range.start && codePoint <= range.end))
  if (segment === undefined) throw new Error(`PDF text contains an unsupported Unicode character U+${codePoint.toString(16).toUpperCase()}`)
  return segment
}

async function writePdf(value: PdfDocumentInput): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  if (value.title !== undefined) pdf.setTitle(value.title)
  pdf.setProducer('e-Mate 2.0.18')
  const segments = await fontSegments()
  const used = new Map<string, Awaited<ReturnType<PDFDocument['embedFont']>>>()
  const outlines = new Map<string, ReturnType<typeof fontkit.create>>()
  const allText = [value.title ?? '', ...value.pages.flatMap(page => page.lines)]
  for (const character of allText.join('')) {
    const codePoint = character.codePointAt(0) as number
    const segment = segmentFor(segments, codePoint)
    if (!used.has(segment.file)) {
      const bytes = await readFile(segment.file)
      used.set(segment.file, await pdf.embedFont(bytes, { subset: true }))
      outlines.set(segment.file, fontkit.create(bytes))
    }
  }
  const size = 12
  for (const source of value.pages) {
    const page = pdf.addPage([595.28, 841.89])
    let y = 800
    for (const line of source.lines) {
      let x = 48
      let text = ''
      let textWidth = 0
      let textFont: Awaited<ReturnType<PDFDocument['embedFont']>> | undefined
      let textOutline: ReturnType<typeof fontkit.create> | undefined
      const drawText = () => {
        if (textFont !== undefined && textOutline !== undefined && text !== '') {
          page.drawText(text, { x, y, font: textFont, size, opacity: 0 })
          const run = textOutline.layout(text)
          let glyphX = x
          for (let index = 0; index < run.glyphs.length; index += 1) {
            const position = run.positions[index]
            if (position === undefined) throw new Error('PDF font layout failed')
            const scale = size / textOutline.unitsPerEm
            page.drawSvgPath(run.glyphs[index]?.path.scale(1, -1).toSVG() ?? '', {
              x: glyphX + position.xOffset * scale,
              y: y + position.yOffset * scale,
              scale,
              color: rgb(0.08, 0.08, 0.08),
            })
            glyphX += position.xAdvance * scale
          }
        }
        x += textWidth
        text = ''
        textWidth = 0
      }
      for (const character of line) {
        const font = used.get(segmentFor(segments, character.codePointAt(0) as number).file)
        if (font === undefined) throw new Error('PDF font embedding failed')
        const width = font.widthOfTextAtSize(character, size)
        if (font !== textFont || x + textWidth + width > 547) {
          drawText()
          if (x + width > 547) { x = 48; y -= 20 }
          textFont = font
          textOutline = outlines.get(segmentFor(segments, character.codePointAt(0) as number).file)
        }
        if (y < 48) throw new Error('PDF page contains too much text; split it into more pages')
        text += character
        textWidth += width
      }
      drawText()
      y -= 20
    }
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }))
}

export async function writeOfficeBuffer(format: OfficeFormat, document: unknown): Promise<Buffer> {
  const value = normalizeOfficeDocument(format, document)
  switch (format) {
    case 'docx': return await writeDocx(value as TextDocument)
    case 'xlsx': return await writeXlsx(value as WorkbookDocument)
    case 'pptx': return await writePptx(value as SlidesDocument)
    case 'pdf': return await writePdf(value as PdfDocumentInput)
  }
}

function xmlText(xml: string, containerName: string): string[] {
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  const containers = Array.from(document.getElementsByTagName('*')).filter(node => node.localName === containerName)
  return containers.map(container => Array.from(container.getElementsByTagName('*'))
    .filter(node => node.localName === 't')
    .map(node => node.textContent ?? '')
    .join(''))
    .filter(Boolean)
}

async function readDocx(buffer: Buffer): Promise<TextDocument> {
  const archive = await loadOfficeZip(buffer)
  const entry = archive.zip.file('word/document.xml')
  if (entry === null) throw new Error('DOCX document.xml is missing')
  return { paragraphs: xmlText(await readZipXml(archive, entry), 'p') }
}

function numericPath(a: string, b: string): number {
  return Number(/(\d+)\.xml$/u.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/u.exec(b)?.[1] ?? 0)
}

async function readPptx(buffer: Buffer): Promise<SlidesDocument> {
  const archive = await loadOfficeZip(buffer)
  const paths = Object.keys(archive.zip.files).filter(path => /^ppt\/slides\/slide\d+\.xml$/u.test(path)).sort(numericPath)
  if (paths.length === 0 || paths.length > MAX_SLIDES) throw new Error('PPTX slide count is invalid')
  const slides: SlidesDocument['slides'] = []
  for (const path of paths) {
    const entry = archive.zip.file(path)
    if (entry === null) throw new Error('PPTX slide is missing')
    slides.push({ bullets: xmlText(await readZipXml(archive, entry), 'p') })
  }
  return { slides }
}

function parsedXml(xml: string): XmlDocument {
  return new DOMParser().parseFromString(xml, 'application/xml')
}

function namedElements(document: XmlDocument | XmlElement, name: string): XmlElement[] {
  return Array.from(document.getElementsByTagName('*')).filter((node): node is XmlElement => node.localName === name)
}

function cellColumn(reference: string): number {
  const letters = /^[A-Z]+/u.exec(reference)?.[0]
  if (letters === undefined) throw new Error('XLSX cell reference is invalid')
  return [...letters].reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0)
}

function xlsxCellValue(cell: XmlElement, sharedStrings: readonly string[]): Scalar {
  const type = cell.getAttribute('t')
  if (type === 'inlineStr') return namedElements(cell, 't').map(node => node.textContent ?? '').join('')
  const raw = namedElements(cell, 'v')[0]?.textContent
  if (raw === undefined || raw === '') return null
  if (type === 's') {
    const index = Number(raw)
    if (!Number.isSafeInteger(index) || sharedStrings[index] === undefined) throw new Error('XLSX shared string index is invalid')
    return sharedStrings[index]
  }
  if (type === 'b') return raw === '1'
  if (type === 'str' || type === 'e') return raw
  const value = Number(raw)
  return Number.isFinite(value) ? value : raw
}

async function readXlsx(buffer: Buffer): Promise<WorkbookDocument> {
  const archive = await loadOfficeZip(buffer)
  const workbookFile = archive.zip.file('xl/workbook.xml')
  const relationshipsFile = archive.zip.file('xl/_rels/workbook.xml.rels')
  if (workbookFile === null || relationshipsFile === null) throw new Error('XLSX workbook metadata is missing')
  const workbook = parsedXml(await readZipXml(archive, workbookFile))
  const relationships = parsedXml(await readZipXml(archive, relationshipsFile))
  const targets = new Map(namedElements(relationships, 'Relationship').map(node => [node.getAttribute('Id'), node.getAttribute('Target')]))
  const sharedFile = archive.zip.file('xl/sharedStrings.xml')
  const sharedStrings = sharedFile === null ? [] : xmlText(await readZipXml(archive, sharedFile), 'si')
  const sheets: WorkbookDocument['sheets'] = []
  const sheetElements = namedElements(workbook, 'sheet')
  if (sheetElements.length === 0 || sheetElements.length > 100) throw new Error('XLSX sheet count is invalid')
  for (const sheet of sheetElements) {
    const name = sheet.getAttribute('name')
    const target = targets.get(sheet.getAttribute('r:id') || sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'))
    if (name === null || target === null || target === undefined) throw new Error('XLSX sheet metadata is invalid')
    const path = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join('xl', target))
    if (!path.startsWith('xl/') || path.includes('../')) throw new Error('XLSX worksheet path is unsafe')
    const entry = archive.zip.file(path)
    if (entry === null) throw new Error('XLSX worksheet is missing')
    const document = parsedXml(await readZipXml(archive, entry))
    const rows: Scalar[][] = []
    for (const row of namedElements(document, 'row')) {
      const rowIndex = Number(row.getAttribute('r'))
      if (!Number.isSafeInteger(rowIndex) || rowIndex < 1 || rowIndex > MAX_ROWS) throw new Error('XLSX row index is invalid')
      while (rows.length < rowIndex) rows.push([])
      const values = rows[rowIndex - 1] as Scalar[]
      for (const cell of namedElements(row, 'c')) {
        const reference = cell.getAttribute('r')
        if (reference === null) throw new Error('XLSX cell reference is missing')
        const column = cellColumn(reference)
        if (column > MAX_COLUMNS) throw new Error('XLSX column exceeds the supported limit')
        while (values.length < column) values.push(null)
        values[column - 1] = xlsxCellValue(cell, sharedStrings)
      }
    }
    sheets.push({ name, rows })
  }
  return { sheets }
}

function pdfLines(texts: ParsedPdf['Pages'][number]['Texts']): string[] {
  const lines: Array<{ text: string; y: number }> = []
  for (const item of [...texts].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const content = item.R.map(run => decodeURIComponent(run.T)).join('')
    if (content === '') continue
    const line = lines.at(-1)
    if (line !== undefined && Math.abs(line.y - item.y) < 0.01) line.text += content
    else lines.push({ y: item.y, text: content })
  }
  return lines.map(line => line.text)
}

async function readPdf(buffer: Buffer): Promise<PdfDocumentInput> {
  const PDFParser = (await import(new URL('../assets/pdf2json/pdfparser.js', import.meta.url).href)).default as typeof import('pdf2json').default
  const compact = Buffer.allocUnsafeSlow(buffer.byteLength)
  buffer.copy(compact)
  const parsed = await new Promise<ParsedPdf>((resolve, reject) => {
    const parser = new PDFParser(null, true)
    parser.once('pdfParser_dataReady', value => { parser.destroy(); resolve(value) })
    parser.once('pdfParser_dataError', value => {
      parser.destroy()
      reject(value instanceof Error ? value : value.parserError)
    })
    parser.parseBuffer(compact, 0)
  })
  return {
    pages: parsed.Pages.map(page => ({
      lines: pdfLines(page.Texts),
    })),
  }
}

export async function readOfficeBuffer(format: OfficeFormat, buffer: Buffer): Promise<OfficeDocument> {
  switch (format) {
    case 'docx': return await readDocx(buffer)
    case 'xlsx': return await readXlsx(buffer)
    case 'pptx': return await readPptx(buffer)
    case 'pdf': return await readPdf(buffer)
  }
}
