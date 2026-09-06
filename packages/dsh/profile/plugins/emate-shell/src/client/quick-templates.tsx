import { useState } from 'react'
import {
  IconChecklistOutline14, IconDataOutline16, IconEditOutline16, IconLinkOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './quick-templates.module.css'

export const OFFICE_TEMPLATES = [
  ['小红书笔记创作', '按主题、受众与素材，生成结构清晰、语气自然的小红书笔记草稿。', '请根据我提供的主题、目标人群、产品卖点和素材，撰写一篇小红书笔记。先确认缺失信息，再输出标题、正文、话题标签和配图建议。'],
  ['计划方案撰写', '把目标与约束整理为步骤、时间节点、交付物和验收标准。', '请根据我的目标、背景和约束，撰写一份可执行的计划方案，包含目标、现状、步骤、时间安排、风险和验收标准。'],
  ['快速外部连接', '根据当前任务，填入外部服务选择、连接与授权引导草稿。', '请帮我连接并使用外部服务完成任务。先询问我要连接的服务和目标，再通过已有外部连接能力继续。'],
  ['深度数据分析', '识别关键趋势、异常与原因，形成可执行的分析结论和建议。', '请对我提供的数据进行深度分析，识别趋势、异常、关键驱动因素和风险，并给出结论、图表建议和可执行动作。'],
] as const

const TEMPLATE_ICONS = [IconEditOutline16, IconChecklistOutline14, IconLinkOutline16, IconDataOutline16] as const

interface Props {
  prepareDraft: (prompt: string) => void | Promise<void>
}

export function QuickTemplates({ prepareDraft }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const choose = async (name: string, prompt: string) => {
    if (busy !== null) return
    setBusy(name)
    setError(null)
    try {
      await prepareDraft(prompt)
      document.querySelector<HTMLTextAreaElement>("[data-slot='conversation.composer.bar'] textarea")?.focus()
    } catch {
      setError('模板暂时无法写入输入框，请重试。')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className={css.templates} aria-labelledby="emate-quick-templates-title" data-emate-quick-templates="">
      <header><div><h2 id="emate-quick-templates-title">快速开始</h2><p>选择后只会填入草稿，你可以继续编辑。</p></div></header>
      <div className={css.grid}>
        {OFFICE_TEMPLATES.map(([name, description, prompt], index) => {
          const Icon = TEMPLATE_ICONS[index]
          return (
          <button
            key={name}
            type="button"
            disabled={busy !== null}
            aria-busy={busy === name}
            onClick={() => { void choose(name, prompt) }}
          >
            <span className={css.icon} aria-hidden="true"><Icon size={18} /></span>
            <strong>{name}</strong>
            <small>{description}</small>
          </button>
          )
        })}
      </div>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
    </section>
  )
}
