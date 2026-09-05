import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

type State = 'not-connected' | 'connected' | 'expired' | 'failed'
type Stream = AsyncIterable<Uint8Array | string>
interface Handle { stdout: Stream; stderr: Stream; done: Promise<{ exitCode: number | null }>; cancel(): void }
interface Runner { run(args: readonly string[], signal?: AbortSignal): Handle }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Only structured, verified CLI identity state may project a working connection. */
export function feishuConnectionState(value: unknown): State {
  if (!record(value) || value.ok === false) return 'failed'
  const data = value.ok === true && record(value.data) ? value.data : value
  if (!record(data.identities)) return data.status === 'not_configured' ? 'not-connected' : 'failed'
  const user = data.identities.user
  if (!record(user)) return 'not-connected'
  if (user.available === true && (user.verified === true || data.verified === true && data.identity === 'user')) return 'connected'
  if (['expired', 'revoked', 'invalid', 'missing'].includes(String(user.tokenStatus))
    || ['expired', 'revoked', 'not_authorized'].includes(String(user.status))) return 'expired'
  if (user.status === 'not_configured' || user.status === 'not_logged_in') return 'not-connected'
  return 'failed'
}

async function collect(stream: Stream, handle: Handle): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of stream) {
    const bytes = Buffer.from(value)
    size += bytes.byteLength
    if (size > 64 * 1024) { handle.cancel(); throw new Error('status output limit') }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** No installation, login or secret/config read; the packaged native CLI owns verification. */
export async function readFeishuConnection(runner: Runner | undefined, signal?: AbortSignal, profileDir = join(homedir(), '.lark-cli')): Promise<{ state: State }> {
  try { if (!(await stat(profileDir)).isDirectory()) return { state: 'failed' } }
  catch (error) { return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-connected' : 'failed' } }
  if (runner === undefined) return { state: 'failed' }
  const bounded = AbortSignal.any([AbortSignal.timeout(12_000), ...(signal ? [signal] : [])])
  let handle: Handle | undefined
  try {
    handle = runner.run(['--config.offline=true', 'dlx', '@larksuite/cli@1.0.88', 'auth', 'status', '--json', '--verify'], bounded)
    const [outcome, stdout] = await Promise.all([handle.done, collect(handle.stdout, handle), collect(handle.stderr, handle)])
    if (outcome.exitCode !== 0) return { state: 'failed' }
    return { state: feishuConnectionState(JSON.parse(stdout)) }
  } catch { handle?.cancel(); return { state: 'failed' } }
}
