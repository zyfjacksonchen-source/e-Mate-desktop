# 2.0.18 message flow plugin review

Base: `ff4062c071c266105db043a0d5933a75d8927dbe`. Worktree: `emate-2.0.18-message-flow`. All behavior lives in the existing `emate-shell` Profile plugin; no DSH source, transport, agent loop, lockfile, Desktop, image catalog or release changes.

The compact mode now renders one turn activity disclosure containing native reasoning, progress prose and ToolCallTree children. The latest progress text labels the disclosure. The trailing natural-language answer remains native outside it, including while streaming; admitting a following tool moves its preceding prose into the disclosure. Manual expand/collapse persists through streaming and native settlement in the same runtime. Detailed mode still retires the plugin shadows and restores native views.

Running titles and nested native tool rows use a 2s `steps(48,end)` text shimmer, with 50% × 200% gradient and background-position −100% → 250%. The previous 2.6s native tool glare is suppressed only inside this disclosure. Completed turns stop animation; failed/interrupted turns show an explicit label. An orphaned running call at a closed turn is treated as stopped, not successful. Reduced-motion/forced-colors retain readable nonanimated text. Old domino markup, brain icon and “思考中” branding are removed. rc.7 hardcodes TurnStatus outside slots, so a narrowly scoped reversible presentation adapter still relabels that fallback and hides it when the running disclosure exists. Its native clock, event owner, scrolling and approval owner remain unchanged.

Selected text exposes an anchored “添加到聊天” action. The action inserts a real native InputTrigger reference occurrence, guarded by session identity, input phase and draftRev. Its codec serializes the full selected text into the prompt, and projects full text to clipboard/persistence. Undo/redo, image ids and existing draft text remain native. It does not send automatically. Existing generated-image hover/add-to-chat paths remain intact: owner.readAttachment → identity/MIME/bytes and live limits → createDraftImages → input.addImages → native sendSession base64 image content. No URL-only image placeholder was added.

## Reference evidence

Only locally accessible static application resources were read from `/Applications/ChatGPT.app/Contents/Resources/app.asar` on 2026-09-08. They were not modified or committed.

- `webview/assets/app-initial-5b0a474bff5e.css`: `loading-shimmer-pure-text` duration, stepped timing, gradient, hover and reduced-motion rules.
- `webview/assets/split-items-into-render-groups-57548326ecf1.js`: separates agent activity and trailing assistant answer; keeps tool outputs separate; does not replace event history with summary text.
- `webview/assets/app-primary-6cd7b8b3f5e3.js`: `selectedTextOverlay.addToCodex`, selection-anchored add callback and prevention of mousedown selection loss.
- Local hashes: `work/2.0.18/message-flow/reference.json` (not committed).

These sources support specific behavior/animation parameters. They do not establish pixel-for-pixel equality with the installed Codex UI.

## Verification

Run in `packages/dsh/profile/plugins/emate-shell` with the existing pinned runtime on PATH:

```
../../../../../upstream/deepseek-harness/node_modules/.bin/vitest run tests/activity-fold.client.spec.tsx tests/chat-context.client.spec.tsx tests/chat-fidelity.client.spec.tsx tests/image-gallery.client.spec.tsx
../../../../../upstream/deepseek-harness/node_modules/.bin/tsdown
```

81 tests passed across 4 files; plugin client/server bundle build passed. Error stacks in tests.log are intentional atomic-renderer/slot-assembly error-injection tests, not unhandled failures. Tests import the changed plugin source from this worktree; fixed rc.7 sources are locally checked out and existing dependency/native lib outputs are read-only reused from integration. New plugin build output exists only in this worktree.

Coverage includes streaming/final placement; parent/child folding; keyboard toggle; runtime remount; native atomic tool failure/retirement and assembly-error propagation; interrupted boundary handling; text occurrence insertion, native serialization, undo/redo and stale-session/busy refusal; generated-image hover, child ownership, concurrent read admission, refusal cleanup; native image bytes reaching session.prompt and draft retention on rejected prompt.

Browser check at `http://127.0.0.1:5188` used actual changed plugin components plus native AssistantNodeView/ToolCallTree with fixed local event inputs. Observed: one collapsed progress row; expanded tools beneath it; fallback status display:none; native tool pseudo-glare content:none; new tool animation 2s/steps(48); completed animation count 0; dark stopped label; actual drag selection produces add toolbar and clicking dismisses it. Browser fixture's textarea is only a visual callback target; the real native reference/send behavior is proved by the native-facade tests, not by this textarea. Temporary reproducible fixture: `/tmp/em218-flow-preview`.

Local logs: `work/2.0.18/message-flow/tests.log`, `build.log`. Browser screenshots are in the development task's tool outputs; they are local component evidence, not installed acceptance.

## Open acceptance

Computer Use explicitly denied access to Codex (`com.openai.codex`), and no alternative UI capture/control route was used. Side-by-side installed Codex motion/shape/interaction acceptance remains OPEN, including pixel metrics, easing of disclosure transitions, exact rich-reference appearance, complete installed composer behavior, both installed platforms and real-user acceptance. The standalone browser fixture is not a screenshot of Codex or an installed e-Mate build. Main task must integrate/review and run the agreed same-source installed acceptance; this change does not authorize packaging, installation or publication by this task.
