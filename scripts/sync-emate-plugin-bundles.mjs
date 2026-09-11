#!/usr/bin/env node

import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const inventory = JSON.parse(await readFile(join(root, 'packages', 'dsh', 'profile', 'component-inventory.json'), 'utf8'))
if (inventory.schema_version !== 1 || !Array.isArray(inventory.components)) {
  throw new Error('component inventory is invalid')
}

async function copyEntry(source, target) {
  const metadata = await stat(source)
  await mkdir(target.endsWith('/') ? target : resolve(target, '..'), { recursive: true })
  await cp(source, target, { recursive: metadata.isDirectory(), force: true })
}

export async function syncEmatePluginBundles({ target = 'cli', destination } = {}) {
  if (!['cli', 'desktop'].includes(target)) throw new Error(`unsupported e-Mate bundle target: ${target}`)
  destination = resolve(destination ?? join(root, 'packages', 'dsh', 'profile', 'bundles'))
  const destinationRelative = relative(root, destination)
  if (destination === root || destinationRelative === '' || destinationRelative === '..'
    || destinationRelative.startsWith(`..${sep}`)) {
    throw new Error('e-Mate bundle destination must be a repository child directory')
  }
  const expected = inventory.components.filter(component =>
    /^@e-mate\/dsh-plugin-[a-z0-9-]+$/u.test(component.id)
      && (target === 'cli' ? component.cli === true : component.desktop !== 'blocked'))

  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })

  const receipts = []
  for (const component of expected) {
    const { id: name } = component
    const slug = name.slice('@e-mate/dsh-plugin-'.length)
    const source = join(root, component.root)
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    if (manifest.name !== name || manifest.version !== '2.0.18' || manifest.license !== (name === '@e-mate/dsh-plugin-imagegen' ? 'Apache-2.0' : 'MIT')) {
      throw new Error(`${source} package identity is invalid`)
    }
    if (typeof manifest.main !== 'string') throw new Error(`${name} has no main entry`)
    await stat(join(source, manifest.main))
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error(`${name} has no explicit files allowlist`)

    const componentTarget = join(destination, slug)
    await mkdir(componentTarget, { recursive: true })
    await cp(join(source, 'package.json'), join(componentTarget, 'package.json'))
    for (const entry of manifest.files) {
      if (typeof entry !== 'string' || entry === '' || entry.includes('..') || entry.startsWith('/')) {
        throw new Error(`${name} contains an unsafe files entry`)
      }
      await copyEntry(join(source, entry), join(componentTarget, entry))
    }
    receipts.push({ name, version: manifest.version, directory: basename(componentTarget) })
  }

  await writeFile(join(destination, 'registry.json'), `${JSON.stringify({
    schema_version: 1,
    product: 'e-Mate',
    version: '2.0.18',
    harness_version: '0.1.5-rc.1',
    harness_commit: 'e841a5c4add3f7e34c3f7efc8742313debf54922',
    packages: receipts,
  }, null, 2)}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      target: { type: 'string', default: 'cli' },
      out: { type: 'string' },
    },
  })
  await syncEmatePluginBundles({ target: values.target, destination: values.out })
}
