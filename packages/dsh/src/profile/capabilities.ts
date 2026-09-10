export const name = 'emate-capabilities'
export const inject = ['connection']
export const CAPABILITIES_CHANNEL = '/emate.capabilities'

const ID = /^[a-z][a-z0-9.-]{1,63}$/u
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/u
const STATES = new Set(['ready', 'setup-required', 'blocked', 'failed'])
const ACTION_KINDS = new Set(['primary', 'secondary'])
const ICON_KEYS = new Set(['browser', 'collaboration', 'image', 'office', 'ocr'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function badRequest(message) {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function boundedText(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
}

function validAction(action) {
  const keys = isRecord(action) ? Object.keys(action).sort().join(',') : ''
  return isRecord(action)
    && ID.test(action.id)
    && boundedText(action.label, 48)
    && ACTION_KINDS.has(action.kind)
    && (keys === 'id,kind,label'
      || (keys === 'id,input,kind,label' && action.input === 'credential'))
}

function validateDefinition(definition) {
  if (!isRecord(definition)
    || !ID.test(definition.id)
    || !boundedText(definition.title, 80)
    || !boundedText(definition.summary, 240)
    || typeof definition.icon_key !== 'string'
    || !ICON_KEYS.has(definition.icon_key)
    || !Number.isSafeInteger(definition.order)
    || typeof definition.status !== 'function'
    || !Array.isArray(definition.actions)
    || definition.actions.length > 4
    || definition.actions.some(action => !validAction(action))
    || new Set(definition.actions.map(action => action.id)).size !== definition.actions.length
    || (definition.actions.some(action => action.input !== 'credential') && typeof definition.invoke !== 'function')) {
    throw new Error('invalid e-Mate capability definition')
  }
}

function validateStatus(value, definition) {
  const credentialRefs = value?.credential_refs ?? {}
  if (!isRecord(value)
    || !STATES.has(value.state)
    || (value.detail !== undefined && (typeof value.detail !== 'string' || value.detail.length > 240))
    || !Array.isArray(value.action_ids)
    || value.action_ids.some(id => typeof id !== 'string' || !definition.actions.some(action => action.id === id))
    || new Set(value.action_ids).size !== value.action_ids.length
    || !isRecord(credentialRefs)
    || Object.entries(credentialRefs).some(([id, ref]) => !value.action_ids.includes(id)
      || definition.actions.find(action => action.id === id)?.input !== 'credential'
      || typeof ref !== 'string' || !CREDENTIAL_REF.test(ref))
    || value.action_ids.some(id => definition.actions.find(action => action.id === id)?.input === 'credential'
      && !Object.hasOwn(credentialRefs, id))
    || Object.keys(value).some(key => key !== 'state' && key !== 'detail'
      && key !== 'action_ids' && key !== 'credential_refs')) {
    throw new Error('invalid e-Mate capability status')
  }
  return value
}

export function apply(ctx) {
  const definitions = new Map()
  const registry = {
    register(definition) {
      validateDefinition(definition)
      if (definitions.has(definition.id)) throw new Error(`duplicate e-Mate capability ${definition.id}`)
      definitions.set(definition.id, definition)
      return () => { definitions.delete(definition.id) }
    },
  }
  ctx.provide('emateCapabilities', registry)

  ctx.effect(() => ctx.connection.rpc.handle(
    CAPABILITIES_CHANNEL,
    async (endpoint, payload, signal) => {
      if (!isRecord(payload)) return badRequest('e-Mate capability payload must be an object')
      if (endpoint === 'list') {
        if (Object.keys(payload).length !== 0) return badRequest('capability list payload must be empty')
        const items = []
        for (const definition of definitions.values()) {
          let status
          try {
            status = validateStatus(await definition.status(signal), definition)
          } catch {
            signal.throwIfAborted()
            status = { state: 'failed', detail: '能力插件未能返回有效状态。', action_ids: [] }
          }
          items.push({
            id: definition.id,
            title: definition.title,
            summary: definition.summary,
            icon_key: definition.icon_key,
            order: definition.order,
            actions: definition.actions.filter(action => status.action_ids.includes(action.id)).map(action => ({
              ...action,
              ...(action.input === 'credential'
                ? { credential_ref: status.credential_refs[action.id] }
                : {}),
            })),
            state: status.state,
            ...(status.detail === undefined ? {} : { detail: status.detail }),
          })
        }
        items.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
        return { ok: true, value: { schema_version: 1, items } }
      }
      if (endpoint === 'action') {
        if (Object.keys(payload).sort().join(',') !== 'action_id,capability_id,data'
          || typeof payload.capability_id !== 'string'
          || !ID.test(payload.capability_id)
          || typeof payload.action_id !== 'string'
          || !ID.test(payload.action_id)) {
          return badRequest('capability action payload is invalid')
        }
        const definition = definitions.get(payload.capability_id)
        const action = definition?.actions.find(candidate => candidate.id === payload.action_id)
        if (definition === undefined
          || action?.input === 'credential'
          || typeof definition.invoke !== 'function') {
          return badRequest('capability action is unavailable')
        }
        try {
          const status = validateStatus(await definition.status(signal), definition)
          if (!status.action_ids.includes(payload.action_id)) return badRequest('capability action is unavailable')
          const result = await definition.invoke(payload.action_id, payload.data, signal)
          return {
            ok: true,
            value: {
              schema_version: 1,
              capability_id: payload.capability_id,
              action_id: payload.action_id,
              result,
            },
          }
        } catch {
          signal.throwIfAborted()
          return {
            ok: false,
            error: {
              code: 'internal',
              details: {},
              message: `${definition.title}操作未完成，请刷新能力状态后重试。`,
            },
          }
        }
      }
      return badRequest('unknown e-Mate capability endpoint')
    },
    { authority: 'loopback' },
  ), 'emate.capabilities: target-native RPC channel')
}
