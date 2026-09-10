import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '../../../upstream/deepseek-harness/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../upstream/deepseek-harness/packages/core/tools/lib/index.js'
import * as Presets from '../lib/index.js'

const root = fileURLToPath(new URL('../', import.meta.url))

test('native registry exposes preserved Skills and optional plugin discovery without installing or registering Tools', async t => {
  const ctx = new Context()
  const fibers = []
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose() })
  const mount = async plugin => { const fiber = ctx.plugin(plugin); fibers.push(fiber); await fiber; return fiber }
  await mount(SkillRegistry)
  assert.deepEqual(Presets.inject, ['skills'])
  assert.deepEqual(Object.keys(Presets).sort(), ['apply', 'inject', 'name'])
  const presets = await mount(Presets)
  // The provider mounts with only its native Skill service; Tool/Job services are unnecessary.
  assert.equal(ctx.get('tools'), undefined)
  assert.equal(ctx.get('jobs'), undefined)
  const skills = await ctx.skills.list({})
  assert.deepEqual(skills.map(skill => skill.name), ['install-univer-office', 'lieflat-charts', 'meeting-summary'])
  for (const skill of skills) {
    assert.equal(skill.provider, 'emate-office-skills')
    assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
    const loaded = await ctx.skills.get(skill.name, {})
    assert.ok(loaded.content.length > 300)
    assert.equal(loaded.metadata.adapter, skill.name === 'install-univer-office' ? 'e-mate' : 'upstream')
    assert.equal(loaded.metadata.state, 'ready')
    assert.equal(loaded.resourceBase.kind, 'directory')
    assert.ok(loaded.content.includes(loaded.resourceBase.path))
    assert.doesNotMatch(loaded.content, /^---|\{\{SKILL_DIR\}\}|office_read|office_write/u)
    if (skill.name === 'meeting-summary') {
      assert.match(skill.description, /^会议总结/u)
      assert.match(loaded.content, /原文是事实和引用的权威来源/u)
      assert.match(loaded.content, /清洗不是必需步骤/u)
      assert.match(loaded.content, /# Meeting Transcript Summary Skill/u)
      const original = await readFile(join(loaded.resourceBase.path, 'SKILL.md'))
      assert.equal(createHash('sha256').update(original).digest('hex'), '852f8724aafd16de632326fb7aa12437bf8129b919f80180de71e216902694ca')
      assert.match(await readFile(join(loaded.resourceBase.path, 'LICENSE'), 'utf8'), /Apache License/u)
      for (const resource of ['references/canvas_ui_guide.md', 'references/quality_checklist.md', 'references/transcript_formats.md', 'templates/meeting_dashboard_template.html']) {
        assert.ok((await readFile(join(loaded.resourceBase.path, resource))).length > 0)
      }
    } else if (skill.name === 'lieflat-charts') {
      assert.match(loaded.content, /先加载 univer，再加载对应 Unit Skill/u)
      assert.match(loaded.content, /univer-sheet.*univer-doc.*univer-slide/u)
      assert.match(loaded.content, /univer_\*/u)
      assert.match(loaded.content, /现有浏览器能力/u)
      assert.doesNotMatch(loaded.content, /本 skill 由|署名提示/u)
    }
  }
  for (const removed of ['documents', 'pdf', 'spreadsheets', 'ppt-master']) assert.equal(await ctx.skills.get(removed, {}), undefined)
  await mount(SystemPrompt)
  await mount(ToolRuntime)
  assert.deepEqual(ctx.tools.schemas(), [])
  await presets.dispose()
  assert.deepEqual(await ctx.skills.list({}), [])
  assert.deepEqual(ctx.tools.schemas(), [])
})

test('Lieflat retains all 125 recorded resource hashes, license and real template validation', async () => {
  const skillRoot = join(root, 'skills/lieflat-charts')
  const manifest = JSON.parse(await readFile(join(skillRoot, 'UPSTREAM.json'), 'utf8'))
  assert.equal(manifest.commit, 'eace082a317b696c5570c25826a53a7fa113e984')
  assert.equal(manifest.files.length, 125)
  assert.equal(manifest.distribution_basis.kind, 'user-confirmed-enterprise-authorization')
  assert.equal(manifest.distribution_basis.contract_document_in_repository, false)
  for (const file of manifest.files) {
    const bytes = await readFile(join(skillRoot, file.path))
    const expected = manifest.local_modifications?.find(item => item.path === file.path) ?? file
    assert.equal(bytes.length, expected.bytes, file.path)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, file.path)
  }
  assert.equal(manifest.files.find(file => file.path === 'SKILL.md').sha256, '1d58a31343b0f38fed16a44a65fd2fac0588ca98ffc9e43b20263d886f3ee9ce')
  assert.deepEqual(manifest.local_modifications.map(file => file.path), ['SKILL.md'])
  assert.match(await readFile(join(skillRoot, 'LICENSE'), 'utf8'), /PolyForm Noncommercial License 1.0.0/u)
  const validation = spawnSync(process.execPath, [join(skillRoot, 'scripts/validate.mjs')], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(validation.status, 0, validation.error?.message ?? validation.stderr + validation.stdout)
})

test('the package contains support and installation Skills without any old Office executor or client', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.deepEqual((await readdir(join(root, 'skills'))).sort(), ['install-univer-office', 'lieflat-charts', 'meeting-summary'])
  assert.deepEqual(await readdir(join(root, 'src')), ['index.ts'])
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.exports['./client'], undefined)
  assert.equal(pkg.dsh.client, undefined)
  assert.equal(pkg.dsh.officeSkills, undefined)
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-skill'], '0.1.0-rc.7')
  assert.equal(pkg.eMate.harnessCommit, '4da69d7c3522ee51de12822c917c503a124f7a7d')
  assert.ok(pkg.files.includes('skills'))
  for (const removed of ['assets', 'scripts', 'patches', 'vitest.config.ts']) assert.equal((await readdir(root)).includes(removed), false)
})

test('meeting transcript helper preserves Chinese speakers and standalone numeric facts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'emate-meeting-summary-'))
  t.after(async () => await rm(directory, { recursive: true, force: true }))
  const input = join(directory, '会议 转录.txt')
  const output = join(directory, '会议 整理.txt')
  const transcript = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\n张三：预算金额如下\n300\n李四：客户数量\n25\n王五：责任人未定，截止日期未提供。\n'
  await writeFile(input, transcript)
  const python = process.env.EMATE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  const result = spawnSync(python, [fileURLToPath(new URL('../skills/meeting-summary/scripts/clean_transcript.py', import.meta.url)),
    input, '--output', output], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  const cleaned = await readFile(output, 'utf8')
  assert.match(cleaned, /张三：预算金额如下 300 李四：客户数量 25 王五：责任人未定/u)
  assert.doesNotMatch(cleaned, /WEBVTT|00:00:01|(?:^|\s)1(?:\s|$)/u)
  assert.equal(await readFile(input, 'utf8'), transcript)
})
