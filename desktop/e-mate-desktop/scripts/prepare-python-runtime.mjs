/** Download the fixed Python bootstrap exposed to the rc.7 Vision component. */

import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
  if (process.platform === 'darwin') return ['darwin-arm64', 'darwin-x64']
  if (process.platform === 'win32' && process.arch === 'x64') return ['win32-x64']
  throw new Error(`e-Mate Python runtime is unsupported on ${process.platform}-${process.arch}`)
}

function pythonExecutable(targetRoot, platform) {
  return platform === 'win32'
    ? join(targetRoot, 'python', 'python.exe')
    : join(targetRoot, 'python', 'bin', 'python3')
}

function receipt(target, asset) {
  return JSON.stringify({ release: RELEASE, python: PYTHON_VERSION, target, sha256: asset.sha256 })
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
}
