import {
  AlignmentType, Document, Footer, Header, HeadingLevel, ImageRun, Packer,
  PageNumber, Paragraph, PatchType, Table, TableCell, TableRow, TextRun,
  WidthType, patchDocument, type ParagraphChild,
} from 'docx'
import { DOMParser, XMLSerializer, type Document as XmlDocument, type Element as XmlElement, type Node as XmlNode } from '@xmldom/xmldom'
import { loadOfficeZip, readZipXml } from './office-runtime.ts'

export type NativeDocxBlock =
  | { type: 'heading'; text: string; level?: 1 | 2 | 3 }
  | { type: 'paragraph'; text?: string; runs?: Array<{ text: string; bold?: boolean; italic?: boolean }> }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'image'; data: Buffer; imageType: 'png' | 'jpg'; width: number; height: number; caption?: string }
  | { type: 'page-break' }
export interface NativeDocxSpec {
  title?: string
  subtitle?: string
  header?: string
  footer?: string
  font?: string
  accent?: string
  blocks: NativeDocxBlock[]
}
export interface DocxReplacement { find: string; replace: string }

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const XML = 'http://www.w3.org/XML/1998/namespace'
const MAX_TEXT = 1_000_000
function exactObject(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid or unsupported Word fields')
}
const serializer = new XMLSerializer()

function checkedText(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_TEXT
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) throw new Error('Invalid Word text')
  return value
}
function xmlDocument(xml: string): XmlDocument {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new Error('Word XML declarations are unsupported')
  const document = new DOMParser({ onError: (level, message) => {
    if (level !== 'warning') throw new Error(`Invalid Word XML: ${message}`)
  } }).parseFromString(xml, 'application/xml')
  if (!document.documentElement) throw new Error('Word XML has no root')
  return document
}
function elements(node: XmlNode): XmlElement[] {
  return Array.from(node.childNodes).filter((child): child is XmlElement => child.nodeType === 1)
}
function isW(node: XmlElement, local: string): boolean { return node.namespaceURI === W && node.localName === local }

/** JSON-driven authoring; only caller-supplied image bytes enter the document. */
export async function createDocxBuffer(spec: NativeDocxSpec): Promise<Buffer> {
  exactObject(spec, ['title', 'subtitle', 'header', 'footer', 'font', 'accent', 'blocks'])
  if (!Array.isArray(spec.blocks) || spec.blocks.length > 10_000) throw new Error('Invalid Word blocks')
  const accent = spec.accent ?? '214E70'
  if (!/^[0-9A-Fa-f]{6}$/u.test(accent)) throw new Error('Invalid Word accent')
  const font = checkedText(spec.font ?? 'Microsoft YaHei')
  if (!font || font.length > 100) throw new Error('Invalid Word font')
  let totalText = 0
  let imageBytes = 0
  const text = (value: unknown): string => {
    const result = checkedText(value)
    totalText += Buffer.byteLength(result)
    if (totalText > MAX_TEXT) throw new Error('Word structured content exceeds 1 MB')
    return result
  }
  const children: Array<Paragraph | Table> = []
  if (spec.title !== undefined) children.push(new Paragraph({ text: text(spec.title), heading: HeadingLevel.TITLE }))
  if (spec.subtitle !== undefined) children.push(new Paragraph({ text: text(spec.subtitle), style: 'Subtitle' }))
  for (const block of spec.blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) throw new Error('Invalid Word block')
    const fields = { heading: ['type', 'text', 'level'], paragraph: ['type', 'text', 'runs'], table: ['type', 'headers', 'rows'], image: ['type', 'data', 'imageType', 'width', 'height', 'caption'], 'page-break': ['type'] }
    exactObject(block, fields[block.type] ?? [])
    switch (block.type) {
      case 'heading': {
        const level = block.level ?? 1
        if (![1, 2, 3].includes(level)) throw new Error('Invalid heading level')
        children.push(new Paragraph({ text: text(block.text), heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][level - 1]! }))
        break
      }
      case 'paragraph': {
        if (block.text !== undefined && block.runs !== undefined) throw new Error('Specify paragraph text or runs')
        if (block.runs !== undefined && (!Array.isArray(block.runs) || block.runs.length > 10_000)) throw new Error('Invalid Word runs')
        for (const run of block.runs ?? []) {
          exactObject(run, ['text', 'bold', 'italic'])
          if (run.bold !== undefined && typeof run.bold !== 'boolean' || run.italic !== undefined && typeof run.italic !== 'boolean') throw new Error('Invalid Word run style')
        }
        children.push(new Paragraph({ children: (block.runs ?? [{ text: block.text ?? '' }]).map(run => new TextRun({ text: text(run.text), ...(run.bold === undefined ? {} : { bold: run.bold }), ...(run.italic === undefined ? {} : { italics: run.italic }) })) }))
        break
      }
      case 'table': {
        if (!Array.isArray(block.headers) || !block.headers.length || block.headers.length > 32
          || !Array.isArray(block.rows) || block.rows.length > 10_000
          || block.rows.some(row => !Array.isArray(row) || row.length !== block.headers.length)) throw new Error('Invalid Word table')
        const row = (values: string[], heading: boolean): TableRow => new TableRow({
          tableHeader: heading, cantSplit: true,
          children: values.map(value => new TableCell({
            ...(heading ? { shading: { fill: 'EAF0F5' } } : {}),
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            children: [new Paragraph({ children: [new TextRun({ text: text(value), bold: heading, color: heading ? accent : '24292F' })] })],
          })),
        })
        children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [row(block.headers, true), ...block.rows.map(values => row(values, false))] }))
        children.push(new Paragraph(''))
        break
      }
      case 'image': {
        if (!Buffer.isBuffer(block.data) || !['png', 'jpg'].includes(block.imageType)
          || !Number.isFinite(block.width) || !Number.isFinite(block.height)
          || block.width <= 0 || block.height <= 0 || block.width > 620 || block.height > 900) throw new Error('Invalid Word image')
        imageBytes += block.data.byteLength
        if (!block.data.byteLength || block.data.byteLength > 16 * 1024 * 1024 || imageBytes > 48 * 1024 * 1024) throw new Error('Word image size limit exceeded')
        const valid = block.imageType === 'png' ? block.data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : block.data[0] === 255 && block.data[1] === 216
        if (!valid) throw new Error('Word image bytes do not match type')
        children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ data: block.data, type: block.imageType, transformation: { width: block.width, height: block.height } })] }))
        if (block.caption !== undefined) children.push(new Paragraph({ text: text(block.caption), style: 'Caption', alignment: AlignmentType.CENTER }))
        break
      }
      case 'page-break': children.push(new Paragraph({ pageBreakBefore: true })); break
      default: throw new Error('Unsupported Word block')
    }
  }
  const fonts = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: font, cs: 'Arial' }
  const footer: ParagraphChild[] = []
  if (spec.footer !== undefined) footer.push(new TextRun(`${text(spec.footer)}  ·  `))
  footer.push(new TextRun({ children: ['第 ', PageNumber.CURRENT, ' 页 / 共 ', PageNumber.TOTAL_PAGES, ' 页'] }))
  const document = new Document({
    creator: 'e-Mate', title: spec.title ?? '',
    styles: {
      default: { document: { run: { font: fonts, size: 22, color: '24292F' }, paragraph: { spacing: { after: 120, line: 324 } } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', run: { size: 44, bold: true, color: accent, font: fonts }, paragraph: { spacing: { after: 220 }, keepNext: true } },
        { id: 'Subtitle', name: 'Subtitle', basedOn: 'Normal', run: { size: 24, color: '667085', font: fonts }, paragraph: { spacing: { after: 300 } } },
        ...[32, 26, 23].map((size, index) => ({ id: `Heading${index + 1}`, name: `heading ${index + 1}`, basedOn: 'Normal', next: 'Normal', run: { size, bold: true, color: accent, font: fonts }, paragraph: { spacing: { before: 240, after: 120 }, keepNext: true, outlineLevel: index } })),
        { id: 'Caption', name: 'Caption', basedOn: 'Normal', run: { size: 18, color: '667085', font: fonts } },
      ],
    },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1247, bottom: 1247, left: 1304, right: 1304 } } },
      ...(spec.header === undefined ? {} : { headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: text(spec.header), size: 18, color: '667085' })] })] }) } }),
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: footer })] }) },
      children,
    }],
  })
  return Packer.toBuffer(document)
}

interface TextSlot { node: XmlElement; start: number; end: number }
interface ParagraphText { text: string; slots: TextSlot[]; barriers: Set<number>; protected: Array<[number, number]> }
function paragraphText(paragraph: XmlElement, fields = { depth: 0 }): ParagraphText {
  const result: ParagraphText = { text: '', slots: [], barriers: new Set(), protected: [] }
  let fieldDepth = fields.depth
  for (const child of elements(paragraph)) {
    if (isW(child, 'pPr')) continue
    if (!isW(child, 'r')) {
      const text = Array.from(child.getElementsByTagNameNS(W, 't')).map(node => node.textContent ?? '').join('')
      const start = result.text.length
      result.barriers.add(start)
      result.text += text
      result.protected.push([start, result.text.length])
      result.barriers.add(result.text.length)
      continue
    }
    for (const node of elements(child)) {
      if (isW(node, 'rPr')) continue
      const start = result.text.length
      if (isW(node, 't')) {
        result.text += node.textContent ?? ''
        result.slots.push({ node, start, end: result.text.length })
        if (fieldDepth) result.protected.push([start, result.text.length])
      } else {
        result.barriers.add(start)
        if (isW(node, 'fldChar')) {
          const kind = node.getAttributeNS(W, 'fldCharType')
          if (kind === 'begin') fieldDepth++
          if (kind === 'end') fieldDepth = Math.max(0, fieldDepth - 1)
        }
        const text = isW(node, 'tab') ? '\t' : isW(node, 'br') || isW(node, 'cr') ? '\n' : ''
        result.text += text
        if (text) { result.protected.push([start, result.text.length]); result.barriers.add(result.text.length) }
      }
    }
  }
  fields.depth = fieldDepth
  return result
}
function matchesIn(paragraph: ParagraphText, find: string): Array<[number, number]> {
  const matches: Array<[number, number]> = []
  for (let start = paragraph.text.indexOf(find); start !== -1; start = paragraph.text.indexOf(find, start + find.length)) {
    const end = start + find.length
    if ([...paragraph.barriers].some(point => start < point && point < end)
      || paragraph.protected.some(([left, right]) => left < end && right > start)) throw new Error('Word replacement crosses protected structure; source is unchanged')
    matches.push([start, end])
  }
  return matches
}
function applyText(paragraph: ParagraphText, matches: Array<[number, number]>, replacement: string): void {
  for (const [start, end] of matches.toReversed()) {
    let first = true
    for (const { node, start: left, end: right } of paragraph.slots) {
      if (right <= start || left >= end) continue
      const text = node.textContent ?? ''
      node.textContent = text.slice(0, Math.max(start, left) - left) + (first ? replacement : '') + text.slice(Math.min(end, right) - left)
      node.setAttributeNS(XML, 'xml:space', 'preserve')
      first = false
    }
  }
}
function checkedReplacements(replacements: readonly DocxReplacement[]): void {
  if (!Array.isArray(replacements) || !replacements.length || replacements.length > 1000) throw new Error('Invalid Word replacements')
  let total = 0
  for (const replacement of replacements) {
    exactObject(replacement, ['find', 'replace'])
    const find = checkedText(replacement.find)
    const replace = checkedText(replacement.replace)
    total += Buffer.byteLength(find) + Buffer.byteLength(replace)
    if (!find || /[\r\n\t]/u.test(replace) || total > MAX_TEXT) throw new Error('Invalid Word replacement text')
  }
}
async function checkedWord(source: Buffer) {
  if (!Buffer.isBuffer(source) || source.length > 64 * 1024 * 1024) throw new Error('Invalid Word source buffer')
  const archive = await loadOfficeZip(source)
  if (!archive.zip.file('word/document.xml') || !archive.zip.file('[Content_Types].xml')) throw new Error('Not a Word document')
  const parts = new Map<string, XmlDocument>()
  for (const [path, entry] of Object.entries(archive.zip.files)) {
    if (entry.dir || !/\.(?:xml|rels)$/u.test(path)) continue
    const document = xmlDocument(await readZipXml(archive, entry))
    if (/^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/u.test(path)) parts.set(path, document)
  }
  return { archive, parts }
}

/** Safe text edits preserve unrelated ZIP entries byte-for-byte after decompression. */
export async function replaceDocxBuffer(source: Buffer, replacements: readonly DocxReplacement[]): Promise<Buffer> {
  checkedReplacements(replacements)
  const { archive, parts } = await checkedWord(source)
  let growth = 0
  const matched = new Set<string>()
  for (const [path, document] of parts) {
    let changed = false
    const fields = { depth: 0 }
    for (const paragraph of Array.from(document.getElementsByTagNameNS(W, 'p'))) {
      const mapped = paragraphText(paragraph, fields)
      const edits = replacements.flatMap(replacement => {
        const matches = matchesIn(mapped, replacement.find)
        if (matches.length) matched.add(replacement.find)
        return matches.map(([start, end]) => ({ start, end, text: replacement.replace }))
      }).sort((a, b) => a.start - b.start)
      for (let index = 0; index < edits.length; index++) {
        const edit = edits[index]!
        if (index && edits[index - 1]!.end > edit.start) throw new Error('Overlapping Word replacements')
        growth += Math.max(0, Buffer.byteLength(edit.text) - (edit.end - edit.start))
        if (growth > 16 * 1024 * 1024) throw new Error('Word replacement expansion limit exceeded')
      }
      for (const edit of edits.toReversed()) applyText(mapped, [[edit.start, edit.end]], edit.text)
      changed ||= edits.length > 0
    }
    if (changed) archive.zip.file(path, serializer.serializeToString(document))
  }
  if (replacements.some(replacement => !matched.has(replacement.find))) throw new Error('Word replacement text was not found; source is unchanged')
  return archive.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

/** docx 9.7.1's native template patcher, retaining template styling and other parts. */
export async function templateDocxBuffer(source: Buffer, values: Record<string, string>): Promise<Buffer> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid Word template values')
  const replacements = Object.entries(values).map(([key, value]) => {
    if (!/^[\p{L}\p{N}\p{M}_.-]+$/u.test(key)) throw new Error('Invalid Word template key')
    return { find: `{{${key}}}`, replace: value }
  })
  checkedReplacements(replacements)
  const { archive, parts } = await checkedWord(source)
  const touched = new Set<string>()
  const found = new Set<string>()
  for (const [path, document] of parts) {
    const fields = { depth: 0 }
    for (const paragraph of Array.from(document.getElementsByTagNameNS(W, 'p'))) {
      const mapped = paragraphText(paragraph, fields)
      for (const match of mapped.text.matchAll(/\{\{([\p{L}\p{N}\p{M}_.-]+)\}\}/gu)) if (!Object.hasOwn(values, match[1]!)) throw new Error('Word template value is missing')
      for (const replacement of replacements) if (matchesIn(mapped, replacement.find).length) {
        touched.add(path); found.add(replacement.find)
      }
    }
  }
  if (found.size !== replacements.length) throw new Error('Word template key was not found')
  const patches = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { type: PatchType.PARAGRAPH, children: [new TextRun(value)] }]))
  const expected = await checkedWord(await replaceDocxBuffer(source, replacements))
  const patched = await patchDocument({ data: source, outputType: 'nodebuffer', patches, keepOriginalStyles: true, recursive: false })
  const checked = await checkedWord(patched)
  for (const path of touched) {
    const document = checked.parts.get(path)
    if (!document) throw new Error('Word template patch lost a source part')
    const original = parts.get(path)!
    const protectedParts = (doc: XmlDocument): string[] => Array.from(doc.getElementsByTagNameNS(W, '*')).filter(node => ['drawing', 'pict', 'fldChar', 'instrText', 'tab', 'br', 'cr', 'bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd', 'commentReference'].includes(node.localName ?? '')).map(node => serializer.serializeToString(node))
    const texts = (doc: XmlDocument): string[] => Array.from(doc.getElementsByTagNameNS(W, 'p')).map(node => paragraphText(node).text)
    if (JSON.stringify(protectedParts(original)) !== JSON.stringify(protectedParts(document))
      || JSON.stringify(texts(expected.parts.get(path)!)) !== JSON.stringify(texts(document))) throw new Error('Word template patch cannot preserve this structure; source is unchanged')
    // Preserve styles/media/relationships and unrelated XML from the original ZIP.
    archive.zip.file(path, serializer.serializeToString(document))
  }
  return archive.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
