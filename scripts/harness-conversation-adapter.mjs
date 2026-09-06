// Product-only additions to pinned conversation owners. Never edit upstream
// packages: assemblers apply these transforms to their copied client bundles.
export const CONVERSATION_ADAPTER_PATH = 'scripts/harness-conversation-adapter.mjs'
export const CONVERSATION_PACKAGE = '@deepseek-ai/dsh-client-ui-conversation'
export const NAVIGATION_PACKAGE = '@kelearns/dsh-navigation-bar'

function replaceOnce(source, before, after, owner, version = 'rc.7') {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(`Harness conversation adapter ${owner}: expected one ${version} seam, found ${count}`)
  return source.replace(before, after)
}

// This function is embedded unchanged into the native client closure. It is the
// persistence/public-facade boundary; imported-file RPC validation stays upstream.
function emateDraftFiles(value) {
  if (!Array.isArray(value) || value.length > 64) throw new Error('附件草稿无效。')
  const seen = new Set()
  return value.map(file => {
    if (file === null || typeof file !== 'object'
      || typeof file.stored_name !== 'string' || file.stored_name.length === 0
      || file.stored_name.startsWith('.') || /[\s@<>:"/\\|?*\u0000-\u001f]/u.test(file.stored_name)
      || /[. ]$/u.test(file.stored_name)
      || file.relative_path !== '.e-mate/imports/' + file.stored_name
      || typeof file.display_name !== 'string' || file.display_name.length === 0
      || /[<>:"/\\|?*\u0000-\u001f]/u.test(file.display_name)
      || typeof file.media_type !== 'string' || file.media_type.length === 0
      || seen.has(file.relative_path)) throw new Error('附件草稿无效。')
    seen.add(file.relative_path)
    return Object.freeze({
      stored_name: file.stored_name, relative_path: file.relative_path,
      display_name: file.display_name, media_type: file.media_type,
    })
  })
}

// Pending steering, the native queue editor and navigation share this projection.
function emateDraftImages(value) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('图片草稿无效。')
  const keys = new Set()
  let total = 0
  return value.map(item => {
    if (item === null || typeof item !== 'object'
      || Object.keys(item).sort().join(',') !== 'attachment,draft_key,schema_version'
      || item.schema_version !== 1 || typeof item.draft_key !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(item.draft_key)
      || keys.has(item.draft_key)) throw new Error('图片草稿无效。')
    const ref = item.attachment
    const refKeys = ref !== null && typeof ref === 'object' ? Object.keys(ref).sort().join(',') : ''
    if ((refKeys !== 'attachmentId,bytes,height,mediaType,width' && refKeys !== 'attachmentId,bytes,height,mediaType,name,width')
      || typeof ref.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(ref.attachmentId)
      || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType)
      || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > 5 * 1024 * 1024
      || !Number.isSafeInteger(ref.width) || ref.width < 1
      || !Number.isSafeInteger(ref.height) || ref.height < 1
      || ref.width > Math.floor(40_000_000 / ref.height)
      || ('name' in ref && (typeof ref.name !== 'string' || ref.name === '' || ref.name !== ref.name.trim()
        || ref.name.normalize('NFC') !== ref.name || new TextEncoder().encode(ref.name).byteLength > 255
        || ref.name === '.' || ref.name === '..' || ref.name.includes('/') || ref.name.includes('\\')
        || Array.from(ref.name).some(character => { const code = character.codePointAt(0); return code <= 0x1f || code === 0x7f })))) throw new Error('图片草稿无效。')
    total += ref.bytes
    if (total > 100 * 1024 * 1024) throw new Error('图片草稿无效。')
    keys.add(item.draft_key)
    return Object.freeze({ schema_version: 1, draft_key: item.draft_key, attachment: Object.freeze({ ...ref }) })
  })
}

function emateImportedText(text) {
  const paths = []
  const clean = text.replace(/(^|\s)@(\.e-mate\/imports\/\S+)/gu, (token, space, path) => {
    const name = path.slice('.e-mate/imports/'.length)
    if (name.startsWith('.') || /[\s@<>:"/\\|?*\u0000-\u001f]/u.test(name)) return token
    if (!paths.includes(path)) paths.push(path)
    return space
  })
  return { text: paths.length ? clean.trimEnd() : text, filePaths: paths }
}
function emateFileDisplay(text, source) {
  const value = emateImportedText(text)
  const names = new Map()
  if (Array.isArray(source?.mentions)) for (const mention of source.mentions) {
    if (mention?.source !== 'e-mate/file-import' || typeof mention.ref !== 'string') continue
    try {
      const [file] = emateDraftFiles([JSON.parse(mention.ref)])
      names.set(file.relative_path, file.display_name)
    } catch { /* Invalid optional labels fall back to the actual stored filename. */ }
  }
  return [value.text, ...value.filePaths.map(path => names.get(path) ?? path.slice('.e-mate/imports/'.length))].filter(Boolean).join('\n')
}
function emateQueuePreview(row) {
  const text = row.content.map(block => block.type === 'text' ? emateFileDisplay(block.text) : `[${block.type}]`).join(' ').replace(/\s+/gu, ' ').trim()
  const chars = Array.from(text)
  return chars.length > 200 ? chars.slice(0, 200).join('') + '…' : text
}

// An async transition fence over the existing tab action. Selection remains
// wholly in the native chat store; this ref only discards stale save outcomes.
function emateCanvasNavigationRequest(sequence, beforeNavigate, isCurrentSession, selectView, reportError) {
  return (view) => {
    const token = ++sequence.current;
    const current = () => sequence.current === token && isCurrentSession();
    const commit = () => { if (current()) selectView(view); };
    const failed = (error) => { if (current()) reportError(error); };
    try {
      const pending = beforeNavigate(view);
      if (pending && typeof pending.then === "function") return Promise.resolve(pending).then(commit, failed);
      commit();
    } catch (error) { failed(error); }
  };
}
function emateCanvasBeforeView(ctx, sessionId, view) {
  if (view === "e-mate-canvas") return;
  const canvas = ctx.get("emateCanvas");
  if (canvas?.activeSessionId() === sessionId) return canvas.beforeNavigate();
}

const CANVAS_FRAME_CSS = '[data-conversation-scroll]:has([data-emate-active-view="e-mate-canvas"]) [data-emate-composer-fallback]{display:none}'
  + '[data-conversation-scroll]:has([data-emate-active-view="e-mate-canvas"])>[data-composer-seat][data-emate-has-interactions="false"]{display:none}'
  + '[data-conversation-scroll]:has([data-emate-active-view="e-mate-canvas"])>[data-slot="conversation.session"]{display:flex;flex:1;min-height:0;min-width:0}'
  + '[data-conversation-scroll] [data-emate-active-view="e-mate-canvas"]{display:flex;flex-direction:column;flex:1 1 0;min-height:0;min-width:0;overflow:hidden}'
  + '[data-emate-active-view="e-mate-canvas"]>[data-slot="conversation.view"]{display:flex;flex:1;min-height:0;min-width:0}';

/** Desktop's copied navigation 0.2.1 bundle: one projection for AX and hover. */
export function adaptNavigationSource(source) {
  source = replaceOnce(source, '      const textOfBlocks = (blocks) => {',
    `${[emateDraftFiles, emateImportedText, emateFileDisplay].map(fn => fn.toString()).join('\n')}\n      const textOfBlocks = (blocks) => {`, 'navigation/helpers', '0.2.1')
  return replaceOnce(source, '            const userText = textOfBlocks(data.content)\n',
    '            const userText = emateFileDisplay(textOfBlocks(data.content), data.source)\n', 'navigation/user-text', '0.2.1')
}

/** Apply exact compiled seams from packages/client/ui-conversation/src/client. */
export function adaptHarnessConversationSource(source) {
  const change = (before, after, owner) => { source = replaceOnce(source, before, after, owner) }

  // Native Header still commits via its own scoped actions; failed saves do
  // not change view, and pending work cannot redirect a newer session/click.
  change('function ConversationSessionHeader({ sessionId, useSession, useSessions, useStore, actions, renderSlot, views, open, t }) {',
    'function ConversationSessionHeader({ sessionId, useSession, useSessions, useStore, actions, renderSlot, views, open: commitSessionOpen, beforeViewNavigate, isCurrentViewSession, reportViewError, t }) {\n\t\t\tconst navigation = (0, react.useRef)(0);\n\t\t\t(0, react.useEffect)(() => () => { navigation.current += 1; }, [sessionId]);\n\t\t\tconst selectView = emateCanvasNavigationRequest(navigation, beforeViewNavigate, isCurrentViewSession, actions.setView, reportViewError);\n\t\t\tconst open = emateCanvasNavigationRequest(navigation, () => beforeViewNavigate("chat"), isCurrentViewSession, commitSessionOpen, reportViewError);', 'canvas/header-guard')
  change('\t\t\t\t\t\t\t\t\t\t\topen(summary.id);', '\t\t\t\t\t\t\t\t\t\t\tvoid open(summary.id);', 'canvas/parent-session-action')
  change('\t\t\t\t\t\t\tactions.setView(viewTab.id);', '\t\t\t\t\t\t\tvoid selectView(viewTab.id);', 'canvas/tab-action')
  change('\t\t\t\tinject: () => ({\n\t\t\t\t\tviews,\n\t\t\t\t\topen: (id) => {',
    '\t\t\t\tinject: (sessionId) => ({\n\t\t\t\t\tviews,\n\t\t\t\t\tbeforeViewNavigate: (view) => emateCanvasBeforeView(ctx, sessionId, view),\n\t\t\t\t\tisCurrentViewSession: () => sessions.list.getSnapshot().current === sessionId,\n\t\t\t\t\treportViewError: (error) => { const scope = sessions.scope(sessionId); if (scope) ctx.conversation.input.for(scope).notify("error", error instanceof Error ? error.message : "画布尚未保存，请重试。"); },\n\t\t\t\t\topen: (id) => {', 'canvas/header-inject')
  // Preserve the mounted input/draft and native approval/question overlay.
  // Only its ordinary fallback is hidden; an elected interaction stays usable.
  change('\t\t\t\tclassName: ConversationRoot_module_css_default.composerFallback,', '\t\t\t\tclassName: ConversationRoot_module_css_default.composerFallback,\n\t\t\t\t"data-emate-composer-fallback": "",', 'canvas/composer-fallback')
  change('\t\t\t\t"data-composer-seat": "",', '\t\t\t\t"data-composer-seat": "",\n\t\t\t\t"data-emate-has-interactions": pending.length > 0 ? "true" : "false",', 'canvas/interaction-seat')
  change('\t\t\t\tclassName: ConversationRoot_module_css_default.viewArea,', '\t\t\t\tclassName: ConversationRoot_module_css_default.viewArea,\n\t\t\t\t"data-emate-active-view": active?.id ?? "chat",', 'canvas/active-view')
  change('\t\t\ttag.textContent = css$6;', '\t\t\ttag.textContent = css$6 + ' + JSON.stringify(CANVAS_FRAME_CSS) + ';', 'canvas/frame-css')

  // stores.ts: extend the existing per-session dsh.conversation.chat record.
  change('\t\tfunction createChatStore() {', `${[emateDraftFiles, emateDraftImages, emateImportedText, emateFileDisplay, emateQueuePreview, emateCanvasNavigationRequest, emateCanvasBeforeView].map(fn => fn.toString()).join('\n')}\n\t\tfunction createChatStore() {`, 'stores/helper')
  change('\t\t\t\t\tdraft: "",\n\t\t\t\t\tview: null,', '\t\t\t\t\tdraft: "",\n\t\t\t\t\tfileRefs: [],\n\t\t\t\t\timageRefs: [],\n\t\t\t\t\tview: null,', 'stores/init')
  change('\t\t\t\t\tsetDraft: (d, text) => {\n\t\t\t\t\t\td.draft = text;\n\t\t\t\t\t},', '\t\t\t\t\tsetDraft: (d, text, fileRefs = [], imageRefs = []) => {\n\t\t\t\t\t\td.draft = text;\n\t\t\t\t\t\td.fileRefs = fileRefs;\n\t\t\t\t\t\td.imageRefs = imageRefs;\n\t\t\t\t\t},', 'stores/mirror-action')

  // input/facade.ts: files live beside imageIds, not in another plugin store.
  change('\t\t\timageIds = [];\n\t\t\tdisposed = false;', '\t\t\timageIds = [];\n\t\t\tfileRefs = [];\n\t\t\tdurableImages = [];\n\t\t\tdurableImageIds = new Map();\n\t\t\timageStagePending = false;\n\t\t\tlastFileRefs = this.fileRefs;\n\t\t\tlastDurableImages = this.durableImages;\n\t\t\thydrationNotice = false;\n\t\t\tdisposed = false;', 'facade/state')
  change('\t\t\t\taddImages: (ids) => this.addImages(ids),', '\t\t\t\taddFiles: (files, draft) => this.addFiles(files, draft),\n\t\t\t\tremoveFile: (path) => this.removeFile(path),\n\t\t\t\trestoreDraft: (text, files, images) => this.restoreDraft(text, files, images),\n\t\t\t\tbeginImageStage: () => this.beginImageStage(),\n\t\t\t\tcancelImageStage: () => this.cancelImageStage(),\n\t\t\t\taddDurableImages: (images, ids) => this.addDurableImages(images, ids),\n\t\t\t\thydrateDurableImage: (key, id) => this.hydrateDurableImage(key, id),\n\t\t\t\tremoveDurableImage: (key) => this.removeDurableImage(key),\n\t\t\t\taddImages: (ids) => this.addImages(ids),', 'facade/actions')
  change('\t\t\t/** Append ordered image ids unless an admission transaction is locked. */', `
\t\t\taddFiles(files, draft) {
\t\t\t\tif (this.disposed || this.snapshot.phase === "adjudicating" || this.snapshot.phase === "submitting") return false;
\t\t\t\tconst current = new Set(this.fileRefs.map(file => file.relative_path));
\t\t\t\tconst added = emateDraftFiles(files).filter(file => !current.has(file.relative_path));
\t\t\t\tif (this.fileRefs.length + added.length > 64) throw new Error("草稿最多可添加 64 个文件。");
\t\t\t\tthis.fileRefs = [...this.fileRefs, ...added];
\t\t\t\tif (draft !== undefined) this.setDraft(draft);
\t\t\t\telse this.publish();
\t\t\t\treturn true;
\t\t\t}
\t\t\tremoveFile(path) {
\t\t\t\tthis.fileRefs = this.fileRefs.filter(file => file.relative_path !== path);
\t\t\t\tthis.publish();
\t\t\t}
\t\t\trestoreFiles(files) {
\t\t\t\tconst current = new Set(this.fileRefs.map(file => file.relative_path));
\t\t\t\tthis.fileRefs = [...files.filter(file => !current.has(file.relative_path)), ...this.fileRefs];
\t\t\t\tthis.publish();
\t\t\t}
\t\t\tbeginImageStage() {\n\t\t\t\tif (this.disposed || this.imageStagePending || this.snapshot.phase === "adjudicating" || this.snapshot.phase === "submitting") return false;\n\t\t\t\tthis.imageStagePending = true;\n\t\t\t\tthis.publish();\n\t\t\t\treturn true;\n\t\t\t}\n\t\t\tcancelImageStage() {\n\t\t\t\tif (!this.imageStagePending) return;\n\t\t\t\tthis.imageStagePending = false;\n\t\t\t\tthis.hydrationNotice = false;\n\t\t\t\tthis.publish();\n\t\t\t}\n\t\t\taddDurableImages(images, ids) {
\t\t\t\tif (this.disposed || this.snapshot.phase === "adjudicating" || this.snapshot.phase === "submitting") return false;
\t\t\t\tconst added = emateDraftImages(images);
\t\t\t\tif (added.length !== ids.length || added.some(item => this.durableImages.some(current => current.draft_key === item.draft_key))
\t\t\t\t\t|| new Set(ids).size !== ids.length || ids.some(id => this.imageIds.includes(id))) return false;
\t\t\t\tthis.durableImages = emateDraftImages([...this.durableImages, ...added]);
\t\t\t\tfor (let index = 0; index < added.length; index += 1) this.durableImageIds.set(added[index].draft_key, ids[index]);
\t\t\t\tthis.imageIds = [...this.imageIds, ...ids];
\t\t\t\tthis.imageStagePending = false;
\t\t\t\tthis.hydrationNotice = false;
\t\t\t\tthis.publish();
\t\t\t\treturn true;
\t\t\t}
\t\t\thydrateDurableImage(key, id) {
\t\t\t\tif (this.disposed || this.durableImageIds.has(key) || this.imageIds.includes(id)
\t\t\t\t\t|| !this.durableImages.some(item => item.draft_key === key)) return false;
\t\t\t\tthis.durableImageIds.set(key, id);
\t\t\t\tconst durableIds = new Set(this.durableImageIds.values());
\t\t\t\tconst runtimeOnly = this.imageIds.filter(candidate => !durableIds.has(candidate));
\t\t\t\tthis.imageIds = [...this.durableImages.flatMap(item => { const candidate = this.durableImageIds.get(item.draft_key); return candidate === undefined ? [] : [candidate]; }), ...runtimeOnly];
\t\t\t\tif (!this.durableImages.some(item => !this.durableImageIds.has(item.draft_key))) this.hydrationNotice = false;
\t\t\t\tthis.publish();
\t\t\t\treturn true;
\t\t\t}
\t\t\tremoveDurableImage(key) {
\t\t\t\tconst id = this.durableImageIds.get(key);
\t\t\t\tthis.durableImageIds.delete(key);
\t\t\t\tthis.durableImages = this.durableImages.filter(item => item.draft_key !== key);
\t\t\t\tif (id !== undefined) this.imageIds = this.imageIds.filter(candidate => candidate !== id);
\t\t\t\tif (!this.durableImages.some(item => !this.durableImageIds.has(item.draft_key))) this.hydrationNotice = false;
\t\t\t\tthis.publish();
\t\t\t\treturn id;
\t\t\t}
\t\t\trestoreDraft(text, files = [], images = []) {
\t\t\t\tlet failure;
\t\t\t\ttry { this.fileRefs = emateDraftFiles(files); }
\t\t\t\tcatch { this.fileRefs = []; failure = "附件草稿无法恢复，请重新选择文件。"; }
\t\t\t\ttry { this.durableImages = emateDraftImages(images); }
\t\t\t\tcatch { this.durableImages = []; failure = "图片草稿无法恢复，请重新选择图片。"; }
\t\t\t\tthis.durableImageIds.clear();
\t\t\t\tthis.imageIds = [];
\t\t\t\tthis.setDraft(text);
\t\t\t\tif (failure !== undefined) this.notify("error", failure);
\t\t\t}
\t\t\t/** Append ordered image ids unless an admission transaction is locked. */`, 'facade/file-lifecycle')
  change('\t\t\tcommitSend(imageIds) {\n\t\t\t\tconst submitted = new Set(imageIds);', '\t\t\tcommitSend(imageIds, files = []) {\n\t\t\t\tconst submittedFiles = new Set(files.map(file => file.relative_path));\n\t\t\t\tthis.fileRefs = this.fileRefs.filter(file => !submittedFiles.has(file.relative_path));\n\t\t\t\tconst submitted = new Set(imageIds);\n\t\t\t\tconst durable = this.durableImages.flatMap(item => { const id = this.durableImageIds.get(item.draft_key); return id !== undefined && submitted.has(id) ? [{ item, id }] : []; });\n\t\t\t\tthis.durableImages = this.durableImages.filter(item => !durable.some(sent => sent.item.draft_key === item.draft_key));\n\t\t\t\tfor (const sent of durable) this.durableImageIds.delete(sent.item.draft_key);', 'facade/commit')
  change('\t\t\t\tthis.run(this.core.dispatch({ type: "send-committed" }));\n\t\t\t}', '\t\t\t\tthis.run(this.core.dispatch({ type: "send-committed" }));\n\t\t\t\treturn durable;\n\t\t\t}', 'facade/commit-result')
  change('\t\t\tsubmit(mode = "queue") {\n\t\t\t\tthis.clearNotice();', '\t\t\tsubmit(mode = "queue") {\n\t\t\t\tif (this.imageStagePending || this.durableImages.some(item => !this.durableImageIds.has(item.draft_key))) { if (!this.hydrationNotice) { this.hydrationNotice = true; this.notify("info", "图片草稿正在恢复，请稍候。"); } return; }\n\t\t\t\tthis.clearNotice();', 'facade/hydration-submit')
  change('if (this.snapshot.draft.trim() === "" && this.imageIds.length > 0)', 'if (this.snapshot.draft.trim() === "" && (this.imageIds.length > 0 || this.fileRefs.length > 0))', 'facade/file-only-submit')
  change('\t\t\t\t\timageIds: this.imageIds,', '\t\t\t\t\timageIds: this.imageIds,\n\t\t\t\t\tfileRefs: this.fileRefs,\n\t\t\t\t\timageRefs: this.durableImages,\n\t\t\t\t\thydratedImageKeys: this.durableImages.filter(item => this.durableImageIds.has(item.draft_key)).map(item => item.draft_key),\n\t\t\t\t\truntimeOnlyImageIds: this.imageIds.filter(id => ![...this.durableImageIds.values()].includes(id)),\n\t\t\t\t\timageStagePending: this.imageStagePending,', 'facade/snapshot')
  change('\t\t\t\tthis.mirrorFn = write;\n\t\t\t\treturn () => {', '\t\t\t\tthis.mirrorFn = write;\n\t\t\t\twrite(this.snapshot.draft, this.fileRefs, this.durableImages);\n\t\t\t\treturn () => {', 'facade/mirror-adopt')
  change('if (next.draft !== this.lastDraft) {\n\t\t\t\t\tthis.lastDraft = next.draft;\n\t\t\t\t\tthis.mirrorFn?.(next.draft);', 'if (next.draft !== this.lastDraft || next.fileRefs !== this.lastFileRefs || next.imageRefs !== this.lastDurableImages) {\n\t\t\t\t\tthis.lastDraft = next.draft;\n\t\t\t\t\tthis.lastFileRefs = next.fileRefs;\n\t\t\t\t\tthis.lastDurableImages = next.imageRefs;\n\t\t\t\t\tthis.mirrorFn?.(next.draft, next.fileRefs, next.imageRefs);', 'facade/persistence')

  change('\t\t\tdispose() {\n\t\t\t\tthis.disposed = true;', '\t\t\tdispose() {\n\t\t\t\tthis.disposed = true;\n\t\t\t\tthis.imageStagePending = false;', 'facade/dispose-stage')

  change('\t\t\tremoveImage(id) {\n\t\t\t\tconst next = this.imageIds.filter((candidate) => candidate !== id);', '\t\t\tremoveImage(id) {\n\t\t\t\tconst durableKey = [...this.durableImageIds].find(([, candidate]) => candidate === id)?.[0];\n\t\t\t\tif (durableKey !== undefined) { this.durableImageIds.delete(durableKey); this.durableImages = this.durableImages.filter(item => item.draft_key !== durableKey); }\n\t\t\t\tconst next = this.imageIds.filter((candidate) => candidate !== id);', 'facade/remove-durable')

  change('\t\t\tpruneImages(available) {\n\t\t\t\tconst keep = new Set(available);', '\t\t\tpruneImages(available) {\n\t\t\t\tconst keep = new Set(available);\n\t\t\t\tfor (const [key, id] of this.durableImageIds) if (!keep.has(id)) this.durableImageIds.delete(key);', 'facade/prune-durable')

  change('\t\t\trestoreImages(ids) {\n\t\t\t\tconst current = new Set(this.imageIds);', '\t\t\trestoreImages(ids, durable = []) {\n\t\t\t\tconst restored = emateDraftImages(durable.map(value => value.item));\n\t\t\t\tconst currentKeys = new Set(this.durableImages.map(item => item.draft_key));\n\t\t\t\tthis.durableImages = emateDraftImages([...restored.filter(item => !currentKeys.has(item.draft_key)), ...this.durableImages]);\n\t\t\t\tfor (const value of durable) if (!this.durableImageIds.has(value.item.draft_key)) this.durableImageIds.set(value.item.draft_key, value.id);\n\t\t\t\tconst current = new Set(this.imageIds);', 'facade/restore-durable')

  // input/hub.ts: retain the native prompt/queue/steer transport and rollback.
  change(`\t\t\t\tif (text === "" && imageIds.length === 0) return;
\t\t\t\tconst shell = this.shells.get(session.sessionId);
\t\t\t\tshell?.commitSend(imageIds);`, `\t\t\t\tconst shell = this.shells.get(session.sessionId);
\t\t\t\tconst files = shell?.snapshot.fileRefs ?? [];
\t\t\t\tif (text === "" && imageIds.length === 0 && files.length === 0) return;
\t\t\t\tconst draftText = text;
\t\t\t\tif (files.length > 0) {
\t\t\t\t\ttext = [text, ...files.map(file => "@" + file.relative_path)].filter(Boolean).join("\\n");
\t\t\t\t\tmentions = [...(mentions ?? []), ...files.map(file => ({ source: "e-mate/file-import", ref: JSON.stringify(file) }))];
\t\t\t\t}
\t\t\t\tconst durableImages = shell?.commitSend(imageIds, files) ?? [];`, 'hub/admission')
  change('\t\t\t\t\t\tshell?.restoreImages(imageIds);\n\t\t\t\t\t\tif (shell?.snapshot.draft === "") shell.setDraft(text);', '\t\t\t\t\t\tshell?.restoreFiles(files);\n\t\t\t\t\t\tshell?.restoreImages(imageIds, durableImages);\n\t\t\t\t\t\tif (shell?.snapshot.draft === "") shell.setDraft(draftText);', 'hub/rollback')

  // skeleton/ConversationSession.tsx: hydrate the same scoped native store.
  change('const storedDraft = useStore((s) => s.draft);', 'const storedDraft = useStore((s) => s.draft);\n\t\t\tconst storedFiles = useStore((s) => s.fileRefs);\n\t\t\tconst storedImages = useStore((s) => s.imageRefs);', 'session/persisted-files')
  change('if (inputState.draft === "" && storedDraft !== "") inputActions.setDraft(storedDraft);', 'if (inputState.draft === "" && inputState.fileRefs.length === 0 && inputState.imageRefs.length === 0) inputActions.restoreDraft(storedDraft, storedFiles ?? [], storedImages ?? []);', 'session/hydrate')

  // skeleton/InputBar.tsx: toolbar/Enter retain native locks and submit policy.
  change('const empty = draft.trim() === "" && attachments.length === 0;', 'const empty = draft.trim() === "" && attachments.length === 0 && (input?.fileRefs.length ?? 0) === 0 && (input?.imageRefs.length ?? 0) === 0;', 'input-bar/empty')
  // apply.ts: the native entry keeps ownership of plan/model and its assembled
  // renderSlot binding. Product content decorates that body through one child.
  change('\t\t\t\tname: "conversation.composer.bar",\n\t\t\t\tlocale: NS,\n\t\t\t\tchildren: {', '\t\t\t\tname: "conversation.composer.bar",\n\t\t\t\tlocale: NS,\n\t\t\t\tchildren: {\n\t\t\t\t\t"e-mate.conversation.composer": { kind: "single", scope: "session-maybe" },', 'apply/composer-declaration')
  change('\t\t\t}, InputBar);', `\t\t\t}, function EmateComposer(props) {
\t\t\t\treturn props.renderSlot("e-mate.conversation.composer", { nativeProps: props, InputBar }, { fallback: (0, react_jsx_runtime.jsx)(InputBar, props) });
\t\t\t});`, 'apply/composer-body')
  // chat/MessageItem.tsx: native pending steering has no keyed renderer. Keep
  // its native actions and show the managed filename until the durable node
  // supplies the richer file-import card projection.
  change('\t\tfunction projectUserText(text) {', '\t\tfunction projectUserText(text) {\n\t\t\ttext = emateFileDisplay(text);', 'message/pending-steering-display')
  // queue/QueueDock.tsx: edit the prose while retaining the exact file paths in
  // the existing edit transaction. Preview text must never become model text.
  change('children: row.preview', 'children: emateQueuePreview(row)', 'queue/preview')
  change('text: row.text\n', '...emateImportedText(row.text)\n', 'queue/begin-edit')
  change('id: row.id,\n\t\t\t\t\t\t\t\t\t\t\ttext: event.currentTarget.value', '...editing,\n\t\t\t\t\t\t\t\t\t\t\ttext: event.currentTarget.value', 'queue/edit-text')
  change('if (editing === null || editing.text.trim() === "") return;', 'if (editing === null || (editing.text.trim() === "" && editing.filePaths.length === 0)) return;', 'queue/save-admission')
  change('text: editing.text\n', 'text: [editing.text, ...editing.filePaths.map(path => "@" + path)].filter(Boolean).join("\\n")\n', 'queue/save-model-text')
  change('disabled: busy !== null || editing.text.trim() === "",', 'disabled: busy !== null || (editing.text.trim() === "" && editing.filePaths.length === 0),', 'queue/save-button')
  return source
}
