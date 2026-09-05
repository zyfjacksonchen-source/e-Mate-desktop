# Xiaoxin resource production handoff

No runtime artwork is included yet. Do not create repeated/static tiles to satisfy this contract.

Canonical legal reference (read-only):
`/Users/mac/e-mate/worktrees/emate-2.0.18-integration/packages/dsh/profile/plugins/emate-shell/assets/xiaoxin-avatar.png`

Use the hatch-pet skill and its imagegen workers. Preserve this Xiaoxin identity; never import upstream dsh/aliang or installed Codex atlases. The main agent owns image generation, manifests, final QA and release. Do not render text, grids or scene labels into cells.

Deliver these four exact files in this directory:

- `xiaoxin-v2.webp`: 1536×2288; 8×11 cells, each 192×208. Rows 0–8 follow hatch-pet's exact counts/timing. Rows 9–10 contain 16 clockwise look directions, starting 000° up, 90° right, 180° down, 270° left. Transparent unused cells and sprite surroundings.
- `xiaoxin-v2.json`: strict `BaseManifest` from `src/assets.ts`: schemaVersion 1, id xiaoxin, displayName 小芯, spriteVersionNumber 2; exact atlas geometry, actual file bytes and SHA-256; nine ordered animations with the exact timing table in `src/client/pet-animation.ts`; directions `[0,22.5,...,337.5]`.
- `xiaoxin-office.webp`: 1536×6240; 30 rows × 8 frames; identical 192×208 geometry. Every scene is a distinct complete eight-frame action cycle. Keep identity, scale and registration stable; props must remain physically attached/in the same frame. Each scene is generated independently from the approved Xiaoxin reference, never synthesized by tiling one idle frame.
- `xiaoxin-office.json`: strict `OfficeManifest` from `src/assets.ts`: schemaVersion 1, id xiaoxin-office, baseSha256 matching the final v2 bytes; actual extension atlas bytes/SHA; exactly 30 ordered `scenes` with `id`, zero-based `row`, `frames:8`, eight integer `durationsMs` (80–2000 each). Suggested complete-loop timing is `[140,140,140,140,140,140,140,260]`.

The exact office row order/labels are `src/scenes.ts`. They retain all S33 scenarios: startup, requirements, planning, file-search, document-read, code-write, terminal, build, test, debug, code-review, web-search, browser, form-fill, download, data-analysis, spreadsheet, document-write, slides, pdf-read, image-generate, image-edit, canvas, meeting, upload, waiting, queue, goal, delivery, error.

After both real WebP files exist, `node --experimental-strip-types scripts/write-manifests.ts` writes the exact manifest structure and actual byte hashes. It does not generate art or approve it.

Validation is cumulative:

1. Run hatch-pet's standard atlas/despill pipeline, contact sheets, motion previews, 16-direction semantic and isolated blind QA. Never package an 8×9 intermediate as v2.
2. Run `node --experimental-strip-types scripts/validate-assets.ts`: both manifests, hashes, sizes and static WebP geometry must pass. Missing art fails this command.
3. Call `load_workspace_dependencies`, then use its exact Python executable for `scripts/validate-pixels.py`: all used cells nonempty, all unused standard cells transparent, no border clipping, no static repeated rows. This does not substitute for the hatch-pet checks or semantic review.
4. Independent 30-scene blind review and normal 112 CSS px motion review must confirm the requested action, real motion, identity, transparent edges and complete loops.
5. Main agent verifies foreground/background/reduced-motion pause, offline recovery, native state agreement, and TTFT/CPU/GPU/heap A/B on real platforms.

Runtime fallback is deliberately asymmetric: a missing/invalid office extension uses an already validated standard v2 atlas; missing/invalid standard v2 renders no pet and reports unavailable resources in Settings. The original static avatar is never substituted for completed animation assets.
