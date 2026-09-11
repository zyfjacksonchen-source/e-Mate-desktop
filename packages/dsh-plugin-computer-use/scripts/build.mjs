import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const upstream = resolve(root, '../../upstream/plugins/dsh-computer-use')
const harness = resolve(root, '../../upstream/deepseek-harness')
const readText = async path => (await readFile(path, 'utf8')).replaceAll('\r\n', '\n')
const bundleRuntime = () => {
  const result = spawnSync(process.execPath, [
    resolve(harness, 'node_modules/tsdown/dist/run.mjs'),
    '--config', join(root, 'tsdown.runtime.config.ts'),
  ], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
  if (result.status !== 0) throw new Error(`runtime bundle failed:\n${result.stdout}${result.stderr}`)
}

// Keep the e-Mate policy docs and their checked bilingual hashes intact.
for (const name of ['lib', 'assets']) {
  await rm(join(root, name), { recursive: true, force: true })
  await cp(join(upstream, name), join(root, name), { recursive: true })
}
await mkdir(join(root, 'scripts'), { recursive: true })
await cp(join(upstream, 'scripts/build-native.mjs'), join(root, 'scripts/build-native.mjs'))
const windowsManifest = JSON.parse(await readFile(join(root, 'native/windows/manifest.json'), 'utf8'))
const windowsHelper = await readFile(join(root, 'native/windows/dsh-computer-use-helper.ps1'))
if (windowsManifest.schemaVersion !== 1 || windowsManifest.source?.path !== 'dsh-computer-use-helper.ps1'
  || windowsManifest.source.sha256 !== createHash('sha256').update(windowsHelper).digest('hex')) {
  throw new Error('Windows helper integrity manifest mismatch')
}
if (process.platform === 'darwin') {
  // Native source remains owned here; do not overwrite exact-window fixes with
  // the reference copy. Reuse the existing native builder when source changed.
  const sourceDirectory = join(root, 'native/macos/Sources/Helper')
  const sourceHash = createHash('sha256')
  for (const name of (await readdir(sourceDirectory)).filter(name => name.endsWith('.swift')).sort()) {
    sourceHash.update(name).update('\0').update(await readFile(join(sourceDirectory, name))).update('\0')
  }
  const sourceDigest = sourceHash.digest('hex')
  let before
  try { before = JSON.parse(await readFile(join(root, 'native/macos/manifest.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (before?.sourceSha256 !== sourceDigest) {
    const built = spawnSync(process.execPath, [join(root, 'scripts/build-native.mjs'), '--helper-only'], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
    if (built.status !== 0) throw new Error(`native helper build failed:\n${built.stdout}${built.stderr}`)
  }
  const helper = join(root, 'native/macos/bin/dsh-computer-use-helper')
  const nativeManifestPath = join(root, 'native/macos/manifest.json')
  const nativeManifest = JSON.parse(await readFile(nativeManifestPath, 'utf8'))
  if (nativeManifest.schemaVersion !== 1 || nativeManifest.sourceSha256 !== sourceDigest
    || nativeManifest.binary?.path !== 'bin/dsh-computer-use-helper'
    || nativeManifest.binary.sha256 !== createHash('sha256').update(await readFile(helper)).digest('hex')) {
    throw new Error('macOS helper source/binary integrity manifest mismatch')
  }
}
let client = await readText(join(root, 'lib/client.js'))
client = client.replaceAll('@anionex/dsh-computer-use', '@e-mate/dsh-plugin-computer-use')
await writeFile(join(root, 'lib/client.js'), client)

function replaceExactlyOnce(source, before, after, label) {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(`computer-use adapter expected one ${label} seam, found ${count}`)
  return source.replace(before, after)
}
const exposurePath = join(root, 'lib/exposure.js')
let exposure = await readText(exposurePath)
exposure = replaceExactlyOnce(
  exposure,
  `import { defineTool } from '@deepseek-ai/dsh-tools';`,
  `import { defineTool } from '@deepseek-ai/dsh-tools';
import { desktopAutomationBypass, hasExplicitComputerUseRequest } from './emate-explicit.js';`,
  'explicit Computer Use request import',
)
exposure = replaceExactlyOnce(
  exposure,
  `                if (!hasLoadedComputerUseSkill(exec.agent.session)) {
                    throw new Error(\`${'${COMPUTER_USE_ACTIVATE}'}: load the ${'${COMPUTER_USE_SKILL_NAME}'} Skill first\`);
                }
                return Promise.resolve(this.activate(exec.agent));`,
  `                if (!hasExplicitComputerUseRequest(exec.agent.session)) {
                    throw new Error(\`${'${COMPUTER_USE_ACTIVATE}'}: the current user request must explicitly select @电脑操控\`);
                }
                if (!hasLoadedComputerUseSkill(exec.agent.session)) {
                    throw new Error(\`${'${COMPUTER_USE_ACTIVATE}'}: load the ${'${COMPUTER_USE_SKILL_NAME}'} Skill first\`);
                }
                return Promise.resolve(this.activate(exec.agent));`,
  'activation Tool request guard',
)
exposure = replaceExactlyOnce(
  exposure,
  `            this.ctx.on('agent/disposed', ({ agent }) => { this.detach(agent); }),
            this.ctx.tools.guard((exec) => {
                if (exec.name !== 'bash'`,
  `            this.ctx.on('agent/disposed', ({ agent }) => { this.detach(agent); }),
            this.ctx.tools.guard((exec) => {
                if (exec.agent === undefined || hasExplicitComputerUseRequest(exec.agent.session))
                    return undefined;
                const state = this.states.get(exec.agent);
                const blockedTool = state !== undefined && state.toolNames.includes(exec.name);
                const blockedShell = exec.name === 'bash' && desktopAutomationBypass(exec.arguments);
                if (!blockedTool && !blockedShell)
                    return undefined;
                return 'Computer Use is available only when the current user request explicitly inserts @电脑操控. Use CDP browser tools first for webpage tasks.';
            }),
            this.ctx.tools.guard((exec) => {
                if (exec.name !== 'bash'`,
  'execution Tool request guard',
)
exposure = replaceExactlyOnce(
  exposure,
  `                    && exec.agent !== undefined
                    && isSkillArguments(exec.arguments)`,
  `                    && exec.agent !== undefined
                    && hasExplicitComputerUseRequest(exec.agent.session)
                    && isSkillArguments(exec.arguments)`,
  'Skill-result activation guard',
)
exposure = replaceExactlyOnce(
  exposure,
  `        if (hasLoadedComputerUseSkill(agent.session))
            this.activate(agent);`,
  `        if (hasExplicitComputerUseRequest(agent.session) && hasLoadedComputerUseSkill(agent.session))
            this.activate(agent);`,
  'existing Agent adoption guard',
)
// 0.1.5 replaced the Session event list with the snapshot accessor; the pinned
// bundle still iterates the removed property and throws when an Agent activates.
exposure = replaceExactlyOnce(exposure,
  "for (const event of session.events) {",
  "for (const event of session.snapshotEvents()) {",
  'native session snapshot accessor')
await writeFile(exposurePath, exposure)

// The scheduled-lease scan needs the same 0.1.5 accessor, but its copy of the
// seam lives in the vendored tree instead of here: contract.test.mjs asserts the
// shipped lib/leases.js is byte-identical to upstream/plugins/dsh-computer-use/
// lib/leases.js, so a build-time rewrite of this file would fail that guard.
// The vendored tree is already an e-Mate 0.1.5-compat branch; SOURCE.md logs the
// divergence and the shipped bytes are the ones the guard compares.

await writeFile(join(root, 'lib/emate-explicit.js'), `const COMPUTER_USE_MENTION = '@[电脑操控](computer-use)'
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
/**
 * Whether the latest direct user request explicitly selected Computer Use.
 * rc.1 retires source.mentions: a reference reaches the Host as its owning
 * source's serialized model form spliced into the prompt text, so the exact
 * canonical token is the durable evidence of an explicit selection. A bare
 * typed @电脑操控 stays a plain sentence and never authorizes the tools.
 */
export function hasExplicitComputerUseRequest(session) {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const content = event.data.content
    return Array.isArray(content) && content.some(block => isRecord(block)
      && block.type === 'text' && typeof block.text === 'string'
      && block.text.includes(COMPUTER_USE_MENTION))
  }
  return false
}

const DIRECT_AUTOMATION = /(?:^|[;&|]\\s*)(?:(?:command|nohup|sudo|(?:\\/usr\\/bin\\/)?env)\\s+)*(?:\\/usr\\/bin\\/)?(?:open|osascript)(?:\\s|$)/u
const SHELL_AUTOMATION = /(?:^|[;&|]\\s*)(?:(?:command|nohup|sudo|(?:\\/usr\\/bin\\/)?env)\\s+)*(?:\\/bin\\/)?(?:ba|z)?sh\\s+-c\\s+(["'])(.*?)\\1/u

/** Known macOS desktop-control executables, including ordinary wrapper forms. */
export function desktopAutomationBypass(args) {
  if (!isRecord(args) || typeof args.command !== 'string') return false
  if (DIRECT_AUTOMATION.test(args.command)) return true
  const nested = SHELL_AUTOMATION.exec(args.command)
  return nested !== null && DIRECT_AUTOMATION.test(nested[2])
}
`)

const skillPath = join(root, 'lib/skill.js')
let skill = await readText(skillPath)
skill = replaceExactlyOnce(
  skill,
  `export const COMPUTER_USE_SKILL_CONTENT = \`# DSH Computer Use

Use this capability only for a local macOS application UI that has no narrower,`,
  `export const COMPUTER_USE_SKILL_CONTENT = \`# DSH Computer Use

This capability is enabled only when the current direct user request contains the
e-Mate @电脑操控 trigger. Never enable or invoke it on the model's own initiative.
For every webpage read or operation, use the CDP browser tools first.
If a Computer Use Tool fails or its post-action state is not verified, report
that failure or uncertainty; never claim the requested UI action succeeded.

Windows input scope (takes precedence over the generic platform guidance below):
Prefer advertised UIA Invoke, Value, Toggle, SelectionItem, ExpandCollapse and
Scroll actions. Targeted type-text and navigation keys require a checked native
Edit/RichEdit control. press-key supports Enter, Backspace, Delete, Home, End,
PageUp/PageDown, ArrowUp/Down/Left/Right and Ctrl+A only. Tab, Escape, Space,
letter/digit press-key and other modifier chords are unavailable; for printable
text use type-text, not simulated shortcut keys. Clipboard/global shortcuts and
custom/WebView keyboard input are unavailable. Raw pointer/drag fallback needs
an explicitly selected route, a checked native control and an already-foreground
target; background pointer/drag must use an advertised semantic action or fail.
A visible Save/Cancel button may offer an equivalent UIA action, but there is no
generic replacement for every unsupported shortcut. Report the specific blocked
reason; do not infer permission denial from an unsupported input route, repeat
unsupported input, activate the target, or bypass this provider via global input.

Use this capability only for a local application UI that has no narrower,`,
  'Computer Use Skill selection rule',
)
await writeFile(skillPath, skill)

const runtimeSource = join(root, '.runtime-source')
const runtimeBundle = join(root, '.runtime-bundle')
try {
await mkdir(runtimeSource, { recursive: true })
await writeFile(join(runtimeSource, 'windows.ts'), (await readText(join(root, 'src/windows.ts')))
  .replace('../../../upstream/plugins/dsh-computer-use/src/errors.ts', '../lib/errors.js'))
const providerPath = join(root, 'lib/providers/macos.js')
let provider = await readText(providerPath)
provider = replaceExactlyOnce(provider, `import { NativeHelperClient } from "./native-helper.js";`, `import { NativeHelperClient } from "./native-helper.js";
import { WindowsBackend } from "../../.runtime-source/windows.ts";`, 'Windows backend import')
provider = replaceExactlyOnce(provider, `        if (process.platform !== 'darwin') {
            throw new ComputerUseError('COMPUTER_UNSUPPORTED_PLATFORM', \`dsh-computer-use 0.1.0 supports macOS only; current platform is ${'${process.platform}'}\`);
        }`, `        if (process.platform !== 'darwin' && process.platform !== 'win32') {
            throw new ComputerUseError('COMPUTER_UNSUPPORTED_PLATFORM', \`Computer Use supports darwin and win32; current platform is ${'${process.platform}'}\`);
        }`, 'provider platform gate')
provider = replaceExactlyOnce(provider, `        super(ctx, new MacOSBackend(ctx, resolved), resolved);`, `        super(ctx, process.platform === 'darwin' ? new MacOSBackend(ctx, resolved) : new WindowsBackend(ctx, resolved), resolved);`, 'provider platform selection')
provider = replaceExactlyOnce(provider, `            const backend = new MacOSBackend(ctx, candidate);`, `            const backend = process.platform === 'darwin' ? new MacOSBackend(ctx, candidate) : new WindowsBackend(ctx, candidate);`, 'provider reconfiguration selection')
await writeFile(providerPath, provider)

const servicePath = join(root, 'lib/service.js')
let service = await readText(servicePath)
service = replaceExactlyOnce(service, `            provider: 'macos-ax',`, `            provider: this.backend.name,`, 'platform status provider')
service = replaceExactlyOnce(
  service,
  `            ...this.healthState,
        };`,
  `            ...this.healthState,
            applicationAccess: {
                allowAllApps: this.config.allowAllApps,
                readGrants: this.config.grants.filter(grant => grant.read).length,
                controlGrants: this.config.grants.filter(grant => grant.control).length,
            },
        };`,
  'application access status',
)
await writeFile(servicePath, service)

const backendTypesPath = join(root, 'lib/types/backend.d.ts')
let backendTypes = await readText(backendTypesPath)
backendTypes = replaceExactlyOnce(backendTypes, `readonly name: 'macos-ax';`, `readonly name: 'macos-ax' | 'windows-uia';`, 'backend provider type')
await writeFile(backendTypesPath, backendTypes)
const publicTypesPath = join(root, 'lib/types/types.d.ts')
let publicTypes = await readText(publicTypesPath)
publicTypes = replaceExactlyOnce(publicTypes, `provider: 'macos-ax';`, `provider: 'macos-ax' | 'windows-uia';`, 'public provider type')
await writeFile(publicTypesPath, publicTypes)

const indexPath = join(root, 'lib/index.js')
await cp(join(root, 'src/emate-capability.ts'), join(root, 'lib/emate-capability.js'))
let index = await readText(indexPath)
index = replaceExactlyOnce(
  index,
  `import { ComputerUseExposure } from "./exposure.js";`,
  `import { ComputerUseExposure } from "./exposure.js";
import { installComputerUseCapability } from "./emate-capability.js";`,
  'e-Mate capability adapter import',
)
index = replaceExactlyOnce(
  index,
  `    static inject = ['subprocess', 'approval', 'settings', 'sessions', 'agents', 'tools', 'skills'];`,
  `    static inject = ['subprocess', 'approval', 'settings', 'sessions', 'agents', 'tools', 'skills', 'emateCapabilities'];`,
  'e-Mate capability injection',
)
index = replaceExactlyOnce(
  index,
  `        ctx.effect(() => () => {
            this.consumerDispose?.();
            this.consumerDispose = undefined;
        }, 'dsh-computer-use: consumer lifecycle');`,
  `        ctx.effect(() => () => {
            this.consumerDispose?.();
            this.consumerDispose = undefined;
        }, 'dsh-computer-use: consumer lifecycle');
        installComputerUseCapability(ctx, this);`,
  'e-Mate capability lifecycle',
)
await writeFile(indexPath, index)
bundleRuntime()
let runtime = await readText(join(root, '.runtime-bundle/index.js'))
runtime = replaceExactlyOnce(runtime, 'new URL("../../native/macos/", import.meta.url)', 'new URL("../native/macos/", import.meta.url)', 'bundled native path')
runtime = replaceExactlyOnce(runtime, 'new URL("../../scripts/build-native.mjs", import.meta.url)', 'new URL("../scripts/build-native.mjs", import.meta.url)', 'bundled native builder path')
await writeFile(indexPath, runtime)
} finally {
  await rm(runtimeBundle, { recursive: true, force: true })
  await rm(runtimeSource, { recursive: true, force: true })
}
