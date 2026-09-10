#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const packageRoot = resolve(dirname(script), '..')
const requireFromPlugin = createRequire(join(packageRoot, 'package.json'))
const nativePackages = [
  '@libsql/darwin-arm64',
  '@libsql/darwin-x64',
  '@libsql/linux-arm64-gnu',
  '@libsql/linux-arm64-musl',
  '@libsql/linux-x64-gnu',
  '@libsql/linux-x64-musl',
  '@libsql/linux-arm-gnueabihf',
  '@libsql/linux-arm-musleabihf',
  '@libsql/win32-x64-msvc'
]
/** Materialize the locked runtime closure, preserving nested versions and licenses. */
export function copyGatewayDependencies(targetRoot) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const names = manifest.bundledDependencies
  if (!Array.isArray(names) || names.length !== Object.keys(manifest.dependencies).length
    || names.some(name => !Object.hasOwn(manifest.dependencies, name))) {
    throw new Error('Univer must explicitly bundle every declared runtime dependency')
  }
  let nativeCount = 0
  const copyDependency = (name, requireFrom, parent, ancestry, optional = false) => {
    let source
    try {
      source = locatePackage(name, requireFrom)
    } catch (error) {
      if (optional && error?.code === 'MODULE_NOT_FOUND') return
      throw error
    }
    if (ancestry.has(source)) return
    const destination = join(parent, 'node_modules', ...name.split('/'))
    copyPackage(source, destination)
    if (nativePackages.includes(name)) nativeCount++
    const dependency = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    const nextRequire = createRequire(join(source, 'package.json'))
    const nextAncestry = new Set([...ancestry, source])
    for (const child of Object.keys(dependency.dependencies ?? {})) {
      copyDependency(child, nextRequire, destination, nextAncestry)
    }
    for (const child of Object.keys(dependency.optionalDependencies ?? {})) {
      copyDependency(child, nextRequire, destination, nextAncestry, true)
    }
  }
  for (const name of names) copyDependency(name, requireFromPlugin, targetRoot, new Set())
  if (nativeCount === 0) throw new Error('libsql platform package is not installed')
  return nativeCount
}

function locatePackage(name, requireFrom) {
  let cursor = dirname(resolvePackageEntry(name, requireFrom))
  for (;;) {
    const manifest = join(cursor, 'package.json')
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
      if (parsed.name === name) return cursor
    }
    const parent = dirname(cursor)
    if (parent === cursor) throw new Error(`package root not found for ${name}`)
    cursor = parent
  }
}

function resolvePackageEntry(name, requireFrom) {
  const candidates =
    name === '@univerjs-pro/cli-assets' ? [`${name}/manifest.json`] : [name, `${name}/package.json`]
  let missing
  for (const candidate of candidates) {
    try {
      return requireFrom.resolve(candidate)
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND' && error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED')
        throw error
      missing = error
    }
  }
  throw missing
}

function copyPackage(source, destination) {
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: path => relative(source, path).split(sep)[0] !== 'node_modules'
  })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === script) {
  const target = process.argv[2]
  if (target === undefined) throw new Error('usage: copy-gateway-dependencies.mjs <package-root>')
  const count = copyGatewayDependencies(resolve(target))
  console.log(`Copied Gateway dependencies (${count} platform package${count === 1 ? '' : 's'})`)
}
