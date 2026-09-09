import { createDecipheriv, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { DEFAULT_ENABLED_MODEL_ROUTE_IDS, isDefaultEnabledModelRoute, isRetiredModelRoute } from '@e-mate/admin-contract';
import type { ModelGatewayPrincipal, TenantModelRoutePolicy } from './server.ts';

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const clientCredentialPattern = /^emate_twe_[A-Za-z0-9_-]{43}$/;

function identifier(value: string, label: string): string {
  if (!identifierPattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

export class PostgresTenantModelRoutePolicy implements TenantModelRoutePolicy {
  readonly #pool: Pool;
  readonly #routeKeyEncryptionKey: Buffer | undefined;

  constructor(pool: Pool, routeKeyEncryptionKey?: Buffer) {
    this.#pool = pool;
    this.#routeKeyEncryptionKey = routeKeyEncryptionKey ? Buffer.from(routeKeyEncryptionKey) : undefined;
    if (this.#routeKeyEncryptionKey && this.#routeKeyEncryptionKey.byteLength !== 32) {
      throw new Error('Invalid model route key encryption key');
    }
  }

  async isEnabled(tenantIdInput: string, routeIdInput: string): Promise<boolean> {
    const tenantId = identifier(tenantIdInput, 'tenant id');
    const routeId = identifier(routeIdInput, 'route id');
    if (isRetiredModelRoute(routeId)) return false;
    const result = await this.#pool.query<{ enabled: boolean }>(
      `
      SELECT enabled AND published AS enabled
        FROM e_mate_tenant_model_route
       WHERE tenant_id = $1 AND (route_id = $2 OR
         ($2 = 'gpt-image-2.5-flare' AND route_id = 'gpt-image-2-pro'))
       ORDER BY (route_id = $2) DESC LIMIT 1
    `,
      [tenantId, routeId]
    );
    return result.rows[0]?.enabled ?? isDefaultEnabledModelRoute(routeId);
  }

  async isUserActive(tenantIdInput: string, userIdInput: string): Promise<boolean> {
    const tenantId = identifier(tenantIdInput, 'tenant id');
    const userId = identifier(userIdInput, 'user id');
    const result = await this.#pool.query<{ active: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
          FROM e_mate_tenant_user
         WHERE tenant_id = $1 AND user_id = $2 AND status = 'ACTIVE'
      ) AS active
    `,
      [tenantId, userId]
    );
    const active = result.rows[0]?.active;
    if (typeof active !== 'boolean') throw new Error('User status was unavailable');
    return active;
  }

  async isUserSessionActive(tenantIdInput: string, userIdInput: string, sessionIdInput: string): Promise<boolean> {
    const tenantId = identifier(tenantIdInput, 'tenant id');
    const userId = identifier(userIdInput, 'user id');
    const sessionId = identifier(sessionIdInput, 'session id');
    const result = await this.#pool.query<{ active: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
          FROM e_mate_tenant_user AS app_user
          JOIN e_mate_auth_session AS session
            ON session.tenant_id = app_user.tenant_id
           AND session.user_id = app_user.user_id
         WHERE app_user.tenant_id = $1
           AND app_user.user_id = $2
           AND session.session_id = $3
           AND app_user.status = 'ACTIVE'
           AND session.status = 'ACTIVE'
           AND session.expires_at > clock_timestamp()
      ) AS active
    `,
      [tenantId, userId, sessionId]
    );
    const active = result.rows[0]?.active;
    if (typeof active !== 'boolean') throw new Error('User session status was unavailable');
    return active;
  }

  async authenticateClientCredential(
    bearer: string,
    routeIdsInput: readonly string[]
  ): Promise<ModelGatewayPrincipal | null> {
    if (!clientCredentialPattern.test(bearer)) return null;
    if (
      routeIdsInput.length < 1 ||
      routeIdsInput.length > 20 ||
      routeIdsInput.some((routeId) => !identifierPattern.test(routeId)) ||
      new Set(routeIdsInput).size !== routeIdsInput.length
    ) {
      throw new Error('Invalid model route catalog');
    }
    const routeIds = [...routeIdsInput];
    const tokenHash = createHash('sha256').update(bearer, 'utf8').digest('base64url');
    const result = await this.#pool.query<{
      tenant_id: string;
      user_id: string;
      model_ids: string[];
    }>(
      `
      WITH authenticated AS (
        UPDATE e_mate_admin_api_key AS key
           SET last_used_at = now()
          FROM e_mate_tenant_user AS app_user
         WHERE key.token_hash = $1
           AND key.revoked_at IS NULL
           AND key.principal_type = 'USER'
           AND key.scopes = ARRAY['models:invoke']::text[]
           AND app_user.tenant_id = key.tenant_id
           AND app_user.user_id = key.user_id
           AND app_user.status = 'ACTIVE'
        RETURNING key.tenant_id, key.user_id
      )
      SELECT authenticated.tenant_id,
             authenticated.user_id,
             ARRAY(
               SELECT candidate.route_id
                 FROM unnest($2::text[]) WITH ORDINALITY AS candidate(route_id, position)
                 LEFT JOIN LATERAL (
                   SELECT stored.published, stored.enabled
                     FROM e_mate_tenant_model_route AS stored
                    WHERE stored.tenant_id = authenticated.tenant_id
                      AND (stored.route_id = candidate.route_id OR
                        (candidate.route_id = 'gpt-image-2.5-flare' AND stored.route_id = 'gpt-image-2-pro'))
                    ORDER BY (stored.route_id = candidate.route_id) DESC LIMIT 1
                 ) AS policy ON true
                WHERE COALESCE(policy.published, true)
                  AND COALESCE(policy.enabled, candidate.route_id = ANY($3::text[]))
                ORDER BY candidate.position
             ) AS model_ids
        FROM authenticated
    `,
      [tokenHash, routeIds, DEFAULT_ENABLED_MODEL_ROUTE_IDS]
    );
    const row = result.rows[0];
    if (
      !row ||
      !identifierPattern.test(row.tenant_id) ||
      !identifierPattern.test(row.user_id) ||
      !Array.isArray(row.model_ids) ||
      row.model_ids.length > routeIds.length ||
      row.model_ids.some((routeId) => !routeIds.includes(routeId)) ||
      new Set(row.model_ids).size !== row.model_ids.length
    ) {
      return null;
    }
    return {
      tenantId: row.tenant_id,
      userId: row.user_id,
      modelIds: [...row.model_ids],
    };
  }

  async upstreamApiKey(tenantIdInput: string, routeIdInput: string): Promise<string | null> {
    const tenantId = identifier(tenantIdInput, 'tenant id');
    const routeId = identifier(routeIdInput, 'route id');
    const result = await this.#pool.query<{
      route_id: string;
      upstream_key_ciphertext: Buffer | null;
      upstream_key_nonce: Buffer | null;
      upstream_key_tag: Buffer | null;
    }>(
      `
      SELECT route_id, upstream_key_ciphertext, upstream_key_nonce, upstream_key_tag
        FROM e_mate_tenant_model_route
       WHERE tenant_id = $1 AND (route_id = $2 OR
         ($2 = 'gpt-image-2.5-flare' AND route_id = 'gpt-image-2-pro'))
       ORDER BY (route_id = $2) DESC LIMIT 1
    `,
      [tenantId, routeId]
    );
    const row = result.rows[0];
    if (
      !row ||
      (row.upstream_key_ciphertext === null && row.upstream_key_nonce === null && row.upstream_key_tag === null)
    ) {
      return null;
    }
    if (
      (row.route_id !== routeId && !(routeId === 'gpt-image-2.5-flare' && row.route_id === 'gpt-image-2-pro')) ||
      !this.#routeKeyEncryptionKey ||
      !row.upstream_key_ciphertext ||
      row.upstream_key_nonce?.byteLength !== 12 ||
      row.upstream_key_tag?.byteLength !== 16
    ) {
      throw new Error('Model route key is unavailable');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.#routeKeyEncryptionKey, row.upstream_key_nonce);
    decipher.setAAD(Buffer.from(`${tenantId}\0${row.route_id}`, 'utf8'));
    decipher.setAuthTag(row.upstream_key_tag);
    const apiKey = Buffer.concat([decipher.update(row.upstream_key_ciphertext), decipher.final()]).toString('utf8');
    if (apiKey.length < 20 || apiKey.length > 8_192 || /\s/.test(apiKey)) {
      throw new Error('Model route key is unavailable');
    }
    return apiKey;
  }
}

function postgresUrl(value: string): string {
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

export async function openPostgresTenantModelRoutePolicy(
  url: string,
  routeKeyEncryptionKey?: Buffer
): Promise<{ policy: PostgresTenantModelRoutePolicy; close: () => Promise<void> }> {
  const connectionString = postgresUrl(url);
  const hostname = new URL(connectionString).hostname;
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
  const privateService = hostname === 'postgres';
  const pool = new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(loopback || privateService ? {} : { ssl: { rejectUnauthorized: true } }),
  });
  pool.on('error', () => undefined);
  try {
    await pool.query(
      'SELECT route_id, published, enabled, upstream_key_ciphertext, upstream_key_nonce, upstream_key_tag FROM e_mate_tenant_model_route LIMIT 0'
    );
    await pool.query('SELECT session_id FROM e_mate_auth_session LIMIT 0');
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  return {
    policy: new PostgresTenantModelRoutePolicy(pool, routeKeyEncryptionKey),
    close: () => pool.end(),
  };
}
