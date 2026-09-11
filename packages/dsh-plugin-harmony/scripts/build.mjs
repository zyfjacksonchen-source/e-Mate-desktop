#!/usr/bin/env node
/**
 * Build the e-Mate harmony owner: copy the vendored published tree and fail closed
 * unless every builtin patch still resolves against the pinned 0.1.5 build.
 */
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { assertSeams, formatReport, packageRoot, repoRoot } from './seams.mjs'
import { BUILTINS, SHIPPED_FILES, SHIPPED_TREES } from './shipped.mjs'

const source = resolve(repoRoot, 'upstream', 'plugins', 'dsh-harmony')
const output = packageRoot

if (!process.argv.includes('--seams-only')) {
  for (const relative of SHIPPED_TREES) {
    await stat(resolve(source, relative))
    await rm(resolve(output, relative), { recursive: true, force: true })
    await cp(resolve(source, relative), resolve(output, relative), { recursive: true })
  }
  await mkdir(resolve(output, 'scripts'), { recursive: true })
  for (const relative of SHIPPED_FILES) {
    await cp(resolve(source, relative), resolve(output, relative))
  }
  const manifest = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'))
  process.stdout.write(`vendored ${manifest.name}@${manifest.version} → ${[...SHIPPED_TREES, ...SHIPPED_FILES].join(', ')}\n`)
  for (const relative of BUILTINS) await stat(resolve(output, relative))
}

const report = assertSeams()
process.stdout.write(`${formatReport(report)}\n`)
