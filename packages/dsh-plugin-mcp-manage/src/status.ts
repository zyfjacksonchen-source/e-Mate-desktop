interface LoaderStatus {
  resolve(id: string): { fiber?: { state?: number } }
}

interface ToolStatus {
  schemas(): readonly { name: string }[]
}

/** Fail closed unless both the native loader fiber and its server Tool surface are live. */
export function isMcpServerActive(
  loader: LoaderStatus,
  tools: ToolStatus,
  entryId: string | undefined,
  serverName: string,
): boolean {
  if (entryId === undefined) return false
  try {
    return loader.resolve(entryId).fiber?.state === 2
      && tools.schemas().some(tool => tool.name.startsWith(`mcp__${serverName}__`))
  } catch {
    return false
  }
}

/** Owner tuple comes only from the verified enterprise identity service. */
export interface XinPrincipal { tenantId: string; userId: string }
export function validXinPrincipal(value: unknown): value is XinPrincipal {
  if (!value || typeof value !== 'object') return false
  const principal = value as XinPrincipal
  return [principal.tenantId, principal.userId].every(part => typeof part === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(part))
}

export interface XinCapabilityProof {
  binding: { tenant_id: string; user_id: number; principal_id: number }
  permissions: { tools: string[]; project_count: number; knowledge_project_count: number; writable_project_count: number; scope_revision: string }
}
/** Validate the actual Principal contract; this summary never grants authority. */
export function parseXinCapabilities(value: unknown): XinCapabilityProof | undefined {
  if (!value || typeof value !== 'object') return undefined
  const result = value as { structuredContent?: unknown; content?: unknown }
  let body = result.structuredContent
  if (body === undefined && Array.isArray(result.content) && result.content.length === 1) {
    const item = result.content[0]
    if (!item || typeof item !== 'object' || item.type !== 'text' || typeof item.text !== 'string' || item.text.length > 64 * 1024) return undefined
    try { body = JSON.parse(item.text) } catch { return undefined }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const data = body as Record<string, unknown>
  const fields = ['tenant_id', 'user_id', 'principal_id', 'project_ids', 'knowledge_project_ids', 'writable_project_ids', 'project_scope_revisions', 'tools', 'scope_revision']
  const ids = (value: unknown): value is number[] => Array.isArray(value) && value.length <= 10000 && new Set(value).size === value.length && value.every(id => Number.isSafeInteger(id) && id > 0)
  const revisions = data.project_scope_revisions
  if (Object.keys(data).sort().join(',') !== fields.sort().join(',')
    || typeof data.tenant_id !== 'string' || !data.tenant_id || data.tenant_id.length > 128
    || !Number.isSafeInteger(data.user_id) || Number(data.user_id) <= 0
    || !Number.isSafeInteger(data.principal_id) || Number(data.principal_id) < 0
    || typeof data.scope_revision !== 'string' || !data.scope_revision || data.scope_revision.length > 128
    || !Array.isArray(data.tools) || data.tools.length > 512 || new Set(data.tools).size !== data.tools.length || !data.tools.every(tool => typeof tool === 'string' && tool.length > 0 && tool.length <= 128)
    || !ids(data.project_ids) || !ids(data.knowledge_project_ids) || !ids(data.writable_project_ids)
    || !revisions || typeof revisions !== 'object' || Array.isArray(revisions) || Object.keys(revisions).length > 10000
    || !Object.entries(revisions).every(([key, revision]) => key.length > 0 && key.length <= 128 && typeof revision === 'string' && revision.length > 0 && revision.length <= 256)) return undefined
  return {
    binding: { tenant_id: data.tenant_id, user_id: Number(data.user_id), principal_id: Number(data.principal_id) },
    permissions: { tools: [...data.tools] as string[], project_count: data.project_ids.length, knowledge_project_count: data.knowledge_project_ids.length, writable_project_count: data.writable_project_ids.length, scope_revision: data.scope_revision },
  }
}
export function verifiedXinCapabilities(value: unknown): boolean { return parseXinCapabilities(value) !== undefined }

export function oauthFailureKind(error: unknown, state: { aborted?: boolean; invalidated?: boolean; transient?: boolean } = {}): 'cancelled' | 'reauthorize' | 'transient' | 'failed' {
  const failure = error && typeof error === 'object' ? error as { errorCode?: string; name?: string; code?: string } : {}
  if (state.aborted || failure.name === 'AbortError') return 'cancelled'
  if (state.invalidated || ['invalid_grant', 'invalid_token', 'invalid_client', 'unauthorized_client', 'access_denied', 'insufficient_scope'].includes(failure.errorCode ?? '')) return 'reauthorize'
  if (state.transient || ['server_error', 'temporarily_unavailable', 'too_many_requests'].includes(failure.errorCode ?? '')
    || ['TypeError', 'TimeoutError'].includes(failure.name ?? '') || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN'].includes(failure.code ?? '')) return 'transient'
  return 'failed'
}

/** After a failed refresh, only the current native credential readback may be reused.
 * SDK invalid_grant clears tokens; a committed rotation may instead contain new tokens.
 */
export function hasUnexpiredOAuthAccess(value: { tokens?: { access_token?: string }; expires_at?: number }, now: number): boolean {
  return typeof value.tokens?.access_token === 'string' && value.tokens.access_token.length > 0
    && Number.isSafeInteger(value.expires_at) && Number(value.expires_at) > now
}
