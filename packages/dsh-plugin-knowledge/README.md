# 企业知识图谱与原生整理

`/knowledge` uses the pinned Profile/Slot owner. `KnowledgeEntry` registers in `sidebar.primary.action` at order 30, after the existing capability entry at 20; `KnowledgePage` occupies `shell.overlay` at -9, using the Desktop sidebar-width variable. It creates no router, user identity system, Agent loop, or parallel knowledge database.

## Root-owned integration

- The native component inventory now includes this package, and the existing managed Profile installer/packager carries it through the shared roster.
- Shell recognizes `/knowledge` as a standalone product page. Conversation body/header/composer are hidden through the existing seats; canvas save guards and authentication routes keep their normal precedence.
- Host reads use `emateIdentity`, `connection`, `webServer`, `timer`. The workflow uses native Agents, Sessions, persistence, subagents, Jobs, Goals and Tools. Xin project calls use `emateXinKnowledge.capture`, never a separate MCP client. Client rendering uses the native slots, connection and modules services.
- Prerequisite identity commit: root `d44ea15` (this worktree cherry-pick `2348401`). Only the exact enterprise knowledge prefix receives the enterprise **access** token. Model and Skill Hub transports retain their original model token. An expired model lease does not invalidate an otherwise active access subject.
- Runtime `three@0.185.1` and dev-only `@types/three@0.185.4` are exact pins. Root installed and owns locks. Native `clientBundle` builds a ~33KB entry and a separate local `/emate-knowledge-assets/graph.js` closure factory. Three is not loaded for an empty corpus or reduced-motion list. Its MIT notice is copied into `lib/licenses` during build.

## Native Host RPC contract

Channel `/emate.knowledge`, authority `loopback`. The outer native response is `{ok:true,value:{schema_version:1,status:"success",value:{scope_key,result}}}` or `{ok:true,value:{schema_version:1,status:"failure",error:{code,message}}}`. This follows the existing Skill Hub business-result pattern: rc.7 transport error codes are closed, so knowledge-specific failures are carried in its business value and parsed once in the client bridge. `scope_key` is a noncredential owner fingerprint; each read captures the current native enterprise principal and checks it again after fully reading the response body. Account changes cancel pending reads and invalidate original-download handles. Same-account token refresh does not cancel an otherwise current read. A cold identity is bootstrapped through the existing identity service before capturing the owner.

The only remote root is `https://mvdcm.ecoremedia.net/ecorex-agent/client/knowledge/v1`. No RPC accepts a URL, token, tenant, user or project override. Renderer never reads credentials or fetches this API directly.

| RPC endpoint | Accepted payload | Existing remote route |
|---|---|---|
| `catalog` | `{}` | GET `/catalog` |
| `graph` | `{root_id?,depth?:0..2,limit?:1..500,corpus_revision?}` | GET `/graph` |
| `sources` | `{kind?,offset?,limit?:1..100,corpus_revision?}` | GET `/sources` |
| `source` | `{source_id,version?}` | GET `/sources/:id` |
| `node` | `{node_id,version?}` | GET `/nodes/:id` |
| `search` | `{question,limit?:1..20,layer?,corpus_revision?}` | POST `/search` |
| `benchmarks` | `{keyword?}` | GET `/benchmark` |
| `benchmark` | existing read-only BenchmarkQuery | POST `/benchmark` |
| `evidence` | `{query_id}` | GET `/evidence/:id` |
| `original` | `{source_id,version}` | GET `/sources/:id/original?version=...` |

Ordinary results preserve the actual API schema, public scope, corpus revision, source identities, status and missing/truncated results. UI requires matching catalog/graph scope and revision; graph nodes are capped at 500 and dangling edges are rejected. Search results retain actual source IDs, hashes and excerpts. A real source outside the returned graph is shown as a source item, with no invented relationships. Graph and list render the same filtered item collection.

Original reads are bounded at20MiB and hashed against the requested version. RPC returns only `{url,sha256,bytes}` for a same-origin, one-time, same-account download handle; it expires and releases bytes after 60 seconds, with at most two retained handles. Original bytes/credentials/host filesystem paths are not serialized into renderer RPC. Filename comes from the validated source response's encoded attachment header.

## Reading and rendering

Only returned nodes/source records become points. Stable hash positions are a visual layout, not relationships or factual strength. White/charcoal star points follow dark/light mode; orange highlights selection and actual adjacent edges. No decorative fake knowledge nodes, production fallback fixtures, background source generation, WebGPU, CDN script/font or extra renderer data fetch is used.

The list contains every item in the current result collection, including when WebGL is absent, context is lost or reduced motion is enabled. On-demand WebGL rendering stops while hidden; disposal releases geometry, textures, controls, observers, frame requests and the context. Pointer movement stays scoped to the graph canvas; keyboard readers select the same items through regular buttons. There is a reset-view control.

Reading pins the selected source version. Returned Markdown is shown as exact selectable text, not evaluated HTML or automatic external image requests. Source metadata/excerpts remain labeled, and full originals use the verified download path. Route departure and the existing `emate:identity-changed` event cancel requests and clear page data; stale results cannot restore an old account or route.

The current page exposes public reading. The Host workflow supports public, uploader-private and Xin project imports/compilations through the existing service receipts. UI actions and Agent Tool registration are still integration work; this source does not claim their installed or production acceptance. `truncated` remains visible when only part of a corpus is returned.

## Native workflow

`createKnowledgeWorkflow` reuses real AgentLoop, Session JSONL, Subagent, Job and Goal owners. It freezes source versions and model selection, writes durable intent before submission, and recovers by the original operation/revision identity. A confirmed missing creation receipt may resend the same frozen request; unknown model submissions are never replayed. Checkpoints use the backend's canonical defaults.

Public compilation runs in a fresh isolated native Agent with only frozen-source reads and structured output. The Host hashes actual quotes and retains leases privately. A known citation rejection permits one bounded correction. Benchmark references select frozen query IDs; the Host supplies a fixed explanation and the service renders each metric/value/unit/period/sample field. Model prose cannot replace those numbers.

`resolveKnowledgeSelection` reads the native session model endpoint, including an unsent composer selection, or the native default for a standalone operation. Enterprise policy validates the model and the existing LLM owner resolves effective thinking effort. `@deepseek-ai/dsh-agent` is an exact rc.7 Base import for `installModelSelection`; no new model configuration store is added.

## Checks

`corepack pnpm run test`, `corepack pnpm run test:client`, `corepack pnpm run check`, and `corepack pnpm run build` use existing pinned Harness tools; package install/lock updates remain root-owned. Host tests cover endpoint scope, owner changes during body streaming, refresh, original hash/download scope and graph validation. Client tests cover empty results, filtering, exact versions, inert raw HTML, canceled routes/details, identity changes, no-WebGL/reduced-motion list and context disposal.

Visual fixtures live only in the untracked `work/knowledge-ui` directory. Their screenshots explicitly label 500 synthetic verification items and are component evidence, not imported production knowledge, installed behavior or release acceptance.
