# Skill Hub service

Same-server Skill Hub API using PostgreSQL and a persistent content-addressed ZIP volume. Business rules, archive validation, ownership signatures and response shapes come from `../skill-hub-worker/src/core.ts`; the Worker can forward the existing API prefix to this service after migration.

Run from the repository root with the pinned enterprise dependencies installed:

```sh
bun enterprise/apps/skill-hub-service/src/server.ts
```

Provide `SKILL_HUB_DATABASE_URL_FILE`, `SKILL_HUB_AUTHOR_KEY_FILE`, `SKILL_HUB_MODEL_VALIDATION_URL`, `SKILL_HUB_VOLUME` and `SKILL_HUB_SCHEMA`. Secret values can instead be supplied through the corresponding variables without `_FILE`, but each secret must have exactly one source. Preserve the original author key byte for byte. The default listener is `127.0.0.1:8788`; a container may explicitly set `SKILL_HUB_HOST=0.0.0.0` behind its existing proxy. Use a dedicated database role and the same filesystem UID/GID for migration and serving.

The service requires an activated migration receipt and matching key fingerprint. It does not initialize an empty market. `/livez` checks the process; `/readyz` checks activated storage and bounded package readback. Existing clients retain `/ecorex-agent/client/skill-hub/v1/...` and `/healthz`. Errors emit fixed JSON event names without SQL, URLs, tokens, identities or package content. Monitor service 5xx, `skill_hub_request_failed` and `skill_hub_database_connection_failed` alongside readiness and disk capacity.

Migration requires Node 24.10+ and the original D1 export, every R2 package and a verified manifest. Commands use the same secret configuration; optionally set `SKILL_HUB_SERVICE_ROLE` to grant only the runtime table privileges:

```sh
node --experimental-strip-types enterprise/apps/skill-hub-service/src/migrate.ts --dry-run /private/snapshot
node --experimental-strip-types enterprise/apps/skill-hub-service/src/migrate.ts --apply /private/snapshot
```

Dry-run stages and independently reads back PostgreSQL rows and package bytes, then removes its staging data. Apply activates the verified schema and durable file generation. A lost activation response requires retrying the **same** snapshot and reading back the durable receipt; do not replace its input or delete retained generation directories. Back up and restore PostgreSQL and its referenced generation together. Only the main agent performs source freeze, backup/restore rehearsal, deployment and fixed-Worker cutover. See [the migration and compatibility contract](../../../../docs/skill-hub-compatibility.md) for the exact manifest and ordering.

Focused checks:

```sh
corepack pnpm --dir enterprise --filter @e-mate/skill-hub-service check
corepack pnpm --dir enterprise --filter @e-mate/skill-hub-worker test
E_MATE_TEST_POSTGRES_URL=postgresql://postgres@127.0.0.1:65432/emate218 corepack pnpm --dir enterprise --filter @e-mate/skill-hub-service test
```

The last command must target an isolated test database. Tests create and remove random `sh_test_*`/`sh_stage_*` schemas; without the variable PostgreSQL cases are explicitly skipped. These checks do not establish production migration or real-user installation acceptance.
