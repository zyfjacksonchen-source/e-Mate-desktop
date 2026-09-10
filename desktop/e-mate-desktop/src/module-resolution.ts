/** Profile-relative package resolution for Electron's restricted Node runtime. */

import { readFileSync, realpathSync } from 'node:fs'
import { builtinModules, registerHooks } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isProfileBaseRuntimePackage } from './base-contract.ts'

const DESKTOP_ENTRY_URL = new URL('../lib/index.js', import.meta.url).href
const DESKTOP_PACKAGE_NAME = '@e-mate/desktop'
const BUILTIN_PACKAGES = new Set(builtinModules.map(name => name.replace(/^node:/u, '')))

/** Return whether a Loader request needs Node package resolution. */
function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !URL.canParse(specifier)
}

function baseRuntimePackage(specifier: string): string | undefined {
  if (specifier.startsWith(`${DESKTOP_PACKAGE_NAME}/`)) {
    return isProfileBaseRuntimePackage(specifier) ? specifier : undefined
  }
  const segments = specifier.split('/')
  const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  return name !== undefined && isProfileBaseRuntimePackage(name) ? name : undefined
}

/** Stable runtime packages supplied by the pinned Base only when the component declares them. */
export function isBaseProfileRuntimeSpecifier(
  specifier: string,
  allowedImports: ReadonlySet<string>,
): boolean {
  const name = baseRuntimePackage(specifier)
  return name !== undefined && allowedImports.has(name)
}

function componentBaseImports(root: string, baseRuntimeImports: Readonly<Record<string, string>>): Set<string> {
  let value: unknown
  try { value = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) } catch {
    throw new Error(`bundled Profile component package contract is invalid: ${root}`)
  }
  const eMate = value !== null && typeof value === 'object' && !Array.isArray(value)
    && 'eMate' in value && value.eMate !== null && typeof value.eMate === 'object' && !Array.isArray(value.eMate)
    ? value.eMate as Record<string, unknown>
    : undefined
  const imports = eMate?.baseImports
  if (!Array.isArray(imports)
    || imports.some(name => typeof name !== 'string' || !Object.hasOwn(baseRuntimeImports, name))
    || imports.some((name, index) => index > 0 && imports[index - 1] >= name)) {
    throw new Error(`bundled Profile component Base imports are invalid: ${root}`)
  }
  return new Set(imports as string[])
}

/**
 * Resolve Cordis Loader bare imports from the selected persistent profile.
 * @param profileBaseUrl - file URL inside the profile that owns plugin dependencies.
 * @returns an idempotent hook disposer.
 */
export function installProfilePackageResolver(
  profileBaseUrl: string,
  componentRoots: Iterable<string> = [],
  baseRuntimeImports: Readonly<Record<string, string>> = {},
  loaderEntryUrl: string = import.meta.resolve('@deepseek-ai/cordis-plugin-loader'),
  baseRuntimeEntryUrl: string = DESKTOP_ENTRY_URL,
): () => void {
  const components = [...componentRoots].map(root => ({
    root: realpathSync(resolve(root)),
    prefix: pathToFileURL(`${realpathSync(resolve(root))}${sep}`).href,
    imports: componentBaseImports(root, baseRuntimeImports),
  }))
  const localDeclarations = new Map<string, ReadonlySet<string>>()
  const declaresLocalDependency = (root: string, parentURL: string, specifier: string): boolean => {
    // Harness and product services remain exclusive to the declared Base ABI.
    if (specifier.startsWith('@deepseek-ai/') || specifier.startsWith('@e-mate/')) return false
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!
    let directory = dirname(fileURLToPath(parentURL))
    while (directory === root || directory.startsWith(`${root}${sep}`)) {
      let names = localDeclarations.get(directory)
      if (names === undefined) {
        try {
          const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
            name?: string; dependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown>
          }
          names = new Set([
            ...(manifest.name === undefined ? [] : [manifest.name]),
            ...Object.keys(manifest.dependencies ?? {}),
            ...Object.keys(manifest.optionalDependencies ?? {}),
          ])
          localDeclarations.set(directory, names)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (names !== undefined) return names.has(name)
      directory = dirname(directory)
    }
    return false
  }
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const fromLoader = context.parentURL === loaderEntryUrl
      if (fromLoader && specifier === DESKTOP_PACKAGE_NAME) {
        return { shortCircuit: true, url: DESKTOP_ENTRY_URL }
      }
      if (context.parentURL !== undefined) {
        const component = components.find(candidate => context.parentURL!.startsWith(candidate.prefix))
        if (component !== undefined) {
          if (isBareSpecifier(specifier)) {
            if (isBaseProfileRuntimeSpecifier(specifier, component.imports)) {
              const parentURL = specifier.startsWith(`${DESKTOP_PACKAGE_NAME}/`)
                ? DESKTOP_ENTRY_URL
                : baseRuntimeEntryUrl
              return nextResolve(specifier, { ...context, parentURL })
            }
            if (BUILTIN_PACKAGES.has(specifier)) return nextResolve(specifier, context)
            if (declaresLocalDependency(component.root, context.parentURL, specifier)) {
              const resolved = nextResolve(specifier, context)
              if (resolved.url.startsWith('file:')
                && pathToFileURL(realpathSync(fileURLToPath(resolved.url))).href.startsWith(component.prefix)) return resolved
              throw new Error(`bundled Profile component dependency escape is blocked: ${specifier}`)
            }
            throw new Error(`bundled Profile component undeclared runtime import is blocked: ${specifier}`)
          }
          if (specifier.startsWith('node:') && BUILTIN_PACKAGES.has(specifier.slice(5))) {
            return nextResolve(specifier, context)
          }
          const resolved = nextResolve(specifier, context)
          if (resolved.url.startsWith(component.prefix)) return resolved
          throw new Error(`bundled Profile component path escape is blocked: ${specifier}`)
        }
      }
      if (fromLoader && isBareSpecifier(specifier)) {
        return nextResolve(specifier, { ...context, parentURL: profileBaseUrl })
      }
      return nextResolve(specifier, context)
    },
  })
  let active = true
  return () => {
    if (!active) return
    active = false
    hooks.deregister()
  }
}
