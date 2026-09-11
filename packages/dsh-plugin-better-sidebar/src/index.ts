import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const name = 'emate-better-sidebar'
export const inject = [
  'webServer','connection', 'workspaceRegistry']
export const CHANNEL = '/emate.betterSidebar'

const MAX_FILE_BYTES = 512 * 1024
const MAX_ENTRIES = 500

type Workspace = { path: string; sessionIds: readonly string[] }

function badRequest(message: string) {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function unavailable(message: string) {
  return { ok: false, error: { code: 'unavailable', message, details: {} } }
}

function relativeParts(value: unknown): string[] | null {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\\') || value.includes('\0')) return null
  if (value === '') return []
  const parts = value.split('/')
  return parts.some(part => part === '' || part === '.' || part === '..') ? null : parts
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function projectRoot(ctx: any, sessionId: unknown): Promise<{ kind: 'general' | 'project'; root: string } | null> {
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 256) return null
  if (ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)) return null
  const workspace = (ctx.workspaceRegistry.list() as Workspace[])
    .find(candidate => candidate.sessionIds.includes(sessionId))
  if (workspace === undefined) return null
  const root = await realpath(workspace.path)
  const dshHome = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  return { kind: resolve(root) === resolve(dshHome, 'e-mate', 'general') ? 'general' : 'project', root }
}

async function resolvedChild(root: string, parts: string[]): Promise<string | null> {
  try {
    const candidate = await realpath(resolve(root, ...parts))
    return inside(root, candidate) ? candidate : null
  } catch {
    return null
  }
}

export function apply(ctx: any): void {
  // 0.1.5 registers a Host RPC channel as (channel, handler): the removed
  // per-channel `authority` option is now the transport's trust decision
  // (a trusted API request), so passing one would claim a policy nothing reads.
  ctx.effect(() => ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint: string, payload: unknown) => {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return badRequest('payload must be an object')
      const body = payload as Record<string, unknown>
      const expected = endpoint === 'list' || endpoint === 'read' ? 'path,session_id' : ''
      if (Object.keys(body).sort().join(',') !== expected) return badRequest('invalid better-sidebar payload')
      const parts = relativeParts(body.path)
      const project = await projectRoot(ctx, body.session_id)
      if (parts === null || project === null) return badRequest('unknown session or invalid project path')
      if (project.kind === 'general') {
        return { ok: true, value: { schema_version: 1, kind: 'general', path: '', entries: [] } }
      }
      const target = await resolvedChild(project.root, parts)
      if (target === null) return badRequest('project path is unavailable')

      try {
        if (endpoint === 'list') {
          if (!(await stat(target)).isDirectory()) return badRequest('project path is not a directory')
          const all = (await readdir(target, { withFileTypes: true }))
            .filter(entry => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
            .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
          const entries = all.slice(0, MAX_ENTRIES).map(entry => ({
            name: entry.name,
            kind: entry.isDirectory() ? 'directory' : 'file',
          }))
          return {
            ok: true,
            value: {
              schema_version: 1,
              kind: 'project',
              path: parts.join('/'),
              entries,
              truncated: all.length > entries.length,
            },
          }
        }
        if (endpoint === 'read') {
          const info = await stat(target)
          if (!info.isFile() || info.size > MAX_FILE_BYTES) return badRequest('file is not a readable text file')
          const bytes = await readFile(target)
          const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          return {
            ok: true,
            value: { schema_version: 1, kind: 'file', path: parts.join('/'), content },
          }
        }
        return badRequest('unknown better-sidebar endpoint')
      } catch {
        return unavailable('项目文件暂不可读取。')
      }
    },
  ), 'emate.betterSidebar: target-native RPC channel')
}
