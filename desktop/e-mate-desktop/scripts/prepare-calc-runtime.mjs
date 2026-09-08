/** Desktop build-time extraction. No system installation or runtime download. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { download } from './prepare-python-runtime.mjs'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(await readFile(join(packageRoot, 'scripts/calc-runtime/manifest.json'), 'utf8'))

export async function fileDigest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function verifyArchive(path, expected) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size !== expected.bytes || await fileDigest(path) !== expected.sha256) {
    throw new Error(`Calc archive integrity mismatch: ${basename(path)}`)
  }
}

/** Check a link using the same platform's resolution and separator rules. */
export function verifyLinkTarget(root, link, target, paths = path) {
  const outside = paths.relative(root, paths.resolve(paths.dirname(link), target))
  if (paths.isAbsolute(target) || outside === '..' || outside.startsWith(`..${paths.sep}`) || paths.isAbsolute(outside)) {
    throw new Error('Calc asset link escapes its app')
  }
}

/** Inventory all bytes/modes/links; reject links escaping the retained app. */
export async function inventory(root) {
  const entries = []
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), stat = await lstat(path)
      const item = { path: relative(root, path).split('\\').join('/'), mode: stat.mode & 0o777 }
      if (stat.isSymbolicLink()) {
        const target = await readlink(path)
        verifyLinkTarget(root, path, target)
        entries.push({ ...item, kind: 'link', target })
      } else if (stat.isDirectory()) {
        entries.push({ ...item, kind: 'directory' }); await walk(path)
      } else if (stat.isFile()) entries.push({ ...item, kind: 'file', bytes: stat.size, sha256: await fileDigest(path) })
      else throw new Error('Unsupported Calc asset entry')
    }
  }
  await walk(root)
  return entries
}

function command(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`Calc extraction ${basename(file)} failed: ${result.error?.message ?? result.stderr}`)
}

export function verifyInventory(entries, expected) {
  const files = entries.filter(item => item.kind === 'file')
  if (files.length !== expected.fileCount || files.reduce((sum, item) => sum + item.bytes, 0) !== expected.logicalBytes
    || entries.filter(item => item.kind === 'link').length !== expected.symlinkCount) throw new Error('Incomplete Calc app extraction')
  const appRoot = expected.executable.split('/')[0]
  const notices = appRoot === 'LibreOffice'
    ? ['LICENSE.html', 'license.txt', 'NOTICE', 'readmes/readme_en-US.txt']
    : ['Contents/Resources/LICENSE', 'Contents/Resources/NOTICE', 'Contents/Resources/readmes/README_en-US']
  for (const name of [...notices, expected.executable.slice(appRoot.length + 1)]) {
    if (!files.some(item => item.path === name)) throw new Error(`Calc required asset missing: ${name}`)
  }
}

/** Builder copyDir retains files and links, creating only their parent directories. */
export function verifyReceiptInventory(current, expected, { allowPrunedEmptyDirectories = false } = {}) {
  if (!allowPrunedEmptyDirectories) {
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Calc cache contents changed')
    return
  }
  const expectedByPath = new Map(expected.map(item => [item.path, item]))
  const currentByPath = new Map(current.map(item => [item.path, item]))
  const nonEmptyDirectories = new Set()
  for (const item of expected) {
    if (item.kind === 'directory') continue
    let slash = item.path.lastIndexOf('/')
    while (slash >= 0) {
      nonEmptyDirectories.add(item.path.slice(0, slash))
      slash = item.path.lastIndexOf('/', slash - 1)
    }
  }
  for (const item of current) {
    if (JSON.stringify(item) !== JSON.stringify(expectedByPath.get(item.path))) throw new Error('Calc cache contents changed')
  }
  for (const item of expected) {
    if (currentByPath.has(item.path)) continue
    if (item.kind !== 'directory' || nonEmptyDirectories.has(item.path)) throw new Error('Calc cache contents changed')
  }
}

export async function prepareTarget(target, archiveDirectory, outputRoot) {
  const expected = manifest.targets[target]
  if (!expected || !target.startsWith(`${process.platform}-`) || (process.platform !== 'darwin' && target !== 'win32-x64')) throw new Error(`Native Calc extraction is not verified for ${target}`)
  const destination = join(outputRoot, target)
  let cached = false
  try { await lstat(destination); cached = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (cached) {
    return verifyPreparedTarget(target, outputRoot)
  }
  const archive = join(archiveDirectory, basename(new URL(expected.archive.url).pathname))
  await mkdir(archiveDirectory, { recursive: true })
  try { await lstat(archive) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const partial = archive + '.part'
    await download(expected.archive.url, partial)
    try { await verifyArchive(partial, expected.archive); await rename(partial, archive) }
    catch (error) { await rm(partial, { force: true }); throw error }
  }
  await verifyArchive(archive, expected.archive)
  await mkdir(outputRoot, { recursive: true })
  const staging = await mkdtemp(join(outputRoot, `${target}.staging-`))
  const mount = process.platform === 'darwin' ? await mkdtemp(join(tmpdir(), 'emate-calc-mount-')) : undefined
  const appRoot = expected.executable.split('/')[0]
  let mounted = false
  try {
    if (mount !== undefined) {
      // An interrupted attach may have mounted the image before returning an error.
      mounted = true
      command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, archive])
      command('/usr/bin/ditto', [join(mount, appRoot), join(staging, appRoot)])
      command('/usr/bin/hdiutil', ['detach', mount]); mounted = false
    } else {
      const extracted = join(staging, appRoot)
      await mkdir(extracted)
      command(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'msiexec.exe'),
        ['/a', archive, `TARGETDIR=${extracted}`, '/qn', '/norestart', '/L*v', join(staging, 'msiexec-admin-extract.log')])
    }
    const entries = await inventory(join(staging, appRoot))
    verifyInventory(entries, expected)
    const receipt = { schema: 1, target, version: manifest.version, archiveSha256: expected.archive.sha256, entries }
    await writeFile(join(staging, 'receipt.json'), JSON.stringify(receipt) + '\n', { flag: 'wx' })
    await rename(staging, destination)
    return receipt
  } finally {
    if (mounted) command('/usr/bin/hdiutil', ['detach', mount])
    if (mount !== undefined) await rm(mount, { recursive: true, force: true })
    await rm(staging, { recursive: true, force: true })
  }
}

export async function verifyPreparedTarget(target, outputRoot, { packaged = false } = {}) {
  const expected = manifest.targets[target]
  if (!expected) throw new Error(`Calc target has no verified manifest: ${target}`)
  const destination = join(outputRoot, target)
  const receipt = JSON.parse(await readFile(join(destination, 'receipt.json'), 'utf8'))
  if (receipt.schema !== 1 || receipt.target !== target || receipt.version !== manifest.version || receipt.archiveSha256 !== expected.archive.sha256) throw new Error('Calc cache archive identity mismatch')
  const current = await inventory(join(destination, expected.executable.split('/')[0]))
  verifyInventory(current, expected)
  verifyReceiptInventory(current, receipt.entries, { allowPrunedEmptyDirectories: packaged })
  return receipt
}

const fontSource = resolve(packageRoot, '../../packages/dsh-plugin-office-skills/skills/pdf/assets/noto-sans-sc')
const fontNames = ['NotoSansSC-Regular.ttf', 'SOURCE.json', 'OFL.txt', 'FONT-NOTICE.txt', 'REPRODUCE.md']
async function verifyFonts(destination) {
  await verifyArchive(join(destination, fontNames[0]), { bytes: 10596308, sha256: 'c7763f454946833081cc90e73186615f8e1189de9c5e5a5a8752871fd79fddbc' })
  for (const file of fontNames) if (await fileDigest(join(fontSource, file)) !== await fileDigest(join(destination, file))) throw new Error('Calc font cache changed')
}

async function prepareFonts(outputRoot) {
  await verifyFonts(fontSource)
  const destination = join(outputRoot, 'fonts')
  try {
    await lstat(destination)
    await verifyFonts(destination)
    return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    // Missing files in an existing cache are errors, not permission to overwrite it.
    try { await lstat(destination); throw new Error('Calc font cache is incomplete') } catch (missing) { if (missing.code !== 'ENOENT') throw missing }
  }
  const staging = await mkdtemp(join(outputRoot, 'fonts.staging-'))
  try {
    for (const file of fontNames) await copyFile(join(fontSource, file), join(staging, file))
    await rename(staging, destination)
  } finally { await rm(staging, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'archive-dir': { type: 'string' }, target: { type: 'string' }, 'verify-root': { type: 'string' }, packaged: { type: 'boolean' } } })
  const targets = values.target ? [values.target] : process.platform === 'darwin' ? ['darwin-arm64', 'darwin-x64'] : [`${process.platform}-${process.arch}`]
  for (const target of targets) {
    const receipt = values['verify-root'] ? await verifyPreparedTarget(target, resolve(values['verify-root']), { packaged: values.packaged })
      : await prepareTarget(target, resolve(values['archive-dir'] ?? join(packageRoot, 'build/calc-downloads')), join(packageRoot, 'build/calc-runtime'))
    process.stdout.write(`Calc ${receipt.target}: ${receipt.entries.length} verified entries\n`)
  }
  if (values['verify-root']) await verifyFonts(join(resolve(values['verify-root']), 'fonts'))
  else await prepareFonts(join(packageRoot, 'build/calc-runtime'))
}
