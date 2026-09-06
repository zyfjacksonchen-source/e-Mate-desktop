import { constants } from 'node:fs'
import { mkdir, open, lstat, link, unlink, statfs, readdir, access } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, isAbsolute } from 'node:path'
import { Readable } from 'node:stream'

export const SHA256 = /^[a-f0-9]{64}$/u
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const activeTemporary = new Set<string>()
const STALE_TEMPORARY_MS = 15 * 60 * 1000
const TEMPORARY_NAME = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.zip$/u
export class ArchiveTooLarge extends Error { code = 'SHARE_ARCHIVE_TOO_LARGE' }
export function digest(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex') }

export class ArchiveFiles {
  root: string
  limit: number
  constructor(root: string, limit = MAX_UPLOAD_BYTES) {
    if (!isAbsolute(root) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_UPLOAD_BYTES) throw new Error('Invalid share volume')
    this.root = root
    this.limit = limit
  }
  async ready() {
    for (const directory of [this.root, join(this.root, 'tmp'), join(this.root, 'archives')]) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid share volume')
    }
  }
  async health() {
    for (const directory of [this.root, join(this.root, 'tmp'), join(this.root, 'archives')]) {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid share volume')
      await access(directory, constants.R_OK | constants.W_OK | constants.X_OK)
    }
    const space = await statfs(this.root)
    if (space.bavail * space.bsize < this.limit + 64 * 1024 * 1024) throw new Error('Share volume is full')
  }
  path(sha: string) {
    if (!SHA256.test(sha)) throw new Error('Invalid archive digest')
    return join(this.root, 'archives', `${sha}.zip`)
  }
  async stage(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
    const space = await statfs(this.root)
    if (space.bavail * space.bsize < this.limit + 64 * 1024 * 1024) throw new Error('Share volume is full')
    const temporary = join(this.root, 'tmp', `${randomUUID()}.zip`)
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    activeTemporary.add(temporary)
    const hash = createHash('sha256')
    let size = 0
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const abort = () => { void reader?.cancel(signal.reason).catch(() => {}) }
    try {
      reader = body.getReader()
      signal.addEventListener('abort', abort, { once: true })
      while (true) {
        signal.throwIfAborted()
        const chunk = await reader.read()
        signal.throwIfAborted()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > this.limit) throw new ArchiveTooLarge()
        hash.update(chunk.value)
        let offset = 0
        while (offset < chunk.value.byteLength) {
          const { bytesWritten } = await file.write(chunk.value, offset, chunk.value.byteLength - offset)
          if (!bytesWritten) throw new Error('Incomplete archive write')
          offset += bytesWritten
        }
      }
      if (size === 0) throw new ArchiveTooLarge()
      await file.sync()
      return { temporary, size, sha256: hash.digest('hex') }
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
      await reader?.cancel().catch(() => {})
      reader?.releaseLock()
      try { await file.close() } finally { activeTemporary.delete(temporary) }
    }
  }
  async publish(staged: { temporary: string; sha256: string; size: number }) {
    try { await link(staged.temporary, this.path(staged.sha256)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await this.verify(staged.sha256, staged.size)
    }
    const directory = await open(join(this.root, 'archives'), constants.O_RDONLY)
    try { await directory.sync() } finally { await directory.close() }
  }
  async read(sha: string, expectedSize: number) {
    const file = await open(this.path(sha), constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await file.stat()
    if (!info.isFile() || info.size !== expectedSize) { await file.close(); throw new Error('Archive integrity failure') }
    return Readable.toWeb(file.createReadStream({ autoClose: true })) as ReadableStream<Uint8Array>
  }
  async verify(sha: string, size: number) {
    const body = await this.read(sha, size)
    const hash = createHash('sha256')
    for await (const chunk of body) hash.update(chunk)
    if (hash.digest('hex') !== sha) throw new Error('Archive integrity failure')
  }
  async collectTemporary() {
    const cutoff = Date.now() - STALE_TEMPORARY_MS
    let removed = 0
    for (const name of await readdir(join(this.root, 'tmp'))) {
      if (!TEMPORARY_NAME.test(name)) continue
      const path = join(this.root, 'tmp', name)
      if (activeTemporary.has(path)) continue
      try {
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs > cutoff) continue
        // A fresh stat protects a file replaced/touched during enumeration.
        // UUID names never get reused by stage(), and its active set protects
        // live uploads even if their mtime is older than the crash grace period.
        const current = await lstat(path)
        if (activeTemporary.has(path) || !current.isFile() || current.isSymbolicLink()
          || current.dev !== info.dev || current.ino !== info.ino || current.mtimeMs !== info.mtimeMs
          || current.size !== info.size || current.mtimeMs > cutoff) continue
        await unlink(path)
        removed++
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return removed
  }
  async candidates() {
    return (await readdir(join(this.root, 'archives'))).filter(name => /^[a-f0-9]{64}\.zip$/u.test(name)).map(name => name.slice(0, -4))
  }
}
