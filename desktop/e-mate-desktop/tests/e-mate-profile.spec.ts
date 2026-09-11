import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import { HostConnectionService, serverResponseSchema } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { prepareDesktopProfile } from '../src/profile.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'emate/expert-mode': { active: boolean } }
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** The image limits a Host context's attachment service declares for projections. */
const TEST_IMAGE_LIMITS = Object.freeze({
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageDimension: 2000,
  mediaTypes: Object.freeze(['image/png'] as const),
})

/**
 * Provide the capability services the 0.1.5 Session owner injects but these
 * expert-mode scenarios never reach. 0.1.5 deleted
 * `@deepseek-ai/dsh-host-apiproxy`; the renderer-facing Session surface is now
 * `@deepseek-ai/dsh-api-session-controller` (`session/create`), whose inject
 * list assumes a complete Host composition.
 * @param ctx - hand-built Host context mounting the Session owner.
 */
function installSessionApiCapabilities(ctx: Context): void {
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'unused', model: 'unused' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  ctx.provide('attachments', { imageLimits: TEST_IMAGE_LIMITS } as never)
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {} } as never)
  ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
  ctx.provide('typert', {
    lookups: { configure: () => () => {} },
    contexts: { configureHost: () => () => {} },
  } as never)
}

/**
 * The composed profile mounts the `session-query-sqlite` provider row, which is not a
 * declared dependency of this package; the spec mounts the declared engine base and
 * implements the two search methods these scenarios never call.
 */
class ExpertModeSessionQuery extends SessionQueryEngine {
  override searchSessions(): never {
    throw new Error('the expert-mode scenarios do not search Sessions')
  }

  override searchEvents(): never {
    throw new Error('the expert-mode scenarios do not search Session events')
  }
}

/**
 * Mount the 0.1.5 owner of the renderer-facing `session/create` Remote method.
 * @param ctx - Host context carrying the Session owner's capability services.
 * @returns the controller fiber to keep in the scenario's disposal list.
 */
function mountSessionController(ctx: Context) {
  return ctx.plugin(SessionController, { nativeOpen: false })
}

/**
 * Answer the retired host API proxy key through the 0.1.5 owner. The composed
 * `emate-agent-operations` row still resumes a Session by calling
 * `ctx.get('apiProxy').sessions.create(...)`
 * (`packages/dsh/src/profile/agent-operations.ts:45`); that plugin's own
 * migration onto `ctx.sessionController` is owned outside this spec, so the
 * scenarios bind the key it reads to the same controller the migrated call uses.
 * @param ctx - Host context with the Session Controller mounted.
 */
function provideHostApiProxySeam(ctx: Context): void {
  ctx.provide('apiProxy', {
    sessions: {
      create: async (request: {
        readonly rpcId: string
        readonly payload: { readonly sessionId: SessionId; readonly cwd: string }
      }) => {
        try {
          return {
            rpcId: request.rpcId,
            result: { ok: true as const, value: await ctx.sessionController.create(request.payload) },
          }
        } catch (error) {
          const remote = error as { code?: string; message?: string; details?: Record<string, unknown> }
          return {
            rpcId: request.rpcId,
            result: {
              ok: false as const,
              error: {
                code: remote.code ?? 'internal',
                message: remote.message ?? String(error),
                details: remote.details ?? {},
              },
            },
          }
        }
      },
    },
  })
}

/**
 * Authorize the loopback requests these scenarios drive. They exercise the Host
 * Connection trust fence (the untrusted-origin refusal), not the browser cookie
 * handshake that owns its own upstream coverage.
 * @returns the browser-authentication seam the connection carrier reads.
 */
function loopbackBrowserAuth(): ConstructorParameters<typeof HostConnectionService>[2] {
  return {
    isAuthenticated: () => true,
  } as unknown as ConstructorParameters<typeof HostConnectionService>[2]
}

/**
 * Read one stored Session's `emate/expert-mode` payloads in append order.
 * @param events - events read through a persistence read handle.
 * @returns each recorded expert-mode state.
 */
function expertModeStates(events: readonly SessionEvent[]): readonly { active: boolean }[] {
  return events.flatMap(event => event.type === 'emate/expert-mode' ? [event.data] : [])
}

// Complete Windows payloads are physical copies: cold installation alone takes
// ~53s on the native runner. This is an integration deadline, not a latency SLA.
describe('e-Mate desktop profile', { timeout: process.platform === 'win32' ? 120_000 : 30_000 }, () => {
  type ProfileModule = typeof import('../src/e-mate-profile.ts')
  let EMATE_DESKTOP_PROFILE_VERSION: ProfileModule['EMATE_DESKTOP_PROFILE_VERSION']
  let EMATE_MANAGED_PROFILE_CLEANUP_MAX_ATTEMPTS: ProfileModule['EMATE_MANAGED_PROFILE_CLEANUP_MAX_ATTEMPTS']
  let EMATE_BUNDLED_PROFILE_COMPONENT_IDS: ProfileModule['EMATE_BUNDLED_PROFILE_COMPONENT_IDS']
  let cleanupEmateDesktopProfileArtifact: ProfileModule['cleanupEmateDesktopProfileArtifact']
  let installEmateDesktopProfile: ProfileModule['installEmateDesktopProfile']
  let packagedSource: string
  // Navigation source checks do not need a built profile; installation checks do.
  // Copy/cleanup includes bundled Skill assets; these hooks are not startup measurements.
  beforeAll(async () => {
    packagedSource = mkdtempSync(join(tmpdir(), 'e-mate-packaged-profile-'))
    // Match electron-builder's declaration exclusion without mutating shared build resources.
    cpSync(fileURLToPath(new URL('../build/e-mate-profile/', import.meta.url)), packagedSource, {
      recursive: true, dereference: true, filter: source => !source.endsWith('.d.ts'),
    })
    const runtimePaths = await import('../src/packaged-runtime-path.ts')
    vi.doMock('../src/packaged-runtime-path.ts', () => ({
      ...runtimePaths,
      unpackedAsarPath: (path: string) => path === fileURLToPath(new URL('../build/e-mate-profile/', import.meta.url))
        ? packagedSource : runtimePaths.unpackedAsarPath(path),
    }))
    ;({ EMATE_DESKTOP_PROFILE_VERSION, EMATE_MANAGED_PROFILE_CLEANUP_MAX_ATTEMPTS,
      EMATE_BUNDLED_PROFILE_COMPONENT_IDS, cleanupEmateDesktopProfileArtifact,
      installEmateDesktopProfile } = await import('../src/e-mate-profile.ts'))
  }, 60_000)

  afterAll(() => {
    vi.doUnmock('../src/packaged-runtime-path.ts')
    if (packagedSource) rmSync(packagedSource, { recursive: true, force: true })
  }, 60_000)

  it('installs the fixed product profile and replaces legacy CLI update guidance', async () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)

    const profile = installEmateDesktopProfile(home)
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dependencies).toEqual({})
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      ...EMATE_BUNDLED_PROFILE_COMPONENT_IDS.filter(id => id.startsWith('@e-mate/dsh-plugin-')),
      'dsh-at-file',
      'dsh-file-viewer',
      'dsh-visualize',
    ])
    expect(manifest.dsh.profile.bundles).not.toContain('@e-mate/dsh-plugin-im')
    expect(manifest.dsh.profile.bundles).toContain('@e-mate/dsh-plugin-vision-toolkit')
    expect(manifest.dsh.profile.bundles).toContain('@e-mate/dsh-plugin-better-sidebar')
    expect(manifest.dsh.profile.bundles).toContain('@e-mate/dsh-plugin-genui')
    expect(manifest.dsh.profile.bundles).not.toContain('@e-mate/dsh-plugin-xin-assistant')
    expect(manifest.dsh.profile.bundles).not.toContain('@e-mate/dsh-plugin-search-mcp')
    expect(manifest.dsh.profile.bundles).not.toContain('dsh-search-mcp')
    expect(manifest.dsh.profile.bundles).not.toContain('@e-mate/dsh-plugin-subagent')
    expect(manifest.dsh.profile.bundles).toContain('@e-mate/dsh-plugin-tidychat')
    expect(manifest.dsh.profile.bundles).not.toContain('@kelearns/dsh-navigation-bar')
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-genui', 'lib', 'client.js'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-vision-toolkit', 'lib', 'index.mjs'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-cdp', 'lib', 'index.mjs'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-skill-hub', 'lib', 'index.js'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-tool-search', 'lib', 'index.mjs'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-schedules', 'lib', 'index.js'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-file-import', 'lib', 'client.js'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-computer-use', 'lib', 'client.js'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-find-skill', 'lib', 'index.js'))).toBe(true)
    const findSkillPatch = readFileSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-find-skill', 'cordis.patch.yml'), 'utf8')
    expect(findSkillPatch).toContain("cliCommand: 'pnpm dlx skills@1.5.22'")
    expect(findSkillPatch).toContain('/tree/skills-v2.0.12-r1/skills/connect-feishu-cli')
    expect(findSkillPatch).not.toContain('/tree/main/skills/connect-feishu-cli')
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-mcp-manage', 'lib', 'index.mjs'))).toBe(true)
    const supportSkills = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-office-skills')
    expect(existsSync(join(supportSkills, 'lib', 'index.js'))).toBe(true)
    expect(existsSync(join(supportSkills, 'lib', 'client.js'))).toBe(false)
    expect(existsSync(join(supportSkills, 'assets'))).toBe(false)
    for (const skill of ['documents', 'pdf', 'spreadsheets', 'ppt-master']) {
      expect(existsSync(join(supportSkills, 'skills', skill))).toBe(false)
    }
    for (const skill of ['meeting-summary', 'lieflat-charts']) {
      expect(existsSync(join(supportSkills, 'skills', skill, 'SKILL.md'))).toBe(true)
    }
    expect(manifest.dsh.profile.bundles).not.toContain('@e-mate/dsh-plugin-univer-office')
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-univer-office'))).toBe(false)
    expect(existsSync(join(profile, 'node_modules', 'dsh-univer-office'))).toBe(false)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-xin-assistant'))).toBe(false)
    expect(existsSync(join(profile, 'node_modules', 'dsh-at-file', 'lib', 'client.js'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-better-sidebar', 'lib', 'client.js'))).toBe(true)
    expect(existsSync(join(profile, 'node_modules', 'dsh-better-sidebar'))).toBe(false)
    expect(existsSync(join(profile, 'node_modules', 'dsh-file-viewer', 'lib', 'client.js'))).toBe(true)
    const fileViewerHost = readFileSync(join(profile, 'node_modules', 'dsh-file-viewer', 'lib', 'index.js'), 'utf8')
    const fileViewerClient = readFileSync(join(profile, 'node_modules', 'dsh-file-viewer', 'lib', 'client.js'), 'utf8')
    expect(fileViewerHost).toContain('/usr/bin/open')
    expect(fileViewerHost).toContain('Invoke-Item -LiteralPath $env:E_MATE_OPEN_PATH')
    expect(fileViewerClient).not.toContain('"file-viewer: file open router"')
    expect(fileViewerClient).toContain('name: "conversation.session.header.actions"')
    expect(fileViewerClient).toContain('coordinator.openInSystem(sessionId, path)')
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-search-mcp'))).toBe(false)
    expect(existsSync(join(profile, 'node_modules', 'dsh-search-mcp'))).toBe(false)
    expect(existsSync(join(profile, 'node_modules', 'dsh-turn-fold'))).toBe(false)
    expect(existsSync(join(profile, 'node_modules', 'dsh-visualize', 'lib', 'client.js'))).toBe(true)
    expect(existsSync(join(home, 'browser-extension'))).toBe(false)
    mkdirSync(join(home, 'browser-extension'))
    writeFileSync(join(home, 'ext-bridge-token'), 'retired-token')
    installEmateDesktopProfile(home)
    expect(existsSync(join(home, 'browser-extension'))).toBe(false)
    expect(existsSync(join(home, 'ext-bridge-token'))).toBe(false)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-browser'))).toBe(false)
    expect(existsSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-browser-panel'))).toBe(false)
    expect(existsSync(join(profile, 'plugins', 'runtime-binding.json'))).toBe(true)
    const runtimeBinding = JSON.parse(readFileSync(join(profile, 'plugins', 'runtime-binding.json'), 'utf8')) as {
      version?: string
      schedule_module?: string
      schedule_module_sha256?: string
      compaction_module?: string
      compaction_module_sha256?: string
    }
    expect(runtimeBinding.version).toBe(EMATE_DESKTOP_PROFILE_VERSION)
    expect(runtimeBinding.schedule_module).toContain(join('@deepseek-ai', 'dsh-schedule'))
    expect(runtimeBinding.schedule_module_sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(runtimeBinding.compaction_module).toContain(join('@deepseek-ai', 'dsh-compaction'))
    expect(runtimeBinding.compaction_module_sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe(
      'ui-theme:\n  preference: dark\nagent-default-model:\n  provider: e-mate-enterprise\n  model: gpt-5.6-luna\n  reasoningEffort: max\n',
    )

    const prepared = await prepareDesktopProfile(undefined, home, process.platform, 'e-mate')
    const rows = composeEntries([prepared.patches])
    expect(prepared.profile.name).toBe('e-mate')
    expect(prepared.mode).toBe(process.platform === 'linux' ? 'compatibility' : 'advanced')
    expect(rows.find(row => row.id === 'desktop-agent-update')).toEqual(expect.objectContaining({
      name: '@e-mate/desktop/agent-update',
    }))
    expect(rows.find(row => row.id === 'desktop-agent-update')?.disabled).not.toBe(true)
    expect(rows.map(row => row.id)).not.toContain('desktop-computer-use-setup')
    expect(rows.find(row => row.id === 'emate-cdp')).toEqual(expect.objectContaining({
      name: '@e-mate/dsh-plugin-cdp',
    }))
    expect(rows.map(row => row.id)).not.toContain('bridge-browser')
    expect(rows.find(row => row.id === 'emate-genui')).toEqual(expect.objectContaining({
      name: '@e-mate/dsh-plugin-genui',
    }))
    expect(rows.map(row => row.id)).not.toContain('genui')
    expect(rows.find(row => row.id === 'vision-toolkit')).toEqual(expect.objectContaining({
      name: '@e-mate/dsh-plugin-vision-toolkit',
    }))
    expect(rows.map(row => row.id)).not.toContain('desktop-vision-toolkit')
    // Every product component the inventory declares must be materialized into this
    // profile by name. The desktop previously rewrote those names to a relative path
    // that 0.1.5 resolves beside the declaring patch file, which silently doubled the
    // path for seven components and left them unable to load.
    const inventory = JSON.parse(readFileSync(
      new URL('../../../packages/dsh/profile/component-inventory.json', import.meta.url),
      'utf8',
    )) as { components: Array<{ id: string }> }
    const composedNames = new Set(rows.map(row => row.name))
    const missing = inventory.components
      .map(component => component.id)
      // The client shell is not a Loader row: the desktop materializes it as the
      // profile's own shell plugin directory instead.
      .filter(id => id !== '@e-mate/dsh-client-shell')
      .filter(id => !composedNames.has(id))
    expect(missing, 'product components missing from the composed desktop profile').toEqual([])
    expect(existsSync(join(home, 'profiles', 'e-mate', 'plugins', 'emate-shell'))).toBe(true)
    expect(rows.some(row => row.name === '@kelearns/dsh-navigation-bar')).toBe(false)
    expect(rows.filter(row => row.name === '@e-mate/dsh-plugin-tidychat')).toHaveLength(1)
    expect(rows.find(row => row.id === 'emate-better-sidebar')).toEqual(expect.objectContaining({
      name: '@e-mate/dsh-plugin-better-sidebar',
    }))
    expect(rows.map(row => row.id)).not.toContain('better-sidebar')
    expect(rows.map(row => row.id)).not.toContain('search-mcp')
    expect(rows.find(row => row.id === 'web')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-web',
      config: expect.objectContaining({ searchProvider: 'deepseek-official' }),
    }))
    expect(rows.find(row => row.id === 'web-search-deepseek')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-web-search-deepseek',
      disabled: false,
      config: expect.objectContaining({
        apiKeyEnv: 'E_MATE_SEARCH_KEY_DEEPSEEK',
        baseURL: 'https://api.deepseek.com/anthropic/v1',
        model: 'deepseek-v4-flash',
      }),
    }))
    expect(rows.find(row => row.id === 'tool-web')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-tool-web',
      disabled: false,
      config: expect.objectContaining({ fetch: false, searchTimeoutMs: 60000, searchMaxResults: 50 }),
    }))
    expect(rows.find(row => row.id === 'emate-tool-search')?.config?.alwaysVisible).toContain('web_search')
    expect(rows.find(row => row.id === 'emate-tool-search')?.config?.alwaysVisible)
      .toEqual(expect.arrayContaining(['generate_image', 'edit_image', 'get_image_generation_task', 'cancel_image_generation_task']))
    expect(rows.find(row => row.id === 'emate-file-import')).toEqual(expect.objectContaining({
      name: '@e-mate/dsh-plugin-file-import',
    }))
    expect(rows.find(row => row.id === 'emate-computer-use')).toEqual(expect.objectContaining({
      name: '@e-mate/dsh-plugin-computer-use',
    }))
    expect(rows.find(row => row.id === 'emate-find-skill')).toEqual(expect.objectContaining({
      name: '@e-mate/dsh-plugin-find-skill',
    }))
    expect(rows.find(row => row.id === 'emate-mcp-manage')).toEqual(expect.objectContaining({
      name: '@e-mate/dsh-plugin-mcp-manage',
    }))
    expect(rows.map(row => row.id)).not.toContain('emate-xin-assistant')
    expect(rows.find(row => row.id === 'emate-office-skills')).toEqual(expect.objectContaining({
      name: '@e-mate/dsh-plugin-office-skills',
    }))
    expect(rows.some(row => row.id === 'univer')).toBe(false)
    const agentOperations = rows.find(row => row.id === 'emate-agent-operations')
    expect(agentOperations).toEqual(expect.objectContaining({
      inject: ['systemPrompt', 'connection', 'sessions'],
    }))
    // 0.1.5 anchors an inserted './…' name beside the patch file that declares it
    // (app-boot anchorInsertedPluginNames), so this profile-root row composes as a
    // file URL naming the profile's own plugin file.
    expect(new URL(agentOperations!.name!, pathToFileURL(join(profile, 'package.json'))).href)
      .toBe(pathToFileURL(join(profile, 'plugins', 'agent-operations.js')).href)
    expect(agentOperations?.disabled).not.toBe(true)
    // Boot the composed Desktop row with the pinned native services. A template
    // assertion alone missed the Desktop override that removed this HTTP route.
    const ctx = new Context()
    const services = [ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }),
      ctx.plugin(SystemPrompt, {}), ctx.plugin(SessionStore), ctx.plugin(AgentRegistry),
      ctx.plugin(UserQuestionService), ctx.plugin(LlmRuntime), ctx.plugin(ToolRuntime), ctx.plugin(AgentLoop),
      ctx.plugin(SessionProjectionRegistry), ctx.plugin(ExpertModeSessionQuery)]
    try {
      await Promise.all(services.map(fiber => fiber.await()))
      services.push(ctx.plugin({ name: 'expert-test-connection', inject: ['webServer'],
        apply: (owner: Context) => { new HostConnectionService(owner, [], loopbackBrowserAuth()) } }))
      await services.at(-1)!.await()
      installSessionApiCapabilities(ctx)
      const sessionController = mountSessionController(ctx)
      services.push(sessionController)
      await sessionController.await()
      provideHostApiProxySeam(ctx)
      const moduleUrl = new URL(agentOperations!.name!, pathToFileURL(join(profile, 'package.json'))).href
      const plugin = await import(/* @vite-ignore */ moduleUrl)
      const fiber = ctx.plugin(plugin)
      services.push(fiber)
      await fiber.await()
      // Creation goes through the 0.1.5 owner of the renderer-facing
      // `session/create` Remote method, not the deleted host API proxy.
      for (const sessionId of ['expert-first', 'expert-second']) {
        const created = await ctx.sessionController.create({ sessionId: SessionId(sessionId), cwd: home })
        expect(created.sessionId).toBe(sessionId)
      }
      const first = ctx.sessions.get(SessionId('expert-first'))!
      const second = ctx.sessions.get(SessionId('expert-second'))!
      const flush = vi.fn()
      ctx.on('session/flush', flush)
      const rpc = async (endpoint: string, payload: object, origin?: string) => {
        const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}/emate.expert-mode/${endpoint}`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
          body: JSON.stringify({ type: 'client-request', rpcId: 'expert-test', method: endpoint, payload }),
        })
        if (origin) return response.status
        expect(response.status).toBe(200)
        const body = serverResponseSchema.parse(await response.json())
        return body.result
      }
      const policy = async (session: typeof first) => {
        const assembly = await ctx.systemPrompt.assemble({ agent: {
          session, options: { provider: 'unused', model: 'unused' },
        } } as never)
        return assembly.sections.find(section => section.name === 'emate:expert-mode')?.text ?? ''
      }
      expect(await rpc('get', { session_id: first.id })).toEqual({ ok: true, value: { active: false } })
      expect(await policy(first)).toBe('')
      expect(await rpc('get', { session_id: 'expert-missing' })).toEqual({ ok: false,
        error: { code: 'session-not-found', message: '会话尚未就绪，请稍后重试。', details: { sessionId: 'expert-missing' } } })
      expect(await rpc('set', { session_id: first.id, active: 'yes' })).toEqual({ ok: false,
        error: { code: 'internal', message: '专家模式请求无效。', details: {} } })
      expect(await rpc('set', { session_id: first.id, active: true })).toEqual({ ok: true, value: { active: true } })
      expect(flush).toHaveBeenCalledWith(first)
      expect(await rpc('get', { session_id: first.id })).toEqual({ ok: true, value: { active: true } })
      expect(await policy(first)).toContain('enterprise-knowledge Skill')
      expect(await policy(second)).toBe('')
      const restored = ctx.sessions.create(SessionId('expert-restored'), { seed: first.snapshotEvents() })
      expect(await policy(restored)).toContain('enterprise-knowledge Skill')
      expect(await rpc('set', { session_id: first.id, active: false })).toEqual({ ok: true, value: { active: false } })
      expect(await policy(first)).toContain('用户已关闭')
      expect(await rpc('set', { session_id: second.id, active: true }, 'https://untrusted.example')).toBe(403)
      expect(await policy(second)).toBe('')
      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.find(section => section.name === 'emate:agent-operations')?.text).not.toMatch(/imagegen|image_batch|image_pack/)
      await fiber.dispose()
      expect((await ctx.systemPrompt.assemble()).sections.some(section => section.name.startsWith('emate:'))).toBe(false)
      const removed = await fetch(`http://127.0.0.1:${ctx.webServer.port}/emate.expert-mode/get`, { method: 'POST' })
      expect(removed.status).toBe(404)
    } finally {
      for (const fiber of services.reverse()) await fiber.dispose()
    }
    expect(rows.find(row => row.id === 'emate-schedules')).toEqual(expect.objectContaining({
      name: '@e-mate/dsh-plugin-schedules',
      inject: ['connection', 'sessionPersistence'],
    }))
    const schedules = readFileSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-schedules', 'lib', 'index.js'), 'utf8')
    expect(schedules).toContain('/emate.schedules')
    expect(schedules).toContain('foldScheduleEvents')
    expect(rows.map(row => row.id)).not.toContain('desktop-profiles')
    expect(rows.find(row => row.id === 'dsh-at-file')).toEqual(expect.objectContaining({
      name: 'dsh-at-file',
    }))
    expect(rows.find(row => row.id === 'dsh-file-viewer')).toEqual(expect.objectContaining({
      name: 'dsh-file-viewer',
      config: expect.objectContaining({ allowAbsolutePaths: false }),
    }))
    expect(rows.map(row => row.id)).not.toContain('dsh-turn-fold')
    expect(rows.find(row => row.id === 'visualize')).toEqual(expect.objectContaining({
      name: 'dsh-visualize',
    }))
  })

  it('preserves an existing theme preference and adds the managed model default once', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const settings = join(home, 'settings.yaml')
    writeFileSync(settings, 'ui-theme:\n  preference: light\n')

    installEmateDesktopProfile(home)
    installEmateDesktopProfile(home)

    expect(readFileSync(settings, 'utf8')).toBe(
      'ui-theme:\n  preference: light\nagent-default-model:\n  provider: e-mate-enterprise\n  model: gpt-5.6-luna\n  reasoningEffort: max\n',
    )
  })

  it('reuses a complete immutable profile and repairs it when a required file disappears', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const cdpManifest = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-cdp', 'package.json')
    const sentinel = join(profile, '.warm-start-sentinel')
    const firstModified = readFileSync(join(profile, '.e-mate-install.json'), 'utf8')

    writeFileSync(sentinel, 'preserved only when the immutable install is reused')
    installEmateDesktopProfile(home)
    expect(readFileSync(join(profile, '.e-mate-install.json'), 'utf8')).toBe(firstModified)
    expect(existsSync(sentinel)).toBe(true)

    rmSync(cdpManifest)
    installEmateDesktopProfile(home)
    expect(existsSync(cdpManifest)).toBe(true)
    expect(existsSync(sentinel)).toBe(true)
  })

  it('refreshes changed bundled plugins and patch on same-version replacement without rewriting a stable profile', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const receipt = join(profile, '.e-mate-install.json')
    const settings = readFileSync(join(home, 'settings.yaml'), 'utf8')
    const userPlugin = join(profile, 'plugins', 'user-owned.js')
    const session = join(home, 'sessions', 'preserved.jsonl')
    mkdirSync(join(home, 'sessions'), { recursive: true })
    writeFileSync(userPlugin, 'user plugin')
    writeFileSync(session, 'session history')
    const oldTime = new Date('2020-01-01T00:00:00Z')
    for (const relativePath of ['plugins/model-policy.js', 'plugins/identity/index.js', 'cordis.patch.yml']) {
      const source = join(packagedSource, relativePath)
      const original = readFileSync(source, 'utf8')
      const changed = `${original}\n${relativePath.endsWith('.yml') ? '#' : '//'} same-version replacement\n`
      try {
        utimesSync(receipt, oldTime, oldTime)
        writeFileSync(source, changed)
        installEmateDesktopProfile(home)
        expect(readFileSync(join(profile, relativePath), 'utf8')).toContain('same-version replacement')
        expect(statSync(receipt).mtimeMs).not.toBe(oldTime.getTime())
        expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe(settings)
        expect(readFileSync(userPlugin, 'utf8')).toBe('user plugin')
        expect(readFileSync(session, 'utf8')).toBe('session history')
        utimesSync(receipt, oldTime, oldTime)
        installEmateDesktopProfile(home)
        expect(statSync(receipt).mtimeMs).toBe(oldTime.getTime())
      } finally {
        writeFileSync(source, original)
      }
    }
  })

  it('repairs a managed package with a top-level extra while preserving package-external data', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const cdpPackage = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-cdp')
    const extra = join(cdpPackage, '.unexpected-top-level-entry')
    const external = join(profile, 'node_modules', 'user-owned-package', 'data.txt')
    mkdirSync(join(profile, 'node_modules', 'user-owned-package'), { recursive: true })
    writeFileSync(extra, 'must not survive inside a managed package')
    writeFileSync(external, 'outside the managed package owner')

    installEmateDesktopProfile(home)

    expect(existsSync(extra)).toBe(false)
    expect(readFileSync(external, 'utf8')).toBe('outside the managed package owner')
  })

  it('repairs an explicitly constructed legacy managed-package directory link', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const receiptPath = join(profile, '.e-mate-install.json')
    const library = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-schedules', 'lib')
    const legacyLibrary = join(home, 'legacy-schedules-lib')
    cpSync(library, legacyLibrary, { recursive: true, dereference: true })
    rmSync(library, { recursive: true, force: true })
    symlinkSync(legacyLibrary, library, process.platform === 'win32' ? 'junction' : 'dir')
    expect(lstatSync(library).isSymbolicLink()).toBe(true)
    const legacyReceipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>
    legacyReceipt.schema_version = 1
    delete legacyReceipt.managed_package_layout
    writeFileSync(receiptPath, `${JSON.stringify(legacyReceipt, null, 2)}\n`)

    installEmateDesktopProfile(home)

    expect(lstatSync(library).isSymbolicLink()).toBe(process.platform !== 'win32')
    expect(readFileSync(join(library, 'index.js'))).toEqual(readFileSync(join(legacyLibrary, 'index.js')))
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toEqual(expect.objectContaining({
      schema_version: 2,
      managed_package_layout: process.platform === 'win32' ? 'win32-materialized-v1' : 'linked-v1',
    }))
  })

  it('rejects a managed package root reparse point', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const target = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-cdp')
    const legacyPackage = join(home, 'legacy-cdp-package')
    cpSync(target, legacyPackage, { recursive: true, dereference: true })
    rmSync(target, { recursive: true, force: true })
    symlinkSync(legacyPackage, target, process.platform === 'win32' ? 'junction' : 'dir')

    installEmateDesktopProfile(home)

    expect(lstatSync(target).isSymbolicLink()).toBe(false)
    expect(lstatSync(join(target, 'lib')).isSymbolicLink()).toBe(process.platform !== 'win32')
  })

  it('repairs a broken top-level managed-package directory link without following it', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const library = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-schedules', 'lib')
    const removedTarget = join(home, 'removed-schedules-lib')
    mkdirSync(removedTarget)
    rmSync(library, { recursive: true, force: true })
    symlinkSync(removedTarget, library, process.platform === 'win32' ? 'junction' : 'dir')
    rmSync(removedTarget, { recursive: true, force: true })

    installEmateDesktopProfile(home)

    expect(existsSync(join(library, 'index.js'))).toBe(true)
    expect(lstatSync(library).isSymbolicLink()).toBe(process.platform !== 'win32')
  })

  it.runIf(process.platform !== 'win32')('keeps non-Windows linked package directories current without reading nested payloads', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const library = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-schedules', 'lib')
    const sourceLibrary = realpathSync(library)
    const sentinel = join(profile, '.warm-start-sentinel')
    const receiptPath = join(profile, '.e-mate-install.json')
    const receipt = readFileSync(receiptPath, 'utf8')
    const previousTime = new Date('2000-01-01T00:00:00Z')
    utimesSync(receiptPath, previousTime, previousTime)
    writeFileSync(sentinel, 'warm path reused')

    installEmateDesktopProfile(home)

    expect(realpathSync(library)).toBe(sourceLibrary)
    expect(readFileSync(receiptPath, 'utf8')).toBe(receipt)
    expect(statSync(receiptPath).mtimeMs).toBe(previousTime.getTime())
    expect(readFileSync(sentinel, 'utf8')).toBe('warm path reused')
  })

  it('skips only declaration conditions while repairing missing or corrupted runtime entries', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const source = join(packagedSource, 'bundles', 'computer-use')
    const manifestPath = join(source, 'package.json')
    const originalManifest = readFileSync(manifestPath, 'utf8')
    const manifest = JSON.parse(originalManifest)
    const entries = ['host-default.js', 'host-import.js', 'host-require.js', 'client-default.js', 'client-import.js', 'client-require.js', 'types-runtime.js']
    const runtime = 'export const value = 1\n'
    try {
      delete manifest.main
      manifest.exports['.'] = {
        types: './missing-host.d.ts',
        'types@>=5.2': { default: './missing-versioned-host.d.ts' },
        import: ['./host-import.js'], require: './host-require.js', default: './host-default.js',
      }
      manifest.exports['./client'] = {
        types: './missing-client.d.ts',
        import: { 'types@>=5.2': './missing-versioned-client.d.ts', default: './client-import.js' },
        require: './client-require.js', default: './client-default.js',
        'types-runtime': './types-runtime.js',
      }
      writeFileSync(manifestPath, JSON.stringify(manifest))
      for (const entry of entries) writeFileSync(join(source, entry), runtime)
      const profile = installEmateDesktopProfile(home)
      const target = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-computer-use')
      const receiptPath = join(profile, '.e-mate-install.json')
      const previousTime = new Date('2000-01-01T00:00:00Z')
      expect(existsSync(join(source, 'lib', 'types', 'client', 'index.d.ts'))).toBe(false)
      utimesSync(receiptPath, previousTime, previousTime)
      installEmateDesktopProfile(home)
      expect(statSync(receiptPath).mtimeMs).toBe(previousTime.getTime())

      for (const entry of [...entries, 'cordis.patch.yml']) {
        const path = join(target, entry)
        const expected = readFileSync(path)
        // Same-size corruption must be caught by critical-entry hashing.
        const corrupted = Buffer.from(expected)
        corrupted[0] = corrupted[0]! ^ 1
        writeFileSync(path, corrupted)
        utimesSync(receiptPath, previousTime, previousTime)
        installEmateDesktopProfile(home)
        expect(readFileSync(path)).toEqual(expected)
        expect(statSync(receiptPath).mtimeMs).not.toBe(previousTime.getTime())
        rmSync(path)
        installEmateDesktopProfile(home)
        expect(readFileSync(path)).toEqual(expected)
      }

      manifest.main = './host-default.js'
      writeFileSync(manifestPath, JSON.stringify(manifest))
      installEmateDesktopProfile(home)
      writeFileSync(join(target, manifest.main), runtime.replace('1', '2'))
      installEmateDesktopProfile(home)
      expect(readFileSync(join(target, manifest.main), 'utf8')).toBe(runtime)

      // A runtime condition still cannot escape the package, even if its bytes match.
      manifest.exports['./client'].default = '../outside.js'
      writeFileSync(manifestPath, JSON.stringify(manifest))
      writeFileSync(join(source, '..', 'outside.js'), runtime)
      writeFileSync(join(target, '..', 'outside.js'), runtime)
      installEmateDesktopProfile(home)
      utimesSync(receiptPath, previousTime, previousTime)
      installEmateDesktopProfile(home)
      expect(statSync(receiptPath).mtimeMs).not.toBe(previousTime.getTime())
    } finally {
      writeFileSync(manifestPath, originalManifest)
      for (const entry of entries) rmSync(join(source, entry), { force: true })
      rmSync(join(source, '..', 'outside.js'), { force: true })
    }
  })

  it('defers removal of replaced managed packages until the desktop is interactive', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const cdpPackage = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-cdp')
    const sentinel = join(cdpPackage, '.old-package-sentinel')
    const deferred: string[] = []
    writeFileSync(sentinel, 'old package tree')
    rmSync(join(cdpPackage, 'package.json'))

    installEmateDesktopProfile(home, path => { deferred.push(path) })

    expect(existsSync(join(cdpPackage, 'package.json'))).toBe(true)
    expect(deferred.some(path => existsSync(join(path, '.old-package-sentinel')))).toBe(true)
    for (const path of deferred) rmSync(path, { recursive: true, force: true })
  })

  it('restores the previous managed package when deferred cleanup fails', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const cdpPackage = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-cdp')
    const sentinel = join(cdpPackage, '.old-package-sentinel')
    writeFileSync(sentinel, 'previous package tree')
    rmSync(join(cdpPackage, 'package.json'))

    expect(() => installEmateDesktopProfile(home, () => {
      throw new Error('deferred cleanup failed')
    })).toThrow('deferred cleanup failed')

    expect(readFileSync(sentinel, 'utf8')).toBe('previous package tree')
    expect(existsSync(join(cdpPackage, 'package.json'))).toBe(false)
  })

  it('recovers a deterministic swap interrupted between the two renames', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const target = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-cdp')
    const candidate = `${target}.e-mate-next`
    const stale = `${target}.e-mate-stale`
    renameSync(target, stale)
    mkdirSync(candidate)
    writeFileSync(join(candidate, 'partial.txt'), 'interrupted candidate')

    installEmateDesktopProfile(home)

    expect(existsSync(join(target, 'package.json'))).toBe(true)
    expect(existsSync(candidate)).toBe(false)
    expect(existsSync(stale)).toBe(false)
  })

  it('persists and bounds failed stale cleanup without following an external link', async () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const target = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-cdp')
    const deferred: string[] = []
    rmSync(join(target, 'package.json'))
    installEmateDesktopProfile(home, path => { deferred.push(path) })
    const stale = `${target}.e-mate-stale`
    expect(deferred).toContain(stale)
    const warmDeferred: string[] = []
    installEmateDesktopProfile(home, path => { warmDeferred.push(path) })
    expect(warmDeferred).toContain(stale)

    const outside = join(home, 'outside-cleanup-owner')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'must remain')
    rmSync(stale, { recursive: true, force: true })
    symlinkSync(outside, stale, process.platform === 'win32' ? 'junction' : 'dir')
    const linkedDeferred: string[] = []
    installEmateDesktopProfile(home, path => { linkedDeferred.push(path) })
    expect(linkedDeferred).toContain(stale)
    await expect(cleanupEmateDesktopProfileArtifact(profile, outside)).rejects.toThrow('outside the owned')
    for (let attempt = 0; attempt < EMATE_MANAGED_PROFILE_CLEANUP_MAX_ATTEMPTS; attempt += 1) {
      await expect(cleanupEmateDesktopProfileArtifact(profile, stale)).rejects.toThrow('not a physical directory')
    }
    await expect(cleanupEmateDesktopProfileArtifact(profile, stale)).rejects.toThrow('retry limit is exhausted')

    const retried: string[] = []
    installEmateDesktopProfile(home, path => { retried.push(path) })
    expect(retried).not.toContain(stale)
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('must remain')
    const receipt = JSON.parse(readFileSync(join(profile, '.e-mate-install.json'), 'utf8')) as {
      cleanup_attempts?: Record<string, number>
    }
    expect(Object.values(receipt.cleanup_attempts ?? {})).toContain(EMATE_MANAGED_PROFILE_CLEANUP_MAX_ATTEMPTS)
  })

  it('migrates managed bundle dependencies while retaining their packages and external plugins', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const manifestPath = join(profile, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    const managed = manifest.dsh.profile.bundles.slice(2)
    const snapshot = (name: string) => {
      const root = join(profile, 'node_modules', ...name.split('/'))
      return {
        inode: lstatSync(root).ino,
        manifest: readFileSync(join(root, 'package.json'), 'utf8'),
        patch: readFileSync(join(root, 'cordis.patch.yml'), 'utf8'),
      }
    }
    const before = managed.map(snapshot)
    for (const [index, name] of managed.entries()) {
      manifest.dependencies[name] = (JSON.parse(before[index]!.manifest) as { version: string }).version
    }
    const external = {
      '@xmanrui/dsh-im': 'github:zyfjacksonchen-source/dsh-im#f984f73dcd67692141d4e475c8fbe887e2ce7062',
      '@e-mate/dsh-plugin-univer-office': 'file:/reviewed/plugin.tgz',
    }
    Object.assign(manifest.dependencies, external)
    manifest.dsh.profile.bundles.push(...Object.keys(external))
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const externalFile = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-univer-office', 'user.txt')
    mkdirSync(join(profile, 'node_modules', '@e-mate', 'dsh-plugin-univer-office'), { recursive: true })
    writeFileSync(externalFile, 'external plugin payload')

    installEmateDesktopProfile(home)

    const repaired = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest
    expect(repaired.dependencies).toEqual(external)
    expect(repaired.dsh.profile.bundles).toEqual(manifest.dsh.profile.bundles)
    expect(managed.map(snapshot)).toEqual(before)
    expect(readFileSync(externalFile, 'utf8')).toBe('external plugin payload')
    const oldTime = new Date('2020-01-01T00:00:00Z')
    utimesSync(manifestPath, oldTime, oldTime)
    installEmateDesktopProfile(home)
    expect(statSync(manifestPath).mtimeMs).toBe(oldTime.getTime())
    expect(managed.map(snapshot)).toEqual(before)
  })

  it('preserves a native DSH plugin dependency and bundle across managed profile repair', () => {
    const home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-'))
    roots.push(home)
    const profile = installEmateDesktopProfile(home)
    const manifestPath = join(profile, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    manifest.dependencies['@xmanrui/dsh-im'] = 'github:zyfjacksonchen-source/dsh-im#f984f73dcd67692141d4e475c8fbe887e2ce7062'
    manifest.dependencies['@e-mate/dsh-plugin-im'] = '2.0.8'
    manifest.dependencies['@e-mate/dsh-plugin-idesign'] = '2.0.12'
    manifest.dependencies['@e-mate/dsh-plugin-search-mcp'] = '2.0.11'
    manifest.dependencies['@e-mate/dsh-plugin-xin-assistant'] = '2.0.10'
    manifest.dependencies['@yuxianglin/dsh-bridge-browser'] = '0.0.1'
    manifest.dependencies['dsh-better-sidebar'] = '0.12.2'
    manifest.dependencies['dsh-turn-fold'] = '0.2.2'
    manifest.dependencies['@kelearns/dsh-navigation-bar'] = '0.2.1'
    manifest.dsh.profile.bundles.push('@kelearns/dsh-navigation-bar')
    const retiredNavigation = join(profile, 'node_modules', '@kelearns', 'dsh-navigation-bar')
    mkdirSync(retiredNavigation, { recursive: true })
    writeFileSync(join(retiredNavigation, 'cordis.patch.yml'), "- insert:\n    - id: dsh-navigation-bar\n      name: '@kelearns/dsh-navigation-bar'\n")
    const retiredXin = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-xin-assistant')
    const retiredIDesign = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-idesign')
    const retiredSearchMcp = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-search-mcp')
    const retiredSidebar = join(profile, 'node_modules', 'dsh-better-sidebar')
    const retiredTurnFold = join(profile, 'node_modules', 'dsh-turn-fold')
    mkdirSync(retiredXin, { recursive: true })
    mkdirSync(retiredIDesign, { recursive: true })
    mkdirSync(retiredSearchMcp, { recursive: true })
    mkdirSync(retiredSidebar, { recursive: true })
    mkdirSync(retiredTurnFold, { recursive: true })
    writeFileSync(join(retiredXin, 'stale.txt'), 'retired', { flag: 'w' })
    writeFileSync(join(retiredIDesign, 'stale.txt'), 'retired', { flag: 'w' })
    writeFileSync(join(retiredSearchMcp, 'stale.txt'), 'retired', { flag: 'w' })
    writeFileSync(join(retiredSidebar, 'stale.txt'), 'retired', { flag: 'w' })
    writeFileSync(join(retiredTurnFold, 'stale.txt'), 'retired', { flag: 'w' })
    manifest.dsh.profile.bundles.push(
      '@xmanrui/dsh-im',
      '@e-mate/dsh-plugin-im',
      '@e-mate/dsh-plugin-idesign',
      '@e-mate/dsh-plugin-search-mcp',
      '@e-mate/dsh-plugin-xin-assistant',
      '@yuxianglin/dsh-bridge-browser',
      'dsh-better-sidebar',
      'dsh-turn-fold',
    )
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    installEmateDesktopProfile(home)

    const repaired = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest
    expect(repaired.dependencies['@xmanrui/dsh-im']).toBe(
      'github:zyfjacksonchen-source/dsh-im#f984f73dcd67692141d4e475c8fbe887e2ce7062',
    )
    expect(repaired.dsh.profile.bundles.at(-1)).toBe('@xmanrui/dsh-im')
    expect(repaired.dependencies['@e-mate/dsh-plugin-im']).toBeUndefined()
    expect(repaired.dependencies['@e-mate/dsh-plugin-idesign']).toBeUndefined()
    expect(repaired.dependencies['@e-mate/dsh-plugin-search-mcp']).toBeUndefined()
    expect(repaired.dependencies['@e-mate/dsh-plugin-xin-assistant']).toBeUndefined()
    expect(repaired.dependencies['@yuxianglin/dsh-bridge-browser']).toBeUndefined()
    expect(repaired.dependencies['dsh-better-sidebar']).toBeUndefined()
    expect(repaired.dependencies['dsh-turn-fold']).toBeUndefined()
    expect(repaired.dsh.profile.bundles).not.toContain('@e-mate/dsh-plugin-im')
    expect(repaired.dsh.profile.bundles).not.toContain('@e-mate/dsh-plugin-idesign')
    expect(repaired.dsh.profile.bundles).not.toContain('@e-mate/dsh-plugin-search-mcp')
    expect(repaired.dsh.profile.bundles).not.toContain('@e-mate/dsh-plugin-xin-assistant')
    expect(repaired.dsh.profile.bundles).not.toContain('@yuxianglin/dsh-bridge-browser')
    expect(repaired.dsh.profile.bundles).not.toContain('dsh-better-sidebar')
    expect(repaired.dsh.profile.bundles).not.toContain('dsh-turn-fold')
    expect(existsSync(retiredXin)).toBe(false)
    expect(existsSync(retiredIDesign)).toBe(false)
    expect(existsSync(retiredSearchMcp)).toBe(false)
    expect(existsSync(retiredSidebar)).toBe(false)
    expect(existsSync(retiredTurnFold)).toBe(false)
    expect(existsSync(retiredNavigation)).toBe(false)
    expect(repaired.dependencies['@kelearns/dsh-navigation-bar']).toBeUndefined()
    expect(repaired.dsh.profile.bundles).not.toContain('@kelearns/dsh-navigation-bar')
    expect(repaired.dsh.profile.bundles.filter(name => name === '@e-mate/dsh-plugin-tidychat')).toHaveLength(1)
  })
})


describe('expert mode native cold-session RPC', () => {
  it('reads cold state and resumes the same owner once for concurrent writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'expert-cold-rpc-'))
    roots.push(root)
    const persistenceRoot = join(root, 'sessions')
    const id = SessionId('expert-cold')
    const childId = SessionId('expert-cold-child')
    const seed = new Context()
    await seed.plugin(SessionStore)
    await seed.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
    for (const sessionId of [id, childId]) {
      const session = seed.sessions.create(sessionId, { meta: { cwd: root,
        ...(sessionId === childId ? { origin: 'subagent', parentSession: id } : {}) } })
      session.append('emate/expert-mode', { active: true }, { ignorable: true })
      // 0.1.5 durably writes through a persistence handle: `sessions.flush` only
      // checkpoints Sessions the persistence owner already tracks, so the seed log
      // is created and closed explicitly before the reading context mounts.
      const handle = await seed.sessionPersistence.create(session.header)
      await handle.append(session.snapshotEvents())
      await handle.close()
    }
    await seed.fiber.dispose()
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(UserQuestionService)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentLoop)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(ExpertModeSessionQuery)
      await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
      await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      await ctx.plugin({ name: 'expert-cold-connection', inject: ['webServer'],
        apply: (owner: Context) => { new HostConnectionService(owner, [], loopbackBrowserAuth()) } })
      installSessionApiCapabilities(ctx)
      await mountSessionController(ctx).await()
      provideHostApiProxySeam(ctx)
      const source = new URL('../../../packages/dsh/src/profile/agent-operations.ts', import.meta.url).href
      await ctx.plugin(await import(/* @vite-ignore */ source))
      // 0.1.5 hands every Context its own traced service proxy, so a spy on one
      // `ctx.agents` read never observes another Context's call; the registry
      // prototype is the owner every resume reaches.
      const resume = vi.spyOn(AgentRegistry.prototype, 'resume')
      let next = 0
      const rpc = async (endpoint: string, payload: object) => {
        const rpcId = `expert-cold-${++next}`
        const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}/emate.expert-mode/${endpoint}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
        })
        expect(response.status).toBe(200)
        const body = serverResponseSchema.parse(await response.json())
        expect(body.rpcId).toBe(rpcId)
        return body.result
      }
      expect(await rpc('get', { session_id: id })).toEqual({ ok: true, value: { active: true } })
      expect(ctx.sessions.get(id)).toBeUndefined()
      expect(ctx.agents.get(id)).toBeUndefined()
      expect(resume).not.toHaveBeenCalled()
      expect(await Promise.all([rpc('set', { session_id: id, active: false }),
        rpc('set', { session_id: id, active: false })])).toEqual([
        { ok: true, value: { active: false } }, { ok: true, value: { active: false } },
      ])
      expect(resume).toHaveBeenCalledTimes(1)
      expect(await rpc('set', { session_id: id, active: false })).toEqual({ ok: true, value: { active: false } })
      expect(resume).toHaveBeenCalledTimes(1)
      expect(ctx.agents.get(id)?.session).toBe(ctx.sessions.get(id))
      expect(ctx.sessions.get(id)?.header.cwd).toBe(root)
      const stored = await ctx.sessionPersistence.open(id, 'read')
      const states = expertModeStates((await stored.read()).events)
      await stored.close()
      expect(states).toEqual([{ active: true }, { active: false }])
      const refused = await rpc('set', { session_id: childId, active: false })
      // 0.1.5's Session owner publishes the refusal as the Remote error
      // `session/agent-busy` (`packages/api/session-controller/src/agent.ts:97`)
      // with the same details; the deleted host proxy owned the `agent-busy` code.
      expect(refused).toMatchObject({ ok: false, error: { code: 'session/agent-busy', details: { reason: 'use subagent delivery for this child session' } } })
      expect(ctx.agents.get(childId)).toBeUndefined()
      const liveChild = ctx.sessions.create(SessionId('expert-live-child'), {
        meta: { cwd: root, origin: 'subagent', parentSession: id },
      })
      const childEventsBefore = liveChild.snapshotEvents().length
      expect(await rpc('set', { session_id: liveChild.id, active: true })).toMatchObject({
        ok: false, error: { code: 'session/agent-busy', details: { reason: 'use subagent delivery for this child session' } },
      })
      expect(liveChild.snapshotEvents()).toHaveLength(childEventsBefore)
      expect(await rpc('set', { session_id: id, active: 'yes' })).toMatchObject({ ok: false, error: { code: 'internal', details: {} } })
      expect(await rpc('get', { session_id: 'missing' })).toMatchObject({ ok: false, error: { code: 'internal', details: {} } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
