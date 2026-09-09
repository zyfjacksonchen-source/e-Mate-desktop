# GPT fast mode deployment

This enterprise-only bridge controls the native Sub2API fast-policy setting for
`gpt-5.6-luna` and `gpt-5.6-sol`. The setting applies to the next request;
in-flight responses keep their existing policy. Image and non-GPT routes are
outside this bridge.

## Rebuild the proxy

Use Wei-Shaw/sub2api commit
`99c8e4bf7564823bafbab369acab6539e734c1bb`. Apply
`sub2api-fast-mode.patch` and `sub2api-image-wrapper.patch` to that exact clean
checkout. The image patch uses `gpt-5.6-luna` as the OAuth Responses outer model;
the image tool keeps the requested or native channel-mapped model unchanged.
The fast-mode patch binds policy
rules to the authenticated API-key ID and lets an explicit force rule add
`service_tier: "priority"` when an existing client omitted the field.

Use the upstream frozen frontend lockfile with pnpm 9, then build the embedded
Linux amd64 server with Go 1.26.5, `CGO_ENABLED=0`, `-tags embed`, `-trimpath`,
and the upstream release linker fields (`main.Version`, `main.Commit`,
`main.Date`, and `main.BuildType=release`). Run the patched FastPolicy tests in
`backend/internal/service`, `backend/internal/server/middleware`, and
`backend/internal/handler/admin` before packaging. Also run the native image
Responses builder and OAuth forwarding tests to preserve generation, edit references, streaming and API-key passthrough.

For existing e-Mate clients that request `gpt-image-2-pro`, use Sub2API native
channel mapping for the existing enterprise group to
`gpt-image-2.5-flare`. Keep `billing_model_source=upstream`, no custom prices,
model restrictions disabled, and all unrelated mappings and features intact.
The legacy name is a request compatibility ID, not a fallback. Client policy
must retain its accepted ID until that client supports a new model identifier.
A saved mapping does not prove live image generation: verify the image endpoint
and its upstream model receipt after deployment.

Place the resulting binary as `sub2api` in an empty build context and build it
with `Dockerfile.gpt-fast-mode`. That Dockerfile deliberately retains the
immutable upstream runtime base
`weishaw/sub2api@sha256:85d29bfc69fa7a314cd2a35420dbe2faa6251ccbb3c3d1d4c56c732270e87479`
and adds the capability label checked by the control command. Pin the resulting
image by digest; do not deploy a floating tag.

## Provision the restricted control

Install `gpt-fast-mode-control.py` as root-owned mode `0755` at
`/usr/local/libexec/emate-gpt-fast-mode`. Create root-owned mode `0600`
`/etc/emate-gpt-fast-mode.json` with exactly the authenticated enterprise
tenant ID and its verified positive Sub2API API-key ID:

```json
{"tenantId":"<tenant-id>","apiKeyId":123}
```

Authorize a dedicated SSH public key with a forced command and the management
host's fixed egress address:

```text
restrict,from="<management-egress-address>",command="/usr/local/libexec/emate-gpt-fast-mode" <dedicated-public-key>
```

Mount the matching private key owned by container UID 10001 at mode `0400` and
the pinned proxy host key under `/run/secrets/`. The Analytics container must
reach the proxy only through the required egress network. Add this configuration
to Analytics with no literal key material:

```json
"modelFastMode": {
  "tenantId": "<tenant-id>",
  "sshHost": "<proxy-host>",
  "privateKeyFile": "/run/secrets/gpt-fast-mode-key",
  "knownHostsFile": "/run/secrets/gpt-fast-mode-hosts"
}
```

The forced command rejects other tenants and commands, verifies that the
running proxy has the capability label, validates the configured API key is
active, and updates the whole batch with a PostgreSQL compare-and-swap. Its
append-only audit contains actor and requested model state, never credentials.

## Activate and verify

The deployed proxy composes `docker-compose.yml`, its existing
`docker-compose.override.yml`, and `docker-compose.flare.yml` in that order.
The last native Compose overlay changes only `services.sub2api.image` to the
verified immutable local image digest. Preserve that file in later Compose
invocations; omitting it restores the earlier proxy image. The prior Compose
file list and image digest are recorded alongside the candidate build for
rollback. Native `docker compose up --no-deps --pull never --wait` owns service
replacement and health checks; do not replace the running binary in place.

Deploy the patched proxy first. From the unprivileged Analytics image, verify a
read succeeds through the restricted key and pinned host key. Then deploy the
Analytics image and Admin bundle together. Check authenticated read, individual
and two-model writes, stale-revision conflict, unauthenticated rejection,
cross-tenant rejection, and non-GPT rejection. Correlate a fresh ordinary
request for each managed model with the upstream request record to prove the
policy field was inserted or removed as selected. A provider response reporting
another service tier must be recorded as such; it is not proof of a speed
multiplier.

## Roll back

Disable management writes first. Remove only rules whose `error_message` is
`e-mate:gpt-fast-mode:v1` and whose API-key binding matches this deployment,
using the same compare-and-swap protection. Verify those rules are absent before
starting an unpatched proxy: older Sub2API code does not understand
`api_key_ids` and could broaden a retained rule. Restore the previous proxy
image by digest, then restore Analytics and Admin together. Keep the redacted
audit and deployment image digests in the external release record.
