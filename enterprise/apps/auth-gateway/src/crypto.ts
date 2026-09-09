import { imageModelGrantView } from '@e-mate/admin-contract';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createHmac,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
export {
  derivePasswordVerifier,
  verifyEcorexV0292Password,
  verifyPassword,
  type ScryptVerifier,
} from '@e-mate/auth-credential';

export type AuthIdentity = {
  tenantId: string;
  userId: string;
  displayName: string;
  roles: string[];
  modelIds: string[];
  weeklyTokenLimit: number;
};

export type SessionTokenIssuerOptions = {
  issuer: string;
  accessAudience: string;
  modelAudience: string;
  keyId: string;
  privateKey: KeyObject | string | Buffer;
  modelGatewayBaseUrl: string;
  usageKeyId: string;
  usagePublicKey: string;
  accessLifetimeSeconds: number;
  modelLifetimeSeconds: number;
};

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function refreshTokenHash(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function createRefreshToken(): string {
  return `emate_rt_${randomBytes(32).toString('base64url')}`;
}

export function deriveRefreshToken(secret: Buffer, sessionId: string, generation: number, requestId: string): string {
  if (
    secret.byteLength !== 32 ||
    !identifierPattern.test(sessionId) ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    generation > Number.MAX_SAFE_INTEGER ||
    !identifierPattern.test(requestId)
  ) {
    throw new Error('Invalid refresh derivation input');
  }
  return `emate_rt_${createHmac('sha256', secret)
    .update(sessionId, 'utf8')
    .update('\0')
    .update(String(generation), 'ascii')
    .update('\0')
    .update(requestId, 'utf8')
    .digest('base64url')}`;
}

function text(value: string, label: string, maximum: number): string {
  if (!value || value.length > maximum || /\p{Cc}/u.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function httpsUrl(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid ${label}`);
  }
  return url.toString().replace(/\/$/, '');
}

function jwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: KeyObject): string {
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = sign(null, Buffer.from(signingInput, 'ascii'), key).toString('base64url');
  return `${signingInput}.${signature}`;
}

function integer(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${label}`);
  return value;
}

export function createSessionTokenIssuer(options: SessionTokenIssuerOptions) {
  const privateKey =
    typeof options.privateKey === 'string' || Buffer.isBuffer(options.privateKey)
      ? createPrivateKey(options.privateKey)
      : options.privateKey;
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Session signing key must be Ed25519');
  }
  const keyId = text(options.keyId, 'session key id', 128);
  if (!identifierPattern.test(keyId)) throw new Error('Invalid session key id');
  const issuer = text(options.issuer, 'session issuer', 256);
  const accessAudience = text(options.accessAudience, 'access audience', 256);
  const modelAudience = text(options.modelAudience, 'model audience', 256);
  const modelGatewayBaseUrl = httpsUrl(options.modelGatewayBaseUrl, 'Model Gateway URL');
  const usageKeyId = text(options.usageKeyId, 'Usage key id', 80);
  const usagePublicKey = options.usagePublicKey.trim();
  if (!usagePublicKey || usagePublicKey.length > 8_192 || usagePublicKey.includes('\u0000')) {
    throw new Error('Invalid Usage public key');
  }
  const usageKey = createPublicKey(usagePublicKey);
  if (usageKey.type !== 'public' || usageKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Usage public key must be Ed25519');
  }
  const accessLifetime = integer(options.accessLifetimeSeconds, 'access lifetime', 120, 24 * 60 * 60);
  const modelLifetime = integer(options.modelLifetimeSeconds, 'model lifetime', 120, 15 * 60);
  if (modelLifetime > accessLifetime) throw new Error('Model lifetime exceeds access lifetime');

  return (identity: AuthIdentity, sessionId: string, refreshToken: string, now = Date.now()) => {
    if (
      !identifierPattern.test(identity.tenantId) ||
      !identifierPattern.test(identity.userId) ||
      !identifierPattern.test(sessionId) ||
      !Array.isArray(identity.roles) ||
      identity.roles.length < 1 ||
      identity.roles.length > 3 ||
      identity.roles.some((role) => !['TENANT_ADMIN', 'AUDIT_ADMIN', 'MEMBER'].includes(role)) ||
      !Array.isArray(identity.modelIds) ||
      !Number.isSafeInteger(identity.weeklyTokenLimit) ||
      identity.weeklyTokenLimit < 1 ||
      identity.modelIds.length > 20 ||
      identity.modelIds.some((modelId) => !identifierPattern.test(modelId) || modelId === 'e-mate-faux') ||
      new Set(identity.modelIds).size !== identity.modelIds.length ||
      !/^emate_rt_[A-Za-z0-9_-]{43}$/.test(refreshToken) ||
      !Number.isSafeInteger(now)
    ) {
      throw new Error('Invalid session identity');
    }
    const issuedAt = Math.floor(now / 1_000);
    const accessExpiry = issuedAt + accessLifetime;
    const modelExpiry = issuedAt + modelLifetime;
    const accessToken = jwt(
      { alg: 'EdDSA', typ: 'e-mate-auth-session+jwt', kid: keyId },
      {
        schemaVersion: 1,
        iss: issuer,
        aud: accessAudience,
        sub: identity.userId,
        sid: sessionId,
        tenantId: identity.tenantId,
        roles: identity.roles,
        weeklyTokenLimit: identity.weeklyTokenLimit,
        iat: issuedAt,
        nbf: issuedAt,
        exp: accessExpiry,
        jti: randomUUID(),
      },
      privateKey
    );
    const modelToken = jwt(
      { alg: 'EdDSA', typ: 'e-mate-model-session+jwt', kid: keyId },
      {
        schemaVersion: 1,
        iss: issuer,
        aud: modelAudience,
        sub: identity.userId,
        sid: sessionId,
        tenantId: identity.tenantId,
        roles: identity.roles,
        modelIds: identity.modelIds,
        scopes: ['models:read', 'responses:create', 'usage:read'],
        iat: issuedAt,
        nbf: issuedAt,
        exp: modelExpiry,
        jti: randomUUID(),
      },
      privateKey
    );
    return {
      schemaVersion: 1 as const,
      sessionId,
      accessToken,
      refreshToken,
      expiresAt: new Date(accessExpiry * 1_000).toISOString(),
      identity: {
        tenantId: identity.tenantId,
        userId: identity.userId,
        displayName: text(identity.displayName, 'display name', 160),
        roles: [...identity.roles],
        weeklyTokenLimit: identity.weeklyTokenLimit,
      },
      modelGateway: {
        baseUrl: modelGatewayBaseUrl,
        sessionToken: modelToken,
        expiresAt: new Date(modelExpiry * 1_000).toISOString(),
        usageKeyId,
        usagePublicKey,
        allowedModelIds: imageModelGrantView(identity.modelIds),
      },
    };
  };
}
