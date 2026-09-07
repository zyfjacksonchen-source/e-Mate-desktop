/** Desktop build-time extraction. No system installation or runtime download. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
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

/** Inventory all bytes/modes/links; reject links escaping the retained app. */
export async function inventory(root) {
  const entries = []
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), stat = await lstat(path)
      const item = { path: relative(root, path).split('\\').join('/'), mode: stat.mode & 0o777 }
      if (stat.isSymbolicLink()) {
        const target = await readlink(path)
        const outside = relative(root, resolve(dirname(path), target))
        if (isAbsolute(target) || outside === '..' || outside.startsWith('../') || isAbsolute(outside)) throw new Error('Calc asset link escapes its app')
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

function verifyInventory(entries, expected) {
  const files = entries.filter(item => item.kind === 'file')
  if (files.length !== expected.fileCount || files.reduce((sum, item) => sum + item.bytes, 0) !== expected.logicalBytes
    || entries.filter(item => item.kind === 'link').length !== expected.symlinkCount) throw new Error('Incomplete Calc app extraction')
  for (const name of ['Contents/Resources/LICENSE', 'Contents/Resources/NOTICE', 'Contents/Resources/readmes/README_en-US', expected.executable.replace('LibreOffice.app/', '')]) {
    if (!files.some(item => item.path === name)) throw new Error(`Calc required asset missing: ${name}`)
  }
}

export async function prepareTarget(target, archiveDirectory, outputRoot) {
  const expected = manifest.targets[target]
  if (!expected || process.platform !== 'darwin' || !target.startsWith('darwin-')) throw new Error(`Native Calc extraction is not verified for ${target}`)
  const destination = join(outputRoot, target)
  let cached = false
  try { await lstat(destination); cached = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (cached) {
    const receipt = JSON.parse(await readFile(join(destination, 'receipt.json'), 'utf8'))
    if (receipt.archiveSha256 !== expected.archive.sha256) throw new Error('Calc cache archive identity mismatch')
    const current = await inventory(join(destination, 'LibreOffice.app'))
    verifyInventory(current, expected)
    if (JSON.stringify(current) !== JSON.stringify(receipt.entries)) throw new Error('Calc cache contents changed')
    return receipt
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
  const mount = await mkdtemp(join(tmpdir(), 'emate-calc-mount-'))
  let mounted = false
  try {
    // An interrupted attach may have mounted the image before returning an error.
    mounted = true
    command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, archive])
    command('/usr/bin/ditto', [join(mount, 'LibreOffice.app'), join(staging, 'LibreOffice.app')])
    command('/usr/bin/hdiutil', ['detach', mount]); mounted = false
    const entries = await inventory(join(staging, 'LibreOffice.app'))
    verifyInventory(entries, expected)
    const receipt = { schema: 1, target, version: manifest.version, archiveSha256: expected.archive.sha256, entries }
    await writeFile(join(staging, 'receipt.json'), JSON.stringify(receipt) + '\n', { flag: 'wx' })
    await rename(staging, destination)
    return receipt
  } finally {
    if (mounted) command('/usr/bin/hdiutil', ['detach', mount])
    await rm(mount, { recursive: true, force: true })
    await rm(staging, { recursive: true, force: true })
  }
}

async function prepareFonts(outputRoot) {
  const source = resolve(packageRoot, '../../packages/dsh-plugin-office-skills/skills/pdf/assets/noto-sans-sc')
  const name = 'NotoSansSC-Regular.ttf'
  await verifyArchive(join(source, name), { bytes: 10596308, sha256: 'c7763f454946833081cc90e73186615f8e1189de9c5e5a5a8752871fd79fddbc' })
  const names = [name, 'SOURCE.json', 'OFL.txt', 'FONT-NOTICE.txt', 'REPRODUCE.md']
  const destination = join(outputRoot, 'fonts')
  try {
    await lstat(destination)
    for (const file of names) if (await fileDigest(join(source, file)) !== await fileDigest(join(destination, file))) throw new Error('Calc font cache changed')
    return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    // Missing files in an existing cache are errors, not permission to overwrite it.
    try { await lstat(destination); throw new Error('Calc font cache is incomplete') } catch (missing) { if (missing.code !== 'ENOENT') throw missing }
  }
  const staging = await mkdtemp(join(outputRoot, 'fonts.staging-'))
  try {
    for (const file of names) await copyFile(join(source, file), join(staging, file))
    await rename(staging, destination)
  } finally { await rm(staging, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'archive-dir': { type: 'string' }, target: { type: 'string' } } })
  const targets = values.target ? [values.target] : ['darwin-arm64', 'darwin-x64']
  for (const target of targets) {
    const receipt = await prepareTarget(target, resolve(values['archive-dir'] ?? join(packageRoot, 'build/calc-downloads')), join(packageRoot, 'build/calc-runtime'))
    process.stdout.write(`Calc ${receipt.target}: ${receipt.entries.length} verified entries\n`)
  }
  await prepareFonts(join(packageRoot, 'build/calc-runtime'))
}
