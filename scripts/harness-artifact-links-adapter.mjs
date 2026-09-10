// Product local links use the pinned renderer's existing, receipt-derived
// file-mention vocabulary first; explicit local links use its native Host opener on click.
export const ARTIFACT_LINKS_ADAPTER_PATH = 'scripts/harness-artifact-links-adapter.mjs'
export const ARTIFACT_LINKS_PACKAGE = '@deepseek-ai/dsh-client-ui-primitives'

function replaceOnce(source, before, after, owner) {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(`Harness artifact-link adapter ${owner}: expected one rc.7 seam, found ${count}`)
  return source.replace(before, after)
}

// Embedded in the native renderer closure, with its original React/CSS owners.
function emateArtifactMention(url, context) {
  if (!context?.fileMentions || context.inLink === true || typeof url !== 'string' || url.length === 0 || url.length > 8192 || /[\u0000-\u001f\u007f]/u.test(url)) return undefined
  let path = url
  try {
    if (/^file:/iu.test(url)) {
      const file = new URL(url)
      if (file.protocol !== 'file:' || file.hostname && file.hostname !== 'localhost' || file.username || file.password || file.search || file.hash) return undefined
      path = file.pathname
      if (/^\/[A-Za-z]:\//u.test(path)) path = path.slice(1)
    } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(url) && !/^[A-Za-z]:[/\\]/u.test(url) || url.startsWith('//') || url.startsWith('\\\\') || /[?#]/u.test(url)) return undefined
    // Decode only the authored URI, never a sandbox prefix or a guessed basename.
    const exact = context.fileMentions.resolve(path)
    if (exact) return exact
    path = decodeURIComponent(normalizeUri(path))
    if (/[\u0000-\u001f\u007f]/u.test(path) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path) && !/^[A-Za-z]:[/\\]/u.test(path) || path.startsWith('//') || path.startsWith('\\\\')) return undefined
    return context.fileMentions.resolve(path) ?? context.fileMentions.resolveLink?.(path)
  } catch { return undefined }
}

export function adaptHarnessArtifactLinksSource(source) {
  const change = (before, after, owner) => { source = replaceOnce(source, before, after, owner) }
  change('function renderAnchor(url, children, key) {\n\treturn renderSafeLink(normalizeUri(url), children, key);\n}',
    `${emateArtifactMention.toString()}\nfunction renderAnchor(url, children, key, context) {\n\tconst mention = emateArtifactMention(url, context);\n\tif (mention) return jsx("button", { type: "button", className: MarkdownText_module_css_default.fileMention, style: { margin: 0, padding: 0, border: 0, background: "none", font: "inherit", color: "var(--dsw-alias-state-business-primary, LinkText)", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: "3px" }, title: mention.title, "aria-label": mention.label, onClick: mention.open, children }, key);\n\treturn renderSafeLink(normalizeUri(url), children, key);\n}`, 'renderer/anchor')
  change('case "link": return renderAnchor(node.url, renderChildren(node.children, {\n\t\t\t...context,\n\t\t\tinLink: true\n\t\t}), key);',
    'case "link": return renderAnchor(node.url, renderChildren(node.children, {\n\t\t\t...context,\n\t\t\tinLink: true\n\t\t}), key, context);', 'renderer/link')
  change('return renderAnchor(definition.url, renderChildren(node.children, {\n\t\t...context,\n\t\tinLink: true\n\t}), key);',
    'return renderAnchor(definition.url, renderChildren(node.children, {\n\t\t...context,\n\t\tinLink: true\n\t}), key, context);', 'renderer/reference')
  change('function renderImage(url, alt, key) {\n\tconst imageSrc',
    'function renderImage(url, alt, key, context) {\n\tconst mention = emateArtifactMention(url, context);\n\tif (mention) return jsx("button", { type: "button", className: MarkdownText_module_css_default.fileMention, style: { margin: 0, padding: 0, border: 0, background: "none", font: "inherit", color: "var(--dsw-alias-state-business-primary, LinkText)", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: "3px" }, title: mention.title, "aria-label": mention.label, onClick: mention.open, children: alt || mention.label }, key);\n\tconst imageSrc', 'renderer/image')
  change('case "image": return renderImage(node.url, node.alt ?? "", key);', 'case "image": return renderImage(node.url, node.alt ?? "", key, context);', 'renderer/image-node')
  change('return renderImage(definition.url, node.alt ?? "", key);', 'return renderImage(definition.url, node.alt ?? "", key, context);', 'renderer/image-reference')
  return source
}

// Vite aliases the platform library to this native SOURCE module. Adapting its
// emitted Node library alone cannot affect the browser's static module table.
export const ARTIFACT_LINKS_RENDERER_PATH = 'packages/client/ui-primitives/src/markdown/render.tsx'
export function adaptHarnessArtifactLinksRendererSource(source) {
  const change = (before, after, owner) => { source = replaceOnce(source, before, after, owner) }
  const button = `function emateArtifactButton(mention, children, key) {
  return createElement('button', { key, type: 'button', className: css.fileMention,
    style: { margin: 0, padding: 0, border: 0, background: 'none', font: 'inherit', color: 'var(--dsw-alias-state-business-primary, LinkText)', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: '3px' },
    title: mention.title, 'aria-label': mention.label, onClick: mention.open }, children)
}`
  change('function renderAnchor(url: string, children: ReactNode[], key: Key): ReactNode {\n  return renderSafeLink(normalizeUri(url), children, key)\n}',
    `${emateArtifactMention.toString()}\n${button}\nfunction renderAnchor(url: string, children: ReactNode[], key: Key, context: MarkdownRenderContext): ReactNode {\n  const mention = emateArtifactMention(url, context)\n  if (mention) return emateArtifactButton(mention, children, key)\n  return renderSafeLink(normalizeUri(url), children, key)\n}`, 'vite/anchor')
  change('return renderAnchor(node.url, renderChildren(node.children, { ...context, inLink: true }), key)',
    'return renderAnchor(node.url, renderChildren(node.children, { ...context, inLink: true }), key, context)', 'vite/link')
  change('return renderAnchor(definition.url, renderChildren(node.children, { ...context, inLink: true }), key)',
    'return renderAnchor(definition.url, renderChildren(node.children, { ...context, inLink: true }), key, context)', 'vite/reference')
  change('function renderImage(url: string, alt: string, key: Key): ReactNode {\n  const imageSrc',
    'function renderImage(url: string, alt: string, key: Key, context: MarkdownRenderContext): ReactNode {\n  const mention = emateArtifactMention(url, context)\n  if (mention) return emateArtifactButton(mention, alt || mention.label, key)\n  const imageSrc', 'vite/image')
  change("return renderImage(node.url, node.alt ?? '', key)", "return renderImage(node.url, node.alt ?? '', key, context)", 'vite/image-node')
  change("return renderImage(definition.url, node.alt ?? '', key)", "return renderImage(definition.url, node.alt ?? '', key, context)", 'vite/image-reference')
  return source
}

export function artifactLinksVitePlugin(rendererPath) {
  const target = rendererPath.replaceAll('\\', '/')
  let seen = false
  return {
    name: 'e-mate-native-artifact-links', apply: 'build', enforce: 'pre',
    buildStart() { seen = false },
    transform(source, id) {
      if (id.replaceAll('\\', '/') !== target) return null
      const code = adaptHarnessArtifactLinksRendererSource(source)
      seen = true
      return { code, map: null }
    },
    generateBundle() {
      if (!seen) throw Error('Native Markdown renderer was not consumed by Vite; artifact-link adaptation is missing')
    },
  }
}

export const ARTIFACT_DELIVERABLES_PACKAGE = '@deepseek-ai/dsh-client-ui-deliverables'

// Extend the native Turn accumulator with persisted, successful Office receipts.
// A read proves existence, not creation: it joins the file vocabulary only when
// the latest assistant prose explicitly names that exact verified path.
function emateOfficeDeliverables(native, isAppend) {
  const valid = (value, operation) => {
    if (!value || value.operation !== operation || !['docx', 'xlsx', 'pptx', 'pdf', ...(operation === 'write' ? ['png'] : [])].includes(value.format)
      || typeof value.job_id !== 'string' || !value.job_id.startsWith('emate-office-')
      || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 32 * 1024 * 1024) return undefined
    const path = value.relative_path
    if (typeof path !== 'string' || path.length > 8192 || path !== path.trim() || path !== path.normalize('NFC')
      || /[\\:%?#\u0000-\u001f\u007f]/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')
      || !path.toLowerCase().endsWith('.' + value.format)) return undefined
    return path
  }
  const references = (message, candidates) => {
    const text = (message?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
    if (text.length > 512 * 1024) return []
    const prose = text.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)/gu, '$1')
    const tokens = new Set([...prose.matchAll(/`([^`\n]+)`/gu)].map(match => match[1]))
    for (const match of prose.matchAll(/\]\(([^\s)]+)\)/gu)) { try { tokens.add(decodeURIComponent(match[1])) } catch {} }
    return candidates.filter(item => tokens.has(item.path))
  }
  return {
    ...native,
    match(event) {
      if (event.type === 'assistant/message' && isAppend(event)) return { id: String(event.data.turn), role: 'update' }
      return native.match(event)
    },
    start(context, match) { return { ...native.start(context, match), officeCalls: new Map(), officeReads: [], officeFinal: [] } },
    update(context, match) {
      const { event } = match
      const state = context.state
      if (event.type === 'assistant/message') return { ...state, officeFinal: references(event.data.message, [...state.officeReads, ...state.produced]) }
      if (event.type === 'tool/call') {
        const next = native.update(context, match)
        const officeCalls = new Map(state.officeCalls)
        if (event.data.name === 'office_read' || event.data.name === 'office_write') officeCalls.set(String(event.data.callId), event.data.name)
        return { ...next, officeCalls }
      }
      if (event.type === 'tool/result') {
        const tool = state.officeCalls.get(String(event.data.message.source.callId))
        if (tool) {
          const result = event.data.message.content[0]
          if (result?.type !== 'tool-result' || result.isError !== false) return state
          const operation = tool === 'office_write' ? 'write' : 'read'
          const path = valid(event.data.meta, operation)
          if (!path) return state
          const item = { seq: event.seq, path }
          return operation === 'write' ? { ...state, produced: [...state.produced, item] }
            : { ...state, officeReads: [...state.officeReads, item] }
        }
      }
      return native.update(context, match)
    },
    buildLocationData(context, scope) {
      const result = native.buildLocationData(context, scope)
      if (!result || !context.state) return result
      const selected = context.state.officeFinal ?? []
      const preferred = new Set(selected.map(item => item.path))
      return { ...result, value: { ...result.value, produced: [...selected, ...result.value.produced.filter(item => !preferred.has(item.path))] } }
    },
  }
}

export function adaptHarnessArtifactDeliverablesSource(source) {
  source = replaceOnce(source, 'function selectProducedFiles(owner) {\n\t\t\tconst paths = producedForClosing(owner.turn.data.get("deliverables"), owner.seq);',
    `${emateUniverProduced.toString()}\nfunction selectProducedFiles(owner, sessions) {\n\t\t\tconst paths = producedForClosing({ produced: [...(owner.turn.data.get("deliverables")?.produced ?? []), ...emateUniverProduced(owner, sessions)] }, owner.seq);`, 'deliverables/native-results')
  source = replaceOnce(source, 'select: selectProducedFiles,', 'select: (owner) => selectProducedFiles(owner, ctx.get("sessions")),', 'deliverables/tail-selector')
  source = replaceOnce(source, 'const paths = selectProducedFiles(owner);', 'const paths = selectProducedFiles(owner, ctx.get("sessions"));', 'deliverables/mention-selector')
  source = replaceOnce(source, '\t\t\t"connection"\n\t\t];', '\t\t\t"connection",\n\t\t\t"sessions"\n\t\t];', 'deliverables/session-owner')
  source = replaceOnce(source, 'const deliverablesDefinition = {', `${emateOfficeDeliverables.toString()}\nconst deliverablesDefinition = emateOfficeDeliverables({`, 'deliverables/library-definition')
  return replaceOnce(source, '\t\t\t\tvalue: { produced: context.state.produced }\n\t\t\t}\n\t\t};', '\t\t\t\tvalue: { produced: context.state.produced }\n\t\t\t}\n\t\t}, _deepseek_ai_dsh_client_runtime_client.isAppendSurfaceEvent);', 'deliverables/library-close')
}

// Read the native turn's Tool tree, including Code subcalls. No separate event
// accumulator: root association, replay and interruption remain native-owned.
function emateUniverProduced(owner, sessions) {
  let nodes = owner.nodes
  if (!nodes) {
    const current = sessions?.list.getSnapshot().current
    const snapshot = current === undefined ? undefined : sessions.binding(current)?.session.getSnapshot()
    if (snapshot?.sessionId !== current || snapshot?.openState !== 'open'
      || snapshot.chat.timeline.turns.get(owner.turn.turn) !== owner.turn) return []
    nodes = snapshot.chat.locations.getTurn(owner.turn.turn).map(key => snapshot.chat.nodes.get(key))
  }
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const path = value => typeof value === 'string' && value.length > 1 && value.length <= 8192
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)
    && (value.startsWith('/') && !value.startsWith('//') || /^[A-Za-z]:[/\\]/u.test(value))
    && !value.split(/[/\\]/u).some(part => part === '.' || part === '..')
  const operations = { univer_new: 'new', univer_execute: 'execute', univer_export: 'export',
    univer_print_pdf: 'print-pdf', univer_screenshot: 'screenshot', univer_resources: 'resources' }
  const produced = []
  const visit = root => {
    for (const child of root.subCalls ?? []) visit(child)
    const operation = Object.hasOwn(operations, root.call?.name) ? operations[root.call.name] : undefined
    if (!operation || root.kind !== 'tool-result' || root.isError !== false || !Number.isSafeInteger(root.seq)) return
    const texts = (root.content ?? []).filter(block => block.type === 'text')
    if (texts.length !== 1) return
    let value
    try { value = JSON.parse(texts[0].text) } catch { return }
    if (!object(value) || value.ok !== true || value.operation !== operation || !object(value.result)
      || operation !== 'resources' && !path(value.file)) return
    const result = value.result
    let paths = []
    if (operation === 'new' && result.created === true && result.filePath === value.file
      || operation === 'execute' && result.committed === true && result.filePath === value.file) paths = [result.filePath]
    if (operation === 'export' && result.filePath === value.file && ['sheet', 'doc', 'slide', 'base', 'board'].includes(result.kind)) paths = [result.outputPath]
    if (operation === 'print-pdf' && Number.isSafeInteger(result.pageCount) && result.pageCount > 0) paths = [result.output]
    if (operation === 'screenshot' && Array.isArray(result.images)) paths = result.images.filter(item => object(item)
      && item.mediaType === 'image/png' && object(item.image) && item.image.mediaType === 'image/png'
      && /^sha256:[a-f0-9]{64}$/u.test(item.image.attachmentId)).map(item => item.path)
    if (operation === 'resources' && Array.isArray(result.exported)) paths = result.exported.filter(object).map(item => item.path)
    for (const output of paths) if (path(output)) produced.push({ seq: root.seq, path: output })
  }
  for (const node of nodes) if (node?.kind === 'tool-call' && node.data?.root
    && (node.location.kind === 'turn' || node.location.kind === 'step') && node.location.turn === owner.turn) visit(node.data.root)
  return produced.sort((left, right) => left.seq - right.seq)
}
