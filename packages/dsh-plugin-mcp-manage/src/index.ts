import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { auth as authorizeMcp, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { readCollectedOutput } from './collected-output.ts'
import { parseOAuthCallback } from './oauth-callback.ts'
import { validatePluginInstall, validatePluginPackageName } from './plugin-source.ts'
import { isMcpServerActive, validXinPrincipal, parseXinCapabilities, hasUnexpiredOAuthAccess, oauthFailureKind, type XinCapabilityProof } from './status.ts'
import { readFeishuConnection } from './feishu-status.ts'

export { parseOAuthCallback } from './oauth-callback.ts'

export const name = '@e-mate/dsh-plugin-mcp-manage'
export const inject = ['connection', 'credentials', 'settings', 'subprocess', 'timer', 'tools', 'systemPrompt', 'userQuestions']
export const CHANNEL = '/emate.mcpManage'
export const SETTINGS_NAMESPACE = settingsNamespace('mcp-manage')
export const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/u
const TOKEN_MAX = 16 * 1024
const OAUTH_STATE_MAX = 128 * 1024
const OAUTH_CALLBACK_PORT = 33_418
const OAUTH_CALLBACK_TIMEOUT_MS = 10 * 60_000
const OAUTH_REFRESH_SKEW_MS = 5 * 60_000
const OAUTH_RESPONSE_MAX = 1024 * 1024
const PLUGIN_OUTPUT_MAX = 128 * 1024
const PROTECTED_PLUGIN_PREFIXES = ['@deepseek-ai/', '@e-mate/']
const UNSUPPORTED_MCP = '2.0.18 仅允许受审计 HTTPS MCP；旧本地或自定义连接已停用，可安全删除。'
const AUDITED_PLUGIN_SOURCES = new Map([
  ['@xmanrui/dsh-im', 'github:zyfjacksonchen-source/dsh-im#f984f73dcd67692141d4e475c8fbe887e2ce7062'],
])
export const XIN_SERVICE = 'xin-business-assistant'
const MCP_CATALOG = new Map<string, McpServerSpec>([
  [XIN_SERVICE, { name: XIN_SERVICE, transport: 'streamable-http', url: 'https://mvdcm.ecoremedia.net/business-assistant/mcp', command: '', args: [], auth: 'oauth', oauthScope: 'business' }],
  ['tencent_docs', {
    name: 'tencent_docs', transport: 'streamable-http', url: 'https://docs.qq.com/openapi/mcp',
    command: '', args: [], auth: 'bearer', oauthScope: '',
  }],
])
const TENCENT_DOCS_AUTH_URL = new URL('https://docs.qq.com/open/auth/mcp.html')
const PROTECTED_PLUGIN_NAMES = new Set<string>([
  '@kelearns/dsh-navigation-bar',
  '@omdsh-dev/dsh-genui',
  'dsh-at-file',
  'dsh-better-sidebar',
  'dsh-file-viewer',
  'dsh-visualize',
])
type UserQuestionAgent = Parameters<Context['userQuestions']['ask']>[0]['agent']

const serverSchema = z.object({
  name: z.string().required().pattern(SERVER_NAME),
  transport: z.union(['streamable-http', 'stdio']).default('streamable-http'),
  url: z.string().default(''),
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  auth: z.union(['none', 'bearer', 'oauth']).default('none'),
  oauthScope: z.string().default(''),
})

export interface McpServerSpec {
  name: string
  transport: 'streamable-http' | 'stdio'
  url: string
  command: string
  args: string[]
  auth: 'none' | 'bearer' | 'oauth'
  oauthScope: string
}

export interface ConfigShape { servers: McpServerSpec[] }
export const Config: Schema<ConfigShape> = z.object({ servers: z.array(serverSchema).default([]) })

function tokenRef(name: string) {
  return credentialRef(`EMATE_MCP_${name.replaceAll('-', '_').toUpperCase()}_TOKEN`)
}

function oauthRef(name: string) {
  return credentialRef(`EMATE_MCP_${name.replaceAll('-', '_').toUpperCase()}_OAUTH`)
}

function validateServer(spec: McpServerSpec): void {
  if (!SERVER_NAME.test(spec.name)) throw new Error('MCP 名称仅支持 1-32 位字母、数字、下划线或连字符。')
  if (spec.transport === 'streamable-http') {
    let url: URL
    try { url = new URL(spec.url) } catch { throw new Error('MCP 地址无效。') }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
      throw new Error('远程 MCP 必须使用不含账号、密码或片段的 HTTPS 地址。')
    }
    if (spec.command !== '' || spec.args.length > 0) throw new Error('远程 MCP 不能同时声明本地命令。')
    if (spec.oauthScope.length > 4096 || /[\r\n]/u.test(spec.oauthScope)) throw new Error('OAuth scope 无效。')
  } else {
    if (spec.command.trim() === '' || spec.command.length > 512 || spec.args.some(arg => arg.length > 4096)) {
      throw new Error('本地 MCP 命令无效。')
    }
    if (spec.url !== '' || spec.auth !== 'none' || spec.oauthScope !== '') throw new Error('本地 MCP 不接受远程授权。')
  }
  if (spec.auth !== 'oauth' && spec.oauthScope !== '') throw new Error('只有 OAuth MCP 可以声明 scope。')
}

function validateConfig(value: ConfigShape): void {
  const names = new Set<string>()
  for (const spec of value.servers) {
    validateServer(spec)
    if (names.has(spec.name)) throw new Error(`MCP 名称重复：${spec.name}`)
    names.add(spec.name)
  }
}

function supportedServer(spec: McpServerSpec): boolean {
  const accepted = MCP_CATALOG.get(spec.name)
  return accepted !== undefined
    && spec.transport === accepted.transport
    && spec.url === accepted.url
    && spec.command === accepted.command
    && spec.args.length === accepted.args.length
    && spec.args.every((arg, index) => arg === accepted.args[index])
    && spec.auth === accepted.auth
    && spec.oauthScope === accepted.oauthScope
}

function exactObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function answerText(answer: { answers: Array<{ selected: string[]; custom?: string }> }): string {
  return answer.answers[0]?.custom?.trim() ?? ''
}

interface DesktopPnpmLike {
  readonly profileDir: string
  run(args: readonly string[], signal?: AbortSignal): {
    stdout: AsyncIterable<Uint8Array | string>
    stderr: AsyncIterable<Uint8Array | string>
    done: Promise<{ exitCode: number | null }>
    cancel(): void
  }
  runPlugin(args: readonly string[], invokingDir: string, signal?: AbortSignal): {
    stdout: AsyncIterable<Uint8Array | string>
    stderr: AsyncIterable<Uint8Array | string>
    done: Promise<{ exitCode: number | null }>
    cancel(): void
  }
  runPluginInstall(
    args: readonly string[],
    invokingDir: string,
    recovery: { packageName: string; packageVersion: string; receiptId: string },
    signal?: AbortSignal,
  ): Promise<{
    stdout: AsyncIterable<Uint8Array | string>
    stderr: AsyncIterable<Uint8Array | string>
    done: Promise<{ exitCode: number | null }>
    cancel(): void
  }>
  rollbackPluginInstall(receiptId: string): Promise<boolean>
}

interface DesktopRuntimeLike { requestRestart(): Promise<void> }

async function readBounded(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  let result = ''
  for await (const chunk of stream) {
    result += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    if (Buffer.byteLength(result) > PLUGIN_OUTPUT_MAX) throw new Error('DSH 插件安装输出超过安全上限。')
  }
  return result
}

function desktopServices(ctx: Context): {
  pnpm: DesktopPnpmLike
  runtime: DesktopRuntimeLike
} {
  const pnpm = ctx.get('desktopPnpm') as DesktopPnpmLike | undefined
  const runtime = ctx.get('desktopRuntime') as DesktopRuntimeLike | undefined
  if (pnpm === undefined || runtime === undefined) {
    throw new Error('当前运行方式不提供 Desktop 原生 DSH 插件管理能力。')
  }
  return { pnpm, runtime }
}

async function profileManifest(pnpm: DesktopPnpmLike): Promise<{
  dependencies: Record<string, string>
  bundles: string[]
}> {
  const raw = await readFile(join(pnpm.profileDir, 'package.json'), 'utf8')
  const manifest = JSON.parse(raw) as { dependencies?: unknown; dsh?: { profile?: { bundles?: unknown } } }
  const dependencies = manifest.dependencies
  const bundles = manifest.dsh?.profile?.bundles
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)
    || Object.entries(dependencies).some(([name, value]) => typeof name !== 'string' || typeof value !== 'string')
    || !Array.isArray(bundles) || bundles.some(value => typeof value !== 'string')) {
    throw new Error('DSH profile 插件清单无效。')
  }
  return { dependencies: dependencies as Record<string, string>, bundles: bundles as string[] }
}

async function runProfilePlugin(
  service: DesktopPnpmLike,
  args: readonly string[],
  signal?: AbortSignal,
  recovery?: { packageName: string; packageVersion: string; receiptId: string },
): Promise<void> {
  const operation = recovery === undefined
    ? service.runPlugin(args, process.cwd(), signal)
    : await service.runPluginInstall(args, process.cwd(), recovery, signal)
  try {
    const [, , outcome] = await Promise.all([
      readBounded(operation.stdout),
      readBounded(operation.stderr),
      operation.done,
    ])
    if (outcome.exitCode !== 0) {
      throw new Error('DSH 插件操作失败，请在 DSH 终端查看本机诊断。')
    }
  } catch (error) {
    operation.cancel()
    throw error
  }
}

async function confirmed(
  ctx: Context,
  question: string,
  detail: string,
  signal?: AbortSignal,
  agent?: UserQuestionAgent,
): Promise<boolean> {
  const answer = await ctx.userQuestions.ask({
    agent,
    questions: [{
      id: 'confirm', header: '外部连接', question, detail,
      options: [
        { label: '确认', description: '按显示的连接定义执行。' },
        { label: '取消', description: '不改变任何连接或凭据。' },
      ],
    }],
    signal,
  })
  return answer.answers[0]?.selected.includes('确认') === true
}

export interface OAuthLease { ref: ReturnType<typeof credentialRef>; signal: AbortSignal; assertCurrent(): void; invalidated?: boolean; transientFailure?: boolean }

interface OAuthCredentialState {
  schema_version: 1
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  discovery?: OAuthDiscoveryState
  expires_at?: number
}

function oauthCallbackUrl(name: string): string {
  return `http://127.0.0.1:${OAUTH_CALLBACK_PORT}/oauth/callback/${name}`
}

async function readOAuthState(ctx: Context, name: string, lease?: OAuthLease): Promise<OAuthCredentialState> {
  if (name === XIN_SERVICE && !lease) throw new Error('芯助手需要当前账号授权。')
  lease?.assertCurrent()
  const raw = (await ctx.credentials.resolve(lease?.ref ?? oauthRef(name)))?.value
  lease?.assertCurrent()
  if (raw === undefined || raw === '') return { schema_version: 1 }
  if (raw.length > OAUTH_STATE_MAX) throw new Error('OAuth 凭据超过安全上限。')
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('OAuth 凭据损坏，请重新授权。') }
  if (!exactObject(value) || value.schema_version !== 1) throw new Error('OAuth 凭据版本无效，请重新授权。')
  const state = value as unknown as OAuthCredentialState
  if (state.tokens !== undefined
    && (!exactObject(state.tokens) || typeof state.tokens.access_token !== 'string'
      || state.tokens.access_token === '' || state.tokens.access_token.length > TOKEN_MAX)) {
    throw new Error('OAuth 凭据内容无效，请重新授权。')
  }
  if (state.expires_at !== undefined && (!Number.isSafeInteger(state.expires_at) || state.expires_at <= 0)) {
    throw new Error('OAuth 凭据有效期无效，请重新授权。')
  }
  return state
}

async function writeOAuthState(ctx: Context, name: string, state: OAuthCredentialState, lease?: OAuthLease): Promise<void> {
  const value = JSON.stringify(state)
  if (value.length > OAUTH_STATE_MAX) throw new Error('OAuth 凭据超过安全上限。')
  if (name === XIN_SERVICE && !lease) throw new Error('芯助手需要当前账号授权。')
  lease?.assertCurrent()
  await ctx.credentials.set(lease?.ref ?? oauthRef(name), value)
  lease?.assertCurrent()
}

async function boundedOAuthResponse(response: Response): Promise<Response> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > OAUTH_RESPONSE_MAX) throw new Error('OAuth 响应超过安全上限。')
  if (response.body === null) return response
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > OAUTH_RESPONSE_MAX) {
      await reader.cancel()
      throw new Error('OAuth 响应超过安全上限。')
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new Response(size === 0 ? null : body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

async function secureOAuthFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('OAuth 仅允许不含账号、密码或片段的 HTTPS 端点。')
  }
  const timeout = AbortSignal.timeout(15_000)
  const signals = [timeout, init?.signal].filter((signal): signal is AbortSignal => signal !== undefined && signal !== null)
  const response = await fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) })
  return boundedOAuthResponse(response)
}

/** Same bounded HTTPS path, with caller cancellation preserved outside account leases too. */
export function oauthRequestFetch(signal?: AbortSignal, lease?: OAuthLease, fetchImplementation = secureOAuthFetch): typeof secureOAuthFetch {
  return async (input, init) => {
    const combined = AbortSignal.any([...(signal ? [signal] : []), ...(lease ? [lease.signal] : []), ...(init?.signal ? [init.signal] : []), ...(input instanceof Request ? [input.signal] : [])])
    combined.throwIfAborted(); lease?.assertCurrent()
    try {
      const response = await fetchImplementation(input, { ...init, signal: combined })
      if (lease && (response.status >= 500 || response.status === 429)) lease.transientFailure = true
      return response
    } catch (error) {
      if (lease && !combined.aborted && oauthFailureKind(error) === 'transient') lease.transientFailure = true
      throw error
    }
  }
}

interface OAuthCallbackHandle {
  redirectUrl: string
  result: Promise<string>
  close(): Promise<void>
}

async function startOAuthCallback(name: string, state: string, signal?: AbortSignal): Promise<OAuthCallbackHandle> {
  const path = `/oauth/callback/${name}`
  let resolveResult!: (code: string) => void
  let rejectResult!: (error: Error) => void
  let settled = false
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  const server: Server = createServer((request, response) => {
    const send = (status: number, body: string) => {
      response.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      response.end(body)
    }
    if (request.method !== 'GET' || request.socket.remoteAddress !== '127.0.0.1') {
      send(404, 'Not found')
      return
    }
    let callback: { code?: string; error?: string }
    try { callback = parseOAuthCallback(request.url ?? '/', path, state) } catch {
      send(400, 'Invalid OAuth callback')
      return
    }
    if (callback.code !== undefined) {
      send(200, '<h1>授权成功</h1><p>可以关闭此页面并返回 e-Mate。</p>')
      if (!settled) {
        settled = true
        resolveResult(callback.code)
      }
      return
    }
    send(400, '<h1>授权未完成</h1><p>请返回 e-Mate 后重试。</p>')
    if (callback.error !== undefined && !settled) {
      settled = true
      rejectResult(new Error('用户未完成外部服务授权。'))
    }
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(OAUTH_CALLBACK_PORT, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  }).catch((error) => {
    server.close()
    throw new Error(`无法启动 OAuth 本机回调端口 ${OAUTH_CALLBACK_PORT}。请关闭其他 e-Mate 实例后重试。`, { cause: error })
  })
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true
      rejectResult(new Error('外部服务授权已超时。'))
    }
  }, OAUTH_CALLBACK_TIMEOUT_MS)
  timeout.unref()
  const onAbort = () => {
    if (!settled) {
      settled = true
      rejectResult(new Error('外部服务授权已取消。'))
    }
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  return {
    redirectUrl: oauthCallbackUrl(name),
    result,
    close: async () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

async function openExternal(ctx: Context, url: URL, signal?: AbortSignal): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open'
  const executable = await ctx.subprocess.resolveExecutable(command, {}, signal)
  const argv = process.platform === 'win32'
    ? [executable, 'url.dll,FileProtocolHandler', url.toString()]
    : [executable, url.toString()]
  const handle = ctx.subprocess.spawn({
    argv,
    cwd: process.cwd(),
    signal,
    graceMs: 3_000,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 16 * 1024 },
      stderr: { maxBytes: 16 * 1024 },
    },
  })
  const outcome = await handle.done
  if (outcome.exitCode !== 0) throw new Error('无法打开外部服务授权页面。')
}

async function clipboardText(ctx: Context, signal?: AbortSignal): Promise<string> {
  const command = process.platform === 'darwin' ? 'pbpaste' : process.platform === 'win32' ? 'powershell.exe' : ''
  if (command === '') throw new Error('当前系统不支持从剪贴板安全导入凭据。')
  const executable = await ctx.subprocess.resolveExecutable(command, {}, signal)
  const argv = process.platform === 'win32'
    ? [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write((Get-Clipboard -Raw))']
    : [executable]
  const handle = ctx.subprocess.spawn({
    argv,
    cwd: process.cwd(),
    signal,
    graceMs: 3_000,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: TOKEN_MAX },
      stderr: { maxBytes: 16 * 1024 },
    },
  })
  try {
    const outcome = await handle.done
    const value = readCollectedOutput(handle.collected.stdout, '剪贴板标准输出')
    readCollectedOutput(handle.collected.stderr, '剪贴板错误输出')
    if (outcome.exitCode !== 0) throw new Error('无法读取系统剪贴板。')
    return value.trim()
  } catch (error) {
    handle.terminate()
    throw error
  }
}

async function oauthProvider(
  ctx: Context,
  spec: McpServerSpec,
  redirectUrl: string,
  stateNonce: string,
  redirect: (url: URL) => Promise<void>,
  lease?: OAuthLease,
): Promise<OAuthClientProvider> {
  const saved = await readOAuthState(ctx, spec.name, lease)
  let codeVerifier = ''
  const persist = () => writeOAuthState(ctx, spec.name, saved, lease)
  const clientMetadata: OAuthClientMetadata = {
    client_name: 'e-Mate 2.0.18',
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(spec.oauthScope === '' ? {} : { scope: spec.oauthScope }),
  }
  return {
    redirectUrl,
    clientMetadata,
    state: () => stateNonce,
    clientInformation: () => saved.client,
    saveClientInformation: async client => {
      saved.client = client
      await persist()
    },
    tokens: () => saved.tokens,
    saveTokens: async tokens => {
      saved.tokens = tokens
      saved.expires_at = tokens.expires_in === undefined
        ? undefined
        : Date.now() + Math.max(1, tokens.expires_in) * 1_000
      await persist()
    },
    redirectToAuthorization: redirect,
    saveCodeVerifier: verifier => { codeVerifier = verifier },
    codeVerifier: () => {
      if (codeVerifier === '') throw new Error('OAuth PKCE 校验状态缺失。')
      return codeVerifier
    },
    saveDiscoveryState: async discovery => {
      saved.discovery = discovery
      await persist()
    },
    discoveryState: () => saved.discovery,
    invalidateCredentials: async scope => {
      if (scope === 'all' || scope === 'tokens') {
        if (lease) lease.invalidated = true
        delete saved.tokens
        delete saved.expires_at
      }
      if (scope === 'all' || scope === 'client') delete saved.client
      if (scope === 'all' || scope === 'discovery') delete saved.discovery
      if (scope === 'all' || scope === 'verifier') codeVerifier = ''
      await persist()
    },
  }
}

async function authorizeOAuth(ctx: Context, spec: McpServerSpec, signal?: AbortSignal, lease?: OAuthLease): Promise<string> {
  const stateNonce = randomBytes(32).toString('base64url')
  const callback = await startOAuthCallback(spec.name, stateNonce, signal)
  try {
    const provider = await oauthProvider(ctx, spec, callback.redirectUrl, stateNonce, url => openExternal(ctx, url, signal), lease)
    const first = await authorizeMcp(provider, {
      serverUrl: spec.url,
      ...(spec.oauthScope === '' ? {} : { scope: spec.oauthScope }),
      fetchFn: oauthRequestFetch(signal, lease),
    })
    if (first === 'REDIRECT') {
      const code = await callback.result
      const completed = await authorizeMcp(provider, {
        serverUrl: spec.url,
        authorizationCode: code,
        ...(spec.oauthScope === '' ? {} : { scope: spec.oauthScope }),
        fetchFn: oauthRequestFetch(signal, lease),
      })
      if (completed !== 'AUTHORIZED') throw new Error('外部服务授权未完成。')
    }
    const token = (await readOAuthState(ctx, spec.name, lease)).tokens?.access_token ?? ''
    if (token === '') throw new Error('外部服务未返回可用凭据。')
    return token
  } finally {
    await callback.close()
  }
}

async function refreshOAuth(ctx: Context, spec: McpServerSpec, lease?: OAuthLease): Promise<string> {
  if (lease) { lease.invalidated = false; lease.transientFailure = false }
  const provider = await oauthProvider(ctx, spec, oauthCallbackUrl(spec.name), randomBytes(32).toString('base64url'), async () => {
    throw new Error('OAuth 授权已过期，请重新连接。')
  }, lease)
  const result = await authorizeMcp(provider, {
    serverUrl: spec.url,
    ...(spec.oauthScope === '' ? {} : { scope: spec.oauthScope }),
    fetchFn: oauthRequestFetch(undefined, lease),
  })
  if (result !== 'AUTHORIZED') throw new Error('OAuth 授权已过期，请重新连接。')
  return (await readOAuthState(ctx, spec.name, lease)).tokens?.access_token ?? ''
}

async function currentOAuthToken(ctx: Context, spec: McpServerSpec, lease?: OAuthLease): Promise<string> {
  const state = await readOAuthState(ctx, spec.name, lease)
  const token = state.tokens?.access_token ?? ''
  if (token === '') return ''
  if (state.expires_at === undefined || state.expires_at > Date.now() + OAUTH_REFRESH_SKEW_MS) return token
  if (state.tokens?.refresh_token !== undefined) {
    try { return await refreshOAuth(ctx, spec, lease) } catch (error) {
      if (oauthFailureKind(error) === 'cancelled') throw error
      if (lease) {
        lease.assertCurrent()
        const kind = oauthFailureKind(error, { aborted: lease.signal.aborted, invalidated: lease.invalidated, transient: lease.transientFailure })
        if (kind === 'cancelled') throw error
        const latest = await readOAuthState(ctx, spec.name, lease)
        if (kind === 'reauthorize') { delete latest.tokens; delete latest.expires_at; await writeOAuthState(ctx, spec.name, latest, lease); return '' }
        if (kind !== 'transient') throw error
        return hasUnexpiredOAuthAccess(latest, Date.now()) ? latest.tokens!.access_token : ''
      }
      if (state.expires_at > Date.now()) return token
      return ''
    }
  }
  return state.expires_at > Date.now() ? token : ''
}

export interface XinConnectionResult {
  schema_version: 1; service: typeof XIN_SERVICE; name: typeof XIN_SERVICE; transport: 'streamable-http'
  state: 'ready' | 'authorization-required' | 'connecting' | 'unavailable' | 'cancelled'
  active: boolean; authorized: boolean
  binding?: XinCapabilityProof['binding']; permissions?: XinCapabilityProof['permissions']; verified_at?: string
}
type XinExecution = Partial<Parameters<Context['tools']['execute']>[0]> & { token?: Parameters<Context['tools']['execute']>[0]['parent'] }

/** One account-bound adapter over the existing native owners, shared by UI and Agent. */
export function createXinConnection(ctx: Context, operations: {
  authorize(lease: OAuthLease, agent?: UserQuestionAgent): Promise<void>
  token(lease: OAuthLease): Promise<string>
  confirm(signal: AbortSignal, agent?: UserQuestionAgent): Promise<boolean>
  configured(): boolean
  install(): Promise<void>
}) {
  const spec = MCP_CATALOG.get(XIN_SERVICE)!
  const prefix = `mcp__${XIN_SERVICE}__`
  const capabilityTool = `${prefix}get_capabilities`
  const principals = new WeakMap<object, { turn: number; owner: string | undefined }>()
  const probes = new Set<string>()
  const executions = new WeakMap<object, { key: string; epoch: number; signal: AbortSignal }>()
  let epoch = 0
  let disposed = false
  let controller = new AbortController()
  let entry: { id: string; key: string; fingerprint: string } | undefined
  let verified: string | undefined
  let proof: (XinCapabilityProof & { owner: string; verified_at: string }) | undefined
  let tail: Promise<unknown> = Promise.resolve()
  const pending = new Map<string, { promise: Promise<XinConnectionResult>; interactive: boolean; reauthorize: boolean }>()
  const principal = () => {
    const identity = ctx.get('emateIdentity') as { localAccountPrincipal?(): unknown } | undefined
    const value = identity?.localAccountPrincipal?.()
    return validXinPrincipal(value) ? { tenantId: value.tenantId, userId: value.userId } : undefined
  }
  const owner = () => {
    const value = principal()
    if (!value) return undefined
    const key = createHash('sha256').update(JSON.stringify([value.tenantId, value.userId, XIN_SERVICE, spec.url])).digest('hex')
    return { key, ref: credentialRef(`EMATE_MCP_XIN_${key.toUpperCase()}_OAUTH`) }
  }
  // Bind authorization before the model starts a turn, not when its first
  // late ensure happens to arrive. A new turn may reuse the same local task.
  const stopTurn = ctx.on('agent/pre-step', ({ agent, turn }, next) => {
    if (principals.get(agent)?.turn !== turn) principals.set(agent, { turn, owner: owner()?.key })
    return next()
  })
  const stopAgent = ctx.on('agent/disposed', ({ agent }) => { principals.delete(agent) })
  const executionOwner = (exec: XinExecution): string | undefined => {
    if (!exec.agent) return undefined
    const binding = principals.get(exec.agent)
    if (!binding) return undefined
    const callId = exec.rootCallId ?? exec.callId
    if (callId === undefined) return undefined
    const events = exec.agent.session.events
    const call = events.findLast(event => event.type === 'tool/call' && String(event.data.callId) === String(callId))
    return call?.type === 'tool/call' && call.data.turn === binding.turn ? binding.owner : undefined
  }
  let observedOwner = owner()?.key
  const result = (state: XinConnectionResult['state'], expectedOwner = owner()?.key): XinConnectionResult => ({ schema_version: 1, service: XIN_SERVICE, name: XIN_SERVICE, transport: 'streamable-http', state, active: state === 'ready', authorized: state === 'ready', ...(proof && proof.owner === expectedOwner && expectedOwner === owner()?.key ? { binding: { ...proof.binding }, permissions: { ...proof.permissions, tools: [...proof.permissions.tools] }, verified_at: proof.verified_at } : {}) })
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.catch(() => {}).then(task); tail = run.then(() => {}, () => {}); return run
  }
  const removeEntry = async () => {
    verified = undefined
    const previous = entry
    if (!previous) return
    // Native create() rolls a failed activation out of its store. Resolve is
    // the Loader's pure lookup; there is then no live entry left to remove.
    try { ctx.loader.resolve(previous.id) } catch { if (entry === previous) entry = undefined; return }
    await ctx.loader.remove(previous.id)
    if (entry === previous) entry = undefined
  }
  const guard = ctx.tools.guard(exec => {
    if (!exec.name.startsWith(prefix)) return undefined
    const scope = owner()
    if (!scope || disposed || entry?.key !== scope.key) return '芯助手连接不属于当前登录账号，请先确保连接。'
    if (probes.has(String(exec.callId)) && exec.name === capabilityTool) { executions.set(exec, { key: scope.key, epoch, signal: controller.signal }); return undefined }
    if (verified !== scope.key || !isMcpServerActive(ctx.loader, ctx.tools, entry.id, XIN_SERVICE)) return '芯助手尚未验证当前授权，请先确保连接。'
    if (!exec.agent || executionOwner(exec) !== scope.key) return '请在当前任务中先调用 mcp_manage ensure 验证芯助手账号。'
    executions.set(exec, { key: scope.key, epoch, signal: controller.signal })
    return undefined
  })
  const stopDispatch = ctx.on('tools/execute', async (exec, next) => {
    if (!exec.name.startsWith(prefix)) return next()
    const captured = executions.get(exec)
    if (!captured || disposed || captured.epoch !== epoch || owner()?.key !== captured.key) throw new Error('芯助手账号已变化，请重新确保连接。')
    const previous = exec.signal
    exec.signal = AbortSignal.any([previous, captured.signal])
    try { exec.signal.throwIfAborted(); return await next() } finally { exec.signal = previous }
  })
  const stopPost = ctx.on('tools/post-execute', async (exec, _value, next) => {
    const decision = await next()
    if (!exec.name.startsWith(prefix)) return decision
    const captured = executions.get(exec)
    if (!captured || disposed || captured.epoch !== epoch || owner()?.key !== captured.key) {
      return { kind: 'block' as const, feedback: [{ type: 'text' as const, text: '芯助手账号已变化，本次结果不可用于当前账号。' }] }
    }
    return decision
  })
  const status = async (exec: XinExecution = {}) => {
    const scope = owner()
    if (!scope) return result('authorization-required')
    const priorOwner = executionOwner(exec)
    if (exec.agent && priorOwner !== scope.key) return result('unavailable', priorOwner ?? '')
    if (pending.has(scope.key)) return result('connecting')
    if (verified === scope.key && entry?.key === scope.key && isMcpServerActive(ctx.loader, ctx.tools, entry.id, XIN_SERVICE)) return result('ready')
    const generation = epoch
    const signal = AbortSignal.any([controller.signal, ...(exec.signal ? [exec.signal] : [])])
    try {
      const state = await readOAuthState(ctx, XIN_SERVICE, { ref: scope.ref, signal, assertCurrent() {
        signal.throwIfAborted()
        if (disposed || epoch !== generation || owner()?.key !== scope.key) throw new Error('Xin identity changed')
      } })
      const usable = state.tokens?.access_token !== undefined && (state.expires_at === undefined || state.expires_at > Date.now())
      return result(usable ? 'unavailable' : 'authorization-required', scope.key)
    } catch { return result(signal.aborted || owner()?.key !== scope.key ? 'cancelled' : 'unavailable', scope.key) }
  }
  const ensure = (exec: XinExecution = {}, options: { interactive?: boolean; reauthorize?: boolean } = {}): Promise<XinConnectionResult> => {
    changed()
    const scope = owner()
    if (!scope || disposed) return Promise.resolve(result('authorization-required'))
    const requestEpoch = epoch
    const scopedResult = (state: XinConnectionResult['state']) => result(state, scope.key)
    if (exec.agent) {
      const previous = executionOwner(exec)
      if (previous !== scope.key) return Promise.resolve(result('unavailable', previous ?? ''))
    }
    const shared = pending.get(scope.key)
    if (shared) {
      const current = () => !exec.signal?.aborted && requestEpoch === epoch && owner()?.key === scope.key && !disposed
      if (options.reauthorize && !shared.reauthorize) return shared.promise.then(() => current() ? ensure(exec, options) : scopedResult('cancelled'))
      if (options.interactive !== false && !shared.interactive) return shared.promise.then(value => !current() ? scopedResult('cancelled') : value.state === 'authorization-required' ? ensure(exec, options) : value)
      return shared.promise
    }
    const generation = epoch
    const signal = AbortSignal.any([controller.signal, ...(exec.signal ? [exec.signal] : [])])
    const lease: OAuthLease = { ref: scope.ref, signal, assertCurrent() {
      signal.throwIfAborted()
      if (disposed || generation !== epoch || owner()?.key !== scope.key) throw new Error('Xin identity changed')
    } }
    const task = serial(async () => {
      let previous: { value: string } | undefined
      let authorizing = false
      try {
        lease.assertCurrent()
        if (entry?.key !== scope.key) await removeEntry()
        lease.assertCurrent()
        previous = await ctx.credentials.resolve(scope.ref)
        lease.assertCurrent()
        let token = options.reauthorize ? '' : await operations.token(lease)
        lease.assertCurrent()
        if (!token) {
          // Refresh may have invalidated a grant or committed a rotation. Never
          // restore the pre-refresh credential if a later authorization is cancelled.
          previous = await ctx.credentials.resolve(scope.ref)
          lease.assertCurrent()
          verified = undefined
          await removeEntry()
          lease.assertCurrent()
          if (options.interactive === false) return scopedResult('authorization-required')
          if (!await operations.confirm(signal, exec.agent)) return scopedResult('cancelled')
          lease.assertCurrent()
          authorizing = true
          await operations.authorize(lease, exec.agent)
          lease.assertCurrent()
          token = await operations.token(lease)
          if (!token) throw new Error('Xin authorization unavailable')
        }
        lease.assertCurrent()
        const fingerprint = createHash('sha256').update(token).digest('hex')
        if (!entry || entry.fingerprint !== fingerprint || !isMcpServerActive(ctx.loader, ctx.tools, entry.id, XIN_SERVICE)) {
          await removeEntry()
          lease.assertCurrent()
          const next = { id: `emate-xin-${scope.key.slice(0, 32)}`, key: scope.key, fingerprint }
          // Record before create so a partial/late native activation can always be disposed.
          entry = next
          await ctx.loader.create({ id: next.id, name: MCP_CLIENT, config: {
            transport: 'streamable-http', serverName: XIN_SERVICE, url: spec.url, headers: { Authorization: `Bearer ${token}` },
            toolCallTimeoutMs: 60_000, failOnStartupError: true,
            reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 30_000, maxAttempts: 1000 },
          } } as never)
          lease.assertCurrent()
        }
        if (!ctx.tools.schemas().some(tool => tool.name === capabilityTool)) throw new Error('Xin capability tool unavailable')
        const callId = `xin-ensure-${randomBytes(16).toString('hex')}`
        probes.add(callId)
        try {
          const response = await ctx.tools.execute({ callId, name: capabilityTool, arguments: {}, signal,
            // Host-only read proof is not an Agent permission escalation; a
            // newly installed capability may be deferred by Tool Search.
            ...(exec.token ? { parent: exec.token, rootCallId: exec.rootCallId ?? exec.callId } : {}),
          } as never)
          lease.assertCurrent()
          const checked = response.isError ? undefined : parseXinCapabilities(response.value)
          if (!checked) throw new Error('Xin current authority unavailable')
          proof = { ...checked, owner: scope.key, verified_at: new Date().toISOString() }
        } finally { probes.delete(callId) }
        if (!operations.configured()) { await operations.install(); lease.assertCurrent() }
        verified = scope.key
        return scopedResult('ready')
      } catch {
        verified = undefined
        await removeEntry().catch(() => {})
        // Only the captured owner's key can be restored, never the next account.
        // Serial execution prevents another ensure from racing this rollback.
        if (authorizing) {
          try { if (previous) await ctx.credentials.set(scope.ref, previous.value); else await ctx.credentials.unset(scope.ref) } catch { return scopedResult('unavailable') }
        }
        return scopedResult(signal.aborted || generation !== epoch || owner()?.key !== scope.key ? 'cancelled' : 'unavailable')
      }
    })
    pending.set(scope.key, { promise: task, interactive: options.interactive !== false, reauthorize: options.reauthorize === true })
    void task.finally(() => { if (pending.get(scope.key)?.promise === task) pending.delete(scope.key) })
    return task
  }
  const disconnect = async (exec: XinExecution = {}): Promise<XinConnectionResult> => {
    const scope = owner()
    if (!scope) return result('authorization-required')
    const previousOwner = executionOwner(exec)
    if (exec.agent && previousOwner !== scope.key) return result('unavailable', previousOwner ?? '')
    const signal = exec.signal
    epoch++; controller.abort(); controller = new AbortController(); verified = undefined
    return serial(async () => {
      try {
        signal?.throwIfAborted()
        await removeEntry()
        await ctx.credentials.unset(scope.ref)
        proof = undefined
        return result(owner()?.key === scope.key ? 'authorization-required' : 'cancelled', scope.key)
      } catch { return result(signal?.aborted ? 'cancelled' : 'unavailable', scope.key) }
    })
  }
  const changed = () => {
    const currentOwner = owner()?.key
    if (currentOwner === observedOwner) return
    observedOwner = currentOwner
    proof = undefined
    epoch++; controller.abort(); controller = new AbortController(); verified = undefined
    void serial(removeEntry).catch(() => {})
  }
  return { status, ensure, disconnect, changed, async dispose() {
    disposed = true; epoch++; controller.abort(); verified = undefined
    await serial(removeEntry)
    guard(); stopDispatch(); stopPost(); stopTurn(); stopAgent()
  } }
}

export function apply(ctx: Context, config: ConfigShape): void {
  let current = (): ConfigShape => config
  const entryIds = new Map<string, string>()
  const fingerprints = new Map<string, string>()
  const failures = new Map<string, string>()
  let reconcileTail = Promise.resolve()
  let oauthTail = Promise.resolve()

  const oauthSerial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = oauthTail.catch(() => undefined).then(task)
    oauthTail = run.then(() => undefined, () => undefined)
    return run
  }

  const xin = createXinConnection(ctx, {
    authorize: lease => oauthSerial(() => authorizeOAuth(ctx, MCP_CATALOG.get(XIN_SERVICE)!, lease.signal, lease)).then(() => {}),
    token: lease => oauthSerial(() => currentOAuthToken(ctx, MCP_CATALOG.get(XIN_SERVICE)!, lease)),
    confirm: (signal, agent) => confirmed(ctx, '连接并授权芯助手？', '使用芯助手本人授权连接企业业务与知识服务。', signal, agent),
    configured: () => current().servers.some(spec => spec.name === XIN_SERVICE && supportedServer(spec)),
    install: () => ctx.settings.update(SETTINGS_NAMESPACE, { servers: [...current().servers.filter(spec => spec.name !== XIN_SERVICE), MCP_CATALOG.get(XIN_SERVICE)!] }),
  })
  ctx.on('credentials/updated', ref => {
    if (String(ref) === 'E_MATE_ENTERPRISE_SESSION') {
      xin.changed()
      ctx.timeout(() => { xin.changed(); if (current().servers.some(spec => spec.name === XIN_SERVICE)) void xin.ensure({}, { interactive: false }) }, 0)
    }
    if (String(ref).startsWith('EMATE_MCP_XIN_')) void xin.ensure({}, { interactive: false })
  })
  ctx.effect(() => () => xin.dispose(), 'mcp-manage: account-bound Xin lifecycle')

  const status = async (exec: XinExecution = {}) => Promise.all(current().servers.map(async spec => {
    if (spec.name === XIN_SERVICE) return xin.status(exec)
    if (!supportedServer(spec)) {
      return { name: spec.name, transport: spec.transport, active: false, authorized: false, error: UNSUPPORTED_MCP }
    }
    const authorized = spec.auth === 'none'
      || (spec.auth === 'bearer'
        ? (await ctx.credentials.describe(tokenRef(spec.name))).configured
        : await readOAuthState(ctx, spec.name).then(state => state.tokens?.access_token !== undefined, () => false))
    const active = isMcpServerActive(ctx.loader, ctx.tools, entryIds.get(spec.name), spec.name)
    return {
      name: spec.name,
      transport: spec.transport,
      active,
      authorized,
      ...(failures.has(spec.name) ? { error: failures.get(spec.name) } : {}),
    }
  }))

  const reconcile = async (): Promise<void> => {
    const wanted = new Map(current().servers.filter(supportedServer).filter(spec => spec.name !== XIN_SERVICE).map(spec => [spec.name, spec]))
    for (const [serverName, entryId] of [...entryIds]) {
      if (wanted.has(serverName)) continue
      await ctx.loader.remove(entryId)
      entryIds.delete(serverName)
      fingerprints.delete(serverName)
      failures.delete(serverName)
    }
    for (const spec of wanted.values()) {
      failures.delete(spec.name)
      let token = ''
      if (spec.auth === 'bearer') token = (await ctx.credentials.resolve(tokenRef(spec.name)))?.value ?? ''
      if (spec.auth === 'oauth') {
        try { token = await currentOAuthToken(ctx, spec) } catch (error) {
          failures.set(spec.name, error instanceof Error ? error.message : 'OAuth 凭据无效。')
        }
      }
      if (spec.auth !== 'none' && token === '') {
        const entryId = entryIds.get(spec.name)
        if (entryId !== undefined) await ctx.loader.remove(entryId)
        entryIds.delete(spec.name)
        fingerprints.delete(spec.name)
        continue
      }
      const nativeConfig = {
        transport: 'streamable-http', serverName: spec.name, url: spec.url,
        headers: token === '' ? {} : { Authorization: spec.name === 'tencent_docs' ? token : `Bearer ${token}` },
        toolCallTimeoutMs: 60_000, failOnStartupError: true,
        reconnect: { enabled: true, initialDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 1000 },
      }
      const fingerprint = JSON.stringify(nativeConfig)
      if (fingerprints.get(spec.name) === fingerprint) continue
      const entryId = entryIds.get(spec.name) ?? `emate-mcp-${spec.name}`
      const updating = entryIds.has(spec.name)
      try {
        if (updating) await ctx.loader.update(entryId, { config: nativeConfig })
        else await ctx.loader.create({ id: entryId, name: MCP_CLIENT, config: nativeConfig } as never)
        entryIds.set(spec.name, entryId)
        fingerprints.set(spec.name, fingerprint)
      } catch (error) {
        if (!updating) {
          entryIds.delete(spec.name)
          fingerprints.delete(spec.name)
        }
        failures.set(spec.name, error instanceof Error ? error.message : 'MCP 连接失败。')
      }
    }
  }

  const reconcileSerial = (): Promise<void> => {
    reconcileTail = reconcileTail.catch(() => undefined).then(reconcile)
    return reconcileTail
  }

  installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config, {
    setSource(source) { current = source },
    onChange() { void reconcileSerial(); if (current().servers.some(spec => spec.name === XIN_SERVICE)) void xin.ensure({}, { interactive: false }) },
    validate: validateConfig,
  })
  ctx.on('credentials/updated', ref => {
    if (String(ref).startsWith('EMATE_MCP_')) void reconcileSerial()
  })
  ctx.interval(() => {
    if (current().servers.some(spec => spec.auth === 'oauth' && spec.name !== XIN_SERVICE)) void reconcileSerial()
    if (current().servers.some(spec => spec.name === XIN_SERVICE)) void xin.ensure({}, { interactive: false })
  }, 60_000)

  ctx.effect(() => () => Promise.all([...entryIds.values()].map(id => ctx.loader.remove(id))), 'mcp-manage: native client entries')

  ctx.effect(() => ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint, payload, signal) => {
      if (!exactObject(payload) || Object.keys(payload).length !== 0) {
        return { ok: false, error: { code: 'bad-request', message: 'MCP 查询参数无效。', details: { issues: [] } } }
      }
      if (endpoint === 'xin.status') return { ok: true, value: await xin.status() }
      if (endpoint === 'xin.ensure') return { ok: true, value: await xin.ensure({ signal }) }
      if (endpoint === 'xin.disconnect') return { ok: true, value: await xin.disconnect({ signal }) }
      if (endpoint === 'feishu.status') {
        return { ok: true, value: await readFeishuConnection(ctx.get('desktopPnpm') as DesktopPnpmLike | undefined, signal) }
      }
      if (endpoint !== 'active' && endpoint !== 'list') {
        return { ok: false, error: { code: 'not-found', message: 'MCP 查询不存在。', details: { issues: [] } } }
      }
      const items = await status()
      return { ok: true, value: { schema_version: 1, items: endpoint === 'active' ? items.filter(item => item.active) : items } }
    },
    { authority: 'loopback' },
  ), 'mcp-manage: loopback connection projection')

  ctx.systemPrompt.section({
    name: 'emate:mcp-manage',
    order: 181,
    text: 'When a user asks for a capability that is not installed, use skill_find for discovery and Skill Hub for Skill lifecycle. A selected Skill may call dsh_plugin_manage to install an audited DSH bundle pinned to one exact GitHub commit; that tool uses the Desktop native plugin CLI, preserves the managed profile, and restarts e-Mate. If the Skill requires an MCP server, call mcp_manage only for an audited HTTPS catalog entry. For xin-business-assistant call mcp_manage ensure first: UI and Agent share the same current-account connection; do not reconnect an already ready service. Prefer OAuth: mcp_manage opens the provider authorization page and stores credentials without exposing authorization URLs, codes, or tokens to the Agent. Never ask for tokens in chat. Only report an MCP connection effective when mcp_manage list returns active=true.',
  })

  ctx.tools.register(defineTool({
    name: 'dsh_plugin_manage',
    description: 'List, install, or remove an audited optional DSH profile bundle through the Desktop native dsh plugin runtime. The source is resolved from the trusted application catalog, never from model arguments.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'install', 'remove'] },
      packageName: { type: 'string' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const { pnpm, runtime } = desktopServices(ctx)
      if (args.action === 'list') {
        const manifest = await profileManifest(pnpm)
        return {
          status: 'listed',
          plugins: Object.keys(manifest.dependencies).map(packageName => ({
            packageName,
            active: manifest.bundles.includes(packageName),
          })),
        }
      }
      const packageName = args.packageName ?? ''
      if (PROTECTED_PLUGIN_NAMES.has(packageName)
        || PROTECTED_PLUGIN_PREFIXES.some(prefix => packageName.startsWith(prefix))) {
        throw new Error('e-Mate 与 DSH 托管插件不能通过按需插件工具修改。')
      }
      if (args.action === 'remove') {
        validatePluginPackageName(packageName)
        const before = await profileManifest(pnpm)
        if (before.dependencies[packageName] === undefined) {
          return { status: 'not-found', packageName }
        }
        if (!await confirmed(ctx, `删除按需 DSH 插件“${packageName}”并重启 e-Mate？`, packageName, exec.signal, exec.agent)) {
          return { status: 'cancelled', packageName }
        }
        await runProfilePlugin(pnpm, ['remove', packageName], exec.signal)
        const after = await profileManifest(pnpm)
        if (after.dependencies[packageName] !== undefined || after.bundles.includes(packageName)) {
          throw new Error('DSH 插件删除后仍在 profile 中。')
        }
        ctx.timeout(() => { void runtime.requestRestart().catch(() => {}) }, 2_000)
        return { status: 'removed', packageName, restart: 'scheduled' }
      }
      const source = AUDITED_PLUGIN_SOURCES.get(packageName) ?? ''
      validatePluginInstall(packageName, source)
      if (!await confirmed(ctx, `安装按需 DSH 插件“${packageName}”并重启 e-Mate？`, packageName, exec.signal, exec.agent)) {
        return { status: 'cancelled', packageName }
      }
      const receiptId = `mcp-manage:${randomBytes(16).toString('hex')}`
      try {
        await runProfilePlugin(pnpm, ['add', '--save-exact', source], exec.signal, {
          packageName,
          packageVersion: source,
          receiptId,
        })
        const after = await profileManifest(pnpm)
        if (after.dependencies[packageName] !== source || !after.bundles.includes(packageName)) {
          throw new Error('DSH 插件没有作为 profile bundle 激活。')
        }
      } catch (error) {
        await pnpm.rollbackPluginInstall(receiptId)
        throw error
      }
      ctx.timeout(() => { void runtime.requestRestart().catch(() => {}) }, 2_000)
      return { status: 'installed', packageName, restart: 'scheduled' }
    },
  }))

  const authorizeConnection = async (
    spec: McpServerSpec,
    signal?: AbortSignal,
    agent?: UserQuestionAgent,
  ): Promise<void> => {
    if (spec.auth === 'bearer') {
      let token = ''
      if (spec.name === 'tencent_docs') {
        await openExternal(ctx, TENCENT_DOCS_AUTH_URL, signal)
        const answer = await ctx.userQuestions.ask({
          agent,
          questions: [{
            id: 'token', header: '腾讯文档',
            question: '请在浏览器登录或扫码，点击“复制”获取 MCP Token，然后回到这里继续。Token 只会从系统剪贴板写入本机凭据库。',
            options: [
              { label: '已复制，连接', description: '从系统剪贴板安全导入并验证连接。' },
              { label: '取消', description: '不保存任何凭据或连接。' },
            ],
          }],
          signal,
        })
        if (answer.answers[0]?.selected.includes('已复制，连接') !== true) throw new Error('用户未完成腾讯文档授权。')
        token = await clipboardText(ctx, signal)
      } else {
        const answer = await ctx.userQuestions.ask({
          agent,
          questions: [{ id: 'token', header: '安全授权', question: `请输入“${spec.name}”的 Bearer Token。该值只写入本机 DSH 凭据库，不会发送给 Agent。` }],
          signal,
        })
        token = answerText(answer)
      }
      if (token === '' || token.length > TOKEN_MAX || /[\r\n]/u.test(token)) throw new Error('Bearer Token 无效。')
      await ctx.credentials.set(tokenRef(spec.name), token)
    } else if (spec.auth === 'oauth') {
      await oauthSerial(() => authorizeOAuth(ctx, spec, signal))
    }
  }

  const restoreCredential = async (ref: ReturnType<typeof credentialRef>, previous: { value: string } | undefined) => {
    if (previous === undefined) await ctx.credentials.unset(ref)
    else await ctx.credentials.set(ref, previous.value)
  }

  ctx.tools.register(defineTool({
    name: 'mcp_manage',
    description: 'List, install, connect, ensure, or remove audited HTTPS MCP catalog entries through DSH Settings, Credentials, Loader, and the native dsh-mcp-client runtime. OAuth opens the provider page and keeps URLs, codes, and tokens outside model arguments and results.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'install', 'connect', 'ensure', 'remove'] },
      name: { type: 'string' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (args.action === 'list') return { status: 'listed', connections: await status(exec) }
      if (args.name === undefined || !SERVER_NAME.test(args.name)) throw new Error('必须提供有效的 MCP 名称。')
      if (args.name === XIN_SERVICE) {
        if (args.action === 'remove') return xin.disconnect(exec)
        return xin.ensure(exec, { reauthorize: args.action === 'connect' })
      }
      if (args.action === 'ensure') throw new Error('ensure 仅用于芯助手受审计连接。')
      if (args.action === 'remove') {
        const existing = current().servers.find(item => item.name === args.name)
        if (existing === undefined) return { status: 'not-found', connections: await status(exec) }
        if (!await confirmed(ctx, `删除 MCP 连接“${args.name}”？`, JSON.stringify(existing, null, 2), exec.signal, exec.agent)) {
          return { status: 'cancelled', connections: await status(exec) }
        }
        await ctx.settings.update(SETTINGS_NAMESPACE, { servers: current().servers.filter(item => item.name !== args.name) })
        await reconcileSerial()
        await Promise.all([ctx.credentials.unset(tokenRef(args.name)), ctx.credentials.unset(oauthRef(args.name))])
        return { status: 'removed', connections: await status(exec) }
      }
      if (args.action === 'connect') {
        const existing = current().servers.find(item => item.name === args.name)
        if (existing === undefined) throw new Error(`MCP 连接不存在：${args.name}`)
        if (!supportedServer(existing)) throw new Error(UNSUPPORTED_MCP)
        if (existing.auth === 'none') {
          await reconcileSerial()
          const item = (await status()).find(candidate => candidate.name === existing.name)
          if (item?.active !== true) throw new Error(item?.error ?? 'MCP 连接未能激活。')
          return { status: 'connected', connections: await status(exec) }
        }
        if (!await confirmed(ctx, `连接并授权 MCP“${args.name}”？`, JSON.stringify(existing, null, 2), exec.signal, exec.agent)) {
          return { status: 'cancelled', connections: await status(exec) }
        }
        const token = await ctx.credentials.resolve(tokenRef(args.name)).catch(() => undefined)
        const oauth = await ctx.credentials.resolve(oauthRef(args.name)).catch(() => undefined)
        try {
          await authorizeConnection(existing, exec.signal, exec.agent)
          await reconcileSerial()
          const item = (await status()).find(candidate => candidate.name === existing.name)
          if (item?.active !== true) throw new Error(item?.error ?? 'MCP 连接未能激活。')
          return { status: 'connected', connections: await status(exec) }
        } catch (error) {
          await Promise.all([
            restoreCredential(tokenRef(args.name), token),
            restoreCredential(oauthRef(args.name), oauth),
          ])
          await reconcileSerial()
          throw error
        }
      }
      const spec = MCP_CATALOG.get(args.name)
      if (spec === undefined) throw new Error('该 MCP 不在 2.0.18 受审计 HTTPS catalog 中。')
      validateServer(spec)
      if (current().servers.some(item => item.name === spec.name)) throw new Error(`MCP 连接已存在：${spec.name}`)
      if (!await confirmed(ctx, `安装 MCP 连接“${spec.name}”？`, JSON.stringify(spec, null, 2), exec.signal, exec.agent)) {
        return { status: 'cancelled', connections: await status(exec) }
      }
      const previousServers = current().servers
      const previousToken = await ctx.credentials.resolve(tokenRef(spec.name)).catch(() => undefined)
      const previousOauth = await ctx.credentials.resolve(oauthRef(spec.name)).catch(() => undefined)
      try {
        await authorizeConnection(spec, exec.signal, exec.agent)
        await ctx.settings.update(SETTINGS_NAMESPACE, { servers: [...previousServers, spec] })
        await reconcileSerial()
        const item = (await status()).find(candidate => candidate.name === spec.name)
        if (item?.active !== true) throw new Error(item?.error ?? 'MCP 连接未能激活。')
        return { status: 'installed', connections: await status(exec) }
      } catch (error) {
        try {
          await ctx.settings.update(SETTINGS_NAMESPACE, { servers: previousServers })
          await reconcileSerial()
          await Promise.all([
            restoreCredential(tokenRef(spec.name), previousToken),
            restoreCredential(oauthRef(spec.name), previousOauth),
          ])
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'MCP 安装失败且回滚未完成。')
        }
        throw error
      }
    },
  }))
}
