export type ConnectionState = 'not-connected' | 'connecting' | 'connected' | 'expired' | 'failed'
export type ConnectionId = 'feishu' | 'dingtalk' | 'tencent_docs'
export interface ConnectionItem { id: ConnectionId; state: ConnectionState }
export const CONNECTIONS = [
  { id: 'feishu', title: '飞书', draft: '请帮我连接飞书。使用 connect-feishu-cli Skill，先检查并复用本机已有授权；仅在缺少授权时引导我完成所需的最小授权，最后验证连接状态。不要在聊天中索取或显示密钥。' },
  { id: 'dingtalk', title: '钉钉', draft: '请帮我连接钉钉。使用 connect-dingtalk Skill，先检查并复用已有连接；需要安装时使用现有 dsh_plugin_manage，然后引导我扫码授权并验证 Stream 连接。不要在聊天中索取或显示密钥。' },
  { id: 'tencent_docs', title: '腾讯文档', draft: '请帮我连接腾讯文档。使用 connect-tencent-docs Skill 和现有 mcp_manage，先检查并复用已有连接，仅在必要时引导安全授权，最后验证实际工具可用。不要在聊天中索取或显示密钥。' },
] as const

export const CONNECTION_LABELS: Record<ConnectionState, string> = {
  'not-connected': '未连接', connecting: '连接中', connected: '已连接', expired: '授权失效', failed: '状态异常',
}
type Rpc = (channel: string, endpoint: string, payload: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function valueOf(value: unknown): unknown {
  // Connection transport and provider business results each have one native envelope.
  for (let depth = 0; depth < 2 && record(value) && 'ok' in value; depth++) {
    if (value.ok !== true) {
      if (record(value.error) && ['not-found', 'unavailable-channel'].includes(String(value.error.code))) return undefined
      throw new Error('connection status unavailable')
    }
    value = value.value
  }
  return value
}
export async function loadConnectionStates(call: Rpc, signal?: AbortSignal): Promise<ConnectionItem[]> {
  const results = await Promise.allSettled([
    call('/emate.mcpManage', 'feishu.status', {}, signal),
    call('/dingtalk', 'connection.status', {}, signal),
    call('/emate.mcpManage', 'list', {}, signal),
  ])
  return CONNECTIONS.map(({ id }, index) => {
    const result = results[index]
    let state: ConnectionState = 'failed'
    try {
      if (result?.status !== 'fulfilled') throw new Error('status unavailable')
      const value = valueOf(result.value)
      if (value === undefined) state = 'not-connected'
      else if (record(value) && id === 'feishu' && Object.hasOwn(CONNECTION_LABELS, String(value.state))) {
        state = value.state as ConnectionState
      } else if (record(value) && id === 'dingtalk') {
        if (value.schemaVersion !== 1 || !Array.isArray(value.bots)) throw new Error('invalid DingTalk status')
        state = value.state === 'provisioning' ? 'connecting'
          : value.state === 'disconnected' && value.bots.length === 0 ? 'not-connected'
            : value.state === 'connected' && value.bots.length > 0 && value.bots.every(bot => record(bot) && bot.connected === true)
              ? 'connected' : 'failed'
      } else if (record(value) && id === 'tencent_docs' && value.schema_version === 1 && Array.isArray(value.items)) {
        const item = value.items.find(item => record(item) && item.name === 'tencent_docs')
        state = !record(item) ? 'not-connected' : item.active === true && item.authorized === true ? 'connected'
          : item.authorized === false ? 'expired' : 'failed'
      }
    } catch { state = 'failed' }
    return { id, state }
  })
}

/** Append through the native input owner without replacing attachment state or submitting. */
export function appendConnectionDraft(ctx: any, sessionId: string, prompt: string): void {
  if (ctx.sessions.list.getSnapshot().current !== sessionId) throw new Error('当前会话已切换，请重新选择连接。')
  const scope = ctx.sessions.scope(sessionId)
  if (scope === undefined) throw new Error('当前会话不可用。')
  const input = ctx.conversation.input.for(scope)
  const snapshot = input.state.getSnapshot()
  if (snapshot.phase !== 'plain') throw new Error('输入框正在提交，请稍后重试。')
  input.setDraft(snapshot.draft === '' ? prompt : `${snapshot.draft}\n\n${prompt}`)
}

export type XinState = 'ready' | 'authorization-required' | 'connecting' | 'unavailable' | 'cancelled'
export interface XinConnection {
  schema_version: 1
  service: 'xin-business-assistant'
  name: 'xin-business-assistant'
  transport: 'streamable-http'
  state: XinState
  active: boolean
  authorized: boolean
  binding?: { tenant_id: string; user_id: number; principal_id: number }
  permissions?: { tools: string[]; project_count: number; knowledge_project_count: number; writable_project_count: number; scope_revision: string }
  verified_at?: string
  authorization_unknown?: true
  disconnection?: { local_stopped: true; local_forgotten: boolean; remote_revocation: 'revoked' | 'unknown' | 'not-required' }
}
const XIN_STATES: readonly XinState[] = ['ready', 'authorization-required', 'connecting', 'unavailable', 'cancelled']
function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}
export function parseXinConnection(response: unknown): XinConnection {
  const value = valueOf(response)
  const required = ['schema_version', 'service', 'name', 'transport', 'state', 'active', 'authorized']
  if (!record(value) || !exactKeys(value, required, ['binding', 'permissions', 'verified_at', 'disconnection', 'authorization_unknown']) || value.schema_version !== 1
    || value.service !== 'xin-business-assistant' || value.name !== value.service || value.transport !== 'streamable-http'
    || !XIN_STATES.includes(value.state as XinState) || value.active !== (value.state === 'ready') || value.authorized !== value.active) throw new Error('芯助手返回的连接状态无效。')
  if (value.authorization_unknown !== undefined && value.authorization_unknown !== true) throw new Error('芯助手授权状态无效。')
  if (value.disconnection !== undefined) {
    const stopped = value.disconnection
    if (!record(stopped) || !exactKeys(stopped, ['local_stopped', 'local_forgotten', 'remote_revocation'])
      || stopped.local_stopped !== true || typeof stopped.local_forgotten !== 'boolean'
      || !['revoked', 'unknown', 'not-required'].includes(String(stopped.remote_revocation)) || value.state === 'ready') throw new Error('芯助手断开回执无效。')
  }
  const hasProof = ['binding', 'permissions', 'verified_at'].some(key => Object.hasOwn(value, key))
  if (value.state === 'ready' && !hasProof) throw new Error('芯助手尚未验证绑定账号和权限。')
  if (hasProof) {
    const binding = value.binding; const permissions = value.permissions
    if (!record(binding) || !exactKeys(binding, ['tenant_id', 'user_id', 'principal_id']) || typeof binding.tenant_id !== 'string' || !binding.tenant_id || binding.tenant_id.length > 128
      || !Number.isSafeInteger(binding.user_id) || Number(binding.user_id) <= 0 || !Number.isSafeInteger(binding.principal_id) || Number(binding.principal_id) < 0
      || !record(permissions) || !exactKeys(permissions, ['tools', 'project_count', 'knowledge_project_count', 'writable_project_count', 'scope_revision'])
      || !Array.isArray(permissions.tools) || permissions.tools.length > 512 || permissions.tools.some(tool => typeof tool !== 'string' || !tool || tool.length > 128)
      || ['project_count', 'knowledge_project_count', 'writable_project_count'].some(key => !Number.isSafeInteger(permissions[key]) || Number(permissions[key]) < 0 || Number(permissions[key]) > 10000)
      || typeof permissions.scope_revision !== 'string' || !permissions.scope_revision || permissions.scope_revision.length > 128
      || typeof value.verified_at !== 'string' || !Number.isFinite(Date.parse(value.verified_at)) || new Date(value.verified_at).toISOString() !== value.verified_at) throw new Error('芯助手的账号或权限验证信息无效。')
  }
  return structuredClone(value) as unknown as XinConnection
}
export async function callXinConnection(call: Rpc, action: 'status' | 'ensure' | 'disconnect', signal: AbortSignal): Promise<XinConnection> {
  signal.throwIfAborted()
  const result = await call('/emate.mcpManage', `xin.${action}`, {}, signal)
  signal.throwIfAborted()
  return parseXinConnection(result)
}
