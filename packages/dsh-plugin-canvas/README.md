# e-Mate Canvas

A local multi-page Excalidraw 0.18.1 workspace inside the existing Harness details column. The lightweight client entry registers a service and an open button; only an explicit open or attachment insertion loads the editor factory, stylesheet and same-origin fonts.

## Integration

The main agent owns Profile inventory and Shell Gallery glue. Both host and browser halves must be active. Host injection: `connection`, `workspaceRegistry`, `sessions`, `sessionPersistence`, `attachments`, `sandboxPolicy`, `fs`, `webServer`. Browser injection: `slots`, `modules`, `layout`, `sessions`, `connection`, `conversation`. Local image uploads call the already installed file-import owner's `stage-images` endpoint.

```ts
await ctx.emateCanvas.open(currentSessionId, { projectId: 'main' })
await ctx.emateCanvas.insertAttachment(currentSessionId, ownerSessionId, attachmentId)
```

Gallery may call `insertAttachment` from its hover/focus “画布” button. Pass the real attachment owner session and exact SHA-256 attachment ID. The service resolves the authorized native receipt, flushes any open editor, opens the shared details column and inserts the asset idempotently. Closing restores the previous details slot occupant. It does not declare an Explorer or another Gallery.

## Behavior

Pages support native pan/zoom, images, annotations, title edits, duplication and deletion. Page tabs reorder by drag or keyboard-accessible arrow buttons. Pages marked as slides support fullscreen playback, previous/next, arrow keys and HTML slide export. PNG export uses Excalidraw's renderer. ZIP export includes project JSON and every referenced image's actual bytes, once per attachment hash; import validates every path, hash and image reference before saving a new project.

“交给当前会话” saves a request binding then uses `Session.prompt(..., 'queue')`; current composer drafts are preserved. Image/edit requests use existing image Tools/Jobs. HTML/slides requests ask the Agent's existing file tools to write a unique workspace HTML path. Exact user-message marker, native turn and Tool-call/child-receipt identities determine output insertion. `failed`, `unknown`, cancelled or ambiguous requests never cause automatic generation/replay or invented success. The editor retains imported content hashes, not a parallel task-state store. A native turn containing multiple canvas requests is deliberately not auto-correlated; users can insert verified Gallery results explicitly.

Projects live in `.e-mate/canvas/<id>.json` under the session's canonical registered workspace. The existing `ctx.fs` owns atomic fsync writes and version guards, combined with expected content SHA-256. A previous complete copy is retained as `<id>.backup.json`. Corrupt primary bytes are preserved; readable backup recovery is explicit in the UI. Save conflicts stop auto-save and preserve current edits for export or reload. No localStorage, cloud storage or additional execution transport is used.

HTML runs only in nested opaque iframes with `sandbox="allow-scripts"` and a leading restrictive CSP. The fixed outer frame's `frame-src 'none'` also blocks the project's own location/refresh navigation while allowing its initial inline srcdoc. It has no same-origin privilege, network access, form submission or embedded frames. External links are separately listed and opened only by a user click. HTML is never evaluated by the host. Project size/page/image bounds are enforced at the RPC trust boundary.

## Checks

From this package, with the main-agent-prepared pinned dependencies:

```sh
../../upstream/deepseek-harness/node_modules/.bin/tsdown
../../upstream/deepseek-harness/node_modules/.bin/tsc -p tsconfig.json
node --test test/*.test.mjs
../../upstream/deepseek-harness/node_modules/.bin/vitest run --config vitest.config.ts
```

`browser.test.mjs` uses a real local Chrome and the compiled native factory, with all non-fixture origins blocked. Set `EMATE_CANVAS_BROWSER` to an existing Chromium executable when needed. It proves local browser component behavior, not installed Desktop or provider acceptance. Generated code/assets and `.test-artifacts/` remain untracked. Main-agent integration still verifies Gallery entry hover/focus, native production results, the shared details lifecycle and installed macOS/Windows behavior.
