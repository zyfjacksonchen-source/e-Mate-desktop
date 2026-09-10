/** Verify the bundled Office native targets before packaging or signing. */

import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

export type UniverNativeTarget = 'darwin-arm64' | 'darwin-x64' | 'win32-x64-msvc'

const BINDINGS = [
  { name: 'libsql', platformPrefix: '@libsql/' },
  { name: '@univerjs-pro/engine-formula-rust-binding', platformPrefix: '@univerjs-pro/engine-formula-rust-binding-' },
  { name: '@univerjs-pro/exchange-node-binding', platformPrefix: '@univerjs-pro/exchange-node-binding-' },
] as const

interface NativeManifest {
  name?: string
  version?: string
  main?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  os?: string[]
  cpu?: string[]
}

/** Require declared targets and their exact installed versions, without inventing missing platforms. */
export function verifyUniverNativeRuntime(componentRoot: string, targets: readonly UniverNativeTarget[]): void {
  const root = realpathSync(componentRoot)
  const manifest = (directory: string): NativeManifest => JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as NativeManifest
  const component = manifest(root)
  for (const binding of BINDINGS) {
    const parent = join(root, 'node_modules', binding.name)
    const definition = manifest(parent)
    if (definition.name !== binding.name || typeof definition.version !== 'string'
      || definition.version !== component.dependencies?.[binding.name]) {
      throw new Error(`Univer native dependency version mismatch: ${binding.name}`)
    }
    for (const target of targets) {
      const name = `${binding.platformPrefix}${target}`
      const version = definition.optionalDependencies?.[name]
      if (typeof version !== 'string' || version === '') {
        throw new Error(`Univer native dependency ${binding.name}@${definition.version} does not support ${target}; this package cannot satisfy the requested platform`)
      }
      const directory = join(parent, 'node_modules', name)
      const native = manifest(directory)
      const os = target.startsWith('darwin-') ? 'darwin' : 'win32'
      const cpu = target === 'darwin-arm64' ? 'arm64' : 'x64'
      if (native.name !== name || native.version !== version || !native.os?.includes(os)
        || !native.cpu?.includes(cpu) || typeof native.main !== 'string'
        || isAbsolute(native.main) || native.main.split(/[\\/]/u).includes('..') || !native.main.endsWith('.node')) {
        throw new Error(`Univer native target metadata mismatch: ${name}`)
      }
      const entry = join(directory, native.main)
      const path = relative(root, realpathSync(entry))
      const stat = lstatSync(entry)
      if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path) || !stat.isFile() || stat.size === 0) {
        throw new Error(`Univer native target is missing, empty or outside the component: ${name}`)
      }
    }
  }
}
