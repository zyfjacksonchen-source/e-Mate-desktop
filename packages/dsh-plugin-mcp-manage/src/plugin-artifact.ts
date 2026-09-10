import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { OPTIONAL_UNIVER_PACKAGE, pluginPlatformSupported, validatePluginInstall, type PluginArtifactSource } from './plugin-source.ts'

const ARCHIVE_MAX_BYTES = 2 * 1024 * 1024 * 1024

async function cachedArchive(path: string, sha256: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  const before = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (before === undefined) return false
  if (!before.isFile() || before.size < 1 || before.size > ARCHIVE_MAX_BYTES) throw new Error('插件缓存必须是有效的常规归档文件。')
  const file = await open(path, 'r')
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('插件缓存文件在校验前已变更。')
    const hash = createHash('sha256'); let bytes = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted(); bytes += chunk.byteLength
      if (bytes > ARCHIVE_MAX_BYTES) throw new Error('插件归档超过大小上限。')
      hash.update(chunk)
    }
    const after = await lstat(path)
    signal?.throwIfAborted()
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino
      || bytes !== after.size || hash.digest('hex') !== sha256) throw new Error('插件缓存 SHA256 校验失败，未执行安装。')
    return true
  } finally { await file.close() }
}

/** Host-only cache below the native Harness home; no model or environment source override. */
export async function preparePluginArtifact(
  profileDir: string,
  source: PluginArtifactSource,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<string> {
  validatePluginInstall(OPTIONAL_UNIVER_PACKAGE, source)
  if (!pluginPlatformSupported(source)) throw new Error(`Univer Office 尚不支持当前平台 ${process.platform}-${process.arch}；仅支持 Apple Silicon macOS 和 x64 Windows。`)
  signal?.throwIfAborted()
  const artifact = source.artifact!
  // rc.7 resolveProfileDir is <DSH_HOME>/profiles/<name>. Keep downloads outside
  // the profile restored by DesktopPnpm's native install recovery snapshot.
  const cache = resolve(profileDir, '..', '..', 'e-mate', 'cache', 'plugin-artifacts')
  await mkdir(cache, { recursive: true, mode: 0o700 })
  const directory = await lstat(cache)
  if (!directory.isDirectory() || directory.isSymbolicLink()
    || process.platform !== 'win32' && (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0)) {
    throw new Error('插件缓存目录必须仅由当前 Host 用户访问。')
  }
  const target = join(cache, `${artifact.sha256}.tgz`)
  if (await cachedArchive(target, artifact.sha256, signal)) return target
  const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10 * 60_000)])
  const temporary = join(cache, `.${artifact.sha256}-${randomBytes(12).toString('hex')}.part`)
  let file: Awaited<ReturnType<typeof open>> | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const cancelRead = () => { void reader?.cancel(combined.reason).catch(() => {}) }
  combined.addEventListener('abort', cancelRead, { once: true })
  try {
    const response = await request(artifact.url, { redirect: 'error', signal: combined })
    combined.throwIfAborted()
    if (!response.ok || response.body === null) throw new Error('插件归档下载失败。')
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > ARCHIVE_MAX_BYTES) throw new Error('插件归档超过大小上限。')
    reader = response.body.getReader()
    file = await open(temporary, 'wx', 0o600)
    const hash = createHash('sha256'); let bytes = 0
    while (true) {
      combined.throwIfAborted()
      const item = await reader.read()
      combined.throwIfAborted()
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > ARCHIVE_MAX_BYTES) throw new Error('插件归档超过大小上限。')
      hash.update(item.value)
      await file.writeFile(item.value)
    }
    if (bytes === 0 || hash.digest('hex') !== artifact.sha256) throw new Error('插件归档 SHA256 校验失败，未执行安装。')
    await file.sync(); await file.close(); file = undefined
    combined.throwIfAborted()
    await rename(temporary, target)
    signal?.throwIfAborted()
    return target
  } finally {
    combined.removeEventListener('abort', cancelRead)
    await reader?.cancel().catch(() => {})
    await file?.close()
    await rm(temporary, { force: true })
  }
}
