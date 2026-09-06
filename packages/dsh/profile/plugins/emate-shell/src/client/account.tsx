import { useEffect, useRef, useState, type ComponentType, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { IconPlusOutline16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IDENTITY_CHANGED_EVENT,
  type IdentityBootstrap,
  type RpcResult,
  validBootstrap,
} from './identity.tsx'
import css from './account.module.css'
import { formatTokenCount } from './token-format.ts'
import { UsageHeatmap } from './usage-heatmap.tsx'

interface Props {
  callIdentity: (endpoint: string, payload: Record<string, unknown>) => Promise<RpcResult>
}

interface AccountControlProps extends Props {
  wide: boolean
  placement?: 'sidebar' | 'header'
  UserIcon: ComponentType<{ size?: number }>
  expandSidebar: () => void
}

interface AccountUsage {
  schema_version: 1
  scope: 'account'
  timezone: string
  week: { total_tokens: number }
  week_started_at: string
  calculated_at: string
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : '企业身份服务暂不可用。'
}

function requestId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`
}

function validMutation(value: unknown): value is {
  schema_version: 1
  receipt_id: string
  reauthentication_required: true
  state: IdentityBootstrap
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  return result.schema_version === 1
    && typeof result.receipt_id === 'string'
    && result.receipt_id.length > 0
    && result.reauthentication_required === true
    && validBootstrap(result.state)
    && result.state.authenticated === false
    && result.state.workspace_unlocked === false
}

function validLogout(value: unknown): value is {
  schema_version: 1
  remote_revocation: 'revoked' | 'unknown'
  receipt_id?: string
  state: IdentityBootstrap
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  return result.schema_version === 1
    && (result.remote_revocation === 'revoked' || result.remote_revocation === 'unknown')
    && (result.remote_revocation === 'revoked'
      ? typeof result.receipt_id === 'string' && result.receipt_id.length > 0
      : result.receipt_id === undefined)
    && validBootstrap(result.state)
    && result.state.authenticated === false
    && result.state.workspace_unlocked === false
}

async function bootstrap(callIdentity: Props['callIdentity']): Promise<IdentityBootstrap> {
  const result = await callIdentity('identity.bootstrap', {})
  if (!result.ok) throw new Error(result.error?.message ?? '企业身份服务拒绝了请求。')
  if (!validBootstrap(result.value)) throw new Error('企业身份服务返回了无效状态。')
  return result.value
}

function identityLabel(state: IdentityBootstrap | null, error: string | null, signedOutLabel: string): string {
  if (state === null) return error === null ? '正在同步账号状态…' : '账号状态暂不可用'
  return state.display_name ?? (state.authenticated ? '已登录账号' : signedOutLabel)
}

function validUsage(value: unknown): value is AccountUsage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const usage = value as Partial<AccountUsage>
  return usage.schema_version === 1
    && usage.scope === 'account'
    && typeof usage.timezone === 'string'
    && usage.week !== null
    && typeof usage.week === 'object'
    && Number.isSafeInteger(usage.week.total_tokens)
    && usage.week.total_tokens >= 0
    && typeof usage.week_started_at === 'string'
    && Number.isFinite(Date.parse(usage.week_started_at))
    && typeof usage.calculated_at === 'string'
    && Number.isFinite(Date.parse(usage.calculated_at))
}

export function AccountControl({ callIdentity, wide, placement = 'sidebar', UserIcon, expandSidebar }: AccountControlProps) {
  const [state, setState] = useState<IdentityBootstrap | null>(null)
  const [identityError, setIdentityError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [usage, setUsage] = useState<AccountUsage | null>(null)
  const [usageError, setUsageError] = useState<string | null>(null)
  const details = useRef<HTMLDetailsElement>(null)
  const logoutRequestId = useRef<string | null>(null)
  const unlimited = state?.weekly_token_limit === Number.MAX_SAFE_INTEGER
  const label = identityLabel(state, identityError, '未登录')

  useEffect(() => {
    void bootstrap(callIdentity).then(setState).catch(error => { setIdentityError(message(error)) })
  }, [callIdentity])

  const loadUsage = async () => {
    if (!state?.authenticated) return
    setUsageError(null)
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      const result = await callIdentity('identity.usage', { timezone })
      if (!result.ok) throw new Error(result.error?.message ?? '企业用量服务拒绝了请求。')
      if (!validUsage(result.value)) throw new Error('企业用量服务返回了无效状态。')
      setUsage(result.value)
    } catch (usageFailure) {
      setUsage(null)
      setUsageError(message(usageFailure))
    }
  }

  useEffect(() => {
    if (state?.authenticated && details.current?.open) void loadUsage()
  }, [state?.authenticated])

  useEffect(() => {
    if (!confirming) return undefined
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setConfirming(false)
    }
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('keydown', escape) }
  }, [busy, confirming])

  const logout = async () => {
    if (busy) return
    const stableId = logoutRequestId.current ?? requestId('session_logout')
    logoutRequestId.current = stableId
    setBusy(true)
    setError(null)
    try {
      const result = await callIdentity('session.logout', {
        client_request_id: stableId,
        confirmed: true,
      })
      if (!result.ok) {
        throw new Error('退出登录暂未完成，请稍后重试。')
      }
      if (!validLogout(result.value)) throw new Error('企业服务器返回了无效退出状态。')
      logoutRequestId.current = null
      setState(result.value.state)
      setConfirming(false)
      dispatchEvent(new CustomEvent(IDENTITY_CHANGED_EVENT, {
        detail: { remote_revocation: result.value.remote_revocation },
      }))
    } catch {
      // A lost response can follow successful Host credential clearing.
      // Recheck authoritative identity for every failure shape, not just RPC envelopes.
      dispatchEvent(new CustomEvent(IDENTITY_CHANGED_EVENT, {
        detail: { logout_incomplete: true },
      }))
      setError('退出登录暂未完成，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  return <>
    <details ref={details} className={`${css.account} ${placement === 'header' ? css.headerAccount : ''}`} onToggle={event => {
      if ((event.currentTarget as HTMLDetailsElement).open) {
        void loadUsage()
      } else {
        setError(null)
      }
    }}>
      <summary
        aria-label={`用户中心，${label}`}
        onClick={event => {
          if (!wide && placement === 'sidebar') {
            event.preventDefault()
            expandSidebar()
          }
        }}
      >
        <UserIcon size={18} />
        <span className={wide ? undefined : css.visuallyHidden}>用户中心</span>
      </summary>
      {(wide || placement === 'header') && (
        <div className={css.accountPanel}>
          <strong>{label}</strong>
          {state?.authenticated && state.weekly_token_limit !== undefined ? (
            <div className={css.usage}>
              <span>本周用量</span>
              {unlimited
                ? <progress aria-label="本周 Token 用量" aria-valuetext={usage === null ? '无限额度' : `无限额度，已使用 ${formatTokenCount(usage.week.total_tokens)} Token`} />
                : usage === null
                ? <progress aria-label="本周 Token 用量" max={state.weekly_token_limit} />
                : <progress aria-label="本周 Token 用量" max={state.weekly_token_limit} value={Math.min(usage.week.total_tokens, state.weekly_token_limit)} />}
              <small>{usage === null
                ? usageError ?? '正在同步企业审计用量…'
                : unlimited
                  ? `${formatTokenCount(usage.week.total_tokens)} Token · 不限额度`
                  : `${formatTokenCount(usage.week.total_tokens)} / ${formatTokenCount(state.weekly_token_limit)} Token`}</small>
            </div>
          ) : null}
          {state?.authenticated ? (
            <button type="button" className={css.logout} onClick={() => {
              setConfirming(true)
              details.current?.removeAttribute('open')
            }}>退出登录</button>
          ) : <p role={identityError ? 'status' : undefined}>{identityError ?? '登录状态由企业身份服务提供。'}</p>}
        </div>
      )}
    </details>
    {confirming && createPortal(
      <div className={css.dialogLayer} role="presentation">
        <button className={css.dialogMask} type="button" aria-label="取消退出" disabled={busy} onClick={() => { setConfirming(false) }} />
        <section className={css.confirmDialog} role="dialog" aria-modal="true" aria-labelledby="emate-logout-title" aria-describedby="emate-logout-description">
          <h2 id="emate-logout-title">退出 e-Mate？</h2>
          <p id="emate-logout-description">会话和本地产物会保留；企业登录租约将被撤销。</p>
          {error && <p className={css.error} role="alert">{error}</p>}
          <div>
            <button type="button" disabled={busy} onClick={() => { setConfirming(false) }}>取消</button>
            <button type="button" className={css.danger} disabled={busy} aria-busy={busy} onClick={() => { void logout() }}>
              {busy ? '正在退出' : '退出登录'}
            </button>
          </div>
        </section>
      </div>,
      document.body,
    )}
  </>
}

export function AccountSettings({ callIdentity }: Props) {
  const [state, setState] = useState<IdentityBootstrap | null>(null)
  const [profileAvatar, setProfileAvatar] = useState<string | null>(null)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const passwordRequestId = useRef<string | null>(null)

  useEffect(() => {
    void bootstrap(callIdentity).then(setState).catch(error => { setStatus(message(error)) })
  }, [callIdentity])

  const chooseAvatar = (file: File | undefined) => {
    if (!file) return
    if (!file.type.match(/^image\/(?:png|jpeg|webp)$/u)) {
      setAvatarError('请选择 PNG、JPEG 或 WebP 图片。')
      return
    }
    if (file.size > 512 * 1024) {
      setAvatarError('头像不能超过 512 KB。')
      return
    }
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (typeof reader.result !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,/u.test(reader.result)) {
        setAvatarError('头像读取失败，请重试。')
        return
      }
      setProfileAvatar(reader.result)
      setAvatarError(null)
    }, { once: true })
    reader.addEventListener('error', () => { setAvatarError('头像读取失败，请重试。') }, { once: true })
    reader.readAsDataURL(file)
  }

  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    if (currentPassword.length < 8) {
      setStatus('请输入当前密码。')
      return
    }
    if (newPassword.length < 10 || newPassword.length > 256) {
      setStatus('新密码需为 10–256 个字符。')
      return
    }
    if (newPassword !== confirmPassword) {
      setStatus('两次输入的新密码不一致。')
      return
    }
    const stableId = passwordRequestId.current ?? requestId('session_password')
    passwordRequestId.current = stableId
    setBusy(true)
    setStatus(null)
    try {
      const result = await callIdentity('session.password', {
        current_password: currentPassword,
        new_password: newPassword,
        client_request_id: stableId,
      })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      if (!result.ok) throw new Error(result.error?.message ?? '修改密码失败。')
      if (!validMutation(result.value)) throw new Error('企业服务器返回了无效改密凭证。')
      passwordRequestId.current = null
      setStatus('密码已更新，旧租约已撤销，正在返回登录页…')
      window.setTimeout(() => { location.reload() }, 800)
    } catch (passwordError) {
      setStatus(message(passwordError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={css.settings} aria-labelledby="emate-account-settings-title">
      <h2 id="emate-account-settings-title">个人资料</h2>
      <div className={css.avatarRow}>
        <span className={css.avatarPreview}>
          {profileAvatar ? <img src={profileAvatar} alt="当前头像" /> : <span aria-hidden="true"><IconUserOutline16 size={20} /></span>}
        </span>
        <div><strong>头像</strong><p>仅保存在此设备，不会上传或改变企业账号资料。</p></div>
        <label className={css.avatarButton}>
          <span aria-hidden="true"><IconPlusOutline16 /></span><span>选择图片</span>
          <input type="file" aria-label="选择头像图片" accept="image/png,image/jpeg,image/webp" onChange={event => { chooseAvatar(event.target.files?.[0]) }} />
        </label>
        {profileAvatar ? <button type="button" onClick={() => { setProfileAvatar(null); setAvatarError(null) }}>移除</button> : null}
      </div>
      {avatarError ? <p className={`${css.note} ${css.error}`} role="status">{avatarError}</p> : null}
      <div className={css.identityRow}>
        <div>
          <strong>{identityLabel(state, status, '需要登录')}</strong>
          {state !== null && <p>{state.authenticated ? '企业账户状态已验证' : '模型任务已暂停，本地会话和产物仍会保留。'}</p>}
        </div>
      </div>
      <p className={css.note} role={state === null && status ? 'status' : undefined}>
        {state?.authenticated
          ? `每周 Token 额度 ${state.weekly_token_limit === Number.MAX_SAFE_INTEGER ? '不限' : state.weekly_token_limit === undefined ? '—' : formatTokenCount(state.weekly_token_limit)}；${state.agreement_exempt ? '管理员无需签署用户协议。' : state.agreement_receipt_id ? '首次使用协议已归档。' : '尚无有效协议归档凭证。'}`
          : status ?? (state === null ? null : '请完成企业登录后再修改密码。')}
      </p>
      {state?.authenticated ? <UsageHeatmap callIdentity={callIdentity} /> : null}
      {state?.authenticated ? (
        <form className={css.passwordForm} onSubmit={event => { void changePassword(event) }}>
          <label className={css.currentPassword}><span>当前密码</span><input type="password" autoComplete="current-password" minLength={8} maxLength={256} disabled={busy} value={currentPassword} onChange={event => { setCurrentPassword(event.target.value) }} /></label>
          <label><span>新密码</span><input type="password" autoComplete="new-password" minLength={10} maxLength={256} disabled={busy} value={newPassword} onChange={event => { setNewPassword(event.target.value) }} /></label>
          <label><span>确认新密码</span><input type="password" autoComplete="new-password" minLength={10} maxLength={256} disabled={busy} value={confirmPassword} onChange={event => { setConfirmPassword(event.target.value) }} /></label>
          <footer>
            <p className={status ? css.error : undefined} role={status ? 'status' : undefined}>{status ?? '修改后所有设备会退出登录，请使用新密码重新登录。'}</p>
            <button type="submit" disabled={busy || !currentPassword || !newPassword || !confirmPassword} aria-busy={busy}>{busy ? '正在修改' : '修改密码'}</button>
          </footer>
        </form>
      ) : null}
    </section>
  )
}
