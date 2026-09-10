/** Native provider for support Skills and optional Office plugin discovery. */

import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillLookupOptions,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'emate-office-skills'
export const inject = ['skills']

const skillRoot = fileURLToPath(new URL('../skills/', import.meta.url))
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const SPECS = [
  { name: 'install-univer-office', description: '发现并按需安装 Univer 办公插件；用于缺少办公工具时处理 Excel、Word、PowerPoint、多维表格与画布。', whenToUse: '已有可用 Univer 工具时直接使用其工作流；仅在需要补充或修复本机 Univer 能力时使用此安装指引。' },
  { name: 'meeting-summary', description: '会议总结：从本地转录文本整理会议纪要、决策与行动项，保留事实来源。', whenToUse: '用于会议转录文本、VTT、SRT 的总结和行动项整理；不负责录音或音频转录。' },
  { name: 'lieflat-charts', description: 'Lieflat Charts：模板驱动的数据图表、交互可视化与中英文报告。', whenToUse: '用于将真实数据制作成 HTML 图表、交互地图或明确要求的整页报告，沿用预置模板与来源核验。' },
] as const
type SkillSpec = typeof SPECS[number]

function candidate(spec: SkillSpec): SkillCandidate {
  const directory = join(skillRoot, spec.name)
  return {
    ...spec,
    invocation: INVOCATION,
    source: 'bundled',
    provider: name,
    resourceBase: { kind: 'directory', path: directory },
    rank: BUNDLED_SKILL_RANK,
    locator: spec.name,
    path: join(directory, 'SKILL.md'),
    metadata: { adapter: spec.name === 'install-univer-office' ? 'e-mate' : 'upstream', state: 'ready' },
  }
}

async function loadDefinition(spec: SkillSpec, options: SkillLookupOptions): Promise<SkillDefinition> {
  const directory = join(skillRoot, spec.name)
  const path = join(directory, 'SKILL.md')
  const readOptions = { encoding: 'utf8' as const, signal: options.signal }
  const raw = await readFile(path, readOptions)
  const lines = raw.replace(/^\uFEFF/u, '').split(/\r?\n/u)
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1
  if (end < 0) throw new Error(`${name}: malformed skill frontmatter in ${path}`)
  const host = (await readFile(join(directory, 'HOST.md'), readOptions)).replaceAll('{{SKILL_DIR}}', directory)
  return { ...candidate(spec), content: `${host.trim()}\n\n${lines.slice(end + 1).join('\n').trim()}` }
}

export function apply(ctx: Context): void {
  ctx.skills.registerProvider((): SkillProvider => ({
    name,
    async list(options) {
      options.signal?.throwIfAborted()
      return SPECS.map(candidate)
    },
    async get(skill, options) {
      options.signal?.throwIfAborted()
      const spec = SPECS.find(item => item.name === skill.name && item.name === skill.locator)
      return spec === undefined ? undefined : await loadDefinition(spec, options)
    },
  }))
}
