import { randomBytes } from 'node:crypto'
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
import { isMcpServerActive } from './status.ts'
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
const MCP_CATALOG = new Map<string, McpServerSpec>([
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

async function readOAuthState(ctx: Context, name: string): Promise<OAuthCredentialState> {
  const raw = (await ctx.credentials.resolve(oauthRef(name)))?.value
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

async function writeOAuthState(ctx: Context, name: string, state: OAuthCredentialState): Promise<void> {
  const value = JSON.stringify(state)
  if (value.length > OAUTH_STATE_MAX) throw new Error('OAuth 凭据超过安全上限。')
  await ctx.credentials.set(oauthRef(name), value)
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
): Promise<OAuthClientProvider> {
  const saved = await readOAuthState(ctx, spec.name)
  let codeVerifier = ''
  const persist = () => writeOAuthState(ctx, spec.name, saved)
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

async function authorizeOAuth(ctx: Context, spec: McpServerSpec, signal?: AbortSignal): Promise<string> {
  const stateNonce = randomBytes(32).toString('base64url')
  const callback = await startOAuthCallback(spec.name, stateNonce, signal)
  try {
    const provider = await oauthProvider(ctx, spec, callback.redirectUrl, stateNonce, url => openExternal(ctx, url, signal))
    const first = await authorizeMcp(provider, {
      serverUrl: spec.url,
      ...(spec.oauthScope === '' ? {} : { scope: spec.oauthScope }),
      fetchFn: secureOAuthFetch,
    })
    if (first === 'REDIRECT') {
      const code = await callback.result
      const completed = await authorizeMcp(provider, {
        serverUrl: spec.url,
        authorizationCode: code,
        ...(spec.oauthScope === '' ? {} : { scope: spec.oauthScope }),
        fetchFn: secureOAuthFetch,
      })
      if (completed !== 'AUTHORIZED') throw new Error('外部服务授权未完成。')
    }
    const token = (await readOAuthState(ctx, spec.name)).tokens?.access_token ?? ''
    if (token === '') throw new Error('外部服务未返回可用凭据。')
    return token
  } finally {
    await callback.close()
  }
}

async function refreshOAuth(ctx: Context, spec: McpServerSpec): Promise<string> {
  const provider = await oauthProvider(ctx, spec, oauthCallbackUrl(spec.name), randomBytes(32).toString('base64url'), async () => {
    throw new Error('OAuth 授权已过期，请重新连接。')
  })
  const result = await authorizeMcp(provider, {
    serverUrl: spec.url,
    ...(spec.oauthScope === '' ? {} : { scope: spec.oauthScope }),
    fetchFn: secureOAuthFetch,
  })
  if (result !== 'AUTHORIZED') throw new Error('OAuth 授权已过期，请重新连接。')
  return (await readOAuthState(ctx, spec.name)).tokens?.access_token ?? ''
}

async function currentOAuthToken(ctx: Context, spec: McpServerSpec): Promise<string> {
  const state = await readOAuthState(ctx, spec.name)
  const token = state.tokens?.access_token ?? ''
  if (token === '') return ''
  if (state.expires_at === undefined || state.expires_at > Date.now() + OAUTH_REFRESH_SKEW_MS) return token
  if (state.tokens?.refresh_token !== undefined) {
    try { return await refreshOAuth(ctx, spec) } catch {
      if (state.expires_at > Date.now()) return token
      return ''
    }
  }
  return state.expires_at > Date.now() ? token : ''
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

  const status = async () => Promise.all(current().servers.map(async spec => {
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
    const wanted = new Map(current().servers.filter(supportedServer).map(spec => [spec.name, spec]))
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
    onChange() { void reconcileSerial() },
    validate: validateConfig,
  })
  ctx.on('credentials/updated', ref => {
    if (String(ref).startsWith('EMATE_MCP_')) void reconcileSerial()
  })
  ctx.interval(() => {
    if (current().servers.some(spec => spec.auth === 'oauth')) void reconcileSerial()
  }, 60_000)

  ctx.effect(() => () => Promise.all([...entryIds.values()].map(id => ctx.loader.remove(id))), 'mcp-manage: native client entries')

  ctx.effect(() => ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint, payload, signal) => {
      if (!exactObject(payload) || Object.keys(payload).length !== 0) {
        return { ok: false, error: { code: 'bad-request', message: 'MCP 查询参数无效。', details: { issues: [] } } }
      }
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
    text: 'When a user asks for a capability that is not installed, use skill_find for discovery and Skill Hub for Skill lifecycle. A selected Skill may call dsh_plugin_manage to install an audited DSH bundle pinned to one exact GitHub commit; that tool uses the Desktop native plugin CLI, preserves the managed profile, and restarts e-Mate. If the Skill requires an MCP server, call mcp_manage only for an audited HTTPS catalog entry. Prefer OAuth: mcp_manage opens the provider authorization page and stores credentials without exposing authorization URLs, codes, or tokens to the Agent. Never ask for tokens in chat. Only report an MCP connection effective when mcp_manage list returns active=true.',
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
    description: 'List, install, connect, or remove audited HTTPS MCP catalog entries through DSH Settings, Credentials, Loader, and the native dsh-mcp-client runtime. OAuth opens the provider page and keeps URLs, codes, and tokens outside model arguments and results.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'install', 'connect', 'remove'] },
      name: { type: 'string' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (args.action === 'list') return { status: 'listed', connections: await status() }
      if (args.name === undefined || !SERVER_NAME.test(args.name)) throw new Error('必须提供有效的 MCP 名称。')
      if (args.action === 'remove') {
        const existing = current().servers.find(item => item.name === args.name)
        if (existing === undefined) return { status: 'not-found', connections: await status() }
        if (!await confirmed(ctx, `删除 MCP 连接“${args.name}”？`, JSON.stringify(existing, null, 2), exec.signal, exec.agent)) {
          return { status: 'cancelled', connections: await status() }
        }
        await ctx.settings.update(SETTINGS_NAMESPACE, { servers: current().servers.filter(item => item.name !== args.name) })
        await reconcileSerial()
        await Promise.all([ctx.credentials.unset(tokenRef(args.name)), ctx.credentials.unset(oauthRef(args.name))])
        return { status: 'removed', connections: await status() }
      }
      if (args.action === 'connect') {
        const existing = current().servers.find(item => item.name === args.name)
        if (existing === undefined) throw new Error(`MCP 连接不存在：${args.name}`)
        if (!supportedServer(existing)) throw new Error(UNSUPPORTED_MCP)
        if (existing.auth === 'none') {
          await reconcileSerial()
          const item = (await status()).find(candidate => candidate.name === existing.name)
          if (item?.active !== true) throw new Error(item?.error ?? 'MCP 连接未能激活。')
          return { status: 'connected', connections: await status() }
        }
        if (!await confirmed(ctx, `连接并授权 MCP“${args.name}”？`, JSON.stringify(existing, null, 2), exec.signal, exec.agent)) {
          return { status: 'cancelled', connections: await status() }
        }
        const token = await ctx.credentials.resolve(tokenRef(args.name)).catch(() => undefined)
        const oauth = await ctx.credentials.resolve(oauthRef(args.name)).catch(() => undefined)
        try {
          await authorizeConnection(existing, exec.signal, exec.agent)
          await reconcileSerial()
          const item = (await status()).find(candidate => candidate.name === existing.name)
          if (item?.active !== true) throw new Error(item?.error ?? 'MCP 连接未能激活。')
          return { status: 'connected', connections: await status() }
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
        return { status: 'cancelled', connections: await status() }
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
        return { status: 'installed', connections: await status() }
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
