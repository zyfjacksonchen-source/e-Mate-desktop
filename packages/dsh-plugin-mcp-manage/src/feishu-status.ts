import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
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
export async function readFeishuConnection(runner: Runner | undefined, signal?: AbortSignal, profileDir: string | URL = join(homedir(), '.lark-cli'), cliManifest = () => {
  const pnpm = process.env.EMATE_DESKTOP_PNPM_ENTRY
  // Desktop already publishes this packaged-runtime anchor; Windows materializes
  // plugin files outside the app, so resolving relative to the plugin is insufficient.
  return pnpm === undefined ? createRequire(import.meta.url).resolve('@larksuite/cli/package.json')
    : join(dirname(dirname(dirname(pnpm))), '@larksuite/cli/package.json')
}): Promise<{ state: State }> {
  try { if (!(await stat(profileDir)).isDirectory()) return { state: 'failed' } }
  catch (error) { return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-connected' : 'failed' } }
  if (runner === undefined) return { state: 'failed' }
  const bounded = AbortSignal.any([AbortSignal.timeout(12_000), ...(signal ? [signal] : [])])
  let handle: Handle | undefined
  try {
    const manifestPath = cliManifest()
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.name !== '@larksuite/cli' || manifest.version !== '1.0.88') return { state: 'failed' }
    const executable = join(dirname(manifestPath), 'bin', process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli')
    if (!(await stat(executable)).isFile()) return { state: 'failed' }
    // Execute only the installed binary: official run.js can auto-download a missing binary.
    handle = runner.run(['exec', '--', executable, 'auth', 'status', '--json', '--verify'], bounded)
    const [outcome, stdout] = await Promise.all([handle.done, collect(handle.stdout, handle), collect(handle.stderr, handle)])
    if (outcome.exitCode !== 0) return { state: 'failed' }
    return { state: feishuConnectionState(JSON.parse(stdout)) }
  } catch { handle?.cancel(); return { state: 'failed' } }
}
