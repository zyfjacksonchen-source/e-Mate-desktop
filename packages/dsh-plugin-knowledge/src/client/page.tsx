import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { HASH, SOURCE_ID, parseGraph, type CallKnowledge, type KnowledgeGraph, type KnowledgeNode } from '../contract.ts'
import type { GraphController } from './graph-renderer.ts'
import css from './page.module.css'
import { KnowledgeImports, type KnowledgeImportsProps } from './imports.tsx'
type OriginalVersion = { source_id: string; source_version: string; parse_revision?: string }
function revisionOriginals(value: any): OriginalVersion[] {
  const seen = new Set<string>()
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw Error('编译知识的原件引用无效。')
  for (const source of value) {
    if (!SOURCE_ID.test(source?.source_id) || !HASH.test(source?.source_version) || !HASH.test(source?.parse_revision) || seen.has(source.source_id)) throw Error('编译知识的原件引用无效。')
    seen.add(source.source_id)
  }
  return value
}
type ViewNode = KnowledgeNode & { source_only?: boolean; excerpt?: string }
type GraphModule = { createGraph(element: HTMLElement, select: (id: string) => void, unavailable: () => void): GraphController }
interface Props { callKnowledge: CallKnowledge; loadGraph(): Promise<GraphModule>; pickDirectory?: KnowledgeImportsProps['pickDirectory']; openTask?: KnowledgeImportsProps['openTask']; prepareDraft?: (text: string, signal: AbortSignal) => Promise<void> }
const layerNames: Record<string, string> = { expert: '专家知识', case: '案例方法', source: '原始资料' }
export function KnowledgeConstellationIcon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6.2 7.1 6.1-2M5.7 9.2l3.4 7.4m2.8.8 6.4-3.8m-3.7-7.7 4.5 5.2" />
    <circle cx="4.5" cy="7.5" r="2" /><circle cx="14" cy="4.5" r="2" />
    <circle cx="10" cy="18.5" r="2" /><circle cx="20.5" cy="12.5" r="2" />
  </svg>
}
export function KnowledgeEntry({ wide, KnowledgeIcon }: { wide: boolean; KnowledgeIcon: ComponentType<{ size?: number }> }) {
  const [active, setActive] = useState(location.pathname === '/knowledge')
  useEffect(() => { const sync = () => setActive(location.pathname === '/knowledge'); addEventListener('popstate', sync); return () => removeEventListener('popstate', sync) }, [])
  return <button className={css.entry} data-emate-primary-action="" data-wide={wide || undefined} type="button" title="知识图谱" aria-label="知识图谱" aria-current={active ? 'page' : undefined} onClick={() => { if (!active) { history.pushState(null, '', '/knowledge'); dispatchEvent(new PopStateEvent('popstate')) } }}><KnowledgeIcon size={18} />{wide && <span>知识图谱</span>}</button>
}
function GraphView({ nodes, edges, selected, select, loadGraph, failed }: {
  nodes: ViewNode[]; edges: KnowledgeGraph['edges']; selected?: string; select(id: string): void; loadGraph: Props['loadGraph']; failed(): void
}) {
  const [ready, setReady] = useState(false)
  const element = useRef<HTMLDivElement>(null), controller = useRef<GraphController | undefined>(undefined)
  const current = useRef({ nodes, edges, selected, select, failed }); current.current = { nodes, edges, selected, select, failed }
  useEffect(() => {
    let disposed = false
    void loadGraph().then(module => {
      if (disposed || !element.current) return
      const graph = module.createGraph(element.current, id => current.current.select(id), () => current.current.failed())
      controller.current = graph; setReady(true)
      graph.update(current.current.nodes, current.current.edges, current.current.selected)
      if (current.current.selected) graph.focus(current.current.selected)
    }).catch(() => { if (!disposed) current.current.failed() })
    return () => { disposed = true; controller.current?.dispose(); controller.current = undefined }
  }, [loadGraph])
  useEffect(() => { controller.current?.update(nodes, edges, selected) }, [nodes, edges, selected])
  useEffect(() => { if (selected) controller.current?.focus(selected) }, [selected])
  return <div ref={element} className={css.graph} aria-label="知识关系图，使用下方列表进行键盘浏览"><button className={css.resetView} type="button" disabled={!ready} onClick={() => controller.current?.reset()}>重置视角</button></div>
}
export function KnowledgePage({ callKnowledge, loadGraph, pickDirectory, openTask, prepareDraft }: Props) {
  const [open, setOpen] = useState(location.pathname === '/knowledge')
  const [graph, setGraph] = useState<KnowledgeGraph>()
  const [scope, setScope] = useState('')
  const [total, setTotal] = useState<number>()
  const [query, setQuery] = useState(''), [layer, setLayer] = useState('all')
  const [search, setSearch] = useState<{ question: string; query_id?: string; nodes: ViewNode[] }>()
  const [selected, setSelected] = useState<ViewNode>(), [detail, setDetail] = useState<any>()
  const [drafting, setDrafting] = useState(false), [importRequest, setImportRequest] = useState(0)
  const draftRequest = useRef<AbortController | undefined>(undefined)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [reading, setReading] = useState(false), [downloading, setDownloading] = useState(false)
  const [view, setView] = useState<'graph' | 'list'>('graph'), [unavailable, setUnavailable] = useState(false)
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  const listElement = useRef<HTMLUListElement>(null)
  useEffect(() => { listElement.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [selected?.id])
  const generation = useRef(0), reads = useRef(0), downloadGeneration = useRef(0)
  const request = useRef<AbortController | undefined>(undefined), readingRequest = useRef<AbortController | undefined>(undefined), downloadRequest = useRef<AbortController | undefined>(undefined)
  const clear = () => {
    generation.current++; reads.current++; downloadGeneration.current++
    request.current?.abort(); readingRequest.current?.abort(); downloadRequest.current?.abort(); draftRequest.current?.abort()
    setDrafting(false); setGraph(undefined); setScope(''); setTotal(undefined); setSearch(undefined); setQuery(''); setLayer('all'); setSelected(undefined); setDetail(undefined); setBusy(false); setReading(false); setDownloading(false)
  }
  const report = (reason: any) => {
    if (['scope-changed', 'unauthorized'].includes(reason?.code)) clear()
    if (reason?.code === 'scope-changed') dispatchEvent(new Event('emate:identity-changed'))
    setError(reason instanceof Error ? reason.message : '企业知识请求未完成，请重试。')
  }
  const refresh = async () => {
    draftRequest.current?.abort(); setDrafting(false)
    const ticket = ++generation.current
    request.current?.abort(); const controller = new AbortController(); request.current = controller
    setBusy(true); setError(''); setUnavailable(false); setSelected(undefined); setDetail(undefined); setSearch(undefined)
    reads.current++; readingRequest.current?.abort()
    try {
      const [catalog, result] = await Promise.all([callKnowledge('catalog', {}, controller.signal), callKnowledge('graph', { limit: 500 }, controller.signal)])
      if (ticket !== generation.current || controller.signal.aborted) return
      const next = parseGraph(result.result)
      if (!HASH.test(result.scope_key) || result.scope_key !== catalog.scope_key || next.corpus_revision !== catalog.result?.corpus_revision
        || !Number.isSafeInteger(catalog.result.source_count) || catalog.result.source_count < 0) throw Error('企业知识范围或版本不一致，请重试。')
      if (scope && scope !== result.scope_key) clear()
      setGraph(next); setScope(result.scope_key); setTotal(catalog.result.source_count)
    } catch (reason) { if (ticket === generation.current && !controller.signal.aborted) report(reason) }
    finally { if (ticket === generation.current) setBusy(false) }
  }
  useEffect(() => {
    const sync = () => { const next = location.pathname === '/knowledge'; if (!next) clear(); setOpen(next) }
    const identity = () => { clear(); setError('登录状态已变化，请重新加载企业知识。') }
    addEventListener('popstate', sync); addEventListener('emate:identity-changed', identity)
    return () => { request.current?.abort(); readingRequest.current?.abort(); downloadRequest.current?.abort(); draftRequest.current?.abort(); generation.current++; reads.current++; downloadGeneration.current++; removeEventListener('popstate', sync); removeEventListener('emate:identity-changed', identity) }
  }, [])
  useEffect(() => { if (open) void refresh() }, [open])
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const media = matchMedia('(prefers-reduced-motion: reduce)'), sync = () => setReduced(media.matches)
    media.addEventListener('change', sync); return () => media.removeEventListener('change', sync)
  }, [])
  const nodes = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const fromSearch = search?.question === query.trim()
    const rows: ViewNode[] = fromSearch ? search.nodes : graph?.nodes ?? []
    return rows.filter(node => (fromSearch || layer === 'all' || node.layer === layer) && (fromSearch || !needle || node.title.toLocaleLowerCase().includes(needle)))
  }, [graph, query, layer, search])
  useEffect(() => { if (selected && !nodes.some(node => node.id === selected.id)) { reads.current++; readingRequest.current?.abort(); setSelected(undefined); setDetail(undefined); setReading(false) } }, [nodes, selected])
  const searchText = async () => {
    draftRequest.current?.abort(); setDrafting(false)
    if (!graph || !query.trim()) return
    const ticket = ++generation.current
    request.current?.abort(); const controller = new AbortController(); request.current = controller
    setBusy(true); setError(''); const question = query.trim()
    try {
      const reply = await callKnowledge('search', { question, limit: 20, ...(layer === 'all' ? {} : { layer }), corpus_revision: graph.corpus_revision }, controller.signal)
      if (ticket !== generation.current || controller.signal.aborted) return
      if (reply.scope_key !== scope) throw Object.assign(Error('登录账号已变化，请重新加载。'), { code: 'scope-changed' })
      if (reply.result?.corpus_revision !== graph.corpus_revision || !Array.isArray(reply.result.data) || reply.result.data.length > 20 || !Array.isArray(reply.result.sources)) throw Error('知识检索版本不一致，请刷新。')
      const known = new Map(graph.nodes.filter(node => node.revision_id === undefined).map(node => [node.source_id, node])), seen = new Set<string>()
      const result = reply.result.data.map((hit: any) => {
        const source = reply.result.sources.find((value: any) => value.id === hit.source_id)
        if (!source || typeof source.id !== 'string' || typeof source.file_hash !== 'string' || !SOURCE_ID.test(source.id) || !HASH.test(source.file_hash) || typeof source.title !== 'string' || typeof hit.text !== 'string' || seen.has(source.id)) throw Error('知识检索来源无效。')
        seen.add(source.id)
        const node = known.get(source.id)
        if (node && node.source_version !== source.file_hash) throw Error('检索来源版本不一致，请刷新。')
        return { ...(node ?? { id: source.id, title: source.title, source_id: source.id, source_version: source.file_hash, layer: 'source', source_only: true }), excerpt: hit.text }
      })
      if (reply.result.query_id !== undefined && !SOURCE_ID.test(reply.result.query_id)) throw Error('检索快照身份无效。')
      setSearch({ question, query_id: reply.result.query_id, nodes: result }); setSelected(undefined); setDetail(undefined)
    } catch (reason) { if (ticket === generation.current && !controller.signal.aborted) report(reason) }
    finally { if (ticket === generation.current) setBusy(false) }
  }
  const read = async (node: ViewNode) => {
    draftRequest.current?.abort(); setDrafting(false)
    const ticket = ++reads.current
    readingRequest.current?.abort(); const controller = new AbortController(); readingRequest.current = controller
    setSelected(node); setDetail(undefined); setReading(true); setError('')
    try {
      const reply = await callKnowledge(node.source_only ? 'source' : 'node', { [node.source_only ? 'source_id' : 'node_id']: node.source_only ? node.source_id : node.id, version: node.source_version }, controller.signal)
      if (ticket !== reads.current || controller.signal.aborted) return
      if (reply.scope_key !== scope) throw Object.assign(Error('登录账号已变化，请重新加载。'), { code: 'scope-changed' })
      if (reply.result?.corpus_revision !== graph?.corpus_revision) throw Error('资料快照已变化，请刷新后阅读。')
      const version = node.source_only ? reply.result?.source?.file_hash : reply.result?.source_version
      if (version !== node.source_version || (node.source_only ? reply.result.source.id !== node.source_id : reply.result.id !== node.id || reply.result.source_id !== node.source_id || reply.result.untrusted !== true || typeof reply.result.content !== 'string')) throw Error('原文版本不一致，请刷新。')
      if (node.revision_id !== undefined) {
        if (reply.result.revision_id !== node.revision_id) throw Error('知识修订身份不一致，请刷新。')
        revisionOriginals(reply.result.source_versions)
      }
      setDetail(reply.result)
    } catch (reason) { if (ticket === reads.current && !controller.signal.aborted) report(reason) }
    finally { if (ticket === reads.current) setReading(false) }
  }
  const download = async (original: OriginalVersion) => {
    if (!selected || downloading) return
    const ticket = ++downloadGeneration.current, controller = new AbortController(); downloadRequest.current = controller
    setDownloading(true); setError('')
    try {
      const reply = await callKnowledge('original', { source_id: original.source_id, version: original.source_version }, controller.signal)
      if (ticket !== downloadGeneration.current || controller.signal.aborted) return
      if (reply.scope_key !== scope) throw Object.assign(Error('登录账号已变化，请重新加载。'), { code: 'scope-changed' })
      if (reply.result?.sha256 !== original.source_version || !/^\/emate-knowledge-downloads\/[a-f0-9-]{36}$/u.test(reply.result?.url)) throw Error('原件下载身份无效。')
      const anchor = document.createElement('a'); anchor.href = reply.result.url; anchor.click()
    } catch (reason) { if (ticket === downloadGeneration.current && !controller.signal.aborted) report(reason) }
    finally { if (ticket === downloadGeneration.current) setDownloading(false) }
  }
  const prepareReading = async (action: 'question' | 'report' | 'correction') => {
    if (!selected || !detail || !graph || !prepareDraft || draftRequest.current && !draftRequest.current.signal.aborted) return
    const controller = new AbortController(); draftRequest.current = controller; setDrafting(true); setError('')
    const node = selected, snapshot = graph.corpus_revision
    const sources = node.revision_id ? revisionOriginals(detail.source_versions) : [{ source_id: node.source_id, source_version: node.source_version }]
    const reference = { title: node.title, scope: graph.scope, scope_key: scope, corpus_revision: snapshot, node_id: node.source_only ? undefined : node.id,
      ...(node.revision_id ? { revision_id: node.revision_id, revision_version: node.source_version } : {}), source_versions: sources,
      ...(search?.question === query.trim() ? { question: search.question, ...(search.query_id ? { query_id: search.query_id } : {}) } : {}) }
    const intent = action === 'question' ? '请基于以下知识引用回答我的问题（请补充问题）：'
      : action === 'report' ? '请将以下知识加入我要制作的方案/报表（请补充目标）：'
      : '请协助核对此处知识并准备纠错建议（请补充疑点及新依据）：'
    const text = `${intent}\n\n知识引用：\n${JSON.stringify(reference, null, 2)}\n\n请先按上述版本读取原文，复用同一查询快照。区分原文事实、模型整理、推断和冲突；编译内容不等于原文事实。数字必须来自可核验的结构化 benchmark 及其证据，缺失时明确说明。${action === 'correction' ? '逐项列出原文表述、疑点、依据及建议更正，未经原件和引用校验不得宣称已修正或发布。' : '不要将推断写成已证实事实，也不要混入其他版本。'}`
    try {
      const current = await callKnowledge('catalog', {}, controller.signal)
      controller.signal.throwIfAborted()
      if (current.scope_key !== scope) throw Object.assign(Error('登录账号已变化，请重新加载。'), { code: 'scope-changed' })
      if (current.result?.corpus_revision !== snapshot) throw Error('资料快照已变化，请刷新后再准备草稿。')
      await prepareDraft(text, controller.signal)
    } catch (reason) { if (!controller.signal.aborted) report(reason) }
    finally { if (draftRequest.current === controller) { draftRequest.current = undefined; setDrafting(false) } }
  }
  if (!open) return null
  const originals: OriginalVersion[] = selected ? selected.revision_id ? detail?.source_versions ?? [] : [{ source_id: selected.source_id, source_version: selected.source_version }] : []
  const graphical = view === 'graph' && !reduced && !unavailable && nodes.length > 0
  return <main className={css.page} aria-label="知识图谱" data-emate-knowledge-page="">
    <header className={css.header}><div><small>公司公共知识</small><h1>知识图谱</h1><p>沿知识、方法与原始资料，找到可追溯的依据。</p></div><button type="button" onClick={() => void refresh()} disabled={busy}>{busy ? '正在读取' : '刷新资料'}</button></header>
    <KnowledgeImports openRequest={importRequest} callKnowledge={callKnowledge} pickDirectory={pickDirectory} openTask={openTask} replacement={selected && !selected.revision_id ? { source_id: selected.source_id, source_version: selected.source_version, title: selected.title } : undefined} />
    <form className={css.filters} onSubmit={event => { event.preventDefault(); void searchText() }}>
      <input maxLength={4000} aria-label="搜索知识" placeholder="筛选标题，或检索原文内容" value={query} onChange={event => { draftRequest.current?.abort(); setDrafting(false); generation.current++; request.current?.abort(); setBusy(false); setQuery(event.target.value); setSearch(undefined) }} />
      <select aria-label="知识类型" value={layer} onChange={event => { draftRequest.current?.abort(); setDrafting(false); generation.current++; request.current?.abort(); setBusy(false); setLayer(event.target.value); setSearch(undefined) }}><option value="all">全部类型</option>{Object.entries(layerNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <button type="submit" disabled={busy || !query.trim() || !graph}>检索原文</button>
      <div className={css.viewChoice} aria-label="浏览方式"><button type="button" aria-pressed={view === 'graph' && !reduced && !unavailable} onClick={() => setView('graph')} disabled={reduced || unavailable}>图谱</button><button type="button" aria-pressed={view === 'list' || reduced || unavailable} onClick={() => setView('list')}>列表</button></div>
    </form>
    <div className={css.status} role="status">{graph ? <><span>当前显示 {nodes.length} 个条目</span><span>公共资料 {total} 份</span><span title={graph.corpus_revision}>版本 {graph.corpus_revision.slice(0, 12)}</span>{graph.truncated && <span>当前图谱为部分结果，单视图最多500个节点。</span>}</> : <span>{busy ? '正在读取企业知识…' : '尚未加载企业知识。'}</span>}</div>
    {error && <p className={css.error} role="alert">{error}</p>}
    {(reduced || unavailable) && <p className={css.fallback}>{reduced ? '已遵循减少动态效果设置，使用完整列表阅读。' : '当前环境无法显示三维图谱，所有条目仍可在列表中阅读。'}</p>}
    <div className={`${css.workspace} ${selected ? css.hasDetail : ''}`}>
      <section className={css.browse} aria-label="知识结果">
        {graph && !nodes.length && <p className={css.empty}>{query || layer !== 'all' ? '未找到匹配条目。可调整筛选，或检索原文。' : '当前没有可读取的公共知识。'}</p>}
        {graphical && <div className={css.graphStage}><GraphView nodes={nodes} edges={graph!.edges} selected={selected?.id} select={id => { const node = nodes.find(value => value.id === id); if (node) void read(node) }} loadGraph={loadGraph} failed={() => setUnavailable(true)} /><span className={css.graphHint}>拖动旋转 · 滚轮缩放 · 点击查看来源</span></div>}
        {nodes.length > 0 && <ul ref={listElement} className={`${css.list} ${graphical ? css.graphList : ''}`} aria-label="知识条目列表">{nodes.map(node => <li key={node.id}><button type="button" aria-pressed={selected?.id === node.id} onClick={() => void read(node)}><span className={css.dot} /><span><strong>{node.title}</strong><small>{layerNames[node.layer]} · {node.revision_id ? '编译知识' : node.source_only ? '来源资料' : '知识节点'} · {node.source_version.slice(0, 8)}</small></span><span aria-hidden="true">↗</span></button></li>)}</ul>}
      </section>
      {selected && <aside className={css.detail} aria-label="知识原文"><header><span>{layerNames[selected.layer]}</span><button type="button" onClick={() => { draftRequest.current?.abort(); setDrafting(false); reads.current++; readingRequest.current?.abort(); setSelected(undefined); setDetail(undefined) }}>关闭</button></header><h2>{selected.title}</h2><details><summary>来源与版本</summary><p>{selected.revision_id ? `修订 ${selected.revision_id}` : `来源 ${selected.source_id}`}</p><code>sha256:{selected.source_version}</code></details>
        {detail && <div className={css.filters} aria-label="知识阅读操作">
          <button type="button" disabled={drafting || !prepareDraft} onClick={() => void prepareReading('question')}>基于此提问</button>
          <button type="button" disabled={drafting || !prepareDraft} onClick={() => void prepareReading('report')}>加入方案/报表</button>
          <button type="button" onClick={() => setImportRequest(value => value + 1)}>补充资料</button>
          <button type="button" disabled={drafting || !prepareDraft} onClick={() => void prepareReading('correction')}>纠错</button>
          <small>提问、方案与纠错会追加到聊天草稿，由你确认后发送。</small>
        </div>}
        {selected.revision_id && <h3>引用的原始资料</h3>}
        {originals.map((original, index) => <button key={original.source_id} type="button" className={css.download} disabled={downloading} onClick={() => void download(original)}>{downloading ? '正在核验原件' : selected.revision_id ? `下载原件：${graph?.nodes.find(node => node.revision_id === undefined && node.source_id === original.source_id && node.source_version === original.source_version)?.title ?? `原始资料 ${index + 1}`}` : '下载此版本原件'}</button>)}
        {selected.excerpt && <section><h3>检索片段</h3><p className={css.bodyText}>{selected.excerpt}</p></section>}
        {reading ? <p role="status">正在读取对应版本…</p> : detail?.content ? <section><h3>{selected.revision_id ? '编译内容' : '原文内容'}</h3><div className={css.bodyText}>{detail.content}</div></section> : detail?.source ? <p>来源：{detail.source.publisher}。可下载已核验版本的完整原件。</p> : null}
      </aside>}
    </div>
  </main>
}
