import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer'
import type {} from '@deepseek-ai/dsh-client-connection/client'

export const inject = ['slots', 'connection']

type RpcResult = { ok: boolean; value?: unknown; error?: { message?: string } }
type Entry = { name: string; kind: 'directory' | 'file' }
type Listing = { kind: 'general' | 'project'; path: string; entries: Entry[]; truncated?: boolean }

interface Injected {
  callSidebar: (endpoint: string, payload: Record<string, unknown>) => Promise<RpcResult>
}

const styles: Record<string, CSSProperties> = {
  root: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', padding: '20px 24px', color: 'var(--dsw-alias-label-primary)' },
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 },
  button: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: '6px 10px', background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', cursor: 'pointer' },
  path: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)' },
  list: { minHeight: 0, overflow: 'auto', display: 'grid', alignContent: 'start', gap: 2 },
  row: { display: 'flex', width: '100%', gap: 10, alignItems: 'center', border: 0, borderRadius: 8, padding: '8px 10px', background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer' },
  preview: { minHeight: 0, flex: 1, overflow: 'auto', margin: 0, padding: 16, borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)', fontSize: 12 },
  note: { color: 'var(--dsw-alias-label-secondary)' },
}

function parseListing(value: unknown): Listing {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('项目文件目录无效。')
  const item = value as Record<string, unknown>
  if (item.schema_version !== 1 || (item.kind !== 'general' && item.kind !== 'project') || typeof item.path !== 'string' || !Array.isArray(item.entries)) {
    throw new Error('项目文件目录无效。')
  }
  const entries = item.entries.map(entry => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('项目文件目录无效。')
    const row = entry as Record<string, unknown>
    if (typeof row.name !== 'string' || (row.kind !== 'directory' && row.kind !== 'file')) throw new Error('项目文件目录无效。')
    return { name: row.name, kind: row.kind } as Entry
  })
  return { kind: item.kind, path: item.path, entries, truncated: item.truncated === true }
}

function ProjectFiles({ sessionId, callSidebar }: ConvViewProps & Injected) {
  const request = useRef(0)
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<Listing | null>(null)
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null)
  const [status, setStatus] = useState('正在读取项目文件…')

  const owned = useCallback(async <T,>(run: () => Promise<T>): Promise<T | undefined> => {
    const current = ++request.current
    try {
      const value = await run()
      return current === request.current ? value : undefined
    } catch (error) {
      if (current === request.current) throw error
      return undefined
    }
  }, [])

  const load = useCallback(async (nextPath: string) => {
    setStatus('正在读取项目文件…')
    setPreview(null)
    const result = await owned(() => callSidebar('list', { session_id: sessionId, path: nextPath }))
    if (result === undefined) return
    if (!result.ok) throw new Error(result.error?.message ?? '项目文件读取失败。')
    setListing(parseListing(result.value))
    setPath(nextPath)
    setStatus('')
  }, [callSidebar, owned, sessionId])

  useEffect(() => {
    void load('').catch(error => { setStatus(error instanceof Error ? error.message : '项目文件读取失败。') })
    return () => { request.current += 1 }
  }, [load])

  const open = async (entry: Entry) => {
    const next = path === '' ? entry.name : `${path}/${entry.name}`
    if (entry.kind === 'directory') return await load(next)
    setStatus('正在读取文件…')
    const result = await owned(() => callSidebar('read', { session_id: sessionId, path: next }))
    if (result === undefined) return
    if (!result.ok) throw new Error(result.error?.message ?? '文件读取失败。')
    const value = result.value as { schema_version?: unknown; kind?: unknown; path?: unknown; content?: unknown }
    if (value?.schema_version !== 1 || value.kind !== 'file' || typeof value.path !== 'string' || typeof value.content !== 'string') throw new Error('文件内容无效。')
    setPreview({ path: value.path, content: value.content })
    setStatus('')
  }

  if (listing?.kind === 'general') return <section style={styles.root}><h2>项目文件</h2><p style={styles.note}>当前是通用会话。选择一个项目文件夹后，这里会显示该项目的文件。</p></section>

  return (
    <section style={styles.root} aria-label="项目文件">
      <div style={styles.toolbar}>
        <button style={styles.button} type="button" disabled={preview === null && path === ''} onClick={() => {
          if (preview !== null) { setPreview(null); setStatus(''); return }
          const parts = path.split('/').filter(Boolean); parts.pop(); void load(parts.join('/')).catch(error => setStatus(error instanceof Error ? error.message : '项目文件读取失败。'))
        }}>返回</button>
        <strong style={styles.path}>{preview?.path ?? (path || '项目根目录')}</strong>
        <button style={{ ...styles.button, marginLeft: 'auto' }} type="button" onClick={() => { void load(path).catch(error => setStatus(error instanceof Error ? error.message : '项目文件读取失败。')) }}>刷新</button>
      </div>
      {status && <p role="status" style={styles.note}>{status}</p>}
      {preview !== null ? <pre style={styles.preview}>{preview.content}</pre> : (
        <div style={styles.list}>
          {listing?.entries.map(entry => (
            <button key={`${entry.kind}:${entry.name}`} style={styles.row} type="button" onClick={() => { void open(entry).catch(error => setStatus(error instanceof Error ? error.message : '文件读取失败。')) }}>
              <span aria-hidden="true">{entry.kind === 'directory' ? '▸' : '·'}</span><span>{entry.name}</span>
            </button>
          ))}
          {listing?.truncated && <p style={styles.note}>目录较大，仅显示前 500 项。</p>}
        </div>
      )}
    </section>
  )
}

function SessionProjectFiles(props: ConvViewProps & Injected) {
  return <ProjectFiles key={props.sessionId} {...props} />
}

export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'project-files',
    order: 20,
    label: '文件',
    inject: () => ({
      callSidebar: (endpoint: string, payload: Record<string, unknown>) =>
        ctx.connection.rpc.call('/emate.betterSidebar', endpoint, payload),
    }),
  }, SessionProjectFiles))
}
