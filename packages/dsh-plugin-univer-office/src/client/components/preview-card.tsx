import * as React from 'react'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  filesOfNodes,
  outcomeOfTurnFile,
  resolveTurnFiles,
  type UniverTurnFile,
  type UniverTurnMatch
} from '../conversation/univer-turn-definition.ts'
import { useUniverStates } from '../hooks/use-univer-state.ts'
import type { ViewerLocaleInjected } from '../viewer-locale.ts'
import { ReviewPanel } from './review-panel.tsx'

interface PreviewCardShared extends PropsLocale<'univer'>, ViewerLocaleInjected {}

export type PreviewCardProps = PropsRuntime<'conversation.chat.turnTail'> & PreviewCardShared

/** Read the assembled Chat target and remount the card at the authorization boundary. */
export function PreviewCard(props: PreviewCardProps): React.ReactElement | null {
  const chat = props.useChat((snapshot) => snapshot)
  const cwd = props.useSessions((state) => state.byId[props.sessionId]?.cwd)
  return (
    <PreviewCardContent
      key={JSON.stringify([props.sessionId, cwd])}
      {...props}
      chat={chat}
      cwd={cwd}
    />
  )
}

/** Render one unified Univer card for every file touched during the owning Turn. */
function PreviewCardContent(
  props: PreviewCardProps & {
    readonly chat: ChatSnapshot
    readonly cwd: string | undefined
  }
): React.ReactElement | null {
  const turn = props.turn.turn
  const files = React.useMemo(
    () => resolveTurnFiles(filesOfNodes(props.chat.nodes.values(), turn), props.cwd),
    [props.chat, turn, props.cwd]
  )
  const { states, missingFiles } = useUniverStates(
    files.map((entry) => entry.file),
    props.sessionId
  )
  const latestTurns = React.useMemo(
    () => latestWorktreeTurns(props.chat, props.cwd),
    [props.chat, props.cwd]
  )
  if (files.length === 0) return null
  return (
    <>
      {files.map((target) => {
        // Bash or another tool may remove a temporary file after its structured Univer operations.
        // The Host's current workspace state is authoritative, so no historical shell is rendered.
        if (missingFiles.has(target.file)) return null
        const outcome = outcomeOfTurnFile(target)
        const worktreeId = outcome.primaryWorktreeId ?? pendingWorktree(target)
        const historical =
          worktreeId !== null && latestTurns.get(JSON.stringify([target.file, worktreeId])) !== turn
        return (
          <ReviewPanel
            key={target.file}
            file={target.file}
            state={states[target.file]}
            worktreeId={worktreeId}
            preferredUnitId={outcome.preferredUnitId}
            historical={historical}
            t={props.t}
            viewerLocale={props.getViewerLocale()}
          />
        )
      })}
    </>
  )
}

function pendingWorktree(target: UniverTurnFile): string | null {
  for (let index = target.operations.length - 1; index >= 0; index -= 1) {
    const operation = target.operations[index]
    if (operation !== undefined && operation.worktreeId !== null) return operation.worktreeId
  }
  return null
}

function latestWorktreeTurns(chat: ChatSnapshot, cwd?: string): Map<string, number> {
  const latest = new Map<string, number>()
  for (const node of chat.nodes.values()) {
    if (node.kind !== 'univerTurn') continue
    const data = node.data as UniverTurnMatch
    for (const file of resolveTurnFiles(data.files, cwd)) {
      for (const operation of file.operations) {
        if (operation.worktreeId === null) continue
        const key = JSON.stringify([file.file, operation.worktreeId])
        latest.set(key, Math.max(data.turn, latest.get(key) ?? data.turn))
      }
    }
  }
  return latest
}
