import JSZip from 'jszip'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PREVIEW_CHANNEL = '/emate.officePreview'
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const inside = (root: string, path: string) => { const p = relative(root, path); return p === '' || p !== '..' && !p.startsWith(`..${sep}`) && !isAbsolute(p) }
interface Binding {
  id: string; owner: string; sessionId: string; project: string; root: string; controller: AbortController
  active: boolean; closed: boolean; busy: boolean; touched: number
  cache: Map<string, { revision: string; png: string; prepared: any; versions: Record<string, string> }>
}

/** Transient view leases only. Source files and original native Jobs remain authoritative. */
export function createOfficePreview(ctx: any) {
  const bindings = new Map<string, Binding>()
  const restoring = new Map<string, { controller: AbortController; promise: Promise<Binding>; sessionId: string; owner: string }>()
  let generation = 0, disposed = false
  const owner = () => {
    const identity = ctx.emateIdentity.localAccountPrincipal()
    if (!identity?.tenantId || !identity?.userId) throw Object.assign(new Error('请先登录企业账号。'), { code: 'preview-unauthorized' })
    return hash(JSON.stringify([identity.tenantId, identity.userId]))
  }
  let knownOwner: string | undefined
  try { knownOwner = owner() } catch { /* Enterprise login may not be ready at injection. */ }
  const release = (binding: Binding) => { binding.active = false; binding.closed = true; binding.controller.abort(); binding.cache.clear() }
  const clear = () => { generation++; for (const pending of restoring.values()) pending.controller.abort(); restoring.clear(); for (const binding of bindings.values()) release(binding); bindings.clear() }
  const dispose = () => { disposed = true; clear() }
  const unauthorized = () => Object.assign(new Error('账号归属无法验证，原预览已关闭。请切回原账号。'), { code: 'preview-unauthorized' })
  const expired = () => Object.assign(new Error('无法验证原预览的任务归属，请在原账号和任务重新打开。'), { code: 'preview-expired' })
  function remember(binding: Binding) {
    for (const [id, item] of bindings) if (item.closed || Date.now() - item.touched > 30 * 60_000) { release(item); bindings.delete(id) }
    if (bindings.size >= 8) { const oldest = bindings.values().next().value!; release(oldest); bindings.delete(oldest.id) }
    bindings.set(binding.id, binding)
  }
  async function projectPath(root: string, path: unknown) {
    if (typeof path !== 'string' || !path || isAbsolute(path)) throw new Error('请选择当前工作区内的 PPT 项目。')
    const resolved = await realpath(join(root, path))
    if (!inside(root, resolved) || !(await lstat(resolved)).isDirectory()) throw new Error('PPT 项目超出工作区。')
    return resolved
  }
  async function check(binding: Binding, signal: AbortSignal) {
    signal.throwIfAborted()
    if (binding.owner !== owner()) { clear(); throw unauthorized() }
    const session = ctx.sessions.get(binding.sessionId)
    const workspace = ctx.workspaceRegistry.list().find((row: any) => row.sessionIds.includes(binding.sessionId))
    if (!session || !workspace || ctx.workspaceRegistry.archivedSessionIds.includes(binding.sessionId)
      || await realpath(workspace.path) !== binding.root || await realpath(session.header.cwd) !== binding.root
      || await projectPath(binding.root, relative(binding.root, binding.project) || '.') !== binding.project) {
      release(binding); throw Object.assign(new Error('会话与项目绑定已变化，请重新打开预览。'), { code: 'preview-expired' })
    }
    signal.throwIfAborted()
    if (disposed) throw expired()
    if (binding.owner !== owner()) { clear(); throw unauthorized() }
    binding.touched = Date.now()
    return session
  }
  async function restore(id: string, sessionId: string, signal: AbortSignal): Promise<Binding> {
    signal.throwIfAborted()
    const expected = owner(), epoch = generation
    const session = ctx.sessions.get(sessionId)
    if (disposed || !session || session.header.id !== sessionId || !Array.isArray(session.events)) throw expired()
    // Only the physical native Tool result and its paired call establish the project.
    // Renderer paths and assistant text are never recovery evidence.
    const result = session.events.find((event: any) => event.type === 'tool/result' && !event.data.error
      && event.data.meta?.operation === 'preview' && event.data.meta.preview?.kind === 'ppt-preview'
      && event.data.meta.preview.preview_id === id && event.data.meta.preview.session_id === sessionId)
    const blocks = result?.data.message?.content
    const block = Array.isArray(blocks) && blocks.length === 1 ? blocks[0] : undefined
    if (block?.type !== 'tool-result' || block.isError || !Number.isSafeInteger(result.data.turn) || result.data.turn < 1) throw expired()
    if (!ctx.emateAudit.ownsTask(sessionId, result.data.turn)) throw unauthorized()
    const call = session.events.find((event: any) => event.type === 'tool/call' && event.seq < result.seq
      && event.data.callId === block.toolCallId && event.data.name === 'office_read'
      && event.data.turn === result.data.turn && event.data.step === result.data.step)
    let args: any
    try { args = JSON.parse(call?.data.arguments) } catch { throw expired() }
    if (args?.operation !== 'preview') throw expired()
    const root = await realpath(session.header.cwd)
    const project = await projectPath(root, result.data.meta.preview.project_path)
    if (await projectPath(root, args.path) !== project) throw expired()
    const binding: Binding = { id, owner: expected, sessionId, project, root, controller: new AbortController(), active: false, closed: false, busy: false, touched: Date.now(), cache: new Map() }
    await check(binding, signal)
    signal.throwIfAborted()
    if (disposed || epoch !== generation || ctx.sessions.get(sessionId) !== session) throw expired()
    if (owner() !== expected || !ctx.emateAudit.ownsTask(sessionId, result.data.turn)) throw unauthorized()
    remember(binding)
    return binding
  }
  async function recover(id: string, sessionId: string, signal: AbortSignal) {
    let pending = restoring.get(id)
    if (pending && pending.sessionId !== sessionId) throw expired()
    if (!pending) {
      const expected = owner()
      const controller = new AbortController()
      const promise = restore(id, sessionId, AbortSignal.any([signal, controller.signal]))
        .finally(() => { if (restoring.get(id)?.controller === controller) restoring.delete(id) })
      pending = { controller, promise, sessionId, owner: expected }; restoring.set(id, pending)
    }
    let binding: Binding
    try { binding = await pending.promise } catch (error) { if (pending.owner !== owner()) throw unauthorized(); throw error }
    signal.throwIfAborted()
    if (binding.sessionId !== sessionId) throw expired()
    return binding
  }
  async function helper(binding: Binding, page: string, signal: AbortSignal, change?: unknown) {
    const python = ctx.shellEnv.collect({}).DSH_EMATE_PYTHON
    if (typeof python !== 'string' || !isAbsolute(python)) throw new Error('原生 Python 尚不可用。')
    const temporary = await mkdtemp(join(tmpdir(), 'emate-ppt-preview-'))
    try {
    const process = ctx.subprocess.spawn({ argv: [python, '-B', fileURLToPath(new URL('../assets/ppt-preview.py', import.meta.url))], cwd: binding.root,
      signal, graceMs: 3000, stdio: { stdin: { data: JSON.stringify({ project: binding.project, temporary, page, ...(change ? { change } : {}) }) },
        stdout: { maxBytes: 48 * 1024 * 1024 }, stderr: { maxBytes: 4096 } } })
    const result = await process.done
    const output = process.collected.stdout.readFrom(0)
    if (result.exitCode !== 0 || output.lossy) throw new Error(`PPT 页面处理失败：${process.collected.stderr.readFrom(0).text.slice(0, 1000)}`)
    signal.throwIfAborted()
    return JSON.parse(output.text)
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }
  async function dependencyVersions(binding: Binding, dependencies: Record<string, string>, verify = false) {
    const versions: Record<string, string> = {}
    for (const [name, digest] of Object.entries(dependencies)) {
      const requested = join(binding.project, name), path = await realpath(requested)
      if (!inside(binding.project, requested) || !inside(binding.project, path)) throw new Error('素材超出项目。')
      const stat = await lstat(path, { bigint: true })
      if (!stat.isFile() || stat.size > 32n * 1024n * 1024n) throw new Error('素材无效。')
      const stamp = (value: typeof stat) => [path, value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':')
      if (verify && (hash(await readFile(path)) !== digest || stamp(await lstat(path, { bigint: true })) !== stamp(stat)
        || await realpath(requested) !== path)) throw new Error('处理期间素材已变化，请刷新。')
      versions[name] = stamp(stat)
    }
    return versions
  }
  async function roster(binding: Binding) {
    const directory = join(binding.project, 'svg_output')
    const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!info) return []
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('页面目录无效。')
    const pages = (await readdir(directory)).filter(name => /^[\p{L}\p{N}\p{M}_ .()-]+\.svg$/u.test(name)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    if (pages.length > 100) throw new Error('预览最多支持 100 页。')
    return pages
  }
  return {
    dispose,
    changed() { let key: string | undefined; try { key = owner() } catch { /* Logged out or expired. */ }
      if (key !== knownOwner || [...bindings.values()].some(binding => binding.owner !== key) || [...restoring.values()].some(pending => pending.owner !== key)) { knownOwner = key; clear() }
    },
    async open(path: unknown, exec: any) {
      if (disposed) throw expired()
      const expected = owner(), epoch = generation, session = exec.agent?.session
      const sessionId = session?.header?.id
      if (typeof sessionId !== 'string' || ctx.sessions.get(sessionId) !== session) throw new Error('预览需要当前原生任务。')
      exec.signal.throwIfAborted()
      const root = await realpath(session.header.cwd)
      const project = await projectPath(root, path)
      const binding: Binding = { id: randomUUID(), owner: expected, sessionId, project, root, controller: new AbortController(), active: false, closed: false, busy: false, touched: Date.now(), cache: new Map() }
      await check(binding, exec.signal)
      const pages = await roster(binding)
      await check(binding, exec.signal)
      if (disposed || epoch !== generation || ctx.sessions.get(sessionId) !== session) throw expired()
      if (owner() !== expected) throw unauthorized()
      remember(binding)
      return { kind: 'ppt-preview', preview_id: binding.id, session_id: sessionId, project_path: relative(root, project) || '.', pages }
    },
    async call(action: string, payload: any, requestSignal = new AbortController().signal) {
      if (disposed) throw expired()
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !['roster', 'page', 'save', 'close'].includes(action)
        || typeof payload.preview_id !== 'string' || !payload.preview_id || payload.preview_id.length > 128
        || typeof payload.session_id !== 'string' || !payload.session_id || payload.session_id.length > 128) throw new Error('预览请求无效。')
      let binding = bindings.get(payload.preview_id)
      if (binding && binding.sessionId !== payload.session_id || restoring.has(payload.preview_id) && restoring.get(payload.preview_id)!.sessionId !== payload.session_id) throw expired()
      if (action === 'close') { if (binding) release(binding); restoring.get(payload.preview_id)?.controller.abort(); return {} }
      binding ??= await recover(payload.preview_id, payload.session_id, requestSignal)
      if (binding.busy) throw new Error('页面正在处理，请稍后重试。')
      if (!binding.active) { binding.controller = new AbortController(); binding.active = true; binding.closed = false }
      const signal = AbortSignal.any([requestSignal, binding.controller.signal, AbortSignal.timeout(45_000)])
      binding.busy = true
      try {
        const session = await check(binding, signal)
        const pages = await roster(binding)
        if (action === 'roster') return { pages }
        const page = payload.page
        if (typeof page !== 'string' || !pages.includes(page)) throw new Error('页面已变化，请刷新。')
        const target = await ctx.fs.resolve(join(binding.project, 'svg_output', page), { cwd: binding.root, signal })
        const before = await ctx.fs.stat(target, signal)
        if (!before) throw new Error('页面已移除。')
        let cached = binding.cache.get(page)
        if (cached && JSON.stringify(await dependencyVersions(binding, cached.prepared.dependencies)) !== JSON.stringify(cached.versions)) { binding.cache.delete(page); cached = undefined }
        const prepared = action === 'page' && cached ? cached.prepared : await helper(binding, page, signal)
        await check(binding, signal)
        if (action === 'save') {
          if (ctx.sandboxPolicy.resolve({ session }).mode === 'read-only') throw new Error('当前工作区只读。')
          if (payload.expected_revision !== prepared.revision) throw new Error('页面或素材已被修改，请重新载入；输入已保留。')
          const exports = join(binding.project, 'exports')
          const exported = await lstat(exports).catch(() => undefined)
          let hasExport = false
          if (exported?.isDirectory() && !exported.isSymbolicLink()) {
            for (const name of (await readdir(exports)).filter(name => name.endsWith('.pptx')).slice(0, 100)) {
              const path = join(exports, name), stat = await lstat(path)
              if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) continue
              try { const zip = await JSZip.loadAsync(await readFile(path)); if (zip.file('ppt/presentation.xml') && zip.file('[Content_Types].xml')) { hasExport = true; break } } catch {}
            }
          }
          if (!hasExport) throw new Error('请先完成一次 PPTX 导出，再提交修改。')
          const changed = await helper(binding, page, signal, payload.change)
          await check(binding, signal)
          if (changed.source_hash !== prepared.source_hash) throw new Error('页面已被修改，请重新载入。')
          if (typeof changed.content !== 'string') throw new Error('修改内容无效。')
          try { await ctx.fs.writeText(target, changed.content, { kind: 'replaceIfVersion', version: before.version }, signal) }
          catch { throw new Error('保存结果尚未确认，请重新载入源页面核对，不要重复提交。') }
          binding.cache.delete(page)
          return { saved: true, source_hash: hash(changed.content), instruction: `PPT 项目 ${relative(binding.root, binding.project) || '.'} 的 svg_output/${page} 已由用户保存修改（版本 ${hash(changed.content)}）。请先核对当前源版本；如果用户的元素注释存在，运行预置 check_annotations.py，按准确元素应用并记录 annotation_applied；接着执行原 canonical final --json 检查、finalize_svg 和原生 PPTX 导出。保留其余页面、模板、来源及未要求的内容，不要用图片生成替换可编辑 PPT。` }
        }
        if (action !== 'page') throw new Error('未知预览操作。')
        if (!cached || cached.revision !== prepared.revision) {
          const rendered = await ctx.desktopRuntime.renderSvgPage({ svg: prepared.svg, width: prepared.width, height: prepared.height, signal })
          await check(binding, signal)
          if (hash(await readFile(join(binding.project, 'svg_output', page))) !== prepared.source_hash) throw new Error('渲染期间页面已变化，请刷新。')
          if (rendered.png.length > 8 * 1024 * 1024) throw new Error('页面预览超过 8 MiB，请减小素材。')
          const versions = await dependencyVersions(binding, prepared.dependencies, true)
          const { svg: _svg, ...metadata } = prepared
          cached = { revision: prepared.revision, png: Buffer.from(rendered.png).toString('base64'), prepared: metadata, versions }
          // At most two rendered pages per open view, eight bindings total.
          if (binding.cache.size >= 2) binding.cache.delete(binding.cache.keys().next().value!)
          binding.cache.set(page, cached)
        }
        return { page, revision: prepared.revision, source_hash: prepared.source_hash, width: prepared.width, height: prepared.height, elements: prepared.elements,
          ...(payload.known_revision === cached.revision ? {} : { png: cached.png }) }
      } catch (error) { if (binding.owner !== owner()) throw unauthorized(); throw error }
      finally { binding.busy = false }
    },
  }
}
