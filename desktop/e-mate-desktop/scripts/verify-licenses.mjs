/**
 * Verify every production dependency shipped inside the desktop installers
 * carries a permissive license that allows redistribution.
 *
 * Walks the production dependency graph (dependencies + optionalDependencies,
 * excluding dev/peer) starting from this package manifest and the private
 * node_modules materialized by sync-emate-plugin-bundles. Component roots are
 * also checked; this does not inventory dependencies inlined into their code.
 * Fails when a package has no license field and no LICENSE file, or when its
 * license is not on the redistribution allowlist.
 *
 * @module scripts/verify-licenses
 */

import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const rootManifestPath = realpathSync(join(packageRoot, 'package.json'))
const rootManifest = JSON.parse(readFileSync(rootManifestPath, 'utf8'))

/** Licenses accepted for redistribution inside the desktop installers. */
const ALLOWED_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'Unlicense',
  'MPL-2.0',
  'CC0-1.0',
  'Zlib',
  'Python-2.0',
])

/**
 * Licenses that permit redistribution only when their notice obligations are
 * honored. Sharp ships libvips as a separate @img/sharp-libvips-* package on
 * macOS and inside the @img/sharp-win32-* package on Windows. Their license
 * texts ship inside node_modules in the installer. Keep this list minimal and
 * review any addition.
 */
const NOTICE_LICENSES = new Set([
  'LGPL-3.0-or-later',
  'Apache-2.0 AND LGPL-3.0-or-later',
])

/**
 * Locate one installed package manifest by walking node_modules directories
 * upward from the parent manifest. Reads the real package.json regardless of
 * the package's `exports` map, which often hides the `./package.json` subpath.
 */
function resolvePackageManifest(name, fromManifestPath) {
  const segments = name.split('/')
  const folder = name.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  const entry = name.startsWith('@') ? segments.slice(2).join('/') : segments.slice(1).join('/')
  let dir = dirname(fromManifestPath)
  for (;;) {
    const candidate = join(dir, 'node_modules', folder, entry, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** Normalize the license field of one package manifest. */
function licenseExpression(manifest) {
  const value = manifest.license
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && typeof value.type === 'string') return value.type
  if (Array.isArray(manifest.licenses)) {
    return manifest.licenses
      .map((item) => (typeof item === 'string' ? item : item.type))
      .filter(Boolean)
      .join(' OR ')
  }
  return undefined
}

const failures = []
const seen = new Set()
const manifests = []
const queue = [{ name: rootManifest.name ?? '@e-mate/desktop', manifestPath: rootManifestPath }]

// Inspect the exact component trees selected and materialized by the native
// Desktop build, including their private nested dependencies. Do not resolve
// these from the source workspace or rebuild a second bundle selection graph.
const bundlesRoot = join(packageRoot, 'build/e-mate-profile/bundles')
const registry = JSON.parse(readFileSync(join(bundlesRoot, 'registry.json'), 'utf8'))
if (registry.schema_version !== 1 || !Array.isArray(registry.packages)) {
  throw new Error('verify-licenses: bundled component registry is invalid')
}
for (const component of registry.packages) {
  queue.push({ name: component.name, manifestPath: join(bundlesRoot, component.directory, 'package.json'), component: true })
}

for (let index = 0; index < queue.length; index += 1) {
  const current = queue[index]
  if (current === undefined) continue
  const manifestPath = realpathSync(current.manifestPath)
  if (seen.has(manifestPath)) continue
  seen.add(manifestPath)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const label = `${current.name}@${manifest.version ?? 'unknown'} (${relative(packageRoot, manifestPath)})`

  if (manifestPath !== rootManifestPath) {
    const license = licenseExpression(manifest)
    const hasLicenseFile = existsSync(join(dirname(manifestPath), 'LICENSE'))
      || existsSync(join(dirname(manifestPath), 'LICENSE.md'))
      || existsSync(join(dirname(manifestPath), 'LICENSE.txt'))
    if (license === undefined && !hasLicenseFile) {
      failures.push(`${label}: no license field and no LICENSE file`)
    } else if (license !== undefined && license.startsWith('SEE LICENSE IN ')) {
      if (!hasLicenseFile) {
        failures.push(`${label}: license refers to ${JSON.stringify(license)} but no LICENSE file is shipped`)
      }
    } else if (license !== undefined && !ALLOWED_LICENSES.has(license) && !NOTICE_LICENSES.has(license)) {
      failures.push(`${label}: license ${JSON.stringify(license)} is not on the redistribution allowlist`)
    }
    manifests.push({ name: current.name, version: manifest.version, license: license ?? 'SEE LICENSE FILE' })
  }

  if (current.component) {
    const modulesRoot = join(dirname(manifestPath), 'node_modules')
    const names = existsSync(modulesRoot) ? readdirSync(modulesRoot)
      .filter(name => !name.startsWith('.'))
      .flatMap(name => name.startsWith('@')
        ? readdirSync(join(modulesRoot, name)).map(child => `${name}/${child}`)
        : [name]) : []
    for (const name of names) {
      const path = join(modulesRoot, name, 'package.json')
      if (existsSync(path)) queue.push({ name, manifestPath: path })
    }
    for (const name of manifest.bundledDependencies ?? []) {
      if (!existsSync(join(modulesRoot, name, 'package.json'))) {
        failures.push(`${label} -> ${name}: bundled dependency was not materialized`)
      }
    }
    continue
  }

  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      const resolved = resolvePackageManifest(name, manifestPath)
      if (resolved === undefined) {
        // Optional dependencies may legitimately be absent on this platform.
        if (section === 'optionalDependencies') continue
        failures.push(`${label} -> ${name}: could not locate its manifest`)
        continue
      }
      queue.push({ name, manifestPath: resolved })
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`verify-licenses: ${failures.length} production package(s) need attention\n`)
  for (const failure of failures) process.stderr.write(`- ${failure}\n`)
  process.exit(1)
}

const nativeManifest = JSON.parse(readFileSync(join(packageRoot, 'third-party-notices/feishu-cli/1.0.88/manifest.json'), 'utf8'))
const noticeOnly = manifests.filter(entry => NOTICE_LICENSES.has(entry.license))
const noticesArg = process.argv.indexOf('--notices')
if (noticesArg !== -1) {
  const target = process.argv[noticesArg + 1]
  if (target === undefined) {
    process.stderr.write('verify-licenses: --notices requires a file path\n')
    process.exit(1)
  }
  const lines = [
    '# Third-Party Notices',
    '',
    'e-Mate distributes the following third-party packages inside its installers.',
    'Each package ships with its own license text in the application files; this list records',
    'the package names, versions, and licenses for transparency.',
    '',
    '| Package | Version | License |',
    '| --- | --- | --- |',
    ...manifests
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => `| ${entry.name} | ${entry.version ?? ''} | ${entry.license} |`),
    '',
    noticeOnly.length === 0
      ? ''
      : `> Notice-required licenses in use: ${[...new Set(noticeOnly.map(entry => entry.license))].join(', ')}. Their license texts ship inside node_modules; see the package LICENSE files for the full terms.`,
    '',
    '## Feishu native executable notices',
    '',
    `The ${nativeManifest.package} ${nativeManifest.version} native executable includes Go modules that are separate from the npm dependency table above.`,
    `Statically verified official binary targets: ${Object.keys(nativeManifest.binarySha256).join(', ')}; Go ${nativeManifest.goVersion}; source commit ${nativeManifest.sourceCommit}.`,
    `Original license and notice texts (${nativeManifest.files.length} files), exact module versions, source URLs and SHA256 hashes are retained under Resources/third-party-notices/feishu-cli/${nativeManifest.version}/ (resources/ on Windows). See manifest.json in that directory.`,
    `Actual compiled module counts by target: ${Object.entries(nativeManifest.targetModules).map(([target, modules]) => `${target}: ${modules.length}`).join('; ')}.`,
    nativeManifest.scope,
    '',
  ].filter(line => line !== '')
  writeFileSync(join(packageRoot, target), lines.join('\n'))
}

const total = seen.size - 1
const summary = noticeOnly.length === 0
  ? `verify-licenses: ${total} production packages carry redistribution-safe licenses`
  : `verify-licenses: ${total} production packages checked; ${noticeOnly.length} use notice-required licenses (${[...new Set(noticeOnly.map(entry => entry.license))].join(', ')})`
process.stdout.write(`${summary}\n`)
