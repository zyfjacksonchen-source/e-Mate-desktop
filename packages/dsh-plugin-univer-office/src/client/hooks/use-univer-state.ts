import * as React from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FileState } from '../../shared/wire/state.ts'
import {
  getFileState,
  getUniverStatus,
  isMissingUniverFile,
  startGateway
} from '../api/univer-api.ts'

/** Poll collaboration state for a stable list of files. */
export function useUniverStates(
  files: readonly string[],
  sessionId: SessionId,
  intervalMs = 900
): {
  readonly states: Readonly<Record<string, FileState>>
  readonly missingFiles: ReadonlySet<string>
} {
  const [states, setStates] = React.useState<Record<string, FileState>>({})
  const [missing, setMissing] = React.useState<Record<string, true>>({})
  const key = files.join('\u0000')
  React.useEffect(() => {
    if (key === '') {
      setStates({})
      setMissing({})
      return
    }
    const trackedFiles = key.split('\u0000')
    setStates({})
    setMissing({})
    let active = true
    let inFlight = false
    let controller: AbortController | undefined
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      if (!active || inFlight || !pageIsVisible()) return
      inFlight = true
      controller = new AbortController()
      const signal = controller.signal
      for (const file of trackedFiles) {
        try {
          const state = await getFileState(file, sessionId, signal)
          if (!active || signal.aborted) break
          setStates((previous) => ({ ...previous, [file]: state }))
          setMissing((previous) => {
            if (previous[file] === undefined) return previous
            const next = { ...previous }
            delete next[file]
            return next
          })
        } catch (error) {
          if (!active || signal.aborted) break
          if (isMissingUniverFile(error)) {
            setStates((previous) => {
              if (previous[file] === undefined) return previous
              const next = { ...previous }
              delete next[file]
              return next
            })
            setMissing((previous) =>
              previous[file] === true ? previous : { ...previous, [file]: true }
            )
          }
        }
      }
      inFlight = false
      if (active && pageIsVisible()) timer = window.setTimeout(() => void poll(), intervalMs)
    }
    void poll()
    const onVisibility = (): void => {
      window.clearTimeout(timer)
      if (!pageIsVisible()) controller?.abort()
      else void poll()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      active = false
      controller?.abort()
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [key, sessionId, intervalMs])
  return {
    states,
    missingFiles: React.useMemo(() => new Set(Object.keys(missing)), [missing])
  }
}

function pageIsVisible(): boolean {
  return document.visibilityState !== 'hidden'
}

/** Gateway state and start action used by preview surfaces. */
export function useGatewayStatus(): {
  readonly phase: 'checking' | 'stopped' | 'starting' | 'running' | 'failed'
  readonly start: () => Promise<void>
} {
  const [phase, setPhase] = React.useState<
    'checking' | 'stopped' | 'starting' | 'running' | 'failed'
  >('checking')
  React.useEffect(() => {
    let active = true
    void getUniverStatus()
      .then((status) => {
        if (active) setPhase(status.gateway.phase)
      })
      .catch(() => {
        if (active) setPhase('failed')
      })
    return () => {
      active = false
    }
  }, [])
  const start = React.useCallback(async () => {
    setPhase('starting')
    try {
      const result = await startGateway()
      setPhase(result.ok ? 'running' : 'failed')
    } catch {
      setPhase('failed')
    }
  }, [])
  return { phase, start }
}
