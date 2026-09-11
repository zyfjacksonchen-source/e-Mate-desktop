# Source provenance

Code baseline: `npc-dao/dsh-pet@f501139cfb155fd46717a79bb1c158da064dce15` (MIT, retained in LICENSE). The upstream LICENSE explicitly excludes `assets/dsh/spritesheet.webp` and `assets/aliang/spritesheet.webp`; neither file was checked out, copied, referenced at runtime or admitted to this component. No Codex preset/ASAR discovery or external catalog is retained.

Adapted code: `src/client/index.ts` (same overlay/Settings host), `PetOverlayRoot.tsx` (same child seat), `PetOverlay.tsx`/CSS (window-local bounded drag and keyboard motion), `PetSprite.tsx`/CSS and `pet-animation.ts` (timed cells and standard animation semantics). Catalog transport is replaced by fixed offline component assets; native Settings owns position/toggle persistence. No second host or renderer is created.

Harness contract: `8cc7914c51a063cd2b851a9eb956c72b4c16471b`, rc.7. Read-only native adaptation follows `packages/client/runtime/src/client/sessions/{service,session,conversation,projection-store}.ts`, native Goal/Todo types, `packages/host/apiproxy/src/api/jobs.ts`, ToolCallView presentation discriminants and the existing current-turn `deliverables` Chat projection used by e-Mate Shell. Browser Page Visibility and focus/blur are the native pause signals; the adapter does not fabricate a distinct minimized-window state. Visual and real-platform behavior remains subject to main-agent acceptance.

Xiaoxin artwork reference is user-owned existing e-Mate art specified in `assets/PRODUCTION.md`; no sprite artwork is synthesized or claimed by this code task. Raster generation and independent visual QA belong to the main agent's hatch-pet production workflow.
