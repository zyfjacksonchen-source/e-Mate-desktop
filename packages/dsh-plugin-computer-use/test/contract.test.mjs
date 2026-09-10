import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { installComputerUseCapability } from '../lib/emate-capability.js'
import { desktopAutomationBypass, hasExplicitComputerUseRequest } from '../lib/emate-explicit.js'

const root = new URL('../', import.meta.url)

test('computer-use adapter keeps pinned owners, exact captures and dual platform policy', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')
  const policyEnglish = await readFile(new URL('docs/interaction-policy.md', root))
  const policyChinese = await readFile(new URL('docs/interaction-policy.zh.md', root))
  const policyHashes = await readFile(new URL('docs/interaction-policy.i18n.yaml', root), 'utf8')
  const macHelper = await readFile(new URL('native/macos/Sources/Helper/main.swift', root), 'utf8')
  const nativeBuilder = await readFile(new URL('scripts/build-native.mjs', root), 'utf8')
  const adapterBuilder = await readFile(new URL('scripts/build.mjs', root), 'utf8')
  const client = await readFile(new URL('lib/client.js', root), 'utf8')
  const leases = await readFile(new URL('lib/leases.js', root), 'utf8')
  const upstreamLeases = await readFile(new URL('../../upstream/plugins/dsh-computer-use/lib/leases.js', root), 'utf8')
  const bundle = await readFile(new URL('lib/index.js', root), 'utf8')
  assert.equal(pkg.version, '2.0.18')
  assert.equal(pkg.dsh.upstream.commit, '76bfe8607f61945c1cbb84e73976e601100c13a2')
  assert.equal(pkg.eMate.harnessVersion, '0.1.5-rc.1')
  assert.match(patch, /disabled: !!js Array\.of\('darwin', 'win32'\)\.includes\(process\.platform\) === false/u)
  assert.doesNotMatch(patch, /!!js\s+!/u)
  assert.match(patch, /process\.platform === 'win32' \? 'hidden' : 'visible'/u)
  assert.match(patch, /focusPolicy:\s*preserve/u)
  assert.match(patch, /keyboardPolicy:\s*preserve/u)
  assert.match(patch, /cursorMotionMs:\s*0/u)
  assert.doesNotMatch(patch, /(?:focusPolicy|keyboardPolicy):\s*activate/u)
  assert.match(macHelper, /interactionValue\(interaction, "keyboardPolicy", \["preserve", "activate"\]\)/u)
  assert.match(macHelper, /guard effectiveFocusPolicy == "activate" else \{[\s\S]*return \(snapshot, record, "not-requested"\)/u)
  assert.match(macHelper, /private func pressKey[\s\S]*?down\.postToPid\(app\.processIdentifier\)[\s\S]*?up\.postToPid\(app\.processIdentifier\)/u)
  assert.match(macHelper, /private func typeTextWithKeyboard[\s\S]*?down\.postToPid\(app\.processIdentifier\)[\s\S]*?up\.postToPid\(app\.processIdentifier\)/u)
  const capture = macHelper.slice(macHelper.indexOf('private func captureWindow'), macHelper.indexOf('private func observationJSON'))
  assert.match(capture, /windowID == expectedId &&.*processID == snapshot\.app\.processIdentifier/u)
  assert.match(capture, /afterFrame == expectedFrame/u)
  assert.doesNotMatch(capture, /windows\.max|window\.title == expectedTitle/u)
  assert.match(adapterBuilder, /before\?\.sourceSha256 !== sourceDigest/u)
  assert.doesNotMatch(adapterBuilder, /rm\(join\(root, 'native\/macos'\)/u)
  assert.match(adapterBuilder, /nativeManifest\.sourceSha256 !== sourceDigest/u)
  assert.match(adapterBuilder, /nativeManifest\.binary\.sha256 !== createHash/u)
  assert.match(adapterBuilder, /error\.code !== 'ENOENT'/u)
  const gitBlobHash = contents => createHash('sha1')
    .update(`blob ${contents.byteLength}\0`)
    .update(contents)
    .digest('hex')
  assert.match(policyHashes, new RegExp(`^interaction-policy\\.md: ${gitBlobHash(policyEnglish)}$`, 'mu'))
  assert.match(policyHashes, new RegExp(`^interaction-policy\\.zh\\.md: ${gitBlobHash(policyChinese)}$`, 'mu'))
  for (const policy of [policyEnglish.toString('utf8'), policyChinese.toString('utf8')]) {
    assert.match(policy, /keyboardPolicy: preserve/u)
    assert.match(policy, /cursorVisualization: !!js "process\.platform === 'win32' \? 'hidden' : 'visible'"/u)
    assert.match(policy, /cursorAutoHideMs: 0/u)
    assert.match(policy, /Windows[\s\S]*raw[\s\S]*(?:background|后台)[\s\S]*(?:denied|拒绝)/u)
  }
  assert.doesNotMatch(patch, /allowAllApps:\s*true/u)
  if (process.platform === 'darwin') {
    const manifest = JSON.parse(await readFile(new URL('native/macos/manifest.json', root), 'utf8'))
    const helper = await readFile(new URL('native/macos/bin/dsh-computer-use-helper', root))
    assert.deepEqual(manifest.binary.architectures, ['arm64', 'x86_64'])
    assert.equal(createHash('sha256').update(helper).digest('hex'), manifest.binary.sha256)
    const verified = spawnSync('/usr/bin/codesign', ['--verify', '--strict', new URL('native/macos/bin/dsh-computer-use-helper', root).pathname], { encoding: 'utf8' })
    assert.equal(verified.status, 0, verified.stderr)
    const signature = spawnSync('/usr/bin/codesign', ['-dvv', new URL('native/macos/bin/dsh-computer-use-helper', root).pathname], { encoding: 'utf8' })
    assert.match(`${signature.stdout}\n${signature.stderr}`, /Signature=adhoc/u)
  }
  assert.doesNotMatch(nativeBuilder, /HELPER_ENTITLEMENTS|--entitlements|allow-jit|disable-library-validation/u)
  assert.match(adapterBuilder, /nativeManifest\.binary\.sha256/u)
  assert.match(adapterBuilder, /process\.platform === 'darwin'/u)
  assert.match(adapterBuilder, /\['lib', 'assets'\]/u)
  assert.match(adapterBuilder, /process\.platform !== 'darwin' && process\.platform !== 'win32'/u)
  assert.doesNotMatch(adapterBuilder, /executablePath\?: string|processStartTime\?: string|windowId\?: number/u)
  assert.match(adapterBuilder, /finally \{[\s\S]*rm\(runtimeBundle[\s\S]*rm\(runtimeSource/u)
  assert.doesNotMatch(adapterBuilder, /unsupported computer-use build platform/u)
  assert.doesNotMatch(adapterBuilder, /--entitlements|allow-jit|allow-unsigned-executable-memory|disable-library-validation/u)
  assert.match(client, /@e-mate\/dsh-plugin-computer-use/u)
  assert.doesNotMatch(client, /@anionex\/dsh-computer-use/u)
  assert.doesNotMatch(adapterBuilder, /standingFullAccess|emate-permission|sandboxPolicy/u)
  assert.equal(leases, upstreamLeases)
  assert.doesNotMatch(leases, /standingFullAccess|emate-permission|sandboxPolicy/u)
  assert.equal((leases.match(/configuredAccess\(this\.config\(\), app\.bundleId, scope\)/gu) ?? []).length, 2)
  assert.match(leases, /approvalPolicy\(this\.ctx, agent\) === 'never'/u)
  assert.match(leases, /approval prompts are disabled/u)
  assert.doesNotMatch(bundle, /standingFullAccess|emate-permission/u)
  assert.doesNotMatch(bundle, /^import .* from ["']zod["'];?$/mu)
  assert.match(bundle, /current user request must explicitly select @电脑操控/u)
  assert.match(bundle, /Use CDP browser tools first for webpage tasks/u)
  assert.match(bundle, /new URL\("\.\.\/native\/macos\/", import\.meta\.url\)/u)
  assert.match(bundle, /windows-uia/u)
  assert.match(bundle, /new URL\("\.\.\/scripts\/build-native\.mjs", import\.meta\.url\)/u)
  assert.equal((bundle.match(/["']emateCapabilities["']/gu) ?? []).length, 1)
  assert.match(bundle, /installComputerUseCapability\(ctx, this\)/u)
})

test('Computer Use projects cached native readiness and permission actions through one lifecycle effect', async () => {
  const definitions = []
  const effects = []
  const permissionCalls = []
  let statusCalls = 0
  let snapshot = {
    ready: true, accessibility: 'granted', screenRecording: 'granted',
    applicationAccess: { allowAllApps: false, readGrants: 1, controlGrants: 1 },
  }
  const service = {
    status() {
      statusCalls += 1
      return snapshot
    },
    async openPermissionSettings(kind, signal) {
      permissionCalls.push([kind, signal])
    },
  }
  const ctx = {
    effect(install, label) {
      const dispose = install()
      effects.push({ dispose, label })
      return dispose
    },
    emateCapabilities: {
      register(definition) {
        definitions.push(definition)
        return () => definitions.splice(definitions.indexOf(definition), 1)
      },
    },
  }

  const dispose = installComputerUseCapability(ctx, service)
  assert.deepEqual(effects.map(effect => effect.label), ['dsh-computer-use: e-Mate capability metadata'])
  assert.deepEqual(definitions.map(definition => definition.id), ['computer-use'])
  const capability = definitions[0]

  assert.deepEqual(await capability.status(), {
    state: 'ready', detail: '原生 helper、macOS 权限和应用操作授权均已就绪。', action_ids: [],
  })
  assert.equal(statusCalls, 1, 'capability list reads only the cached service status once')

  snapshot = { ready: true, accessibility: 'denied', screenRecording: 'not-determined' }
  assert.deepEqual(await capability.status(), {
    state: 'setup-required', detail: '需要在 macOS 系统设置中开启对应权限。',
    action_ids: ['open-accessibility-settings', 'open-screen-recording-settings'],
  })
  const signal = new AbortController().signal
  await capability.invoke('open-accessibility-settings', {}, signal)
  await capability.invoke('open-screen-recording-settings', {}, signal)
  assert.deepEqual(permissionCalls, [['accessibility', signal], ['screen-recording', signal]])

  snapshot = {
    ready: true, accessibility: 'granted', screenRecording: 'granted',
    applicationAccess: { allowAllApps: false, readGrants: 0, controlGrants: 0 },
  }
  assert.deepEqual(await capability.status(), {
    state: 'setup-required', detail: 'macOS 权限已就绪，但尚未在 Computer Use 设置中授权任何应用操作。', action_ids: [],
  })

  snapshot = { ready: false, accessibility: 'unavailable', screenRecording: 'unavailable', lastError: 'provider failed' }
  assert.deepEqual(await capability.status(), { state: 'failed', detail: 'provider failed', action_ids: [] })
  snapshot = { ready: false, accessibility: 'unavailable', screenRecording: 'unavailable' }
  assert.deepEqual(await capability.status(), {
    state: 'blocked', detail: 'Computer Use 原生 provider 尚未就绪。', action_ids: [],
  })
  snapshot = { ready: true, accessibility: 'unavailable', screenRecording: 'granted' }
  assert.deepEqual(await capability.status(), {
    state: 'blocked', detail: 'Computer Use 无法读取所需的 macOS 权限状态。', action_ids: [],
  })

  dispose()
  assert.deepEqual(definitions, [])
})

test('Computer Use authorization expires before the next direct user request', () => {
  const message = (text, mentions) => ({
    type: 'user/message',
    data: { source: { kind: 'user', ...(mentions === undefined ? {} : { mentions }) }, content: [{ type: 'text', text }] },
  })
  const selected = [{ source: '电脑操控', ref: 'computer-use' }]
  assert.equal(hasExplicitComputerUseRequest({ events: [] }), false)
  assert.equal(hasExplicitComputerUseRequest({ events: [message('普通请求')] }), false)
  assert.equal(hasExplicitComputerUseRequest({ events: [message('@电脑操控 读取当前应用')] }), false)
  assert.equal(hasExplicitComputerUseRequest({ events: [message('请解释文本 @电脑操控 的含义')] }), false)
  assert.equal(hasExplicitComputerUseRequest({ events: [message('@电脑操控 读取当前应用', selected)] }), true)
  assert.equal(hasExplicitComputerUseRequest({ events: [message('引用历史 @电脑操控')] }), false)
  assert.equal(hasExplicitComputerUseRequest({
    events: [{ type: 'user/message', data: { source: { kind: 'plugin', mentions: selected }, content: [] } }],
  }), false)
  assert.equal(hasExplicitComputerUseRequest({
    events: [
      message('@电脑操控 读取当前应用', selected),
      message('下一轮普通请求'),
    ],
  }), false)
})

test('desktop automation bypass guard is narrow', () => {
  assert.equal(desktopAutomationBypass({ command: 'open -a Calculator' }), true)
  assert.equal(desktopAutomationBypass({ command: '/usr/bin/osascript -e \'tell app "Calculator" to activate\'' }), true)
  assert.equal(desktopAutomationBypass({ command: 'env open -a Calculator' }), true)
  assert.equal(desktopAutomationBypass({ command: 'nohup open -a Calculator' }), true)
  assert.equal(desktopAutomationBypass({ command: '/usr/bin/env osascript -e \'tell app "Calculator" to activate\'' }), true)
  assert.equal(desktopAutomationBypass({ command: '/bin/sh -c "open -a Calculator"' }), true)
  assert.equal(desktopAutomationBypass({ command: 'git status --short' }), false)
  assert.equal(desktopAutomationBypass({ command: 'rg -n "open|osascript" src test' }), false)
  assert.equal(desktopAutomationBypass({ command: 'echo open' }), false)
})
