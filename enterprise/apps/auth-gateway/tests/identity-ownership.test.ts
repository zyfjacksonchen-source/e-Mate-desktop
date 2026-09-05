import assert from 'node:assert/strict';
import { pbkdf2Sync, randomUUID } from 'node:crypto';
import test, { after, before, type TestContext } from 'node:test';
import { Pool } from 'pg';
import { AUTH_CREDENTIAL_SCHEMA_SQL, AUTH_LOGIN_IDENTITY_PREFLIGHT_SQL, isLoginIdentityConflict } from '@e-mate/auth-credential';
import { PostgresAdminManagementStore, AdminManagementError } from '../../analytics-api/src/admin-management.ts';
import { PostgresAuthStore } from '../src/postgres-store.ts';

const url = process.env.E_MATE_TEST_POSTGRES_URL;
const integration = url ? test : test.skip;
const base = url ? new Pool({ connectionString: url, connectionTimeoutMillis: 10_000 }) : undefined;
const catalog = [
  { routeId: 'gpt-5.6-sol', label: 'Sol', provider: 'fixture' },
  { routeId: 'gpt-6-astra', label: 'Astra', provider: 'fixture' },
];
before(async () => { if (base) await new PostgresAdminManagementStore(base, catalog).initialize(); });
after(async () => { await base?.end(); });

async function fixture(t: TestContext) {
  const schema = `identity_${randomUUID().replaceAll('-', '')}`;
  await base!.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema},public`, max: 4, connectionTimeoutMillis: 10_000 });
  t.after(async () => { await pool.end(); await base!.query(`DROP SCHEMA ${schema} CASCADE`); });
  const admin = new PostgresAdminManagementStore(pool, catalog);
  await admin.initialize();
  const auth = new PostgresAuthStore(pool, { refreshDerivationSecret: Buffer.alloc(32, 7),
    modelRouteIds: catalog.map(({ routeId }) => routeId), sessionLifetimeSeconds: 3600 });
  await auth.initialize();
  return { pool, admin, auth, schema };
}
const principal = { tenantId: 'fixture', userId: 'admin', roles: ['TENANT_ADMIN'] };
const password = 'Synthetic-password-2026!';
const create = (userId: string) => ({ schemaVersion: 1 as const, userId, displayName: 'Synthetic user',
  roles: ['MEMBER' as const], tokenLimit: 1000, allowedModelIds: ['gpt-5.6-sol'], initialPassword: password });

async function legacy(pool: Pool, userId = 'legacy-user', account = 'legacy@example.test') {
  const salt = Buffer.alloc(16, 8);
  const hash = `pbkdf2_sha256$180000$${salt.toString('base64')}$${pbkdf2Sync(password, salt, 180000, 32, 'sha256').toString('base64')}`;
  await pool.query(`INSERT INTO e_mate_tenant_user (tenant_id,user_id,display_name,roles,status,allowed_model_ids)
    VALUES ('fixture',$1,'Synthetic user',ARRAY['MEMBER'],'ACTIVE',ARRAY['gpt-5.6-sol'])`, [userId]);
  await pool.query(`INSERT INTO e_mate_auth_credential_migration (tenant_id,user_id,source_version,source_record_sha256)
    VALUES ('fixture',$1,'0.2.9.2',$2)`, [userId, Buffer.alloc(32, 4)]);
  await pool.query(`INSERT INTO e_mate_auth_legacy_password_credential
    (credential_id,tenant_id,user_id,login_identifier_normalized,algorithm,encoded_hash,source_version,source_record_sha256)
    VALUES ($1,'fixture',$2,$3,'pbkdf2_sha256',$4,'0.2.9.2',$5)`, [randomUUID(), userId, account, hash, Buffer.alloc(32, 4)]);
}

integration('registration reserves one normalized identity across current, legacy and concurrent admin creation', async (t) => {
  const { pool, auth, admin } = await fixture(t);
  await legacy(pool);
  const registration = async (account: string) => {
    const challenge = await auth.issueRegistrationChallenge();
    return auth.register({ tenantId: 'fixture', account, realName: 'Synthetic user', password,
      challengeId: challenge.challengeId, verificationCode: challenge.code });
  };
  assert.deepEqual(await registration(' LEGACY@EXAMPLE.TEST '), { ok: false, code: 'ACCOUNT_EXISTS' });
  const simultaneous = await Promise.all([registration('new-member'), registration('NEW-MEMBER')]);
  assert.equal(simultaneous.filter(({ ok }) => ok).length, 1);
  assert.deepEqual(simultaneous.find(({ ok }) => !ok), { ok: false, code: 'ACCOUNT_EXISTS' });
  const mixed = await Promise.allSettled([registration('mixed-member'), admin.createUser(principal, create('MIXED-MEMBER'))]);
  const success = mixed.filter((result) => result.status === 'fulfilled' && (!('ok' in result.value) || result.value.ok));
  assert.equal(success.length, 1);
  for (const result of mixed) if (result.status === 'rejected') {
    assert(result.reason instanceof AdminManagementError);
    assert.equal(result.reason.code, 'CONFLICT');
  }
  const counts = await pool.query(`SELECT
    (SELECT count(*)::int FROM e_mate_auth_login_identity) AS owners,
    (SELECT count(*)::int FROM e_mate_tenant_user) AS users`);
  assert.deepEqual(counts.rows[0], { owners: 3, users: 3 });
});

integration('legacy password reset retains its login, revokes sessions and keeps migration evidence', async (t) => {
  const { pool, auth, admin } = await fixture(t);
  await legacy(pool);
  const sid = randomUUID();
  await pool.query(`INSERT INTO e_mate_auth_session (session_id,tenant_id,user_id,client_id,status,expires_at)
    VALUES ($1,'fixture','legacy-user','e-mate-desktop','ACTIVE',clock_timestamp()+interval '1 hour')`, [sid]);
  await pool.query(`INSERT INTO e_mate_auth_refresh_token (token_hash,session_id,generation,status,expires_at)
    VALUES ($1,$2,0,'ACTIVE',clock_timestamp()+interval '1 hour')`, [Buffer.alloc(32, 5), sid]);
  await admin.resetPassword(principal, 'legacy-user', { schemaVersion: 1, password: 'Replacement-synthetic-2026!' });
  assert.deepEqual((await pool.query('SELECT login_identifier_normalized FROM e_mate_auth_password_credential')).rows,
    [{ login_identifier_normalized: 'legacy@example.test' }]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM e_mate_auth_legacy_password_credential')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT upgraded_at IS NOT NULL AS upgraded FROM e_mate_auth_credential_migration')).rows[0].upgraded, true);
  assert.equal((await pool.query('SELECT status FROM e_mate_auth_session')).rows[0].status, 'REVOKED');
  assert.equal((await pool.query('SELECT status FROM e_mate_auth_refresh_token')).rows[0].status, 'REVOKED');
  assert.deepEqual(await auth.authenticatePassword({ tenantId: 'fixture', clientId: 'e-mate-desktop', user: 'legacy@example.test', password }),
    { ok: false, code: 'INVALID_GRANT' });
  assert.equal((await auth.authenticatePassword({ tenantId: 'fixture', clientId: 'e-mate-desktop', user: 'legacy@example.test',
    password: 'Replacement-synthetic-2026!' })).ok, true);
});

integration('Astra is opt-in and issued only for 2.0.18 login/refresh; quota edits preserve disabled grants', async (t) => {
  const { auth, admin, pool } = await fixture(t);
  const created = await admin.createUser(principal, create('member'));
  await admin.updateModelRoute(principal, 'gpt-6-astra', { schemaVersion: 1, enabled: true });
  const policy = { schemaVersion: 1 as const, displayName: created.displayName, roles: created.roles, status: 'ACTIVE' as const,
    tokenLimit: 1000, allowedModelIds: ['gpt-5.6-sol', 'gpt-6-astra'], expectedUpdatedAt: created.updatedAt };
  const granted = await admin.updateUser(principal, 'member', policy);
  assert(granted);
  const login = { tenantId: 'fixture', clientId: 'e-mate-desktop', user: 'member', password };
  const old = await auth.authenticatePassword(login);
  const modern = await auth.authenticatePassword({ ...login, clientVersion: '2.0.18' });
  assert(old.ok && modern.ok);
  assert.deepEqual(old.identity.modelIds, ['gpt-5.6-sol']);
  assert.deepEqual(modern.identity.modelIds, ['gpt-5.6-sol', 'gpt-6-astra']);
  const rotated = await auth.rotateRefreshToken({ clientId: login.clientId, refreshToken: modern.refreshToken, refreshRequestId: randomUUID() });
  assert(rotated.ok);
  assert.deepEqual(rotated.identity.modelIds, ['gpt-5.6-sol']);
  const reordered = await admin.updateUser(principal, 'member', { ...policy, expectedUpdatedAt: granted.updatedAt,
    allowedModelIds: ['gpt-6-astra', 'gpt-5.6-sol'] });
  assert(reordered);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM e_mate_auth_session WHERE status='REVOKED'")).rows[0].n, 0);
  await admin.updateModelRoute(principal, 'gpt-6-astra', { schemaVersion: 1, enabled: false });
  assert(await admin.updateUser(principal, 'member', { ...policy, expectedUpdatedAt: reordered.updatedAt, tokenLimit: 2000 }));
  await assert.rejects(admin.createUser(principal, { ...create('invalid'), allowedModelIds: ['gpt-6-astra'] }), /Invalid allowed model policy/);
  const latest = (await admin.listUsers(principal)).users.find(({ userId }) => userId === 'member')!;
  const concurrent = await Promise.allSettled([3000, 4000].map((tokenLimit) => admin.updateUser(principal, 'member', {
    ...policy, tokenLimit, expectedUpdatedAt: latest.updatedAt,
  })));
  assert.equal(concurrent.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = concurrent.find(({ status }) => status === 'rejected');
  assert(rejected?.status === 'rejected' && rejected.reason instanceof AdminManagementError);
  assert.equal(rejected.reason.code, 'STALE_UPDATE');
});

integration('a legacy import with an older serializable snapshot cannot claim a newly reserved account', async (t) => {
  const { pool, admin } = await fixture(t);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query('SELECT count(*) FROM e_mate_auth_login_identity');
    await admin.createUser(principal, create('reserved'));
    await client.query(`INSERT INTO e_mate_tenant_user (tenant_id,user_id,display_name,roles,status)
      VALUES ('fixture','late-import','Synthetic user',ARRAY['MEMBER'],'PENDING_APPROVAL')`);
    await assert.rejects(client.query(`INSERT INTO e_mate_auth_legacy_password_credential
      (credential_id,tenant_id,user_id,login_identifier_normalized,algorithm,encoded_hash,source_version,source_record_sha256)
      VALUES ($1,'fixture','late-import','reserved','pbkdf2_sha256',$2,'0.2.9.2',$3)`,
      [randomUUID(), `pbkdf2_sha256$180000$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(32).toString('base64')}`, Buffer.alloc(32)]),
      (error: unknown) => isLoginIdentityConflict(error) || (error as { code?: string }).code === '40001');
    await client.query('ROLLBACK');
    assert.deepEqual((await pool.query('SELECT user_id FROM e_mate_auth_login_identity')).rows, [{ user_id: 'reserved' }]);
    assert.deepEqual((await pool.query('SELECT user_id FROM e_mate_tenant_user')).rows, [{ user_id: 'reserved' }]);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

integration('shared schema detects ambiguous historical owners without merging or partially backfilling', async (t) => {
  const schema = `historical_${randomUUID().replaceAll('-', '')}`;
  await base!.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema},public`, max: 1 });
  t.after(async () => { await pool.end(); await base!.query(`DROP SCHEMA ${schema} CASCADE`); });
  await pool.query(`CREATE TABLE e_mate_tenant_user (tenant_id text,user_id text,PRIMARY KEY(tenant_id,user_id));
    INSERT INTO e_mate_tenant_user VALUES ('fixture','original'),('fixture','duplicate');
    CREATE TABLE e_mate_auth_password_credential (tenant_id text,user_id text,login_identifier_normalized text);
    CREATE TABLE e_mate_auth_legacy_password_credential (tenant_id text,user_id text,login_identifier_normalized text);
    INSERT INTO e_mate_auth_password_credential VALUES ('fixture','original','same');
    INSERT INTO e_mate_auth_legacy_password_credential VALUES ('fixture','duplicate','same');`);
  assert.deepEqual((await pool.query(AUTH_LOGIN_IDENTITY_PREFLIGHT_SQL)).rows, [{ conflicting_accounts: '1' }]);
  await assert.rejects(pool.query(AUTH_CREDENTIAL_SCHEMA_SQL), /Conflicting login identity owners/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM e_mate_tenant_user')).rows[0].n, 2);
  assert.equal((await pool.query('SELECT to_regclass($1)::text AS name', [`${schema}.e_mate_auth_login_identity`])).rows[0].name, null);
  // A separately reviewed correction is simulated only in this synthetic fixture.
  await pool.query("UPDATE e_mate_auth_legacy_password_credential SET login_identifier_normalized = 'different'");
  await pool.query(AUTH_CREDENTIAL_SCHEMA_SQL);
  assert.deepEqual((await pool.query('SELECT user_id FROM e_mate_auth_login_identity ORDER BY user_id')).rows,
    [{ user_id: 'duplicate' }, { user_id: 'original' }]);
});

test('only the named account ownership constraint maps to an account conflict', () => {
  assert.equal(isLoginIdentityConflict({ code: '23505', constraint: 'e_mate_auth_login_identity_owner' }), true);
  assert.equal(isLoginIdentityConflict({ code: '23505', constraint: 'unrelated_primary_key' }), false);
  assert.equal(isLoginIdentityConflict({ code: '40001' }), false);
});
