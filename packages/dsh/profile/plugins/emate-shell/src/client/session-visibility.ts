import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'

/** Collect Sessions owned by the native Subagent tree, including partial list projections. */
export function collectInternalSubagentIds(state: SessionListState): ReadonlySet<string> {
  const internal = new Set<string>()

  for (const row of Object.values(state.byId)) {
    // Ordinary user forks also carry parentId; only native subagent evidence hides a task.
    if (row.origin === 'subagent') internal.add(row.id)
  }
  for (const catalog of Object.values(state.subagentsByParent)) {
    for (const entry of catalog.entries) {
      if (entry.kind === 'child') internal.add(entry.id)
    }
  }
  if (state.currentAddress !== undefined) internal.add(state.currentAddress.childSessionId)

  return internal
}

/** Product navigation contains user tasks, never native internal child Sessions. */
export function isTopLevelProductSession(
  row: SessionSummary,
  internalIds: ReadonlySet<string>,
): boolean {
  return !internalIds.has(row.id)
}

/** Keep the owning task highlighted while a child transcript is selected. */
export function highlightedProductSessionId(state: SessionListState): string | undefined {
  return state.currentAddress !== undefined && state.currentAddress.childSessionId === state.current
    ? state.currentAddress.parentSessionId
    : state.current
}
