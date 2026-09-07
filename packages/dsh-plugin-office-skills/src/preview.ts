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
  const owner = () => {
    const identity = ctx.emateIdentity.localAccountPrincipal()
    if (!identity?.tenantId || !identity?.userId) throw new Error('请先登录企业账号。')
    return hash(JSON.stringify([identity.tenantId, identity.userId]))
  }
  const release = (binding: Binding) => { binding.active = false; binding.closed = true; binding.controller.abort(); binding.cache.clear() }
  const dispose = () => { for (const binding of bindings.values()) release(binding); bindings.clear() }
  async function projectPath(root: string, path: unknown) {
    if (typeof path !== 'string' || !path || isAbsolute(path)) throw new Error('请选择当前工作区内的 PPT 项目。')
    const resolved = await realpath(join(root, path))
    if (!inside(root, resolved) || !(await lstat(resolved)).isDirectory()) throw new Error('PPT 项目超出工作区。')
    return resolved
  }
  async function check(binding: Binding, signal: AbortSignal) {
    signal.throwIfAborted()
    if (binding.owner !== owner()) { dispose(); throw Object.assign(new Error('账号已变化，请重新打开预览。'), { code: 'preview-expired' }) }
    const session = ctx.sessions.get(binding.sessionId)
    const workspace = ctx.workspaceRegistry.list().find((row: any) => row.sessionIds.includes(binding.sessionId))
    if (!session || !workspace || ctx.workspaceRegistry.archivedSessionIds.includes(binding.sessionId)
      || await realpath(workspace.path) !== binding.root || await realpath(session.header.cwd) !== binding.root
      || await projectPath(binding.root, relative(binding.root, binding.project) || '.') !== binding.project) {
      release(binding); throw Object.assign(new Error('会话与项目绑定已变化，请重新打开预览。'), { code: 'preview-expired' })
    }
    binding.touched = Date.now()
    return session
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
    changed() { let key: string; try { key = owner() } catch { dispose(); return }
      if ([...bindings.values()].some(binding => binding.owner !== key)) dispose()
    },
    async open(path: unknown, exec: any) {
      const sessionId = exec.agent?.session?.header?.id
      if (typeof sessionId !== 'string') throw new Error('预览需要当前原生任务。')
      const root = await realpath(exec.agent.session.header.cwd)
      const project = await projectPath(root, path)
      for (const [id, item] of bindings) if (item.closed || Date.now() - item.touched > 30 * 60_000) { release(item); bindings.delete(id) }
      if (bindings.size >= 8) { const oldest = bindings.values().next().value!; release(oldest); bindings.delete(oldest.id) }
      const binding: Binding = { id: randomUUID(), owner: owner(), sessionId, project, root, controller: new AbortController(), active: false, closed: false, busy: false, touched: Date.now(), cache: new Map() }
      await check(binding, exec.signal)
      bindings.set(binding.id, binding)
      return { kind: 'ppt-preview', preview_id: binding.id, session_id: sessionId, project_path: relative(root, project) || '.', pages: await roster(binding) }
    },
    async call(action: string, payload: any, requestSignal = new AbortController().signal) {
      if (!payload || typeof payload !== 'object') throw new Error('预览请求无效。')
      const binding = bindings.get(payload.preview_id)
      if (!binding || binding.sessionId !== payload.session_id) throw Object.assign(new Error('预览已失效，请在当前任务重新打开。'), { code: 'preview-expired' })
      if (action === 'close') { release(binding); return {} }
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
      } finally { binding.busy = false }
    },
  }
}
