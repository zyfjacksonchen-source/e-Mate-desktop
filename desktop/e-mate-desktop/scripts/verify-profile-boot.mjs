/** Headless smoke for the complete bundled DSH Web profile and renderer manifest. */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import { installDesktopPnpmRuntime } from '../lib/desktop-runtime-environment.js'
import {
  emateProfileComponentSources,
  installEmateDesktopProfile,
} from '../lib/e-mate-profile.js'
import { installProfilePackageResolver } from '../lib/module-resolution.js'
import { prepareDesktopProfile } from '../lib/profile.js'
import { loadProfileBaseContract } from '../src/base-contract.ts'
import { authenticateRendererSession } from '../src/renderer-session-auth.ts'

const BIN_NAME = '@e-mate/desktop-profile-smoke'
const selectedTarget = { platform: 'win32', arch: 'x64' }
const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-'))
const previousDshHome = process.env.DSH_HOME
process.env.DSH_HOME = home
let ctx
let releasePackageResolver
let pnpmRuntime
let mountedSpec
let nativeThemeSource = 'system'
const trayItems = []

/**
 * Chromium-equivalent stand-in for one Electron renderer session: a persistent
 * cookie jar whose redirects are followed inside the session. The profile smoke
 * cannot construct a BrowserWindow, so it drives the production exchange step
 * (@e-mate/desktop authenticateRendererSession) with this jar and then loads the
 * marker URL exactly as the window does.
 */
function createRendererSession() {
  const jar = new Map()
  const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
  return {
    cookieHeader,
    async fetch(url, init) {
      let target = url
      for (let hop = 0; hop <= 5; hop += 1) {
        const cookie = cookieHeader()
        const response = await fetch(target, {
          method: init.method,
          redirect: 'manual',
          cache: init.cache,
          ...(cookie === '' ? {} : { headers: { cookie } }),
        })
        for (const value of response.headers.getSetCookie()) {
          const pair = value.split(';', 1)[0]
          const separator = pair.indexOf('=')
          if (separator > 0) jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
        }
        const location = response.headers.get('location')
        if (response.status >= 300 && response.status < 400 && location !== null) {
          await response.body?.cancel()
          target = new URL(location, target).href
          continue
        }
        return { status: response.status, body: { cancel: async () => { await response.body?.cancel() } } }
      }
      throw new Error('renderer session authentication exceeded the redirect limit')
    },
  }
}

try {
  // Deliberately inject stale target state: the e-Mate desktop must still boot
  // its fixed profile mode without exposing a mode selector.
  writeFileSync(join(home, 'settings.yaml'), 'dsh-desktop:\n  mode: compatibility\n')
  const selectedBase = loadProfileBaseContract(
    fileURLToPath(new URL('../base-contract.json', import.meta.url)),
  )
  const installedProfile = installEmateDesktopProfile(home)
  const retiredBrowser = /e-Mate 浏览器扩展未连接|chrome:\/\/extensions|load[- ]unpacked|加载已解压|ext-bridge-token|browser-extension|@e-mate\/dsh-plugin-browser(?:-panel)?|@yuxianglin\/dsh-bridge-browser/u
  for (const relative of readdirSync(installedProfile, { recursive: true })) {
    if (retiredBrowser.test(relative)) {
      throw new Error(`assembled Profile contains a retired browser bridge path: ${relative}`)
    }
    if (!/\.(?:[cm]?js|html|json|ya?ml)$/u.test(relative)) continue
    if (retiredBrowser.test(readFileSync(join(installedProfile, relative), 'utf8'))) {
      throw new Error(`assembled Profile contains retired browser bridge code: ${relative}`)
    }
  }
  const prepared = await prepareDesktopProfile('1', home, selectedTarget.platform)
  const packageRoot = new URL('../', import.meta.url)
  const pnpmBinPath = fileURLToPath(new URL('node_modules/pnpm/bin/pnpm.mjs', packageRoot))
  const electronVersion = JSON.parse(
    readFileSync(new URL('node_modules/electron/package.json', packageRoot), 'utf8'),
  ).version
  pnpmRuntime = installDesktopPnpmRuntime({
    platform: process.platform,
    appExecutable: process.execPath,
    pnpmBinPath,
    electronVersion,
    stateDir: join(home, 'runtime-commands'),
    environment: process.env,
  })
  releasePackageResolver = installProfilePackageResolver(
    prepared.bareModuleBaseUrl,
    emateProfileComponentSources(),
    selectedBase.runtime_imports,
  )
  const runtime = {
    platform: selectedTarget.platform,
    locale: 'en',
    updates: {
      isPackaged: false,
      canDownload: true,
      currentVersion: '2.0.0',
      statePath: join(home, 'update-state.json'),
      request: async () => { throw new Error('profile smoke must not perform update requests') },
      confirmDownload: async () => false,
      showManualCheckResult: async () => {},
      downloadAndOpen: async () => {},
      notify: () => {},
    },
    schedule(spec) {
      mountedSpec = spec
      return async () => {}
    },
    async mountScheduled() {
      if (mountedSpec === undefined) throw new Error('desktop shell was not registered')
      nativeThemeSource = mountedSpec.readThemeSource()
    },
    show() {},
    async pickDirectory() { return home },
    registerTrayItem(item) {
      trayItems.push(item)
      return {
        refresh() {},
        dispose() {
          const index = trayItems.indexOf(item)
          if (index >= 0) trayItems.splice(index, 1)
        },
      }
    },
    openTerminal() {},
    setThemeSource(source) { nativeThemeSource = source },
    async requestRestart() {},
    prepareToQuit() {},
  }
  ctx = await boot(
    BIN_NAME,
    prepared.rootConfig,
    [...prepared.patches, { id: 'webserver', config: { host: '127.0.0.1', port: 0 } }],
    async (host) => {
      host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]))
      host.provide('desktopRuntime', runtime)
      host.provide('desktopPnpmBootstrap', {
        activeProfileName: 'e-mate',
        activeProfileDir: prepared.profile.dir,
        homeDir: prepared.homeDir,
        appExecutable: process.execPath,
        pnpmBinPath,
        electronVersion,
        nodeBinDir: pnpmRuntime.nodeBinDir,
        nodeShimPath: pnpmRuntime.nodeShimPath,
        clearEnvironmentPath: pnpmRuntime.clearEnvironmentPath,
        dshBootstrapPath: fileURLToPath(new URL('../lib/desktop-cli.js', import.meta.url)),
        installRecoveryStatePath: join(home, 'plugin-install-recovery', 'state.json'),
        generationId: 'profile-smoke-generation-0001',
      })
      provideCmdline(host, {
        args: ['--host', '127.0.0.1', '--port', '0'],
        exit: () => {},
      })
    },
    prepared.bareModuleBaseUrl,
  )
  await runtime.mountScheduled()

  if (ctx.get('desktopPnpm') === undefined) {
    throw new Error('assembled desktop profile is missing the desktop pnpm Host capability')
  }
  const picker = ctx.directoryPicker.capability()
  if (picker.kind !== 'native') {
    throw new Error(`assembled ${selectedTarget.platform} profile selected ${picker.kind} instead of native directory picker`)
  }
  if (selectedTarget.platform === 'win32') {
    const picked = await picker.pick(new AbortController().signal)
    if (picked !== home) {
      throw new Error(`assembled Windows native picker returned ${String(picked)} instead of ${home}`)
    }
  }

  const rendererOrigin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const expectedUrl = `${rendererOrigin}/?dsh-desktop-mode=${prepared.mode}&dsh-desktop-platform=${selectedTarget.platform}`
  if (mountedSpec?.url !== expectedUrl) {
    throw new Error(`desktop plugin produced an unexpected renderer URL: ${String(mountedSpec?.url)}`)
  }
  // The Web root is browser-authenticated (client/connection browser-auth): the
  // shell must hand the Electron adapter the Connection owner's process-token
  // URL, and the adapter must exchange it inside the renderer session before
  // loading the marker URL above.
  const expectedAuthenticationUrl = ctx.connection.authenticatedUrl(rendererOrigin)
  if (mountedSpec?.authenticationUrl !== expectedAuthenticationUrl) {
    throw new Error(`desktop plugin produced an unexpected authentication URL: ${String(mountedSpec?.authenticationUrl)}`)
  }
  if (new URL(expectedAuthenticationUrl).searchParams.get('token') === null) {
    throw new Error(`assembled authentication URL carries no process token: ${expectedAuthenticationUrl}`)
  }
  if (mountedSpec?.mode !== prepared.mode) {
    throw new Error(`desktop plugin produced an unexpected shell mode: ${String(mountedSpec?.mode)}`)
  }
  if (nativeThemeSource !== 'system') {
    throw new Error(`desktop plugin produced an unexpected native theme source: ${nativeThemeSource}`)
  }
  if (!trayItems.some(item => item.label() === 'Check for Updates…')) {
    throw new Error('assembled desktop profile is missing the update tray command')
  }
  if (process.platform !== 'linux'
    && !trayItems.some(item => item.label() === 'Open DSH Terminal')) {
    throw new Error('assembled desktop profile is missing the terminal tray command')
  }
  if (trayItems.some(item => item.label().startsWith('Profile:'))) {
    throw new Error('assembled e-Mate profile unexpectedly exposes a profile selector')
  }
  const defaultAgent = (await ctx.agents.create({
    sessionId: SessionId('profile-smoke-default-ptc'),
    meta: { cwd: home },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx),
  })).agent
  // 0.1.5 ships standard|ptc|minimal|cordis and the product profile selects native
  // PTC by default; 'code' has no successor in this baseline.
  if (ctx.agentPresets.defaultId !== 'ptc'
    || ctx.agentPresets.composedPreset(defaultAgent.ctx) !== 'ptc'
    || ctx.tools.modeFor(defaultAgent) !== 'ptc') {
    throw new Error('assembled Profile did not select the native PTC preset by default')
  }
  const ptc = await ctx.tools.execute({
    callId: ToolCallId('profile-smoke-ptc-sdk'),
    name: 'run_code',
    arguments: { code: 'return await tools.job_list({})', description: 'Verify native PTC tool dispatch' },
    agent: defaultAgent,
    signal: new AbortController().signal,
  })
  if (ptc.isError) throw new Error(`assembled native PTC dispatch failed: ${JSON.stringify(ptc)}`)

  // Standard remains available for its existing direct-dispatch contract checks.
  const disclosureAgent = (await ctx.agents.create({
    sessionId: SessionId('profile-smoke-tool-disclosure'),
    meta: { cwd: home },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'standard'),
  })).agent
  const initialToolNames = new Set(ctx.tools.schemas(disclosureAgent).map(schema => schema.name))
  if (!initialToolNames.has('tool_search')
    || !['generate_image', 'edit_image', 'get_image_generation_task', 'cancel_image_generation_task'].every(name => initialToolNames.has(name))
    || ['imagegen', 'image_batch', 'image_pack'].some(name => initialToolNames.has(name))
    || !['job_output', 'job_list', 'job_kill'].every(name => initialToolNames.has(name))
    || initialToolNames.has('skill_find') || initialToolNames.has('univer_new')) {
    throw new Error('assembled Profile did not apply progressive Tool disclosure')
  }

  const processTool = process.platform === 'win32' ? 'pwsh' : 'bash'
  const background = await ctx.tools.execute({
    callId: ToolCallId('profile-smoke-background-job'),
    name: processTool,
    arguments: {
      command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30',
      description: 'Hold harmless profile smoke process',
      run_in_background: true,
    },
    agent: disclosureAgent,
    signal: new AbortController().signal,
  })
  if (background.isError || background.value.kind !== 'background') {
    throw new Error(`assembled Profile could not start a native background Job: ${JSON.stringify(background)}`)
  }
  const cancelled = await ctx.tools.execute({
    callId: ToolCallId('profile-smoke-job-kill'),
    name: 'job_kill',
    arguments: { job_id: background.value.jobId, reason: 'profile cancellation smoke complete' },
    agent: disclosureAgent,
    signal: new AbortController().signal,
  })
  if (cancelled.isError || cancelled.value.outcome !== 'cancellation-requested') {
    throw new Error(`assembled Profile native job_kill did not request cancellation: ${JSON.stringify(cancelled)}`)
  }
  const terminalJob = await ctx.jobs.wait(background.value.jobId, 5_000, disclosureAgent)
  if (terminalJob.status !== 'killed') {
    throw new Error(`assembled Profile background Job settled as ${terminalJob.status} instead of killed`)
  }

  const disclosure = await ctx.tools.execute({
    callId: ToolCallId('profile-smoke-tool-search'),
    name: 'tool_search',
    arguments: { query: 'skill_find', limit: 1 },
    agent: disclosureAgent,
    signal: new AbortController().signal,
  })
  if (disclosure.isError || !ctx.tools.schemas(disclosureAgent).some(schema => schema.name === 'skill_find')) {
    throw new Error(`assembled Profile Tool Search did not reveal the native skill_find Tool: ${JSON.stringify(disclosure)}`)
  }
  // Three states, as the Electron shell reaches them: the bare root is refused,
  // the process-token exchange mints the browser-session cookie inside the
  // renderer session, and the marker URL then serves the application.
  const unauthenticated = await fetch(expectedUrl, { redirect: 'manual' })
  await unauthenticated.body?.cancel()
  if (unauthenticated.status !== 401) {
    throw new Error(`assembled Web root accepted an unauthenticated request with HTTP ${String(unauthenticated.status)}`)
  }
  const rendererSession = createRendererSession()
  await authenticateRendererSession(rendererSession, expectedAuthenticationUrl)
  const response = await fetch(expectedUrl, { headers: { cookie: rendererSession.cookieHeader() } })
  const html = await response.text()
  if (response.status !== 200) {
    throw new Error(`assembled Web root returned HTTP ${String(response.status)}`)
  }
  // The pinned native index serializer emits one `globalThis["__DSH_BOOT__"]`
  // row (host/webserver injections.ts), not the older `window.__DSH_BOOT__`
  // assignment this gate used to look for.
  const bootMatch = html.match(/globalThis\["__DSH_BOOT__"\] = (\{[^<]*\})<\/script>/u)
  if (bootMatch?.[1] === undefined) {
    const occurrences = (html.match(/__DSH_BOOT__/gu) ?? []).length
    throw new Error(`assembled Web root carries no globalThis["__DSH_BOOT__"] row (${String(html.length)} bytes, ${String(occurrences)} name occurrences)`)
  }
  const graph = JSON.parse(bootMatch[1])
  const ids = new Set(graph.entries.map(entry => entry.id))
  if (ids.has('@e-mate/dsh-plugin-univer-office') || ids.has('dsh-univer-office')) throw new Error('optional Univer plugin is unexpectedly bundled')
  if (ids.has('@kelearns/dsh-navigation-bar')) throw new Error('retired navigation plugin is still active')
  for (const id of [
    '@e-mate/desktop',
    '@e-mate/dsh-plugin-file-import',
    '@e-mate/dsh-plugin-skill-hub',
    '@e-mate/dsh-plugin-genui',
    '@e-mate/dsh-plugin-vision-toolkit',
    '@deepseek-ai/dsh-client-ui-conversation',
    // The native `ui-sidebar` row. The e-Mate shell answers it under that row's
    // own package identity (see src/e-mate-profile.ts, shellIdentityOverride), so
    // this id is the Sidebar the product serves.
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@e-mate/dsh-plugin-better-sidebar',
    ...(prepared.mode === 'compatibility' ? ['@deepseek-ai/dsh-client-ui-layout'] : []),
    '@deepseek-ai/dsh-client-ui-directory-picker-native',
    'dsh-at-file',
    'dsh-file-viewer',
    'dsh-visualize',
  ]) {
    if (!ids.has(id)) {
      throw new Error(`assembled desktop Web graph is missing ${id}; got ${[...ids].sort().join(', ')}`)
    }
  }
  // The Sidebar has exactly one implementation, and it is the one the native
  // `ui-sidebar` row loads: the e-Mate shell, installed under that row's package
  // identity, whose client bundle registers that same id
  // (packages/dsh/profile/plugins/emate-shell/tsdown.config.ts). A graph row for
  // the shell's own package name would be a second Sidebar implementation, so
  // requiring exactly one of the two identities fails closed if the Sidebar is
  // missing and if a second mount reappears. @e-mate/dsh-plugin-better-sidebar is
  // not either identity: it contributes a conversation view
  // (packages/dsh-plugin-better-sidebar/src/client/index.tsx).
  const sidebarImplementations = [
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@e-mate/dsh-client-shell',
  ].filter(id => ids.has(id))
  if (sidebarImplementations.length !== 1) {
    throw new Error(`assembled desktop Web graph must carry exactly one Sidebar implementation, got ${sidebarImplementations.length === 0 ? 'none' : sidebarImplementations.join(', ')}`)
  }
  for (const id of [
    '@deepseek-ai/dsh-client-ui-directory-picker-browse',
    ...(prepared.mode === 'advanced' ? ['@deepseek-ai/dsh-client-ui-layout'] : []),
  ]) {
    if (ids.has(id)) throw new Error(`assembled desktop Web graph unexpectedly includes ${id}`)
  }
  if (globalThis.__ModuleLoader__ !== undefined || globalThis.window !== undefined) {
    throw new Error('client Loader smoke requires a clean Node global')
  }
  globalThis.window = globalThis
  const registered = new Set()
  globalThis.__ModuleLoader__ = {
    load(handoff) {
      if (typeof handoff?.id !== 'string' || typeof handoff.factory !== 'function' || registered.has(handoff.id)) {
        throw new Error(`client bundle registration is invalid: ${String(handoff?.id)}`)
      }
      registered.add(handoff.id)
    },
  }
  try {
    for (const entry of graph.entries) {
      const path = entry.url
      const url = new URL(path, expectedUrl)
      if (url.origin !== new URL(expectedUrl).origin) throw new Error(`client bundle escaped the loopback origin: ${url.href}`)
      const bundle = await fetch(url, { headers: { cookie: rendererSession.cookieHeader() } })
      if (bundle.status !== 200) throw new Error(`client bundle returned HTTP ${bundle.status}: ${url.href}`)
      runInThisContext(await bundle.text(), { filename: url.href })
      if (!registered.has(entry.id)) throw new Error(`client bundle did not register its graph id: ${entry.id}`)
    }
  } finally {
    delete globalThis.__ModuleLoader__
    delete globalThis.window
  }
} finally {
  try {
    await ctx?.fiber.dispose()
  } finally {
    try {
      releasePackageResolver?.()
    } finally {
      try {
        pnpmRuntime?.dispose()
      } finally {
        if (previousDshHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousDshHome
        rmSync(home, { recursive: true, force: true })
      }
    }
  }
}
