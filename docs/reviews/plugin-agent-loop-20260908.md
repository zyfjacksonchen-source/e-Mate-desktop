# Plugin quality and Agent integration review — 2026-09-08

This review extends the image audit to the 17 packaged plugin adapters plus the product Profile. It is source/contract evidence, not installed acceptance or proof that a real model picks the best tool. Preserve the pinned Harness owners and the 2.0.18 release gates.

## Method

For each capability, follow discovery → schema → authorized execution → result projection → next Agent action → durable recovery/delivery. Plugin quality includes dependency closure, bounded input/output, cancellation, trust boundaries, concurrency and platform support. Agent quality includes understandable capabilities, explicit argument selection, enough returned evidence for the next step, and avoiding unnecessary discovery/planning/verification calls. Search tokenization is retrieval infrastructure, not permission to route user intent by hardcoded phrases.

Do not impose an image workflow on every plugin: a structured data tool should return facts and locators; a visual tool should return pixels or a usable preview; UI-only plugins should not introduce Agent work. Loading, starting, connecting, saving and successfully fulfilling the request are distinct states.

## Confirmed fix

`dsh-plugin-memory-evolve`: remember/search returned public records internally, but output.render discarded memory_id, tags, timestamp and scope. Delete requires an exact memory_id. Automatic recall sometimes carried an ID, but its bounded recall window does not guarantee that every explicitly searched result appears there. The explicit tool chain therefore depended on incidental context.

Remember/search now return the existing public record as model-visible structured JSON. No private scope key/store path is added. The regression takes memory_id from rendered search content, then exercises delete rejection/confirmation and project isolation through existing tools. It does not read the internal execute result to supply the ID. No new memory store, semantic router or approval flow was introduced.

## Inventory and findings

| Adapter | Plugin quality boundary | Agent integration finding / next acceptance |
|---|---|---|
| file-import | Session/workspace binding, original file integrity, ordinary-file validation | Imported paths remain usable native file inputs. Real model must read actual content, not summarize filename metadata. |
| office-skills | DOCX preserves template structures; managed Calc/renderer and artifacts have separate runtime gates | Write completion is not document quality. Use existing read/render/preview to inspect the relevant result; no new Office planning agent. |
| knowledge | Account scope, immutable sources/versions, operation identity and resumable compilation | Tool returns structured source results. Verify real query→evidence→answer and explicit partial/error treatment; no automatic keyword-based expert-mode route. |
| mcp-manage | Existing Host connection, credential references, scoped grants and collected output bounds | Connection status must prove active capability before use. MCP management output stays structured; individual remote tools retain their own output contracts. |
| tool-search | Native per-Agent disclosure, permission intersection, lifecycle/restart isolation | BM25/aliases discover schema; Agent still selects intent and arguments. Existing code-mode disclosure is not wrapped in another search layer. |
| schedules | Projects native schedule events; owns neither timer execution nor schedule store | Task registration versus a real delivered occurrence are distinct. Continue using native schedule tools and status. |
| memory-evolve | Project/session isolation, confirmed mutation and durable store | Fixed lost public locators in model-visible output; bounded automatic recall is not a substitute for complete explicit search results. |
| skill-hub | Immutable identity/digests, allowlisted lifecycle, recovery after lost responses | Start-job result includes its Job ID for native follow-up; Agent must inspect completion rather than say installed/published when merely started. |
| find-skill | Pinned discovery/bootstrap adapter and deployment allowlist | Discovery is not installation or authorization. Avoid repeated discovery when existing capability/status is already known. |
| cdp | Session-bound target, snapshot indices, explicit control grant, bounded snapshots | Observations precede index actions. Preserve real browser events and untrusted page evidence; do not use it as fallback for unrelated missing native tools. |
| computer-use | Platform native helpers, permission/readiness status, current target state | Screenshots/observations guide the next action. Native Mac/Windows action latency and post-action correctness still require installed tests. |
| genui | Pinned runtime/client bundle and resource compatibility | Rendered UI and meaningful user interaction are separate from generating markup. Verify actual artifact behaviour; do not add another Agent Loop. |
| canvas | Native editor and image attachment binding | Explicit canvas edits supply real source/annotation intent. Keep the requested terminal image cards; rendering a canvas is not image edit completion. |
| vision-toolkit | Bundled native runtime, scoped CAS input, model policy and cleanup | Native image results and targeted comparisons; request-local duplicate coalescing. Historical compacted batch inspection remains an explicit image-audit item. |
| better-sidebar | Workspace isolation and session switching | Presentation/navigation adapter; no semantic routing or extra Agent work required. |
| glass-composer | Native composer slots/settings | Presentation-only effects; do not use animation as evidence of Agent work. |
| pet | Native overlay/settings and event projection | Presentation-only status; must not invent reasoning, tools or task completion. |

Profile image tools were reviewed separately. QR already returns a native image block. Share, artifact-open, authentication/model policy and update remain existing Profile/Desktop owners; they require their own operational/installed receipts rather than a generic plugin-success flag.

## Current verification

- Seven core capability groups: 131 tests passed, no failures/skips. Covers tool disclosure, MCP contracts, knowledge Agent/recovery, file import, schedule projection and DOCX preservation.
- Eight platform/discovery/presentation groups: 107 tests passed, no failures/skips. Covers CDP, GenUI, find-skill, composer/sidebar/pet, Skill Hub and Computer Use source contracts.
- Memory correction: 6 tests passed, no failures/skips; initial regression failed against old rendered output before rebuilding the fix.
- Canvas/image/Vision checks are recorded in the image audit and local receipts. These are not an all-platform installed plugin certificate.

Raw local logs: `work/2.0.18/plugin-loop-owner-audit.log`, `plugin-platform-owner-audit.log`, `plugin-memory-loop-fix.log` (before), `plugin-memory-loop-fixed.log` (after).

## Required follow-through

Use the existing installed capability matrix for actual dependencies and real tool calls. For Agent evaluation capture actual model-selected tools, arguments, observations and outcomes: import→read→edit→render; search→source→answer; discover→connect→invoke; remember→search→confirmed delete; schedule→status→actual occurrence; observe→act→verify. Include unavailable capability, empty result, scope change, cancellation and ambiguous timeout. Do not count scripted tool sequences as successful model reasoning. Measure task completion and unnecessary tool/LLM calls alongside latency; no new benchmark runtime is required.
