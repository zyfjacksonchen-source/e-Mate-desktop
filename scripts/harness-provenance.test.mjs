import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import test from 'node:test'

import {
  assertExactOccurrence,
  assertNativeAgentLoop,
  assertHarnessSource,
  assertHarnessSourceClean,
  DESKTOP_OVERLAYS,
  findDesktopHarnessPackages,
  HARNESS_COMMIT,
  hashDirectory,
  runHarnessBuildScripts,
  frontendBuildRecord,
  verifyFrontendBuildRecord,
  materializeFrontendDist,
  harnessFrontendViteConfig,
} from './harness-provenance.mjs'
import { pinnedPnpmInvocation } from './package-manager.mjs'
import { CONVERSATION_ADAPTER_PATH, CONVERSATION_PACKAGE } from './harness-conversation-adapter.mjs'
import { SESSION_EXPORT_ADAPTER_PATH, SESSION_EXPORT_PACKAGE } from './harness-session-export-adapter.mjs'
import { ARTIFACT_LINKS_ADAPTER_PATH, ARTIFACT_LINKS_PACKAGE, ARTIFACT_LINKS_RENDERER_PATH } from './harness-artifact-links-adapter.mjs'
import { FS_BYTES_ADAPTER_PATH, FS_BYTES_PACKAGE } from './harness-fs-bytes-adapter.mjs'

import { adaptHarnessSessionTitleSource, SESSION_TITLE_PACKAGE, SESSION_TITLE_ADAPTER_PATH } from './harness-runtime-adapters.mjs'

const root = resolve(import.meta.dirname, '..')
const harnessRoot = join(root, 'upstream', 'deepseek-harness')

test('runtime and Desktop materialization share the conversation owner adapter and record its provenance', () => {
  const runtime = readFileSync(join(root, 'scripts/harness-runtime-adapters.mjs'), 'utf8')
  const desktop = readFileSync(join(root, 'scripts/harness-provenance.mjs'), 'utf8')
  assert.equal(CONVERSATION_PACKAGE, '@deepseek-ai/dsh-client-ui-conversation')
  assert.equal(CONVERSATION_ADAPTER_PATH, 'scripts/harness-conversation-adapter.mjs')
  assert.equal(ARTIFACT_LINKS_ADAPTER_PATH, 'scripts/harness-artifact-links-adapter.mjs')
  assert.equal(ARTIFACT_LINKS_PACKAGE, '@deepseek-ai/dsh-client-ui-primitives')
  assert.match(runtime, /adaptHarnessArtifactLinksSource\(await readFile\(artifactTarget/u)
  assert.match(desktop, /adaptHarnessArtifactLinksSource\(readFileSync\(entry/u)
  assert.match(desktop, /adaptHarnessArtifactLinksSource\(readFileSync\(join\(sourceLib, 'index.js'\)/u)
  assert.match(runtime, /adaptHarnessConversationSource\(await readFile\(conversationTarget/u)
  assert.match(desktop, /adaptHarnessConversationSource\(readFileSync\(client/u)
  assert.match(desktop, /adapter: adapter === null \? null : \{ path: adapter, sha256:/u)
})

test('pins one clean native model-directory refresh owner', () => {
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: harnessRoot, encoding: 'utf8' }).trim(), HARNESS_COMMIT)
  assert.doesNotThrow(() => assertHarnessSource(root))
  const source = readFileSync(join(
    harnessRoot,
    'packages/client/ui-model-selection/src/client/service.ts',
  ), 'utf8')
  assertExactOccurrence(source, "ctx.remote.$on('credentials/reference-updated', refresh)", 'native model listener')
})

test('Desktop session archives use the same native export adapter and record its file-import contract', () => {
  const runtime = readFileSync(join(root, 'scripts/harness-runtime-adapters.mjs'), 'utf8')
  const desktop = readFileSync(join(root, 'scripts/harness-provenance.mjs'), 'utf8')
  assert.equal(SESSION_EXPORT_PACKAGE, '@deepseek-ai/dsh-session-log-export')
  assert.equal(SESSION_EXPORT_ADAPTER_PATH, 'scripts/harness-session-export-adapter.mjs')
  assert.match(runtime, /adaptHarnessSessionExportSource\(await readFile\(exportTarget/u)
  assert.match(desktop, /adaptHarnessSessionExportSource\(readFileSync\(entry/u)
  assert.match(desktop, /adaptHarnessSessionExportSource\(readFileSync\(join\(sourceLib, 'index.js'\)/u)
  assert.match(desktop, /adapter_inputs:[\s\S]*packages\/dsh-plugin-file-import\/src\/contract.ts/u)
  assert.equal(FS_BYTES_PACKAGE, '@deepseek-ai/dsh-fs-local')
  assert.equal(FS_BYTES_ADAPTER_PATH, 'scripts/harness-fs-bytes-adapter.mjs')
  assert.match(runtime, /adaptHarnessFsBytesSource\(await readFile\(bytesTarget/u)
  assert.match(desktop, /adaptHarnessFsBytesSource\(readFileSync\(entry/u)
  assert.match(desktop, /adaptHarnessFsBytesSource\(readFileSync\(join\(sourceLib, 'index.js'\)/u)
})

test('runs manager-free Harness build scripts in order through inherited pnpm and fails fast', () => {
  const directory = mkdtempSync(join(tmpdir(), 'e-mate-pinned-pnpm-'))
  const entry = join(directory, 'v1/pnpm/11.7.0/bin/pnpm.cjs')
  const log = join(directory, 'invocation.json')
  try {
    mkdirSync(join(directory, 'v1/pnpm/11.7.0/bin'), { recursive: true })
    writeFileSync(entry, [
      "if (process.argv[2] === '--version') process.stdout.write('11.7.0\\n')",
      'else {',
      "  const args = process.argv.slice(2)",
      "  require('node:fs').appendFileSync(process.env.T25_PM_LOG, `${JSON.stringify(args)}\\n`)",
      "  if (args.includes('--config')) require('node:fs').writeFileSync(process.env.T25_PM_LOG + '.config', require('node:fs').readFileSync(args[args.indexOf('--config') + 1]))",
      "  if (args.at(-1) === process.env.T25_FAIL_SCRIPT) process.exit(7)",
      '}',
    ].join('\n'))
    const env = { PATH: '/usr/bin:/bin', npm_execpath: entry, T25_PM_LOG: log }
    const expected = [
      ['--dir', 'upstream/deepseek-harness', 'run', 'build:lib:host'],
      ['--dir', 'upstream/deepseek-harness', 'exec', 'tsc', '-b', 'tsconfig.client.json'],
      ['--dir', 'upstream/deepseek-harness', 'run', 'build:lib:client'],
      ['--dir', 'upstream/deepseek-harness', '--filter', '@deepseek-ai/dsh-web-frontend', 'run', 'build'],
    ]
    runHarnessBuildScripts(directory, '11.7.0', env)
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(calls.slice(0, 3), expected.slice(0, 3))
    assert.deepEqual(calls[3].slice(0, -2), expected[3])
    assert.equal(calls[3].at(-2), '--config')
    assert.equal(existsSync(calls[3].at(-1)), false, 'ephemeral Vite config is removed')
    assert.match(readFileSync(log + '.config', 'utf8'), /artifactLinksVitePlugin.*realpathSync/)
    assert.match(readFileSync(log + '.config', 'utf8'), /apps\/web\/vite\.config\.ts/)
    assert.equal(expected.flat().includes('npm'), false)

    writeFileSync(log, '')
    assert.throws(
      () => runHarnessBuildScripts(directory, '11.7.0', { ...env, T25_FAIL_SCRIPT: 'tsconfig.client.json' }),
      /tsconfig.client.json exited with 7/u,
    )
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), expected.slice(0, 2))

    writeFileSync(entry, "process.stdout.write('11.19.0\\n')\n")
    assert.throws(() => pinnedPnpmInvocation('11.7.0', [], { env }), /requires pinned pnpm 11\.7\.0/u)
    assert.throws(
      () => pinnedPnpmInvocation('11.7.0', [], { env, execPath: join(directory, 'missing-node') }),
      /active Node executable is unavailable/u,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('keeps exactly the three pinned Desktop overlays', () => {
  assert.deepEqual([...DESKTOP_OVERLAYS], [
    ['@deepseek-ai/dsh-app-boot', 'desktop/patches/dsh-app-boot@0.1.5-rc.1.patch'],
    ['@deepseek-ai/dsh-client-ui-workspace', 'desktop/patches/dsh-client-ui-workspace@0.1.5-rc.1.patch'],
    ['@deepseek-ai/dsh-win32-process', 'desktop/patches/dsh-win32-process@0.1.5-rc.1.patch'],
  ])

  const appBoot = readFileSync(join(harnessRoot, 'packages/boot/app-boot/src/index.ts'), 'utf8')
  const appBootPatch = readFileSync(join(root, DESKTOP_OVERLAYS.get('@deepseek-ai/dsh-app-boot')), 'utf8')
  assert.equal(appBoot.includes('parsed === undefined') || appBoot.includes('parsed === null'), false)
  assert.ok(appBoot.includes('if (!Array.isArray(parsed))'))
  assert.ok(appBootPatch.includes('+	if (parsed === void 0 || parsed === null) return [];'))

  const workspace = readFileSync(join(harnessRoot, 'packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx'), 'utf8')
  const workspacePatch = readFileSync(join(root, DESKTOP_OVERLAYS.get('@deepseek-ai/dsh-client-ui-workspace')), 'utf8')
  assert.doesNotMatch(workspace, /data-dsh-workspace-drop-target/u)
  assert.match(workspacePatch, /data-dsh-workspace-drop-target/u)

  const windows = readFileSync(join(harnessRoot, 'packages/subprocess/win32-process/src/process.ts'), 'utf8')
  const windowsPatch = readFileSync(join(root, DESKTOP_OVERLAYS.get('@deepseek-ai/dsh-win32-process')), 'utf8')
  assert.equal(windows.match(/dwFlags: abi\.STARTF_USESTDHANDLES/gu)?.length, 2)
  assert.doesNotMatch(windows, /wShowWindow/u)
  assert.equal(windowsPatch.match(/^\+\s*wShowWindow: 0,/gmu)?.length, 2)

  // 0.1.5 absorbed the former redundant-escalation overlay: each escalation
  // owner now runs the single native pairing validation, so no patch remains.
  for (const path of [
    'packages/fs/tool-fs/src/sandbox.ts',
    'packages/shell/tool-bash/src/index.ts',
    'packages/shell/tool-pwsh/src/index.ts',
  ]) {
    const native = readFileSync(join(harnessRoot, path), 'utf8')
    assert.equal(native.match(/validateEscalationArgs\(args\.sandbox_permissions, args\.justification\)/gu)?.length, 1)
    assert.doesNotMatch(native, /redundantEscalation/u)
  }
})

test('rejects zero or two native owners instead of guessing', () => {
  assert.throws(() => assertExactOccurrence('', 'owner', 'fixture owner'), /expected once, found 0/u)
  assert.throws(() => assertExactOccurrence('owner\nowner', 'owner', 'fixture owner'), /expected once, found 2/u)
})

test('rejects tracked and untracked dirty Harness source', () => {
  const directory = mkdtempSync(join(tmpdir(), 'e-mate-harness-clean-'))
  const tracked = join(directory, 'tracked.txt')
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: directory })
    writeFileSync(tracked, 'accepted\n')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: directory })
    execFileSync('git', [
      '-c', 'user.name=e-Mate Test', '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '-m', 'fixture',
    ], { cwd: directory })
    assert.doesNotThrow(() => assertHarnessSourceClean(directory))

    writeFileSync(tracked, 'dirty\n')
    assert.throws(() => assertHarnessSourceClean(directory), /source must be clean/u)
    writeFileSync(tracked, 'accepted\n')
    assert.doesNotThrow(() => assertHarnessSourceClean(directory))

    writeFileSync(join(directory, 'untracked.txt'), 'dirty\n')
    assert.throws(() => assertHarnessSourceClean(directory), /source must be clean/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('hashes emitted libs deterministically and rejects byte drift', () => {
  const directory = mkdtempSync(join(tmpdir(), 'e-mate-harness-hash-'))
  const reverse = mkdtempSync(join(tmpdir(), 'e-mate-harness-hash-reverse-'))
  try {
    mkdirSync(join(directory, 'nested'))
    writeFileSync(join(directory, 'z.js'), 'z\n')
    writeFileSync(join(directory, 'nested', 'a.js'), 'a\n')
    writeFileSync(join(reverse, 'z.js'), 'z\n')
    mkdirSync(join(reverse, 'nested'))
    writeFileSync(join(reverse, 'nested', 'a.js'), 'a\n')
    const first = hashDirectory(directory)
    assert.equal(hashDirectory(directory), first)
    assert.equal(hashDirectory(reverse), first)
    writeFileSync(join(directory, 'nested', 'a.js'), 'changed\n')
    assert.notEqual(hashDirectory(directory), first)
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(reverse, { recursive: true, force: true })
  }
})

test('discovers root and nested physical Desktop Harness packages', () => {
  const directory = mkdtempSync(join(tmpdir(), 'e-mate-desktop-closure-'))
  const writePackage = (path, name) => {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), `${JSON.stringify({ name, version: '0.1.5-rc.1' })}\n`)
  }
  try {
    writePackage(join(directory, '@deepseek-ai/dsh-session'), '@deepseek-ai/dsh-session')
    writePackage(join(directory, 'holder'), 'holder')
    writePackage(
      join(directory, 'holder/node_modules/@deepseek-ai/dsh-session-persistence'),
      '@deepseek-ai/dsh-session-persistence',
    )
    assert.deepEqual(
      findDesktopHarnessPackages(directory).map(value => relative(directory, value.path).split(sep).join('/')),
      ['@deepseek-ai/dsh-session', 'holder/node_modules/@deepseek-ai/dsh-session-persistence'],
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Desktop declares no Session, model-directory, bash, or pwsh patch path', () => {
  const manifest = readFileSync(join(root, 'desktop/package.json'), 'utf8')
  assert.doesNotMatch(manifest, /"@deepseek-ai\/dsh-session(?:-persistence)?@npm:[^"]+":\s*"patch:/u)
  assert.doesNotMatch(manifest, /dsh-client-ui-model-selection@.*patch:/u)
  assert.doesNotMatch(manifest, /"@deepseek-ai\/dsh-tool-(?:bash|pwsh)@npm:[^"]+":\s*"patch:/u)
})


test('frontend build inputs invalidate old receipts and materialization copies the actual shipped dist', () => {
  const directory = mkdtempSync(join(tmpdir(), 'emate-frontend-receipt-'))
  try {
    const native = join(directory, 'upstream/deepseek-harness')
    const renderer = join(native, ARTIFACT_LINKS_RENDERER_PATH)
    mkdirSync(join(directory, 'scripts'), { recursive: true })
    mkdirSync(join(native, 'apps/web/dist/assets'), { recursive: true })
    mkdirSync(join(renderer, '..'), { recursive: true })
    writeFileSync(renderer, readFileSync(join(harnessRoot, ARTIFACT_LINKS_RENDERER_PATH)))
    writeFileSync(join(directory, ARTIFACT_LINKS_ADAPTER_PATH), readFileSync(join(root, ARTIFACT_LINKS_ADAPTER_PATH)))
    writeFileSync(join(directory, 'scripts/harness-provenance.mjs'), readFileSync(join(root, 'scripts/harness-provenance.mjs')))
    writeFileSync(join(native, 'apps/web/dist/index.html'), '<script src="assets/test.js"></script>')
    writeFileSync(join(native, 'apps/web/dist/assets/test.js'), 'synthetic browser output')
    writeFileSync(join(native, 'apps/web/dist/assets/test.js.map'), 'not in native release:pack files')
    const current = frontendBuildRecord(directory)
    assert.doesNotThrow(() => verifyFrontendBuildRecord(directory, current))
    assert.throws(() => verifyFrontendBuildRecord(directory, undefined), /frontend.*changed/)
    assert.throws(() => verifyFrontendBuildRecord(directory, { ...current, artifact_adapter: { ...current.artifact_adapter, sha256: '0'.repeat(64) } }), /frontend.*changed/)
    const target = join(directory, 'desktop/node_modules/@deepseek-ai/dsh-web-frontend')
    mkdirSync(join(target, 'dist'), { recursive: true }); writeFileSync(join(target, 'dist/old.js'), 'stale published package bytes')
    materializeFrontendDist(native, target)
    assert.equal(readFileSync(join(target, 'dist/assets/test.js'), 'utf8'), 'synthetic browser output')
    assert.equal(existsSync(join(target, 'dist/old.js')), false)
    assert.equal(existsSync(join(target, 'dist/assets/test.js.map')), false)
    writeFileSync(join(native, 'apps/web/dist/assets/test.js'), 'changed frontend output')
    assert.throws(() => verifyFrontendBuildRecord(directory, current), /frontend.*changed/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})


test('generated Vite configuration resolves the pinned native aliases and the pre-transform before React', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'emate-native-vite-config-'))
  try {
    const configFile = join(directory, 'vite.config.mjs')
    writeFileSync(configFile, harnessFrontendViteConfig(root))
    const nativeRequire = createRequire(join(harnessRoot, 'apps/web/package.json'))
    const { resolveConfig } = await import(pathToFileURL(nativeRequire.resolve('vite')).href)
    const config = await resolveConfig({ configFile, root: join(harnessRoot, 'apps/web'), logLevel: 'silent' }, 'build')
    const artifact = config.plugins.findIndex(plugin => plugin.name === 'e-mate-native-artifact-links')
    assert(artifact >= 0)
    assert(artifact < config.plugins.findIndex(plugin => plugin.name === 'vite:react-babel'))
    const alias = config.resolve.alias.find(alias => alias.find instanceof RegExp && alias.find.test('@deepseek-ai/dsh-client-ui-primitives'))
    assert(alias.replacement.endsWith('packages/client/ui-primitives/src/index.ts'))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('rejects missing, modified or overlaid Agent Loop packages at release verification', () => {
  const native = { name: '@deepseek-ai/dsh-agent-loop', source_lib_sha256: 'native', resolved_lib_sha256: 'native', adapter: null, overlay: null }
  assert.doesNotThrow(() => assertNativeAgentLoop([native]))
  for (const records of [[], [{ ...native, resolved_lib_sha256: 'modified' }],
    [{ ...native, adapter: { path: 'image-loop-adapter' } }],
    [{ ...native, overlay: { path: 'vision.patch' } }]]) {
    assert.throws(() => assertNativeAgentLoop(records), /Agent Loop must exactly match/)
  }
})


test('Desktop title materialization validates exact adapted bytes and records the shared adapter', () => {
  const runtime = readFileSync(join(root, 'scripts/harness-runtime-adapters.mjs'), 'utf8')
  const desktop = readFileSync(join(root, 'scripts/harness-provenance.mjs'), 'utf8')
  assert.equal(SESSION_TITLE_ADAPTER_PATH, 'scripts/harness-runtime-adapters.mjs')
  assert.match(runtime, /replaceRuntimeFile\(titleTarget, adaptHarnessSessionTitleSource/u)
  assert.match(desktop, /manifest.name === SESSION_TITLE_PACKAGE \? SESSION_TITLE_ADAPTER_PATH/u)
  const native = process.env.EMATE_TEST_NATIVE_ROOT ?? root
  const input = readFileSync(join(native, 'upstream/deepseek-harness/packages/session/session-title/lib/index.js'), 'utf8')
  const directory = mkdtempSync(join(tmpdir(), 'emate-title-materialization-'))
  const sourceLib = join(directory, 'source'), targetLib = join(directory, 'target')
  mkdirSync(sourceLib); mkdirSync(targetLib)
  writeFileSync(join(sourceLib, 'index.js'), input); writeFileSync(join(targetLib, 'index.js'), input)
  const materialize = desktop.match(/    if \(manifest.name === SESSION_TITLE_PACKAGE\) \{[\s\S]*?\n    \}/u)?.[0]
  const verify = desktop.match(/    if \(manifest.name === SESSION_TITLE_PACKAGE &&[\s\S]*?\n    \}/u)?.[0]
  assert(materialize); assert(verify)
  const scope = { manifest: { name: SESSION_TITLE_PACKAGE }, SESSION_TITLE_PACKAGE, sourceLib, targetLib,
    join, readFileSync, writeFileSync, adaptHarnessSessionTitleSource }
  try {
    assert.throws(() => runInNewContext(verify, scope), /session titles do not match/)
    runInNewContext(materialize, scope)
    assert.equal(readFileSync(join(sourceLib, 'index.js'), 'utf8'), input)
    assert.equal(readFileSync(join(targetLib, 'index.js'), 'utf8'), adaptHarnessSessionTitleSource(input))
    assert.doesNotThrow(() => runInNewContext(verify, scope))
    writeFileSync(join(targetLib, 'index.js'), adaptHarnessSessionTitleSource(input) + '\n// unexpected drift')
    assert.throws(() => runInNewContext(verify, scope), /session titles do not match/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
