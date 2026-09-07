import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import test from 'node:test'

import {
  assertExactOccurrence,
  assertHarnessSource,
  assertHarnessSourceClean,
  DESKTOP_OVERLAYS,
  findDesktopHarnessPackages,
  HARNESS_COMMIT,
  hashDirectory,
  runHarnessBuildScripts,
} from './harness-provenance.mjs'
import { pinnedPnpmInvocation } from './package-manager.mjs'
import { CONVERSATION_ADAPTER_PATH, CONVERSATION_PACKAGE } from './harness-conversation-adapter.mjs'
import { SESSION_EXPORT_ADAPTER_PATH, SESSION_EXPORT_PACKAGE } from './harness-session-export-adapter.mjs'
import { ARTIFACT_LINKS_ADAPTER_PATH, ARTIFACT_LINKS_PACKAGE } from './harness-artifact-links-adapter.mjs'
import { FS_BYTES_ADAPTER_PATH, FS_BYTES_PACKAGE } from './harness-fs-bytes-adapter.mjs'

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
  assertExactOccurrence(source, "ctx.remote.$on('credentials/updated', refresh)", 'native model listener')
})

test('Desktop session archives use the same native export adapter and record its file-import contract', () => {
  const runtime = readFileSync(join(root, 'scripts/harness-runtime-adapters.mjs'), 'utf8')
  const desktop = readFileSync(join(root, 'scripts/harness-provenance.mjs'), 'utf8')
  assert.equal(SESSION_EXPORT_PACKAGE, '@deepseek-ai/dsh-host-apiproxy')
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
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), expected)
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

test('keeps exactly the four pinned Desktop overlays', () => {
  assert.deepEqual([...DESKTOP_OVERLAYS], [
    ['@deepseek-ai/dsh-app-boot', 'desktop/patches/dsh-app-boot@0.1.0-rc.7.patch'],
    ['@deepseek-ai/dsh-client-ui-workspace', 'desktop/patches/dsh-client-ui-workspace@0.1.0-rc.7.patch'],
    ['@deepseek-ai/dsh-sandbox-windows-acl', 'desktop/patches/dsh-sandbox-windows-acl@0.1.0-rc.7.patch'],
    ['@deepseek-ai/dsh-tool-fs', 'desktop/.yarn/patches/@deepseek-ai-dsh-tool-fs-npm-0.1.0-rc.7-redundant-escalation.patch'],
  ])

  const appBoot = readFileSync(join(harnessRoot, 'packages/boot/app-boot/src/index.ts'), 'utf8')
  const appBootPatch = readFileSync(join(root, DESKTOP_OVERLAYS.get('@deepseek-ai/dsh-app-boot')), 'utf8')
  assert.equal(appBoot.includes('parsed === undefined') || appBoot.includes('parsed === null'), false)
  assert.ok(appBoot.includes('if (!Array.isArray(parsed))'))
  assert.ok(appBootPatch.includes('+	if (parsed === void 0 || parsed === null) return [];'))

  const workspace = readFileSync(join(harnessRoot, 'packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx'), 'utf8')
  const workspacePatch = readFileSync(join(root, DESKTOP_OVERLAYS.get('@deepseek-ai/dsh-client-ui-workspace')), 'utf8')
  assert.doesNotMatch(workspace, /data-dsh-workspace-drop-target/u)
  assert.match(workspacePatch, /data-dsh-workspace-drop-target/u)

  const windows = readFileSync(join(harnessRoot, 'packages/sandbox/sandbox-windows-acl/src/spawn.ts'), 'utf8')
  const windowsPatch = readFileSync(join(root, DESKTOP_OVERLAYS.get('@deepseek-ai/dsh-sandbox-windows-acl')), 'utf8')
  assert.equal(windows.match(/dwFlags: abi\.STARTF_USESTDHANDLES/gu)?.length, 2)
  assert.doesNotMatch(windows, /wShowWindow/u)
  assert.equal(windowsPatch.match(/^\+\s*wShowWindow: 0,/gmu)?.length, 2)

  const source = readFileSync(join(harnessRoot, 'packages/fs/tool-fs/src/sandbox.ts'), 'utf8')
  assertExactOccurrence(
    source,
    'validateEscalationArgs(args.sandbox_permissions, args.justification)',
    'native filesystem escalation validation',
  )
  assert.doesNotMatch(source, /redundantEscalation/u)

  for (const path of [
    'packages/shell/tool-bash/src/index.ts',
    'packages/shell/tool-pwsh/src/index.ts',
  ]) {
    const native = readFileSync(join(harnessRoot, path), 'utf8')
    assert.match(native, /const redundantEscalation =/u)
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
    writeFileSync(join(path, 'package.json'), `${JSON.stringify({ name, version: '0.1.0-rc.7' })}\n`)
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
