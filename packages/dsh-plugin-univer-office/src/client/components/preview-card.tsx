import * as React from 'react'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  outcomeOfTurnFile,
  resolveTurnFiles,
  type UniverTurnFile,
  type UniverTurnMatch
} from '../conversation/univer-turn-definition.ts'
import { useUniverStates } from '../hooks/use-univer-state.ts'
import type { ViewerLocaleInjected } from '../viewer-locale.ts'
import { ReviewPanel } from './review-panel.tsx'

interface PreviewCardShared extends PropsLocale<'univer'>, ViewerLocaleInjected {
  readonly matched: UniverTurnMatch
}

export type PreviewCardProps = PropsRuntime<'conversation.chat.turnTail'> & PreviewCardShared

/** Read rc.7's combined Session and remount the view at the authorization boundary. */
export function PreviewCard(props: PreviewCardProps): React.ReactElement {
  const chat = props.useSession((snapshot) => snapshot.chat)
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
  props: PreviewCardShared & {
    readonly sessionId: SessionId
    readonly chat: ChatSnapshot
    readonly cwd: string | undefined
  }
): React.ReactElement {
  const files = React.useMemo(
    () => resolveTurnFiles(props.matched.files, props.cwd),
    [props.matched.files, props.cwd]
  )
  const { states, missingFiles } = useUniverStates(
    files.map((entry) => entry.file),
    props.sessionId
  )
  const latestTurns = React.useMemo(
    () => latestWorktreeTurns(props.chat, props.cwd),
    [props.chat, props.cwd]
  )
  return (
    <>
      {files.map((target) => {
        // Bash or another tool may remove a temporary file after its structured Univer operations.
        // The Host's current workspace state is authoritative, so no historical shell is rendered.
        if (missingFiles.has(target.file)) return null
        const outcome = outcomeOfTurnFile(target)
        const worktreeId = outcome.primaryWorktreeId ?? pendingWorktree(target)
        const historical =
          worktreeId !== null &&
          latestTurns.get(JSON.stringify([target.file, worktreeId])) !== props.matched.turn
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
