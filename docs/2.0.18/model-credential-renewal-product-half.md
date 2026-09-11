# Model-connection credential: the product half of `resolveCurrent`

Work order: wire the product credential into the native credential-renewal seam
that landed in the Harness fork at `ff9a977890dafc4fe9b05634470db9a33bc9a3ef`
(`emate/2.0.18-model-credential-renewal`). Until this change the seam operation
was a no-op in production, because nothing overrode it for the credential that
actually rotates — recorded as pending in
`docs/2.0.18/model-connection-native-credential.md`.

## What changed (three files, all uncommitted)

| File | Change |
|---|---|
| `packages/dsh/src/profile/credentials-os.ts` | `OsCredentialProvider.resolveCurrent(ref)`: for `E_MATE_MODEL_SESSION_TOKEN` it asks the product renewal owner to make the value current, then returns the stored value; for every other reference it returns `super.resolveCurrent(ref)`. Also exports `MODEL_SESSION_CREDENTIAL_REF` and `mountProductCredentialProvider` (the composition `apply` mounts, shared with the test). |
| `packages/dsh/src/profile/identity/index.ts` | The `emateIdentity` service exposes `renewModelCredential()`, which is the existing `keepAlive()` → `active()` renewal. Minimal export required: the identity plugin is the only reachable owner of the lease, and it shares no other handle. |
| `packages/dsh/test/model-credential-renewal.test.mjs` | The focused test below. |

## Why this is delegation, not a second owner

- The renewal decision stays where it already lived: `enterprise-provider.ts:811-824` `active()` renews only when `modelGateway.expiresAt` is inside its 60 s margin (:13 `REFRESH_EARLY_MS`), shares one in-flight refresh (:766-809 `refreshing`), and persists the result through the same credential service (:705-727 `save` → `credentials.set(MODEL_SESSION_REF, …)`).
- This change adds **no timer, no cache, no token store, no retry loop**. The only new state is the ref comparison in `resolveCurrent`.
- The owner is looked up per call (`ctx.get('emateIdentity')`) because the profile inserts `emate-credentials-os` before `emate-identity` (`packages/dsh/profile/cordis.patch.yml:85,95`), and `emate-identity` injects `credentials` — an `inject` edge back would be a dependency cycle. Cordis documents `ctx.get` as "read a service from the store without the inject requirement".
- A profile with no identity owner keeps the previous behaviour exactly: the lookup returns nothing, no renewal is attempted, and the stored value is returned.

## Proof

```
cd packages/dsh
../../upstream/deepseek-harness/node_modules/.bin/tsdown                      # exit 0
node --test test/model-credential-renewal.test.mjs                            # 4 pass / 0 fail, exit 0
node --test                                                                   # 156 pass / 0 fail, exit 0 (whole package face)
cd ../.. && pnpm run test:fast                                                # exit 0
```

The four tests, against the real composition (real native seam, real OS-store
class, real identity plugin with a real `createEnterpriseIdentityProvider`, real
`llm-deepseek` adapter, real Agent Loop, real mock provider that accepts only
the renewed bearer):

| Test | Assertion |
|---|---|
| a model request renews an expired product credential once and then succeeds | the turn completes with the expected assistant text; exactly **one** control-plane refresh; exactly **one** model request; wire `authorization: Bearer fresh.gateway.token`; the renewed token is projected back into the store |
| a non-product reference resolves as before and never wakes the lease owner | `DEEPSEEK_API_KEY` authenticates the turn unchanged; **zero** control-plane calls; the product ref is untouched |
| renewal belongs to the resolve-for-use path and runs once per due lease | `resolve` still returns the stale stored value with zero calls; the first `resolveCurrent` renews once; the second costs no round trip; a non-product `resolveCurrent` returns the stored value and source |
| the wiring still targets a seam default the product actually overrides | the bound seam declares `resolveCurrent`; the product class overrides it; `MODEL_SESSION_CREDENTIAL_REF` equals the identity provider's own `MODEL_SESSION_REF` |

Deliberate-break checks (break, observe red, restore, observe green — exit 1 then exit 0):

| Break | Result |
|---|---|
| `resolveCurrent` reduced to `return super.resolveCurrent(ref)` (the seam default) | 2 of 4 red: the model turn produces no assistant text (the provider rejects the stale bearer) and `resolveCurrent` returns `stale.gateway.token` instead of `fresh.gateway.token` |
| `emateIdentity.renewModelCredential()` no longer calls `keepAlive()` | the same 2 tests red — proves the test drives the real identity owner, not a stub |

Measured steady-state cost (20 000 iterations per arm, `performance.now()`, same
process, lease current so nothing is due):

| Arm | p50 | p95 | mean |
|---|---|---|---|
| `resolve(ref)` (previous path) | 0.00092 ms | 0.00158 ms | 0.00109 ms |
| `resolveCurrent(ref)` (new path) | 0.00554 ms | 0.00629 ms | 0.00565 ms |

**+4.6 µs per request, with 0 control-plane round trips** while the lease is
current (measured: the control plane was never contacted during either arm).
A round trip happens only when the lease is inside its own 60 s margin, which
the 30 s keep-alive poll (`identity/index.ts:282-286`) normally prevents.

## Build-state finding (for the main agent)

The seam exists in the pinned fork's **source** and in the emitted modules, but
the **bundled package entry** in this worktree is one build behind:

- `upstream/deepseek-harness/packages/{credentials/credentials,llm/llm-deepseek,llm/llm-pi-ai}/lib/index.js` (the `main`/`exports` entry the runtime and existing tests load) carry **0** occurrences of `resolveCurrent`; their `lib/types/index.js` (the `tsc -b` output) carry it. The entries are stamped 14:49, the modules 17:23 — the fork commit was authored at 17:23.
- The harness build is `tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host` (`pnpm build:lib:host`); only the first half has run since the fork commit.
- The packaging path already fails closed on the resulting drift: `scripts/build-harness-runtime.mjs:44-50` requires `verifyHarnessBuildReceipt`, which currently throws — the stored `.release-cache/harness-build.json` is stamped `d1d095bee7` (older than the pinned `ff9a977`) and five `lib_sha256` entries differ (credentials, llm-deepseek, llm-pi-ai, authorization, web-frontend).

**Action for the main agent (outside this work order's write set): run `pnpm build:harness`.**
It regenerates the entries and rewrites the receipt, after which the new test can
import the package entry directly; today it imports the emitted module
(`lib/types/index.js`) that the entry is bundled from, which is the same compiled
code and the same behaviour.

## Not covered

- `llm-pi-ai` is the adapter the enterprise route actually uses (`model-policy.ts:600` `apiKeyEnv: model.credentialRef`, `api: 'openai-responses'`); the end-to-end test drives `llm-deepseek`, because the pinned mock provider only serves `POST …/chat/completions`. Both adapters call the same seam operation (`llm-pi-ai/src/index.ts:184`, `llm-deepseek/src/index.ts:455`).
- `packages/dsh` is not type-checked by any gate (no `typecheck` script in the root or the package; `packages/dsh/tsconfig.json` has ~100 pre-existing errors). The new member follows the file's existing `Base: any` + `override` style, which that tsconfig reports as `TS4113` for all nine members, the eight pre-existing ones included.
- `pnpm build:harness` and the provenance fixed points remain the main agent's call; nothing in this work order touched `upstream/deepseek-harness`.
