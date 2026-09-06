// @vitest-environment jsdom
import React from 'react'
import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareTemplateDraftFromRoute } from '../src/client/index.ts'
import { OFFICE_TEMPLATES, QuickTemplates } from '../src/client/quick-templates.tsx'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  history.replaceState(null, '', '/')
})

function context(current: string | undefined, blank: boolean, workspaceId = 'general') {
  const setDraft = vi.fn()
  const connectWorkspace = vi.fn(async () => 'session-new')
  const state = {
    current,
    byId: current === undefined ? {} : { [current]: { blank } },
  }
  const ctx = {
    workspaces: {
      list: { getSnapshot: () => ({
        baselinesReady: true,
        items: workspaceId === 'general'
          ? [{ workspaceId: 'general', title: '通用会话', path: '/tmp/e-mate/general', sessionIds: current === undefined ? [] : [current] }]
          : [
              { workspaceId, title: '项目 A', path: '/work/project-a', sessionIds: current === undefined ? [] : [current] },
              { workspaceId: 'general', title: '通用会话', path: '/tmp/e-mate/general', sessionIds: [] },
            ],
      }) },
      connectWorkspace,
    },
    sessions: {
      list: { getSnapshot: () => state, subscribe: () => () => {} },
      open: vi.fn((id: string) => { state.current = id; state.byId[id] = { blank: true } }),
      scope: (id: string) => ({ sessionId: id }),
    },
    conversation: { input: { for: () => ({ setDraft }) } },
  }
  return { ctx, setDraft, connectWorkspace }
}

describe('T21 quick start templates', () => {
  it('renders exactly four specified actions and only delegates editable drafts before focusing Composer', async () => {
    const prepareDraft = vi.fn(async () => {})
    const composer = document.createElement('div')
    composer.dataset.slot = 'conversation.composer.bar'
    const textarea = document.createElement('textarea')
    composer.append(textarea)
    document.body.append(composer)
    render(<QuickTemplates prepareDraft={prepareDraft} />)

    expect(OFFICE_TEMPLATES).toEqual([
      ['小红书笔记创作', '按主题、受众与素材，生成结构清晰、语气自然的小红书笔记草稿。', '请根据我提供的主题、目标人群、产品卖点和素材，撰写一篇小红书笔记。先确认缺失信息，再输出标题、正文、话题标签和配图建议。'],
      ['计划方案撰写', '把目标与约束整理为步骤、时间节点、交付物和验收标准。', '请根据我的目标、背景和约束，撰写一份可执行的计划方案，包含目标、现状、步骤、时间安排、风险和验收标准。'],
      ['快速外部连接', '根据当前任务，填入外部服务选择、连接与授权引导草稿。', '请帮我连接并使用外部服务完成任务。先询问我要连接的服务和目标，再通过已有外部连接能力继续。'],
      ['深度数据分析', '识别关键趋势、异常与原因，形成可执行的分析结论和建议。', '请对我提供的数据进行深度分析，识别趋势、异常、关键驱动因素和风险，并给出结论、图表建议和可执行动作。'],
    ])
    expect(screen.getByRole('heading', { name: '快速开始' })).toBeTruthy()
    expect(screen.getByText('选择后只会填入草稿，你可以继续编辑。')).toBeTruthy()
    expect(screen.queryByText(/个模板/u)).toBeNull()
    const cards = screen.getAllByRole('button')
    expect(cards).toHaveLength(4)
    expect(document.querySelector('[data-emate-template-number]')).toBeNull()
    expect(cards.every(card => card.querySelector('svg') !== null)).toBe(true)
    const css = readFileSync('src/client/quick-templates.module.css', 'utf8')
    expect(css).not.toMatch(/\.number\s*\{/u)
    expect(css).toMatch(/\.grid button\s*\{[\s\S]*grid-template-columns: 28px minmax\(0, 1fr\);/u)
    expect(css).toMatch(/\.grid button:focus-visible\s*\{[\s\S]*outline: 2px solid var\(--emate-color-brand\)/u)
    for (const [index, [title, , draft]] of OFFICE_TEMPLATES.entries()) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(title, 'u') }))
      await waitFor(() => { expect(prepareDraft).toHaveBeenNthCalledWith(index + 1, draft) })
    }
    expect(document.activeElement).toBe(textarea)
    expect(document.querySelector('form')).toBeNull()
  })

  it('keeps an existing project Session while preparing a template draft without creating or sending', async () => {
    const { ctx, setDraft, connectWorkspace } = context('project-session', false, 'project-a')
    await prepareTemplateDraftFromRoute(ctx, '整理会议纪要')
    expect(connectWorkspace).not.toHaveBeenCalled()
    expect(ctx.sessions.open).not.toHaveBeenCalled()
    expect(setDraft).toHaveBeenCalledOnce()
    expect(setDraft).toHaveBeenCalledWith('整理会议纪要')
  })

  it('uses the existing Workspace connect seam when no blank Session exists, then opens and drafts once', async () => {
    const { ctx, setDraft, connectWorkspace } = context(undefined, false)
    await prepareTemplateDraftFromRoute(ctx, '制作工作计划')
    expect(connectWorkspace).toHaveBeenCalledOnce()
    expect(connectWorkspace).toHaveBeenCalledWith('general')
    expect(ctx.sessions.open).toHaveBeenCalledWith('session-new')
    expect(setDraft).toHaveBeenCalledOnce()
    expect(setDraft).toHaveBeenCalledWith('制作工作计划')
  })
})
