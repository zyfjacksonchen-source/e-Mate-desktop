import { createHash, pbkdf2, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export type ScryptVerifier = {
  salt: Buffer;
  hash: Buffer;
  cost: number;
  blockSize: number;
  parallelization: number;
};

const scryptMaximumMemory = 96 * 1024 * 1024;
const dummySalt = createHash('sha256').update('e-mate-auth-gateway-dummy-password-v1', 'utf8').digest();

export const AUTH_CREDENTIAL_SCHEMA_SQL = `
  SELECT pg_advisory_xact_lock(hashtext('e-mate-auth-credential-schema'));
  CREATE TABLE IF NOT EXISTS e_mate_auth_password_credential (
    credential_id uuid PRIMARY KEY,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    login_identifier_normalized text NOT NULL,
    password_salt bytea NOT NULL CHECK (octet_length(password_salt) = 32),
    password_hash bytea NOT NULL CHECK (octet_length(password_hash) = 64),
    scrypt_cost integer NOT NULL CHECK (scrypt_cost = 65536),
    scrypt_block_size integer NOT NULL CHECK (scrypt_block_size = 8),
    scrypt_parallelization integer NOT NULL CHECK (scrypt_parallelization = 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, login_identifier_normalized),
    FOREIGN KEY (tenant_id, user_id)
      REFERENCES e_mate_tenant_user (tenant_id, user_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS e_mate_auth_password_user
    ON e_mate_auth_password_credential (tenant_id, user_id);
  CREATE TABLE IF NOT EXISTS e_mate_auth_legacy_password_credential (
    credential_id uuid PRIMARY KEY,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    login_identifier_normalized text NOT NULL,
    algorithm text NOT NULL CHECK (algorithm = 'pbkdf2_sha256'),
    encoded_hash text NOT NULL CHECK (
      encoded_hash ~ '^pbkdf2_sha256\\$180000\\$[A-Za-z0-9+/]{22}==\\$[A-Za-z0-9+/]{43}=$'
    ),
    source_version text NOT NULL CHECK (source_version IN ('0.2.9.2', 'admin')),
    source_record_sha256 bytea NOT NULL CHECK (octet_length(source_record_sha256) = 32),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, login_identifier_normalized),
    UNIQUE (tenant_id, user_id),
    FOREIGN KEY (tenant_id, user_id)
      REFERENCES e_mate_tenant_user (tenant_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS e_mate_auth_login_identity (
    tenant_id text NOT NULL,
    login_identifier_normalized text NOT NULL,
    user_id text NOT NULL,
    PRIMARY KEY (tenant_id, login_identifier_normalized),
    UNIQUE (tenant_id, login_identifier_normalized, user_id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES e_mate_tenant_user (tenant_id, user_id) ON DELETE CASCADE
  );
  -- Fail before backfill on ambiguous historical ownership. Never choose or merge a user.
  DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM (
        SELECT tenant_id, login_identifier_normalized, user_id FROM e_mate_auth_password_credential
        UNION SELECT tenant_id, login_identifier_normalized, user_id FROM e_mate_auth_legacy_password_credential
        UNION SELECT tenant_id, login_identifier_normalized, user_id FROM e_mate_auth_login_identity
      ) AS owners GROUP BY tenant_id, login_identifier_normalized HAVING count(DISTINCT user_id) > 1
    ) THEN RAISE EXCEPTION 'Conflicting login identity owners; run redacted preflight'; END IF;
  END $$;
  INSERT INTO e_mate_auth_login_identity (tenant_id, login_identifier_normalized, user_id)
    SELECT tenant_id, login_identifier_normalized, user_id FROM e_mate_auth_password_credential
    UNION SELECT tenant_id, login_identifier_normalized, user_id FROM e_mate_auth_legacy_password_credential
    ON CONFLICT DO NOTHING;
  CREATE OR REPLACE FUNCTION e_mate_claim_login_identity() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    INSERT INTO e_mate_auth_login_identity (tenant_id, login_identifier_normalized, user_id)
      VALUES (NEW.tenant_id, NEW.login_identifier_normalized, NEW.user_id) ON CONFLICT DO NOTHING;
    IF NOT EXISTS (
      SELECT 1 FROM e_mate_auth_login_identity WHERE tenant_id = NEW.tenant_id
        AND login_identifier_normalized = NEW.login_identifier_normalized AND user_id = NEW.user_id
    ) THEN
      RAISE EXCEPTION 'Login identity already belongs to another user'
        USING ERRCODE = '23505', CONSTRAINT = 'e_mate_auth_login_identity_owner';
    END IF;
    RETURN NEW;
  END $$;
  DO $$ DECLARE credential_table text; BEGIN
    FOREACH credential_table IN ARRAY ARRAY['e_mate_auth_password_credential', 'e_mate_auth_legacy_password_credential'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = credential_table::regclass AND tgname = 'claim_login_identity') THEN
        EXECUTE format('CREATE TRIGGER claim_login_identity BEFORE INSERT OR UPDATE OF tenant_id, user_id, login_identifier_normalized ON %I FOR EACH ROW EXECUTE FUNCTION e_mate_claim_login_identity()', credential_table);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = credential_table::regclass AND conname = 'login_identity_owner') THEN
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT login_identity_owner FOREIGN KEY (tenant_id, login_identifier_normalized, user_id) REFERENCES e_mate_auth_login_identity (tenant_id, login_identifier_normalized, user_id)', credential_table);
      END IF;
    END LOOP;
  END $$;
  CREATE TABLE IF NOT EXISTS e_mate_auth_credential_migration (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    source_version text NOT NULL CHECK (source_version IN ('0.2.9.2', 'admin')),
    source_record_sha256 bytea NOT NULL CHECK (octet_length(source_record_sha256) = 32),
    imported_at timestamptz NOT NULL DEFAULT now(),
    upgraded_at timestamptz,
    PRIMARY KEY (tenant_id, user_id, source_version),
    FOREIGN KEY (tenant_id, user_id)
      REFERENCES e_mate_tenant_user (tenant_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS e_mate_auth_session (
    session_id uuid PRIMARY KEY,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    client_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    FOREIGN KEY (tenant_id, user_id)
      REFERENCES e_mate_tenant_user (tenant_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS e_mate_auth_refresh_token (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    session_id uuid NOT NULL REFERENCES e_mate_auth_session (session_id),
    generation integer NOT NULL CHECK (generation >= 0),
    status text NOT NULL CHECK (status IN ('ACTIVE', 'CONSUMED', 'REVOKED')),
    expires_at timestamptz NOT NULL,
    consumed_request_id text,
    replacement_generation integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    consumed_at timestamptz,
    UNIQUE (session_id, generation),
    CHECK (
      (status = 'CONSUMED' AND consumed_request_id IS NOT NULL AND replacement_generation IS NOT NULL)
      OR (status <> 'CONSUMED' AND consumed_request_id IS NULL AND replacement_generation IS NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS e_mate_auth_refresh_session
    ON e_mate_auth_refresh_token (session_id, generation);
`;

/** Read-only aggregate preflight; never returns account identifiers or credential material. */
export const AUTH_LOGIN_IDENTITY_PREFLIGHT_SQL = `
  WITH owners AS (
    SELECT tenant_id, login_identifier_normalized, user_id FROM e_mate_auth_password_credential
    UNION SELECT tenant_id, login_identifier_normalized, user_id FROM e_mate_auth_legacy_password_credential
  ) SELECT count(*)::text AS conflicting_accounts FROM (
    SELECT 1 FROM owners GROUP BY tenant_id, login_identifier_normalized HAVING count(DISTINCT user_id) > 1
  ) AS conflicts`;

export function isLoginIdentityConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { code?: unknown; constraint?: unknown };
  return value.code === '23505' && value.constraint === 'e_mate_auth_login_identity_owner';
}

export const AUTH_CREDENTIAL_SOURCE_VERSION_MIGRATION_SQL = `
  SELECT pg_advisory_xact_lock(hashtext('e-mate-auth-source-version-migration'));
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'e_mate_auth_legacy_password_credential_source_version_check'
         AND conrelid = 'e_mate_auth_legacy_password_credential'::regclass
         AND pg_get_constraintdef(oid) LIKE '%admin%'
    ) THEN
      ALTER TABLE e_mate_auth_legacy_password_credential
        DROP CONSTRAINT IF EXISTS e_mate_auth_legacy_password_credential_source_version_check;
      ALTER TABLE e_mate_auth_legacy_password_credential
        ADD CONSTRAINT e_mate_auth_legacy_password_credential_source_version_check
        CHECK (source_version IN ('0.2.9.2', 'admin'));
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'e_mate_auth_credential_migration_source_version_check'
         AND conrelid = 'e_mate_auth_credential_migration'::regclass
         AND pg_get_constraintdef(oid) LIKE '%admin%'
    ) THEN
      ALTER TABLE e_mate_auth_credential_migration
        DROP CONSTRAINT IF EXISTS e_mate_auth_credential_migration_source_version_check;
      ALTER TABLE e_mate_auth_credential_migration
        ADD CONSTRAINT e_mate_auth_credential_migration_source_version_check
        CHECK (source_version IN ('0.2.9.2', 'admin'));
    END IF;
  END $$;
`;

function scryptKey(
  password: string,
  verifier: Pick<ScryptVerifier, 'salt' | 'cost' | 'blockSize' | 'parallelization'>
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      verifier.salt,
      64,
      {
        N: verifier.cost,
        r: verifier.blockSize,
        p: verifier.parallelization,
        maxmem: scryptMaximumMemory,
      },
      (error, derived) => (error ? reject(error) : resolve(derived))
    );
  });
}

function validScryptVerifier(value: ScryptVerifier): boolean {
  return (
    value.salt.byteLength === 32 &&
    value.hash.byteLength === 64 &&
    value.cost === 65_536 &&
    value.blockSize === 8 &&
    value.parallelization === 1
  );
}

const ecorexV0292PasswordPattern = /^pbkdf2_sha256\$180000\$([A-Za-z0-9+/]{22}==)\$([A-Za-z0-9+/]{43}=)$/;
const legacyDummySalt = createHash('sha256')
  .update('e-mate-auth-gateway-legacy-dummy-v1', 'utf8')
  .digest()
  .subarray(0, 16);

function pbkdf2Key(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    pbkdf2(password, salt, 180_000, 32, 'sha256', (error, derived) => (error ? reject(error) : resolve(derived)));
  });
}

function ecorexV0292Verifier(encodedHash?: string): { salt: Buffer; hash: Buffer } | undefined {
  const match = encodedHash?.match(ecorexV0292PasswordPattern);
  if (!match?.[1] || !match[2]) return undefined;
  const salt = Buffer.from(match[1], 'base64');
  const hash = Buffer.from(match[2], 'base64');
  return salt.byteLength === 16 && hash.byteLength === 32 ? { salt, hash } : undefined;
}

export function normalizeLoginIdentifier(value: string): string {
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  if (!normalized || normalized.length > 320 || /\p{Cc}/u.test(normalized)) {
    throw new Error('Invalid login identifier');
  }
  return normalized;
}

export async function derivePasswordVerifier(password: string, salt = randomBytes(32)): Promise<ScryptVerifier> {
  if (!password || password.length > 1_024 || salt.byteLength !== 32) {
    throw new Error('Invalid password verifier input');
  }
  const parameters = { salt: Buffer.from(salt), cost: 65_536, blockSize: 8, parallelization: 1 };
  return { ...parameters, hash: await scryptKey(password, parameters) };
}

export async function verifyPassword(password: string, verifier?: ScryptVerifier): Promise<boolean> {
  if (!password || password.length > 1_024) return false;
  const hasValidVerifier = verifier !== undefined && validScryptVerifier(verifier);
  const selected = hasValidVerifier
    ? verifier
    : { salt: dummySalt, hash: Buffer.alloc(64), cost: 65_536, blockSize: 8, parallelization: 1 };
  const actual = await scryptKey(password, selected);
  return hasValidVerifier && timingSafeEqual(actual, selected.hash);
}

export async function verifyEcorexV0292Password(password: string, encodedHash?: string): Promise<boolean> {
  if (!password || password.length > 1_024) return false;
  const verifier = ecorexV0292Verifier(encodedHash);
  const selected = verifier ?? { salt: legacyDummySalt, hash: Buffer.alloc(32) };
  const actual = await pbkdf2Key(password, selected.salt);
  return verifier !== undefined && timingSafeEqual(actual, selected.hash);
}
