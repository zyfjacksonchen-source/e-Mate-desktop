/** Shared preparation and verification inventory for universal macOS packages. */

import { chmodSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
export {
  FORBIDDEN_MACOS_UNIVERSAL_ENTRIES,
  MACOS_UNIVERSAL_NATIVE_ENTRIES,
  type MacUniversalArch,
} from '../src/mac-universal-inventory.ts'
import { MACOS_UNIVERSAL_NATIVE_ENTRIES } from '../src/mac-universal-inventory.ts'

/** Injectable filesystem seam for source-runtime preparation. */
export interface MacUniversalPreparationOptions {
  readonly desktopRoot: string
  readonly exists: (path: string) => boolean
  readonly chmod: (path: string, mode: number) => void
}

/**
 * Validate both CPU runtime trees and restore node-pty helper execute bits.
 * Yarn intentionally disables lifecycle scripts, so the package step owns this
 * deterministic permission repair for both architectures.
 * @param options - Desktop root and injectable filesystem operations.
 */
export function prepareMacUniversalRuntime(
  options: MacUniversalPreparationOptions,
): void {
  const root = resolve(options.desktopRoot)
  const missing = MACOS_UNIVERSAL_NATIVE_ENTRIES
    .map(entry => join(root, entry.path))
    .filter(path => !options.exists(path))
  if (missing.length > 0) {
    throw new Error(
      `universal macOS runtime is missing ${String(missing.length)} native file(s): ${missing.join(', ')}`,
    )
  }

  for (const entry of MACOS_UNIVERSAL_NATIVE_ENTRIES) {
    if (entry.path.endsWith('/spawn-helper')) {
      options.chmod(join(root, entry.path), 0o755)
    }
  }
}

/** Prepare the installed workspace dependency tree for universal packaging. */
export function prepareInstalledMacUniversalRuntime(desktopRoot: string): void {
  prepareMacUniversalRuntime({ desktopRoot, exists: existsSync, chmod: chmodSync })
}
