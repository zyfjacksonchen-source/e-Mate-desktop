/** Download the fixed Python bootstrap exposed to the rc.7 Vision component. */

import { createHash } from 'node:crypto'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const RELEASE = '20260814'
const PYTHON_VERSION = '3.12.14'
const DOWNLOAD_ATTEMPTS = 3
const TRANSIENT_DOWNLOAD_CODES = new Set([
  'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETDOWN', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT',
  'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
])
const ASSETS = {
  'darwin-arm64': {
    target: 'aarch64-apple-darwin',
    sha256: 'dd5b76ab11451a4a4367c17c61d944dded56b425396b07f102922a7ebef7d55f',
  },
  'darwin-x64': {
    target: 'x86_64-apple-darwin',
    sha256: 'aec265e3cddaccdb2a3d783331596351b24d4a63c97af0a38f75f643c9451de9',
  },
  'win32-x64': {
    target: 'x86_64-pc-windows-msvc',
    sha256: '89f18f6932917163b74339ebcec2645c8e47ae7f1c5f2ac37f2b4f4cf3beb647',
  },
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const outputRoot = join(packageRoot, 'build', 'python-runtime')

function targetsForHost() {
  if (process.platform === 'darwin') return [`darwin-${process.arch}`, `darwin-${process.arch === 'arm64' ? 'x64' : 'arm64'}`]
  if (process.platform === 'win32' && process.arch === 'x64') return ['win32-x64']
  throw new Error(`e-Mate Python runtime is unsupported on ${process.platform}-${process.arch}`)
}

function pythonExecutable(targetRoot, platform) {
  return platform === 'win32'
    ? join(targetRoot, 'python', 'python.exe')
    : join(targetRoot, 'python', 'bin', 'python3')
}

function receipt(target, asset) {
  officeNotices() // Validate the source notices even when the prepared runtime is reused.
  return JSON.stringify({ release: RELEASE, python: PYTHON_VERSION, target, sha256: asset.sha256,
    officeRequirementsSha256: sha256(join(packageRoot, 'scripts', 'office-python', `${target}.txt`)),
    officeManifestSha256: sha256(join(packageRoot, 'scripts', 'office-python', 'manifest.json')) })
}

function officeNotices() {
  const root = join(packageRoot, 'scripts', 'office-python')
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  return manifest.supplementalNotices.map(({ filename, sha256: expected }) => {
    if (basename(filename) !== filename) throw new Error('Invalid office notice filename')
    const bytes = readFileSync(join(root, 'notices', filename))
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Office notice SHA-256 mismatch: ${filename}`)
    return { filename, bytes }
  })
}

export function installOfficeNotices(staging) {
  const destination = join(staging, 'office-notices')
  mkdirSync(destination, { recursive: true })
  for (const { filename, bytes } of officeNotices()) {
    writeFileSync(join(destination, filename), bytes, { mode: 0o644, flag: 'wx' })
  }
}

function officeSitePackages(staging, platform) {
  return join(staging, 'python', ...(platform === 'win32' ? ['Lib', 'site-packages'] : ['lib', 'python3.12', 'site-packages']))
}

const OFFICE_VERIFY_SCRIPT = `import importlib.metadata as metadata,json,sys
expected=json.loads(sys.argv[1])
normalize=lambda name:name.lower().replace('_','-').replace('.','-')
installed={normalize(d.metadata['Name']):d for d in metadata.distributions(path=[sys.argv[2]])}
verified={}
for name,spec in expected.items():
 d=installed[normalize(name)]
 assert d.version==spec['version'],(name,d.version,spec['version'])
 files=list(d.files or [])
 for license_file in spec['license_files']:
  matches=[f for f in files if str(f)==license_file or str(f).endswith('/'+license_file)]
  assert matches and all(d.locate_file(f).is_file() for f in matches),(name,'missing license',license_file)
 verified[name]={'version':d.version,'license_files':len(spec['license_files'])}
if sys.argv[3]=='native':
 sys.path.insert(0,sys.argv[2])
 import reportlab,pypdf,pdfplumber,openpyxl,PIL.Image,pypdfium2
 import pptx,xlsxwriter,lxml.etree,pathops,uharfbuzz,yaml,typing_extensions
print(json.dumps({'distributions':verified,'native_imports':sys.argv[3]=='native'},sort_keys=True))
`

export function officeInstallArguments(target, staging) {
  const platform = target.startsWith('win32-') ? 'win32' : 'darwin'
  const wheelPlatform = { 'darwin-arm64': 'macosx_12_0_arm64', 'darwin-x64': 'macosx_12_0_x86_64', 'win32-x64': 'win_amd64' }[target]
  if (wheelPlatform === undefined) throw new Error('Unsupported office Python target')
  return ['-I', '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check',
    '--no-deps', '--no-index', '--no-compile', '--only-binary=:all:', '--require-hashes',
    '--platform', wheelPlatform, '--implementation', 'cp', '--python-version', '3.12', '--abi', 'cp312',
    '--target', officeSitePackages(staging, platform),
    '-r', join(packageRoot, 'scripts', 'office-python', `${target}.txt`)]
}

export async function download(url, destination, request = fetch) {
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await request(url, { redirect: 'follow' })
      if (!response.ok || response.body === null) {
        throw new Error(`Python runtime download failed with HTTP ${response.status}`)
      }
      await pipeline(response.body, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
      return
    } catch (cause) {
      rmSync(destination, { force: true })
      const code = cause?.code ?? cause?.cause?.code
      if (attempt === DOWNLOAD_ATTEMPTS || !TRANSIENT_DOWNLOAD_CODES.has(code)) throw cause
    }
  }
}

function sha256(filename) {
  return createHash('sha256').update(readFileSync(filename)).digest('hex')
}

/** Source and build materials travel inside the same existing Python resource volume. */
export async function prepareOfficeSources(destination = join(outputRoot, 'office-sources'), request = fetch) {
  const sourceRoot = join(packageRoot, 'scripts', 'office-python', 'source-companion')
  const manifestBytes = readFileSync(join(sourceRoot, 'manifest.json'))
  const manifest = JSON.parse(manifestBytes)
  const valid = (root, file) => {
    try {
      const bytes = readFileSync(join(root, file.distribution_path))
      return bytes.length === file.bytes && createHash('sha256').update(bytes).digest('hex') === file.sha256
    } catch { return false }
  }
  if (existsSync(join(destination, 'manifest.json'))
    && readFileSync(join(destination, 'manifest.json')).equals(manifestBytes)
    && manifest.files.every(file => valid(destination, file))) return
  const staging = `${destination}.staging-${process.pid}-${Date.now()}`
  mkdirSync(staging, { recursive: true })
  try {
    for (const file of manifest.files) {
      const output = join(staging, file.distribution_path)
      mkdirSync(dirname(output), { recursive: true })
      if (file.role !== 'original-source-archive') {
        copyFileSync(join(sourceRoot, file.distribution_path), output)
      } else if (valid(destination, file)) {
        copyFileSync(join(destination, file.distribution_path), output)
      } else {
        await download(file.url, output, request)
      }
      if (!valid(staging, file)) throw new Error(`Office source SHA-256 or size mismatch: ${file.distribution_path}`)
    }
    writeFileSync(join(staging, 'manifest.json'), manifestBytes, { mode: 0o644 })
    rmSync(destination, { recursive: true, force: true })
    renameSync(staging, destination)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

async function prepare(target) {
  const asset = ASSETS[target]
  const finalRoot = join(outputRoot, target)
  const receiptPath = join(finalRoot, 'receipt.json')
  const platform = target.startsWith('win32-') ? 'win32' : 'darwin'
  const expectedReceipt = receipt(target, asset)
  if (existsSync(pythonExecutable(finalRoot, platform))
    && existsSync(receiptPath)
    && readFileSync(receiptPath, 'utf8') === expectedReceipt) return

  mkdirSync(outputRoot, { recursive: true })
  const nonce = `${process.pid}-${Date.now()}`
  const archive = join(outputRoot, `.${target}-${nonce}.tar.gz`)
  const staging = join(outputRoot, `.${target}-${nonce}`)
  const name = `cpython-${PYTHON_VERSION}+${RELEASE}-${asset.target}-install_only_stripped.tar.gz`
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/${encodeURIComponent(name)}`
  try {
    console.log(`Preparing fixed Python runtime: ${target}`)
    await download(url, archive)
    const actual = sha256(archive)
    if (actual !== asset.sha256) throw new Error(`Python runtime SHA-256 mismatch for ${target}`)
    mkdirSync(staging, { recursive: true })
    const unpack = spawnSync('tar', ['-xzf', basename(archive), '-C', basename(staging)], {
      cwd: outputRoot,
      stdio: 'inherit',
    })
    if (unpack.error !== undefined) throw unpack.error
    if (unpack.status !== 0) throw new Error(`tar exited with ${String(unpack.status)} for ${target}`)
    if (!existsSync(pythonExecutable(staging, platform))) {
      throw new Error(`Python runtime archive for ${target} is missing its interpreter`)
    }
    const hostPython = target === `${process.platform}-${process.arch}`
      ? pythonExecutable(staging, platform)
      : pythonExecutable(join(outputRoot, `${process.platform}-${process.arch}`), process.platform)
    const install = spawnSync(hostPython, officeInstallArguments(target, staging), { stdio: 'inherit' })
    if (install.error !== undefined) throw install.error
    if (install.status !== 0) throw new Error(`Office dependency installation failed for ${target}`)
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'scripts', 'office-python', 'manifest.json'), 'utf8'))
    const expectedPackages = Object.fromEntries(manifest.targets[target].map(({ name, version, license_files }) => [name, { version, license_files }]))
    const probe = spawnSync(hostPython, ['-I', '-c', OFFICE_VERIFY_SCRIPT,
      JSON.stringify(expectedPackages), officeSitePackages(staging, platform),
      target === `${process.platform}-${process.arch}` ? 'native' : 'metadata'], { stdio: 'inherit' })
    if (probe.error !== undefined) throw probe.error
    if (probe.status !== 0) throw new Error(`Office dependency verification failed for ${target}`)
    installOfficeNotices(staging)
    writeFileSync(join(staging, 'receipt.json'), expectedReceipt, { mode: 0o644 })
    rmSync(finalRoot, { recursive: true, force: true })
    renameSync(staging, finalRoot)
  } finally {
    rmSync(archive, { force: true })
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { target: { type: 'string', multiple: true } },
  })
  const hostTargets = targetsForHost()
  const targets = values.target ?? hostTargets
  if (targets.length === 0 || new Set(targets).size !== targets.length
    || targets.some(target => !hostTargets.includes(target))) {
    throw new Error(`e-Mate Python runtime target is unsupported on ${process.platform}-${process.arch}`)
  }
  for (const target of targets) await prepare(target)
  await prepareOfficeSources()
}
