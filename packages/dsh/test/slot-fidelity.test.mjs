// e-Mate slot-name fidelity guard: every slot this repository injects into,
// registers on, or styles by `data-slot` must be a slot the pinned Harness
// baseline (or this repository itself) actually declares.
//
// The 0.1.5 upgrade renamed native slots ('conversation' became
// 'main.conversation'). A stale name does not fail loudly: `slots.inject`
// simply never fires and a CSS selector simply never matches, so the feature
// falls off the screen while every self-consistent spec stays green. This guard
// is the loud failure for that class of regression.
//
// Source plane only: it reads the pinned upstream checkout and this repository's
// sources, never built lib/ output.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const harnessRoot = join(repoRoot, 'upstream', 'deepseek-harness')

/** Directories that never hold hand-written source. */
const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', 'build', '.git', 'coverage'])

function walk(dir, extensions, skip = SKIP_DIRS) {
  const found = []
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) found.push(...walk(path, extensions, skip))
    else if (extensions.some(extension => entry.endsWith(extension))) found.push(path)
  }
  return found
}

/** Strip comments so quoted text inside prose is not read as code. */
function stripComments(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/^[ \t]*\/\/.*$/gmu, '')
}

/**
 * The source region between a balanced `{...}` at or after `from`.
 * @param source - source text.
 * @param from - index at or after which the opening brace must appear.
 * @returns the region between the braces, or undefined when unbalanced.
 */
function balancedRegion(source, from) {
  const open = source.indexOf('{', from)
  if (open === -1) return undefined
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  return undefined
}

/**
 * Slot names a program declares: the keys of every merge-extensible
 * `interface SlotMap` block, plus the keys of every child-slot table handed to
 * `slots.register`, `slots.declare`, or a test runtime's `declare`.
 * @param files - source files to read.
 * @returns the declared slot names.
 */
function declaredSlots(files) {
  const declared = new Set()
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'))
    for (const block of source.matchAll(/interface SlotMap[^{]*\{([\s\S]*?)\n\}/gu)) {
      for (const key of block[1].matchAll(/^\s*'([^']+)'\s*[?:]/gmu)) declared.add(key[1])
    }
    for (const marker of source.matchAll(/children\s*:|\.declare\(\s*\{/gu)) {
      const region = balancedRegion(source, marker.index + marker[0].length)
      if (region === undefined) continue
      for (const key of region.matchAll(/^\s*'([^']+)'\s*:/gmu)) declared.add(key[1])
    }
  }
  return declared
}

/**
 * Whether a match sits inside a quoted string literal (an assertion's own text
 * names a slot without registering it). Counts unescaped quotes before the match
 * on its own line; an odd count means the scan is inside one of them.
 * @param line - the source line holding the match.
 * @param offset - the match offset inside that line.
 * @returns true when the match is string content.
 */
function insideStringLiteral(line, offset) {
  let single = 0
  let double = 0
  for (let index = 0; index < offset; index += 1) {
    if (line[index] === '\\') index += 1
    else if (line[index] === "'") single += 1
    else if (line[index] === '"') double += 1
  }
  return single % 2 === 1 || double % 2 === 1
}

function repositorySources() {
  return walk(join(repoRoot, 'packages'), ['.ts', '.tsx'])
}

function harnessSources() {
  return ['client', 'extensions', 'bundle']
    .flatMap(group => walk(join(harnessRoot, 'packages', group), ['.ts', '.tsx']))
}

test('every slot this repository injects into or registers on is declared', () => {
  const declared = new Set([...declaredSlots(harnessSources()), ...declaredSlots(repositorySources())])

  const used = new Map()
  for (const file of repositorySources()) {
    const source = stripComments(readFileSync(file, 'utf8'))
    for (const match of source.matchAll(/slots\.(?:inject|register)\(\s*(?:\{\s*name:\s*)?'([A-Za-z][\w.-]{0,80})'/gu)) {
      const lineStart = source.lastIndexOf('\n', match.index) + 1
      const line = source.slice(lineStart, source.indexOf('\n', match.index))
      if (insideStringLiteral(line, match.index - lineStart)) continue
      if (!used.has(match[1])) used.set(match[1], new Set())
      used.get(match[1]).add(relative(repoRoot, file))
    }
  }

  assert.ok(declared.size > 50, `read only ${declared.size} declared slots — the Harness scan is broken`)
  assert.ok(used.size > 20, `read only ${used.size} used slots — the repository scan is broken`)

  const undeclared = [...used].filter(([name]) => !declared.has(name))
  assert.deepEqual(
    undeclared.map(([name, files]) => `${name} (used by ${[...files].sort().join(', ')})`),
    [],
    'these slot names are not declared by the pinned Harness or by this repository',
  )
})

test('every data-slot selector the product shell styles names a declared slot', () => {
  const shellClient = join(repoRoot, 'packages', 'dsh', 'profile', 'plugins', 'emate-shell', 'src', 'client')
  const declared = new Set([...declaredSlots(harnessSources()), ...declaredSlots(repositorySources())])

  const undeclared = new Set()
  for (const file of walk(shellClient, ['.css'])) {
    for (const match of readFileSync(file, 'utf8').matchAll(/data-slot=(?:\\?['"])([^'"\]]+)/gu)) {
      if (!declared.has(match[1])) undeclared.add(`${match[1]} (${relative(repoRoot, file)})`)
    }
  }

  assert.deepEqual([...undeclared].sort(), [], 'these data-slot selectors match no declared slot')
})
