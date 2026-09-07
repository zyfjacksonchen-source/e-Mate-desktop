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
