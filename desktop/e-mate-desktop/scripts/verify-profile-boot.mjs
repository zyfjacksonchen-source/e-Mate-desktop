/** Headless smoke for the complete bundled DSH Web profile and renderer manifest. */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { CallId } from '@deepseek-ai/dsh-llm'
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
  const prepared = prepareDesktopProfile('1', home, selectedTarget.platform)
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

  const expectedUrl = `http://127.0.0.1:${String(ctx.webServer.port)}/?dsh-desktop-mode=${prepared.mode}&dsh-desktop-platform=${selectedTarget.platform}`
  if (mountedSpec?.url !== expectedUrl) {
    throw new Error(`desktop plugin produced an unexpected renderer URL: ${String(mountedSpec?.url)}`)
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
  const disclosureAgent = (await ctx.agents.create({
    sessionId: SessionId('profile-smoke-tool-disclosure'),
    meta: { cwd: home },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx),
  })).agent
  const initialToolNames = new Set(ctx.tools.schemas(disclosureAgent).map(schema => schema.name))
  if (!initialToolNames.has('tool_search')
    || !initialToolNames.has('imagegen')
    || !initialToolNames.has('image_pack')
    || !['job_output', 'job_list', 'job_kill'].every(name => initialToolNames.has(name))
    || initialToolNames.has('office_write')) {
    throw new Error('assembled Profile did not apply progressive Tool disclosure')
  }

  const processTool = process.platform === 'win32' ? 'pwsh' : 'bash'
  const background = await ctx.tools.execute({
    callId: CallId('profile-smoke-background-job'),
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
    callId: CallId('profile-smoke-job-kill'),
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
    callId: CallId('profile-smoke-tool-search'),
    name: 'tool_search',
    arguments: { query: 'office_write', limit: 1 },
    agent: disclosureAgent,
    signal: new AbortController().signal,
  })
  if (disclosure.isError || !ctx.tools.schemas(disclosureAgent).some(schema => schema.name === 'office_write')) {
    throw new Error(`assembled Profile Tool Search did not reveal the original office_write Tool: ${JSON.stringify(disclosure)}`)
  }
  const response = await fetch(expectedUrl)
  const html = await response.text()
  if (response.status !== 200) {
    throw new Error(`assembled Web root returned HTTP ${String(response.status)}`)
  }
  const bootMatch = html.match(/window\.__DSH_BOOT__ = (\{.*?\})<\/script>/u)
  if (bootMatch?.[1] === undefined) {
    throw new Error('assembled Web root is missing window.__DSH_BOOT__')
  }
  const graph = JSON.parse(bootMatch[1])
  const ids = new Set(graph.entries.map(entry => entry.id))
  if (ids.has('@kelearns/dsh-navigation-bar')) throw new Error('retired navigation plugin is still active')
  for (const id of [
    '@e-mate/desktop',
    '@e-mate/dsh-plugin-file-import',
    '@e-mate/dsh-plugin-office-skills',
    '@e-mate/dsh-plugin-skill-hub',
    '@e-mate/dsh-plugin-genui',
    '@e-mate/dsh-plugin-vision-toolkit',
    '@e-mate/dsh-plugin-tidychat',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-sidebar',
    ...(prepared.mode === 'compatibility' ? ['@deepseek-ai/dsh-client-ui-layout'] : []),
    '@deepseek-ai/dsh-client-ui-directory-picker-native',
    'dsh-at-file',
    '@e-mate/dsh-plugin-better-sidebar',
    'dsh-file-viewer',
    'dsh-visualize',
  ]) {
    if (!ids.has(id)) {
      throw new Error(`assembled desktop Web graph is missing ${id}; got ${[...ids].sort().join(', ')}`)
    }
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
      const bundle = await fetch(url)
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
