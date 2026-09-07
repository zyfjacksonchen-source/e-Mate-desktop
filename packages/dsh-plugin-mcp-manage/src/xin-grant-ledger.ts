import { randomUUID } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
export type XinGrant = { schema_version: 1; id: string; complete: boolean; resource: string }
export type GrantMutation = { id: string; kind: 'authorization_code' | 'refresh_token' | 'revocation'; grant_id?: string }
export type DisconnectReceipt = { local_stopped: true; local_forgotten: boolean; remote_revocation: 'revoked' | 'unknown' | 'not-required' }
export interface GrantLedgerState { schema_version: 1; pending: GrantMutation[]; disconnected?: DisconnectReceipt }
export function validXinGrant(value: any, resource: string): value is XinGrant {
  return value?.schema_version === 1 && typeof value.id === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value.id)
    && typeof value.complete === 'boolean' && value.resource === resource
}
/** A secret-free journal inside native Credentials, scoped to the original OAuth owner. */
export function createGrantLedger(credentials: any, oauthRef: string, changed: (state: GrantLedgerState) => void) {
  const ref = credentialRef(oauthRef + '_STATE')
  let tail: Promise<unknown> = Promise.resolve()
  const read = async (): Promise<GrantLedgerState> => {
    const raw = (await credentials.resolve(ref))?.value
    const state: GrantLedgerState = raw ? JSON.parse(raw) : { schema_version: 1, pending: [] }
    if (state.schema_version !== 1 || !Array.isArray(state.pending) || state.pending.length > 32
      || Object.keys(state).some(key => !['schema_version', 'pending', 'disconnected'].includes(key))
      || state.pending.some(item => !item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(item.id)
        || !['authorization_code', 'refresh_token', 'revocation'].includes(item.kind)
        || Object.keys(item).some(key => !['id','kind','grant_id'].includes(key))
        || item.grant_id !== undefined && !/^[A-Za-z0-9_-]{16,80}$/.test(item.grant_id))) throw Error('芯助手授权状态记录无效。')
    const stopped = state.disconnected
    if (stopped !== undefined && (!stopped || stopped.local_stopped !== true || typeof stopped.local_forgotten !== 'boolean'
      || !['revoked','unknown','not-required'].includes(stopped.remote_revocation) || Object.keys(stopped).some(key => !['local_stopped','local_forgotten','remote_revocation'].includes(key)))) throw Error('芯助手断开状态记录无效。')
    changed(state); return state
  }
  const update = (edit: (state: GrantLedgerState) => void) => {
    const task = tail.catch(() => {}).then(async () => {
      const state = await read(); edit(state)
      if (state.pending.length > 32) throw Error('芯助手存在过多未确认授权，请先处理撤销状态。')
      await credentials.set(ref, JSON.stringify(state)); changed(state); return state
    })
    tail = task; return task
  }
  return {
    read,
    async begin(kind: GrantMutation['kind'], grant_id?: string) {
      const id = randomUUID()
      await update(state => { state.pending.push({ id, kind, ...(grant_id ? { grant_id } : {}) }) })
      return id
    },
    async received(id: string, grant_id: string) { await update(state => { const item = state.pending.find(item => item.id === id); if (item) item.grant_id = grant_id }) },
    async committed(id: string) { await update(state => { state.pending = state.pending.filter(item => item.id !== id) }) },
    async confirmed(grant_id: string) { await update(state => { state.pending = state.pending.filter(item => item.grant_id !== grant_id || item.kind === 'revocation') }) },
    async revoked(grant_id: string) { await update(state => { state.pending = state.pending.filter(item => item.grant_id !== grant_id) }) },
    async disconnect(receipt: DisconnectReceipt) { await update(state => { state.disconnected = receipt }) },
    async reconnect() { await update(state => { delete state.disconnected }) },
  }
}
