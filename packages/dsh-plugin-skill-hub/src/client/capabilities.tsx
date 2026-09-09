import { useEffect, useMemo, useRef, useState, type ComponentType, type FormEvent } from 'react'
import css from './capabilities.module.css'

type HubCategory = 'third_party' | 'content_creation' | 'office_productivity'

interface SkillCard {
  slug: string
  version: string
  package_sha256: string
  title: string
  summary: string
  package_size_bytes: number
  category: HubCategory
  tags: string[]
  uploader: { nickname: string; author_ref: string }
  provenance: { brand: 'e-Mate'; original_platform: string | null; original_url: string | null }
  installation_status: 'not_installed' | 'installed_enabled' | 'installed_disabled' | 'uninstalled'
  readiness: 'ready' | 'needs_configuration' | 'missing_runtime' | 'unsupported'
}

interface SkillDetail {
  skill: SkillCard
  versions: SkillCard[]
  next_cursor: string | null
}

interface InstalledSkill {
  slug: string
  version: string
  package_sha256: string
  status: 'installed' | 'disabled'
  description: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  ready: boolean
  recovery_pending: boolean
  uploader?: { nickname: string; author_ref: string }
  error?: string
}

type CapabilityIconKey = 'browser' | 'collaboration' | 'image' | 'office' | 'ocr'
type IconComponent = ComponentType<{ size?: number }>

interface BuiltinCapability {
  id: string
  title: string
  summary: string
  icon_key: CapabilityIconKey
  order: number
  state: 'ready' | 'setup-required' | 'blocked' | 'failed'
  detail?: string
  actions: CapabilityAction[]
}

interface CapabilityAction {
  id: string
  label: string
  kind: 'primary' | 'secondary'
  input?: 'credential'
  credential_ref?: string
}

interface RpcResult {
  ok: boolean
  value?: unknown
  error?: { message?: string }
}

interface Props {
  callCapabilities: (endpoint: string, payload: Record<string, unknown>) => Promise<RpcResult>
  callSkillHub: (endpoint: string, payload: Record<string, unknown>) => Promise<RpcResult>
  setCredential: (ref: string, value: string) => Promise<RpcResult>
  SearchIcon: ComponentType<{ size?: number }>
  DownloadIcon: ComponentType<{ size?: number }>
  CloseIcon: ComponentType<{ size?: number }>
  RefreshIcon: ComponentType<{ size?: number }>
  SkillIcon: ComponentType<{ size?: number }>
  capabilityIcons: Record<CapabilityIconKey, IconComponent>
}

interface ControlProps {
  wide: boolean
  active: boolean
  SkillIcon: ComponentType<{ size?: number }>
}

type Tab = 'discover' | 'installed' | 'upload'
type InventoryState = 'loading' | 'ready' | 'failed'
type JobState = {
  id: string
  label: string
  status: string
  detail?: string
  download?: { href: string; filename: string }
}
type CatalogAction = {
  label: string
  disabled: boolean
  endpoint?: 'skills.install' | 'skills.enable'
  payload?: Record<string, unknown>
  jobLabel?: string
}

const CAPABILITY_STATE_LABELS: Record<BuiltinCapability['state'], string> = {
  ready: '可使用',
  'setup-required': '需要配置',
  blocked: '暂未启用',
  failed: '状态异常',
}

const CAPABILITY_CATEGORY_LABELS: Record<CapabilityIconKey, string> = {
  browser: '系统能力',
  office: '办公能力',
  image: '图像 / 媒体',
  collaboration: '外部连接',
  ocr: '数据能力',
}

const CAPABILITY_CATEGORY_KEYS = new Set<CapabilityIconKey>(['browser', 'collaboration', 'image', 'office', 'ocr'])

function requestedCapabilityCategory(): CapabilityIconKey | 'all' {
  const value = new URLSearchParams(location.search).get('category')
  return CAPABILITY_CATEGORY_KEYS.has(value as CapabilityIconKey) ? value as CapabilityIconKey : 'all'
}

const HUB_CATEGORY_LABELS: Record<HubCategory, string> = {
  third_party: '第三方',
  content_creation: '内容创作',
  office_productivity: '办公效率',
}

const JOB_STATUS_LABELS: Record<string, string> = {
  running: '进行中',
  stopping: '正在取消',
  completed: '已完成',
  failed: '失败',
  killed: '已取消',
}

function CapabilityGlyph({ capability, icons, fallback: Fallback }: {
  capability: BuiltinCapability
  icons: Record<CapabilityIconKey, IconComponent>
  fallback: IconComponent
}) {
  const Icon = icons[capability.icon_key] ?? Fallback
  return <span className={css.capabilityAvatar} data-icon={capability.icon_key}><Icon size={20} /></span>
}

function route(path: string): void {
  if (`${location.pathname}${location.search}${location.hash}` === path) return
  history.pushState(null, '', path)
  dispatchEvent(new PopStateEvent('popstate'))
}

function message(error: unknown): string {
  const detail = error instanceof Error ? error.message : ''
  return detail.includes('/emate.skillHub/')
    ? '社区 Skill 暂时不可用；内置能力仍可正常使用。'
    : detail || '能力中心暂不可用，请稍后重试。'
}

function rpcValue(result: RpcResult, fallback: string): unknown {
  if (!result.ok) throw new Error(result.error?.message ?? fallback)
  return result.value
}

function archiveBase64(file: File): Promise<string> {
  if (file.size < 1 || file.size > 10 * 1024 * 1024) {
    throw new Error('Skill ZIP 必须大于 0 且不超过 10 MiB。')
  }
  return file.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    }
    return btoa(binary)
  })
}

function downloadFromOutput(output: unknown): JobState['download'] {
  if (typeof output !== 'string' || output.length > 4096) return undefined
  try {
    const value = JSON.parse(output) as Record<string, unknown>
    if (typeof value.download_id !== 'string'
      || !/^[A-Za-z0-9.-]{8,256}$/u.test(value.download_id)
      || typeof value.slug !== 'string'
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.slug)
      || typeof value.version !== 'string'
      || !/^[0-9A-Za-z.-]{1,128}$/u.test(value.version)) return undefined
    return {
      href: `/api/e-mate/skill-hub.download?id=${encodeURIComponent(value.download_id)}`,
      filename: `e-mate-skill-${value.slug}-${value.version}.zip`,
    }
  } catch {
    return undefined
  }
}

function normal(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN')
}

function catalogAction(card: SkillCard, inventoryState: InventoryState, local?: InstalledSkill): CatalogAction {
  if (inventoryState === 'loading') return { label: '正在核对安装状态', disabled: true }
  if (inventoryState === 'failed') return { label: '安装状态读取失败', disabled: true }
  if (local?.recovery_pending) return { label: '等待恢复', disabled: true }
  if (local?.status === 'installed') return { label: local.ready ? '已安装并启用' : '已安装（需修复）', disabled: true }
  if (local?.status === 'disabled') {
    return { label: '启用', disabled: false, endpoint: 'skills.enable', payload: { slug: card.slug }, jobLabel: `启用 ${card.slug}` }
  }
  return {
    label: '安装并启用',
    disabled: false,
    endpoint: 'skills.install',
    payload: { slug: card.slug, version: card.version },
    jobLabel: `安装 ${card.slug}@${card.version}`,
  }
}

export function CapabilityControl({ wide, active, SkillIcon }: ControlProps) {
  return (
    <button className={css.sidebarAction} data-emate-primary-action="" data-wide={wide || undefined} type="button" title="能力中心" aria-label="能力中心" aria-current={active ? 'page' : undefined} onClick={() => { route('/capabilities') }}>
      <SkillIcon size={18} />
      {wide && <span>能力中心</span>}
    </button>
  )
}

export function CapabilitiesPage({
  callCapabilities,
  callSkillHub,
  setCredential,
  SearchIcon,
  DownloadIcon,
  CloseIcon,
  RefreshIcon,
  SkillIcon,
  capabilityIcons,
}: Props) {
  const detailSlug = useRef<string | null>(null)
  const dismissedJobs = useRef(new Set<string>())
  const [open, setOpen] = useState(() => location.pathname === '/capabilities')
  const [tab, setTab] = useState<Tab>('discover')
  const [query, setQuery] = useState('')
  const [installedQuery, setInstalledQuery] = useState('')
  const [items, setItems] = useState<SkillCard[]>([])
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [builtins, setBuiltins] = useState<BuiltinCapability[]>([])
  const [installed, setInstalled] = useState<InstalledSkill[]>([])
  const [inventoryState, setInventoryState] = useState<InventoryState>('loading')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<JobState | null>(null)
  const [upload, setUpload] = useState<File | null>(null)
  const [category, setCategory] = useState<HubCategory>('office_productivity')
  const [hubCategory, setHubCategory] = useState<HubCategory | 'all'>('all')
  const [hubTag, setHubTag] = useState('')
  const [capabilityCategory, setCapabilityCategory] = useState<CapabilityIconKey | 'all'>(requestedCapabilityCategory)
  const [builtinsOpen, setBuiltinsOpen] = useState(() => requestedCapabilityCategory() !== 'all')
  const [capabilityNotice, setCapabilityNotice] = useState<string | null>(null)
  const [selectedCard, setSelectedCard] = useState<SkillCard | null>(null)
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [credentialAction, setCredentialAction] = useState<{ capability: BuiltinCapability; action: CapabilityAction } | null>(null)
  const [credentialValue, setCredentialValue] = useState('')

  useEffect(() => {
    const sync = () => {
      const nextOpen = location.pathname === '/capabilities'
      setOpen(nextOpen)
      if (!nextOpen) return
      const nextCategory = requestedCapabilityCategory()
      setCapabilityCategory(nextCategory)
      if (nextCategory !== 'all') {
        setTab('discover')
        setBuiltinsOpen(true)
      }
    }
    addEventListener('popstate', sync)
    return () => { removeEventListener('popstate', sync) }
  }, [])

  useEffect(() => {
    if (selectedCard === null) return undefined
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      detailSlug.current = null
      setSelectedCard(null)
      setDetail(null)
    }
    addEventListener('keydown', close)
    return () => { removeEventListener('keydown', close) }
  }, [selectedCard])

  const loadCatalog = async (nextQuery = query, cursor?: string) => {
    if (loading) return
    if (cursor === undefined) setCatalogLoaded(false)
    setLoading(true)
    setError(null)
    try {
      if (cursor === undefined) {
        const capabilities = rpcValue(await callCapabilities('list', {}), '内置能力读取失败。') as { schema_version?: unknown; items?: unknown }
        if (capabilities.schema_version !== 1 || !Array.isArray(capabilities.items)) throw new Error('内置能力注册表无效。')
        setBuiltins(capabilities.items as BuiltinCapability[])
      }
      try {
        const filters: Record<string, unknown> = { query: nextQuery.trim(), limit: 24 }
        if (hubCategory !== 'all') filters.category = hubCategory
        if (hubTag.trim() !== '') filters.tag = hubTag.trim()
        if (cursor !== undefined) filters.cursor = cursor
        const value = rpcValue(await callSkillHub('catalog.search', filters), 'Skill Hub 读取失败。') as { items?: unknown; next_cursor?: unknown }
        if (!Array.isArray(value?.items) || (value.next_cursor !== null && typeof value.next_cursor !== 'string')) throw new Error('Skill Hub 返回了无效目录。')
        setItems(previous => cursor === undefined ? value.items as SkillCard[] : [...previous, ...value.items as SkillCard[]])
        setNextCursor(value.next_cursor as string | null)
        setCatalogLoaded(true)
      } catch (skillHubError) {
        if (cursor === undefined) setItems([])
        setError(message(skillHubError))
      }
    } catch (loadError) {
      setError(message(loadError))
    } finally {
      setLoading(false)
    }
  }

  const loadInstalled = async (showLoading = true) => {
    if (showLoading) setLoading(true)
    setInventoryState('loading')
    setError(null)
    try {
      const value = rpcValue(await callSkillHub('inventory.list', {}), '已安装 Skill 读取失败。') as { schema_version?: unknown; items?: unknown }
      if (value.schema_version !== 1 || !Array.isArray(value.items)) throw new Error('Skill Hub 本机清单无效。')
      setInstalled(value.items as InstalledSkill[])
      setInventoryState('ready')
    } catch (loadError) {
      setInventoryState('failed')
      setError(message(loadError))
    } finally {
      if (showLoading) setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    if (tab === 'discover') {
      if (items.length === 0) void loadCatalog('')
      void loadInstalled(false)
    }
    if (tab === 'installed') void loadInstalled()
  }, [open, tab])

  useEffect(() => {
    if (!open || job !== null) return
    let cancelled = false
    void callSkillHub('jobs.list', {}).then(result => {
      if (cancelled) return
      const value = rpcValue(result, 'Skill Job 清单读取失败。') as { items?: unknown }
      if (!Array.isArray(value.items)) throw new Error('Skill Job 清单无效。')
      const active = [...value.items].reverse().find(item => item !== null && typeof item === 'object'
        && typeof (item as { id?: unknown }).id === 'string'
        && !dismissedJobs.current.has((item as { id: string }).id)) as { id?: string; label?: string; status?: string } | undefined
      if (typeof active?.id === 'string' && typeof active.label === 'string' && typeof active.status === 'string') {
        setJob({ id: active.id, label: active.label, status: active.status })
      }
    }).catch(readError => { if (!cancelled) setError(message(readError)) })
    return () => { cancelled = true }
  }, [callSkillHub, job, open])

  useEffect(() => {
    if (job === null || !['running', 'stopping'].includes(job.status)) return undefined
    let cancelled = false
    const timer = window.setTimeout(() => {
      void callSkillHub('jobs.read', { job_id: job.id }).then(result => {
        if (cancelled) return
        const value = rpcValue(result, 'Skill Job 状态读取失败。') as { status?: string; detail?: string; output?: unknown }
        if (typeof value.status !== 'string') throw new Error('Skill Job 状态无效。')
        setJob(previous => {
          if (previous?.id !== job.id) return previous
          const next: JobState = { ...previous, status: value.status! }
          if (value.detail === undefined) delete next.detail
          else next.detail = value.detail
          const download = value.status === 'completed' ? downloadFromOutput(value.output) : undefined
          if (download === undefined) delete next.download
          else next.download = download
          return next
        })
        if (['completed', 'failed', 'killed'].includes(value.status)) void loadInstalled()
      }).catch(readError => { if (!cancelled) setError(message(readError)) })
    }, 500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [callSkillHub, job])

  const startJob = async (endpoint: 'skills.install' | 'skills.update' | 'skills.download' | 'skills.enable' | 'skills.disable' | 'skills.uninstall' | 'skills.publish' | 'skills.delete-publication', payload: Record<string, unknown>, label: string) => {
    if (job !== null && ['running', 'stopping'].includes(job.status)) return
    setError(null)
    try {
      const value = rpcValue(await callSkillHub(endpoint, payload), `${label}启动失败。`) as { job_id?: string; status?: string }
      if (typeof value.job_id !== 'string' || value.status !== 'running') throw new Error(`${label}未返回有效 Job。`)
      setJob({ id: value.job_id, status: value.status, label })
    } catch (operationError) {
      setError(message(operationError))
    }
  }

  const cancelJob = async () => {
    if (job === null || !['running', 'stopping'].includes(job.status)) return
    setError(null)
    try {
      rpcValue(await callSkillHub('jobs.cancel', { job_id: job.id }), 'Skill Job 取消失败。')
    } catch (cancelError) {
      setError(message(cancelError))
    }
  }

  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void loadCatalog()
  }

  const publish = async () => {
    if (upload === null) return
    try {
      const bundle = await archiveBase64(upload)
      await startJob('skills.publish', { bundle_base64: bundle, category }, `发布 ${upload.name}`)
    } catch (publishError) {
      setError(message(publishError))
    }
  }

  const runCapabilityAction = async (capability: BuiltinCapability, actionId: string) => {
    if (loading) return
    setLoading(true)
    setError(null)
    setCapabilityNotice(null)
    let succeeded = false
    try {
      rpcValue(await callCapabilities('action', {
        capability_id: capability.id,
        action_id: actionId,
        data: {},
      }), '能力操作失败。')
      setCapabilityNotice(`${capability.title} 已提交操作。`)
      succeeded = true
    } catch (actionError) {
      setError(message(actionError))
    } finally {
      setLoading(false)
    }
    if (succeeded) await loadCatalog(query)
  }

  const beginCapabilityAction = (capability: BuiltinCapability, action: CapabilityAction) => {
    if (action.input !== 'credential') {
      void runCapabilityAction(capability, action.id)
      return
    }
    if (typeof action.credential_ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(action.credential_ref)) {
      setError('能力返回了无效的凭据引用。')
      return
    }
    setCredentialValue('')
    setCredentialAction({ capability, action })
  }

  const storeCredential = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (credentialAction === null || loading) return
    const value = credentialValue.trim()
    if (value.length === 0 || value.length > 16 * 1024 || /[\r\n]/u.test(value)) {
      setError('凭据必须是 1–16384 个不含换行的字符。')
      return
    }
    setLoading(true)
    setError(null)
    try {
      rpcValue(await setCredential(credentialAction.action.credential_ref!, value), '凭据写入失败。')
      setCredentialValue('')
      setCapabilityNotice(`${credentialAction.capability.title} 凭据已安全保存。`)
      setCredentialAction(null)
      await loadCatalog(query)
    } catch (credentialError) {
      setError(message(credentialError))
    } finally {
      setLoading(false)
    }
  }

  const openDetail = async (card: SkillCard) => {
    detailSlug.current = card.slug
    setSelectedCard(card)
    setDetail(null)
    setDetailLoading(true)
    setError(null)
    try {
      const value = rpcValue(await callSkillHub('catalog.detail', { slug: card.slug, limit: 24 }), 'Skill 详情读取失败。') as { skill?: unknown; versions?: unknown; next_cursor?: unknown }
      if (!value.skill || !Array.isArray(value.versions) || (value.next_cursor != null && typeof value.next_cursor !== 'string')) throw new Error('Skill 详情返回了无效数据。')
      value.next_cursor ??= null
      if (detailSlug.current === card.slug) setDetail(value as SkillDetail)
    } catch (detailError) {
      if (detailSlug.current === card.slug) setError(message(detailError))
    } finally {
      if (detailSlug.current === card.slug) setDetailLoading(false)
    }
  }

  const loadMoreVersions = async () => {
    if (selectedCard === null || detail?.next_cursor == null || detailLoading) return
    const slug = selectedCard.slug
    setDetailLoading(true)
    setError(null)
    try {
      const value = rpcValue(await callSkillHub('catalog.detail', {
        slug,
        cursor: detail.next_cursor,
        limit: 24,
      }), 'Skill 版本历史读取失败。') as { versions?: unknown; next_cursor?: unknown }
      if (!Array.isArray(value.versions) || (value.next_cursor != null && typeof value.next_cursor !== 'string')) throw new Error('Skill 版本历史返回了无效数据。')
      if (detailSlug.current === slug) setDetail(previous => previous === null ? null : {
        ...previous,
        versions: [...previous.versions, ...value.versions as SkillCard[]],
        next_cursor: (value.next_cursor as string | null | undefined) ?? null,
      })
    } catch (detailError) {
      if (detailSlug.current === slug) setError(message(detailError))
    } finally {
      if (detailSlug.current === slug) setDetailLoading(false)
    }
  }

  const closeDetail = () => {
    detailSlug.current = null
    setSelectedCard(null)
    setDetail(null)
    setDetailLoading(false)
  }

  const capabilityCategories = useMemo(() => Array.from(new Set(builtins.map(item => item.icon_key))), [builtins])
  const visibleBuiltins = useMemo(() => builtins
    .filter(item => capabilityCategory === 'all' || item.icon_key === capabilityCategory)
    .sort((leftItem, rightItem) => leftItem.order - rightItem.order), [builtins, capabilityCategory])
  const visibleItems = useMemo(() => {
    return items
  }, [items])
  const visibleInstalled = useMemo(() => {
    const needle = normal(installedQuery)
    return installed.filter(item => !needle || normal(`${item.slug} ${item.description}`).includes(needle))
  }, [installed, installedQuery])
  const installedBySlug = useMemo(() => new Map(installed.map(item => [item.slug, item])), [installed])
  const selectedAction = selectedCard === null ? null : catalogAction(selectedCard, inventoryState, installedBySlug.get(selectedCard.slug))

  if (!open) return null

  return (
    <main className={css.page} data-emate-capabilities="">
      <section className={css.workspace} aria-label="能力中心">
        <header className={css.header}>
          <div><h1>能力中心</h1><p>发现、安装并管理 e-Mate 的办公能力。</p></div>
          <div className={css.headerActions}>
            <button type="button" aria-label={loading ? '正在刷新能力' : '刷新能力'} disabled={loading} onClick={() => { if (tab === 'installed') void loadInstalled(); else { void loadCatalog(); void loadInstalled(false) } }}><RefreshIcon size={16} /></button>
          </div>
        </header>

        <div className={css.tabs} role="tablist" aria-label="能力中心页面">
          <button type="button" role="tab" aria-selected={tab === 'discover'} onClick={() => { setTab('discover') }}>发现</button>
          <button type="button" role="tab" aria-selected={tab === 'installed'} onClick={() => { setTab('installed') }}>已安装 <span>{installed.length}</span></button>
            <button type="button" role="tab" aria-selected={tab === 'upload'} onClick={() => { setTab('upload') }}>导入</button>
        </div>

        {error && <div className={css.error} role="alert"><span>{error}</span><button type="button" aria-label="关闭错误" onClick={() => { setError(null) }}><CloseIcon size={16} /></button></div>}
        {capabilityNotice && <div className={css.notice} role="status">{capabilityNotice}</div>}
        {job && <div className={css.job} role="status"><span>{job.label}</span><strong>{JOB_STATUS_LABELS[job.status] ?? job.status}</strong>{job.detail && <small>{job.detail}</small>}{job.download && <a href={job.download.href} download={job.download.filename}>保存 ZIP</a>}{['running', 'stopping'].includes(job.status) ? <button type="button" onClick={() => { void cancelJob() }}>取消</button> : <button type="button" aria-label="关闭任务状态" onClick={() => { dismissedJobs.current.add(job.id); setJob(null) }}><CloseIcon size={16} /></button>}</div>}

        {tab === 'discover' && (
          <section className={css.content} aria-label="e-Mate Skill Hub">
            <section className={css.community} aria-label="Skill Hub">
              <form className={css.filterRow} onSubmit={search}>
                <label className={css.search}><SearchIcon size={16} /><input type="search" value={query} placeholder="搜索 Skill Hub" maxLength={128} onChange={event => setQuery(event.target.value)} /></label>
                <select aria-label="市场分类" value={hubCategory} onChange={event => setHubCategory(event.target.value as HubCategory | 'all')}><option value="all">全部市场</option><option value="third_party">第三方</option><option value="content_creation">内容创作</option><option value="office_productivity">办公效率</option></select>
                <input aria-label="按标签筛选" value={hubTag} placeholder="标签" onChange={event => setHubTag(event.target.value)} />
                <button className={css.uploadAction} type="button" onClick={() => { setTab('upload') }}><DownloadIcon size={16} />上传 Skill</button>
              </form>
              {loading && items.length === 0 ? <p className={css.empty}>正在读取 e-Mate Skill Hub…</p> : null}
              {!loading && catalogLoaded && visibleItems.length === 0 ? <p className={css.empty}>没有匹配的 Skill。</p> : null}
              <div className={css.hubGrid}>
                {visibleItems.map(card => {
                  const action = catalogAction(card, inventoryState, installedBySlug.get(card.slug))
                  return <article className={css.hubCard} key={`${card.slug}:${card.version}`}>
                    <div className={css.hubCardHead}><span className={css.hubAvatar}><SkillIcon size={20} /></span><span><strong>{card.title}</strong><small>{card.slug}</small></span></div>
                    <p>{card.summary}</p>
                    <div className={css.tags}>{card.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
                    <footer>
                      <span>v{card.version} · {HUB_CATEGORY_LABELS[card.category]} · {card.uploader.nickname}</span>
                      <div className={css.hubActions}>
                        <button type="button" disabled={detailLoading && selectedCard?.slug === card.slug} onClick={() => { void openDetail(card) }}>{detailLoading && selectedCard?.slug === card.slug ? '读取中' : '查看详情'}</button>
                        <button className={css.primary} type="button" disabled={action.disabled || ['missing_runtime', 'unsupported'].includes(card.readiness) || (job !== null && ['running', 'stopping'].includes(job.status))} onClick={() => { if (action.endpoint) void startJob(action.endpoint, action.payload!, action.jobLabel!) }}>{action.label}</button>
                      </div>
                    </footer>
                  </article>
                })}
              </div>
              {nextCursor && <button className={css.uploadAction} type="button" disabled={loading} onClick={() => { void loadCatalog(query, nextCursor) }}>加载更多</button>}
            </section>

            <details className={css.builtins} open={builtinsOpen} onToggle={event => { setBuiltinsOpen(event.currentTarget.open) }}>
              <summary><span>本机内置能力</span><small>{builtins.length}</small></summary>
              <div className={css.builtinsBody}>
                {capabilityCategories.length > 0 && <div className={css.categoryFilter} role="group" aria-label="内置能力分类">
                  <button type="button" aria-pressed={capabilityCategory === 'all'} onClick={() => { setCapabilityCategory('all') }}><SkillIcon size={14} /><span>全部分类</span></button>
                  {capabilityCategories.map(item => {
                    const Icon = capabilityIcons[item] ?? SkillIcon
                    return <button type="button" key={item} aria-pressed={capabilityCategory === item} onClick={() => { setCapabilityCategory(item) }}><Icon size={14} /><span>{CAPABILITY_CATEGORY_LABELS[item]}</span></button>
                  })}
                </div>}
                {loading && builtins.length === 0 ? <p className={css.empty}>正在读取能力目录…</p> : null}
                {!loading && builtins.length > 0 && visibleBuiltins.length === 0 ? <p className={css.empty}>该分类暂无能力。</p> : null}
                <div className={css.capabilityGrid}>
                  {visibleBuiltins.map(capability => <article className={css.capabilityCard} key={capability.id} data-state={capability.state}>
                    <div className={css.capabilityMain}><CapabilityGlyph capability={capability} icons={capabilityIcons} fallback={SkillIcon} /><span className={css.capabilityCopy}><strong>{capability.title}</strong><small>{capability.summary}</small><em>{CAPABILITY_CATEGORY_LABELS[capability.icon_key]} · {CAPABILITY_STATE_LABELS[capability.state]}</em></span></div>
                    {capability.actions.length > 0 && <div className={css.capabilityActions}>{capability.actions.map(action => <button className={action.kind === 'primary' ? css.primary : undefined} type="button" key={action.id} disabled={loading} onClick={() => { beginCapabilityAction(capability, action) }}>{action.label}</button>)}</div>}
                    {capability.detail && <p className={css.capabilityDetail}>{capability.detail}</p>}
                  </article>)}
                </div>
              </div>
            </details>
          </section>
        )}

        {tab === 'installed' && (
          <section className={css.content} aria-label="已安装 Skill">
            <div className={css.filterRow}><label className={css.search}><SearchIcon size={16} /><input type="search" value={installedQuery} placeholder="搜索 Skill Hub 本机清单" onChange={event => setInstalledQuery(event.target.value)} /></label></div>
            {loading ? <p className={css.empty}>正在通过原生 DSH provider 校验本机 Skill…</p> : null}
            {!loading && visibleInstalled.length === 0 ? <p className={css.empty}>没有 Skill Hub 管理的本机 Skill。</p> : null}
            <div className={css.capabilityGrid}>
              {visibleInstalled.map(skill => <article className={css.capabilityCard} key={skill.slug} data-state={skill.ready ? 'ready' : 'blocked'}>
                <div className={css.capabilityMain}><span className={css.capabilityAvatar}><SkillIcon size={20} /></span><span className={css.capabilityCopy}><strong>{skill.slug} <small>v{skill.version}</small></strong><small>{skill.description || '已验证的声明式 Skill'}</small><em>{skill.status === 'disabled' ? '已禁用' : skill.ready ? (skill.invocation.modelInvocable ? 'Agent 可调用' : '仅用户调用') : '原生回读失败'}{skill.recovery_pending ? ' · 等待恢复' : ''}</em>{skill.error && <small>{skill.error}</small>}</span></div>
                <div className={css.capabilityActions}>
                  {skill.status === 'installed' && <button type="button" disabled={skill.recovery_pending || (job !== null && ['running', 'stopping'].includes(job.status))} onClick={() => { void startJob('skills.update', { slug: skill.slug }, `更新 ${skill.slug}`) }}>更新</button>}
                  <button type="button" disabled={skill.recovery_pending || (job !== null && ['running', 'stopping'].includes(job.status))} onClick={() => { void startJob(skill.status === 'disabled' ? 'skills.enable' : 'skills.disable', { slug: skill.slug }, `${skill.status === 'disabled' ? '启用' : '禁用'} ${skill.slug}`) }}>{skill.status === 'disabled' ? '启用' : '禁用'}</button>
                  <button type="button" disabled={skill.recovery_pending || (job !== null && ['running', 'stopping'].includes(job.status))} onClick={() => { void startJob('skills.uninstall', { slug: skill.slug }, `卸载 ${skill.slug}`) }}>卸载</button>
                </div>
              </article>)}
            </div>
          </section>
        )}

        {tab === 'upload' && (
          <section className={`${css.content} ${css.skillMarket}`} aria-label="发布 Skill 到 e-Mate">
            <section className={css.upload}>
              <div><SkillIcon size={20} /><span><strong>发布到 e-Mate Skill Hub</strong><small>仅接受不超过 10 MiB 的声明式 Skill ZIP；slug 和版本来自包内 SKILL.md，已发布版本不可覆盖。</small></span></div>
              <label><span>市场分类</span><select value={category} onChange={event => setCategory(event.target.value as HubCategory)}><option value="third_party">第三方</option><option value="content_creation">内容创作</option><option value="office_productivity">办公效率</option></select></label>
              <label><span>选择 Skill ZIP</span><input type="file" accept=".zip,application/zip" onChange={event => setUpload(event.target.files?.[0] ?? null)} /></label>
              <button className={css.primary} type="button" disabled={upload === null || (job !== null && ['running', 'stopping'].includes(job.status))} onClick={() => { void publish() }}>验证并发布</button>
            </section>
          </section>
        )}
      </section>

      {selectedCard && <div className={css.dialogOverlay} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) closeDetail() }}>
        <section className={css.dialog} role="dialog" aria-modal="true" aria-labelledby="emate-skill-detail-title" aria-describedby="emate-skill-detail-description">
          <h2 id="emate-skill-detail-title">{selectedCard.title}</h2>
          <p id="emate-skill-detail-description">{selectedCard.summary}</p>
          <dl className={css.detailList}>
            <div><dt>slug</dt><dd>{selectedCard.slug}</dd></div>
            <div><dt>版本</dt><dd>{selectedCard.version}</dd></div>
            <div><dt>市场分类</dt><dd>{HUB_CATEGORY_LABELS[selectedCard.category]}</dd></div>
            <div><dt>发布者</dt><dd>{selectedCard.uploader.nickname}</dd></div>
            <div><dt>内容摘要</dt><dd><code>{selectedCard.package_sha256}</code></dd></div>
          </dl>
          {detailLoading ? <p className={css.detailLoading}>正在读取版本历史…</p> : null}
          {detail && <div className={css.versions}><strong>版本历史</strong><ul>{detail.versions.map(version => <li key={version.version}><span>v{version.version}</span><code>{version.package_sha256.slice(0, 12)}…</code></li>)}</ul>{detail.next_cursor && <button type="button" disabled={detailLoading} onClick={() => { void loadMoreVersions() }}>加载更多版本</button>}</div>}
          <p className={css.installNote}>e-Mate 会在当前设备创建绑定账号、版本和摘要的单次安装意图。</p>
          {job && <p className={css.dialogJob} role="status">{job.label} · {JOB_STATUS_LABELS[job.status] ?? job.status}</p>}
          <div className={css.dialogActions}>
            <button type="button" disabled={job !== null && ['running', 'stopping'].includes(job.status)} onClick={() => { void startJob('skills.download', { slug: selectedCard.slug, version: selectedCard.version }, `下载 ${selectedCard.slug}@${selectedCard.version}`) }}><DownloadIcon size={16} />下载 ZIP</button>
            <button className={css.primary} type="button" disabled={selectedAction!.disabled || ['missing_runtime', 'unsupported'].includes(selectedCard.readiness) || (job !== null && ['running', 'stopping'].includes(job.status))} onClick={() => { if (selectedAction!.endpoint) void startJob(selectedAction!.endpoint, selectedAction!.payload!, selectedAction!.jobLabel!) }}>{selectedAction!.label}</button>
          </div>
          <button className={css.dialogClose} type="button" aria-label="关闭 Skill 详情" onClick={closeDetail}><CloseIcon size={16} /></button>
        </section>
      </div>}

      {credentialAction && <div className={css.dialogOverlay} role="presentation" onMouseDown={event => { if (!loading && event.target === event.currentTarget) setCredentialAction(null) }}>
        <form className={css.dialog} role="dialog" aria-modal="true" aria-labelledby="emate-credential-title" onSubmit={storeCredential}>
          <h2 id="emate-credential-title">配置 {credentialAction.capability.title}</h2>
          <p>密钥只通过 DSH Credentials 单向写入本机凭据库，不会进入 Agent、能力 RPC 或设置文档。</p>
          <label className={css.credentialField}><span>API Key</span><input autoFocus type="password" autoComplete="new-password" spellCheck={false} value={credentialValue} disabled={loading} onChange={event => { setCredentialValue(event.target.value) }} /></label>
          <div className={css.dialogActions}>
            <button type="button" disabled={loading} onClick={() => { setCredentialValue(''); setCredentialAction(null) }}>取消</button>
            <button className={css.primary} type="submit" disabled={loading || credentialValue.trim() === ''}>{loading ? '正在保存' : '安全保存'}</button>
          </div>
          <button className={css.dialogClose} type="button" aria-label="关闭凭据配置" disabled={loading} onClick={() => { setCredentialValue(''); setCredentialAction(null) }}><CloseIcon size={16} /></button>
        </form>
      </div>}
    </main>
  )
}
