import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { createVisualizeDefinition } = await import(pathToFileURL(createRequire(import.meta.url).resolve('dsh-visualize')).href)

it.each([
  { chunks: ['汉字🙂abc'], cap: 6, html: '汉字', truncated: true },
  { chunks: ['汉', '🙂', 'abc'], cap: 7, html: '汉🙂', truncated: true },
  { chunks: ['🙂'], cap: 3, html: '', truncated: true },
  { chunks: ['汉🙂'], cap: 7, html: '汉🙂', truncated: false },
  { chunks: ['abc', 'def'], cap: 4, html: 'abcd', truncated: true },
])('caps preview at $cap UTF-8 bytes without splitting characters: $chunks', async ({ chunks, cap, html, truncated }) => {
  const original = chunks.join('')
  const tool = createVisualizeDefinition({
    fs: {
      resolve: async () => ({ displayPath: 'preview.html' }),
      stat: async () => ({ type: 'file', size: Buffer.byteLength(original), version: 'fixture' }),
      streamText: async function* () { yield* chunks },
    },
    emit: () => {},
  }, { maxPreviewBytes: cap })
  const result = await tool.execute({ path: 'preview.html' }, { signal: new AbortController().signal })
  expect(result).toEqual({ path: 'preview.html', size: Buffer.byteLength(original), html, truncated })
  expect(Buffer.byteLength(result.html)).toBeLessThanOrEqual(cap)
  expect(result.html).not.toContain('\uFFFD')
})
