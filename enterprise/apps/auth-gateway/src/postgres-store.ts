import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { DEFAULT_ENABLED_MODEL_ROUTE_IDS, modelSupportsClient } from '@e-mate/admin-contract';
import {
  AUTH_CREDENTIAL_SCHEMA_SQL,
  AUTH_CREDENTIAL_SOURCE_VERSION_MIGRATION_SQL,
  normalizeLoginIdentifier,
  isLoginIdentityConflict,
} from '@e-mate/auth-credential';
import type { Pool, PoolClient } from 'pg';
import {
  createRefreshToken,
  derivePasswordVerifier,
  deriveRefreshToken,
  refreshTokenHash,
  verifyEcorexV0292Password,
  verifyPassword,
  type AuthIdentity,
  type ScryptVerifier,
} from './crypto.ts';
import type {
  AuthenticationResult,
  AuthStore,
  LogoutInput,
  MutationReceipt,
  PasswordChangeInput,
  PasswordAuthenticationInput,
  RefreshAuthenticationInput,
  RegistrationChallenge,
  RegistrationInput,
  RegistrationResult,
  AuthErrorCode,
} from './types.ts';

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const refreshTokenPattern = /^emate_rt_[A-Za-z0-9_-]{43}$/;
const allowedRoles = new Set(['TENANT_ADMIN', 'AUDIT_ADMIN', 'MEMBER']);

type CredentialRow = {
  credential_id: string;
  tenant_id: string;
  user_id: string;
  display_name: string | null;
  roles: string[] | null;
  status: string | null;
  token_limit: string | null;
  allowed_model_ids: string[] | null;
  password_salt: Buffer;
  password_hash: Buffer;
  scrypt_cost: number;
  scrypt_block_size: number;
  scrypt_parallelization: number;
};

type RefreshRow = {
  session_id: string;
  tenant_id: string;
  user_id: string;
  client_id: string;
  session_status: string;
  session_expires_at: Date;
  token_status: string;
  token_generation: number;
  token_expires_at: Date;
  consumed_request_id: string | null;
  replacement_generation: number | null;
  display_name: string | null;
  roles: string[] | null;
  user_status: string | null;
  token_limit: string | null;
  allowed_model_ids: string[] | null;
};

type LegacyCredentialRow = Pick<
  CredentialRow,
  'credential_id' | 'tenant_id' | 'user_id' | 'display_name' | 'roles' | 'status' | 'token_limit'
> & {
  algorithm: string;
  encoded_hash: string;
  source_version: string;
};

export type PostgresAuthStoreOptions = {
  refreshDerivationSecret: Buffer;
  modelRouteIds: readonly string[];
  sessionLifetimeSeconds: number;
  now?: () => Date;
};

function identifier(value: string, label: string): string {
  if (!identifierPattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function validRoles(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 3 &&
    value.every((role) => typeof role === 'string' && allowedRoles.has(role)) &&
    new Set(value).size === value.length
  );
}

export function issuedWeeklyTokenLimit(value: string | null): number | null {
  if (value === null) return Number.MAX_SAFE_INTEGER;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function verifier(row: CredentialRow): ScryptVerifier | undefined {
  if (
    !Buffer.isBuffer(row.password_salt) ||
    !Buffer.isBuffer(row.password_hash) ||
    !Number.isSafeInteger(row.scrypt_cost) ||
    !Number.isSafeInteger(row.scrypt_block_size) ||
    !Number.isSafeInteger(row.scrypt_parallelization)
  ) {
    return undefined;
  }
  return {
    salt: row.password_salt,
    hash: row.password_hash,
    cost: row.scrypt_cost,
    blockSize: row.scrypt_block_size,
    parallelization: row.scrypt_parallelization,
  };
}

function identityFromRow(
  row: Pick<CredentialRow, 'tenant_id' | 'user_id' | 'display_name' | 'roles' | 'status' | 'token_limit'>,
  modelIds: string[]
): AuthIdentity | null {
  const weeklyTokenLimit = issuedWeeklyTokenLimit(row.token_limit);
  if (
    row.status !== 'ACTIVE' ||
    !identifierPattern.test(row.tenant_id) ||
    !identifierPattern.test(row.user_id) ||
    typeof row.display_name !== 'string' ||
    !row.display_name.trim() ||
    row.display_name.length > 160 ||
    !validRoles(row.roles) ||
    weeklyTokenLimit === null ||
    modelIds.length < 1
  ) {
    return null;
  }
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    displayName: row.display_name,
    roles: [...row.roles],
    modelIds,
    weeklyTokenLimit,
  };
}

function loginPolicyError(
  row: Pick<CredentialRow, 'status' | 'token_limit'>,
  modelIds: readonly string[]
): AuthErrorCode {
  if (row.status === 'PENDING_APPROVAL') return 'APPROVAL_REQUIRED';
  if (
    row.status === 'ACTIVE' &&
    (issuedWeeklyTokenLimit(row.token_limit) === null || modelIds.length < 1)
  ) {
    return 'POLICY_REQUIRED';
  }
  return 'INVALID_GRANT';
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

export class PostgresAuthStore implements AuthStore {
  readonly #pool: Pool;
  readonly #refreshSecret: Buffer;
  readonly #routeIds: string[];
  readonly #sessionLifetimeSeconds: number;
  readonly #now: () => Date;

  constructor(pool: Pool, options: PostgresAuthStoreOptions) {
    if (options.refreshDerivationSecret.byteLength !== 32) {
      throw new Error('Refresh derivation secret must be 32 bytes');
    }
    if (
      options.modelRouteIds.length < 1 ||
      options.modelRouteIds.length > 20 ||
      options.modelRouteIds.some((routeId) => !identifierPattern.test(routeId) || routeId === 'e-mate-faux') ||
      new Set(options.modelRouteIds).size !== options.modelRouteIds.length
    ) {
      throw new Error('Invalid model route catalog');
    }
    if (
      !Number.isSafeInteger(options.sessionLifetimeSeconds) ||
      options.sessionLifetimeSeconds < 300 ||
      options.sessionLifetimeSeconds > 30 * 24 * 60 * 60
    ) {
      throw new Error('Invalid session lifetime');
    }
    this.#pool = pool;
    this.#refreshSecret = Buffer.from(options.refreshDerivationSecret);
    this.#routeIds = [...options.modelRouteIds];
    this.#sessionLifetimeSeconds = options.sessionLifetimeSeconds;
    this.#now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    const existing = await this.#pool.query<{ tenant_user: string | null; model_route: string | null }>(`
      SELECT to_regclass('public.e_mate_tenant_user')::text AS tenant_user,
             to_regclass('public.e_mate_tenant_model_route')::text AS model_route
    `);
    if (!existing.rows[0]?.tenant_user || !existing.rows[0]?.model_route) {
      throw new Error('Required enterprise tenant tables are unavailable');
    }
    await this.#pool.query('SELECT published FROM e_mate_tenant_model_route LIMIT 0');
    await this.#pool.query(AUTH_CREDENTIAL_SCHEMA_SQL);
    await this.#pool.query(AUTH_CREDENTIAL_SOURCE_VERSION_MIGRATION_SQL);
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS e_mate_auth_registration_challenge (
        challenge_id uuid PRIMARY KEY,
        answer_hash bytea NOT NULL CHECK (octet_length(answer_hash) = 32),
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        consumed_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS e_mate_auth_registration_challenge_expiry
        ON e_mate_auth_registration_challenge (expires_at);
    `);
  }

  #challengeHash(challengeId: string, code: string): Buffer {
    return createHmac('sha256', this.#refreshSecret)
      .update('e-mate-registration-challenge-v1\0', 'utf8')
      .update(challengeId, 'utf8')
      .update('\0', 'utf8')
      .update(code, 'utf8')
      .digest();
  }

  async issueRegistrationChallenge(): Promise<RegistrationChallenge> {
    const challengeId = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(this.#now().getTime() + 2 * 60_000);
    await this.#pool.query(
      `INSERT INTO e_mate_auth_registration_challenge (challenge_id, answer_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [challengeId, this.#challengeHash(challengeId, code), expiresAt]
    );
    return { challengeId, code, expiresAt };
  }

  async register(input: RegistrationInput): Promise<RegistrationResult> {
    const tenantId = identifier(input.tenantId, 'tenant id');
    const challengeId = identifier(input.challengeId, 'challenge id');
    const account = normalizeLoginIdentifier(input.account);
    const realName = input.realName.normalize('NFKC').trim();
    if (realName.length < 2 || realName.length > 120 || /\p{Cc}/u.test(realName)) {
      throw new Error('Invalid real name');
    }
    const next = await derivePasswordVerifier(input.password);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const challenge = await client.query<{ answer_hash: Buffer; expires_at: Date }>(
        `UPDATE e_mate_auth_registration_challenge
            SET consumed_at = $2
          WHERE challenge_id = $1 AND consumed_at IS NULL
        RETURNING answer_hash, expires_at`,
        [challengeId, this.#now()]
      );
      const row = challenge.rows[0];
      const expected = this.#challengeHash(challengeId, input.verificationCode);
      if (
        !row ||
        !Buffer.isBuffer(row.answer_hash) ||
        row.answer_hash.byteLength !== expected.byteLength ||
        !timingSafeEqual(row.answer_hash, expected) ||
        row.expires_at.getTime() <= this.#now().getTime()
      ) {
        await client.query('COMMIT');
        return { ok: false, code: 'INVALID_CHALLENGE' };
      }
      const existing = await client.query(
        `SELECT 1 FROM e_mate_auth_login_identity
          WHERE tenant_id = $1 AND login_identifier_normalized = $2`,
        [tenantId, account]
      );
      if (existing.rowCount !== 0) {
        await client.query('COMMIT');
        return { ok: false, code: 'ACCOUNT_EXISTS' };
      }
      const userId = randomUUID();
      await client.query(
        `INSERT INTO e_mate_tenant_user (
           tenant_id, user_id, display_name, roles, status, token_limit, allowed_model_ids
         ) VALUES ($1, $2, $3, ARRAY['MEMBER']::text[], 'PENDING_APPROVAL', NULL, ARRAY[]::text[])`,
        [tenantId, userId, realName]
      );
      await client.query(
        `INSERT INTO e_mate_auth_password_credential (
           credential_id, tenant_id, user_id, login_identifier_normalized,
           password_salt, password_hash, scrypt_cost, scrypt_block_size, scrypt_parallelization
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          randomUUID(),
          tenantId,
          userId,
          account,
          next.salt,
          next.hash,
          next.cost,
          next.blockSize,
          next.parallelization,
        ]
      );
      await client.query('COMMIT');
      return { ok: true, registrationId: userId };
    } catch (error) {
      await rollback(client);
      if (isLoginIdentityConflict(error)) return { ok: false, code: 'ACCOUNT_EXISTS' };
      throw error;
    } finally {
      client.release();
    }
  }

  async #enabledModelIds(client: PoolClient, tenantId: string, userId: string, clientVersion?: string): Promise<string[]> {
    const result = await client.query<{ model_ids: string[] }>(
      `
      SELECT ARRAY(
        SELECT candidate.route_id
          FROM unnest($2::text[]) WITH ORDINALITY AS candidate(route_id, position)
          LEFT JOIN LATERAL (
            SELECT enabled, published FROM e_mate_tenant_model_route
             WHERE tenant_id = $1 AND (route_id = candidate.route_id OR
               (candidate.route_id = 'gpt-image-2.5-flare' AND route_id = 'gpt-image-2-pro'))
             ORDER BY (route_id = candidate.route_id) DESC LIMIT 1
          ) AS policy ON true
         WHERE (candidate.route_id = ANY(app_user.allowed_model_ids) OR
           (candidate.route_id = 'gpt-image-2.5-flare' AND 'gpt-image-2-pro' = ANY(app_user.allowed_model_ids)))
           AND COALESCE(policy.published, true)
           AND COALESCE(policy.enabled, candidate.route_id = ANY($4::text[]))
         ORDER BY candidate.position
      ) AS model_ids
        FROM e_mate_tenant_user AS app_user
       WHERE app_user.tenant_id = $1 AND app_user.user_id = $3
    `,
      [tenantId, this.#routeIds.filter((id) => modelSupportsClient(id, clientVersion)), userId, DEFAULT_ENABLED_MODEL_ROUTE_IDS]
    );
    const modelIds = result.rows[0]?.model_ids;
    if (
      !Array.isArray(modelIds) ||
      modelIds.some((routeId) => !this.#routeIds.includes(routeId)) ||
      new Set(modelIds).size !== modelIds.length
    ) {
      throw new Error('Model route policy was unavailable');
    }
    return modelIds;
  }

  async #createSession(
    client: PoolClient,
    identity: AuthIdentity,
    clientId: string
  ): Promise<Extract<AuthenticationResult, { ok: true }>> {
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + this.#sessionLifetimeSeconds * 1_000);
    const sessionId = randomUUID();
    const refreshToken = createRefreshToken();
    await client.query(
      `
      INSERT INTO e_mate_auth_session (
        session_id, tenant_id, user_id, client_id, status, expires_at, created_at
      ) VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6)
    `,
      [sessionId, identity.tenantId, identity.userId, clientId, expiresAt, now]
    );
    await client.query(
      `
      INSERT INTO e_mate_auth_refresh_token (
        token_hash, session_id, generation, status, expires_at, created_at
      ) VALUES ($1, $2, 0, 'ACTIVE', $3, $4)
    `,
      [refreshTokenHash(refreshToken), sessionId, expiresAt, now]
    );
    return { ok: true, identity, sessionId, refreshToken };
  }

  async #authenticateLegacyPassword(
    tenantId: string,
    loginIdentifier: string,
    clientId: string,
    password: string,
    clientVersion?: string
  ): Promise<AuthenticationResult> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const lookup = await client.query<LegacyCredentialRow>(
        `
        SELECT credential.credential_id,
               credential.tenant_id,
               credential.user_id,
               credential.algorithm,
               credential.encoded_hash,
               credential.source_version,
               app_user.display_name,
               app_user.roles,
               app_user.status,
               app_user.token_limit,
               app_user.allowed_model_ids
          FROM e_mate_auth_legacy_password_credential AS credential
          JOIN e_mate_auth_credential_migration AS migration
            ON migration.tenant_id = credential.tenant_id
           AND migration.user_id = credential.user_id
           AND migration.source_version = credential.source_version
           AND migration.source_record_sha256 = credential.source_record_sha256
          JOIN e_mate_tenant_user AS app_user
            ON app_user.tenant_id = credential.tenant_id
           AND app_user.user_id = credential.user_id
         WHERE credential.tenant_id = $1
           AND credential.login_identifier_normalized = $2
           AND credential.algorithm = 'pbkdf2_sha256'
           AND credential.source_version IN ('0.2.9.2', 'admin')
         FOR UPDATE OF credential, app_user
      `,
        [tenantId, loginIdentifier]
      );
      const legacy = lookup.rows[0];
      if (!legacy) {
        const upgraded = await client.query<CredentialRow>(
          `
          SELECT credential.credential_id,
                 credential.tenant_id,
                 credential.user_id,
                 app_user.display_name,
                 app_user.roles,
                 app_user.status,
                 app_user.token_limit,
                 app_user.allowed_model_ids,
                 credential.password_salt,
                 credential.password_hash,
                 credential.scrypt_cost,
                 credential.scrypt_block_size,
                 credential.scrypt_parallelization
            FROM e_mate_auth_password_credential AS credential
            JOIN e_mate_tenant_user AS app_user
              ON app_user.tenant_id = credential.tenant_id
             AND app_user.user_id = credential.user_id
           WHERE credential.tenant_id = $1
             AND credential.login_identifier_normalized = $2
           FOR UPDATE OF credential, app_user
        `,
          [tenantId, loginIdentifier]
        );
        const current = upgraded.rows[0];
        if (!(await verifyPassword(password, current ? verifier(current) : undefined)) || !current) {
          await rollback(client);
          return { ok: false, code: 'INVALID_GRANT' };
        }
        const modelIds = await this.#enabledModelIds(client, tenantId, current.user_id, clientVersion);
        const identity = identityFromRow(current, modelIds);
        if (!identity) {
          await rollback(client);
          return { ok: false, code: loginPolicyError(current, modelIds) };
        }
        const result = await this.#createSession(client, identity, clientId);
        await client.query('COMMIT');
        return result;
      }
      if (!(await verifyEcorexV0292Password(password, legacy.encoded_hash))) {
        await rollback(client);
        return { ok: false, code: 'INVALID_GRANT' };
      }
      const modelIds = await this.#enabledModelIds(client, tenantId, legacy.user_id, clientVersion);
      const identity = identityFromRow(legacy, modelIds);
      if (!identity) {
        await rollback(client);
        return { ok: false, code: loginPolicyError(legacy, modelIds) };
      }
      const next = await derivePasswordVerifier(password);
      const inserted = await client.query(
        `
        INSERT INTO e_mate_auth_password_credential (
          credential_id, tenant_id, user_id, login_identifier_normalized,
          password_salt, password_hash, scrypt_cost, scrypt_block_size, scrypt_parallelization
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
        [
          randomUUID(),
          legacy.tenant_id,
          legacy.user_id,
          loginIdentifier,
          next.salt,
          next.hash,
          next.cost,
          next.blockSize,
          next.parallelization,
        ]
      );
      if (inserted.rowCount !== 1) throw new Error('Legacy password upgrade was not persisted');
      const audited = await client.query(
        `
        UPDATE e_mate_auth_credential_migration
           SET upgraded_at = COALESCE(upgraded_at, now())
         WHERE tenant_id = $1
           AND user_id = $2
           AND source_version = $3
           AND source_record_sha256 = (
             SELECT source_record_sha256
               FROM e_mate_auth_legacy_password_credential
              WHERE credential_id = $4
           )
      `,
        [legacy.tenant_id, legacy.user_id, legacy.source_version, legacy.credential_id]
      );
      if (audited.rowCount !== 1) throw new Error('Legacy password upgrade lost its migration evidence');
      const removed = await client.query(
        `DELETE FROM e_mate_auth_legacy_password_credential WHERE credential_id = $1`,
        [legacy.credential_id]
      );
      if (removed.rowCount !== 1) throw new Error('Legacy password upgrade lost its lock');
      const result = await this.#createSession(client, identity, clientId);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async authenticatePassword(input: PasswordAuthenticationInput): Promise<AuthenticationResult> {
    const tenantId = identifier(input.tenantId, 'tenant id');
    const clientId = identifier(input.clientId, 'client id');
    const loginIdentifier = normalizeLoginIdentifier(input.user);
    const lookup = await this.#pool.query<CredentialRow>(
      `
      SELECT credential.credential_id,
             credential.tenant_id,
             credential.user_id,
             app_user.display_name,
             app_user.roles,
             app_user.status,
             app_user.token_limit,
             app_user.allowed_model_ids,
             credential.password_salt,
             credential.password_hash,
             credential.scrypt_cost,
             credential.scrypt_block_size,
             credential.scrypt_parallelization
        FROM e_mate_auth_password_credential AS credential
        LEFT JOIN e_mate_tenant_user AS app_user
          ON app_user.tenant_id = credential.tenant_id
         AND app_user.user_id = credential.user_id
       WHERE credential.tenant_id = $1
         AND credential.login_identifier_normalized = $2
       LIMIT 1
    `,
      [tenantId, loginIdentifier]
    );
    const candidate = lookup.rows[0];
    if (!candidate) {
      return this.#authenticateLegacyPassword(tenantId, loginIdentifier, clientId, input.password, input.clientVersion);
    }
    if (!(await verifyPassword(input.password, verifier(candidate)))) {
      return { ok: false, code: 'INVALID_GRANT' };
    }

    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<CredentialRow>(
        `
        SELECT credential.credential_id,
               credential.tenant_id,
               credential.user_id,
               app_user.display_name,
               app_user.roles,
               app_user.status,
               app_user.token_limit,
               app_user.allowed_model_ids,
               credential.password_salt,
               credential.password_hash,
               credential.scrypt_cost,
               credential.scrypt_block_size,
               credential.scrypt_parallelization
          FROM e_mate_auth_password_credential AS credential
          JOIN e_mate_tenant_user AS app_user
            ON app_user.tenant_id = credential.tenant_id
           AND app_user.user_id = credential.user_id
         WHERE credential.credential_id = $1
         FOR UPDATE OF credential, app_user
      `,
        [candidate.credential_id]
      );
      const current = locked.rows[0];
      const candidateVerifier = verifier(candidate);
      const currentVerifier = current ? verifier(current) : undefined;
      if (
        !current ||
        !candidateVerifier ||
        !currentVerifier ||
        !timingSafeEqual(candidateVerifier.hash, currentVerifier.hash) ||
        !timingSafeEqual(candidateVerifier.salt, currentVerifier.salt)
      ) {
        await rollback(client);
        return { ok: false, code: 'INVALID_GRANT' };
      }
      const modelIds = await this.#enabledModelIds(client, tenantId, current.user_id, input.clientVersion);
      const identity = identityFromRow(current, modelIds);
      if (!identity) {
        await rollback(client);
        return { ok: false, code: loginPolicyError(current, modelIds) };
      }
      const result = await this.#createSession(client, identity, clientId);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async #revokeSession(client: PoolClient, sessionId: string, now: Date): Promise<void> {
    await client.query(`UPDATE e_mate_auth_session SET status = 'REVOKED', revoked_at = $2 WHERE session_id = $1`, [
      sessionId,
      now,
    ]);
    await client.query(
      `UPDATE e_mate_auth_refresh_token SET status = 'REVOKED' WHERE session_id = $1 AND status = 'ACTIVE'`,
      [sessionId]
    );
  }

  async rotateRefreshToken(input: RefreshAuthenticationInput): Promise<AuthenticationResult> {
    const clientId = identifier(input.clientId, 'client id');
    const requestId = identifier(input.refreshRequestId, 'refresh request id');
    if (!refreshTokenPattern.test(input.refreshToken)) return { ok: false, code: 'INVALID_GRANT' };
    const tokenHash = refreshTokenHash(input.refreshToken);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const lookup = await client.query<RefreshRow>(
        `
        SELECT session.session_id,
               session.tenant_id,
               session.user_id,
               session.client_id,
               session.status AS session_status,
               session.expires_at AS session_expires_at,
               refresh.status AS token_status,
               refresh.generation AS token_generation,
               refresh.expires_at AS token_expires_at,
               refresh.consumed_request_id,
               refresh.replacement_generation,
               app_user.display_name,
               app_user.roles,
               app_user.status AS user_status,
               app_user.token_limit,
               app_user.allowed_model_ids
          FROM e_mate_auth_refresh_token AS refresh
          JOIN e_mate_auth_session AS session ON session.session_id = refresh.session_id
          JOIN e_mate_tenant_user AS app_user
            ON app_user.tenant_id = session.tenant_id
           AND app_user.user_id = session.user_id
         WHERE refresh.token_hash = $1
         FOR UPDATE OF refresh, session, app_user
      `,
        [tokenHash]
      );
      const row = lookup.rows[0];
      if (!row) {
        await rollback(client);
        return { ok: false, code: 'INVALID_GRANT' };
      }
      if (row.client_id !== clientId) {
        await rollback(client);
        return { ok: false, code: 'CLIENT_FORBIDDEN' };
      }
      const now = this.#now();
      if (
        row.session_status !== 'ACTIVE' ||
        row.user_status !== 'ACTIVE' ||
        row.session_expires_at.getTime() <= now.getTime() ||
        row.token_expires_at.getTime() <= now.getTime()
      ) {
        await this.#revokeSession(client, row.session_id, now);
        await client.query('COMMIT');
        return { ok: false, code: 'SESSION_REVOKED' };
      }
      if (row.token_status === 'REVOKED') {
        await rollback(client);
        return { ok: false, code: 'SESSION_REVOKED' };
      }
      if (row.token_status === 'CONSUMED' && row.consumed_request_id !== requestId) {
        await this.#revokeSession(client, row.session_id, now);
        await client.query('COMMIT');
        return { ok: false, code: 'TOKEN_REUSED' };
      }
      const generation = row.token_status === 'CONSUMED' ? row.replacement_generation : row.token_generation + 1;
      if (!Number.isSafeInteger(generation) || generation === null || generation < 1) {
        throw new Error('Invalid refresh generation');
      }
      const refreshToken = deriveRefreshToken(this.#refreshSecret, row.session_id, generation, requestId);
      if (row.token_status === 'ACTIVE') {
        const updated = await client.query(
          `
          UPDATE e_mate_auth_refresh_token
             SET status = 'CONSUMED',
                 consumed_request_id = $2,
                 replacement_generation = $3,
                 consumed_at = $4
           WHERE token_hash = $1 AND status = 'ACTIVE'
        `,
          [tokenHash, requestId, generation, now]
        );
        if (updated.rowCount !== 1) throw new Error('Refresh token rotation lost its lock');
        await client.query(
          `
          INSERT INTO e_mate_auth_refresh_token (
            token_hash, session_id, generation, status, expires_at, created_at
          ) VALUES ($1, $2, $3, 'ACTIVE', $4, $5)
        `,
          [refreshTokenHash(refreshToken), row.session_id, generation, row.session_expires_at, now]
        );
      } else {
        const replacement = await client.query<{ exists: boolean }>(
          `
          SELECT EXISTS (
            SELECT 1
              FROM e_mate_auth_refresh_token
             WHERE session_id = $1 AND generation = $2 AND status = 'ACTIVE'
          ) AS exists
        `,
          [row.session_id, generation]
        );
        if (replacement.rows[0]?.exists !== true) {
          await this.#revokeSession(client, row.session_id, now);
          await client.query('COMMIT');
          return { ok: false, code: 'SESSION_REVOKED' };
        }
      }
      const modelIds = await this.#enabledModelIds(client, row.tenant_id, row.user_id, input.clientVersion);
      const identity = identityFromRow(
        {
          tenant_id: row.tenant_id,
          user_id: row.user_id,
          display_name: row.display_name,
          roles: row.roles,
          status: row.user_status,
          token_limit: row.token_limit,
        },
        modelIds
      );
      if (!identity) {
        await this.#revokeSession(client, row.session_id, now);
        await client.query('COMMIT');
        return { ok: false, code: 'SESSION_REVOKED' };
      }
      await client.query('COMMIT');
      return { ok: true, identity, sessionId: row.session_id, refreshToken };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async logout(input: LogoutInput): Promise<MutationReceipt> {
    const clientId = identifier(input.clientId, 'client id');
    identifier(input.clientRequestId, 'client request id');
    if (!refreshTokenPattern.test(input.refreshToken)) return { ok: false, code: 'INVALID_GRANT' };
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ session_id: string; client_id: string }>(
        `SELECT session.session_id, session.client_id
           FROM e_mate_auth_refresh_token AS refresh
           JOIN e_mate_auth_session AS session ON session.session_id = refresh.session_id
          WHERE refresh.token_hash = $1
          FOR UPDATE OF refresh, session`,
        [refreshTokenHash(input.refreshToken)]
      );
      const row = result.rows[0];
      if (!row) {
        await rollback(client);
        return { ok: false, code: 'INVALID_GRANT' };
      }
      if (row.client_id !== clientId) {
        await rollback(client);
        return { ok: false, code: 'CLIENT_FORBIDDEN' };
      }
      await this.#revokeSession(client, row.session_id, this.#now());
      await client.query('COMMIT');
      return { ok: true, receiptId: input.clientRequestId };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async changePassword(input: PasswordChangeInput): Promise<MutationReceipt> {
    const clientId = identifier(input.clientId, 'client id');
    identifier(input.clientRequestId, 'client request id');
    if (!refreshTokenPattern.test(input.refreshToken)) return { ok: false, code: 'INVALID_GRANT' };
    const next = await derivePasswordVerifier(input.newPassword);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<CredentialRow & { client_id: string }>(
        `SELECT session.client_id,
                credential.credential_id,
                credential.tenant_id,
                credential.user_id,
                app_user.display_name,
                app_user.roles,
                app_user.status,
                app_user.token_limit,
                app_user.allowed_model_ids,
                credential.password_salt,
                credential.password_hash,
                credential.scrypt_cost,
                credential.scrypt_block_size,
                credential.scrypt_parallelization
           FROM e_mate_auth_refresh_token AS refresh
           JOIN e_mate_auth_session AS session ON session.session_id = refresh.session_id
           JOIN e_mate_auth_password_credential AS credential
             ON credential.tenant_id = session.tenant_id AND credential.user_id = session.user_id
           JOIN e_mate_tenant_user AS app_user
             ON app_user.tenant_id = session.tenant_id AND app_user.user_id = session.user_id
          WHERE refresh.token_hash = $1
            AND refresh.status = 'ACTIVE'
            AND session.status = 'ACTIVE'
          FOR UPDATE OF refresh, session, credential, app_user`,
        [refreshTokenHash(input.refreshToken)]
      );
      const row = result.rows[0];
      if (!row || !(await verifyPassword(input.currentPassword, row ? verifier(row) : undefined))) {
        await rollback(client);
        return { ok: false, code: 'INVALID_GRANT' };
      }
      if (row.client_id !== clientId) {
        await rollback(client);
        return { ok: false, code: 'CLIENT_FORBIDDEN' };
      }
      await client.query(
        `UPDATE e_mate_auth_password_credential
            SET password_salt = $2,
                password_hash = $3,
                scrypt_cost = $4,
                scrypt_block_size = $5,
                scrypt_parallelization = $6,
                updated_at = $7
          WHERE credential_id = $1`,
        [row.credential_id, next.salt, next.hash, next.cost, next.blockSize, next.parallelization, this.#now()]
      );
      const sessions = await client.query<{ session_id: string }>(
        `SELECT session_id FROM e_mate_auth_session
          WHERE tenant_id = $1 AND user_id = $2 AND status = 'ACTIVE'
          FOR UPDATE`,
        [row.tenant_id, row.user_id]
      );
      for (const session of sessions.rows) await this.#revokeSession(client, session.session_id, this.#now());
      await client.query('COMMIT');
      return { ok: true, receiptId: input.clientRequestId };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
