import { cp, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncEmatePluginBundles } from '../../../scripts/sync-emate-plugin-bundles.mjs'

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repositoryRoot = resolve(desktopRoot, '..', '..')
const source = join(repositoryRoot, 'packages', 'dsh', 'profile')
const destination = join(desktopRoot, 'build', 'e-mate-profile')
const mark = join(source, 'plugins', 'emate-shell', 'assets', 'emate-mark.png')
const require = createRequire(import.meta.url)
const desktopManifest = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'))
const version = desktopManifest.version
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) {
  throw new Error('sync-emate-profile: desktop package version must be a stable semantic version')
}
const ecosystemPlugins = [
  'dsh-at-file',
  'dsh-file-viewer',
  'dsh-visualize',
]

// Build the complete product inventory before copying its generated Profile.
// The dsh-only build copies plugin lib files without rebuilding those components.
execFileSync('corepack', ['pnpm', 'run', 'build'], {
  cwd: repositoryRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

// Component builds reset runtime assets. Prepare the complete Desktop target set
// after that build and before copying bundles, including both universal slices.
const visionTargets = process.platform === 'darwin' ? 'darwin-arm64,darwin-x64'
  : process.platform === 'win32' ? 'win32-x64' : undefined
if (visionTargets !== undefined) {
  execFileSync(process.env.EMATE_BUILD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), [
    join(repositoryRoot, 'packages/dsh-plugin-vision-toolkit/scripts/prepare-wheels.py'),
    '--root', join(repositoryRoot, 'packages/dsh-plugin-vision-toolkit'),
    '--targets', visionTargets,
  ], { cwd: repositoryRoot, stdio: 'inherit' })
}

for (const path of [
  join(source, 'cordis.patch.yml'),
  join(source, 'plugins', 'health.js'),
  join(source, 'plugins', 'emate-shell', 'lib', 'client.js'),
  mark,
]) {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
    throw new Error(`sync-emate-profile: required build output is invalid: ${path}`)
  }
}

await rm(destination, { recursive: true, force: true })
await mkdir(dirname(destination), { recursive: true })
await cp(source, destination, {
  recursive: true,
  force: true,
  dereference: false,
  filter: async path => relative(source, path).split(sep)[0] !== 'bundles'
    && !(await lstat(path)).isSymbolicLink(),
})
await syncEmatePluginBundles({ target: 'desktop', destination: join(destination, 'bundles') })
for (const name of ecosystemPlugins) {
  const packageRoot = dirname(require.resolve(`${name}/package.json`))
  await cp(packageRoot, join(destination, 'ecosystem', name), {
    recursive: true,
    force: true,
    dereference: true,
    filter: path => {
      const parts = relative(packageRoot, path).split(sep)
      return !(parts[0] === 'node_modules' && parts[1] === 'node-pty' && parts[2] === 'build')
    },
  })
}

const registry = JSON.parse(await readFile(join(destination, 'bundles', 'registry.json'), 'utf8'))
if (registry.product !== 'e-Mate' || registry.version !== version
  || registry.harness_commit !== 'bf7179bf3f62585d84b9b41b8cc1a0fffa1d7866') {
  throw new Error('sync-emate-profile: bundled e-Mate profile identity drifted')
}

await writeFile(join(destination, 'desktop-source.json'), `${JSON.stringify({
  schema_version: 1,
  product: 'e-Mate',
  version,
  harness_commit: registry.harness_commit,
  registry_sha256: createHash('sha256')
    .update(await readFile(join(destination, 'bundles', 'registry.json')))
    .digest('hex'),
}, null, 2)}\n`)
