import { ALLOWED_MEDIA_BY_EXTENSION, MAX_FILE_BYTES, normalizedSafeFileName } from '../packages/dsh-plugin-file-import/src/contract.ts'

export const SESSION_EXPORT_PACKAGE = '@deepseek-ai/dsh-host-apiproxy'
export const SESSION_EXPORT_ADAPTER_PATH = 'scripts/harness-session-export-adapter.mjs'

const MEDIA_TYPE_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

export function emateExportMediaPath(ref) {
  const id = ref.attachmentId
  let name
  if (typeof id === 'string' && /^sha256:[a-f0-9]{64}$/u.test(id)) name = id.replace(':', '-')
  else {
    // Reserve the canonical digest mapping, rather than replacing arbitrary
    // punctuation and making distinct opaque attachment identities collide.
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)
      || normalizedSafeFileName(id) !== id || /^sha256-[a-f0-9]{64}$/u.test(id)) {
      throw new Error('Unsafe session archive attachment identity')
    }
    name = id
  }
  if (!Object.hasOwn(MEDIA_TYPE_EXTENSIONS, ref.mediaType)) throw new Error('Unsupported session archive image type')
  return `media/${name}.${MEDIA_TYPE_EXTENSIONS[ref.mediaType]}`
}

// These helpers become part of the pinned native ZIP entry producer. They do
// not own another ZIP writer, event store, attachment route or serializer.
export function emateExportContent(content) {
  const kept = []
  for (const line of content.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    if (line.trim() === '') { kept.push(line); continue }
    let event
    try { event = JSON.parse(line) } catch { throw new Error('Session archive contains an unreadable event') }
    // Draft persistence is for local restart recovery, never public sharing.
    // Remove its entire line, including names/IDs, without rewriting any other
    // serialized event or touching the durable session artifact.
    if (event?.type !== 'emate/image-draft-staged') kept.push(line)
  }
  return kept.join('')
}

export function emateExportFileRefs(content) {
  const files = new Map()
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue
    const event = JSON.parse(line)
    const messages = event?.type === 'user/message' ? [event.data]
      : event?.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted) ? event.data.inserted : []
    for (const message of messages) {
      if (message?.role !== 'user' || message.source?.kind !== 'user' || !Array.isArray(message.source.mentions)) continue
      for (const mention of message.source.mentions) {
        if (mention?.source !== 'e-mate/file-import') continue
        let file
        try { file = JSON.parse(mention.ref) } catch { throw new Error('Invalid imported archive reference') }
        if (!file || Object.keys(file).sort().join(',') !== 'display_name,media_type,relative_path,stored_name'
          || normalizedSafeFileName(file.stored_name) !== file.stored_name || /[@\s]/u.test(file.stored_name)
          || normalizedSafeFileName(file.display_name) !== file.display_name
          || file.relative_path !== `.e-mate/imports/${file.stored_name}`
          || typeof file.media_type !== 'string'
          || ALLOWED_MEDIA_BY_EXTENSION[file.display_name.slice(file.display_name.lastIndexOf('.') + 1).toLowerCase()] !== file.media_type
          || ALLOWED_MEDIA_BY_EXTENSION[file.stored_name.slice(file.stored_name.lastIndexOf('.') + 1).toLowerCase()] !== file.media_type) {
          throw new Error('Invalid imported archive reference')
        }
        // The structured identity must actually belong to this submitted text.
        const submitted = (message.content ?? []).some(block => block?.type === 'text' && typeof block.text === 'string'
          && block.text.split(/\s+/u).includes(`@${file.relative_path}`))
        if (!submitted) throw new Error('Imported archive reference is not submitted')
        const previous = files.get(file.relative_path)
        if (previous && (previous.media_type !== file.media_type || previous.stored_name !== file.stored_name)) throw new Error('Conflicting imported archive reference')
        files.set(file.relative_path, file)
      }
    }
  }
  return [...files.values()]
}

export async function* emateExportFiles(deps, content, sessionId, archivePrefix, signal) {
  const refs = emateExportFileRefs(content)
  if (refs.length === 0) return
  const fs = deps.emateExportFs
  const owners = deps.emateExportWorkspaces?.list().filter(workspace => workspace.sessionIds.includes(sessionId)) ?? []
  if (!fs || owners.length !== 1) throw new Error('Session archive file workspace is unavailable')
  const cwd = owners[0].path
  const root = await fs.resolve(cwd, { signal })
  for (const file of refs) {
    signal?.throwIfAborted()
    // Native lstat/resolve/contains retain backend identity and reject links at
    // every managed path component; never interpret opaque targetKey as a path.
    const observe = async () => {
      const paths = ['.e-mate', '.e-mate/imports', file.relative_path]
      const observed = []
      for (const [index, path] of paths.entries()) {
        const entry = await fs.lstat(path, { cwd }, signal)
        if (!entry || entry.type !== (index === 2 ? 'file' : 'directory')) throw new Error('Session archive file is missing or unsafe')
        const target = await fs.resolve(path, { cwd, signal })
        if (!fs.contains(root, target)) throw new Error('Session archive file escaped its workspace')
        const info = await fs.stat(target, signal)
        if (!info || info.type !== entry.type) throw new Error('Session archive file identity changed')
        observed.push({ target, entry, info })
      }
      if (!fs.contains(observed[1].target, observed[2].target)) throw new Error('Session archive file escaped its import directory')
      return observed
    }
    const before = await observe()
    const source = before[2]
    if (!Number.isSafeInteger(source.info.size) || source.info.size < 0 || source.info.size > MAX_FILE_BYTES) throw new Error('Session archive file size is unavailable or too large')
    const data = await fs.readBytes(source.target, signal, MAX_FILE_BYTES)
    const after = await observe()
    if (data.byteLength !== source.info.size || before.some((value, index) => value.target.targetKey !== after[index].target.targetKey
      || value.entry.version !== after[index].entry.version || value.info.version !== after[index].info.version)) {
      throw new Error('Session archive file changed while reading')
    }
    signal?.throwIfAborted()
    // Preserve the logged identity while keeping extracted files visible in
    // Finder; native media uses the same identity-to-entry convention.
    yield { path: `${archivePrefix}files/${file.stored_name}`, data }
  }
}

export function adaptHarnessSessionExportSource(source) {
  const change = (before, after, name) => {
    const count = source.split(before).length - 1
    if (count !== 1) throw new Error(`Harness export adapter expected one rc.7 ${name} seam, found ${count}`)
    source = source.replace(before, after)
  }
  change('function sessionLogExportDeps(ctx) {', `const ALLOWED_MEDIA_BY_EXTENSION = ${JSON.stringify(ALLOWED_MEDIA_BY_EXTENSION)};\nconst MAX_FILE_BYTES = ${MAX_FILE_BYTES};\n${normalizedSafeFileName.toString()}\n${emateExportContent.toString()}\n${emateExportFileRefs.toString()}\n${emateExportFiles.toString()}\nfunction sessionLogExportDeps(ctx) {`, 'helpers')
  change('function mediaEntryPath(ref) {\n\treturn `media/${String(ref.attachmentId)}.${MEDIA_TYPE_EXTENSIONS[ref.mediaType]}`;\n}', emateExportMediaPath.toString().replace('function emateExportMediaPath', 'function mediaEntryPath'), 'media-name')
  change('\t\tattachments: ctx.get("attachments"),\n\t\tsessions: ctx.get("sessions")', '\t\tattachments: ctx.get("attachments"),\n\t\temateExportFs: ctx.get("fs"),\n\t\temateExportWorkspaces: ctx.get("workspaceRegistry"),\n\t\tsessions: ctx.get("sessions")', 'dependencies')
  change('\t\t\t\tsessions: deps.sessions\n', '\t\t\t\tsessions: deps.sessions,\n\t\t\t\temateExportFs: deps.emateExportFs,\n\t\t\t\temateExportWorkspaces: deps.emateExportWorkspaces\n', 'ready-services')
  change('\trememberMedia(root.content);\n\tyield {\n\t\tpath: root.filename,\n\t\tcontent: root.content\n\t};', '\tconst rootContent = emateExportContent(root.content);\n\trememberMedia(rootContent);\n\tyield {\n\t\tpath: root.filename,\n\t\tcontent: rootContent\n\t};\n\tyield* emateExportFiles(deps, rootContent, sessionId, "", signal);', 'root')
  change('\t\t\t\trememberMedia(raw.content);\n\t\t\t\tyield {\n\t\t\t\t\tpath: `subagents/${safeSessionIdSegment(id)}/${raw.filename}`,\n\t\t\t\t\tcontent: raw.content\n\t\t\t\t};', '\t\t\t\tconst childContent = emateExportContent(raw.content);\n\t\t\t\trememberMedia(childContent);\n\t\t\t\tyield {\n\t\t\t\t\tpath: `subagents/${safeSessionIdSegment(id)}/${raw.filename}`,\n\t\t\t\t\tcontent: childContent\n\t\t\t\t};\n\t\t\t\tyield* emateExportFiles(deps, childContent, id, `subagents/${safeSessionIdSegment(id)}/`, signal);', 'descendants')
  return source
}
