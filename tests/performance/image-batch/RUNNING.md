# Image acceptance for 2.0.18

Run from a clean committed worktree using Node 24. The runners do not install or build anything. The main agent supplies the pinned Harness and current @e-mate/dsh-plugin-imagegen build before the assembled single-image benchmark.

```sh
node tests/performance/image-single/benchmark.mjs --source-smoke
node tests/performance/image-single/benchmark.mjs
node --test tests/performance/image-batch/stress.test.mjs
node tests/performance/image-batch/mixed-admission.mjs
node tests/performance/image-single/project-evidence.mjs open PRIVATE_SINGLE_OPEN_JSON
node tests/performance/image-batch/project-release-evidence.mjs open PRIVATE_BATCH_OPEN_JSON
node tests/quality/image-batch/real-study.mjs open PRIVATE_QUALITY_OPEN_JSON
```

The single benchmark uses deterministic local image bytes and blocks networking. Its comparator is the pinned owners' lower bound, not a native imagegen implementation. Batch stress runs 160 groups through actual native Tools/Jobs/queue/CAS/Session with a fixture provider: 2/4/5/8 each have 40 groups, and 5/8 compose [4,1]/[4,4] using the four-slot native queue. Mixed admission calls the existing in-memory gateway owner with an injected logical clock; it diagnoses three versus four occupied slots and refill, without a provider. These are explicit occupancy scenarios, not a removed default-three scheduler. These results do not establish provider latency, UI visibility, production fairness, or real image quality. EM217 evidence retains its historical identity; it cannot close an EM218 manifest.

## Real provider collection

Current 2.0.18 collection uses the fixed `gpt-image-2.5-flare` route for both the actual request and its private execution/precommit metadata. The shared release identity keeps historical 2.0.17 on its original model; `contract.json` remains the historical keyless fixture. Do not change the product route to accommodate old evidence. An old 2.0.18 quality precommit containing `gpt-image-2-pro` is rejected before dispatch; do not relabel or replay it.

The main agent supplies these environment variables through the existing secure environment, without putting their values in commands or logs:

- `EMATE_EVIDENCE_GATEWAY_URL`: fixed HTTPS `/v1` endpoint.
- `EMATE_EVIDENCE_SESSION_TOKEN`: authorized session credential.
- `EMATE_EVIDENCE_DEPLOYMENT_FINGERPRINT_SHA256` and `EMATE_EVIDENCE_ENVIRONMENT_NAME`: the actual deployment identity.
- `EMATE_EVIDENCE_LAYER`: `staging` or `production`.
- `EMATE_EVIDENCE_PROMPTS_FILE`: private JSON string array, at least 17 prompts for three 4/5/8 runs.
- `EMATE_EVIDENCE_OUTPUT`: new private JSON path.
- `EMATE_EVIDENCE_RUNS`: 3..1000, default 3.
- `EMATE_EVIDENCE_429_PROBE`: `1` only for controlled staging configured to accept exactly four probe submissions and reject one before provider dispatch.

```sh
node tests/performance/image-batch/real-provider-benchmark.mjs
```

Before its first request, the runner reserves a new `EMATE_EVIDENCE_OUTPUT.images` directory and fsyncs/readbacks `execution.json`. This private receipt binds a fresh random execution ID to the release, deployment, fixed task set, and every planned direct/batch/probe request header. The fixed task-set hash stays unchanged across staging and production; execution request IDs never overlap. `started.json` is an exclusive durable claim, so invoking the same prepared execution again fails before any request. A missing or changed receipt also fails closed. The one accepted typed-429 retry keeps the original request identity and body.

Successful bytes are immediately written and read back in that directory, including direct controls. Keep the full private directory with the public raw report: `execution.json` and `started.json` are the audit correlation evidence, not optional disposable caches. A partial or unknown run is never automatically resumed or replayed. Resolve unknown provider outcomes against its committed request IDs before deciding on an explicit fresh execution with a new output path; do not delete receipts to reuse an old directory. Invalid responses stop queued dispatch, while already active successful siblings are retained before the runner fails. The shareable report's strict timing/count/hash schema is unchanged.

The collector directly calls the Gateway, not native `generate_image` Tools. Its direct control precedes each concurrency-four batch; it does not overlap a single request with active batches. It cannot substitute for native Gallery first-visible, mixed-load fairness, cancellation, or restart/recovery acceptance.

Real macOS GUI measurements must use the same fixed set and include per-task `provider_submission_counts` and `provider_billing_counts`, verified from correlated provider/audit records. A batch contains `task_count`, `first_visible_ms`, `all_terminal_ms`, `direct_single_ms`, `terminal_counts`, `successful_images`, `retained_successful_images`, and those two arrays. Count an image as successful only after actual output validation and visibility; failed, cancelled, unknown and interrupted are never successes. Legal-terminal rate is a separate metric. Generation and billing duplication must both be zero.

The GUI projector does **not** infer installed source from this checkout. Before projection, supply:

- `REVIEWED_PROVENANCE_JSON`: exactly `emate_commit`, `harness_commit`, `desktop_reference`, and `version`. These must describe the actually measured installation (for example source94), not this runner's HEAD. Harness/Desktop pins remain the protocol's exact pins and version must be `2.0.18`.
- `SOURCE_INSTALL_RECEIPT`: the original reviewed installation receipt with `source_commit`, `installed_app`, and `full_file_hashes_match: true`, such as the existing full candidate-to-install verification receipt. Keep its original build/source evidence alongside it. A DMG record marked `installed: false` is insufficient. Source-to-build attribution is a reviewed input; this command does not automatically discover the source commit.
- The actual absolute `.app` path and exact completed measurements JSON. Keep the installation unchanged throughout collection and binding. The binding hashes the full bundle, including unpacked Profile content and internal symlink targets, and binds the raw installation receipt plus measurement bytes. Projection verifies these again once for the complete dataset, not per batch. Missing input, changed bytes, an escaping symlink, or a different source/app receipt fails closed.

```sh
node tests/performance/image-batch/project-release-evidence.mjs bind-installed PRIVATE_MEASUREMENTS_JSON /Applications/e-Mate.app REVIEWED_PROVENANCE_JSON SOURCE_INSTALL_RECEIPT PRIVATE_INSTALLED_BINDING_JSON
```

Set `EMATE_EVIDENCE_INSTALLED_RECEIPT` to the absolute binding path and `EMATE_EVIDENCE_INSTALLED_RECEIPT_SHA256` to the exact `receipt_sha256` printed above. Retain the private binding and original installation receipt with the raw measurement evidence. The binding is content verification, not proof that the GUI was observed; real first-visible collection remains mandatory. The public schema is unchanged. Compose still rejects mismatched source provenance across layers: a source94 installation cannot be relabeled as the current checkout to compose with unrelated source measurements.

```sh
node tests/performance/image-batch/project-release-evidence.mjs gui PRIVATE_MEASUREMENTS_JSON PRIVATE_GUI_OUT
node tests/performance/image-batch/project-release-evidence.mjs compose LOCAL_JSON STAGING_JSON PRODUCTION_JSON GUI_JSON PRIVATE_RAW_OUT
node tests/performance/image-batch/project-release-evidence.mjs project RAW_JSON IMMUTABLE_HTTPS_URI OPEN_JSON PASS_OUT
```

## Paired quality study

Supply `EMATE_EVIDENCE_UPSTREAM_MODEL_ID=gpt-image-2.5-flare` only after verifying that actual fixed route. Current prepare/collect requires it to match the fixed model sent by the runner; it is not an override. Prepare at least 30 pairs, at least five per category: `person`, `text`, `product`, `scene`, `style`, `reference-edit`. The private case file has `schema_version: 1`, `evaluator_protocol_commitment_sha256`, and `cases`; each case has `pair_id`, `category`, `prompt`, `references`. Only reference-edit cases contain source file paths. Paired prompts, references, model, quality and size stay identical. The single condition now completes one request before dispatching the next; the batch condition runs the predeclared group of 2–4 cases concurrently and waits for all active siblings. Each new quality execution starts with a fresh `prepare` state; its private allocation/precommit is its request scope and must not be reused as a fresh study after an unknown result.

```sh
node tests/quality/image-batch/real-study.mjs prepare PRIVATE_CASES_JSON PRIVATE_STATE_OUT
node tests/quality/image-batch/real-study.mjs collect PRIVATE_STATE NEW_PRIVATE_IMAGE_DIRECTORY PRIVATE_BLIND_PACKET_OUT
node tests/quality/image-batch/real-study.mjs finalize PRIVATE_STATE PRIVATE_BLIND_PACKET RAW_OUT BLIND_SCORE_JSON
node tests/quality/image-batch/real-study.mjs project RAW_JSON IMMUTABLE_HTTPS_URI OPEN_JSON PASS_OUT
```

Before collect/finalize, set `EMATE_EVIDENCE_PRECOMMIT_SHA256` to the exact prepare-state hash. Independently score concealed A/B images using the precommitted evaluator protocol. The collector does not invent scores. It saves each successful image before another request can fail, waits for active siblings, and refuses an existing output directory. Release analysis requires mean difference >= -0.2 and the two-sided 95% CI lower bound >= -0.3, overall and per category. Legacy 2.0.17 studies retain their minimum of 50 pairs. Both quality conditions are direct Gateway calls: the study tests that controlled provider comparison, not the native Agent prompt preparation, Gallery, mixed workload, or installed restart flow. Those still require actual native evidence.


## Current native execution and second-round handoff

The single worker uses schema 2 with `dsh-imagegen-1.5.11-native-tools-jobs-session-v3`; the local multi-image layer uses schema 3. Historical single/batch cohorts are not retagged. `contract.json` and `baseline.test.mjs` remain the frozen 2.0.16/EM217 reference and are not current source proof.

The single-image ABBA ordering, three fresh processes, warm/cold small/max pair counts, 0-versus-256 history samples, every p95/p99 threshold, and 100-sample actual GUI/500 ms threshold remain unchanged. The native execution order is provider/response/CAS, durable Session receipt handoff, then native Job completion; the return/terminal timestamps are measured, never reassigned to fit the removed implementation. The old automatic typed-429 retry mechanism is superseded by native safe failure: one refused request, failed Job/receipt, no generated image, and no repeated submission of that Tool call. The independent real Gateway retry probe remains a transport-control gate, not a claim that the plugin retries.

The current batch local layer measures first completed **native receipt**, per-Tool terminal time and all-terminal time; these are not historical child-Agent metrics or actual UI first-visible. Its all-terminal p95 remains below 250 ms. Source output is still DIRTY during development and cannot close the CLEAN same-source evidence requirement. The main agent owns temporary dependency links, builds, installs and the second round; no test rewrites them.

Run the focused current owner and protocol checks without network/model calls:

```sh
node --test tests/performance/image-single/contract.test.mjs tests/performance/image-batch/native-tool-cohort.test.mjs tests/performance/image-batch/release-evidence-protocol.test.mjs
node --test tests/performance/image-batch/stress.test.mjs
node --experimental-transform-types tests/performance/image-batch/mixed-admission.mjs
```

`native-tool-cohort.mjs` exports `runNativeToolCohort({ ctx, agent, cases, outputDirectory, provenance, signal })`. The main agent supplies an already-authorized native benchmark host/Agent at an entered step; this is a programmatic Tool benchmark, not a conversation-model run. The module does not create a login, transport, Agent, new Tool or batch API. Each case is `{ id, prompt, task_count }`; supported counts are 1/2/4/5/8. One same-prompt direct single control completes before each group; 5/8 invoke real Tools with `[4,1]`/`[4,4]`. The existing queue alone owns admission/refill. No retry is introduced.

The output directory must be new. Before any Tool call, the driver fsyncs and reads back `execution.json` and `started.json`, binding planned Tool call IDs, prompt hashes and the supplied source identity. It retains each actual CAS output and request receipt before proceeding, waits for active siblings after a partial failure, and stops new groups after failure/unknown outcomes. It records actual per-request task/trace/client/provider IDs and image hashes without inventing billing outcomes. Never reuse an incomplete execution's directory or call IDs to trigger another run.

The driver deliberately leaves installed same-source, real first-visible, billing correlation, quality, 100-round fixed-set completion and production latency gates OPEN. Its fixture tests are not real-provider samples. The main agent will supply the live host entry point after the unified build; exact ledger matching, actual image visibility, all latency thresholds and source-to-install binding remain required.

Merge the separate reviewed evidence-runner fixes first (current fixed model, durable precommit/receipt behavior, full installed-tree binding and quality model validation), then this native contract migration. Preserve both changes to this document and both additions to `release-evidence-protocol.test.mjs`. Current single GUI collection reuses that runner's `installedGuiProvenance` helper and fails closed if the helper is not yet present; it never substitutes checkout HEAD for installed source.
