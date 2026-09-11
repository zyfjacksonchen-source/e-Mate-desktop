# Model-connection credential: native resolution for use

Work order: add a model-connection call optimization that uses DSH native model
access instead of a home-grown one, and wire authentication, recovery, retry and
immediacy properly. Baseline: `upstream/deepseek-harness` @ `8cc7914c51a063cd2b851a9eb956c72b4c16471b`.

## Verdict per ask

| Ask | Ruling | Decisive evidence (submodule paths, pinned revision) |
|---|---|---|
| (a) authentication | **NATIVE GAP** — closed by this change | `packages/credentials/credentials/src/index.ts:183` resolve is the only read; the seam had no operation that renews a rotating value. `packages/llm/llm-pi-ai/src/adapter.ts:348` and `packages/llm/llm-deepseek/src/adapter.ts:479` resolved once per stream call from the stored value, and `packages/credentials/credentials/src/index.ts:269-271` publishes `credentials/reference-updated` with no model-path consumer. |
| (b) recovery after a dropped stream | **NATIVE ALREADY COVERS IT** — unchanged | `packages/core/agent-loop/src/agent.ts:441-464` (waterfall, `{kind:'retry'}` → `continue`) and `packages/llm/llm-retry/tests/transport-recovery.spec.ts:113-148` (dropped stream retried, failed chunks not committed), `:87-111` (refused connection), `:202-221` (stall → TIMEOUT), `:223-246` (budget exhausted). |
| (c) retry / backoff | **NATIVE ALREADY COVERS IT** — unchanged | `packages/llm/llm/src/retry-policy.ts:14-24` defaults (maxRetries 5, 500 ms → 10 s, jitter 0.1, codes `EMPTY_RESPONSE RATE_LIMIT SERVER TIMEOUT TRANSPORT`), resolved per route at `packages/llm/llm-pi-ai/src/config.ts:344,496`; executor `packages/llm/llm-retry/src/index.ts:59-64,194-241` (durable `llm/retry` before a cancellable wait). |
| (d) immediacy | **NATIVE ALREADY COVERS IT** — unchanged | `packages/llm/llm-deepseek/src/adapter.ts:651` is a bare global `fetch` — no client, agent or pool per request; SSE end-to-end with the first token emitted synchronously at `packages/core/agent-loop/src/assistant-stream.ts:63`; no mutex, semaphore, queue or single-flight on any model call. |
| (e) e-Mate on top | product-specific, one divergence | `packages/dsh/src/profile/identity/enterprise-provider.ts:657,811-824` keeps the enterprise lease in memory and renews on its own schedule; `packages/dsh/src/profile/identity/index.ts:282-286` polls it every 30 s. It duplicates no native transport, retry, pool or registry — the divergence is that the native model request path cannot ask it to renew. |

## What changed (fork commit)

One seam operation, used by both adapters:

- `packages/credentials/credentials/src/index.ts` — `CredentialProvider.resolveCurrent(ref)`, the value a request must authenticate with now. The concrete default is `return this.resolve(ref)`, so every existing provider keeps its stored-value behaviour and no subclass breaks.
- `packages/llm/llm-pi-ai/src/index.ts` and `packages/llm/llm-deepseek/src/index.ts` — the per-stream credential read goes through `resolveCurrent` instead of `resolve`.

Because `packages/core/agent-loop/src/agent.ts:361-362` re-prepares the request inside the retry loop, each attempt now resolves again and authenticates with a credential issued for that attempt.

## Proof

Focused spec `packages/llm/llm-retry/tests/credential-renewal.spec.ts` (4 tests, real agent loop + real adapter + real credentials seam over a local HTTP server):

| Test | Assertion |
|---|---|
| sends the value the provider made current | wire `authorization` is the renewed value, not the stored one |
| authenticates a retried attempt with the credential renewed for it | attempt 1 `Bearer token-1`, attempt 2 `Bearer token-2`, `llm/retry` failure `TRANSPORT`, turn completes |
| keeps the stored value for a provider that renews nothing | regression guard for the seam default |
| fails the attempt instead of falling back when renewal is unavailable | zero requests on the wire, turn ends in error |

Deliberate-break checks (behaviour broken, observed red, restored):

- adapter back on `credentials.resolve(ref)` → 3 of 4 red (both renewal tests and the failure test), including `expected [] to deeply equal [ 'token-1' ]`.
- seam default returning `undefined` instead of `this.resolve(ref)` → the regression-guard test red.

Measured (400 iterations per arm, first-token latency through the real adapter against a local mock server, `performance.now()`, same process):

| Arm | p50 | p95 | mean |
|---|---|---|---|
| seam default (no renewal) | 1.5774 ms | 2.7681 ms | 1.6853 ms |
| per-request renewal | 1.5857 ms | 2.3231 ms | 1.7251 ms |

Seam call alone (20 000 iterations): p50 0.0084 ms → 0.0087 ms. The change costs **+0.0003 ms per request** when nothing needs renewing. Where the stored value is stale the previous behaviour was a terminal `AUTH` failure (zero requests on the wire); it is now one renewal plus a completed request.

## Pending product half (not written: outside this work order's write set)

`packages/dsh/src/profile/credentials-os.ts` should override `resolveCurrent` on `OsCredentialProvider`: for `E_MATE_MODEL_SESSION_TOKEN` delegate to the identity provider's `keepAlive()` (whose `active()` at `enterprise-provider.ts:811-824` already renews at its 60 s margin and single-flights the refresh), and for every other reference delegate to `super.resolveCurrent(ref)`. Until that lands the seam operation is a no-op in production and the model path keeps today's behaviour.
