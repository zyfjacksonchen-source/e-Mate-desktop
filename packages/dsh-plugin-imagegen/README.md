# e-Mate dsh-imagegen host integration

Uses pinned dsh-imagegen 1.5.11 host execution with the existing e-Mate account and fixed `gpt-image-2.5-flare` route. See `SOURCE.md` and `upstream-manifest.json` for attribution and the small host-boundary changes.

Native tools: `generate_image`, `edit_image`, `get_image_generation_task`, and `cancel_image_generation_task`. A generation/edit tool call accepts 1–4 outputs, waits by default, and can run in background mode. Independent calls reuse the upstream queue with a shared budget of four provider requests; a four-output task consumes that existing budget until its provider resources settle. Edit input is exactly one of `source_image` (one complete reference) or `source_images` (1–16 ordered references), returned by generation/query or belonging to actual current-session uploads. Each source is limited to 5 MiB and the total respects the native attachment byte limit.

Model-facing output is JSON text with actual image references and requested/returned/failed counts. Images are saved in native attachment CAS before their `emate/image-output` version 3 Session event is appended. Direct Tool presentation uses the upstream image metadata. Native PTC sub-calls use the same durable image event because rc.7 intentionally omits their presentation metadata. Existing e-Mate components render the image terminal state, gallery and canvas.

A partial response retains each successfully validated image and states the exact missing count and error, including when another output is corrupt or cancellation arrives after an admitted request succeeds. Cancellation joins upstream resource cleanup through native Jobs. Each provider request has its own task/trace/client correlation and a receipt linking its actual response ID and image hash; these are request receipts, not a claim of remote billing settlement. Queries and cancellation are Session scoped. Completed queue payloads and running owner contexts are released after persistence; only 256 terminal cache entries remain. No generated output bytes are inserted into later model messages.

The fixed enterprise route accepts generation size `auto`, `1:1`, `3:4`, `4:3`, `2:3`, `3:2`, `1024x1024`, `1024x1536` or `1536x1024`. Editing accepts only the default size `auto`. Quality and detail remain at the supported defaults (`auto` and the empty string); unsupported values fail before any provider request.

This package adds no sidebar/studio entrance, independent gallery/canvas, settings or API-key screen, prompt rules, automatic retry, model fallback, templates, updater or Agent Loop modification.

Verification (from this package, using the repository's Node toolchain):

```sh
pnpm build
pnpm test:types
pnpm test
```

The 22 tests use pinned rc.7 ToolRuntime, LocalJobRegistry, LocalAttachmentStore and Session with fixture provider responses. A loopback test also runs the actual e-Mate model-gateway router, schema, authorization and InMemoryUsageStore, checking separate request finalization and multi-source edits. These checks establish source/native and local gateway behavior only, not installed behavior, live provider success or remote billing settlement.
