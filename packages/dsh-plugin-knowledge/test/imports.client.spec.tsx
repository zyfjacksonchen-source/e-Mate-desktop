// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { diskFiles, KnowledgeImports } from '../src/client/imports.tsx'
const scope = 'a'.repeat(64)
const prepared = { operation_id: '1'.repeat(36), session_id: '2'.repeat(36), title: '导入并整理知识', scope: { kind: 'uploader-private' }, model: { id: 'model', reasoning_effort: 'medium' }, phase: 'prepared', sources: [], compiled_count: 0, updated_at: 1 }
const reply = (result: any) => ({ scope_key: scope, result })
afterEach(() => { cleanup(); delete (window as any).__DSH_DESKTOP_FILE_PATH__ })
function file() { return new File(['original'], 'report.pdf', { type: 'application/pdf' }) }
function selectOriginal() {
  const original = file()
  ;(window as any).__DSH_DESKTOP_FILE_PATH__ = { getPathForFile: vi.fn(value => { expect(value).toBe(original); return '/sources/report.pdf' }) }
  fireEvent.change(screen.getByLabelText('选择知识原件'), { target: { files: [original] } })
  return original
}
it('one user click prepares a Host identity then starts the native operation, without a draft or duplicate prepare', async () => {
  const call = vi.fn(async (endpoint: string, payload: any) => {
    if (endpoint === 'ui.import.recent') return reply({ items: [], has_more: false })
    if (endpoint === 'ui.import.prepare') { expect(payload).toEqual({ paths: ['/sources/report.pdf'], scope: { kind: 'uploader-private' } }); return reply(prepared) }
    if (endpoint === 'ui.import.start') { expect(payload).toEqual({ operation_id: prepared.operation_id, session_id: prepared.session_id }); return reply({ ...prepared, phase: 'importing', job_id: 'knowledge-import-1' }) }
    throw Error(endpoint)
  })
  render(<KnowledgeImports callKnowledge={call} />)
  fireEvent.click(screen.getByRole('button', { name: '导入并整理' })); selectOriginal()
  const button = screen.getByRole('button', { name: '导入并整理所选资料' })
  act(() => { fireEvent.click(button); fireEvent.click(button) })
  await screen.findByText('导入中')
  expect(call.mock.calls.filter(args => args[0] === 'ui.import.prepare')).toHaveLength(1)
  expect(call.mock.calls.filter(args => args[0] === 'ui.import.start')).toHaveLength(1)
  expect(screen.queryByLabelText('待导入原件')).toBeNull()
})
it('rejects virtual files and never substitutes a forged File.path', () => {
  expect(() => diskFiles([{} as File], { getPathForFile: () => '/private' })).toThrow('真实磁盘文件')
  const original = file(); Object.assign(original, { path: '/forged' })
  expect(() => diskFiles([original], { getPathForFile: () => '' })).toThrow('磁盘位置')
})
it('uses the injected native folder picker and preserves explicit public scope', async () => {
  const pick = vi.fn(async () => '/sources/folder')
  const call = vi.fn(async (endpoint: string, payload: any) => endpoint === 'ui.import.recent' ? reply({ items: [], has_more: false }) : endpoint === 'ui.import.prepare' ? reply({ ...prepared, scope: payload.scope }) : reply({ ...prepared, phase: 'parsing' }))
  render(<KnowledgeImports callKnowledge={call} pickDirectory={pick} />)
  fireEvent.click(screen.getByRole('button', { name: '导入并整理' }))
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' })); await screen.findByText('folder')
  fireEvent.change(screen.getByRole('combobox', { name: '资料范围' }), { target: { value: 'public' } })
  fireEvent.click(screen.getByRole('button', { name: '导入并整理所选资料' }))
  await screen.findByText('解析中')
  expect(pick).toHaveBeenCalledOnce()
  expect(call).toHaveBeenCalledWith('ui.import.prepare', { paths: ['/sources/folder'], scope: { kind: 'public' } }, expect.any(AbortSignal))
})
it('clears old files and ignores a late prepared operation after identity changes', async () => {
  let finish!: (value: any) => void
  const call = vi.fn((endpoint: string) => endpoint === 'ui.import.recent' ? Promise.resolve(reply({ items: [], has_more: false })) : new Promise<any>(resolve => { finish = resolve }))
  render(<KnowledgeImports callKnowledge={call} />)
  fireEvent.click(screen.getByRole('button', { name: '导入并整理' })); selectOriginal()
  fireEvent.click(screen.getByRole('button', { name: '导入并整理所选资料' }))
  act(() => dispatchEvent(new Event('emate:identity-changed')))
  await act(async () => finish(reply({ ...prepared, title: '旧账号任务' })))
  expect(screen.queryByText('旧账号任务')).toBeNull(); expect(screen.queryByText('report.pdf')).toBeNull()
  expect(call.mock.calls.some(args => args[0] === 'ui.import.start')).toBe(false)
})
it('read-only projects remain disabled and partial directories do not pretend completeness', async () => {
  const call = vi.fn(async (endpoint: string) => endpoint === 'ui.import.projects' ? reply({ items: [{ id: 1, title: '只读项目', can_import: false }, { id: 2, title: '可维护项目', can_import: true }], complete: false }) : reply({ items: [], has_more: false }))
  render(<KnowledgeImports callKnowledge={call} />)
  fireEvent.click(screen.getByRole('button', { name: '导入并整理' }))
  fireEvent.change(screen.getByRole('combobox', { name: '资料范围' }), { target: { value: 'project' } })
  const readonly = await screen.findByRole('option', { name: '只读项目（只读）' })
  expect(readonly.hasAttribute('disabled')).toBe(true)
  expect(screen.getByText(/项目目录为部分结果/)).toBeTruthy()
})
it('leaving the panel does not issue stop and failed start responses are queried using the issued identity', async () => {
  const call = vi.fn(async (endpoint: string) => {
    if (endpoint === 'ui.import.recent') return reply({ items: [], has_more: false })
    if (endpoint === 'ui.import.prepare') return reply(prepared)
    if (endpoint === 'ui.import.start') throw Error('response lost')
    if (endpoint === 'ui.import.status') return reply({ ...prepared, phase: 'compiling', job_id: 'knowledge-import-1' })
    throw Error(endpoint)
  })
  const view = render(<KnowledgeImports callKnowledge={call} />)
  fireEvent.click(screen.getByRole('button', { name: '导入并整理' })); selectOriginal()
  fireEvent.click(screen.getByRole('button', { name: '导入并整理所选资料' }))
  await screen.findByText('整理中')
  expect(call).toHaveBeenCalledWith('ui.import.status', { operation_id: prepared.operation_id, session_id: prepared.session_id }, expect.any(AbortSignal))
  view.unmount()
  expect(call.mock.calls.some(args => args[0] === 'ui.import.stop')).toBe(false)
})


it('freezes every file admission path while prepare waits and unlocks after start acknowledges', async () => {
  let finish: (value: any) => void = () => {}
  const call = vi.fn(async (endpoint: string, payload: any) => {
    if (endpoint === 'ui.import.recent') return reply({ items: [], has_more: false })
    if (endpoint === 'ui.import.prepare') { expect(payload.paths).toEqual(['/sources/report.pdf']); return new Promise(resolve => { finish = resolve }) }
    if (endpoint === 'ui.import.start') return reply({ ...prepared, phase: 'importing' })
    throw Error(endpoint)
  })
  const pickDirectory = vi.fn(async () => '/sources/folder')
  render(<KnowledgeImports callKnowledge={call} pickDirectory={pickDirectory} />)
  fireEvent.click(screen.getByRole('button', { name: '导入并整理' })); selectOriginal()
  const bridge = (window as any).__DSH_DESKTOP_FILE_PATH__.getPathForFile
  bridge.mockImplementation((file: File) => '/sources/' + file.name)
  fireEvent.click(screen.getByRole('button', { name: '导入并整理所选资料' }))
  for (const name of ['选择文件', '选择文件夹', '移除 report.pdf']) expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByLabelText('选择知识原件').hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('combobox', { name: '资料范围' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('textbox', { name: '整理主题（可选）' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: '收起知识导入' }).hasAttribute('disabled')).toBe(false)
  const later = new File(['next'], 'later.pdf', { type: 'application/pdf' })
  fireEvent.change(screen.getByLabelText('选择知识原件'), { target: { files: [later] } })
  const drop = screen.getByText('拖入磁盘文件，或').parentElement!
  fireEvent.drop(drop, { dataTransfer: { types: ['Files'], files: [later] } })
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
  expect(pickDirectory).not.toHaveBeenCalled(); expect(bridge).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: '移除 later.pdf' })).toBeNull()
  await act(async () => finish(reply(prepared)))
  await screen.findByText('导入中')
  expect(screen.getByRole('button', { name: '选择文件' }).hasAttribute('disabled')).toBe(false)
  fireEvent.change(screen.getByLabelText('选择知识原件'), { target: { files: [later] } })
  expect(screen.getByRole('button', { name: '移除 later.pdf' })).toBeTruthy()
})

it('reading supplement reopens the same import selection without clearing files or changing explicit scope', async () => {
  const call = vi.fn(async (_endpoint: string) => reply({ items: [], has_more: false }))
  const view = render(<KnowledgeImports callKnowledge={call} openRequest={0} />)
  fireEvent.click(screen.getByRole('button', { name: '导入并整理' }))
  selectOriginal()
  fireEvent.change(screen.getByRole('combobox', { name: '资料范围' }), { target: { value: 'public' } })
  fireEvent.click(screen.getByRole('button', { name: '收起知识导入' }))
  await act(async () => view.rerender(<KnowledgeImports callKnowledge={call} openRequest={1} />))
  expect(screen.getByText('report.pdf')).toBeTruthy()
  expect((screen.getByRole('combobox', { name: '资料范围' }) as HTMLSelectElement).value).toBe('public')
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '选择文件' }))
  expect(call.mock.calls.every(([endpoint]) => endpoint === 'ui.import.recent')).toBe(true)
})
