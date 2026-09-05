import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { AdminManagementError, InMemoryAdminManagementStore, PostgresAdminManagementStore } from '../src/index.ts';
import type { RuntimeRegistryPrincipal } from '../src/runtime-registry.ts';

const tenantAdmin = (tenantId: string): RuntimeRegistryPrincipal => ({
  tenantId,
  userId: 'admin-1',
  roles: ['TENANT_ADMIN'],
});

test('tenant user and model route records remain tenant-isolated', async () => {
  let now = Date.parse('2026-07-30T10:00:00.000Z');
  const store = new InMemoryAdminManagementStore(
    [{ routeId: 'gpt-5.6-sol', label: 'Sol', provider: 'Enterprise gateway' }],
    () => now
  );
  const created = await store.createUser(tenantAdmin('tenant-a'), {
    schemaVersion: 1,
    userId: 'user-a',
    displayName: 'User A',
    roles: ['MEMBER'],
    tokenLimit: 1_000,
    allowedModelIds: ['gpt-5.6-sol'],
    initialPassword: 'InitialPass-2026!',
  });
  await store.updateUser(tenantAdmin('tenant-a'), 'user-a', {
    schemaVersion: 1,
    displayName: 'User A',
    roles: ['MEMBER'],
    status: 'ACTIVE',
    tokenLimit: 5_000,
    allowedModelIds: ['gpt-5.6-sol'],
    expectedUpdatedAt: created.updatedAt,
  });
  assert.equal((await store.listUsers(tenantAdmin('tenant-a'))).users[0]?.tokenLimit, 5_000);
  await assert.rejects(
    store.updateUser(tenantAdmin('tenant-a'), 'user-a', {
      schemaVersion: 1,
      displayName: 'Stale User A',
      roles: ['MEMBER'],
      status: 'SUSPENDED',
      tokenLimit: 1,
      allowedModelIds: ['gpt-5.6-sol'],
      expectedUpdatedAt: created.updatedAt,
    }),
    (error: unknown) => error instanceof AdminManagementError && error.code === 'STALE_UPDATE'
  );
  await assert.rejects(
    store.deleteUser(tenantAdmin('tenant-a'), 'user-a', {
      schemaVersion: 1,
      expectedUpdatedAt: created.updatedAt,
    }),
    (error: unknown) => error instanceof AdminManagementError && error.code === 'STALE_UPDATE'
  );
  assert.equal((await store.listUsers(tenantAdmin('tenant-a'))).users[0]?.status, 'ACTIVE');
  assert.equal((await store.listUsers(tenantAdmin('tenant-b'))).users.length, 0);

  now += 1_000;
  await store.updateModelRoute(tenantAdmin('tenant-a'), 'gpt-5.6-sol', {
    schemaVersion: 1,
    enabled: false,
  });
  assert.equal((await store.listModelRoutes(tenantAdmin('tenant-a'))).routes[0]?.enabled, false);
  assert.equal((await store.listModelRoutes(tenantAdmin('tenant-b'))).routes[0]?.enabled, true);

  const apiKey = 'tenant-provider-key-that-is-long-enough';
  now += 1_000;
  const updated = await store.updateModelRouteKey(tenantAdmin('tenant-a'), 'gpt-5.6-sol', {
    schemaVersion: 1,
    apiKey,
  });
  assert.equal(updated?.keyConfigured, true);
  assert.equal(JSON.stringify(updated).includes(apiKey), false);
  assert.equal((await store.listModelRoutes(tenantAdmin('tenant-a'))).routes[0]?.keyConfigured, true);
  assert.equal((await store.listModelRoutes(tenantAdmin('tenant-b'))).routes[0]?.keyConfigured, false);
});

test('model catalog removal is tenant-scoped, fail-closed, and reversible only for deployed routes', async () => {
  const store = new InMemoryAdminManagementStore([
    { routeId: 'gpt-5.6-sol', label: 'Sol', provider: 'Enterprise gateway' },
  ]);
  const removed = await store.publishModelRoute(tenantAdmin('tenant-a'), 'gpt-5.6-sol', {
    schemaVersion: 1,
    published: false,
  });
  assert.equal(removed?.published, false);
  assert.equal(removed?.enabled, false);
  assert.equal((await store.listModelRoutes(tenantAdmin('tenant-b'))).routes[0]?.published, true);
  assert.equal(
    await store.publishModelRoute(tenantAdmin('tenant-a'), 'not-in-deployment-catalog', {
      schemaVersion: 1,
      published: true,
    }),
    null
  );
  assert.equal(
    (
      await store.publishModelRoute(tenantAdmin('tenant-a'), 'gpt-5.6-sol', {
        schemaVersion: 1,
        published: true,
      })
    )?.published,
    true
  );
});

test('new client credentials are model-only, user-bound, and revocable', async () => {
  let now = Date.parse('2026-07-30T10:00:00.000Z');
  const store = new InMemoryAdminManagementStore([{ routeId: 'gpt-5.6-sol', label: 'Sol', provider: 'fixture' }], () => now);
  const admin = tenantAdmin('tenant-a');
  await store.createUser(admin, {
    schemaVersion: 1,
    userId: 'user-a',
    displayName: 'User A',
    roles: ['MEMBER'],
    tokenLimit: 10_000,
    allowedModelIds: ['gpt-5.6-sol'],
    initialPassword: 'InitialPass-2026!',
  });
  const issued = await store.issueApiKey(admin, {
    schemaVersion: 1,
    label: 'Desktop',
    principalType: 'USER',
    principalId: 'user-a',
    userId: 'user-a',
    scopes: ['models:invoke'],
  });
  assert.match(issued.secret, /^emate_twe_[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(await store.listApiKeys(admin)).includes(issued.secret), false);
  for (const scopes of [['task-events:write'], ['task-events:write', 'models:invoke']] as const) {
    await assert.rejects(
      store.issueApiKey(admin, {
        schemaVersion: 1,
        label: 'Retired task writer',
        principalType: 'USER',
        principalId: 'user-a',
        userId: 'user-a',
        scopes: [...scopes],
      }),
      /key scopes/
    );
  }

  now += 1_000;
  assert.equal(await store.revokeApiKey(admin, issued.key.keyId), true);
  assert.equal(await store.revokeApiKey(tenantAdmin('tenant-b'), issued.key.keyId), false);
});

test('suspended and missing users cannot receive model credentials', async () => {
  const store = new InMemoryAdminManagementStore([{ routeId: 'gpt-5.6-sol', label: 'Sol', provider: 'fixture' }]);
  const admin = tenantAdmin('tenant-a');
  const created = await store.createUser(admin, {
    schemaVersion: 1,
    userId: 'user-a',
    displayName: 'User A',
    roles: ['MEMBER'],
    tokenLimit: 1_000,
    allowedModelIds: ['gpt-5.6-sol'],
    initialPassword: 'InitialPass-2026!',
  });
  await store.updateUser(admin, 'user-a', {
    schemaVersion: 1,
    displayName: 'User A',
    roles: ['MEMBER'],
    status: 'SUSPENDED',
    tokenLimit: null,
    allowedModelIds: [],
    expectedUpdatedAt: created.updatedAt,
  });
  await assert.rejects(
    store.issueApiKey(admin, {
      schemaVersion: 1,
      label: 'Desktop',
      principalType: 'USER',
      principalId: 'user-a',
      userId: 'user-a',
      scopes: ['models:invoke'],
    }),
    (error: unknown) => error instanceof AdminManagementError && error.code === 'USER_UNAVAILABLE'
  );
});

test('deleting a user is idempotent, terminal, and revokes existing credentials', async () => {
  const store = new InMemoryAdminManagementStore([{ routeId: 'gpt-5.6-sol', label: 'Sol', provider: 'fixture' }]);
  const admin = tenantAdmin('tenant-a');
  const created = await store.createUser(admin, {
    schemaVersion: 1,
    userId: 'user-a',
    displayName: 'User A',
    roles: ['MEMBER'],
    tokenLimit: 1_000,
    allowedModelIds: ['gpt-5.6-sol'],
    initialPassword: 'InitialPass-2026!',
  });
  await store.issueApiKey(admin, {
    schemaVersion: 1,
    label: 'Desktop',
    principalType: 'USER',
    principalId: 'user-a',
    userId: 'user-a',
    scopes: ['models:invoke'],
  });

  const deletion = { schemaVersion: 1 as const, expectedUpdatedAt: created.updatedAt };
  assert.equal(await store.deleteUser(admin, 'user-a', deletion), true);
  assert.equal(await store.deleteUser(admin, 'user-a', deletion), true);
  const deleted = (await store.listUsers(admin)).users[0];
  assert.equal(deleted?.status, 'DELETED');
  assert.equal((await store.listApiKeys(admin)).keys[0]?.revokedAt !== null, true);
  assert.equal(
    await store.updateUser(admin, 'user-a', {
      schemaVersion: 1,
      displayName: 'User A',
      roles: ['MEMBER'],
      status: 'ACTIVE',
      tokenLimit: 1_000,
      allowedModelIds: ['gpt-5.6-sol'],
      expectedUpdatedAt: deleted?.updatedAt as string,
    }),
    null
  );
  await assert.rejects(
    store.issueApiKey(admin, {
      schemaVersion: 1,
      label: 'Replacement',
      principalType: 'USER',
      principalId: 'user-a',
      userId: 'user-a',
      scopes: ['models:invoke'],
    }),
    (error: unknown) => error instanceof AdminManagementError && error.code === 'USER_UNAVAILABLE'
  );
});

test('credential migration revokes every legacy task scope before validating the model-only constraint', async () => {
  const statements: string[] = [];
  const pool = {
    query: async (sql: string) => {
      statements.push(sql);
      return { rows: [] };
    },
  } as unknown as Pool;
  await new PostgresAdminManagementStore(pool, []).initialize();
  const schema = statements[0] as string;
  const revoke = schema.indexOf("WHERE 'task-events:write' = ANY(scopes)");
  const constraint = schema.indexOf('ADD CONSTRAINT e_mate_admin_api_key_scopes_check');
  assert(revoke >= 0 && constraint > revoke);
  assert.match(schema, /SET revoked_at = COALESCE\(revoked_at, now\(\)\)/u);
  assert.match(schema, /scopes = ARRAY\['models:invoke'\]::text\[\][\s\S]*principal_type = 'USER'/u);
  assert.match(schema, /revoked_at IS NOT NULL[\s\S]*ARRAY\['task-events:write'\]::text\[\]/u);
  assert.match(schema, /revoked_at IS NOT NULL[\s\S]*ARRAY\['task-events:write', 'models:invoke'\]::text\[\]/u);
  assert.doesNotMatch(schema, /NOT VALID/u);
});
