import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { apply } from '../lib/index.js'
import { runCli } from '../lib/cli.js'
import { installSkill, updateSkill } from '../lib/install.js'
import { registerTools } from '../lib/tools.js'

import {
  BUNDLED_CONNECTOR_SKILLS,
  findInstalledPersistentSkill,
  managedSkillDigest,
  promotePersistentSkills,
  recoverManagedSkillSwap,
  reconcileBundledConnectorSkills,
  removeManagedSkill,
  resolvePersistentSkillCandidate,
  resolvePersistentSkillScope,
  throwawayEnvironment,
} from '../lib/emate-safety.js'

const root = new URL('../', import.meta.url)
const PERSISTENT_SOURCE = 'https://github.com/larksuite/cli/tree/v1.0.88/skills'
const PERSISTENT_VERSION = 'v1.0.88@2829ecd18846d8390dfac558125f602b07232206'

test('find-skill is pinned and limits persistent installation to connector sources', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')
  const cli = await readFile(new URL('../lib/cli.js', import.meta.url), 'utf8')
  const tools = await readFile(new URL('../lib/tools.js', import.meta.url), 'utf8')
  const installer = await readFile(new URL('../lib/install.js', import.meta.url), 'utf8')
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const runtime = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.equal(pkg.version, '2.0.18')
  assert.equal(pkg.dsh.upstream.commit, '5a7f18b4535835a81de47c0cc2ca8ceb6e97a4e6')
  assert.match(patch, /cliCommand: 'pnpm dlx skills@1\.5\.22'/u)
  assert.match(patch, /registerFindTool: true/u)
  assert.match(patch, /registerInstallTool: true/u)
  assert.match(patch, /registerRemoveTool: false/u)
  assert.match(patch, /registerCommand: false/u)
  assert.match(tools, /agent: exec\.agent/u)
  assert.doesNotMatch(patch, /\bnpx\b/u)
  assert.match(patch, /tree\/skills-v2\.0\.12-r1\/skills\/connect-feishu-cli/u)
  assert.match(patch, /id: connect-tencent-docs/u)
  assert.match(cli, /subprocess\.spawn/u)
  assert.doesNotMatch(cli, /node:child_process/u)
  assert.doesNotMatch(cli, /\.\.\.process\.env/u)
  assert.match(tools, /Skill installation was cancelled by the user/u)
  assert.match(tools, /id: 'dsh-find-skill-remove'/u)
  assert.match(tools, /resolvePersistentSkillCandidate\(config, args\.source, args\.skill\)/u)
  assert.match(tools, /作为设备级全局能力安装/u)
  assert.match(tools, /来源：\$\{pinned\.source\}/u)
  assert.match(tools, /版本：\$\{pinned\.version\}/u)
  assert.match(tools, /SHA-256：\$\{pinned\.contentDigest\}/u)
  assert.match(tools, /title: args\.skill \?\? '安装技能'/u)
  assert.match(client, /String\(args\.skill \?\? ["']安装技能["']\)/u)
  assert.doesNotMatch(client, /String\(args\.source/u)
  assert.doesNotMatch(runtime, /^import .* from ['"]yaml['"];?$/mu)
  assert.match(runtime, /validated\.registerCommand !== false/u)
  const installDigest = installer.indexOf('managedSkillDigest(fetched.skillDir)')
  const installActivate = installer.indexOf('replaceManagedSkillAtomically(fetched.skillDir, targetDir')
  const updateStart = installer.indexOf('export async function updateSkill')
  const updateDigest = installer.indexOf('managedSkillDigest(fetched.skillDir)', updateStart)
  const updateActivate = installer.indexOf('replaceManagedSkillAtomically(fetched.skillDir, dir', updateStart)
  assert.ok(installDigest >= 0 && installDigest < installActivate)
  assert.ok(updateStart >= 0 && updateDigest >= 0 && updateDigest < updateActivate)
  assert.doesNotMatch(installer.slice(0, updateStart), /await rm\(targetDir/u)
  assert.doesNotMatch(installer.slice(updateStart), /await rm\(dir/u)
  assert.match(installer, /Downloaded Skill content does not match the approved version and SHA-256/u)

  const config = parse(patch)[0].insert[0].config
  const catalogSources = config.catalogSkills.map(skill => skill.source)
  assert.equal(config.persistentSkillCandidates.length, 9)
  assert.equal(config.persistentSkillCandidates.every(candidate =>
    candidate.source === PERSISTENT_SOURCE
      && candidate.version === PERSISTENT_VERSION
      && candidate.legacySources?.length === 1
      && candidate.legacySources[0] === 'larksuite/cli'
      && /^[a-f0-9]{64}$/u.test(candidate.contentDigest)), true)
  assert.deepEqual(config.persistentSkillCandidates.map(candidate => candidate.skill), [
    'lark-shared', 'lark-doc', 'lark-im', 'lark-drive', 'lark-sheets',
    'lark-base', 'lark-calendar', 'lark-task', 'lark-mail',
  ])
  assert.equal(catalogSources.filter(source => source === 'e-mate-bundled:xin-assistant').length, 1)
  assert.equal(catalogSources.filter(source => source === 'e-mate-bundled:enterprise-knowledge').length, 1)
  assert.equal(catalogSources.filter(source => !['e-mate-bundled:xin-assistant', 'e-mate-bundled:enterprise-knowledge'].includes(source)).every(source => source.includes(
    '/zyfjacksonchen-source/e-Mate-desktop/tree/skills-v2.0.12-r1/skills/connect-',
  )), true)
})

test('registerCommand false leaves the real DSH command registry untouched', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'emate-find-skill-no-command-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  let commandRegistrations = 0
  const ctx = {
    logger: () => ({ info: () => {} }),
    tools: { register: () => { throw new Error('model tools must stay disabled in this test') } },
    skills: {
      register: () => () => {},
      registerProvider: create => {
        create({ invalidate: () => {} })
        return () => {}
      },
    },
    subprocess: {},
    get: name => name === 'commands'
      ? { register: () => { commandRegistrations += 1 } }
      : undefined,
    on: () => {},
  }
  apply(ctx, {
    ...connectorConfig(),
    globalSkillRoot: join(scratch, 'global'),
    tempSkillRoot: join(scratch, 'temp'),
    persistentSkillCandidates: [],
    registerFindTool: false,
    registerInstallTool: false,
    registerRemoveTool: false,
    registerCommand: false,
  })
  assert.equal(commandRegistrations, 0)
})

test('external-connection Skills are global and legacy temporary installs are promoted', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'emate-find-skill-persistent-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const roots = {
    tempSkillDir: join(scratch, 'temp'),
    globalSkillDir: join(scratch, 'global'),
  }
  const legacy = await writeManagedSkill(roots.tempSkillDir, 'lark-doc', 'temp', 'larksuite/cli')
  await writeManagedSkill(roots.tempSkillDir, 'ordinary-skill', 'temp', 'someone/community')
  const candidate = await persistentCandidate(legacy, 'lark-doc')
  const config = { persistentSkillCandidates: [candidate], installDefaultScope: 'temp' }

  assert.deepEqual(resolvePersistentSkillCandidate(config, PERSISTENT_SOURCE, 'lark-doc'), candidate)
  assert.equal(resolvePersistentSkillScope(config, PERSISTENT_SOURCE, 'lark-doc', 'temp'), 'global')
  assert.throws(
    () => resolvePersistentSkillScope(config, 'someone/community', 'lark-doc', 'global'),
    /not an approved external-connection candidate/u,
  )
  assert.deepEqual(promotePersistentSkills(config, roots), ['lark-doc'])
  assert.equal((await stat(join(roots.globalSkillDir, 'lark-doc', 'SKILL.md'))).isFile(), true)
  const receipt = JSON.parse(await readFile(join(roots.globalSkillDir, 'lark-doc', '.dsh-find-skill.json'), 'utf8'))
  assert.equal(receipt.scope, 'global')
  assert.equal(receipt.source, PERSISTENT_SOURCE)
  assert.equal(receipt.sourceVersion, PERSISTENT_VERSION)
  assert.equal(receipt.contentDigest, candidate.contentDigest)
  await assert.rejects(stat(join(roots.tempSkillDir, 'lark-doc')), { code: 'ENOENT' })
  assert.equal((await stat(join(roots.tempSkillDir, 'ordinary-skill'))).isDirectory(), true)
})

test('device-global install receipt is reused across sessions only for the same source and Skill', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'emate-find-skill-global-reuse-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const globalRoot = join(scratch, 'global')

  const missingCandidate = persistentCandidateValue('lark-shared', '0'.repeat(64))
  assert.equal(await findInstalledPersistentSkill(globalRoot, missingCandidate), undefined)
  const target = await writeManagedSkill(globalRoot, 'lark-shared', 'global', 'larksuite/cli')
  const receipt = JSON.parse(await readFile(join(target, '.dsh-find-skill.json'), 'utf8'))
  delete receipt.receiptVersion
  delete receipt.contentDigest
  await writeFile(join(target, '.dsh-find-skill.json'), JSON.stringify(receipt), 'utf8')
  const candidate = await persistentCandidate(target, 'lark-shared')

  assert.deepEqual(
    await findInstalledPersistentSkill(globalRoot, candidate),
    { name: 'lark-shared', path: target },
  )
  const migrated = JSON.parse(await readFile(join(target, '.dsh-find-skill.json'), 'utf8'))
  assert.equal(migrated.source, PERSISTENT_SOURCE)
  assert.equal(migrated.sourceVersion, PERSISTENT_VERSION)
  assert.equal(migrated.receiptVersion, 1)
  assert.equal(migrated.contentDigest, candidate.contentDigest)
  assert.equal(await findInstalledPersistentSkill(globalRoot, { ...candidate, source: 'other/source', legacySources: [] }), undefined)
  assert.equal(await findInstalledPersistentSkill(globalRoot, { ...candidate, skill: 'lark-doc' }), undefined)
  await writeFile(join(target, 'SKILL.md'), 'tampered after consent', 'utf8')
  assert.equal(await findInstalledPersistentSkill(globalRoot, candidate), undefined)
})

test('an interrupted temp-to-global receipt migration self-heals without another question', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'emate-find-skill-receipt-recovery-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const globalRoot = join(scratch, 'global')
  const target = await writeManagedSkill(globalRoot, 'lark-shared', 'temp', PERSISTENT_SOURCE)
  const candidate = await persistentCandidate(target, 'lark-shared')
  const leftover = join(globalRoot, '.lark-shared.e-mate-receipt-staging')
  await writeFile(leftover, 'interrupted receipt bytes', 'utf8')

  assert.deepEqual(await findInstalledPersistentSkill(globalRoot, candidate), {
    name: 'lark-shared',
    path: target,
  })
  const receipt = JSON.parse(await readFile(join(target, '.dsh-find-skill.json'), 'utf8'))
  assert.equal(receipt.scope, 'global')
  assert.equal(receipt.sourceVersion, PERSISTENT_VERSION)
  assert.equal(receipt.contentDigest, candidate.contentDigest)
  await assert.rejects(stat(leftover), { code: 'ENOENT' })
})

test('a receipt migration staging symlink is rejected without touching its target', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'emate-find-skill-receipt-staging-symlink-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const globalRoot = join(scratch, 'global')
  const target = await writeManagedSkill(globalRoot, 'lark-shared', 'temp', PERSISTENT_SOURCE)
  const candidate = await persistentCandidate(target, 'lark-shared')
  const sentinel = join(scratch, 'outside-receipt-staging')
  await writeFile(sentinel, 'do not overwrite', 'utf8')
  await symlink(sentinel, join(globalRoot, '.lark-shared.e-mate-receipt-staging'))

  assert.equal(await findInstalledPersistentSkill(globalRoot, candidate), undefined)
  assert.equal(await readFile(sentinel, 'utf8'), 'do not overwrite')
})

test('skill_install skips the question in a new session only when the exact global receipt exists', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'emate-find-skill-tool-reuse-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const globalRoot = join(scratch, 'global')
  const target = await writeManagedSkill(globalRoot, 'lark-shared', 'global', 'larksuite/cli')
  const sharedCandidate = await persistentCandidate(target, 'lark-shared')
  const docCandidate = persistentCandidateValue('lark-doc', '1'.repeat(64))
  const registered = []
  let questions = 0
  let lastQuestion
  const ctx = {
    tools: { register: tool => { registered.push(tool) } },
    get: () => ({
      ask: async request => {
        questions += 1
        lastQuestion = request
        return { answers: [{ selected: ['取消'] }] }
      },
    }),
    subprocess: {},
  }
  const config = {
    registerFindTool: false,
    registerInstallTool: true,
    registerRemoveTool: false,
    persistentSkillCandidates: [sharedCandidate, docCandidate],
    globalSkillRoot: globalRoot,
    tempSkillRoot: join(scratch, 'temp'),
  }
  const provider = {
    list: async () => [{ name: 'lark-shared', description: 'shared Lark capability', locator: { path: target } }],
  }
  registerTools(ctx, config, provider, { list: () => [] })
  const install = registered.find(tool => tool.name === 'skill_install')

  assert.deepEqual(await install.execute(
    { source: PERSISTENT_SOURCE, skill: 'lark-shared', scope: 'global' },
    { agent: { session: { header: { id: 'second-session', cwd: scratch } } } },
  ), {
    installed: true,
    name: 'lark-shared',
    scope: 'global',
    path: target,
    description: 'shared Lark capability',
  })
  assert.equal(questions, 0)

  const restartedTools = []
  const restartedCtx = {
    ...ctx,
    tools: { register: tool => { restartedTools.push(tool) } },
  }
  registerTools(restartedCtx, config, provider, { list: () => [] })
  const restartedInstall = restartedTools.find(tool => tool.name === 'skill_install')
  assert.deepEqual(await restartedInstall.execute(
    { source: PERSISTENT_SOURCE, skill: 'lark-shared', scope: 'global' },
    { agent: { session: { header: { id: 'after-runtime-restart', cwd: scratch } } } },
  ), {
    installed: true,
    name: 'lark-shared',
    scope: 'global',
    path: target,
    description: 'shared Lark capability',
  })
  assert.equal(questions, 0)

  await assert.rejects(
    install.execute(
      { source: PERSISTENT_SOURCE, skill: 'lark-doc', scope: 'global' },
      { agent: { session: { header: { id: 'changed-skill', cwd: scratch } } } },
    ),
    /cancelled by the user/u,
  )
  await assert.rejects(
    install.execute(
      { source: 'larksuite/cli', skill: 'lark-shared', scope: 'global' },
      { agent: { session: { header: { id: 'changed-source', cwd: scratch } } } },
    ),
    /not an approved external-connection candidate/u,
  )
  assert.equal(questions, 1)
  assert.match(lastQuestion.questions[0].question, new RegExp(PERSISTENT_VERSION.replaceAll('.', '\\.')))
  assert.match(lastQuestion.questions[0].question, new RegExp(docCandidate.contentDigest))
})

test('pinned Skill bytes are verified before an existing device-global install is replaced', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'emate-find-skill-pinned-install-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const fixture = join(scratch, 'fixture', 'lark-doc')
  const skillContent = '---\nname: lark-doc\ndescription: exact Lark document capability\n---\nbody\n'
  await mkdir(fixture, { recursive: true })
  await writeFile(join(fixture, 'SKILL.md'), skillContent, 'utf8')
  const candidate = persistentCandidateValue('lark-doc', await managedSkillDigest(fixture))
  const baseConfig = {
    persistentSkillCandidates: [candidate],
    globalSkillRoot: join(scratch, 'global'),
    tempSkillRoot: join(scratch, 'fetches'),
    cliCommand: 'test-skills',
  }
  let notifications = 0
  const provider = { notifyChanged: () => { notifications += 1 } }
  const subprocess = fakeSkillFetchSubprocess('lark-doc', skillContent)
  const result = await installSkill(
    subprocess, () => {}, baseConfig, provider, { add: async () => {} },
    'global', candidate.source, candidate.skill, scratch,
  )
  assert.equal(result.path, join(baseConfig.globalSkillRoot, 'lark-doc'))
  const receipt = JSON.parse(await readFile(join(result.path, '.dsh-find-skill.json'), 'utf8'))
  assert.equal(receipt.sourceVersion, PERSISTENT_VERSION)
  assert.equal(receipt.contentDigest, candidate.contentDigest)
  assert.equal(notifications, 1)

  const before = await readFile(join(result.path, 'SKILL.md'), 'utf8')
  const mismatched = { ...baseConfig, persistentSkillCandidates: [{ ...candidate, contentDigest: 'f'.repeat(64) }] }
  await assert.rejects(
    installSkill(
      subprocess, () => {}, mismatched, provider, { add: async () => {} },
      'global', candidate.source, candidate.skill, scratch,
    ),
    /does not match the approved version and SHA-256/u,
  )
  assert.equal(await readFile(join(result.path, 'SKILL.md'), 'utf8'), before)
  assert.equal(notifications, 1)
})

test('device-global Skill update preserves the old bundle on digest failure and atomically records success', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'emate-find-skill-pinned-update-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const globalRoot = join(scratch, 'global')
  const target = await writeManagedSkill(
    globalRoot,
    'lark-doc',
    'global',
    PERSISTENT_SOURCE,
    '---\nname: lark-doc\ndescription: previous capability\n---\nprevious\n',
  )
  const nextContent = '---\nname: lark-doc\ndescription: updated capability\n---\nupdated\n'
  const fixture = join(scratch, 'fixture', 'lark-doc')
  await mkdir(fixture, { recursive: true })
  await writeFile(join(fixture, 'SKILL.md'), nextContent, 'utf8')
  const candidate = persistentCandidateValue('lark-doc', await managedSkillDigest(fixture))
  const baseConfig = {
    persistentSkillCandidates: [candidate],
    globalSkillRoot: globalRoot,
    tempSkillRoot: join(scratch, 'fetches'),
    cliCommand: 'test-skills',
  }
  let notifications = 0
  const provider = { notifyChanged: () => { notifications += 1 } }
  const tempManager = { list: () => [], remove: async () => false, add: async () => {} }

  await assert.rejects(
    updateSkill(
      fakeSkillFetchSubprocess('lark-doc', nextContent), () => {},
      { ...baseConfig, persistentSkillCandidates: [{ ...candidate, contentDigest: 'f'.repeat(64) }] },
      provider, tempManager, 'global', 'lark-doc', scratch,
    ),
    /does not match the approved version and SHA-256/u,
  )
  assert.match(await readFile(join(target, 'SKILL.md'), 'utf8'), /previous/u)
  assert.equal(notifications, 0)

  const result = await updateSkill(
    fakeSkillFetchSubprocess('lark-doc', nextContent), () => {}, baseConfig,
    provider, tempManager, 'global', 'lark-doc', scratch,
  )
  assert.deepEqual(result, { updated: true, name: 'lark-doc', scope: 'global' })
  assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), nextContent)
  const receipt = JSON.parse(await readFile(join(target, '.dsh-find-skill.json'), 'utf8'))
  assert.equal(receipt.source, PERSISTENT_SOURCE)
  assert.equal(receipt.sourceVersion, PERSISTENT_VERSION)
  assert.equal(receipt.contentDigest, candidate.contentDigest)
  assert.equal(receipt.receiptVersion, 1)
  assert.equal(notifications, 1)
})

test('an interrupted managed Skill swap restores the complete previous directory', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'emate-find-skill-swap-recovery-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const target = join(scratch, 'global', 'lark-doc')
  const backup = join(scratch, 'global', '.lark-doc.e-mate-backup')
  const staging = join(scratch, 'global', '.lark-doc.e-mate-staging')
  await mkdir(backup, { recursive: true })
  await mkdir(staging, { recursive: true })
  await writeFile(join(backup, 'SKILL.md'), 'complete previous Skill', 'utf8')
  await writeFile(join(staging, 'SKILL.md'), 'partial next Skill', 'utf8')

  await recoverManagedSkillSwap(target)

  assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), 'complete previous Skill')
  await assert.rejects(stat(backup), { code: 'ENOENT' })
  await assert.rejects(stat(staging), { code: 'ENOENT' })
})

test('managed Skill recovery rejects a swap symlink without touching its external target', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'emate-find-skill-swap-symlink-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const globalRoot = join(scratch, 'global')
  const target = join(globalRoot, 'lark-doc')
  const staging = join(globalRoot, '.lark-doc.e-mate-staging')
  const external = join(scratch, 'outside')
  await mkdir(globalRoot, { recursive: true })
  await mkdir(external, { recursive: true })
  await writeFile(join(external, 'sentinel'), 'do not delete', 'utf8')
  await symlink(external, staging)

  await assert.rejects(recoverManagedSkillSwap(target), /conflicting managed Skill swap entry/u)
  assert.equal(await readFile(join(external, 'sentinel'), 'utf8'), 'do not delete')
})

test('a fetched receipt symlink is rejected before the existing Skill or external file changes', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'emate-find-skill-receipt-symlink-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const fixture = join(scratch, 'fixture', 'lark-doc')
  const skillContent = '---\nname: lark-doc\ndescription: exact Lark document capability\n---\nbody\n'
  await mkdir(fixture, { recursive: true })
  await writeFile(join(fixture, 'SKILL.md'), skillContent, 'utf8')
  const candidate = persistentCandidateValue('lark-doc', await managedSkillDigest(fixture))
  const globalRoot = join(scratch, 'global')
  const existing = await writeManagedSkill(globalRoot, 'lark-doc', 'global', candidate.source, 'keep previous Skill')
  const sentinel = join(scratch, 'outside.json')
  await writeFile(sentinel, 'do not overwrite', 'utf8')
  const config = {
    persistentSkillCandidates: [candidate],
    globalSkillRoot: globalRoot,
    tempSkillRoot: join(scratch, 'fetches'),
    cliCommand: 'test-skills',
  }

  await assert.rejects(
    installSkill(
      fakeSkillFetchSubprocess('lark-doc', skillContent, sentinel), () => {}, config,
      { notifyChanged: () => {} }, { add: async () => {} },
      'global', candidate.source, candidate.skill, scratch,
    ),
    /not a regular managed Skill entry/u,
  )
  assert.equal(await readFile(join(existing, 'SKILL.md'), 'utf8'), 'keep previous Skill')
  assert.equal(await readFile(sentinel, 'utf8'), 'do not overwrite')
})

test('a legacy receipt symlink is never migrated or followed outside the managed Skill', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'emate-find-skill-legacy-symlink-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const globalRoot = join(scratch, 'global')
  const target = join(globalRoot, 'lark-shared')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'SKILL.md'), '---\nname: lark-shared\ndescription: shared\n---\nbody\n', 'utf8')
  const candidate = await persistentCandidate(target, 'lark-shared')
  const sentinel = join(scratch, 'outside-receipt.json')
  const legacyReceipt = JSON.stringify({
    source: 'larksuite/cli',
    skill: 'lark-shared',
    installedAt: Date.now(),
    scope: 'global',
  })
  await writeFile(sentinel, legacyReceipt, 'utf8')
  await symlink(sentinel, join(target, '.dsh-find-skill.json'))

  assert.equal(await findInstalledPersistentSkill(globalRoot, candidate), undefined)
  assert.equal(await readFile(sentinel, 'utf8'), legacyReceipt)
})

test('external connection instructions reuse device-global state', async () => {
  const skillsRoot = new URL('../lib/skills/', import.meta.url)
  const documents = await Promise.all([
    'connect-feishu-cli',
    'connect-tencent-docs',
    'connect-dingtalk',
    'connect-wechat-bot',
  ].map(name => readFile(new URL(`${name}/SKILL.md`, skillsRoot), 'utf8')))
  for (const document of documents) {
    assert.match(document, /device-global/u)
    assert.doesNotMatch(document, /current session only|scope appropriate/u)
  }
  assert.match(documents[0], /<LARK_CLI>`? auth status --json --verify/u)
  assert.match(documents[0], /EMATE_DESKTOP_PNPM_ENTRY/u)
  assert.match(documents[0], /official pinned 1\.0\.88 executable/u)
  assert.match(documents[0], /including user status `needs_refresh`/u)
  assert.match(documents[0], /execute the requested user API operation normally/u)
  assert.match(documents[0], /do not run `config init`, `auth login`, or another authorization scan/u)
  assert.match(documents[0], /new e-Mate session or app version is never by itself a reason to authorize again/u)
  assert.doesNotMatch(documents[0], /@larksuite\/cli@latest/u)
})

test('signed connector instructions replace only recognized predecessors and preserve external auth state', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'emate-find-skill-bundled-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const roots = { globalSkillDir: join(scratch, 'global'), tempSkillDir: join(scratch, 'temp') }
  const authSentinel = join(scratch, '.lark-cli', 'authorization.keep')
  await mkdir(join(scratch, '.lark-cli'), { recursive: true })
  await writeFile(authSentinel, 'device-global-token-state', 'utf8')
  await writeManagedSkill(
    roots.globalSkillDir,
    'connect-feishu-cli',
    'global',
    'https://github.com/zyfjacksonchen-source/e-Mate/tree/skills-v2.0.9-r2/skills/connect-feishu-cli',
    'always run config init --new and auth login',
  )
  const config = connectorConfig()
  const result = reconcileBundledConnectorSkills(config, roots)
  assert.deepEqual(result.updated, ['connect-feishu-cli'])
  assert.deepEqual(result.installed, ['connect-tencent-docs', 'connect-dingtalk', 'connect-wechat-bot', 'xin-assistant', 'enterprise-knowledge'])
  const installed = await readFile(join(roots.globalSkillDir, 'connect-feishu-cli', 'SKILL.md'), 'utf8')
  assert.match(installed, /auth status --json --verify/u)
  assert.doesNotMatch(installed, /always run config init/u)
  const metadata = JSON.parse(await readFile(
    join(roots.globalSkillDir, 'connect-feishu-cli', '.dsh-find-skill.json'),
    'utf8',
  ))
  assert.equal(metadata.source, 'e-mate-bundled:connect-feishu-cli')
  assert.equal(metadata.scope, 'global')
  assert.match(metadata.bundleDigest, /^[a-f0-9]{64}$/u)
  assert.equal(await readFile(authSentinel, 'utf8'), 'device-global-token-state')
  const second = reconcileBundledConnectorSkills(config, roots)
  assert.deepEqual(second.unchanged, BUNDLED_CONNECTOR_SKILLS)
})

test('bundled connector reconciliation restores an interrupted swap and never overwrites an unknown owner', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'emate-find-skill-collision-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const globalSkillDir = join(scratch, 'global')
  const roots = { globalSkillDir, tempSkillDir: join(scratch, 'temp') }
  await writeManagedSkill(globalSkillDir, 'connect-tencent-docs', 'global', 'user/private', 'keep custom owner')
  await writeManagedSkill(
    globalSkillDir,
    '.connect-feishu-cli.e-mate-backup',
    'global',
    'https://github.com/zyfjacksonchen-source/e-Mate/tree/skills-v2.0.9-r2/skills/connect-feishu-cli',
    'recover me',
  )
  await mkdir(join(globalSkillDir, '.connect-feishu-cli.e-mate-staging'), { recursive: true })
  await writeFile(join(globalSkillDir, '.connect-feishu-cli.e-mate-staging', 'partial'), 'partial', 'utf8')
  const result = reconcileBundledConnectorSkills(connectorConfig(), roots)
  assert.deepEqual(result.conflicts, ['connect-tencent-docs'])
  assert.equal(await readFile(join(globalSkillDir, 'connect-tencent-docs', 'SKILL.md'), 'utf8'), 'keep custom owner')
  assert.match(await readFile(join(globalSkillDir, 'connect-feishu-cli', 'SKILL.md'), 'utf8'), /auth status --json --verify/u)
  await assert.rejects(stat(join(globalSkillDir, '.connect-feishu-cli.e-mate-backup')), { code: 'ENOENT' })
  await assert.rejects(stat(join(globalSkillDir, '.connect-feishu-cli.e-mate-staging')), { code: 'ENOENT' })
})

test('Feishu install bypasses the shell shim EINVAL path through direct Electron-as-Node inputs', async () => {
  const builtCli = await readFile(new URL('../lib/cli.js', import.meta.url), 'utf8')
  assert.match(builtCli, /EMATE_DESKTOP_RUN_AS_NODE/u)
  assert.match(builtCli, /EMATE_DESKTOP_PNPM_ENTRY/u)
  assert.match(builtCli, /EMATE_DESKTOP_CLEAR_ENV/u)
  assert.match(builtCli, /ELECTRON_RUN_AS_NODE: '1'/u)
  assert.doesNotMatch(builtCli, /EMATE_DESKTOP_PNPM\b/u)

  const previous = Object.fromEntries([
    'EMATE_DESKTOP_RUN_AS_NODE', 'EMATE_DESKTOP_PNPM_ENTRY', 'EMATE_DESKTOP_CLEAR_ENV',
  ].map(name => [name, process.env[name]]))
  Object.assign(process.env, {
    EMATE_DESKTOP_RUN_AS_NODE: '/Applications/e-Mate.app/Contents/MacOS/e-Mate',
    EMATE_DESKTOP_PNPM_ENTRY: '/Applications/e-Mate.app/Contents/Resources/app/node_modules/pnpm/bin/pnpm.mjs',
    EMATE_DESKTOP_CLEAR_ENV: '/tmp/e-mate/clear-env.mjs',
  })
  let spec
  const subprocess = { spawn(value) {
    spec = value
    return {
      done: Promise.resolve({ exitCode: 0, signal: null }),
      collected: {
        stdout: { readFrom: () => ({ text: '' }) },
        stderr: { readFrom: () => ({ text: '' }) },
      },
    }
  } }
  try {
    await runCli(subprocess, 'pnpm dlx skills@1.5.22', ['add', PERSISTENT_SOURCE, '--skill', 'lark-doc'], {
      cwd: '/tmp/e-mate', env: { HOME: '/tmp/e-mate' },
    })
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  assert.deepEqual(spec.argv, [
    '/Applications/e-Mate.app/Contents/MacOS/e-Mate',
    '--import',
    'file:///tmp/e-mate/clear-env.mjs',
    '/Applications/e-Mate.app/Contents/Resources/app/node_modules/pnpm/bin/pnpm.mjs',
    'dlx', 'skills@1.5.22', 'add', PERSISTENT_SOURCE, '--skill', 'lark-doc',
  ])
  assert.deepEqual(spec.env, { HOME: '/tmp/e-mate', ELECTRON_RUN_AS_NODE: '1' })
})

test('find-skill CLI receives an isolated environment without host credentials', () => {
  const env = throwawayEnvironment('/tmp/e-mate-find-skill', {
    PATH: '/usr/bin:/bin',
    LANG: 'zh_CN.UTF-8',
    OPENAI_API_KEY: 'secret',
    DEEPSEEK_API_KEY: 'secret',
    EMATE_ENTERPRISE_TOKEN: 'secret',
  })
  assert.equal(env.PATH, '/usr/bin:/bin')
  assert.equal(env.HOME, '/tmp/e-mate-find-skill')
  assert.equal(env.npm_config_cache, '/tmp/e-mate-find-skill/.npm')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.DEEPSEEK_API_KEY, undefined)
  assert.equal(env.EMATE_ENTERPRISE_TOKEN, undefined)
})

test('skill removal rejects traversal before touching disk', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'emate-find-skill-traversal-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const sentinel = join(scratch, 'sentinel.txt')
  await writeFile(sentinel, 'keep', 'utf8')
  const runtime = fakeRuntime(scratch)
  await assert.rejects(
    removeManagedSkill(runtime.roots, runtime.tempManager, undefined, '../../..', async () => true, runtime.notifyChanged),
    /not a valid managed skill name/u,
  )
  assert.equal((await stat(sentinel)).isFile(), true)
})

test('scope-less removal skips a missing project skill and removes the managed global skill', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'emate-find-skill-global-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const runtime = fakeRuntime(scratch)
  const target = await writeManagedSkill(runtime.globalRoot, 'safe-skill', 'global')
  let confirmed
  const result = await removeManagedSkill(
    runtime.roots,
    runtime.tempManager,
    undefined,
    'safe-skill',
    async value => { confirmed = value; return true },
    runtime.notifyChanged,
  )
  assert.deepEqual(result, { removed: true, name: 'safe-skill', scope: 'global' })
  assert.deepEqual(confirmed, { name: 'safe-skill', scope: 'global', path: target })
  await assert.rejects(stat(target), { code: 'ENOENT' })
  assert.equal(runtime.notifications, 1)
})

test('skill removal keeps the exact managed directory when confirmation is rejected', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'emate-find-skill-cancel-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const runtime = fakeRuntime(scratch)
  const target = await writeManagedSkill(join(runtime.projectRoot, '.managed'), 'keep-skill', 'project')
  await assert.rejects(
    removeManagedSkill(runtime.roots, runtime.tempManager, 'project', 'keep-skill', async () => false, runtime.notifyChanged),
    /cancelled by the user/u,
  )
  assert.equal((await stat(target)).isDirectory(), true)
  assert.equal(runtime.notifications, 0)
})

function fakeRuntime(scratch) {
  const projectRoot = join(scratch, 'project')
  const globalRoot = join(scratch, 'global')
  const tempRoot = join(scratch, 'temp')
  const runtime = {
    projectRoot,
    globalRoot,
    tempRoot,
    notifications: 0,
    tempManager: { list: () => [], remove: async () => false },
  }
  runtime.roots = { projectSkillDir: join(projectRoot, '.managed'), globalSkillDir: globalRoot, tempSkillDir: tempRoot }
  runtime.notifyChanged = () => { runtime.notifications += 1 }
  return runtime
}

function connectorConfig() {
  return {
    catalogSkills: BUNDLED_CONNECTOR_SKILLS.map(name => {
      const source = ['xin-assistant', 'enterprise-knowledge'].includes(name) ? `e-mate-bundled:${name}` : `https://github.com/zyfjacksonchen-source/e-Mate-desktop/tree/skills-v2.0.12-r1/skills/${name}`
      return { id: name, name, source, url: source, keywords: [name] }
    }),
  }
}

function persistentCandidateValue(skill, contentDigest) {
  return {
    source: PERSISTENT_SOURCE,
    legacySources: ['larksuite/cli'],
    skill,
    version: PERSISTENT_VERSION,
    contentDigest,
  }
}

async function persistentCandidate(target, skill) {
  return persistentCandidateValue(skill, await managedSkillDigest(target))
}

function fakeSkillFetchSubprocess(skill, content, receiptTarget) {
  return {
    spawn({ cwd }) {
      const done = (async () => {
        const target = join(cwd, '.agents', 'skills', skill)
        await mkdir(target, { recursive: true })
        await writeFile(join(target, 'SKILL.md'), content, 'utf8')
        if (receiptTarget !== undefined) {
          await symlink(receiptTarget, join(target, '.dsh-find-skill.json'))
        }
        return { exitCode: 0 }
      })()
      const stream = { readFrom: () => ({ text: '' }) }
      return { done, collected: { stdout: stream, stderr: stream } }
    },
  }
}

async function writeManagedSkill(root, name, scope, source = 'test/source', content) {
  const target = join(root, name)
  await mkdir(target, { recursive: true })
  await writeFile(
    join(target, 'SKILL.md'),
    content ?? `---\nname: ${name}\ndescription: test skill\n---\nbody\n`,
    'utf8',
  )
  await writeFile(join(target, '.dsh-find-skill.json'), JSON.stringify({
    source,
    skill: name,
    installedAt: Date.now(),
    receiptVersion: 1,
    contentDigest: await managedSkillDigest(target),
    scope,
  }), 'utf8')
  return target
}


test('enterprise knowledge is preinstalled through the managed provider and stays distinct from Xin business access', async t => {
  const { ManagedSkillProvider } = await import('../lib/provider.js')
  const { searchCatalogSkills } = await import('../lib/search.js')
  const config = parse(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))[0].insert[0].config
  assert.deepEqual(searchCatalogSkills(config.catalogSkills, 'enterprise-knowledge').map(item => item.id), ['enterprise-knowledge'])
  const scratch = await mkdtemp(join(tmpdir(), 'emate-bundled-knowledge-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const roots = { globalSkillDir: join(scratch, 'global'), tempSkillDir: join(scratch, 'temp') }
  assert(reconcileBundledConnectorSkills(config, roots).installed.includes('enterprise-knowledge'))
  const provider = new ManagedSkillProvider({ globalSkillRoot: roots.globalSkillDir, tempSkillRoot: roots.tempSkillDir }, () => {})
  const candidates = await provider.list({ cwd: scratch })
  const knowledge = candidates.filter(item => item.name === 'enterprise-knowledge')
  assert.equal(knowledge.length, 1)
  const loaded = await provider.get(knowledge[0], {})
  assert(loaded.content.includes('enterprise_knowledge'))
  const receipt = JSON.parse(await readFile(join(roots.globalSkillDir, 'enterprise-knowledge', '.dsh-find-skill.json'), 'utf8'))
  assert.equal(receipt.source, 'e-mate-bundled:enterprise-knowledge')
  assert(reconcileBundledConnectorSkills(config, roots).unchanged.includes('enterprise-knowledge'))
})

test('one bundled Xin Skill uses the existing managed provider and old names remain search synonyms', async t => {
  const { ManagedSkillProvider } = await import('../lib/provider.js')
  const { searchCatalogSkills } = await import('../lib/search.js')
  const patch = parse(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
  const config = patch[0].insert[0].config
  const catalog = config.catalogSkills.filter(item => item.id.startsWith('xin-'))
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].id, 'xin-assistant')
  assert.equal(catalog[0].source, 'e-mate-bundled:xin-assistant')
  const metadataUi = parse(await readFile(new URL('../lib/skills/xin-assistant/agents/openai.yaml', import.meta.url), 'utf8'))
  assert.equal(metadataUi.interface.display_name, '芯助手')
  assert(metadataUi.interface.short_description.length >= 25 && metadataUi.interface.short_description.length <= 64)
  assert(metadataUi.interface.default_prompt.includes('$xin-assistant'))
  for (const name of ['芯助手', 'xin-business-data', 'xin-business-operations']) {
    const matches = searchCatalogSkills(config.catalogSkills, name)
    assert.deepEqual(matches.map(item => item.id), ['xin-assistant'])
  }
  const scratch = await mkdtemp(join(tmpdir(), 'emate-xin-skill-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const roots = { globalSkillDir: join(scratch, 'global'), tempSkillDir: join(scratch, 'temp') }
  const result = reconcileBundledConnectorSkills(config, roots)
  assert(result.installed.includes('xin-assistant'))
  const provider = new ManagedSkillProvider({ globalSkillRoot: roots.globalSkillDir, tempSkillRoot: roots.tempSkillDir }, () => {})
  const candidates = await provider.list({ cwd: scratch })
  const xin = candidates.filter(item => item.name.startsWith('xin-'))
  assert.deepEqual(xin.map(item => item.name), ['xin-assistant'])
  const loaded = await provider.get(xin[0], {})
  assert.match(loaded.content, /action: "ensure"/)
  assert.match(loaded.content, /取得一次针对该对象的确认/)
  assert.doesNotMatch(loaded.content, /请.*(?:密码|令牌).*粘贴/)
  const metadata = JSON.parse(await readFile(join(roots.globalSkillDir, 'xin-assistant', '.dsh-find-skill.json'), 'utf8'))
  assert.equal(metadata.source, 'e-mate-bundled:xin-assistant')
  assert(reconcileBundledConnectorSkills(config, roots).unchanged.includes('xin-assistant'))
  await writeManagedSkill(roots.globalSkillDir, 'xin-business-data', 'global', 'user/private', 'keep the user-owned legacy skill')
  reconcileBundledConnectorSkills(config, roots)
  assert.match(await readFile(join(roots.globalSkillDir, 'xin-business-data', 'SKILL.md'), 'utf8'), /keep the user-owned legacy skill/)
})
