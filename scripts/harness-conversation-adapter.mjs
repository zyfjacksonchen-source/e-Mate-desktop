// Product-only additions to pinned conversation owners. Never edit upstream
// packages: assemblers apply these transforms to their copied client bundles.
export const CONVERSATION_ADAPTER_PATH = 'scripts/harness-conversation-adapter.mjs'
export const CONVERSATION_PACKAGE = '@deepseek-ai/dsh-client-ui-conversation'
// 0.1.5 split the rc.7 Conversation package: the skeleton, composer, queue,
// input store and input shell stayed in ui-conversation, while the Chat
// renderer, the chat store and the file-mention provider moved to ui-chat.
// Each owner therefore keeps its own fail-closed adapter beside the original.
export const CONVERSATION_CHAT_ADAPTER_PATH = 'scripts/harness-conversation-adapter.mjs'
export const CONVERSATION_CHAT_PACKAGE = '@deepseek-ai/dsh-client-ui-chat'

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

// Explicit Markdown links may request a local file on click. Inline-code
// mentions retain the native produced-file vocabulary and do not gain guesses.
function emateArtifactFileMentions(ctx, owner, sessions, sessionId) {
  const service = ctx.get("chatFileMentions");
  const native = service?.forClosing(owner);
  const session = sessions?.binding(sessionId)?.session;
  const current = () => session !== undefined && sessions.binding(sessionId)?.session === session
    && sessions.list.getSnapshot().current === sessionId
    && !(typeof document !== "undefined" && document.querySelector("[data-emate-identity-gate]"));
  const previous = value => {
    if (!current()) return undefined;
    const snapshot = session.getSnapshot();
    if (snapshot.sessionId !== sessionId || snapshot.openState !== "open") return undefined;
    const timeline = snapshot.timeline ?? snapshot.chat?.timeline;
    if (timeline === undefined || timeline.turns.get(owner.turn.turn) !== owner.turn) return undefined;
    for (const number of timeline.turnOrder) {
      if (number >= owner.turn.turn) continue;
      const turn = timeline.turns.get(number);
      // The same native selector admits persisted receipts and structured Tool
      // outputs. Prior paths never become this turn's produced-file facts.
      if (!turn) continue;
      const resolved = service?.forClosing({ ...owner, turn, nodes: undefined })?.resolve(value);
      if (resolved?.title === value) return resolved;
    }
    return undefined;
  };
  return {
    resolve: value => {
      const own = native?.resolve(value);
      if (own) return own;
      const prior = previous(value);
      return prior && { ...prior, open: () => { if (previous(value)) prior.open(); } };
    },
    resolveLink: value => native?.resolve(value) ?? {
      open: () => owner.openFile(value),
      label: "打开 " + value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1),
      title: value,
    },
  };
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
  if (view === "e-mate-canvas" || typeof document !== "undefined" && document.querySelector("[data-emate-identity-gate]")) return;
  const canvas = ctx.get("emateCanvas");
  if (canvas?.activeSessionId() === sessionId) return canvas.beforeNavigate();
}

const CANVAS_FRAME_CSS = '[data-conversation-scroll]:has([data-emate-active-view="e-mate-canvas"]) [data-emate-composer-fallback]{display:none}'
  + '[data-conversation-scroll]:has([data-emate-active-view="e-mate-canvas"])>[data-composer-seat][data-emate-has-interactions="false"]{display:none}'
  + '[data-conversation-scroll]:has([data-emate-active-view="e-mate-canvas"])>[data-slot="conversation.session"]{display:flex;flex:1;min-height:0;min-width:0}'
  + '[data-conversation-scroll] [data-emate-active-view="e-mate-canvas"]{display:flex;flex-direction:column;flex:1 1 0;min-height:0;min-width:0;overflow:hidden}'
  + '[data-emate-active-view="e-mate-canvas"]>[data-slot="conversation.view"]{display:flex;flex:1;min-height:0;min-width:0}';

// Presentation-only: the native per-Turn Tool tree remains the sole output index.
function emateAssistantImageBlocks(snapshot, node) {
  if (!node.data.blocks.some(block => block.kind === 'image')) return node.data.blocks;
  const turn = node.location.kind === 'turn' || node.location.kind === 'step' ? node.location.turn : undefined;
  if (turn === undefined) return node.data.blocks;
  const ids = new Set();
  const visit = block => {
    if ('kind' in block && !block.isError) for (const part of [...block.content, ...(block.resultView?.card === 'generic' ? block.resultView.content ?? [] : [])]) {
      if (part.type === 'image') ids.add(part.attachment.attachmentId);
    }
    for (const child of block.subCalls ?? []) visit(child);
  };
  const locations = snapshot.locations ?? snapshot.chat?.locations;
  const nodes = snapshot.nodes ?? snapshot.chat?.nodes;
  if (locations === undefined || nodes === undefined) return node.data.blocks;
  for (const key of locations.getTurn(turn.turn)) {
    const item = nodes.get(key);
    if (item?.kind === 'tool-call') visit(item.data.root);
    if (item?.kind === 'e-mate-tool-images' && item.visibility === 'hidden') {
      for (const image of item.data.items) if (image.status === 'completed' && image.attachment) ids.add(image.attachment.attachmentId);
    }
  }
  return node.data.blocks.filter(block => block.kind !== 'image' || !ids.has(block.attachment.attachmentId));
}
function emateSameAssistantBlocks(left, right) {
  return left.length === right.length && left.every((block, index) => block === right[index]);
}

// Injected verbatim into each native client closure that owns these seams.
const EMATE_SEAM_HELPERS = [
  emateDraftFiles, emateDraftImages, emateImportedText, emateFileDisplay, emateQueuePreview,
  emateArtifactFileMentions, emateCanvasNavigationRequest, emateCanvasBeforeView,
  emateAssistantImageBlocks, emateSameAssistantBlocks,
].map(fn => fn.toString()).join('\n')

/** Apply exact compiled seams from packages/client/ui-conversation/src/client. */
export function adaptHarnessConversationSource(source) {
  const change = (before, after, owner) => { source = replaceOnce(source, before, after, owner) }

  // Native Header still commits via its own scoped actions; failed saves do
  // not change view, and pending work cannot redirect a newer session/click.
  change('function ConversationSessionHeader({ sessionId, useSession, useSessions, useConversation, useConversationViews, useStore, renderSlot, open, selectView, t }) {',
    'function ConversationSessionHeader({ sessionId, useSession, useSessions, useConversation, useConversationViews, useStore, renderSlot, open: commitSessionOpen, selectView: nativeSelectView, beforeViewNavigate, isCurrentViewSession, reportViewError, t }) {\n\t\t\tconst navigation = (0, react.useRef)(0);\n\t\t\t(0, react.useEffect)(() => { const invalidate = () => { navigation.current += 1; }; addEventListener("emate:identity-changed", invalidate); return () => { invalidate(); removeEventListener("emate:identity-changed", invalidate); }; }, [sessionId]);\n\t\t\tconst selectView = emateCanvasNavigationRequest(navigation, beforeViewNavigate, isCurrentViewSession, nativeSelectView, reportViewError);\n\t\t\tconst open = emateCanvasNavigationRequest(navigation, () => beforeViewNavigate("chat"), isCurrentViewSession, commitSessionOpen, reportViewError);', 'canvas/header-guard')

  change('onClick: () => {\n\t\t\t\t\t\t\t\t\t\topen(summary.id);\n\t\t\t\t\t\t\t\t\t\t},',
    'onClick: () => {\n\t\t\t\t\t\t\t\t\t\tvoid open(summary.id);\n\t\t\t\t\t\t\t\t\t\t},', 'canvas/parent-session-action')

  change('openTitle: () => {\n\t\t\t\t\t\t\t\t\t\topen(summary.id);',
    'openTitle: () => {\n\t\t\t\t\t\t\t\t\t\tvoid open(summary.id);', 'canvas/parent-session-title-action')

  change('\t\t\t\t\t\t\tselectView(viewTab.id);', '\t\t\t\t\t\t\tvoid selectView(viewTab.id);', 'canvas/tab-action')

  change('\t\t\t\tinject: (sessionId, actions) => ({\n\t\t\t\t\thooks: { conversationViews },\n\t\t\t\t\topen: (id) => {',
    '\t\t\t\tinject: (sessionId, actions) => ({\n\t\t\t\t\thooks: { conversationViews },\n\t\t\t\t\tbeforeViewNavigate: (view) => emateCanvasBeforeView(ctx, sessionId, view),\n\t\t\t\t\tisCurrentViewSession: () => sessions.list.getSnapshot().current === sessionId && !document.querySelector("[data-emate-identity-gate]"),\n\t\t\t\t\treportViewError: (error) => { const scope = sessions.scope(sessionId); if (scope) inputHub.for(scope).notify("error", error instanceof Error ? error.message : "画布尚未保存，请重试。"); },\n\t\t\t\t\topen: (id) => {', 'canvas/header-inject')

  // Preserve the mounted input/draft and native approval/question overlay.
  // Only its ordinary fallback is hidden; an elected interaction stays usable.
  change('\t\t\t\tclassName: clsx(ConversationRoot_module_css_default.composerStack, hero && ConversationRoot_module_css_default.composerHero),\n\t\t\t\t"data-emate-composer-frame-host": "",',
    '\t\t\t\tclassName: clsx(ConversationRoot_module_css_default.composerStack, hero && ConversationRoot_module_css_default.composerHero),\n\t\t\t\t"data-emate-composer-frame-host": "",\n\t\t\t\t"data-emate-composer-fallback": "",', 'canvas/composer-fallback')

  change('\t\t\t\t"data-composer-seat": "",',
    '\t\t\t\t"data-composer-seat": "",\n\t\t\t\t"data-emate-has-interactions": pending.length > 0 ? "true" : "false",', 'canvas/interaction-seat')

  change('\t\t\t\tclassName: ConversationRoot_module_css_default.viewArea,',
    '\t\t\t\tclassName: ConversationRoot_module_css_default.viewArea,\n\t\t\t\t"data-emate-active-view": active?.id ?? "chat",', 'canvas/active-view')

  // ConversationRoot.module.css is css$4 in 0.1.5 (rc.7 emitted it as css$6); the
  // dataset line pins the seam to that stylesheet instead of another plugin CSS.
  change('\t\t\ttag.dataset.pluginCss = tagId$4;\n\t\t\ttag.textContent = css$4;',
    '\t\t\ttag.dataset.pluginCss = tagId$4;\n\t\t\ttag.textContent = css$4 + ' + JSON.stringify(CANVAS_FRAME_CSS) + ';', 'canvas/frame-css')

  // stores.ts: extend the existing per-session dsh.conversation record.
  change('\t\tfunction createConversationStore() {',
    EMATE_SEAM_HELPERS + '\n\t\tfunction createConversationStore() {', 'stores/helper')

  change('\t\t\t\t\tdraft: "",\n\t\t\t\t\tview: null,',
    '\t\t\t\t\tdraft: "",\n\t\t\t\t\tfileRefs: [],\n\t\t\t\t\timageRefs: [],\n\t\t\t\t\tview: null,', 'stores/init')

  change('\t\t\t\t\tsetDraft: (d, text) => {\n\t\t\t\t\t\td.draft = text;\n\t\t\t\t\t},',
    '\t\t\t\t\tsetDraft: (d, text, fileRefs = [], imageRefs = []) => {\n\t\t\t\t\t\td.draft = text;\n\t\t\t\t\t\td.fileRefs = fileRefs;\n\t\t\t\t\t\td.imageRefs = imageRefs;\n\t\t\t\t\t},', 'stores/mirror-action')
  change('\t\t\tattachmentIds = [];\n\t\t\tdisposed = false;',
    '\t\t\tattachmentIds = [];\n\t\t\tfileRefs = [];\n\t\t\tdurableImages = [];\n\t\t\tdurableImageIds = new Map();\n\t\t\timageStagePending = false;\n\t\t\tlastFileRefs = this.fileRefs;\n\t\t\tlastDurableImages = this.durableImages;\n\t\t\thydrationNotice = false;\n\t\t\tdisposed = false;', 'facade/state')

  change('\t\t\t\taddAttachments: (ids) => this.addAttachments(ids),',
    '\t\t\t\taddFiles: (files, draft) => this.addFiles(files, draft),\n\t\t\t\tremoveFile: (path) => this.removeFile(path),\n\t\t\t\trestoreDraft: (text, files, images) => this.restoreDraft(text, files, images),\n\t\t\t\tbeginImageStage: () => this.beginImageStage(),\n\t\t\t\tcancelImageStage: () => this.cancelImageStage(),\n\t\t\t\taddDurableImages: (images, ids) => this.addDurableImages(images, ids),\n\t\t\t\thydrateDurableImage: (key, id) => this.hydrateDurableImage(key, id),\n\t\t\t\tremoveDurableImage: (key) => this.removeDurableImage(key),\n\t\t\t\taddAttachments: (ids) => this.addAttachments(ids),', 'facade/actions')

  // input/facade.ts: files live beside attachment ids, not in another plugin store.
  change('\t\t\t/** Append ordered attachment ids unless an admission transaction is locked. */',
    `\t\t\t\t\t\taddFiles(files, draft) {\n\t\t\t\tif (this.disposed || this.snapshot.phase === "adjudicating" || this.snapshot.phase === "submitting") return false;\n\t\t\t\tconst current = new Set(this.fileRefs.map(file => file.relative_path));\n\t\t\t\tconst added = emateDraftFiles(files).filter(file => !current.has(file.relative_path));\n\t\t\t\tif (this.fileRefs.length + added.length > 64) throw new Error("草稿最多可添加 64 个文件。");\n\t\t\t\tthis.fileRefs = [...this.fileRefs, ...added];\n\t\t\t\tif (draft !== undefined) this.setDraft(draft);\n\t\t\t\telse this.publish();\n\t\t\t\treturn true;\n\t\t\t}\n\t\t\tremoveFile(path) {\n\t\t\t\tthis.fileRefs = this.fileRefs.filter(file => file.relative_path !== path);\n\t\t\t\tthis.publish();\n\t\t\t}\n\t\t\trestoreFiles(files) {\n\t\t\t\tconst current = new Set(this.fileRefs.map(file => file.relative_path));\n\t\t\t\tthis.fileRefs = [...files.filter(file => !current.has(file.relative_path)), ...this.fileRefs];\n\t\t\t\tthis.publish();\n\t\t\t}\n\t\t\tbeginImageStage() {\n\t\t\t\tif (this.disposed || this.imageStagePending || this.snapshot.phase === "adjudicating" || this.snapshot.phase === "submitting") return false;\n\t\t\t\tthis.imageStagePending = true;\n\t\t\t\tthis.publish();\n\t\t\t\treturn true;\n\t\t\t}\n\t\t\tcancelImageStage() {\n\t\t\t\tif (!this.imageStagePending) return;\n\t\t\t\tthis.imageStagePending = false;\n\t\t\t\tthis.hydrationNotice = false;\n\t\t\t\tthis.publish();\n\t\t\t}\n\t\t\taddDurableImages(images, ids) {\n\t\t\t\tif (this.disposed || this.snapshot.phase === "adjudicating" || this.snapshot.phase === "submitting") return false;\n\t\t\t\tconst added = emateDraftImages(images);\n\t\t\t\tif (added.length !== ids.length || added.some(item => this.durableImages.some(current => current.draft_key === item.draft_key))\n\t\t\t\t\t|| new Set(ids).size !== ids.length || ids.some(id => this.attachmentIds.includes(id))) return false;\n\t\t\t\tthis.durableImages = emateDraftImages([...this.durableImages, ...added... (line truncated to 2000 chars)
  change('\t\t\tcommitSend(attachmentIds) {\n\t\t\t\tconst submitted = new Set(attachmentIds);',
    `\t\t\tcommitSend(attachmentIds, files = []) {\n\t\t\t\tconst submittedFiles = new Set(files.map(file => file.relative_path));\n\t\t\t\tthis.fileRefs = this.fileRefs.filter(file => !submittedFiles.has(file.relative_path));\n\t\t\t\tconst submitted = new Set(attachmentIds);\n\t\t\t\tconst durable = this.durableImages.flatMap(item => { const id = this.durableImageIds.get(item.draft_key); return id !== undefined && submitted.has(id) ? [{ item, id }] : []; });\n\t\t\t\tthis.durableImages = this.durableImages.filter(item => !durable.some(sent => sent.item.draft_key === item.draft_key));\n\t\t\t\tfor (const sent of durable) this.durableImageIds.delete(sent.item.draft_key);`, 'facade/commit')

  change('\t\t\t\tthis.dispatchRun({ type: "send-committed" });\n\t\t\t}',
    '\t\t\t\tthis.dispatchRun({ type: "send-committed" });\n\t\t\t\treturn durable;\n\t\t\t}', 'facade/commit-result')

  // 0.1.5 commits an ordinary text send through the machine's commit-draft
  // effect, not through commitSend; files must leave the draft on that path too.
  change('\t\t\tcommitDraft(retainSuffixOf) {\n\t\t\t\tthis.editor.update(() => {',
    '\t\t\tcommitDraft(retainSuffixOf) {\n\t\t\t\tif (this.fileRefs.length > 0) { this.fileRefs = []; this.publish(); }\n\t\t\t\tthis.editor.update(() => {', 'facade/commit-draft')

  change('\t\t\tsubmit(mode = "queue") {\n\t\t\t\tif (this.snapshot.draft.trim() === "" && this.attachmentIds.length > 0) {',
    '\t\t\tsubmit(mode = "queue") {\n\t\t\t\tif (this.imageStagePending || this.durableImages.some(item => !this.durableImageIds.has(item.draft_key))) { if (!this.hydrationNotice) { this.hydrationNotice = true; this.notify("info", "图片草稿正在恢复，请稍候。"); } return; }\n\t\t\t\tif (this.snapshot.draft.trim() === "" && this.attachmentIds.length > 0) {', 'facade/hydration-submit')

  change('if (this.snapshot.draft.trim() === "" && this.attachmentIds.length > 0)',
    'if (this.snapshot.draft.trim() === "" && (this.attachmentIds.length > 0 || this.fileRefs.length > 0))', 'facade/file-only-submit')

  change('\t\t\t\t\tattachmentIds: this.attachmentIds,',
    '\t\t\t\t\tattachmentIds: this.attachmentIds,\n\t\t\t\t\tfileRefs: this.fileRefs,\n\t\t\t\t\timageRefs: this.durableImages,\n\t\t\t\t\thydratedImageKeys: this.durableImages.filter(item => this.durableImageIds.has(item.draft_key)).map(item => item.draft_key),\n\t\t\t\t\truntimeOnlyImageIds: this.attachmentIds.filter(id => ![...this.durableImageIds.values()].includes(id)),\n\t\t\t\t\timageStagePending: this.imageStagePending,', 'facade/snapshot')

  change('\t\t\t\tthis.mirrorFn = write;\n\t\t\t\treturn () => {',
    '\t\t\t\tthis.mirrorFn = write;\n\t\t\t\twrite(this.snapshot.draft, this.fileRefs, this.durableImages);\n\t\t\t\treturn () => {', 'facade/mirror-adopt')

  change('if (next.draft !== this.lastMirroredDraft) {\n\t\t\t\t\tthis.lastMirroredDraft = next.draft;\n\t\t\t\t\tthis.mirrorFn?.(next.draft);',
    'if (next.draft !== this.lastMirroredDraft || next.fileRefs !== this.lastFileRefs || next.imageRefs !== this.lastDurableImages) {\n\t\t\t\t\tthis.lastMirroredDraft = next.draft;\n\t\t\t\t\tthis.lastFileRefs = next.fileRefs;\n\t\t\t\t\tthis.lastDurableImages = next.imageRefs;\n\t\t\t\t\tthis.mirrorFn?.(next.draft, next.fileRefs, next.imageRefs);', 'facade/persistence')

  change('\t\t\tdispose() {\n\t\t\t\tif (this.disposed) return [];',
    '\t\t\tdispose() {\n\t\t\t\tif (this.disposed) return [];\n\t\t\t\tthis.imageStagePending = false;', 'facade/dispose-stage')

  change('\t\t\tremoveAttachment(id) {\n\t\t\t\tif (this.snapshot.phase === "adjudicating" || this.snapshot.phase === "submitting") return false;\n\t\t\t\tconst next = this.attachmentIds.filter((candidate) => candidate !== id);',
    '\t\t\tremoveAttachment(id) {\n\t\t\t\tconst durableKey = [...this.durableImageIds].find(([, candidate]) => candidate === id)?.[0];\n\t\t\t\tif (durableKey !== undefined) { this.durableImageIds.delete(durableKey); this.durableImages = this.durableImages.filter(item => item.draft_key !== durableKey); }\n\t\t\t\tif (this.snapshot.phase === "adjudicating" || this.snapshot.phase === "submitting") return false;\n\t\t\t\tconst next = this.attachmentIds.filter((candidate) => candidate !== id);', 'facade/remove-durable')

  change('\t\t\tpruneAttachments(available) {\n\t\t\t\tconst keep = new Set(available);',
    '\t\t\tpruneAttachments(available) {\n\t\t\t\tconst keep = new Set(available);\n\t\t\t\tfor (const [key, id] of this.durableImageIds) if (!keep.has(id)) this.durableImageIds.delete(key);', 'facade/prune-durable')

  change('\t\t\trestoreAttachments(attachmentIds) {\n\t\t\t\tif (attachmentIds.length === 0) return;\n\t\t\t\tconst current = new Set(this.attachmentIds);',
    '\t\t\trestoreAttachments(attachmentIds, durable = []) {\n\t\t\t\tconst restoredDurable = emateDraftImages(durable.map(value => value.item));\n\t\t\t\tconst currentKeys = new Set(this.durableImages.map(item => item.draft_key));\n\t\t\t\tthis.durableImages = emateDraftImages([...restoredDurable.filter(item => !currentKeys.has(item.draft_key)), ...this.durableImages]);\n\t\t\t\tfor (const value of durable) if (!this.durableImageIds.has(value.item.draft_key)) this.durableImageIds.set(value.item.draft_key, value.id);\n\t\t\t\tif (attachmentIds.length === 0) return;\n\t\t\t\tconst current = new Set(this.attachmentIds);', 'facade/restore-durable')
  // input/hub.ts: retain the native prompt/queue/steer transport and rollback.
  change(`\t\t\tsinkSerialized(attempt, draft, mode) {\n\t\t\t\tconst attachmentIds = [...this.attachmentIds];\n\t\t\t\tthis.attachmentIds = [];\n\t\t\t\tconst occurrences = this.projection.occurrences;\n\t\t\t\tconst record = {\n\t\t\t\t\tdraft,\n\t\t\t\t\toccurrences,\n\t\t\t\t\tattachmentIds\n\t\t\t};`, `\t\t\tsinkSerialized(attempt, draft, mode) {\n\t\t\t\tconst files = this.fileRefs;\n\t\t\t\tconst draftText = draft;\n\t\t\t\tif (files.length > 0) {\n\t\t\t\t\tdraft = [draft, ...files.map(file => "@" + file.relative_path)].filter(Boolean).join("\n");\n\t\t\t\t}\n\t\t\t\tconst attachmentIds = [...this.attachmentIds];\n\t\t\t\tthis.attachmentIds = [];\n\t\t\t\tconst occurrences = this.projection.occurrences;\n\t\t\t\tconst record = {\n\t\t\t\t\tdraft: draftText,\n\t\t\t\t\tfiles,\n\t\t\t\t\toccurrences,\n\t\t\t\t\tattachmentIds\n\t\t\t};`, 'hub/admission')

  change(`\t\t\tsettleDetachedFailure(attempt, message) {\n\t\t\t\tconst record = this.detachedDrafts.get(attempt.seq);\n\t\t\t\tif (record === void 0) return;\n\t\t\t\tthis.detachedDrafts.delete(attempt.seq);\n\t\t\t\tthis.restoreAttachments(record.attachmentIds);`, `\t\t\tsettleDetachedFailure(attempt, message) {\n\t\t\t\tconst record = this.detachedDrafts.get(attempt.seq);\n\t\t\t\tif (record === void 0) return;\n\t\t\t\tthis.detachedDrafts.delete(attempt.seq);\n\t\t\t\tthis.restoreFiles(record.files ?? []);\n\t\t\t\tthis.restoreAttachments(record.attachmentIds);`, 'hub/rollback')

  // skeleton/ConversationSession.tsx: hydrate the same scoped native store.
  change('const storedDraft = useStore((s) => s.draft);',
    'const storedDraft = useStore((s) => s.draft);\n\t\t\tconst storedFiles = useStore((s) => s.fileRefs);\n\t\t\tconst storedImages = useStore((s) => s.imageRefs);', 'session/persisted-files')

  change('if (inputState.draft === "" && storedDraft !== "") inputActions.setDraft(storedDraft);',
    'if (inputState.draft === "" && inputState.fileRefs.length === 0 && inputState.imageRefs.length === 0) inputActions.restoreDraft(storedDraft, storedFiles ?? [], storedImages ?? []);', 'session/hydrate')

  // skeleton/InputBar.tsx: toolbar/Enter retain native locks and submit policy.
  change('const empty = draft.trim() === "" && attachments.length === 0;',
    'const empty = draft.trim() === "" && attachments.length === 0 && (input?.fileRefs.length ?? 0) === 0 && (input?.imageRefs.length ?? 0) === 0;', 'input-bar/empty')

  // apply.ts: the native entry keeps ownership of plan/model and its assembled
  // renderSlot binding. Product content decorates that body through one child.
  change('\t\t\t\tname: "conversation.composer.bar",\n\t\t\t\tlocale: NS,\n\t\t\t\tchildren: {',
    '\t\t\t\tname: "conversation.composer.bar",\n\t\t\t\tlocale: NS,\n\t\t\t\tchildren: {\n\t\t\t\t\t"e-mate.conversation.composer": { kind: "single", scope: "session-maybe" },', 'apply/composer-declaration')

  change('\t\t\t}, InputBar);', `\t\t\t}, function EmateComposer(props) {
\t\t\t\treturn props.renderSlot("e-mate.conversation.composer", { nativeProps: props, InputBar }, { fallback: (0, react_jsx_runtime.jsx)(InputBar, props) });
\t\t\t});`, 'apply/composer-body')
  // queue/QueueDock.tsx: edit the prose while retaining the exact file paths in
  // the existing edit transaction. Preview text must never become model text.
  change('children: (0, _deepseek_ai_dsh_client_ui_primitives.projectUserText)(row.preview, [])', 'children: emateQueuePreview(row)', 'queue/preview')

  change('text: row.text\n', '...emateImportedText(row.text)\n', 'queue/begin-edit')

  change('id: row.id,\n\t\t\t\t\t\t\t\t\t\t\t\ttext: event.currentTarget.value',
    '...editing,\n\t\t\t\t\t\t\t\t\t\t\t\ttext: event.currentTarget.value', 'queue/edit-text')

  change('if (editing === null || editing.text.trim() === "") return;',
    'if (editing === null || (editing.text.trim() === "" && editing.filePaths.length === 0)) return;', 'queue/save-admission')

  change('text: editing.text\n', 'text: [editing.text, ...editing.filePaths.map(path => "@" + path)].filter(Boolean).join("\n")\n', 'queue/save-model-text')

  change('disabled: busy !== null || editing.text.trim() === "",',
    'disabled: busy !== null || (editing.text.trim() === "" && editing.filePaths.length === 0),', 'queue/save-button')
  return source
}

/**
 * Apply exact compiled seams from packages/client/ui-chat/src/client — the 0.1.5
 * owner of the rc.7 Conversation renderer, chat store and file-mention provider.
 *
 * Retired seam: turn-error/terminal-after-retry.
 * rc.7 rendered the terminal Turn failure through a Definition that could be
 * reached while its own state was still hidden, so a retry could suppress a
 * final turn failure; the seam pinned the row visible. 0.1.5 absorbed that
 * outcome natively. Its bundle states it under
 * //#region lib/types/client/conversation-nodes/turn-error.js:
 *
 *   Terminal turn failure Definition. Retries run inside the failing turn, so the
 *   turn's llm/retry history never suppresses this terminal row; the model-retry
 *   node renders that history separately.
 *
 * with the native buildViewNode
 *   const state = context.state ?? fallbackState$1(context);
 *   if (state?.failure === void 0) return null;
 *   const failure = state.failure;
 *   const node = { kind: "turn-error", seq: failure.seq, time: failure.time, turn: state.turn, ... };
 *   return chatNode(context, "turn-error", node.seq, node);
 * and no hidden/visibility branch left, so keeping the seam would delete native
 * behavior instead of preserving product behavior.
 */
export function adaptHarnessChatSource(source) {
  const change = (before, after, owner) => { source = replaceOnce(source, before, after, owner) }

  change('fileMentions: (owner) => ctx.get("chatFileMentions")?.forClosing(owner, sessionId),',
    'fileMentions: (owner) => emateArtifactFileMentions(ctx, owner, ctx.sessions, sessionId),', 'artifacts/explicit-link-owner')

  // 0.1.5 renders each Chat node through a slot whose provided hook face already
  // carries useChat (the same route TurnTailNodeView uses), so the image
  // projection reads the live Chat snapshot instead of a session-nested one.
  change(T+T+'const AssistantNodeView = (0, react.memo)(function AssistantNodeView({ node, useTurnData, turnProcess, openFile, renderMessageImages, fileMentions, t }) {',
    T+T+'const AssistantNodeView = (0, react.memo)(function AssistantNodeView({ node, useChat, useTurnData, turnProcess, openFile, renderMessageImages, fileMentions, t }) {'+N+T+T+T+'const imageBlocks = useChat(snapshot => emateAssistantImageBlocks(snapshot, node), emateSameAssistantBlocks);', 'images/assistant-owner')
  change('blocks: data.blocks,'+N+T+T+T+T+'streaming: data.status === "running",',
    'blocks: imageBlocks,'+N+T+T+T+T+'streaming: data.status === "running",', 'images/assistant-echo')

  // Image receipts must reach the existing Turn tail before a later model step
  // ends. Keep its native key, renderer and closed-Turn derivation; ordinary
  // file/text Turns still acquire their footer only on turn/end.
  change('function closingAnchor(context) {'+N+T+T+T+'let anchor =',
    'function closingAnchor(context) {'+N+T+T+T+'if (turnLocation(context)?.status === "open") return (context.matches.at(-1)?.event.seq ?? context.start?.event.seq ?? 0) + CHAT_SYNTHETIC_SEQ_OFFSETS.finalizedFollowup;'+N+T+T+T+'let anchor =', 'images/live-tail-anchor')
  change('if (end?.event.type !== "turn/end") return null;'+N+T+T+T+'const turn = turnLocation(context);'+N+T+T+T+'if (turn === void 0) return null;',
    'const turn = turnLocation(context);'+N+T+T+T+'if (turn === void 0) return null;'+N+T+T+T+'if (end?.event.type !== "turn/end") {'+N+T+T+T+T+'if (turn.status !== "open") return null;'+N+T+T+T+T+'const hasImages = context.matches.some(({ event }) => event.type === "tool/call"'+N+T+T+T+T+T+'&& (["generate_image", "edit_image", "get_image_generation_task", "imagegen", "image_batch"].includes(event.data.name))'+N+T+T+T+T+T+'|| event.type === "emate/image-output" && event.data.schema_version === 3'+N+T+T+T+T+T+'|| event.type === "tool/result"'+N+T+T+T+T+T+'&& isAppendSurfaceEvent(event)'+N+T+T+T+T+T+'&& event.data.message.content.some(part => part.type === "tool-result" && !part.isError'+N+T+T+T+T+T+T+'&& part.content?.some(content => content.type === "image")));'+N+T+T+T+T+'if (!hasImages) return null;'+N+T+T+T+T+'const latest = context.matches.at(-1)?.event ?? context.start?.event;'+N+T+T+T+T+'return latest === void 0 ? null : { turn: turn.turn, seq: latest.seq, time: latest.time, closing: null, branchUnavailable: true };'+N+T+T+T+'}', 'images/live-tail-data')
  change('kind: "turn-tail",'+N+T+T+T+'target: "chat",'+N+T+T+T+'match: (event) => {',
    'kind: "turn-tail",'+N+T+T+T+'target: "chat",'+N+T+T+T+'match: (event) => {'+N+T+T+T+T+'if (event.type === "emate/image-output" && event.data.schema_version === 3 && Number.isSafeInteger(event.data.turn) && event.data.turn >= 0 && ["generate_image", "edit_image"].includes(event.data.tool_name)) return { id: String(event.data.turn), role: "update" };', 'images/job-tail-match')

  change(T+T+'function createChatStore() {',
    EMATE_SEAM_HELPERS + '\n\t\tfunction createChatStore() {', 'stores/helper')

  // chat/MessageItem.tsx: native pending steering has no keyed renderer, and
  // 0.1.5 projects every user and steering bubble through the shared primitive,
  // so the display transform belongs on that one projection. Keep its native
  // actions and show the managed filename until the durable node supplies the
  // richer file-import card projection.
  change('(0, _deepseek_ai_dsh_client_ui_primitives.projectUserText)(text, referenceLabels, skillNames)',
    '(0, _deepseek_ai_dsh_client_ui_primitives.projectUserText)(emateFileDisplay(text), referenceLabels, skillNames)', 'message/pending-steering-display')

  return source
}

/**
 * Dropped seam, listed rather than silently deleted. The rc.7 product behavior
 * has no 0.1.5 call site; the assembler must re-implement it at its new owner.
 */
export const CONVERSATION_CHAT_UNRESOLVED_SEAMS = Object.freeze([
  Object.freeze({
    owner: 'artifacts/open-error',
    rc7: 'workspaces.openPath((0, _deepseek_ai_dsh_client_runtime_client.resolveWorkspacePath)(cwd, path)).catch(() => {});',
    native0_1_5: [
      'openFile: async (path, options) => {',
      T+T+T+T+T+'const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd;',
      T+T+T+T+T+'const url = fileAddressFor(sessionId, cwd, path);',
      T+T+T+T+T+'if (options?.line === void 0) ctx.sidebarRight.openResource(url);',
      T+T+T+T+T+'else ctx.sidebarRight.openResource(url, { params: { line: options.line } });',
      T+T+T+T+T+'await Promise.resolve();',
      T+T+T+T+'},',
    ].join(N),
    blocker: 'No client bundle declares workspaces.openPath or the runtime namespace any more; resolveWorkspacePath survives only as a bare local in ui-deliverables and ui-tool for a preview title and a terminal cwd label. The 0.1.5 opener is the synchronous ctx.sidebarRight.openResource(url), which returns no promise, so there is no rejection to catch, and the Chat closure has no session notice outlet: its only ctx.get is "chatFileMentions", and the ui-conversation inputHub shell is not reachable from ui-chat.',
  }),
])
