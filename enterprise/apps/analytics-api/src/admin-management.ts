import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  parseAdminApiKeyCreate,
  parseAdminApiKeyCreationResult,
  parseAdminApiKeyList,
  parseAdminPasswordReset,
  parseAdminModelRouteKeyUpdate,
  parseAdminModelRouteList,
  parseAdminModelRoutePublication,
  parseAdminModelRouteUpdate,
  parseTenantUser,
  parseTenantUserCreate,
  parseTenantUserDelete,
  parseTenantUserList,
  parseTenantUserUpdate,
  canonicalModelRouteId,
  IMAGE_ROUTE_ID,
  LEGACY_IMAGE_ROUTE_ID,
  isDefaultEnabledModelRoute,
  isRetiredModelRoute,
  type AdminApiKeyCreate,
  type AdminApiKeyCreationResult,
  type AdminApiKeyList,
  type AdminApiKeyMetadata,
  type AdminApiKeyScope,
  type AdminModelRoute,
  type AdminModelRouteKeyUpdate,
  type AdminModelRouteList,
  type AdminModelRoutePublication,
  type AdminModelRouteUpdate,
  type AdminPasswordReset,
  type TenantUser,
  type TenantUserCreate,
  type TenantUserDelete,
  type TenantUserList,
  type TenantUserUpdate,
} from '@e-mate/admin-contract';
import { AUTH_CREDENTIAL_SCHEMA_SQL, derivePasswordVerifier, normalizeLoginIdentifier, isLoginIdentityConflict } from '@e-mate/auth-credential';
import type { RuntimeRegistryPrincipal } from './runtime-registry.ts';

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type AdminModelRouteDefinition = {
  routeId: string;
  label: string;
  provider: string;
};

export type AdminManagementStore = {
  listUsers(principal: RuntimeRegistryPrincipal): Promise<TenantUserList>;
  createUser(principal: RuntimeRegistryPrincipal, input: TenantUserCreate): Promise<TenantUser>;
  updateUser(principal: RuntimeRegistryPrincipal, userId: string, input: TenantUserUpdate): Promise<TenantUser | null>;
  deleteUser(principal: RuntimeRegistryPrincipal, userId: string, input: TenantUserDelete): Promise<boolean>;
  resetPassword(principal: RuntimeRegistryPrincipal, userId: string, input: AdminPasswordReset): Promise<boolean>;
  listApiKeys(principal: RuntimeRegistryPrincipal): Promise<AdminApiKeyList>;
  issueApiKey(principal: RuntimeRegistryPrincipal, input: AdminApiKeyCreate): Promise<AdminApiKeyCreationResult>;
  revokeApiKey(principal: RuntimeRegistryPrincipal, keyId: string): Promise<boolean>;
  listModelRoutes(principal: RuntimeRegistryPrincipal): Promise<AdminModelRouteList>;
  updateModelRoute(
    principal: RuntimeRegistryPrincipal,
    routeId: string,
    input: AdminModelRouteUpdate
  ): Promise<AdminModelRoute | null>;
  publishModelRoute(
    principal: RuntimeRegistryPrincipal,
    routeId: string,
    input: AdminModelRoutePublication
  ): Promise<AdminModelRoute | null>;
  updateModelRouteKey(
    principal: RuntimeRegistryPrincipal,
    routeId: string,
    input: AdminModelRouteKeyUpdate
  ): Promise<AdminModelRoute | null>;
};

export class AdminManagementError extends Error {
  readonly code: 'CONFLICT' | 'STALE_UPDATE' | 'USER_UNAVAILABLE';

  constructor(code: AdminManagementError['code']) {
    super(
      code === 'CONFLICT'
        ? 'Resource already exists'
        : code === 'STALE_UPDATE'
          ? 'User changed since it was loaded'
          : 'Bound user is not active'
    );
    this.code = code;
  }
}

type StoredKey = AdminApiKeyMetadata & {
  tenantId: string;
  tokenHash: string;
};

type ModelRoutePolicy = {
  published?: boolean;
  enabled: boolean;
  updatedAt: string;
  apiKey?: string;
  keyUpdatedAt?: string;
};

function sameModelSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function validateUserModelGrants(
  available: readonly string[], allowed: readonly string[], previous: readonly string[], activating: boolean
): void {
  if (allowed.some((id) => !previous.includes(id) && !available.includes(id)) ||
      (activating && (allowed.length === 0 || allowed.some((id) => !available.includes(id))))) {
    throw new Error('Invalid allowed model policy');
  }
}

type EncryptedRouteKey = {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
};

function identifier(value: string, label: string): string {
  if (!identifierPattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function keyHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('base64url');
}

function issueSecret(): string {
  return `emate_twe_${randomBytes(32).toString('base64url')}`;
}

function encryptRouteKey(encryptionKey: Buffer, tenantId: string, routeId: string, apiKey: string): EncryptedRouteKey {
  if (encryptionKey.byteLength !== 32) throw new Error('Invalid model route key encryption key');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  cipher.setAAD(Buffer.from(`${tenantId}\0${routeId}`, 'utf8'));
  return {
    ciphertext: Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]),
    nonce,
    tag: cipher.getAuthTag(),
  };
}

function normalizeCatalog(catalog: AdminModelRouteDefinition[]): AdminModelRouteDefinition[] {
  const seen = new Set<string>();
  return catalog.map((route) => {
    const normalized = {
      routeId: identifier(route.routeId, 'route id'),
      label: route.label.trim(),
      provider: route.provider.trim(),
    };
    if (
      seen.has(normalized.routeId) ||
      normalized.label.length < 1 ||
      normalized.label.length > 120 ||
      normalized.provider.length < 1 ||
      normalized.provider.length > 120
    ) {
      throw new Error('Invalid model route catalog');
    }
    seen.add(normalized.routeId);
    return normalized;
  });
}

function publicKey(key: StoredKey): AdminApiKeyMetadata {
  const { tenantId: _tenantId, tokenHash: _tokenHash, ...metadata } = key;
  return metadata;
}

export class InMemoryAdminManagementStore implements AdminManagementStore {
  readonly #catalog: AdminModelRouteDefinition[];
  readonly #users = new Map<string, Map<string, TenantUser>>();
  readonly #keys = new Map<string, StoredKey>();
  readonly #routes = new Map<string, Map<string, ModelRoutePolicy>>();
  readonly #now: () => number;

  constructor(catalog: AdminModelRouteDefinition[], now: () => number = Date.now) {
    this.#catalog = normalizeCatalog(catalog).filter(route => !isRetiredModelRoute(route.routeId));
    this.#now = now;
  }

  #tenantUsers(tenantId: string): Map<string, TenantUser> {
    let users = this.#users.get(tenantId);
    if (!users) {
      users = new Map();
      this.#users.set(tenantId, users);
    }
    return users;
  }

  async listUsers(principal: RuntimeRegistryPrincipal): Promise<TenantUserList> {
    const users = [...this.#tenantUsers(identifier(principal.tenantId, 'tenant id')).values()];
    return parseTenantUserList({ schemaVersion: 1, users });
  }

  async createUser(principal: RuntimeRegistryPrincipal, value: TenantUserCreate): Promise<TenantUser> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const input = parseTenantUserCreate(value);
    const users = this.#tenantUsers(tenantId);
    if (users.has(input.userId)) throw new AdminManagementError('CONFLICT');
    validateUserModelGrants(this.#availableModelIds(tenantId), input.allowedModelIds, [], true);
    const timestamp = new Date(this.#now()).toISOString();
    const { initialPassword: _initialPassword, ...publicInput } = input;
    const user = parseTenantUser({
      ...publicInput,
      status: 'ACTIVE',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    users.set(user.userId, user);
    return user;
  }

  async resetPassword(
    principal: RuntimeRegistryPrincipal,
    userIdInput: string,
    value: AdminPasswordReset
  ): Promise<boolean> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const userId = identifier(userIdInput, 'user id');
    parseAdminPasswordReset(value);
    const user = this.#tenantUsers(tenantId).get(userId);
    return Boolean(user && user.status !== 'DELETED');
  }

  async updateUser(
    principal: RuntimeRegistryPrincipal,
    userIdInput: string,
    value: TenantUserUpdate
  ): Promise<TenantUser | null> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const userId = identifier(userIdInput, 'user id');
    const input = parseTenantUserUpdate(value);
    const users = this.#tenantUsers(tenantId);
    const current = users.get(userId);
    if (!current || current.status === 'DELETED') return null;
    if (current.updatedAt !== input.expectedUpdatedAt) {
      throw new AdminManagementError('STALE_UPDATE');
    }
    validateUserModelGrants(this.#availableModelIds(tenantId), input.allowedModelIds, current.allowedModelIds,
      input.status === 'ACTIVE' && current.status !== 'ACTIVE');
    const { expectedUpdatedAt: _expectedUpdatedAt, ...update } = input;
    const user = parseTenantUser({
      ...current,
      ...update,
      updatedAt: new Date(Math.max(this.#now(), Date.parse(current.updatedAt) + 1)).toISOString(),
    });
    users.set(userId, user);
    return user;
  }

  #availableModelIds(tenantId: string): string[] {
    return this.#catalog.filter((route) => {
      const policy = this.#routes.get(tenantId)?.get(route.routeId);
      return (policy?.published ?? true) && (policy?.enabled ?? isDefaultEnabledModelRoute(route.routeId));
    }).map((route) => route.routeId);
  }

  async deleteUser(
    principal: RuntimeRegistryPrincipal,
    userIdInput: string,
    value: TenantUserDelete
  ): Promise<boolean> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const userId = identifier(userIdInput, 'user id');
    const input = parseTenantUserDelete(value);
    const users = this.#tenantUsers(tenantId);
    const current = users.get(userId);
    if (!current) return false;
    if (current.status === 'DELETED') return true;
    if (current.updatedAt !== input.expectedUpdatedAt) {
      throw new AdminManagementError('STALE_UPDATE');
    }
    const deletedAt = new Date(Math.max(this.#now(), Date.parse(current.updatedAt) + 1)).toISOString();
    users.set(userId, parseTenantUser({ ...current, status: 'DELETED', updatedAt: deletedAt }));
    for (const key of this.#keys.values()) {
      if (key.tenantId === tenantId && key.userId === userId && !key.revokedAt) {
        key.revokedAt = deletedAt;
      }
    }
    return true;
  }

  async listApiKeys(principal: RuntimeRegistryPrincipal): Promise<AdminApiKeyList> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const keys = [...this.#keys.values()].filter((key) => key.tenantId === tenantId).map(publicKey);
    return parseAdminApiKeyList({ schemaVersion: 1, keys });
  }

  async issueApiKey(principal: RuntimeRegistryPrincipal, value: AdminApiKeyCreate): Promise<AdminApiKeyCreationResult> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const input = parseAdminApiKeyCreate(value);
    const user = this.#tenantUsers(tenantId).get(input.userId);
    if (!user || user.status !== 'ACTIVE') throw new AdminManagementError('USER_UNAVAILABLE');
    const createdAt = new Date(this.#now()).toISOString();
    const secret = issueSecret();
    const key: StoredKey = {
      keyId: randomUUID(),
      ...input,
      createdAt,
      lastUsedAt: null,
      revokedAt: null,
      tenantId,
      tokenHash: keyHash(secret),
    };
    this.#keys.set(key.keyId, key);
    return parseAdminApiKeyCreationResult({ schemaVersion: 1, key: publicKey(key), secret });
  }

  async revokeApiKey(principal: RuntimeRegistryPrincipal, keyIdInput: string): Promise<boolean> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const keyId = identifier(keyIdInput, 'key id');
    const key = this.#keys.get(keyId);
    if (!key || key.tenantId !== tenantId) return false;
    if (!key.revokedAt) key.revokedAt = new Date(this.#now()).toISOString();
    return true;
  }

  async listModelRoutes(principal: RuntimeRegistryPrincipal): Promise<AdminModelRouteList> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const policies = this.#routes.get(tenantId);
    return parseAdminModelRouteList({
      schemaVersion: 1,
      routes: this.#catalog.map((route) => {
        const policy = policies?.get(route.routeId);
        return {
          schemaVersion: 1,
          routeId: route.routeId,
          label: route.label,
          provider: route.provider,
          published: policy?.published ?? true,
          enabled: policy?.enabled ?? isDefaultEnabledModelRoute(route.routeId),
          updatedAt: policy?.updatedAt ?? null,
          keyConfigured: policy?.apiKey !== undefined,
          keyUpdatedAt: policy?.keyUpdatedAt ?? null,
        };
      }),
    });
  }

  async updateModelRoute(
    principal: RuntimeRegistryPrincipal,
    routeIdInput: string,
    value: AdminModelRouteUpdate
  ): Promise<AdminModelRoute | null> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const routeId = identifier(routeIdInput, 'route id');
    const definition = this.#catalog.find((route) => route.routeId === routeId);
    if (!definition) return null;
    const input = parseAdminModelRouteUpdate(value);
    const updatedAt = new Date(this.#now()).toISOString();
    let policies = this.#routes.get(tenantId);
    if (!policies) {
      policies = new Map();
      this.#routes.set(tenantId, policies);
    }
    policies.set(routeId, { ...policies.get(routeId), enabled: input.enabled, updatedAt });
    return {
      schemaVersion: 1,
      routeId,
      label: definition.label,
      provider: definition.provider,
      published: policies.get(routeId)?.published ?? true,
      enabled: input.enabled,
      updatedAt,
      keyConfigured: policies.get(routeId)?.apiKey !== undefined,
      keyUpdatedAt: policies.get(routeId)?.keyUpdatedAt ?? null,
    };
  }

  async publishModelRoute(
    principal: RuntimeRegistryPrincipal,
    routeIdInput: string,
    value: AdminModelRoutePublication
  ): Promise<AdminModelRoute | null> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const routeId = identifier(routeIdInput, 'route id');
    const definition = this.#catalog.find((route) => route.routeId === routeId);
    if (!definition) return null;
    const input = parseAdminModelRoutePublication(value);
    const updatedAt = new Date(this.#now()).toISOString();
    let policies = this.#routes.get(tenantId);
    if (!policies) {
      policies = new Map();
      this.#routes.set(tenantId, policies);
    }
    const current = policies.get(routeId);
    policies.set(routeId, {
      ...current,
      published: input.published,
      enabled: input.published ? (current?.enabled ?? isDefaultEnabledModelRoute(routeId)) : false,
      updatedAt,
    });
    const policy = policies.get(routeId) as ModelRoutePolicy;
    return {
      schemaVersion: 1,
      routeId,
      label: definition.label,
      provider: definition.provider,
      published: input.published,
      enabled: policy.enabled,
      updatedAt,
      keyConfigured: policy.apiKey !== undefined,
      keyUpdatedAt: policy.keyUpdatedAt ?? null,
    };
  }

  async updateModelRouteKey(
    principal: RuntimeRegistryPrincipal,
    routeIdInput: string,
    value: AdminModelRouteKeyUpdate
  ): Promise<AdminModelRoute | null> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const routeId = identifier(routeIdInput, 'route id');
    const definition = this.#catalog.find((route) => route.routeId === routeId);
    if (!definition) return null;
    const input = parseAdminModelRouteKeyUpdate(value);
    const keyUpdatedAt = new Date(this.#now()).toISOString();
    let policies = this.#routes.get(tenantId);
    if (!policies) {
      policies = new Map();
      this.#routes.set(tenantId, policies);
    }
    const current = policies.get(routeId);
    const updatedAt = current?.updatedAt ?? keyUpdatedAt;
    policies.set(routeId, {
      published: current?.published ?? true,
      enabled: current?.enabled ?? isDefaultEnabledModelRoute(routeId),
      updatedAt,
      apiKey: input.apiKey,
      keyUpdatedAt,
    });
    return {
      schemaVersion: 1,
      routeId,
      label: definition.label,
      provider: definition.provider,
      published: policies.get(routeId)?.published ?? true,
      enabled: policies.get(routeId)?.enabled ?? isDefaultEnabledModelRoute(routeId),
      updatedAt,
      keyConfigured: true,
      keyUpdatedAt,
    };
  }
}

type UserRow = {
  user_id: string;
  display_name: string;
  roles: string[];
  status: 'PENDING_APPROVAL' | 'ACTIVE' | 'SUSPENDED' | 'DELETED';
  token_limit: string | null;
  allowed_model_ids: string[];
  created_at: Date;
  updated_at: Date;
};

type KeyRow = {
  key_id: string;
  label: string;
  principal_type: 'USER' | 'DEVICE';
  principal_id: string;
  user_id: string;
  scopes: string[];
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

type ModelRouteRow = {
  route_id: string;
  published: boolean;
  enabled: boolean;
  updated_at: Date;
  key_configured: boolean;
  key_updated_at: Date | null;
};

function userFromRow(row: UserRow): TenantUser {
  return parseTenantUser({
    schemaVersion: 1,
    userId: row.user_id,
    displayName: row.display_name,
    roles: row.roles,
    status: row.status,
    tokenLimit: row.token_limit === null ? null : Number(row.token_limit),
    allowedModelIds: [...new Set(row.allowed_model_ids.map(canonicalModelRouteId))],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function keyFromRow(row: KeyRow): AdminApiKeyMetadata {
  return {
    schemaVersion: 1,
    keyId: row.key_id,
    label: row.label,
    principalType: row.principal_type,
    principalId: row.principal_id,
    userId: row.user_id,
    scopes: row.scopes as AdminApiKeyScope[],
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

export class PostgresAdminManagementStore implements AdminManagementStore {
  readonly #pool: Pool;
  readonly #catalog: AdminModelRouteDefinition[];
  readonly #routeKeyEncryptionKey: Buffer | undefined;

  constructor(pool: Pool, catalog: AdminModelRouteDefinition[], routeKeyEncryptionKey?: Buffer) {
    this.#pool = pool;
    this.#catalog = normalizeCatalog(catalog).filter(route => !isRetiredModelRoute(route.routeId));
    this.#routeKeyEncryptionKey = routeKeyEncryptionKey ? Buffer.from(routeKeyEncryptionKey) : undefined;
    if (this.#routeKeyEncryptionKey && this.#routeKeyEncryptionKey.byteLength !== 32) {
      throw new Error('Invalid model route key encryption key');
    }
  }

  async initialize(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS e_mate_tenant_user (
        tenant_id text NOT NULL,
        user_id text NOT NULL,
        display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
        roles text[] NOT NULL,
        status text NOT NULL CHECK (status IN ('PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED', 'DELETED')),
        token_limit bigint CHECK (token_limit BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}),
        allowed_model_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, user_id),
        CHECK (roles <@ ARRAY['TENANT_ADMIN', 'AUDIT_ADMIN', 'MEMBER']::text[]),
        CHECK (cardinality(roles) BETWEEN 1 AND 3)
      );
      ALTER TABLE e_mate_tenant_user
        ADD COLUMN IF NOT EXISTS token_limit bigint;
      ALTER TABLE e_mate_tenant_user
        ADD COLUMN IF NOT EXISTS allowed_model_ids text[] NOT NULL DEFAULT ARRAY[]::text[];
      ALTER TABLE e_mate_tenant_user
        DROP CONSTRAINT IF EXISTS e_mate_tenant_user_status_check;
      ALTER TABLE e_mate_tenant_user
        ADD CONSTRAINT e_mate_tenant_user_status_check
        CHECK (status IN ('PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED', 'DELETED'));
      ALTER TABLE e_mate_tenant_user
        DROP CONSTRAINT IF EXISTS e_mate_tenant_user_token_limit_check;
      ALTER TABLE e_mate_tenant_user
        ADD CONSTRAINT e_mate_tenant_user_token_limit_check
        CHECK (token_limit BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER});
      ALTER TABLE e_mate_tenant_user
        DROP CONSTRAINT IF EXISTS e_mate_tenant_user_allowed_model_ids_check;
      ALTER TABLE e_mate_tenant_user
        ADD CONSTRAINT e_mate_tenant_user_allowed_model_ids_check
        CHECK (
          cardinality(allowed_model_ids) BETWEEN 0 AND 20
          AND array_position(allowed_model_ids, NULL) IS NULL
        );
      CREATE TABLE IF NOT EXISTS e_mate_admin_api_key (
        tenant_id text NOT NULL,
        key_id text NOT NULL,
        label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
        principal_type text NOT NULL CHECK (principal_type IN ('USER', 'DEVICE')),
        principal_id text NOT NULL,
        user_id text NOT NULL,
        scopes text[] NOT NULL,
        token_hash text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz,
        revoked_at timestamptz,
        created_by text NOT NULL,
        PRIMARY KEY (tenant_id, key_id),
        FOREIGN KEY (tenant_id, user_id)
          REFERENCES e_mate_tenant_user (tenant_id, user_id)
      );
      UPDATE e_mate_admin_api_key
         SET revoked_at = COALESCE(revoked_at, now())
       WHERE 'task-events:write' = ANY(scopes);
      ALTER TABLE e_mate_admin_api_key
        DROP CONSTRAINT IF EXISTS e_mate_admin_api_key_scopes_check;
      ALTER TABLE e_mate_admin_api_key
        ADD CONSTRAINT e_mate_admin_api_key_scopes_check CHECK (
          (
            scopes = ARRAY['models:invoke']::text[]
            AND principal_type = 'USER'
          )
          OR (
            revoked_at IS NOT NULL
            AND (
              scopes = ARRAY['task-events:write']::text[]
              OR (
                scopes = ARRAY['task-events:write', 'models:invoke']::text[]
                AND principal_type = 'USER'
              )
            )
          )
        );
      CREATE TABLE IF NOT EXISTS e_mate_tenant_model_route (
        tenant_id text NOT NULL,
        route_id text NOT NULL,
        published boolean NOT NULL DEFAULT true,
        enabled boolean NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text NOT NULL,
        upstream_key_ciphertext bytea,
        upstream_key_nonce bytea,
        upstream_key_tag bytea,
        key_updated_at timestamptz,
        key_updated_by text,
        PRIMARY KEY (tenant_id, route_id)
      );
      ALTER TABLE e_mate_tenant_model_route
        ADD COLUMN IF NOT EXISTS published boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS upstream_key_ciphertext bytea,
        ADD COLUMN IF NOT EXISTS upstream_key_nonce bytea,
        ADD COLUMN IF NOT EXISTS upstream_key_tag bytea,
        ADD COLUMN IF NOT EXISTS key_updated_at timestamptz,
        ADD COLUMN IF NOT EXISTS key_updated_by text;
      CREATE TABLE IF NOT EXISTS e_mate_admin_audit (
        tenant_id text NOT NULL,
        audit_id uuid NOT NULL,
        actor_id text NOT NULL,
        action text NOT NULL,
        target_type text NOT NULL,
        target_id text NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (tenant_id, audit_id)
      );
      CREATE INDEX IF NOT EXISTS e_mate_admin_api_key_lookup
        ON e_mate_admin_api_key (token_hash)
        WHERE revoked_at IS NULL;
      CREATE INDEX IF NOT EXISTS e_mate_admin_audit_time
        ON e_mate_admin_audit (tenant_id, occurred_at DESC);
    `);
    await this.#pool.query(AUTH_CREDENTIAL_SCHEMA_SQL);
  }

  async #audit(
    client: PoolClient,
    principal: RuntimeRegistryPrincipal,
    action: string,
    targetType: string,
    targetId: string,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    await client.query(
      `
      INSERT INTO e_mate_admin_audit (
        tenant_id, audit_id, actor_id, action, target_type, target_id, details
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
    `,
      [principal.tenantId, randomUUID(), principal.userId, action, targetType, targetId, JSON.stringify(details)]
    );
  }

  async #validateUserModels(client: PoolClient, tenantId: string, allowed: string[], previous: string[], activating: boolean): Promise<void> {
    const result = await client.query<{ route_id: string; published: boolean; enabled: boolean }>(
      'SELECT route_id, published, enabled FROM e_mate_tenant_model_route WHERE tenant_id = $1', [tenantId]
    );
    const policies = new Map(result.rows.map((row) => [row.route_id, row]));
    const available = this.#catalog.filter((route) => {
      const policy = policies.get(route.routeId) ?? (route.routeId === IMAGE_ROUTE_ID ? policies.get(LEGACY_IMAGE_ROUTE_ID) : undefined);
      return (policy?.published ?? true) && (policy?.enabled ?? isDefaultEnabledModelRoute(route.routeId));
    }).map((route) => route.routeId);
    validateUserModelGrants(available, allowed, previous.map(canonicalModelRouteId), activating);
  }

  async listUsers(principal: RuntimeRegistryPrincipal): Promise<TenantUserList> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const result = await this.#pool.query<UserRow>(
      `
      SELECT user_id, display_name, roles, status, token_limit, allowed_model_ids, created_at, updated_at
        FROM e_mate_tenant_user
       WHERE tenant_id = $1
       ORDER BY user_id
    `,
      [tenantId]
    );
    return parseTenantUserList({ schemaVersion: 1, users: result.rows.map(userFromRow) });
  }

  async createUser(principal: RuntimeRegistryPrincipal, value: TenantUserCreate): Promise<TenantUser> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const input = parseTenantUserCreate(value);
    const passwordVerifier = await derivePasswordVerifier(input.initialPassword);
    const loginIdentifier = normalizeLoginIdentifier(input.userId);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await this.#validateUserModels(client, tenantId, input.allowedModelIds, [], true);
      const result = await client.query<UserRow>(
        `
        INSERT INTO e_mate_tenant_user (
          tenant_id, user_id, display_name, roles, status, token_limit, allowed_model_ids
        )
        VALUES ($1,$2,$3,$4,'ACTIVE',$5,$6)
        ON CONFLICT DO NOTHING
        RETURNING user_id, display_name, roles, status, token_limit, allowed_model_ids, created_at, updated_at
      `,
        [tenantId, input.userId, input.displayName, input.roles, input.tokenLimit, input.allowedModelIds]
      );
      const row = result.rows[0];
      if (!row) throw new AdminManagementError('CONFLICT');
      await client.query(
        `
        INSERT INTO e_mate_auth_password_credential (
          credential_id, tenant_id, user_id, login_identifier_normalized,
          password_salt, password_hash, scrypt_cost, scrypt_block_size,
          scrypt_parallelization
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `,
        [
          randomUUID(),
          tenantId,
          input.userId,
          loginIdentifier,
          passwordVerifier.salt,
          passwordVerifier.hash,
          passwordVerifier.cost,
          passwordVerifier.blockSize,
          passwordVerifier.parallelization,
        ]
      );
      await this.#audit(client, principal, 'USER_CREATED', 'USER', input.userId, { roles: input.roles });
      await client.query('COMMIT');
      return userFromRow(row);
    } catch (error) {
      await rollback(client);
      if (isLoginIdentityConflict(error)) throw new AdminManagementError('CONFLICT');
      throw error;
    } finally {
      client.release();
    }
  }

  async resetPassword(
    principal: RuntimeRegistryPrincipal,
    userIdInput: string,
    value: AdminPasswordReset
  ): Promise<boolean> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const userId = identifier(userIdInput, 'user id');
    const input = parseAdminPasswordReset(value);
    const passwordVerifier = await derivePasswordVerifier(input.password);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query<{ status: 'PENDING_APPROVAL' | 'ACTIVE' | 'SUSPENDED' | 'DELETED' }>(
        `
        SELECT status
          FROM e_mate_tenant_user
         WHERE tenant_id = $1 AND user_id = $2
         FOR UPDATE
      `,
        [tenantId, userId]
      );
      if (!user.rows[0] || user.rows[0].status === 'DELETED') {
        await client.query('COMMIT');
        return false;
      }
      const accounts = await client.query<{ login_identifier_normalized: string }>(
        `SELECT login_identifier_normalized FROM e_mate_auth_password_credential WHERE tenant_id = $1 AND user_id = $2
         UNION SELECT login_identifier_normalized FROM e_mate_auth_legacy_password_credential WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId]
      );
      if (accounts.rows.length > 1) throw new AdminManagementError('CONFLICT');
      const loginIdentifier = accounts.rows[0]?.login_identifier_normalized ?? normalizeLoginIdentifier(userId);
      await client.query(
        `
        INSERT INTO e_mate_auth_password_credential (
          credential_id, tenant_id, user_id, login_identifier_normalized,
          password_salt, password_hash, scrypt_cost, scrypt_block_size,
          scrypt_parallelization
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (tenant_id, user_id) DO UPDATE
          SET password_salt = EXCLUDED.password_salt,
              password_hash = EXCLUDED.password_hash,
              scrypt_cost = EXCLUDED.scrypt_cost,
              scrypt_block_size = EXCLUDED.scrypt_block_size,
              scrypt_parallelization = EXCLUDED.scrypt_parallelization,
              updated_at = clock_timestamp()
      `,
        [
          randomUUID(),
          tenantId,
          userId,
          loginIdentifier,
          passwordVerifier.salt,
          passwordVerifier.hash,
          passwordVerifier.cost,
          passwordVerifier.blockSize,
          passwordVerifier.parallelization,
        ]
      );
      await client.query(
        `UPDATE e_mate_auth_credential_migration SET upgraded_at = COALESCE(upgraded_at, clock_timestamp())
          WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]
      );
      await client.query('DELETE FROM e_mate_auth_legacy_password_credential WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
      await client.query(
        `
        UPDATE e_mate_auth_session
           SET status = 'REVOKED', revoked_at = clock_timestamp()
         WHERE tenant_id = $1 AND user_id = $2 AND status = 'ACTIVE'
      `,
        [tenantId, userId]
      );
      await client.query(
        `
        UPDATE e_mate_auth_refresh_token AS refresh
           SET status = 'REVOKED', consumed_request_id = NULL,
               replacement_generation = NULL, consumed_at = NULL
          FROM e_mate_auth_session AS session
         WHERE refresh.session_id = session.session_id
           AND session.tenant_id = $1 AND session.user_id = $2
           AND refresh.status <> 'REVOKED'
      `,
        [tenantId, userId]
      );
      await this.#audit(client, principal, 'USER_PASSWORD_RESET', 'USER', userId, {
        sessionsRevoked: true,
      });
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateUser(
    principal: RuntimeRegistryPrincipal,
    userIdInput: string,
    value: TenantUserUpdate
  ): Promise<TenantUser | null> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const userId = identifier(userIdInput, 'user id');
    const input = parseTenantUserUpdate(value);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query<UserRow>(
        `
        SELECT user_id, display_name, roles, status, token_limit, allowed_model_ids, created_at, updated_at
          FROM e_mate_tenant_user
         WHERE tenant_id = $1 AND user_id = $2
         FOR UPDATE
      `,
        [tenantId, userId]
      );
      const current = currentResult.rows[0];
      if (!current || current.status === 'DELETED') {
        await client.query('COMMIT');
        return null;
      }
      if (current.updated_at.toISOString() !== input.expectedUpdatedAt) {
        throw new AdminManagementError('STALE_UPDATE');
      }
      await this.#validateUserModels(client, tenantId, input.allowedModelIds, current.allowed_model_ids,
        input.status === 'ACTIVE' && current.status !== 'ACTIVE');
      const result = await client.query<UserRow>(
        `
        UPDATE e_mate_tenant_user
           SET display_name = $3, roles = $4, status = $5,
               token_limit = $6, allowed_model_ids = $7,
               updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 millisecond')
         WHERE tenant_id = $1 AND user_id = $2 AND status <> 'DELETED'
        RETURNING user_id, display_name, roles, status, token_limit, allowed_model_ids, created_at, updated_at
      `,
        [tenantId, userId, input.displayName, input.roles, input.status, input.tokenLimit, input.allowedModelIds]
      );
      const row = result.rows[0];
      if (!row) throw new Error('User update was unavailable');
      const sessionsRevoked =
        input.status !== 'ACTIVE' ||
        !sameModelSet(current.allowed_model_ids, input.allowedModelIds);
      if (sessionsRevoked) {
        await client.query(
          `UPDATE e_mate_auth_session
              SET status = 'REVOKED', revoked_at = clock_timestamp()
            WHERE tenant_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
          [tenantId, userId]
        );
        await client.query(
          `UPDATE e_mate_auth_refresh_token AS refresh
              SET status = 'REVOKED', consumed_request_id = NULL,
                  replacement_generation = NULL, consumed_at = NULL
             FROM e_mate_auth_session AS session
            WHERE refresh.session_id = session.session_id
              AND session.tenant_id = $1 AND session.user_id = $2
              AND refresh.status <> 'REVOKED'`,
          [tenantId, userId]
        );
      }
      await this.#audit(client, principal, 'USER_UPDATED', 'USER', userId, {
        previousRoles: current.roles,
        roles: input.roles,
        previousStatus: current.status,
        status: input.status,
        previousTokenLimit: current.token_limit === null ? null : Number(current.token_limit),
        tokenLimit: input.tokenLimit,
        previousAllowedModelIds: current.allowed_model_ids,
        allowedModelIds: input.allowedModelIds,
        sessionsRevoked,
      });
      await client.query('COMMIT');
      return userFromRow(row);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteUser(
    principal: RuntimeRegistryPrincipal,
    userIdInput: string,
    value: TenantUserDelete
  ): Promise<boolean> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const userId = identifier(userIdInput, 'user id');
    const input = parseTenantUserDelete(value);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{
        status: 'PENDING_APPROVAL' | 'ACTIVE' | 'SUSPENDED' | 'DELETED';
        updated_at: Date;
      }>(
        `
        SELECT status, updated_at
          FROM e_mate_tenant_user
         WHERE tenant_id = $1 AND user_id = $2
         FOR UPDATE
      `,
        [tenantId, userId]
      );
      const user = current.rows[0];
      if (!user) {
        await client.query('COMMIT');
        return false;
      }
      if (user.status !== 'DELETED') {
        if (user.updated_at.toISOString() !== input.expectedUpdatedAt) {
          throw new AdminManagementError('STALE_UPDATE');
        }
        await client.query(
          `
          UPDATE e_mate_tenant_user
             SET status = 'DELETED',
                 updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 millisecond')
           WHERE tenant_id = $1 AND user_id = $2
        `,
          [tenantId, userId]
        );
        await client.query(
          `
          UPDATE e_mate_admin_api_key
             SET revoked_at = now()
           WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL
        `,
          [tenantId, userId]
        );
        await this.#audit(client, principal, 'USER_DELETED', 'USER', userId);
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async listApiKeys(principal: RuntimeRegistryPrincipal): Promise<AdminApiKeyList> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const result = await this.#pool.query<KeyRow>(
      `
      SELECT key_id, label, principal_type, principal_id, user_id, scopes,
             created_at, last_used_at, revoked_at
        FROM e_mate_admin_api_key
       WHERE tenant_id = $1
       ORDER BY created_at DESC, key_id
    `,
      [tenantId]
    );
    return parseAdminApiKeyList({ schemaVersion: 1, keys: result.rows.map(keyFromRow) });
  }

  async issueApiKey(principal: RuntimeRegistryPrincipal, value: AdminApiKeyCreate): Promise<AdminApiKeyCreationResult> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const input = parseAdminApiKeyCreate(value);
    const secret = issueSecret();
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query<{ status: 'ACTIVE' | 'SUSPENDED' }>(
        `
        SELECT status
          FROM e_mate_tenant_user
         WHERE tenant_id = $1 AND user_id = $2
         FOR SHARE
      `,
        [tenantId, input.userId]
      );
      if (user.rows[0]?.status !== 'ACTIVE') throw new AdminManagementError('USER_UNAVAILABLE');
      const keyId = randomUUID();
      const result = await client.query<KeyRow>(
        `
        INSERT INTO e_mate_admin_api_key (
          tenant_id, key_id, label, principal_type, principal_id, user_id,
          scopes, token_hash, created_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING key_id, label, principal_type, principal_id, user_id, scopes,
                  created_at, last_used_at, revoked_at
      `,
        [
          tenantId,
          keyId,
          input.label,
          input.principalType,
          input.principalId,
          input.userId,
          input.scopes,
          keyHash(secret),
          principal.userId,
        ]
      );
      await this.#audit(client, principal, 'API_KEY_ISSUED', 'API_KEY', keyId, {
        label: input.label,
        principalType: input.principalType,
        principalId: input.principalId,
        userId: input.userId,
        scopes: input.scopes,
      });
      await client.query('COMMIT');
      return parseAdminApiKeyCreationResult({ schemaVersion: 1, key: keyFromRow(result.rows[0] as KeyRow), secret });
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeApiKey(principal: RuntimeRegistryPrincipal, keyIdInput: string): Promise<boolean> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const keyId = identifier(keyIdInput, 'key id');
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `
        UPDATE e_mate_admin_api_key
           SET revoked_at = COALESCE(revoked_at, now())
         WHERE tenant_id = $1 AND key_id = $2
        RETURNING key_id
      `,
        [tenantId, keyId]
      );
      if (!result.rowCount) {
        await client.query('COMMIT');
        return false;
      }
      await this.#audit(client, principal, 'API_KEY_REVOKED', 'API_KEY', keyId);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  // Keep existing policy/key storage; the public image route remains canonical.
  async #imagePolicyRecord(client: PoolClient, tenantId: string, routeId: string): Promise<string> {
    if (routeId !== IMAGE_ROUTE_ID) return routeId;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [tenantId + ':' + routeId]);
    const result = await client.query<{ route_id: string }>(
      'SELECT route_id FROM e_mate_tenant_model_route WHERE tenant_id=$1 AND route_id=ANY($2::text[]) ORDER BY (route_id=$3) DESC LIMIT 1 FOR UPDATE',
      [tenantId, [IMAGE_ROUTE_ID, LEGACY_IMAGE_ROUTE_ID], IMAGE_ROUTE_ID]);
    return result.rows[0]?.route_id ?? routeId;
  }

  async listModelRoutes(principal: RuntimeRegistryPrincipal): Promise<AdminModelRouteList> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const result = await this.#pool.query<ModelRouteRow>(
      `
      SELECT route_id, published, enabled, updated_at, key_updated_at,
             upstream_key_ciphertext IS NOT NULL
               AND upstream_key_nonce IS NOT NULL
               AND upstream_key_tag IS NOT NULL AS key_configured
        FROM e_mate_tenant_model_route
       WHERE tenant_id = $1
    `,
      [tenantId]
    );
    const policies = new Map(result.rows.map((row) => [row.route_id, row]));
    return parseAdminModelRouteList({
      schemaVersion: 1,
      routes: this.#catalog.map((route) => {
        const policy = policies.get(route.routeId) ?? (route.routeId === IMAGE_ROUTE_ID ? policies.get(LEGACY_IMAGE_ROUTE_ID) : undefined);
        return {
          schemaVersion: 1,
          routeId: route.routeId,
          label: route.label,
          provider: route.provider,
          published: policy?.published ?? true,
          enabled: policy?.enabled ?? isDefaultEnabledModelRoute(route.routeId),
          updatedAt: policy?.updated_at.toISOString() ?? null,
          keyConfigured: policy?.key_configured ?? false,
          keyUpdatedAt: policy?.key_updated_at?.toISOString() ?? null,
        };
      }),
    });
  }

  async updateModelRoute(
    principal: RuntimeRegistryPrincipal,
    routeIdInput: string,
    value: AdminModelRouteUpdate
  ): Promise<AdminModelRoute | null> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const routeId = identifier(routeIdInput, 'route id');
    const route = this.#catalog.find((candidate) => candidate.routeId === routeId);
    if (!route) return null;
    const input = parseAdminModelRouteUpdate(value);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const recordId = await this.#imagePolicyRecord(client, tenantId, routeId);
      const result = await client.query<{
        published: boolean;
        enabled: boolean;
        updated_at: Date;
        key_configured: boolean;
        key_updated_at: Date | null;
      }>(
        `
        INSERT INTO e_mate_tenant_model_route (
          tenant_id, route_id, enabled, updated_by
        )
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (tenant_id, route_id) DO UPDATE
          SET enabled = EXCLUDED.enabled,
              updated_at = now(),
              updated_by = EXCLUDED.updated_by
        RETURNING published, enabled, updated_at, key_updated_at,
                  upstream_key_ciphertext IS NOT NULL
                    AND upstream_key_nonce IS NOT NULL
                    AND upstream_key_tag IS NOT NULL AS key_configured
      `,
        [tenantId, recordId, input.enabled, principal.userId]
      );
      await this.#audit(client, principal, 'MODEL_ROUTE_UPDATED', 'MODEL_ROUTE', routeId, {
        enabled: input.enabled,
      });
      await client.query('COMMIT');
      return {
        schemaVersion: 1,
        routeId,
        label: route.label,
        provider: route.provider,
        published: result.rows[0]?.published ?? true,
        enabled: result.rows[0]?.enabled ?? input.enabled,
        updatedAt: (result.rows[0]?.updated_at ?? new Date()).toISOString(),
        keyConfigured: result.rows[0]?.key_configured ?? false,
        keyUpdatedAt: result.rows[0]?.key_updated_at?.toISOString() ?? null,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async publishModelRoute(
    principal: RuntimeRegistryPrincipal,
    routeIdInput: string,
    value: AdminModelRoutePublication
  ): Promise<AdminModelRoute | null> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const routeId = identifier(routeIdInput, 'route id');
    const route = this.#catalog.find((candidate) => candidate.routeId === routeId);
    if (!route) return null;
    const input = parseAdminModelRoutePublication(value);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const recordId = await this.#imagePolicyRecord(client, tenantId, routeId);
      const result = await client.query<{
        published: boolean;
        enabled: boolean;
        updated_at: Date;
        key_configured: boolean;
        key_updated_at: Date | null;
      }>(
        `INSERT INTO e_mate_tenant_model_route (
           tenant_id, route_id, published, enabled, updated_by
         ) VALUES ($1,$2,$3,false,$4)
         ON CONFLICT (tenant_id, route_id) DO UPDATE
           SET published = EXCLUDED.published,
               enabled = CASE WHEN EXCLUDED.published THEN e_mate_tenant_model_route.enabled ELSE false END,
               updated_at = now(),
               updated_by = EXCLUDED.updated_by
         RETURNING published, enabled, updated_at, key_updated_at,
                   upstream_key_ciphertext IS NOT NULL
                     AND upstream_key_nonce IS NOT NULL
                     AND upstream_key_tag IS NOT NULL AS key_configured`,
        [tenantId, recordId, input.published, principal.userId]
      );
      await this.#audit(
        client,
        principal,
        input.published ? 'MODEL_ROUTE_PUBLISHED' : 'MODEL_ROUTE_REMOVED',
        'MODEL_ROUTE',
        routeId,
        { published: input.published }
      );
      await client.query('COMMIT');
      const row = result.rows[0];
      if (!row) throw new Error('Model route publication was unavailable');
      return {
        schemaVersion: 1,
        routeId,
        label: route.label,
        provider: route.provider,
        published: row.published,
        enabled: row.enabled,
        updatedAt: row.updated_at.toISOString(),
        keyConfigured: row.key_configured,
        keyUpdatedAt: row.key_updated_at?.toISOString() ?? null,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateModelRouteKey(
    principal: RuntimeRegistryPrincipal,
    routeIdInput: string,
    value: AdminModelRouteKeyUpdate
  ): Promise<AdminModelRoute | null> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const routeId = identifier(routeIdInput, 'route id');
    const route = this.#catalog.find((candidate) => candidate.routeId === routeId);
    if (!route) return null;
    const input = parseAdminModelRouteKeyUpdate(value);
    if (!this.#routeKeyEncryptionKey) throw new Error('Model route key management is unavailable');
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const recordId = await this.#imagePolicyRecord(client, tenantId, routeId);
      const encrypted = encryptRouteKey(this.#routeKeyEncryptionKey!, tenantId, recordId, input.apiKey);
      const result = await client.query<{
        published: boolean;
        enabled: boolean;
        updated_at: Date;
        key_updated_at: Date;
      }>(
        `
        INSERT INTO e_mate_tenant_model_route (
          tenant_id, route_id, enabled, updated_by, upstream_key_ciphertext,
          upstream_key_nonce, upstream_key_tag, key_updated_at, key_updated_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$4)
        ON CONFLICT (tenant_id, route_id) DO UPDATE
          SET upstream_key_ciphertext = EXCLUDED.upstream_key_ciphertext,
              upstream_key_nonce = EXCLUDED.upstream_key_nonce,
              upstream_key_tag = EXCLUDED.upstream_key_tag,
              key_updated_at = now(),
              key_updated_by = EXCLUDED.key_updated_by
        RETURNING published, enabled, updated_at, key_updated_at
      `,
        [
          tenantId,
          recordId,
          isDefaultEnabledModelRoute(routeId),
          principal.userId,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.tag,
        ]
      );
      await this.#audit(client, principal, 'MODEL_ROUTE_KEY_UPDATED', 'MODEL_ROUTE', routeId, {
        keyConfigured: true,
      });
      await client.query('COMMIT');
      const row = result.rows[0];
      if (!row) throw new Error('Model route key update was unavailable');
      return {
        schemaVersion: 1,
        routeId,
        label: route.label,
        provider: route.provider,
        published: row.published,
        enabled: row.enabled,
        updatedAt: row.updated_at.toISOString(),
        keyConfigured: true,
        keyUpdatedAt: row.key_updated_at.toISOString(),
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function validateAdminPostgresUrl(value: string): string {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  const privateService = url.hostname === 'postgres';
  const queryValid =
    loopback || privateService
      ? !url.search
      : url.searchParams.size === 1 && url.searchParams.get('sslmode') === 'require';
  if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || !url.hostname || url.hash || !queryValid) {
    throw new Error('PostgreSQL URL was invalid');
  }
  return url.toString();
}

export async function openPostgresAdminManagementStore(
  url: string,
  catalog: AdminModelRouteDefinition[],
  routeKeyEncryptionKey?: Buffer
): Promise<{ store: PostgresAdminManagementStore; close: () => Promise<void> }> {
  const connectionString = validateAdminPostgresUrl(url);
  const hostname = new URL(connectionString).hostname;
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
  const privateService = hostname === 'postgres';
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(loopback || privateService ? {} : { ssl: { rejectUnauthorized: true } }),
  });
  pool.on('error', () => undefined);
  const store = new PostgresAdminManagementStore(pool, catalog, routeKeyEncryptionKey);
  try {
    await store.initialize();
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  return { store, close: () => pool.end() };
}
