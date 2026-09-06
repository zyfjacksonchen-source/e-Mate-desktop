# e-Mate Share Worker

This Worker publishes the existing DSH Session ZIP; it does not create another
session snapshot, event store, or transcript renderer. Create and revoke calls
must carry the current short-lived Model Gateway session token. The Worker
forwards that token to the existing `/v1/consents/current` route, so the Model
Gateway remains the single JWT and active-session authority.

An owner/session R2 index lets Desktop read active links back after a restart
and revoke them. The index is paginated and bounded; every result is rechecked
against the archive's exact owner and session hashes before it is returned.

The `emate-session-shares` R2 bucket is dedicated user-data storage. Never bind
the `emate-desktop-downloads` release bucket here.

## Enterprise ownership in 2.0.18

`src/core.ts` is the shared business handler used by the enterprise
[`share-service`](../share-service/README.md). After its original R2 data has
been migrated and verified, set `SHARE_SERVICE_BASE` to exactly
`https://mvdcm.ecoremedia.net/e-mate/share`. The Worker then forwards every
request to that fixed owner without following redirects. Legacy create/list
responses preserve the old public origin required by old Desktop clients;
existing `/s/<id>` URLs continue to resolve to the same archive. Do not delete
the old binding or snapshot during cutover. An absent setting retains the
original R2 implementation for the main agent's controlled pre-cutover state;
an invalid setting fails closed. There is no dual-write mode.

The following describes the original R2 activation, not the 2.0.18 migration:

```sh
pnpm dlx wrangler@4.124.0 r2 bucket create emate-session-shares
pnpm dlx wrangler@4.124.0 r2 bucket lifecycle add emate-session-shares expire-session-shares --expire-days 7 --abort-multipart-days 1 --force
pnpm dlx wrangler@4.124.0 deploy --config enterprise/apps/share-worker/wrangler.jsonc
```

After deployment, legacy `GET /healthz` must keep returning
`{"schema_version":1,"ready":true}`, while `GET /v2/healthz` must return
`{"schema_version":1,"service":"emate-share","version":1,"ready":true}`.
Verify both before Desktop activation so the public 2.0.13 client and the new
session-bound revoke contract can coexist during rollout.
Deploy this compatibility Worker before activating new Desktop bytes. On
rollback, restore Desktop compatibility before rolling the Worker back.
