import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { verifyPassword, type ScryptVerifier } from '@e-mate/auth-credential';
import { AdminManagementError, openPostgresAdminManagementStore } from '../src/admin-management.ts';
import { openPostgresObservabilityPolicyStore } from '../src/observability-policy.ts';
import { openPostgresSessionSummaryStore } from '../src/session-index.ts';

const postgresUrl = process.env.E_MATE_TEST_POSTGRES_URL;

type PasswordCredentialRow = {
  password_salt: Buffer;
  password_hash: Buffer;
  scrypt_cost: number;
  scrypt_block_size: number;
  scrypt_parallelization: number;
};

function verifier(row: PasswordCredentialRow): ScryptVerifier {
  return {
    salt: row.password_salt,
    hash: row.password_hash,
    cost: row.scrypt_cost,
    blockSize: row.scrypt_block_size,
    parallelization: row.scrypt_parallelization,
  };
}

test(
  'real PostgreSQL enforces tenant/project access and summary cursors',
  {
    skip: postgresUrl ? false : 'E_MATE_TEST_POSTGRES_URL is not set',
  },
  async () => {
    const { store, close } = await openPostgresSessionSummaryStore(postgresUrl as string);
    const run = randomUUID();
    const tenantId = `tenant-${run}`;
    const projectId = `project-${run}`;
    const sessionId = `session-${run}`;
    const owner = {
      tenantId,
      userId: 'owner@example.com',
      roles: [],
      projectIds: [projectId],
    };
    const member = {
      tenantId,
      userId: 'member@example.com',
      roles: [],
      projectIds: [projectId],
    };
    const write = {
      schemaVersion: 1 as const,
      title: '客户季度复盘',
      summary: '整理销售数据并交付汇报。',
      projectId,
      tags: ['销售', '汇报'],
      state: 'ACTIVE' as const,
      updatedAt: new Date().toISOString(),
      expectedSourceCursor: null,
    };
    try {
      const created = await store.write(owner, sessionId, write);
      assert.equal(created.status, 'OK');
      assert.equal(await store.write(owner, sessionId, write).then(({ status }) => status), 'CONFLICT');
      assert.equal(
        (
          await store.search(member, {
            query: '销售',
            projectId,
            includeArchived: true,
            limit: 20,
          })
        )[0]?.sessionId,
        sessionId
      );
      assert.equal(
        (
          await store.search(
            {
              ...member,
              tenantId: `other-${tenantId}`,
            },
            {
              query: '销售',
              includeArchived: true,
              limit: 20,
            }
          )
        ).length,
        0
      );
      assert.equal(
        await store
          .write(
            {
              ...owner,
              projectIds: [],
            },
            sessionId,
            {
              ...write,
              expectedSourceCursor: 1,
            }
          )
          .then(({ status }) => status),
        'DENIED'
      );
      assert.equal(
        await store.get(
          {
            ...owner,
            projectIds: [],
          },
          sessionId
        ),
        null
      );
      assert.equal(
        (
          await store.search(
            {
              ...owner,
              projectIds: [],
            },
            {
              query: '销售',
              includeArchived: true,
              limit: 20,
            }
          )
        ).length,
        0
      );
      assert.equal(
        await store
          .write(owner, sessionId, {
            ...write,
            updatedAt: '2020-01-01T00:00:00.000Z',
            expectedSourceCursor: 1,
          })
          .then(({ status }) => status),
        'CONFLICT'
      );
      const deleted = await store.write(owner, sessionId, {
        ...write,
        title: '',
        summary: '',
        tags: [],
        state: 'DELETED',
        expectedSourceCursor: 1,
      });
      assert.equal(deleted.status, 'OK');
      assert.equal(await store.get(owner, sessionId), null);
      assert.equal(
        await store
          .write(owner, sessionId, {
            ...write,
            title: '',
            summary: '',
            tags: [],
            state: 'DELETED',
            expectedSourceCursor: null,
          })
          .then(({ status }) => status),
        'OK'
      );
    } finally {
      await close();
      const cleanup = new Pool({ connectionString: postgresUrl as string });
      await cleanup.query('DELETE FROM e_mate_session_summary WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
      await cleanup.end();
    }
  }
);

test(
  'real PostgreSQL atomically versions and audits observability policy',
  {
    skip: postgresUrl ? false : 'E_MATE_TEST_POSTGRES_URL is not set',
  },
  async () => {
    const { store, close } = await openPostgresObservabilityPolicyStore(postgresUrl as string);
    const tenantId = `tenant-policy-${randomUUID()}`;
    const admin = {
      tenantId,
      userId: 'admin@example.com',
      roles: ['TENANT_ADMIN'],
    };
    const cleanup = new Pool({ connectionString: postgresUrl as string });
    try {
      assert.equal((await store.get(tenantId)).version, 1);
      const changed = await store.update(admin, {
        schemaVersion: 1,
        requestId: 'request:update-postgres',
        expectedVersion: 1,
        traceSampleRatio: 0.25,
      });
      assert.equal(changed.status, 'OK');
      assert.equal(
        (
          await store.update(admin, {
            schemaVersion: 1,
            requestId: 'request:update-postgres',
            expectedVersion: 1,
            traceSampleRatio: 0.25,
          })
        ).status,
        'OK'
      );
      const rolledBack = await store.rollback(admin, {
        schemaVersion: 1,
        requestId: 'request:rollback-postgres',
        expectedVersion: 2,
        targetVersion: 1,
      });
      assert.equal(rolledBack.status, 'OK');
      assert.equal(rolledBack.status === 'OK' && rolledBack.policy.traceSampleRatio, 1);
      const audit = await cleanup.query<{
        operation: string;
        actor_id: string;
        changed_fields: string[];
      }>(
        `
      SELECT operation, actor_id, changed_fields
        FROM e_mate_observability_policy_audit
       WHERE tenant_id = $1
       ORDER BY result_version
    `,
        [tenantId]
      );
      assert.deepEqual(audit.rows, [
        {
          operation: 'UPDATE',
          actor_id: 'admin@example.com',
          changed_fields: ['traceSampleRatio'],
        },
        {
          operation: 'ROLLBACK',
          actor_id: 'admin@example.com',
          changed_fields: ['traceSampleRatio'],
        },
      ]);
    } finally {
      await close();
      await cleanup
        .query('DELETE FROM e_mate_observability_policy_audit WHERE tenant_id = $1', [tenantId])
        .catch(() => undefined);
      await cleanup
        .query('DELETE FROM e_mate_observability_policy_history WHERE tenant_id = $1', [tenantId])
        .catch(() => undefined);
      await cleanup
        .query('DELETE FROM e_mate_observability_policy_current WHERE tenant_id = $1', [tenantId])
        .catch(() => undefined);
      await cleanup.end();
    }
  }
);

test(
  'real PostgreSQL provisions login credentials and revokes every session on password reset',
  {
    skip: postgresUrl ? false : 'E_MATE_TEST_POSTGRES_URL is not set',
  },
  async () => {
    const { store, close } = await openPostgresAdminManagementStore(postgresUrl as string, [{ routeId: 'gpt-5.6-sol', label: 'Sol', provider: 'fixture' }]);
    const run = randomUUID();
    const tenantId = `tenant-password-${run}`;
    const userId = `user-${run}`;
    const sessionId = randomUUID();
    const admin = { tenantId, userId: 'admin-1', roles: ['TENANT_ADMIN'] };
    const cleanup = new Pool({ connectionString: postgresUrl as string });
    try {
      const initialPassword = 'InitialPass-2026!';
      const replacementPassword = 'Replacement-2026!';
      const created = await store.createUser(admin, {
        schemaVersion: 1,
        userId,
        displayName: 'User',
        roles: ['MEMBER'],
        tokenLimit: 1_000,
        allowedModelIds: ['gpt-5.6-sol'],
        initialPassword,
      });
      assert.equal(JSON.stringify(created).includes(initialPassword), false);
      const initialCredential = await cleanup.query<PasswordCredentialRow>(
        `SELECT password_salt, password_hash, scrypt_cost, scrypt_block_size, scrypt_parallelization
           FROM e_mate_auth_password_credential
          WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId]
      );
      assert.equal(
        await verifyPassword(initialPassword, verifier(initialCredential.rows[0] as PasswordCredentialRow)),
        true
      );
      const loginIdentifier = `member-${run}@example.test`;
      await cleanup.query(
        `UPDATE e_mate_auth_password_credential
            SET login_identifier_normalized = $3
          WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId, loginIdentifier]
      );
      await cleanup.query(
        `INSERT INTO e_mate_auth_session
          (session_id, tenant_id, user_id, client_id, status, expires_at)
         VALUES ($1, $2, $3, 'e-mate-desktop', 'ACTIVE', clock_timestamp() + interval '1 hour')`,
        [sessionId, tenantId, userId]
      );
      await cleanup.query(
        `INSERT INTO e_mate_auth_refresh_token
          (token_hash, session_id, generation, status, expires_at)
         VALUES ($1, $2, 0, 'ACTIVE', clock_timestamp() + interval '1 hour')`,
        [Buffer.alloc(32, 7), sessionId]
      );

      assert.equal(await store.resetPassword(admin, userId, { schemaVersion: 1, password: replacementPassword }), true);
      const replacementCredential = await cleanup.query<PasswordCredentialRow & { login_identifier_normalized: string }>(
        `SELECT login_identifier_normalized, password_salt, password_hash,
                scrypt_cost, scrypt_block_size, scrypt_parallelization
           FROM e_mate_auth_password_credential
          WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId]
      );
      const replacementVerifier = verifier(replacementCredential.rows[0] as PasswordCredentialRow);
      assert.equal(replacementCredential.rows[0]?.login_identifier_normalized, loginIdentifier);
      assert.equal(await verifyPassword(initialPassword, replacementVerifier), false);
      assert.equal(await verifyPassword(replacementPassword, replacementVerifier), true);
      assert.deepEqual(
        (
          await cleanup.query<{ session_status: string; refresh_status: string }>(
            `SELECT session.status AS session_status, refresh.status AS refresh_status
               FROM e_mate_auth_session AS session
               JOIN e_mate_auth_refresh_token AS refresh USING (session_id)
              WHERE session.session_id = $1`,
            [sessionId]
          )
        ).rows,
        [{ session_status: 'REVOKED', refresh_status: 'REVOKED' }]
      );
      assert.equal(
        (
          await cleanup.query<{ count: string }>(
            `SELECT count(*) AS count
               FROM e_mate_admin_audit
              WHERE tenant_id = $1 AND action = 'USER_PASSWORD_RESET' AND target_id = $2`,
            [tenantId, userId]
          )
        ).rows[0]?.count,
        '1'
      );
      const auditDetails = await cleanup.query<{ details: unknown }>(
        `SELECT details
           FROM e_mate_admin_audit
          WHERE tenant_id = $1 AND target_id = $2
          ORDER BY occurred_at`,
        [tenantId, userId]
      );
      const serializedAudit = JSON.stringify(auditDetails.rows);
      assert.equal(serializedAudit.includes(initialPassword), false);
      assert.equal(serializedAudit.includes(replacementPassword), false);
    } finally {
      await close();
      await cleanup
        .query(
          'DELETE FROM e_mate_auth_refresh_token WHERE session_id IN (SELECT session_id FROM e_mate_auth_session WHERE tenant_id = $1)',
          [tenantId]
        )
        .catch(() => undefined);
      await cleanup.query('DELETE FROM e_mate_auth_session WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
      await cleanup
        .query('DELETE FROM e_mate_auth_password_credential WHERE tenant_id = $1', [tenantId])
        .catch(() => undefined);
      await cleanup.query('DELETE FROM e_mate_admin_audit WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
      await cleanup.query('DELETE FROM e_mate_tenant_user WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
      await cleanup.end();
    }
  }
);

test(
  'real PostgreSQL makes deleted users terminal and revokes their credentials atomically',
  {
    skip: postgresUrl ? false : 'E_MATE_TEST_POSTGRES_URL is not set',
  },
  async () => {
    const { store, close } = await openPostgresAdminManagementStore(postgresUrl as string, [{ routeId: 'gpt-5.6-sol', label: 'Sol', provider: 'fixture' }]);
    const run = randomUUID();
    const tenantId = `tenant-admin-${run}`;
    const userId = `user-${run}`;
    const admin = { tenantId, userId: 'admin-1', roles: ['TENANT_ADMIN'] };
    const cleanup = new Pool({ connectionString: postgresUrl as string });
    try {
      const created = await store.createUser(admin, {
        schemaVersion: 1,
        userId,
        displayName: 'User',
        roles: ['MEMBER'],
        tokenLimit: 50_000,
        allowedModelIds: ['gpt-5.6-sol'],
        initialPassword: 'InitialPass-2026!',
      });
      await store.issueApiKey(admin, {
        schemaVersion: 1,
        label: 'Desktop',
        principalType: 'USER',
        principalId: userId,
        userId,
        scopes: ['models:invoke'],
      });

      const deletion = { schemaVersion: 1 as const, expectedUpdatedAt: created.updatedAt };
      assert.equal(await store.deleteUser(admin, userId, deletion), true);
      assert.equal(await store.deleteUser(admin, userId, deletion), true);
      assert.equal((await store.listUsers(admin)).users[0]?.status, 'DELETED');
      assert.equal((await store.listUsers(admin)).users[0]?.tokenLimit, 50_000);
      assert.equal((await store.listApiKeys(admin)).keys[0]?.revokedAt !== null, true);
      assert.equal(
        (
          await cleanup.query<{ count: string }>(
            `SELECT count(*) AS count
               FROM e_mate_admin_audit
              WHERE tenant_id = $1 AND action = 'USER_DELETED' AND target_id = $2`,
            [tenantId, userId]
          )
        ).rows[0]?.count,
        '1'
      );
      await assert.rejects(
        store.issueApiKey(admin, {
          schemaVersion: 1,
          label: 'Replacement',
          principalType: 'USER',
          principalId: userId,
          userId,
          scopes: ['models:invoke'],
        }),
        (error: unknown) => error instanceof AdminManagementError && error.code === 'USER_UNAVAILABLE'
      );
    } finally {
      await close();
      await cleanup
        .query(
          'DELETE FROM e_mate_auth_refresh_token WHERE session_id IN (SELECT session_id FROM e_mate_auth_session WHERE tenant_id = $1)',
          [tenantId]
        )
        .catch(() => undefined);
      await cleanup.query('DELETE FROM e_mate_auth_session WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
      await cleanup
        .query('DELETE FROM e_mate_auth_password_credential WHERE tenant_id = $1', [tenantId])
        .catch(() => undefined);
      await cleanup.query('DELETE FROM e_mate_admin_audit WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
      await cleanup.query('DELETE FROM e_mate_admin_api_key WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
      await cleanup.query('DELETE FROM e_mate_tenant_user WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
      await cleanup.end();
    }
  }
);

test('real image policy editing preserves legacy key storage and canonical disable precedence', {
  skip: postgresUrl ? false : 'E_MATE_TEST_POSTGRES_URL is not set',
}, async () => {
  const { createCipheriv } = await import('node:crypto');
  const { PostgresTenantModelRoutePolicy } = await import('../../model-gateway/src/tenant-model-route-policy.ts');
  const tenantId = `image-${randomUUID()}`, routeId = 'gpt-image-2.5-flare', legacy = 'gpt-image-2-pro';
  const key = Buffer.alloc(32, 8), nonce = Buffer.alloc(12, 7), secret = 'fixture-only-key-not-production';
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`${tenantId}\0${legacy}`));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  const db = new Pool({ connectionString: postgresUrl });
  const { store, close } = await openPostgresAdminManagementStore(postgresUrl as string,
    [{ routeId, label: 'Image', provider: 'fixture' }], key);
  const principal = { tenantId, userId: 'admin', roles: ['TENANT_ADMIN'], projectIds: [] };
  const policy = new PostgresTenantModelRoutePolicy(db, key);
  try {
    await db.query(`INSERT INTO e_mate_tenant_model_route
      (tenant_id,route_id,enabled,published,updated_by,upstream_key_ciphertext,upstream_key_nonce,upstream_key_tag)
      VALUES ($1,$2,false,false,'fixture',$3,$4,$5)`, [tenantId,legacy,ciphertext,nonce,cipher.getAuthTag()]);
    const updated = await store.updateModelRoute(principal, routeId, { schemaVersion: 1, enabled: true });
    assert.equal(updated?.published, false); assert.equal(updated?.keyConfigured, true);
    assert.equal(await policy.isEnabled(tenantId, routeId), false);
    assert.equal(await policy.upstreamApiKey(tenantId, routeId), secret);
    await store.publishModelRoute(principal, routeId, { schemaVersion: 1, published: true });
    assert.equal(await policy.isEnabled(tenantId, routeId), true);
    await store.updateModelRouteKey(principal, routeId, { schemaVersion: 1, apiKey: 'replacement-fixture-key' });
    assert.equal(await policy.upstreamApiKey(tenantId, routeId), 'replacement-fixture-key');
    assert.deepEqual((await db.query('SELECT route_id FROM e_mate_tenant_model_route WHERE tenant_id=$1', [tenantId])).rows, [{ route_id: legacy }]);
    await db.query("INSERT INTO e_mate_tenant_model_route (tenant_id,route_id,enabled,published,updated_by) VALUES ($1,$2,false,true,'fixture')", [tenantId,routeId]);
    assert.equal(await policy.isEnabled(tenantId, routeId), false);
    assert.equal(await policy.upstreamApiKey(tenantId, routeId), null);
    const catalog = await store.listModelRoutes(principal);
    assert.equal(catalog.routes[0]?.enabled, false); assert.equal(catalog.routes[0]?.keyConfigured, false);
  } finally {
    await db.query('DELETE FROM e_mate_tenant_model_route WHERE tenant_id=$1', [tenantId]);
    await close(); await db.end();
  }
});
