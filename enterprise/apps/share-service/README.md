# Enterprise session-share service

The service hosts the existing native Session ZIP on the e-Mate enterprise
server. Its only business handler is `../share-worker/src/core.ts`; it does not
create a transcript, HTML viewer, alternate Session store or authentication
authority. The public base is fixed to
`https://mvdcm.ecoremedia.net/e-mate/share`.

## Runtime and persistence

Run `bun src/server.ts` with the existing enterprise Bun runtime. Node 24.10+
also supports the source and is used for focused tests and migration. `pg`
remains pinned to 8.22.0. The root integration owns dependency locks, container
packaging, reverse-proxy configuration and production activation.

- `SHARE_DATABASE_URL_FILE`: a mounted PostgreSQL connection secret. A direct
  `SHARE_DATABASE_URL` is supported for isolated tests; exactly one is required.
- `SHARE_MODEL_VALIDATION_URL`: the existing Model Gateway consent route. On
  the private enterprise network use
  `http://model-gateway/v1/consents/current`. Tokens are validated there for
  every authenticated operation; this service neither issues tokens nor
  accepts unsigned claims without Gateway validation.
- `SHARE_VOLUME`: a durable private directory (default
  `/var/lib/e-mate-share`). Never put it below a public static-file root.
- `SHARE_HOST` / `SHARE_PORT`: default `127.0.0.1:8789`; containers may bind
  `0.0.0.0` behind the enterprise reverse proxy.

The dedicated `emate_share.objects` table preserves original public IDs,
owner/session hashes, metadata and expiry. Archive and owner-index updates
share a PostgreSQL transaction. A per-owner/session advisory lock serializes
create, readback and revoke so concurrent retries return the existing live
link. Public archives are immutable SHA-256-addressed files, streamed through
the service, bounded at 100 MiB, fsynced and atomically linked before commit.
Temporary upload files are removed on normal completion, size rejection and
cancellation. A failed metadata transaction cleans unreferenced published
bytes only after a fresh committed-state read under the digest lock. If the
database cannot resolve an ambiguous commit, bytes remain private until
maintenance can determine their ownership; they must not be blindly deleted.

`/livez` reports process liveness; `/readyz` verifies database and volume.
The `emate_share.service_state` activation row is written only by a successful
snapshot apply, in the same metadata transaction, and records the manifest
digest and imported object count. Until it exists, API and public reads return
`SHARE_DATA_NOT_READY` (503), never a misleading empty list or old-link 404.
`/readyz` reports `data_ready: true` only after checking this row, schema read
permission, volume directory access and sufficient free capacity. The legacy
health routes make the same checks while retaining their exact response shape.
The existing `/healthz` and `/v2/healthz` contracts are retained. Shutdown
rejects new work, drains active requests for up to 30 seconds, then closes the
database. Four active requests, six database connections, a five-minute request
deadline and bounded streaming limit resource use. Maintenance removes expired
metadata and unreferenced archives under the same publication locks. Logs emit
fixed event names and request method only, never tokens, URLs containing share
IDs, archive bytes or SQL parameters.

## Snapshot migration

Before changing the public owner, the main agent must back up the old R2 bucket
and test restoring to an isolated database and volume. Stop writes briefly for
the final snapshot; do not dual-write. All original objects, including owner
indexes, must be enumerated through every R2 cursor and downloaded as bytes.
Preserve R2 custom and HTTP metadata exactly.

The input directory contains `manifest.json` and
`objects/<sha256-of-object-bytes>.bin`. Empty index objects use the SHA-256 of
the empty body and still have an input file. Manifest shape:

```json
{
  "schema_version": 1,
  "source_bucket": "emate-session-shares",
  "objects": [{
    "key": "shares/0123456789abcdefghijklmnopqrstuv.zip",
    "size": 4,
    "sha256": "<64 lowercase hex characters>",
    "customMetadata": {
      "owner_sha256": "<original hash>",
      "session_sha256": "<original hash>",
      "created_at": "2026-09-01T00:00:00.000Z",
      "expires_at": "2026-09-08T00:00:00.000Z"
    },
    "httpMetadata": { "contentType": "application/zip" }
  }]
}
```

With the database secret file and volume environment configured, run
`node src/migrate.ts --check /private/snapshot` before `--apply`. Check mode
initializes the empty schema if necessary, streams and hashes every input,
verifies any previously imported identities, and removes all staging files;
it writes no object metadata, activation row or published archives. Its receipt
reports `data_ready: false`. Apply commits the complete
metadata set and activation row atomically after exact metadata readback; its
receipt reports `data_ready: true`. Replay verifies bytes
and unchanged public IDs, owner/session, dates and metadata; a mismatch fails
instead of overwriting. Failure returns `verify_database_before_retry` because
a lost COMMIT response is not evidence of rollback.

After validated migration, route the enterprise prefix to this service and
enable only the old Worker's fixed `SHARE_SERVICE_BASE` forwarder. Old
`/s/<id>` links stay valid, while business operations and archive reads use
the single enterprise owner. Confirm real authenticated creation, old and new
public reads, ZIP byte hashes, restart recovery, expiry and revoke from both
clients and a mainland-China network before declaring migration complete.
Retain the pre-cutover snapshot and database/volume backups for rollback.

## Focused validation

`node --test tests/service.test.ts ../share-worker/tests/index.test.mjs` runs
offline stream, size, cancellation, metadata-failure, commit-loss, snapshot,
auth configuration, old-client and enterprise-prefix checks. `tsc --noEmit`
checks the shared handler and service together.

`SHARE_TEST_DATABASE_URL=<isolated PostgreSQL URL> node --test tests/postgres.test.ts`
checks actual concurrent creates, owner isolation, revoke and deliberately
lost COMMIT response recovery. This opt-in test creates only synthetic users
and exact scoped object keys; never point it at production. Offline fixtures
do not replace this check, server migration evidence, installed Desktop usage
or mainland access acceptance.
