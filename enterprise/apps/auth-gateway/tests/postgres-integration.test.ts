import assert from 'node:assert/strict';
import { createHash, pbkdf2Sync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { AUTH_CREDENTIAL_SOURCE_VERSION_MIGRATION_SQL } from '@e-mate/auth-credential';
import { derivePasswordVerifier, refreshTokenHash } from '../src/crypto.ts';
import { migrateEcorexV0292Users } from '../src/migrateEcorexV0292Users.ts';
import { PostgresAuthStore } from '../src/postgres-store.ts';

const postgresUrl = process.env.E_MATE_TEST_POSTGRES_URL;
const integrationTest = postgresUrl ? test : test.skip;
const pool = postgresUrl ? new Pool({ connectionString: postgresUrl }) : undefined;
const suffix = randomUUID().replaceAll('-', '');
const tenantId = `auth-test-${suffix}`;
const userId = `user-${suffix}`;
const login = `auth-${suffix}@example.test`;

function legacyEncodedHash(password: string, saltByte: number): string {
  const salt = Buffer.alloc(16, saltByte);
  const digest = pbkdf2Sync(password, salt, 180_000, 32, 'sha256');
  return `pbkdf2_sha256$180000$${salt.toString('base64')}$${digest.toString('base64')}`;
}

function approvedSourceRecordSha256(source: {
  accountId: string;
  loginIdentifier: string;
  displayName: string;
  status: 'ACTIVE' | 'SUSPENDED';
  encodedHash: string;
}): Buffer {
  return createHash('sha256')
    .update(source.accountId, 'utf8')
    .update('\0')
    .update(source.loginIdentifier, 'utf8')
    .update('\0')
    .update(source.displayName, 'utf8')
    .update('\0')
    .update(source.status, 'ascii')
    .update('\0')
    .update(source.encodedHash, 'ascii')
    .digest();
}

async function insertLegacyUser(
  tenant: string,
  user: string,
  userLogin: string,
  password: string,
  status = 'ACTIVE'
): Promise<void> {
  assert.ok(pool);
  await pool.query(
    `INSERT INTO e_mate_tenant_user (tenant_id, user_id, display_name, roles, status)
     VALUES ($1, $2, '迁移用户', ARRAY['MEMBER']::text[], $3)`,
    [tenant, user, status]
  );
  await pool.query(
    `INSERT INTO e_mate_tenant_model_route (tenant_id, route_id, enabled, updated_by)
     VALUES ($1, 'gpt-5.6-sol', true, 'test')`,
    [tenant]
  );
  const encodedHash = legacyEncodedHash(password, 6);
  const sourceRecordSha256 = createHash('sha256').update(encodedHash).digest();
  await pool.query(
    `INSERT INTO e_mate_auth_credential_migration (
       tenant_id, user_id, source_version, source_record_sha256
     ) VALUES ($1, $2, '0.2.9.2', $3)`,
    [tenant, user, sourceRecordSha256]
  );
  await pool.query(
    `INSERT INTO e_mate_auth_legacy_password_credential (
       credential_id, tenant_id, user_id, login_identifier_normalized,
       algorithm, encoded_hash, source_version, source_record_sha256
     ) VALUES ($1, $2, $3, $4, 'pbkdf2_sha256', $5, '0.2.9.2', $6)`,
    [randomUUID(), tenant, user, userLogin, encodedHash, sourceRecordSha256]
  );
}

async function allowDefaultModel(tenant: string, user: string): Promise<void> {
  assert.ok(pool);
  const updated = await pool.query(
    `UPDATE e_mate_tenant_user
        SET allowed_model_ids = ARRAY['gpt-5.6-sol']::text[]
      WHERE tenant_id = $1 AND user_id = $2`,
    [tenant, user]
  );
  assert.equal(updated.rowCount, 1);
}

function createStore(): PostgresAuthStore {
  assert.ok(pool);
  return new PostgresAuthStore(pool, {
    refreshDerivationSecret: Buffer.alloc(32, 9),
    modelRouteIds: ['gpt-5.6-sol', 'gpt-image-2.5-flare'],
    sessionLifetimeSeconds: 3_600,
    now: () => new Date('2026-08-02T00:00:00.000Z'),
  });
}

function migrationSources(): { directory: string; admin: string; control: string } {
  const directory = mkdtempSync(join(tmpdir(), 'e-mate-v0292-'));
  const admin = join(directory, 'admin.sqlite3');
  const control = join(directory, 'control.sqlite3');
  const adminDatabase = new DatabaseSync(admin);
  const controlDatabase = new DatabaseSync(control);
  try {
    adminDatabase.exec(`
      CREATE TABLE users (
        id text PRIMARY KEY, name text NOT NULL, email text NOT NULL, role text NOT NULL,
        status text NOT NULL, password_hash text NOT NULL, deleted_at text
      )
    `);
    controlDatabase.exec(`
      CREATE TABLE admin_ops_password_credentials (
        account_id text PRIMARY KEY, algorithm text NOT NULL, source_version text NOT NULL
      )
    `);
    const addUser = adminDatabase.prepare(
      'INSERT INTO users (id, name, email, role, status, password_hash, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const addCredential = controlDatabase.prepare(
      'INSERT INTO admin_ops_password_credentials (account_id, algorithm, source_version) VALUES (?, ?, ?)'
    );
    adminDatabase.exec('BEGIN');
    controlDatabase.exec('BEGIN');
    for (let index = 0; index < 37; index += 1) {
      const accountId = `migrate-${index}-${suffix}`;
      addUser.run(
        accountId,
        `迁移用户 ${index}`,
        `migrate-${index}-${suffix}@example.test`,
        'member',
        index === 36 ? 'disabled' : 'active',
        legacyEncodedHash(`legacy-password-${index}`, index + 1),
        index === 36 ? '2026-08-02T00:00:00.000Z' : null
      );
      addCredential.run(accountId, 'pbkdf2_sha256', '0.2.9.2');
    }
    for (let index = 0; index < 3; index += 1) {
      const accountId = `migrate-admin-${index}-${suffix}`;
      addUser.run(
        accountId,
        `管理员重置用户 ${index}`,
        `migrate-admin-${index}-${suffix}@example.test`,
        'member',
        'active',
        legacyEncodedHash(`admin-password-${index}`, index + 40),
        null
      );
      addCredential.run(accountId, 'pbkdf2_sha256', 'admin');
    }
    addCredential.run(`orphan-admin-${suffix}`, 'pbkdf2_sha256', 'admin');
    adminDatabase.exec('COMMIT');
    controlDatabase.exec('COMMIT');
    return { directory, admin, control };
  } finally {
    adminDatabase.close();
    controlDatabase.close();
  }
}

before(async () => {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS e_mate_tenant_user (
      tenant_id text NOT NULL,
      user_id text NOT NULL,
      display_name text NOT NULL,
      roles text[] NOT NULL,
      status text NOT NULL,
      token_limit bigint,
      allowed_model_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, user_id)
    );
    ALTER TABLE e_mate_tenant_user
      ADD COLUMN IF NOT EXISTS allowed_model_ids text[] NOT NULL DEFAULT ARRAY[]::text[];
    CREATE TABLE IF NOT EXISTS e_mate_tenant_model_route (
      tenant_id text NOT NULL,
      route_id text NOT NULL,
      published boolean NOT NULL DEFAULT true,
      enabled boolean NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text NOT NULL,
      PRIMARY KEY (tenant_id, route_id)
    );
    ALTER TABLE e_mate_tenant_model_route
      ADD COLUMN IF NOT EXISTS published boolean NOT NULL DEFAULT true;
  `);
});

after(async () => {
  if (!pool) return;
  await pool
    .query(
      'DELETE FROM e_mate_auth_refresh_token WHERE session_id IN (SELECT session_id FROM e_mate_auth_session WHERE tenant_id LIKE $1)',
      [`${tenantId}%`]
    )
    .catch(() => undefined);
  await pool.query('DELETE FROM e_mate_auth_session WHERE tenant_id LIKE $1', [`${tenantId}%`]).catch(() => undefined);
  await pool
    .query('DELETE FROM e_mate_auth_password_credential WHERE tenant_id LIKE $1', [`${tenantId}%`])
    .catch(() => undefined);
  await pool
    .query('DELETE FROM e_mate_auth_legacy_password_credential WHERE tenant_id LIKE $1', [`${tenantId}%`])
    .catch(() => undefined);
  await pool
    .query('DELETE FROM e_mate_auth_credential_migration WHERE tenant_id LIKE $1', [`${tenantId}%`])
    .catch(() => undefined);
  await pool
    .query('DELETE FROM e_mate_tenant_model_route WHERE tenant_id LIKE $1', [`${tenantId}%`])
    .catch(() => undefined);
  await pool.query('DELETE FROM e_mate_tenant_user WHERE tenant_id LIKE $1', [`${tenantId}%`]).catch(() => undefined);
  await pool.end();
});

integrationTest('legacy imports reject an altered algorithm or iteration count', async () => {
  assert.ok(pool);
  const auth = createStore();
  await auth.initialize();
  const tenant = `${tenantId}-malformed`;
  const user = `${userId}-malformed`;
  await pool.query(
    `INSERT INTO e_mate_tenant_user (tenant_id, user_id, display_name, roles, status)
     VALUES ($1, $2, '迁移用户', ARRAY['MEMBER']::text[], 'ACTIVE')`,
    [tenant, user]
  );
  const encodedHash = legacyEncodedHash('legacy-password', 4).replace('$180000$', '$179999$');
  await assert.rejects(
    pool.query(
      `INSERT INTO e_mate_auth_legacy_password_credential (
         credential_id, tenant_id, user_id, login_identifier_normalized,
         algorithm, encoded_hash, source_version, source_record_sha256
       ) VALUES ($1, $2, $3, $4, 'pbkdf2_sha256', $5, '0.2.9.2', $6)`,
      [
        randomUUID(),
        tenant,
        user,
        `malformed-${suffix}@example.test`,
        encodedHash,
        createHash('sha256').update(encodedHash).digest(),
      ]
    )
  );
});

integrationTest('initialization widens an existing legacy source constraint without dropping provenance', async () => {
  assert.ok(pool);
  const auth = createStore();
  await auth.initialize();
  try {
    await pool.query(`
      ALTER TABLE e_mate_auth_legacy_password_credential
        DROP CONSTRAINT e_mate_auth_legacy_password_credential_source_version_check;
      ALTER TABLE e_mate_auth_legacy_password_credential
        ADD CONSTRAINT e_mate_auth_legacy_password_credential_source_version_check
        CHECK (source_version = '0.2.9.2');
      ALTER TABLE e_mate_auth_credential_migration
        DROP CONSTRAINT e_mate_auth_credential_migration_source_version_check;
      ALTER TABLE e_mate_auth_credential_migration
        ADD CONSTRAINT e_mate_auth_credential_migration_source_version_check
        CHECK (source_version = '0.2.9.2');
    `);
    await Promise.all([auth.initialize(), createStore().initialize()]);
    const constraints = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname IN (
          'e_mate_auth_legacy_password_credential_source_version_check',
          'e_mate_auth_credential_migration_source_version_check'
        )
          AND conrelid IN (
            'e_mate_auth_legacy_password_credential'::regclass,
            'e_mate_auth_credential_migration'::regclass
          )
        ORDER BY conname`
    );
    assert.equal(constraints.rows.length, 2);
    assert.equal(
      constraints.rows.every(({ definition }) => definition.includes('admin')),
      true
    );
  } finally {
    await pool.query(AUTH_CREDENTIAL_SOURCE_VERSION_MIGRATION_SQL);
  }
});

integrationTest(
  'migration source audit permits exactly one missing admin user and rejects every other skip',
  async () => {
    assert.ok(postgresUrl);
    const zeroOrphans = migrationSources();
    const twoOrphans = migrationSources();
    const nonMember = migrationSources();
    const malformedOrphan = migrationSources();
    try {
      const zeroControl = new DatabaseSync(zeroOrphans.control);
      zeroControl.prepare("DELETE FROM admin_ops_password_credentials WHERE account_id LIKE 'orphan-admin-%'").run();
      zeroControl.close();
      const twoControl = new DatabaseSync(twoOrphans.control);
      twoControl
        .prepare(
          "INSERT INTO admin_ops_password_credentials (account_id, algorithm, source_version) VALUES (?, 'pbkdf2_sha256', 'admin')"
        )
        .run(`orphan-admin-extra-${suffix}`);
      twoControl.close();
      const nonMemberAdmin = new DatabaseSync(nonMember.admin);
      nonMemberAdmin.prepare("UPDATE users SET role = 'admin' WHERE id LIKE 'migrate-admin-0-%'").run();
      nonMemberAdmin.close();
      const malformedOrphanControl = new DatabaseSync(malformedOrphan.control);
      malformedOrphanControl
        .prepare(
          "UPDATE admin_ops_password_credentials SET algorithm = 'unknown' WHERE account_id LIKE 'orphan-admin-%'"
        )
        .run();
      malformedOrphanControl.close();
      const options = {
        mode: 'dry-run' as const,
        tenantId: `${tenantId}-source-audit`,
        databaseUrl: postgresUrl,
      };
      await assert.rejects(
        migrateEcorexV0292Users({
          ...options,
          sourceAdminDatabase: zeroOrphans.admin,
          sourceControlDatabase: zeroOrphans.control,
        }),
        /approved v0\.2\.9\.2 cohort/
      );
      await assert.rejects(
        migrateEcorexV0292Users({
          ...options,
          sourceAdminDatabase: twoOrphans.admin,
          sourceControlDatabase: twoOrphans.control,
        }),
        /approved v0\.2\.9\.2 cohort/
      );
      await assert.rejects(
        migrateEcorexV0292Users({
          ...options,
          sourceAdminDatabase: nonMember.admin,
          sourceControlDatabase: nonMember.control,
        }),
        /approved v0\.2\.9\.2 cohort/
      );
      await assert.rejects(
        migrateEcorexV0292Users({
          ...options,
          sourceAdminDatabase: malformedOrphan.admin,
          sourceControlDatabase: malformedOrphan.control,
        }),
        /approved v0\.2\.9\.2 cohort/
      );
    } finally {
      rmSync(zeroOrphans.directory, { recursive: true, force: true });
      rmSync(twoOrphans.directory, { recursive: true, force: true });
      rmSync(nonMember.directory, { recursive: true, force: true });
      rmSync(malformedOrphan.directory, { recursive: true, force: true });
    }
  }
);

integrationTest('legacy login is tenant-bound and never upgrades wrong or disabled credentials', async () => {
  assert.ok(pool);
  const auth = createStore();
  await auth.initialize();
  const tenant = `${tenantId}-isolation`;
  const user = `${userId}-isolation`;
  const userLogin = `isolation-${suffix}@example.test`;
  await insertLegacyUser(tenant, user, userLogin, 'legacy-password');
  assert.deepEqual(
    await auth.authenticatePassword({
      tenantId: `${tenant}-other`,
      clientId: 'e-mate-desktop',
      user: userLogin,
      password: 'legacy-password',
    }),
    { ok: false, code: 'INVALID_GRANT' }
  );
  assert.deepEqual(
    await auth.authenticatePassword({
      tenantId: tenant,
      clientId: 'e-mate-desktop',
      user: userLogin,
      password: 'wrong',
    }),
    { ok: false, code: 'INVALID_GRANT' }
  );
  await pool.query('UPDATE e_mate_tenant_user SET status = $3 WHERE tenant_id = $1 AND user_id = $2', [
    tenant,
    user,
    'SUSPENDED',
  ]);
  assert.deepEqual(
    await auth.authenticatePassword({
      tenantId: tenant,
      clientId: 'e-mate-desktop',
      user: userLogin,
      password: 'legacy-password',
    }),
    { ok: false, code: 'INVALID_GRANT' }
  );
  const counts = await pool.query<{ legacy: string; current: string }>(
    `SELECT
       (SELECT count(*) FROM e_mate_auth_legacy_password_credential WHERE tenant_id = $1)::text AS legacy,
       (SELECT count(*) FROM e_mate_auth_password_credential WHERE tenant_id = $1)::text AS current`,
    [tenant]
  );
  assert.deepEqual(counts.rows[0], { legacy: '1', current: '0' });
});

integrationTest('concurrent first login upgrades once and subsequent logins use only scrypt', async () => {
  assert.ok(pool);
  const auth = createStore();
  await auth.initialize();
  const tenant = `${tenantId}-upgrade`;
  const user = `${userId}-upgrade`;
  const userLogin = `upgrade-${suffix}@example.test`;
  const password = 'legacy-password';
  await insertLegacyUser(tenant, user, userLogin, password);
  await allowDefaultModel(tenant, user);
  const input = { tenantId: tenant, clientId: 'e-mate-desktop', user: userLogin, password };
  const concurrent = await Promise.all([auth.authenticatePassword(input), auth.authenticatePassword(input)]);
  assert.equal(
    concurrent.every((result) => result.ok),
    true
  );
  const upgraded = await pool.query<{
    legacy: string;
    current: string;
    migration: string;
    upgraded: string;
    cost: number | null;
    block_size: number | null;
    parallelization: number | null;
  }>(
    `SELECT
       (SELECT count(*) FROM e_mate_auth_legacy_password_credential WHERE tenant_id = $1)::text AS legacy,
       (SELECT count(*) FROM e_mate_auth_password_credential WHERE tenant_id = $1)::text AS current,
       (SELECT count(*) FROM e_mate_auth_credential_migration WHERE tenant_id = $1)::text AS migration,
       (SELECT count(*) FROM e_mate_auth_credential_migration WHERE tenant_id = $1 AND upgraded_at IS NOT NULL)::text AS upgraded,
       max(scrypt_cost) AS cost,
       max(scrypt_block_size) AS block_size,
       max(scrypt_parallelization) AS parallelization
      FROM e_mate_auth_password_credential
     WHERE tenant_id = $1`,
    [tenant]
  );
  assert.deepEqual(upgraded.rows[0], {
    legacy: '0',
    current: '1',
    migration: '1',
    upgraded: '1',
    cost: 65_536,
    block_size: 8,
    parallelization: 1,
  });
  assert.equal((await auth.authenticatePassword(input)).ok, true);
});

integrationTest('v0.2.9.2 migration dry-runs, applies atomically, and repeats with zero additions', async () => {
  assert.ok(pool);
  assert.ok(postgresUrl);
  const source = migrationSources();
  const tenant = `${tenantId}-migration`;
  try {
    await pool.query(
      `INSERT INTO e_mate_tenant_user (tenant_id, user_id, display_name, roles, status)
       VALUES ($1, 'existing-user', '既有用户', ARRAY['TENANT_ADMIN']::text[], 'ACTIVE')`,
      [tenant]
    );
    const common = {
      sourceAdminDatabase: source.admin,
      sourceControlDatabase: source.control,
      tenantId: tenant,
      databaseUrl: postgresUrl,
    };
    const auth = createStore();
    await auth.initialize();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let index = 0; index < 37; index += 1) {
        const accountId = `migrate-${index}-${suffix}`;
        const loginIdentifier = `migrate-${index}-${suffix}@example.test`;
        const displayName = `迁移用户 ${index}`;
        const status = index === 36 ? ('SUSPENDED' as const) : ('ACTIVE' as const);
        const encodedHash = legacyEncodedHash(`legacy-password-${index}`, index + 1);
        const evidence = approvedSourceRecordSha256({
          accountId,
          loginIdentifier,
          displayName,
          status,
          encodedHash,
        });
        // Recreates the exact evidence bytes emitted by the already-deployed 0.2.9.2 migrator.
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO e_mate_tenant_user (tenant_id, user_id, display_name, roles, status)
           VALUES ($1, $2, $3, ARRAY['MEMBER']::text[], $4)`,
          [tenant, accountId, displayName, status]
        );
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO e_mate_auth_credential_migration
             (tenant_id, user_id, source_version, source_record_sha256)
           VALUES ($1, $2, '0.2.9.2', $3)`,
          [tenant, accountId, evidence]
        );
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO e_mate_auth_legacy_password_credential (
             credential_id, tenant_id, user_id, login_identifier_normalized,
             algorithm, encoded_hash, source_version, source_record_sha256
           ) VALUES ($1, $2, $3, $4, 'pbkdf2_sha256', $5, '0.2.9.2', $6)`,
          [randomUUID(), tenant, accountId, loginIdentifier, encodedHash, evidence]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    assert.deepEqual(await migrateEcorexV0292Users({ ...common, mode: 'dry-run' }), {
      mode: 'dry-run',
      sourceTotal: 40,
      active: 39,
      disabled: 1,
      inserted: 0,
      wouldInsert: 3,
      existing: 37,
      skipped: 1,
    });
    assert.equal(
      (await pool.query('SELECT count(*)::text AS count FROM e_mate_tenant_user WHERE tenant_id = $1', [tenant]))
        .rows[0]?.count,
      '38'
    );
    assert.deepEqual(await migrateEcorexV0292Users({ ...common, mode: 'apply' }), {
      mode: 'apply',
      sourceTotal: 40,
      active: 39,
      disabled: 1,
      inserted: 3,
      wouldInsert: 0,
      existing: 37,
      skipped: 1,
    });
    assert.deepEqual(await migrateEcorexV0292Users({ ...common, mode: 'apply' }), {
      mode: 'apply',
      sourceTotal: 40,
      active: 39,
      disabled: 1,
      inserted: 0,
      wouldInsert: 0,
      existing: 40,
      skipped: 1,
    });
    const counts = await pool.query<{
      users: string;
      active: string;
      disabled: string;
      legacy: string;
      imported: string;
      admin: string;
    }>(
      `SELECT
         (SELECT count(*) FROM e_mate_tenant_user WHERE tenant_id = $1 AND user_id <> 'existing-user')::text AS users,
         (SELECT count(*) FROM e_mate_tenant_user WHERE tenant_id = $1 AND status = 'ACTIVE' AND user_id <> 'existing-user')::text AS active,
         (SELECT count(*) FROM e_mate_tenant_user WHERE tenant_id = $1 AND status = 'SUSPENDED')::text AS disabled,
         (SELECT count(*) FROM e_mate_auth_legacy_password_credential WHERE tenant_id = $1)::text AS legacy,
         (SELECT count(*) FROM e_mate_auth_credential_migration WHERE tenant_id = $1 AND source_version = '0.2.9.2')::text AS imported,
         (SELECT count(*) FROM e_mate_auth_credential_migration WHERE tenant_id = $1 AND source_version = 'admin')::text AS admin`,
      [tenant]
    );
    assert.deepEqual(counts.rows[0], {
      users: '40',
      active: '39',
      disabled: '1',
      legacy: '40',
      imported: '37',
      admin: '3',
    });
    const adminUserId = `migrate-admin-0-${suffix}`;
    const adminLoginIdentifier = `migrate-admin-0-${suffix}@example.test`;
    const adminEncodedHash = legacyEncodedHash('admin-password-0', 40);
    const expectedAdminEvidence = approvedSourceRecordSha256({
      accountId: adminUserId,
      loginIdentifier: adminLoginIdentifier,
      displayName: '管理员重置用户 0',
      status: 'ACTIVE',
      encodedHash: adminEncodedHash,
    });
    const adminEvidence = await pool.query<{ source_record_sha256: Buffer }>(
      `SELECT source_record_sha256
         FROM e_mate_auth_credential_migration
        WHERE tenant_id = $1 AND user_id = $2 AND source_version = 'admin'`,
      [tenant, adminUserId]
    );
    assert.deepEqual(adminEvidence.rows[0]?.source_record_sha256, expectedAdminEvidence);
    await allowDefaultModel(tenant, adminUserId);
    assert.equal(
      (
        await auth.authenticatePassword({
          tenantId: tenant,
          clientId: 'e-mate-desktop',
          user: `migrate-admin-0-${suffix}@example.test`,
          password: 'admin-password-0',
        })
      ).ok,
      true
    );
    const upgraded = await pool.query<{ current: string; legacy: string; provenance: string }>(
      `SELECT
         (SELECT count(*) FROM e_mate_auth_password_credential WHERE tenant_id = $1 AND user_id = $2)::text AS current,
         (SELECT count(*) FROM e_mate_auth_legacy_password_credential WHERE tenant_id = $1 AND user_id = $2)::text AS legacy,
         (SELECT count(*) FROM e_mate_auth_credential_migration
           WHERE tenant_id = $1 AND user_id = $2 AND source_version = 'admin' AND upgraded_at IS NOT NULL)::text AS provenance`,
      [tenant, adminUserId]
    );
    assert.deepEqual(upgraded.rows[0], { current: '1', legacy: '0', provenance: '1' });
  } finally {
    rmSync(source.directory, { recursive: true, force: true });
  }
});

integrationTest('v0.2.9.2 migration rolls back the whole cohort on a current credential conflict', async () => {
  assert.ok(pool);
  assert.ok(postgresUrl);
  const source = migrationSources();
  const tenant = `${tenantId}-conflict`;
  const conflictUser = `migrate-0-${suffix}`;
  const conflictLogin = `migrate-0-${suffix}@example.test`;
  try {
    const auth = createStore();
    await auth.initialize();
    await pool.query(
      `INSERT INTO e_mate_tenant_user (tenant_id, user_id, display_name, roles, status)
       VALUES ($1, 'existing-user', '既有用户', ARRAY['TENANT_ADMIN']::text[], 'ACTIVE'),
              ($1, $2, '冲突用户', ARRAY['MEMBER']::text[], 'ACTIVE')`,
      [tenant, conflictUser]
    );
    const current = await derivePasswordVerifier('existing-password');
    await pool.query(
      `INSERT INTO e_mate_auth_password_credential (
         credential_id, tenant_id, user_id, login_identifier_normalized,
         password_salt, password_hash, scrypt_cost, scrypt_block_size, scrypt_parallelization
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        randomUUID(),
        tenant,
        conflictUser,
        conflictLogin,
        current.salt,
        current.hash,
        current.cost,
        current.blockSize,
        current.parallelization,
      ]
    );
    await assert.rejects(
      migrateEcorexV0292Users({
        mode: 'apply',
        sourceAdminDatabase: source.admin,
        sourceControlDatabase: source.control,
        tenantId: tenant,
        databaseUrl: postgresUrl,
      }),
      /Target migration conflict/
    );
    const counts = await pool.query<{ migration: string; legacy: string; users: string }>(
      `SELECT
         (SELECT count(*) FROM e_mate_auth_credential_migration WHERE tenant_id = $1)::text AS migration,
         (SELECT count(*) FROM e_mate_auth_legacy_password_credential WHERE tenant_id = $1)::text AS legacy,
         (SELECT count(*) FROM e_mate_tenant_user WHERE tenant_id = $1)::text AS users`,
      [tenant]
    );
    assert.deepEqual(counts.rows[0], { migration: '0', legacy: '0', users: '2' });
  } finally {
    rmSync(source.directory, { recursive: true, force: true });
  }
});

integrationTest('Postgres password login and refresh rotation are hash-only, atomic, and replay-safe', async () => {
  assert.ok(pool);
  const now = new Date('2026-08-02T00:00:00.000Z');
  const store = new PostgresAuthStore(pool, {
    refreshDerivationSecret: Buffer.alloc(32, 9),
    modelRouteIds: ['gpt-5.6-sol', 'gpt-image-2.5-flare'],
    sessionLifetimeSeconds: 3_600,
    now: () => now,
  });
  await store.initialize();
  await pool.query(
    `INSERT INTO e_mate_tenant_user (tenant_id, user_id, display_name, roles, status)
     VALUES ($1, $2, '测试用户', ARRAY['MEMBER']::text[], 'ACTIVE')`,
    [tenantId, userId]
  );
  await pool.query(
    `INSERT INTO e_mate_tenant_model_route (tenant_id, route_id, enabled, updated_by)
     VALUES ($1, 'gpt-5.6-sol', true, 'test'), ($1, 'gpt-image-2.5-flare', false, 'test')`,
    [tenantId]
  );
  const password = 'integration-password';
  const passwordVerifier = await derivePasswordVerifier(password);
  await pool.query(
    `
    INSERT INTO e_mate_auth_password_credential (
      credential_id, tenant_id, user_id, login_identifier_normalized,
      password_salt, password_hash, scrypt_cost, scrypt_block_size, scrypt_parallelization
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `,
    [
      randomUUID(),
      tenantId,
      userId,
      login,
      passwordVerifier.salt,
      passwordVerifier.hash,
      passwordVerifier.cost,
      passwordVerifier.blockSize,
      passwordVerifier.parallelization,
    ]
  );
  assert.deepEqual(
    await store.authenticatePassword({ tenantId, clientId: 'e-mate-desktop', user: login, password: 'wrong' }),
    { ok: false, code: 'INVALID_GRANT' }
  );
  assert.deepEqual(
    await store.authenticatePassword({ tenantId, clientId: 'e-mate-desktop', user: login, password }),
    { ok: false, code: 'POLICY_REQUIRED' }
  );
  await allowDefaultModel(tenantId, userId);
  const loginResult = await store.authenticatePassword({
    tenantId,
    clientId: 'e-mate-desktop',
    user: login.toUpperCase(),
    password,
  });
  assert.equal(loginResult.ok, true);
  if (!loginResult.ok) return;
  assert.deepEqual(loginResult.identity.modelIds, ['gpt-5.6-sol']);
  const persisted = await pool.query<{ token_hash: Buffer }>(
    'SELECT token_hash FROM e_mate_auth_refresh_token WHERE session_id = $1 AND generation = 0',
    [loginResult.sessionId]
  );
  assert.deepEqual(persisted.rows[0]?.token_hash, refreshTokenHash(loginResult.refreshToken));
  assert.equal(JSON.stringify(persisted.rows).includes(loginResult.refreshToken), false);

  const firstRotation = await store.rotateRefreshToken({
    clientId: 'e-mate-desktop',
    refreshToken: loginResult.refreshToken,
    refreshRequestId: 'request-1',
  });
  assert.equal(firstRotation.ok, true);
  const retry = await store.rotateRefreshToken({
    clientId: 'e-mate-desktop',
    refreshToken: loginResult.refreshToken,
    refreshRequestId: 'request-1',
  });
  assert.deepEqual(retry, firstRotation);
  assert.deepEqual(
    await store.rotateRefreshToken({
      clientId: 'e-mate-desktop',
      refreshToken: loginResult.refreshToken,
      refreshRequestId: 'request-2',
    }),
    { ok: false, code: 'TOKEN_REUSED' }
  );
  if (!firstRotation.ok) return;
  assert.deepEqual(
    await store.rotateRefreshToken({
      clientId: 'e-mate-desktop',
      refreshToken: firstRotation.refreshToken,
      refreshRequestId: 'request-3',
    }),
    { ok: false, code: 'SESSION_REVOKED' }
  );
});

integrationTest('legacy image grants survive login and refresh while canonical tenant policy remains authoritative', async () => {
  assert.ok(pool);
  const store = createStore(); await store.initialize();
  const tenant = `${tenantId}-image-compat`, user = `${userId}-image-compat`;
  const userLogin = `image-${suffix}@example.test`;
  await insertLegacyUser(tenant, user, userLogin, 'legacy-password');
  await pool.query("UPDATE e_mate_tenant_user SET allowed_model_ids = ARRAY['gpt-5.6-sol','gpt-image-2-pro'] WHERE tenant_id=$1 AND user_id=$2", [tenant, user]);
  await pool.query("INSERT INTO e_mate_tenant_model_route (tenant_id,route_id,enabled,published,updated_by) VALUES ($1,'gpt-image-2-pro',false,true,'test')", [tenant]);
  const login = await store.authenticatePassword({ tenantId: tenant, clientId: 'e-mate-desktop', user: userLogin, password: 'legacy-password', clientVersion: '2.0.18' });
  assert.equal(login.ok, true); if (!login.ok) return;
  assert.deepEqual(login.identity.modelIds, ['gpt-5.6-sol']);
  await pool.query("UPDATE e_mate_tenant_model_route SET enabled=true WHERE tenant_id=$1 AND route_id='gpt-image-2-pro'", [tenant]);
  const refresh = await store.rotateRefreshToken({ clientId: 'e-mate-desktop', refreshToken: login.refreshToken, refreshRequestId: 'image-compat-1', clientVersion: '2.0.18' });
  assert.equal(refresh.ok, true); if (!refresh.ok) return;
  assert.deepEqual(refresh.identity.modelIds, ['gpt-5.6-sol','gpt-image-2.5-flare']);
  const { PostgresUsageStore } = await import('../../model-gateway/src/postgres-usage-store.ts');
  const usage = new PostgresUsageStore(pool, { tenantRequestsPerMinute: 1000, tenantBurst: 1000, tenantMaxConcurrent: 1, invocationLeaseMs: 180000 });
  const principal = { tenantId: tenant, userId: user, modelIds: ['gpt-image-2-pro'] };
  assert.deepEqual(await usage.activeModelIds(principal, ['gpt-image-2.5-flare']), ['gpt-image-2.5-flare']);
  await pool.query("UPDATE e_mate_tenant_user SET allowed_model_ids=ARRAY['gpt-5.6-sol'] WHERE tenant_id=$1 AND user_id=$2", [tenant,user]);
  assert.deepEqual(await usage.activeModelIds(principal, ['gpt-image-2.5-flare']), []);
  await pool.query("UPDATE e_mate_tenant_user SET allowed_model_ids=ARRAY['gpt-5.6-sol','gpt-image-2.5-flare'] WHERE tenant_id=$1 AND user_id=$2", [tenant,user]);
  assert.deepEqual(await usage.activeModelIds(principal, ['gpt-image-2.5-flare']), ['gpt-image-2.5-flare']);

  await pool.query("INSERT INTO e_mate_tenant_model_route (tenant_id,route_id,enabled,published,updated_by) VALUES ($1,'gpt-image-2.5-flare',false,true,'test')", [tenant]);
  const disabled = await store.rotateRefreshToken({ clientId: 'e-mate-desktop', refreshToken: refresh.refreshToken, refreshRequestId: 'image-compat-2', clientVersion: '2.0.18' });
  assert.equal(disabled.ok, true); if (!disabled.ok) return;
  assert.deepEqual(disabled.identity.modelIds, ['gpt-5.6-sol']);
});
