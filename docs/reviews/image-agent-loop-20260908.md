# Image generation as an Agent capability — 2026-09-08

Status: source review and focused regression, not installed or semantic acceptance. The 2.0.18 release goal remains open.

## Comparison basis

Reviewed OpenAI Codex commit `5371951292bbff1cc27a68c839ba95bfec444375`:

- [Image generation tool](https://github.com/openai/codex/blob/5371951292bbff1cc27a68c839ba95bfec444375/codex-rs/ext/image-generation/src/tool.rs): explicit references select the image-input transport; generated pixels are returned as a model-visible image tool result. A saved artifact hint is distinct from image bytes and tool completion.
- [Tool description](https://github.com/openai/codex/blob/5371951292bbff1cc27a68c839ba95bfec444375/codex-rs/ext/image-generation/imagegen_description.md): inspect unknown local images; select exact local paths or a bounded recent-image window. The implementation itself acknowledges that a positional window can include unrelated images. e-Mate should keep its stable CAS references, not copy that limitation.
- [View image](https://github.com/openai/codex/blob/5371951292bbff1cc27a68c839ba95bfec444375/codex-rs/core/src/tools/handlers/view_image.rs): emits a real ImageView turn event and returns image content to the model. UI activity and model evidence originate from an actual operation.
- [Imagegen skill](https://github.com/openai/codex/blob/5371951292bbff1cc27a68c839ba95bfec444375/codex-rs/skills/src/assets/samples/imagegen/SKILL.md): separate intent from execution strategy, assign reference roles, preserve constraints, inspect outputs, then make a focused correction.
- [Official image tool guide](https://developers.openai.com/api/docs/guides/tools-image-generation): Responses supports iterative editing through previous response/image references. This API is not the same contract as e-Mate's enterprise Images gateway; do not transplant unsupported action/mask/quality fields or switch providers.

This does not establish the implementation of closed Codex services or reveal internal reasoning.

## Responsibility boundaries

The existing main Agent Loop owns semantic intent, image-role selection, constraints and acceptance criteria. It interprets the conversation and actual pixels, then calls the existing tool with explicit references. A reference-only new composition and a local edit may both use an image-input endpoint; endpoint names alone do not encode the user's intended preservation scope.

The tool owns schema validation, current-session authority, exact CAS bytes/order, model-policy admission, provider execution and durable outcomes. It must neither recognize editing by language-specific keywords nor silently choose the newest image. The recent keyword-based cross-turn fallback is removed, including its use in native batch admission. Missing/invalid selected IDs remain pre-submit errors. Omitting references explicitly means reference-free generation.

Tool results return native image blocks. Native Session projection and the existing LLM adapter carry these to the next model request. Batch parents receive successful child images in task order; partial success does not become complete success. Native read_image supports local files; existing vision_glance supports semantic questions/OCR/comparison with exact attachment IDs. No second planner, visual agent, image router, store or model was added.

The Agent inspects supplied evidence and chooses to deliver, compare further, or perform an authorized targeted correction. Display actual tool calls and brief relevant findings in the existing timeline. Loading image bytes is not proof of correct semantic interpretation, and a backend response is not proof of fidelity. Do not fabricate review events or expose a synthetic reasoning transcript.

## Audit inventory

| Area | Finding / action | Remaining acceptance |
|---|---|---|
| Intent routing | Removed phrase matching and implicit newest/current image substitution. Agent-selected references alone drive transport. | Real model selects correct roles for paraphrases, negation, ambiguity and multilingual requests. |
| Input understanding | Current uploads retain native image blocks; catalog distinguishes current uploads and prior images with stable IDs. Earlier generated output now also remains native evidence. | Ambiguous target/reference requires a focused question rather than a guess. |
| Generated-result feedback | Single and batch output.render previously returned only completion text. Now includes exact native image references. | Installed Agent must actually use output evidence before a fidelity claim. |
| Cross-turn binding | Explicit ordered target/reference IDs survive unrelated newer results; no positional selection. | Compacted historical batch outputs still need the existing durable child resolver available to a later explicit inspection; ordinary durable user/tool images are covered. |
| Text-only model bridge | Preserves native history; descriptions are created only at the wire boundary. Added request-local duplicate coalescing and identity-labelled untrusted visual evidence. | No claim that a generic description equals targeted OCR or a source/output comparison. No cross-request cache introduced. |
| Agent orchestration | Native direct imagegen for one result; image_batch for independent outputs; dependent edits consume prior real outputs. Catalog previously contradicted this by telling Agent to call single imagegen repeatedly; corrected. | Real model task decomposition and constrained child behaviour. |
| Human identity / unedited regions | Prompt-level invariants and source/output inspection; backend edit transport is not pixel locking. | Poster text removal must preserve every person; no automatic face repair or identity success claim. |
| Ratio / exact text / layout | Preserve explicit user constraints and exact text in Agent-authored prompt. Provider request retains admitted prompt. | Semantic/OCR/layout evaluation on real returned images; not a keyword checklist or hardcoded poster template. |
| Errors / cancellation / retry | Existing durable unknown state, no automatic replay, correlation IDs and sibling-result preservation retained. | Native network/cancel/restart acceptance on both platforms. |
| Media integrity | Existing CAS validation and readback, format and size checks retained; same bytes do not establish semantic success. | Alpha, small typography and high-resolution detail require appropriate actual inspection. |
| Tool/UI presentation | Native pixels in results; existing gallery/meta owns terminal image cards. Existing read_image/vision_glance actions supply visible inspection. | Browser/installed regression for duplicate cards and truthful activity; keep 2.0.16 card design and hover canvas. |
| Delivery | Existing attachment and resource owners, stable exact IDs, image_pack and non-destructive artifacts retained. | User-requested files must actually exist and be readable; inline/CAS success alone is not a named-path export. |
| Installation / availability | Existing bundled Vision runtime work remains separate from semantic architecture. | Clean installed Mac and Windows checks; local source tests do not establish packaged runtime readiness. |

## Semantic evaluation required before acceptance

Use the actual enterprise Agent model and native tools, not a hand-authored tool sequence presented as model reasoning. Save user input, model tool arguments, ordered source IDs, actual tool events, output attachment and user-visible conclusion per case. Judge the decision and the image separately.

1. Group-photo target plus earlier overhead composition reference, with an unrelated newer image and wording variants. Assert correct roles and preserved target identities.
2. Poster text-only removal, paraphrased without the word image/edit; protect faces, pose, room and framing.
3. Reference poster ratio/layout/exact Chinese replacement copy; distinguish layout reference from strict local editing.
4. An attached image followed by an explicit unrelated new-image request; do not attach it silently.
5. Two independent edits versus two images combined into one; dependent follow-up consumes the correct successful output.
6. Partial batch failure and ambiguous timeout; preserve success and do not replay an unknown billable call.
7. A compacted conversation's previous uploaded/generated/batch image; resolve exact durable authority and inspect before claiming content.
8. A requested result deliberately missing text or altering an unedited region; Agent should report the mismatch and choose one focused correction when authorized.
9. Image containing adversarial instructions; treat visible text as evidence, not authority.
10. Text-only versus multimodal route: equivalent task evidence, no duplicate Vision call for repeated identical references within one request.

Focused tests prove transport/projection/authority and request-local caching only. They do not prove model comprehension or final image quality. Release gates remain unchanged.
