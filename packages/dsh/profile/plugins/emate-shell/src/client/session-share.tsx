import {
  IconCopyOutline16,
  IconDownloadOutline16,
  IconShareOutline16,
  IconTrashOutline16,
  Modal,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import css from './session-share.module.css'

export interface SessionShareActionProps {
  sessionId: string | undefined
  callShare: (endpoint: string, payload: unknown) => Promise<unknown>
  useSessionLogDownload: <T>(selector: (state: SessionLogDownloadState) => T) => T
  requestDownload: (sessionId: string) => Promise<void>
  dismissDownload: (sessionId: string) => void
}

interface SessionLogDownloadEntry {
  readonly open: boolean
  readonly status: 'downloading' | 'success' | 'error'
  readonly error: string | null
}

interface SessionLogDownloadState {
  readonly bySession: Record<string, SessionLogDownloadEntry | undefined>
}

interface ShareLink {
  readonly share_id: string
  readonly public_url: string
  readonly expires_at: string
}

type ShareStage = 'idle' | 'preparing' | 'uploading' | 'created' | 'listing' | 'revoking' | 'failed'

const ERROR_MESSAGES: Record<string, string> = {
  'bad-request': '在线分享请求无效，请刷新后重试。',
  'authentication-required': '登录状态已失效，请重新登录后再试。',
  'archive-unavailable': '无法准备当前任务归档，请先改用本地导出检查任务数据。',
  'archive-too-large': '任务归档超过在线分享大小限制，请改用本地导出。',
  'owner-required': '当前账号或任务无权管理这个公开链接。',
  'request-timeout': '在线分享请求超时，请稍后重试。',
  'service-unavailable': '在线分享服务暂时不可用，请稍后重试。',
  'service-rejected': '在线分享服务拒绝了请求，请稍后重试。',
  'invalid-response': '分享服务返回了无效响应。',
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function responseValue(result: unknown): unknown {
  const envelope = record(result)
  if (envelope?.ok !== true) {
    const error = record(envelope?.error)
    const message = error?.schema_version === 1 && error.stage === 'failed' && typeof error.code === 'string'
      ? ERROR_MESSAGES[error.code]
      : undefined
    throw new Error(message ?? '在线分享请求失败。')
  }
  return envelope.value
}

function statusValue(result: unknown): boolean {
  const value = record(responseValue(result))
  if (value?.schema_version !== 1 || value.stage !== 'preparing' || value.service_version !== 1
    || typeof value.ready !== 'boolean') {
    throw new Error(ERROR_MESSAGES['invalid-response'])
  }
  return value.ready
}

function shareValue(value: unknown, allowExpired = false): ShareLink {
  const item = record(value)
  if (typeof item?.share_id !== 'string' || typeof item.public_url !== 'string'
    || typeof item.expires_at !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(item.share_id)
    || !Number.isFinite(Date.parse(item.expires_at)) || (!allowExpired && Date.parse(item.expires_at) <= Date.now())) {
    throw new Error('分享服务返回了无效链接。')
  }
  const url = new URL(item.public_url)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || ![`/s/${item.share_id}`, `/e-mate/share/s/${item.share_id}`].includes(url.pathname) || url.search !== '' || url.hash !== '') {
    throw new Error('分享服务返回了无效链接。')
  }
  return {
    share_id: item.share_id,
    public_url: url.toString(),
    expires_at: item.expires_at,
  }
}

function shareLink(result: unknown): ShareLink {
  const value = record(responseValue(result))
  if (value?.schema_version !== 1 || value.stage !== 'created') throw new Error('分享服务返回了无效链接。')
  return shareValue(value)
}

function shareLinks(result: unknown): ShareLink[] {
  const value = record(responseValue(result))
  if (value?.schema_version !== 1 || value.stage !== 'listing'
    || !Array.isArray(value.shares) || value.shares.length > 50) {
    throw new Error('分享服务返回了无效链接列表。')
  }
  const shares = value.shares.map(value => shareValue(value, true))
  if (new Set(shares.map(share => share.share_id)).size !== shares.length) {
    throw new Error('分享服务返回了无效链接列表。')
  }
  return shares.filter(share => Date.parse(share.expires_at) > Date.now())
}

export function SessionShareAction({
  sessionId, callShare, useSessionLogDownload, requestDownload, dismissDownload,
}: SessionShareActionProps) {
  const download = useSessionLogDownload(state => sessionId === undefined ? undefined : state.bySession[sessionId])
  const downloading = download?.status === 'downloading'
  const currentSession = useRef(sessionId)
  const operation = useRef(0)
  const [open, setOpen] = useState(false)
  const [shares, setShares] = useState<ShareLink[]>([])
  const [stage, setStage] = useState<ShareStage>('idle')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const pending = ['preparing', 'uploading', 'listing', 'revoking'].includes(stage)

  useEffect(() => {
    operation.current += 1
    currentSession.current = sessionId
    setOpen(false)
    setShares([])
    setStage('idle')
    setError('')
    setNotice('')
  }, [sessionId])

  const refresh = async (requestedSession: string) => {
    const currentOperation = ++operation.current
    setStage('listing')
    setError('')
    setNotice('')
    try {
      const listed = shareLinks(await callShare('list', { session_id: requestedSession }))
      if (operation.current !== currentOperation || currentSession.current !== requestedSession) return
      setShares(listed)
      setStage(listed.length > 0 ? 'created' : 'idle')
    } catch (failure) {
      if (operation.current === currentOperation && currentSession.current === requestedSession) {
        setStage('failed')
        setError(failure instanceof Error ? failure.message : '无法读取在线分享，请稍后重试。')
      }
    }
  }

  const create = async () => {
    if (pending || sessionId === undefined) return
    const requestedSession = sessionId
    const currentOperation = ++operation.current
    setStage('preparing')
    setError('')
    setNotice('')
    try {
      if (!statusValue(await callShare('status', {}))) throw new Error(ERROR_MESSAGES['service-unavailable'])
      if (operation.current !== currentOperation || currentSession.current !== requestedSession) return
      setStage('uploading')
      const created = shareLink(await callShare('create', { session_id: requestedSession }))
      if (operation.current !== currentOperation || currentSession.current !== requestedSession) return
      setShares([created])
      setStage('created')
      setNotice('公开链接已创建。')
    } catch (failure) {
      if (operation.current !== currentOperation || currentSession.current !== requestedSession) return
      const message = failure instanceof Error ? failure.message : '在线分享请求失败。'
      try {
        setStage('listing')
        const recovered = shareLinks(await callShare('list', { session_id: requestedSession }))
        if (operation.current !== currentOperation || currentSession.current !== requestedSession) return
        setShares(recovered)
        if (recovered.length > 0) {
          setStage('created')
          setNotice('已从服务恢复公开链接。')
        } else {
          setStage('failed')
          setError(message)
        }
      } catch {
        if (operation.current === currentOperation && currentSession.current === requestedSession) {
          setStage('failed')
          setError(message)
        }
      }
    }
  }

  const copy = async (share: ShareLink) => {
    setError('')
    setNotice(await writeClipboard(share.public_url) ? '链接已复制。' : '无法写入剪贴板，请手动复制链接。')
  }

  const revoke = async (share: ShareLink) => {
    if (pending || sessionId === undefined) return
    const requestedSession = sessionId
    const currentOperation = ++operation.current
    setStage('revoking')
    setError('')
    setNotice('')
    try {
      const value = record(responseValue(await callShare('revoke', {
        share_id: share.share_id,
        session_id: requestedSession,
      })))
      if (value?.schema_version !== 1 || value.stage !== 'revoking' || value.revoked !== true) {
        throw new Error('分享服务返回了无效撤销结果。')
      }
      if (operation.current !== currentOperation || currentSession.current !== requestedSession) return
      const remaining = shares.filter(item => item.share_id !== share.share_id)
      setShares(remaining)
      setStage(remaining.length > 0 ? 'created' : 'idle')
      setNotice('公开链接已撤销。')
    } catch (failure) {
      if (operation.current === currentOperation && currentSession.current === requestedSession) {
        setStage('failed')
        setError(failure instanceof Error ? failure.message : '无法撤销在线分享。')
      }
    }
  }

  return <>
    <button
      type="button"
      className={css.trigger}
      aria-label="分享当前任务"
      title={sessionId === undefined ? '开始任务后可分享' : '分享当前任务'}
      disabled={sessionId === undefined}
      onClick={() => {
        if (sessionId === undefined) return
        setOpen(true)
        setShares([])
        void refresh(sessionId)
      }}
    >
      <IconShareOutline16 size={16} />
    </button>
    <Modal
      open={open}
      onClose={() => {
        operation.current += 1
        setOpen(false)
        setStage('idle')
      }}
      title="分享任务"
      closeLabel="关闭分享"
      description="任何拿到链接的人都可以下载创建时已发送的任务、子任务和附件快照。后续消息不会自动同步；需要更新内容时，请先撤销旧链接再创建。"
      className={css.dialog}
    >
      <section className={css.online} aria-labelledby="session-share-title">
        <div>
          <strong id="session-share-title">在线公开链接</strong>
          <span>{stage === 'preparing'
            ? '正在检查在线分享服务…'
            : stage === 'uploading'
              ? '正在准备并上传任务归档…'
              : stage === 'listing'
                ? '正在读取当前任务的公开链接…'
                : stage === 'revoking'
                  ? '正在撤销公开链接…'
            : shares.length === 0
              ? '链接默认保留 7 天，可随时撤销。'
              : `已找回 ${shares.length} 个可管理链接。`}</span>
          {error !== '' && <small role="alert">{error}</small>}
          {notice !== '' && <small role="status">{notice}</small>}
        </div>
        {shares.map((share, index) => <article className={css.shareRow} key={share.share_id}>
          <div>
            <a href={share.public_url} target="_blank" rel="noreferrer">{share.public_url}</a>
            <small>有效期至 {new Intl.DateTimeFormat('zh-CN', {
              dateStyle: 'medium', timeStyle: 'short',
            }).format(new Date(share.expires_at))}</small>
          </div>
          <div className={css.actions}>
            <button
              type="button"
              className={css.secondary}
              aria-label={`复制链接 ${index + 1}`}
              onClick={() => { void copy(share) }}
            >
              <IconCopyOutline16 size={16} />复制链接
            </button>
            <button
              type="button"
              className={css.danger}
              aria-label={`撤销链接 ${index + 1}`}
              disabled={pending}
              aria-busy={stage === 'revoking'}
              onClick={() => { void revoke(share) }}
            >
              <IconTrashOutline16 size={16} />
              {stage === 'revoking' ? '正在撤销…' : '撤销链接'}
            </button>
          </div>
        </article>)}
        {shares.length === 0 && stage !== 'listing' && <button
            type="button"
            className={css.primary}
            disabled={pending}
            aria-busy={stage === 'preparing' || stage === 'uploading'}
            onClick={() => { void create() }}
          >
            <IconShareOutline16 size={16} />
            {stage === 'preparing' ? '正在检查服务…'
              : stage === 'uploading' ? '正在创建…'
                : stage === 'failed' ? '重试创建公开链接' : '创建公开链接'}
          </button>}
      </section>
      <section className={css.archive} aria-labelledby="session-archive-backup-title">
        <div>
          <strong id="session-archive-backup-title">本地备用归档</strong>
          <span>仅保存到本机，不会创建公开链接。</span>
        </div>
        <button
          type="button"
          className={css.secondary}
          disabled={downloading}
          aria-busy={downloading}
          onClick={() => {
            if (sessionId === undefined) return
            setOpen(false)
            void requestDownload(sessionId)
          }}
        >
          <IconDownloadOutline16 size={16} />
          {downloading ? '正在准备…' : '导出 ZIP'}
        </button>
      </section>
    </Modal>
    <Modal
      open={download?.open === true}
      onClose={() => { if (sessionId !== undefined) dismissDownload(sessionId) }}
      title="导出任务"
      closeLabel="关闭导出"
      description="将当前任务、子任务和附件保存为本地 ZIP。"
      className={css.dialog}
    >
      <section className={css.archive} aria-labelledby="session-archive-title">
        <div>
          <strong id="session-archive-title">下载会话归档</strong>
          <span>保存当前任务、子任务和附件的本地 ZIP。</span>
          {download?.status === 'success' && <small role="status">会话归档已开始下载。</small>}
          {download?.status === 'error' && <small role="alert">{download.error || '无法启动会话归档下载。'}</small>}
        </div>
        <button
          type="button"
          className={css.primary}
          disabled={downloading}
          aria-busy={downloading}
          onClick={() => { if (sessionId !== undefined) void requestDownload(sessionId) }}
        >
          <IconDownloadOutline16 size={16} />
          {downloading ? '正在准备…' : '下载 ZIP'}
        </button>
      </section>
    </Modal>
  </>
}

/** The root application tool group owns sharing; suppress only DSH's old header export button. */
export function HiddenSessionLogExport() { return null }
