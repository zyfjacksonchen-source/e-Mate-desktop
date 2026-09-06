# Image acceptance for 2.0.18

Run from a clean committed worktree using Node 24. The runners do not install or build anything. The main agent supplies the pinned Harness and current Profile build before the assembled single-image benchmark.

```sh
node tests/performance/image-single/benchmark.mjs --source-smoke
node tests/performance/image-single/benchmark.mjs
node --test tests/performance/image-batch/stress.test.mjs
node tests/performance/image-batch/mixed-admission.mjs
node tests/performance/image-single/project-evidence.mjs open PRIVATE_SINGLE_OPEN_JSON
node tests/performance/image-batch/project-release-evidence.mjs open PRIVATE_BATCH_OPEN_JSON
node tests/quality/image-batch/real-study.mjs open PRIVATE_QUALITY_OPEN_JSON
```

The single benchmark uses deterministic local image bytes and blocks networking. Its comparator is the pinned owners' lower bound, not a native imagegen implementation. Batch stress deliberately injects failures and uses a fixture provider. Mixed admission calls the existing in-memory gateway owner with an injected logical clock; it diagnoses default-three versus explicit-four slot behavior and refill, without a provider. These results do not establish provider latency, UI visibility, production fairness, or real image quality. EM217 evidence retains its historical identity; it cannot close an EM218 manifest.

## Real provider collection

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

The collector directly calls the Gateway, not native `image_batch`. Its direct control precedes each concurrency-four batch; it does not overlap a single request with active batches. It cannot substitute for native Gallery first-visible, mixed-load fairness, cancellation, or restart/recovery acceptance.

Real macOS GUI measurements must use the same fixed set and include per-task `provider_submission_counts` and `provider_billing_counts`, verified from correlated provider/audit records. A batch contains `task_count`, `first_visible_ms`, `all_terminal_ms`, `direct_single_ms`, `terminal_counts`, `successful_images`, `retained_successful_images`, and those two arrays. Count an image as successful only after actual output validation and visibility; failed, cancelled, unknown and interrupted are never successes. Legal-terminal rate is a separate metric. Generation and billing duplication must both be zero.

```sh
node tests/performance/image-batch/project-release-evidence.mjs gui PRIVATE_MEASUREMENTS_JSON PRIVATE_GUI_OUT
node tests/performance/image-batch/project-release-evidence.mjs compose LOCAL_JSON STAGING_JSON PRODUCTION_JSON GUI_JSON PRIVATE_RAW_OUT
node tests/performance/image-batch/project-release-evidence.mjs project RAW_JSON IMMUTABLE_HTTPS_URI OPEN_JSON PASS_OUT
```

## Paired quality study

Supply `EMATE_EVIDENCE_UPSTREAM_MODEL_ID` from the actual fixed route. Prepare at least 30 pairs, at least five per category: `person`, `text`, `product`, `scene`, `style`, `reference-edit`. The private case file has `schema_version: 1`, `evaluator_protocol_commitment_sha256`, and `cases`; each case has `pair_id`, `category`, `prompt`, `references`. Only reference-edit cases contain source file paths. Paired prompts, references, model, quality and size stay identical. The single condition now completes one request before dispatching the next; the batch condition runs the predeclared group of 2–4 cases concurrently and waits for all active siblings. Each new quality execution starts with a fresh `prepare` state; its private allocation/precommit is its request scope and must not be reused as a fresh study after an unknown result.

```sh
node tests/quality/image-batch/real-study.mjs prepare PRIVATE_CASES_JSON PRIVATE_STATE_OUT
node tests/quality/image-batch/real-study.mjs collect PRIVATE_STATE NEW_PRIVATE_IMAGE_DIRECTORY PRIVATE_BLIND_PACKET_OUT
node tests/quality/image-batch/real-study.mjs finalize PRIVATE_STATE PRIVATE_BLIND_PACKET RAW_OUT BLIND_SCORE_JSON
node tests/quality/image-batch/real-study.mjs project RAW_JSON IMMUTABLE_HTTPS_URI OPEN_JSON PASS_OUT
```

Before collect/finalize, set `EMATE_EVIDENCE_PRECOMMIT_SHA256` to the exact prepare-state hash. Independently score concealed A/B images using the precommitted evaluator protocol. The collector does not invent scores. It saves each successful image before another request can fail, waits for active siblings, and refuses an existing output directory. Release analysis requires mean difference >= -0.2 and the two-sided 95% CI lower bound >= -0.3, overall and per category. Legacy 2.0.17 studies retain their minimum of 50 pairs. Both quality conditions are direct Gateway calls: the study tests that controlled provider comparison, not the native Agent prompt preparation, Gallery, mixed workload, or installed restart flow. Those still require actual native evidence.
