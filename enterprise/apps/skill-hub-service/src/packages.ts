import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, lstat, readdir, realpath, rename, rm, statfs } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { inspectSkillArchive } from '../../skill-hub-worker/src/core.ts'
import type { HubPackages, PackageMetadata } from '../../skill-hub-worker/src/ports.ts'

const MAX_BYTES = 10 * 1024 * 1024
export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY)
  try { await directory.sync() } finally { await directory.close() }
}
export async function readRegular(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum) throw new Error('Invalid Skill Hub file')
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    const after = await file.stat()
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
      throw new Error('Skill Hub file changed during read')
    }
    return bytes.subarray(0, offset)
  } finally { await file.close() }
}

export class FilePackages implements HubPackages {
  readonly directory: string
  readonly minimumFreeBytes: number
  constructor(directory: string, minimumFreeBytes = 64 * 1024 * 1024) {
    if (!isAbsolute(directory) || !Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 0) throw new Error('Invalid package volume')
    this.directory = directory
    this.minimumFreeBytes = minimumFreeBytes
  }
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (await realpath(this.directory) !== this.directory) throw new Error('Package volume cannot be a symlink')
    await mkdir(join(this.directory, '.tmp'), { recursive: true, mode: 0o700 })
  }
  private digest(key: string): string {
    const match = /^packages\/([a-f0-9]{64})\.zip$/.exec(key)
    if (!match) throw new Error('Invalid package key')
    return match[1]!
  }
  async ready(requiredBytes = 0): Promise<void> {
    const disk = await statfs(this.directory, { bigint: true })
    if (disk.bavail * disk.bsize < BigInt(this.minimumFreeBytes + requiredBytes)) throw new Error('Package volume is full')
  }
  private async read(key: string): Promise<{ metadata: PackageMetadata; bytes: Buffer } | null> {
    const digest = this.digest(key)
    const directory = join(this.directory, digest)
    try {
      const stat = await lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid package directory')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const metadata = JSON.parse((await readRegular(join(directory, 'metadata.json'), 8192)).toString('utf8')) as PackageMetadata
    const bytes = await readRegular(join(directory, 'archive.zip'), MAX_BYTES)
    if (metadata.key !== key || metadata.size !== bytes.length || metadata.customMetadata?.package_sha256 !== digest ||
        metadata.customMetadata.archive_sha256 !== sha256(bytes)) throw new Error('Package storage integrity failed')
    const inspected = await inspectSkillArchive(bytes)
    if (inspected.packageSha256 !== digest) throw new Error('Package content integrity failed')
    return { metadata, bytes }
  }
  async head(key: string): Promise<PackageMetadata | null> { return (await this.read(key))?.metadata ?? null }
  async get(key: string) {
    const value = await this.read(key)
    return value ? { ...value.metadata, body: new Blob([new Uint8Array(value.bytes)]).stream() } : null
  }
  async put(key: string, bytes: Uint8Array, options: Omit<PackageMetadata, 'key' | 'size'>): Promise<PackageMetadata> {
    const digest = this.digest(key)
    const inspected = await inspectSkillArchive(bytes)
    if (bytes.length > MAX_BYTES || inspected.packageSha256 !== digest || options.customMetadata?.package_sha256 !== digest ||
        options.customMetadata.archive_sha256 !== sha256(bytes)) throw new Error('Invalid package storage identity')
    const metadata: PackageMetadata = { ...options, key, size: bytes.byteLength }
    const previous = await this.head(key)
    if (previous) {
      if (previous.customMetadata?.archive_sha256 !== metadata.customMetadata?.archive_sha256 || previous.size !== metadata.size) {
        throw new Error('Immutable package already exists')
      }
      return previous
    }
    await this.ready(bytes.length * 2 + 8192)
    const temporary = join(this.directory, '.tmp', randomUUID())
    await mkdir(temporary, { mode: 0o700 })
    try {
      for (const [name, content] of [['archive.zip', bytes], ['metadata.json', Buffer.from(JSON.stringify(metadata))]] as const) {
        const file = await open(join(temporary, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
        try { await file.writeFile(content); await file.sync() } finally { await file.close() }
      }
      await syncDirectory(temporary)
      try { await rename(temporary, join(this.directory, digest)) } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
      await syncDirectory(this.directory)
      const stored = await this.head(key)
      if (!stored || stored.customMetadata?.archive_sha256 !== metadata.customMetadata?.archive_sha256) throw new Error('Package write readback failed')
      return stored
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }
  async list(options: { limit?: number } = {}) {
    const names = (await readdir(this.directory)).filter((name) => /^[a-f0-9]{64}$/.test(name)).sort()
    const selected = names.slice(0, options.limit ?? names.length)
    const objects: PackageMetadata[] = []
    for (const name of selected) {
      const metadata = await this.head(`packages/${name}.zip`)
      if (!metadata) throw new Error('Package inventory changed')
      objects.push(metadata)
    }
    return { objects, truncated: selected.length < names.length }
  }
}
