# Skill Hub service

Same-server Skill Hub API using PostgreSQL and a persistent content-addressed ZIP volume. Business rules, archive validation, ownership signatures and response shapes come from `../skill-hub-worker/src/core.ts`; the Worker can forward the existing API prefix to this service after migration.

Run from the repository root with the pinned enterprise dependencies installed:

```sh
bun enterprise/apps/skill-hub-service/src/server.ts
```

Provide `SKILL_HUB_DATABASE_URL_FILE`, `SKILL_HUB_AUTHOR_KEY_FILE`, `SKILL_HUB_MODEL_VALIDATION_URL`, `SKILL_HUB_VOLUME` and `SKILL_HUB_SCHEMA`. Secret values can instead be supplied through the corresponding variables without `_FILE`, but each secret must have exactly one source. Preserve the original author key byte for byte. The default listener is `127.0.0.1:8788`; a container may explicitly set `SKILL_HUB_HOST=0.0.0.0` behind its existing proxy. Use a dedicated database role and the same filesystem UID/GID for migration and serving.

The service requires an activated migration receipt and matching key fingerprint. It does not initialize an empty market. `/livez` checks the process independently of business capacity. `/readyz` checks activation, database access and volume capacity with one probe and a nonblocking shared lock; it reports busy without waiting for writers. Full package integrity belongs to migration/restore readback and downloads, not health polling. Existing clients retain `/ecorex-agent/client/skill-hub/v1/...` and `/healthz`. Errors emit fixed JSON event names without SQL, URLs, tokens, identities or package content. Monitor service 5xx, `skill_hub_request_failed` and `skill_hub_database_connection_failed` alongside readiness and disk capacity.

The fixed internal Gateway URL is `http://model-gateway:<port>/v1/consents/current` (loopback is also accepted). The HTTPS reverse-proxy URL retains `/e-mate/model-api/v1/consents/current`. The service never rewrites an arbitrary URL or follows redirects.

Migration requires Node 24.10+ and the original D1 export, every R2 package and a verified manifest. Commands use the same secret configuration; optionally set `SKILL_HUB_SERVICE_ROLE` to grant only the runtime table privileges:

```sh
node --experimental-strip-types enterprise/apps/skill-hub-service/src/migrate.ts --dry-run /private/snapshot
node --experimental-strip-types enterprise/apps/skill-hub-service/src/migrate.ts --apply /private/snapshot
```

Dry-run stages and independently reads back PostgreSQL rows and package bytes, then removes its staging data, including when a staging COMMIT reply is lost. Apply activates the verified schema and durable file generation. A lost activation response requires retrying the **same** snapshot and reading back the durable receipt; do not replace its input or delete retained generation directories. Replay fully validates active rows and package bytes against that snapshot. It fails if data is damaged or subsequent business writes have changed it, and never restores old data over newer writes. Back up and restore PostgreSQL and its referenced generation together; health polling alone does not verify a restore. Only the main agent performs source freeze, backup/restore rehearsal, deployment and fixed-Worker cutover. See [the migration and compatibility contract](../../../../docs/skill-hub-compatibility.md) for the exact manifest and ordering.

Migration recognizes only the exact historical `version_sort` encoder from `38ef7bb` and the current encoder introduced by `8e0c035`. It normalizes this derived column to the current format without rewriting the source snapshot. The receipt records the raw D1 hash, original version-row hash, converted row count and normalized table hash. Old version cursors are normalized only after their original signature and version identity pass validation. Unknown sort keys fail closed.

Focused checks:

```sh
corepack pnpm --dir enterprise --filter @e-mate/skill-hub-service check
corepack pnpm --dir enterprise --filter @e-mate/skill-hub-worker test
E_MATE_TEST_POSTGRES_URL=postgresql://postgres@127.0.0.1:65432/emate218 corepack pnpm --dir enterprise --filter @e-mate/skill-hub-service test
```

The last command must target an isolated test database. Tests create and remove random `sh_test_*`/`sh_stage_*` schemas; without the variable PostgreSQL cases are explicitly skipped. These checks do not establish production migration or real-user installation acceptance.

The existing-server deployment files are `deploy/compose.skill-hub.yml` and `deploy/skill-hub.routes.conf` (relative to `enterprise/`). Pin the verified image ID, use the existing separate data/egress networks, and bind the API only to loopback port 18789. The public API keeps `/ecorex-agent/client/skill-hub/v1` on `mvdcm.ecoremedia.net`; the old Worker's `/healthz` forwards to the isolated health path under that prefix.

Prepare the proxy with `skill-hub-write-hold.conf` installed as `/etc/nginx/e-mate-skill-hub-write-mode.conf`. Before the final export, make the old Worker read-only, install and read back the exact 18 triggers in `skill-hub-freeze-d1.sql`, then validate the untouched official export. D1 metadata is frozen only after that readback; old in-flight uploads may still leave unreferenced R2 objects. Migrate every package referenced by frozen D1, retain and separately inventory unreferenced objects in the old bucket, and do not claim the entire bucket is frozen.

Start and validate the new service while the proxy still rejects writes, switch the fixed Worker forwarder, verify authenticated reads, then remove the proxy write hold as the write cutover. Keep D1 frozen afterwards. `skill-hub-thaw-d1-before-cutover.sql` is only for an abort before the new service accepts any write. Later recovery uses PostgreSQL plus the matching volume backup; reverting to writable D1 would create a second data owner.
