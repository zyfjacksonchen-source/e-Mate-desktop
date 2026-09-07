import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const upstream = resolve(root, '../../upstream/plugins/dsh-find-skill')
const harness = resolve(root, '../../upstream/deepseek-harness')
const productSkills = resolve(root, '../../skills')
const bundledConnectorSkills = [
  'connect-feishu-cli',
  'connect-tencent-docs',
  'connect-dingtalk',
  'connect-wechat-bot',
  'xin-assistant',
  'enterprise-knowledge',
]
const runNode = (cwd, entry, ...args) => {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' })
  if (result.status !== 0) throw new Error(`${entry} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`)
}
const bundleRuntime = () => {
  const result = spawnSync(process.execPath, [
    resolve(harness, 'node_modules/tsdown/dist/run.mjs'),
    '--config', join(root, 'tsdown.runtime.config.ts'),
  ], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
  if (result.status !== 0) throw new Error(`runtime bundle failed:\n${result.stdout}${result.stderr}`)
}

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`generated find-skill ${label} is not uniquely patchable`)
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`
}

function replaceSection(source, start, end, replacement, label) {
  const from = source.indexOf(start)
  const to = from < 0 ? -1 : source.indexOf(end, from + start.length)
  if (from < 0 || to < 0 || source.indexOf(start, from + start.length) >= 0) {
    throw new Error(`generated find-skill ${label} is not uniquely patchable`)
  }
  return `${source.slice(0, from)}${replacement}${source.slice(to)}`
}

if (!existsSync(join(upstream, 'node_modules')) || !existsSync(join(upstream, 'client/node_modules'))) {
  throw new Error('pinned dsh-find-skill dependencies are missing; prepare the workspace once before component builds')
}
runNode(upstream, resolve(upstream, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json')
runNode(join(upstream, 'client'), resolve(upstream, 'client/node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json')
runNode(join(upstream, 'client'), resolve(upstream, 'client/node_modules/tsdown/dist/run.mjs'), '--env.DSH_BUILD_FACE', 'client')
await rm(join(root, 'lib'), { recursive: true, force: true })
await cp(join(upstream, 'lib'), join(root, 'lib'), { recursive: true })
await cp(join(root, 'overrides/emate-safety.mjs'), join(root, 'lib/emate-safety.js'))
for (const name of bundledConnectorSkills) {
  const target = join(root, 'lib/skills', name)
  await mkdir(join(target, 'agents'), { recursive: true })
  await cp(join(productSkills, name, 'SKILL.md'), join(target, 'SKILL.md'))
  await cp(join(productSkills, name, 'agents/openai.yaml'), join(target, 'agents/openai.yaml'))
}
await mkdir(join(root, 'lib/types/client'), { recursive: true })
await cp(join(upstream, 'client/lib/client.js'), join(root, 'lib/client.js'))
await cp(join(upstream, 'client/lib/types/index.d.ts'), join(root, 'lib/types/client/index.d.ts'))
let client = await readFile(join(root, 'lib/client.js'), 'utf8')
client = client.replaceAll('dsh-find-skill-client', '@e-mate/dsh-plugin-find-skill')
await writeFile(join(root, 'lib/client.js'), client)
const cliPath = join(root, 'lib/cli.js')
let cli = await readFile(cliPath, 'utf8')
const imports = `import { join } from 'node:path';`
const command = `    const [command, ...fixed] = tokens;\n    const handle = subprocess.spawn({\n        argv: [command, ...fixed, ...args],`
cli = replaceExactlyOnce(cli, imports, `import { isAbsolute, join } from 'node:path';\nimport { pathToFileURL } from 'node:url';\nimport { throwawayEnvironment } from "./emate-safety.js";`, 'CLI imports')
cli = replaceExactlyOnce(cli, command, `    const [command, ...fixed] = tokens;\n    const managedPnpm = command === 'pnpm' ? {\n        executable: process.env.EMATE_DESKTOP_RUN_AS_NODE,\n        entry: process.env.EMATE_DESKTOP_PNPM_ENTRY,\n        clearEnvironment: process.env.EMATE_DESKTOP_CLEAR_ENV,\n    } : undefined;\n    if (managedPnpm !== undefined && Object.values(managedPnpm).some(value => typeof value !== 'string' || !isAbsolute(value)))\n        throw new Error('packaged pnpm direct launch inputs must be absolute paths');\n    const argv = managedPnpm === undefined\n        ? [command, ...fixed, ...args]\n        : [managedPnpm.executable, '--import', pathToFileURL(managedPnpm.clearEnvironment).href, managedPnpm.entry, ...fixed, ...args];\n    const handle = subprocess.spawn({\n        argv,`, 'CLI command')
cli = replaceExactlyOnce(
  cli,
  `        env: options.env,`,
  `        env: managedPnpm === undefined ? options.env : { ...options.env, ELECTRON_RUN_AS_NODE: '1' },`,
  'CLI managed environment',
)
cli = replaceSection(
  cli,
  'function throwawayEnv(home) {',
  '/**\n * Fetch one skill',
  'function throwawayEnv(home) {\n    return throwawayEnvironment(home, process.env);\n}\n',
  'CLI environment',
)
await writeFile(cliPath, cli)

const configPath = join(root, 'lib/config.js')
let configSource = await readFile(configPath, 'utf8')
configSource = replaceExactlyOnce(
  configSource,
  `    catalogSkills: Schema.array(Schema.object({`,
  `    persistentSkillCandidates: Schema.array(Schema.object({\n        source: Schema.string().required(),\n        legacySources: Schema.array(Schema.string()).default([]),\n        skill: Schema.string().required(),\n        version: Schema.string().required(),\n        contentDigest: Schema.string().required(),\n    })).default([]),\n    catalogSkills: Schema.array(Schema.object({`,
  'persistent candidate schema',
)
await writeFile(configPath, configSource)

const configTypesPath = join(root, 'lib/config.d.ts')
let configTypes = await readFile(configTypesPath, 'utf8')
configTypes = replaceExactlyOnce(
  configTypes,
  `    /** Trusted install-only recommendations merged ahead of remote search results. */`,
  `    /** One immutable connector Skill candidate accepted for device-global installation. */\n    readonly persistentSkillCandidates?: ReadonlyArray<{\n        readonly source: string;\n        readonly legacySources?: string[];\n        readonly skill: string;\n        readonly version: string;\n        readonly contentDigest: string;\n    }>;\n    /** Trusted install-only recommendations merged ahead of remote search results. */`,
  'persistent candidate types',
)
await writeFile(configTypesPath, configTypes)

const installPath = join(root, 'lib/install.js')
let install = await readFile(installPath, 'utf8')
install = replaceExactlyOnce(
  install,
  `import { join } from 'node:path';`,
  `import { join } from 'node:path';\nimport { managedSkillDigest, removeManagedSkill, replaceManagedSkillAtomically, resolvePersistentSkillCandidate, resolvePersistentSkillScope } from "./emate-safety.js";`,
  'remove imports',
)
install = replaceExactlyOnce(
  install,
  `    const targetScope = scope ?? config.installDefaultScope ?? 'temp';`,
  `    const pinned = resolvePersistentSkillCandidate(config, source, skillName);\n    const targetScope = resolvePersistentSkillScope(config, source, skillName, scope);`,
  'persistent install scope',
)
install = replaceExactlyOnce(
  install,
  `        const targetRoot = targetScope === 'temp'`,
  `        const fetchedDigest = await managedSkillDigest(fetched.skillDir);\n        if (fetchedDigest !== pinned.contentDigest || parsed.name !== pinned.skill)\n            throw new Error('Downloaded Skill content does not match the approved version and SHA-256');\n        const targetRoot = targetScope === 'temp'`,
  'pre-install content verification',
)
install = replaceExactlyOnce(
  install,
  `            source,\n            ...skillName !== undefined && skillName.length > 0 ? { skill: skillName } : {},\n            installedAt: Date.now(),\n            scope: targetScope,`,
  `            source: pinned.source,\n            skill: pinned.skill,\n            installedAt: Date.now(),\n            sourceVersion: pinned.version,\n            receiptVersion: 1,\n            contentDigest: fetchedDigest,\n            scope: targetScope,`,
  'install content receipt',
)
install = replaceSection(
  install,
  `        await mkdir(targetRoot, { recursive: true });`,
  `        if (targetScope === 'temp') {`,
  `        await replaceManagedSkillAtomically(fetched.skillDir, targetDir, {\n            source: pinned.source,\n            skill: pinned.skill,\n            installedAt: Date.now(),\n            sourceVersion: pinned.version,\n            receiptVersion: 1,\n            contentDigest: fetchedDigest,\n            scope: targetScope,\n        });\n`,
  'atomic install activation',
)
install = replaceExactlyOnce(
  install,
  `        const fetched = await fetchSkillViaCli(subprocess, config.cliCommand ?? 'npx -y skills@1.5.22', meta.source, meta.skill, roots.tempSkillDir, signal);`,
  `        const pinned = resolvePersistentSkillCandidate(config, meta.source, meta.skill);\n        const fetched = await fetchSkillViaCli(subprocess, config.cliCommand ?? 'npx -y skills@1.5.22', pinned.source, pinned.skill, roots.tempSkillDir, signal);`,
  'update candidate',
)
install = replaceExactlyOnce(
  install,
  `    const { readMetadata, writeMetadata: persistMetadata } = await import("./metadata.js");`,
  `    const { readMetadata } = await import("./metadata.js");`,
  'update metadata import',
)
install = replaceExactlyOnce(
  install,
  `            await rm(dir, { recursive: true, force: true });`,
  `            const fetchedDigest = await managedSkillDigest(fetched.skillDir);\n            if (fetchedDigest !== pinned.contentDigest || parsed.name !== pinned.skill)\n                throw new Error('Downloaded Skill content does not match the approved version and SHA-256');\n            await rm(dir, { recursive: true, force: true });`,
  'pre-update content verification',
)
install = replaceSection(
  install,
  `            await rm(dir, { recursive: true, force: true });`,
  `            if (candidate === 'temp') {`,
  `            await replaceManagedSkillAtomically(fetched.skillDir, dir, { ...meta, source: pinned.source, skill: pinned.skill, installedAt: Date.now(), sourceVersion: pinned.version, receiptVersion: 1, contentDigest: fetchedDigest });\n`,
  'atomic update activation',
)
install = replaceSection(
  install,
  'export async function removeSkill(',
  '/**\n * Update a managed skill',
  `export async function removeSkill(provider, tempManager, scope, name, cwd, confirm) {
    return removeManagedSkill(resolveRoots(providerConfigOf(provider), cwd), tempManager, scope, name, confirm, () => provider.notifyChanged());
}
`,
  'remove implementation',
)
await writeFile(installPath, install)

const installTypesPath = join(root, 'lib/install.d.ts')
let installTypes = await readFile(installTypesPath, 'utf8')
installTypes = replaceExactlyOnce(
  installTypes,
  `export declare function removeSkill(provider: ManagedSkillProvider, tempManager: TempSkillManager, scope: InstallScope | undefined, name: string, cwd?: string): Promise<RemoveResult>;`,
  `export interface RemoveTarget {\n    readonly name: string;\n    readonly scope: InstallScope;\n    readonly path: string;\n}\nexport type ConfirmSkillRemoval = (target: RemoveTarget) => Promise<boolean>;\nexport declare function removeSkill(provider: ManagedSkillProvider, tempManager: TempSkillManager, scope: InstallScope | undefined, name: string, cwd: string | undefined, confirm: ConfirmSkillRemoval): Promise<RemoveResult>;`,
  'remove types',
)
await writeFile(installTypesPath, installTypes)

const commandPath = join(root, 'lib/command.js')
let commandSource = await readFile(commandPath, 'utf8')
commandSource = replaceExactlyOnce(
  commandSource,
  `const result = await removeSkill(provider, tempManager, parsed.scope, parsed.arg, cwd);`,
  `const result = await removeSkill(provider, tempManager, parsed.scope, parsed.arg, cwd, async () => true);`,
  'slash-command removal',
)
await writeFile(commandPath, commandSource)

const toolsPath = join(root, 'lib/tools.js')
let toolsSource = await readFile(toolsPath, 'utf8')
toolsSource = replaceExactlyOnce(
  toolsSource,
  `import { defineTool } from '@deepseek-ai/dsh-tools';`,
  `import { defineTool } from '@deepseek-ai/dsh-tools';\nimport { findInstalledPersistentSkill, resolvePersistentSkillCandidate, resolvePersistentSkillScope } from "./emate-safety.js";\nimport { resolveRoots } from "./roots.js";`,
  'persistent tool imports',
)
toolsSource = replaceExactlyOnce(
  toolsSource,
  `const INSTALL_DESCRIPTION = 'Install a skill discovered by skill_find into a managed scope: '\n    + 'temp (default; current session only), project (shared with the workspace), or global (all sessions). '\n    + 'The installed skill immediately appears in the skill catalog and loads via the skill tool. '\n    + 'If the user has not indicated a scope, ask them first via ask_user_question.';`,
  `const INSTALL_DESCRIPTION = 'Install an approved external-connection Skill as a device-global capability. '\n    + 'Only exact deployment-configured connector sources are accepted; community Skill lifecycle remains owned by Skill Hub.';`,
  'connector install description',
)
toolsSource = replaceExactlyOnce(
  toolsSource,
  `                const scope = parseScope(args.scope);`,
  `                const pinned = resolvePersistentSkillCandidate(config, args.source, args.skill);\n                const scope = resolvePersistentSkillScope(config, pinned.source, pinned.skill, parseScope(args.scope));`,
  'connector tool candidate',
)
toolsSource = replaceExactlyOnce(
  toolsSource,
  `                const userQuestions = ctx.get('userQuestions');`,
  `                const cwd = exec.agent?.session.header.cwd;\n                const installed = await findInstalledPersistentSkill(resolveRoots(config, cwd).globalSkillDir, pinned);\n                if (installed !== undefined) {\n                    const installedCandidate = (await provider.list({ cwd, signal: exec.signal })).find(item => item.name === installed.name && item.locator.path === installed.path);\n                    if (installedCandidate === undefined)\n                        throw new Error('Installed Skill receipt is not visible through the DSH provider');\n                    return { installed: true, name: installed.name, scope: 'global', path: installed.path, description: installedCandidate.description };\n                }\n                const userQuestions = ctx.get('userQuestions');`,
  'installed connector reuse',
)
toolsSource = replaceExactlyOnce(
  toolsSource,
  `                            question: \`是否安装 \${args.skill ?? '所选技能'} 到 \${scope ?? config.installDefaultScope ?? 'temp'} 范围？\`,`,
  `                            question: \`是否将 \${pinned.skill} 作为设备级全局能力安装？\\n来源：\${pinned.source}\\n版本：\${pinned.version}\\nSHA-256：\${pinned.contentDigest}\`,`,
  'exact connector confirmation',
)
toolsSource = replaceExactlyOnce(
  toolsSource,
  `                return installSkill(ctx.subprocess, agentRegister(agent, ctx), config, provider, tempManager, scope, args.source, args.skill, agent?.session.header.cwd, exec.signal, agent?.session.header.id);`,
  `                return installSkill(ctx.subprocess, agentRegister(agent, ctx), config, provider, tempManager, scope, pinned.source, pinned.skill, agent?.session.header.cwd, exec.signal, agent?.session.header.id);`,
  'exact connector installation',
)
toolsSource = replaceExactlyOnce(
  toolsSource,
  `            async execute(args, exec) {\n                return removeSkill(provider, tempManager, parseScope(args.scope), args.name, exec.agent?.session.header.cwd);\n            },`,
  `            async execute(args, exec) {\n                return removeSkill(provider, tempManager, parseScope(args.scope), args.name, exec.agent?.session.header.cwd, async (target) => {\n                    const userQuestions = ctx.get('userQuestions');\n                    const answer = await userQuestions.ask({\n                        agent: exec.agent,\n                        questions: [{\n                                id: 'dsh-find-skill-remove',\n                                question: '是否删除 ' + target.name + '（' + target.scope + '）？\\n' + target.path,\n                                header: '删除技能',\n                                options: [\n                                    { label: '删除', description: '删除这个插件管理的技能目录。' },\n                                    { label: '取消', description: '保留当前技能。' },\n                                ],\n                            }],\n                    });\n                    return answer.answers[0]?.selected.includes('删除') === true;\n                });\n            },`,
  'tool removal',
)
await writeFile(toolsPath, toolsSource)

const indexPath = join(root, 'lib/index.js')
let indexSource = await readFile(indexPath, 'utf8')
indexSource = replaceExactlyOnce(
  indexSource,
  `import { Config } from "./config.js";`,
  `import { Config } from "./config.js";\nimport { promotePersistentSkills, reconcileBundledConnectorSkills } from "./emate-safety.js";`,
  'startup promotion import',
)
indexSource = replaceExactlyOnce(
  indexSource,
  `    // Managed provider over self-owned project/global roots.\n    const { provider } = registerManagedProvider((create) => ctx.skills.registerProvider(create), validated);\n    // Temporary skill manager; temp roots resolve per call site.\n    const roots = resolveRoots(validated);`,
  `    const roots = resolveRoots(validated);\n    reconcileBundledConnectorSkills(validated, roots);\n    promotePersistentSkills(validated, roots);\n    // Managed provider over self-owned project/global roots.\n    const { provider } = registerManagedProvider((create) => ctx.skills.registerProvider(create), validated);\n    // Temporary skill manager; temp roots resolve per call site.`,
  'startup promotion',
)
indexSource = replaceExactlyOnce(
  indexSource,
  `    registerCommand(ctx, validated, provider, tempManager);`,
  `    if (validated.registerCommand !== false)\n        registerCommand(ctx, validated, provider, tempManager);`,
  'command registration guard',
)
await writeFile(indexPath, indexSource)
bundleRuntime()
await writeFile(join(root, 'lib/index.js'), await readFile(join(root, '.runtime-bundle/index.js')))
await rm(join(root, '.runtime-bundle'), { recursive: true, force: true })
await cp(join(upstream, 'LICENSE'), join(root, 'LICENSE'))
