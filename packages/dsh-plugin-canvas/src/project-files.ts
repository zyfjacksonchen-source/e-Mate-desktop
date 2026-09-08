import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { CanvasError, identifier, MAX_PROJECT_BYTES, reject, sessionId, validateProject, type CanvasProject, type ProjectReceipt } from './contract.ts'

export interface WorkspaceContext {
  workspaceRegistry: { archivedSessionIds: readonly string[]; list(): readonly { path: string; sessionIds: readonly string[] }[] }
}
export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const inside = (root: string, path: string): boolean => { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) }

export async function workspaceRoot(ctx: WorkspaceContext, id: string): Promise<string> {
  sessionId(id)
  if (ctx.workspaceRegistry.archivedSessionIds.includes(id)) reject('已归档会话不能访问画布。', 'scope')
  const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(id))
  if (!workspace) reject('当前会话没有绑定工作区。', 'scope')
  const root = await realpath(workspace!.path)
  if (!(await lstat(root)).isDirectory()) reject('工作区不可用。', 'scope')
  return root
}
export async function canvasDirectory(root: string, create = false, owner?: string): Promise<string> {
  let current = root
  for (const part of ['.e-mate', 'canvas', ...(owner === undefined ? [] : ['sessions', sha256(sessionId(owner))])]) {
    const path = join(current, part)
    if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory()) reject('画布目录不能使用符号链接。', 'scope')
    current = await realpath(path)
    if (!inside(root, current)) reject('画布目录越出工作区。', 'scope')
  }
  return current
}
async function assertDirectory(root: string, directory: string, owner?: string): Promise<void> {
  if (await canvasDirectory(root, false, owner) !== directory) reject('画布目录已变化。', 'conflict')
}
export async function readRegular(path: string, limit = MAX_PROJECT_BYTES): Promise<Buffer | undefined> {
  let handle
  try {
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.size > limit) reject('画布文件类型或大小无效。', 'corrupt')
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat()
    if (opened.ino !== before.ino || opened.dev !== before.dev) reject('画布文件已变化。', 'conflict')
    const bytes = await handle.readFile()
    if (bytes.byteLength > limit) reject('画布文件超出限制。', 'corrupt')
    return bytes
  } catch (error) { if (missing(error)) return undefined; throw error }
  finally { await handle?.close() }
}
// Writes are owned by pinned ctx.fs: its target identity, expected version and atomic fsync path.
export interface NativeFiles {
  resolve(path: string, options: { cwd: string }): Promise<{ targetKey: unknown; displayPath: string }>
  processPath(target: { targetKey: unknown; displayPath: string }): string
  stat(target: { targetKey: unknown; displayPath: string }): Promise<{ type: string; version: unknown } | undefined>
  writeText(target: { targetKey: unknown; displayPath: string }, content: string, expected: unknown): Promise<unknown>
}
async function targetFile(fs: NativeFiles, root: string, directory: string, name: string, owner?: string) {
  await assertDirectory(root, directory, owner)
  const absolute = join(directory, name)
  const prior = await lstat(absolute).catch(error => { if (missing(error)) return undefined; throw error })
  if (prior && (!prior.isFile() || prior.isSymbolicLink())) reject('画布文件不能使用符号链接。', 'scope')
  const target = await fs.resolve(absolute, { cwd: root })
  if (fs.processPath(target) !== absolute || !inside(root, fs.processPath(target))) reject('画布文件越出工作区。', 'scope')
  return target
}
async function atomic(fs: NativeFiles, root: string, directory: string, name: string, bytes: Uint8Array, owner?: string) {
  const target = await targetFile(fs, root, directory, name, owner)
  const existing = await fs.stat(target)
  return await fs.writeText(target, new TextDecoder('utf-8', { fatal: true }).decode(bytes), existing
    ? { kind: 'replaceIfVersion', version: existing.version } : { kind: 'createIfAbsent' })
}
function parse(bytes: Buffer, id: string): CanvasProject {
  try {
    const document = validateProject(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    if (document.id !== id) reject('画布项目身份不一致。', 'corrupt')
    return document
  } catch { return reject('画布文件损坏，未覆盖原文件。', 'corrupt') }
}
export async function loadProject(root: string, id: string, owner?: string): Promise<ProjectReceipt | null> {
  identifier(id)
  let directory
  try { directory = await canvasDirectory(root, false, owner) } catch (error) { if (missing(error)) return null; throw error }
  const primary = await readRegular(join(directory, `${id}.json`))
  if (primary) {
    try { return { project: parse(primary, id), revision: sha256(primary), recovered: false } }
    catch (error) { if (!(error instanceof CanvasError) || error.code !== 'corrupt') throw error }
  }
  const backup = await readRegular(join(directory, `${id}.backup.json`))
  if (backup) return { project: parse(backup, id), revision: primary ? sha256(primary) : '', recovered: true }
  if (primary) reject('画布及备份均不可恢复，原文件已保留。', 'corrupt')
  return null
}
export async function saveProject(fs: NativeFiles, root: string, value: unknown, expectedRevision: string | null, owner?: string): Promise<ProjectReceipt> {
  const project = validateProject(value)
  if (expectedRevision !== null && expectedRevision !== '' && !/^[0-9a-f]{64}$/u.test(expectedRevision)) reject('保存版本无效。')
  const directory = await canvasDirectory(root, true, owner)
  const target = await targetFile(fs, root, directory, `${project.id}.json`, owner)
  const observed = await fs.stat(target)
  const current = await readRegular(join(directory, `${project.id}.json`))
  if ((current ? sha256(current) : null) !== (expectedRevision === '' ? null : expectedRevision)) reject('画布已在其他窗口修改。请重新载入或另存副本。', 'conflict')
  if (current) {
    let valid = true
    try { parse(current, project.id) } catch { valid = false }
    if (valid) await atomic(fs, root, directory, `${project.id}.backup.json`, current, owner)
    // Preserve corrupt bytes for diagnosis, retaining the valid backup.
    else await atomic(fs, root, directory, `${project.id}.corrupt-${sha256(current)}.json`, current, owner)
  }
  const bytes = Buffer.from(JSON.stringify(project) + '\n')
  await assertDirectory(root, directory, owner)
  try {
    await fs.writeText(target, bytes.toString('utf8'), observed ? { kind: 'replaceIfVersion', version: observed.version } : { kind: 'createIfAbsent' })
  } catch (error) {
    if (['FS_STALE_VERSION', 'FS_NOT_OBSERVED'].includes((error as { code?: string }).code ?? '')) reject('画布已变化，请重新载入或另存副本。', 'conflict')
    throw error
  }
  const saved = await readRegular(join(directory, `${project.id}.json`))
  if (!saved?.equals(bytes)) reject('画布保存后发生变化，请重新载入。', 'conflict')
  return { project, revision: sha256(bytes), recovered: false }
}
export async function listProjects(root: string, owner?: string): Promise<readonly { id: string; title: string; recovered: boolean; error?: string }[]> {
  let directory
  try { directory = await canvasDirectory(root, false, owner) } catch (error) { if (missing(error)) return []; throw error }
  const ids = [...new Set((await readdir(directory)).map(name => /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\.backup)?\.json$/u.exec(name)?.[1]).filter((id): id is string => id !== undefined))].sort()
  if (ids.length > 200) reject('画布项目超过 200 个，请先整理工作区。')
  return await Promise.all(ids.map(async id => {
    try { const result = await loadProject(root, id, owner); return { id, title: result?.project.title ?? id, recovered: result?.recovered ?? false } }
    catch { return { id, title: id, recovered: false, error: '项目损坏或无法读取，原文件已保留。' } }
  }))
}
