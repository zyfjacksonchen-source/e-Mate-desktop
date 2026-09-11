import { describe, expect, test } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Every declared runtime import must resolve; the retired client edges must not come back. */
const desktopRoot = fileURLToPath(new URL('..', import.meta.url))
const contract = JSON.parse(readFileSync(join(desktopRoot, 'base-contract.json'), 'utf8')) as {
  harness_version: string
  runtime_imports: Record<string, string>
}
const app = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as {
  name: string
  exports?: Record<string, unknown>
}

/** The installable package of a specifier: a subpath such as @e-mate/desktop/vision-toolkit
 * resolves inside the package root, not as a nested node_modules directory. */
function packageRoot(specifier: string): string {
  const segments = specifier.split('/')
  return segments[0]?.startsWith('@') === true ? segments.slice(0, 2).join('/') : (segments[0] ?? specifier)
}

function installed(name: string): boolean {
  return existsSync(join(desktopRoot, 'node_modules', ...name.split('/')))
}

describe('declared runtime imports', () => {
  test('every declared package resolves, from the closure or from this app own exports', () => {
    const unresolved = Object.keys(contract.runtime_imports).filter((specifier) => {
      const name = packageRoot(specifier)
      if (installed(name)) return false
      // The desktop app publishes its own runtime entry points as subpath exports.
      if (name === app.name && specifier !== name) return app.exports?.['./' + specifier.slice(name.length + 1)] === undefined
      return true
    })
    expect(unresolved).toEqual([])
  })

  test('the removed 0.1.0 client packages are not declared again', () => {
    // 0.1.5 ships neither package (packages/client has no web-react and no runtime
    // package), and declaring one of them is the exact stale-edge failure that broke
    // transitive client imports during the upgrade.
    for (const retired of ['@deepseek-ai/dsh-client-web-react', '@deepseek-ai/dsh-client-runtime']) {
      expect(Object.keys(contract.runtime_imports)).not.toContain(retired)
    }
  })

  test('harness-owned imports are pinned to the accepted harness version', () => {
    const drifted = Object.entries(contract.runtime_imports)
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
      .filter(([, version]) => version !== contract.harness_version)
    expect(drifted).toEqual([])
  })
})
