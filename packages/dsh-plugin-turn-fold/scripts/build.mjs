#!/usr/bin/env node
/**
 * Build the e-Mate turn-fold owner: copy the vendored upstream files into `lib/`
 * and fail closed unless every upstream seam still resolves against the pinned
 * 0.1.5 build.
 */
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { assertSeams, formatReport, packageRoot, repoRoot } from './seams.mjs'
import { SHIPPED } from './shipped.mjs'

const source = resolve(repoRoot, 'upstream', 'plugins', 'dsh-turn-fold')
const output = resolve(packageRoot, 'lib')

if (!process.argv.includes('--seams-only')) {
  await stat(resolve(source, 'patch.cjs'))
  await rm(output, { recursive: true, force: true })
  await mkdir(resolve(output, 'locales'), { recursive: true })
  for (const relative of SHIPPED) {
    await cp(resolve(source, relative), resolve(output, relative))
  }
  const manifest = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'))
  process.stdout.write(`vendored @ch4acko3/dsh-turn-fold@${manifest.version} → lib/ (${SHIPPED.length} files)\n`)
}

const report = assertSeams()
process.stdout.write(`${formatReport(report)}\n`)
