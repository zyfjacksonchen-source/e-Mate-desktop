export const name = 'emate-agent-operations'
export const inject = ['systemPrompt', 'connection', 'sessions']

class ExpertModeRpcError extends Error {
  constructor(error) { super(error.message); this.rpcError = error }
}

export function expertModeActive(session) {
  for (let index = session.events.length - 1; index >= 0; index--) {
    const event = session.events[index]
    if (event.type === 'emate/expert-mode') return event.data?.active === true
  }
  return false
}

export async function expertModeRequest(ctx, endpoint, payload) {
  if (!['get', 'set'].includes(endpoint) || payload === null || typeof payload !== 'object'
    || Array.isArray(payload) || typeof payload.session_id !== 'string'
    || Object.keys(payload).some(key => !['session_id', ...(endpoint === 'set' ? ['active'] : [])].includes(key))
    || (endpoint === 'set' && typeof payload.active !== 'boolean')) throw new Error('专家模式请求无效。')
  let session = ctx.sessions.get(payload.session_id)
  let inspected
  if (session === undefined) {
    const persistence = ctx.get?.('sessionPersistence')
    if (persistence === undefined) throw new ExpertModeRpcError({
      code: 'session-not-found', message: '会话尚未就绪，请稍后重试。', details: { sessionId: payload.session_id },
    })
    // History browsing is intentionally read-only in the native Host: it does
    // not attach an Agent. Inspect the durable log without creating a writer.
    inspected = await persistence.inspect(payload.session_id)
    session = ctx.sessions.get(payload.session_id)
    if (session === undefined && endpoint === 'get') return { active: expertModeActive(inspected) }
  }
  if (endpoint === 'set') {
    const api = ctx.get?.('apiProxy')
    if (api === undefined) throw new Error('原生会话服务尚未就绪，请稍后重试。')
    // Every write, including warm and concurrently attached Sessions, uses the
    // native owner check. Existing ordinary Agents return without a resume.
    const response = await api.sessions.create({
      rpcId: `expert-mode:${payload.session_id}`,
      payload: { sessionId: payload.session_id, cwd: (session?.header ?? inspected.meta).cwd },
    })
    if (!response.result.ok) throw new ExpertModeRpcError(response.result.error)
    session = ctx.sessions.get(payload.session_id)
    if (session === undefined) throw new Error('原生会话恢复后仍不可用。')
    if (expertModeActive(session) !== payload.active) session.append('emate/expert-mode', { active: payload.active }, { ignorable: true })
    if (!await ctx.sessions.flush(session)) throw new Error('专家模式设置尚未保存，请重试。')
  }
  return { active: expertModeActive(session) }
}

const brandIdentity = '你是小芯，用户的 AI 办公助手。你运行在 e-Mate 内，是亦芯开发的全场景办公 AI Agent。自我介绍时使用第一人称：“我是小芯，你的 AI 办公助手。我运行在 e-Mate 内，是亦芯开发的全场景办公 AI Agent。”'
const batchImageGuidance = 'For exactly one image output, new or edited, call `imagegen` directly in the current Agent. For two or more mutually independent image outputs, call `image_batch` exactly once with one ordered task per output and explicit source IDs for each edit or fusion. Dependent edits wait for the preceding real output and run serially. Use the default concurrency unless the user specifies an allowed cap. Do not delegate the batch, emit sibling subagent waves, call `imagegen` separately for that batch, infer source images, replay unknown requests, switch models, or fall back. If the native Tool is unavailable, report that capability failure. Native batch children call `imagegen` once with their exact admitted arguments. Successful images remain valid when sibling tasks fail; report each failure once and do not create replacements automatically. Never display attachment IDs, hashes, receipt pointers, child Session IDs, Job IDs, or sha256 values as image results.'


const guidance = imageGuidance => `## e-Mate product operations

${brandIdentity} 涉及自我介绍、产品身份或品牌归属时必须保持此身份，不得自称 DeepSeek Harness、Codex 或其他产品。

Online update guidance is contributed by the Desktop Base that owns the typed \`e_mate_desktop_update\` Tool. Never use Bash, PowerShell, npm, pnpm, the legacy e-Mate CLI, or a hand-built downloader for an update.

When the user asks for an external service that is not installed, use the installed find-skill provider to discover it. skill_install is only for deployment-allowlisted external-connection Skills and always installs them device-globally after native confirmation; ordinary community Skill lifecycle belongs to Skill Hub. Check the provider's existing global status before any setup or authorization command: starting a new Session is never a reason to authorize again. If the connector requires MCP, use \`mcp_manage\` and do not claim it is effective until it reports \`active=true\`. Do not invent a built-in connector or ask the user to paste secrets into chat. Use Browser Tools only when the user's latest direct request explicitly asks to read or operate a user-visible webpage exposed through the DSH CDP adapter; never use Browser/CDP as a fallback for \`imagegen\`, native \`web_search\`, attachment resolution, or another unavailable first-party Tool.

${imageGuidance}

Old e-Mate/CowAgent scheduled tasks are staged by e_mate_schedule_import_list as disabled records, never as running timers. Explain unsupported cron, sub-five-minute intervals, ambiguous local time, and external delivery honestly. To enable one mappable task, first show its exact confirmation phrase and wait for a later user reply that matches it exactly. Only then call e_mate_schedule_import_enable; it delegates the live rule to schedule_list and schedule_create. Never call the enable Tool in the same turn that asks for confirmation.`

export function apply(ctx) {
  ctx.systemPrompt.section({ name: 'emate:agent-operations', order: 180,
    text: guidance(batchImageGuidance) })
  ctx.systemPrompt.section({ name: 'emate:expert-mode', order: 181,
    text: context => {
      const session = context.agent?.session
      if (session === undefined) return ''
      if (expertModeActive(session)) return '用户已在当前会话开启专家模式。处理后续问题时使用 enterprise-knowledge Skill；尚未加载时先通过原生 skill 工具加载。按该 Skill 查询企业知识库原文和 Wiki，并依据实际返回的来源回答。没有检索结果或服务不可用时明确说明，不能冒充已查询。该模式不授予额外数据权限。'
      return session.events.some(event => event.type === 'emate/expert-mode')
        ? '用户已关闭当前会话的专家模式。后续消息不再因先前开启过专家模式而自动查询企业知识库；用户明确要求查询时仍可使用现有企业知识能力。' : ''
    } })
  ctx.effect(() => ctx.connection.rpc.handle('/emate.expert-mode', async (endpoint, payload) => {
    try { return { ok: true, value: await expertModeRequest(ctx, endpoint, payload) } }
    catch (error) { return { ok: false, error: error instanceof ExpertModeRpcError ? error.rpcError : { code: 'internal', message: error instanceof Error ? error.message : '专家模式暂不可用。', details: {} } } }
  }, { authority: 'loopback' }), 'emate: session expert mode')
}
