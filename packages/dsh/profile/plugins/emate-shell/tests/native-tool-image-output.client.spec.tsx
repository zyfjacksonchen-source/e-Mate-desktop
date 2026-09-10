// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ConversationNodeAssembler } from '../../../../../../upstream/deepseek-harness/packages/client/ui-conversation/src/client/conversation/assembler.ts'
import { toolDefinition } from '../../../../../../upstream/deepseek-harness/packages/client/ui-conversation/src/client/conversation-nodes/tool.ts'
import { turnTailDefinition } from '../../../../../../upstream/deepseek-harness/packages/client/ui-conversation/src/client/conversation-nodes/turn-tail.ts'
import { chatViewDefinition } from '../../../../../../upstream/deepseek-harness/packages/client/ui-conversation/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { unknownFallbackDefinition } from '../../../../../../upstream/deepseek-harness/packages/client/ui-conversation/src/client/conversation-nodes/fallback.ts'
import { ToolCallTree } from '../../../../../../upstream/deepseek-harness/packages/client/ui-tool/src/client/tool/ToolCallTree.tsx'
import { imageCallsDefinition, toolImagesDefinition, selectArtifactTerminal, terminalImageItems } from '../src/client/image-gallery.tsx'

afterEach(cleanup)

it('replays the actual QR result through native projection and native generic tool presentation', () => {
  const callId = 'call_8CRvix83c60z6ZHzBw5LLtEo|fc_045f7e1e457e0d83016aa02eee468c87d09529aa1b6a989f3e'
  const attachment = { attachmentId: 'sha256:e992029bf1614a2b2d44824175d07d6b51aaf6a23186b97279a48e3200098517', mediaType: 'image/png', bytes: 2882, width: 512, height: 512, name: 'e-Mate-qr.png' }
  const events = [
    { type: 'tool/call', seq: 2122, time: 1788882678428, data: { turn: 3, step: 2, callId, name: 'e_mate_qr_generate', arguments: '{"content":"EM218-QR-TEST-20260908"}' } },
    { type: 'tool/result', seq: 2124, time: 1788882678571, surfaceOp: 'append', data: { turn: 3, step: 2, message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: '二维码已生成。' }, { type: 'image', attachment }], isError: false }] } } },
    { type: 'turn/end', seq: 2198, time: 1788882719257, data: { turn: 3, reason: { kind: 'completed' } } },
  ]
  const start = { type: 'turn/start', seq: 2000, time: 1788882660000, data: { turn: 3 } }
  const assembler = new ConversationNodeAssembler({ entries: () => [toolDefinition, turnTailDefinition, imageCallsDefinition, toolImagesDefinition], fallbackEntry: () => unknownFallbackDefinition }, { entries: () => [chatViewDefinition] })
  assembler.replaceWindow([start, ...events].map(event => ({ event, view: undefined })), false)
  assembler.flush()
  const chat = assembler.snapshot('chat') as any
  const nodes = [...chat.nodes.values()]
  const tool = nodes.find(node => node.kind === 'tool-call' && node.data.root.call?.name === 'e_mate_qr_generate')
  expect(tool.data.root.content[1]).toMatchObject({ type: 'image', attachment: { width: 512, height: 512 } })
  const tail = nodes.find(node => node.kind === 'turn-tail')
  const matched = selectArtifactTerminal({ turn: tail.location.turn, nodes, seq: 2198, openFile: () => {} } as any)
  expect(matched).toMatchObject({ callIds: [callId] })
  expect(terminalImageItems(nodes, matched!.callIds, 3)).toMatchObject([{ callId, attachment, status: 'completed' }])
  const view = render(<ToolCallTree node={tool} t={key => key} openFile={() => {}} inspectCall={() => {}}
    renderSlot={(_key: string, _owner: unknown, options: any) => options.fallback} /> as any)
  expect(screen.queryByRole('img')).toBeNull()
  const disclosure = view.container.querySelector('[data-disclosure-row]')!
  expect(disclosure).not.toBeNull()
  fireEvent.click(disclosure)
  expect(view.container.textContent).toContain('sha256:e992029bf1614a2b2d44824175d07d6b51aaf6a23186b97279a48e3200098517')
  expect(screen.queryByRole('img')).toBeNull()
})
