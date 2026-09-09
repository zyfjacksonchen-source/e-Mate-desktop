import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { createSessionTokenIssuer, derivePasswordVerifier, deriveRefreshToken, verifyPassword } from '../src/crypto.ts';
import { createSessionTokenVerifier } from '../../model-gateway/src/session-auth.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const usageKeys = generateKeyPairSync('ed25519');

function decodeJwt(token: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [encodedHeader, encodedClaims, encodedSignature] = token.split('.');
  assert.ok(encodedHeader && encodedClaims && encodedSignature);
  assert.equal(
    verify(
      null,
      Buffer.from(`${encodedHeader}.${encodedClaims}`, 'ascii'),
      publicKey,
      Buffer.from(encodedSignature, 'base64url')
    ),
    true
  );
  return {
    header: JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8')) as Record<string, unknown>,
  };
}

test('password verifier uses fixed scrypt parameters and rejects wrong or absent credentials', async () => {
  const credential = await derivePasswordVerifier('correct horse battery staple');
  assert.equal(credential.salt.byteLength, 32);
  assert.equal(credential.hash.byteLength, 64);
  assert.equal(credential.cost, 65_536);
  assert.equal(await verifyPassword('correct horse battery staple', credential), true);
  assert.equal(await verifyPassword('wrong', credential), false);
  assert.equal(await verifyPassword('wrong'), false);
});

test('refresh derivation is idempotent only for the same session generation and request id', () => {
  const secret = Buffer.alloc(32, 7);
  const first = deriveRefreshToken(secret, 'session-1', 2, 'request-1');
  assert.equal(deriveRefreshToken(secret, 'session-1', 2, 'request-1'), first);
  assert.notEqual(deriveRefreshToken(secret, 'session-1', 2, 'request-2'), first);
  assert.notEqual(deriveRefreshToken(secret, 'session-1', 3, 'request-1'), first);
  assert.match(first, /^emate_rt_[A-Za-z0-9_-]{43}$/);
});

test('issued response matches desktop contract and model token authorizes consent reads', async () => {
  const now = Date.UTC(2026, 7, 2, 0, 0, 0);
  const issue = createSessionTokenIssuer({
    issuer: 'e-mate-auth',
    accessAudience: 'e-mate-desktop',
    modelAudience: 'e-mate-model-gateway',
    keyId: 'auth-2026-08',
    privateKey,
    modelGatewayBaseUrl: 'https://mvdcm.ecoremedia.net/e-mate/model-gateway',
    usageKeyId: 'usage-2026-08',
    usagePublicKey: usageKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    accessLifetimeSeconds: 900,
    modelLifetimeSeconds: 600,
  });
  const session = issue(
    {
      tenantId: 'tenant-a',
      userId: 'user-a',
      displayName: '测试用户',
      roles: ['MEMBER'],
      modelIds: ['gpt-5.6-luna', 'gpt-image-2.5-flare'],
      weeklyTokenLimit: 50_000,
    },
    'session-1',
    `emate_rt_${Buffer.alloc(32, 3).toString('base64url')}`,
    now
  );
  assert.deepEqual(Object.keys(session), [
    'schemaVersion',
    'sessionId',
    'accessToken',
    'refreshToken',
    'expiresAt',
    'identity',
    'modelGateway',
  ]);
  assert.equal(session.schemaVersion, 1);
  assert.deepEqual(Object.keys(session.modelGateway), [
    'baseUrl',
    'sessionToken',
    'expiresAt',
    'usageKeyId',
    'usagePublicKey',
    'allowedModelIds',
  ]);
  const modelJwt = decodeJwt(session.modelGateway.sessionToken);
  assert.deepEqual(modelJwt.header, { alg: 'EdDSA', typ: 'e-mate-model-session+jwt', kid: 'auth-2026-08' });
  assert.equal(modelJwt.claims.aud, 'e-mate-model-gateway');
  assert.deepEqual(modelJwt.claims.scopes, ['models:read', 'responses:create', 'usage:read']);
  assert.deepEqual(modelJwt.claims.roles, ['MEMBER']);
  assert.deepEqual(modelJwt.claims.modelIds, ['gpt-5.6-luna', 'gpt-image-2.5-flare']);
  assert.equal(modelJwt.claims.sid, 'session-1');
  const authenticateModelGateway = createSessionTokenVerifier({
    issuer: 'e-mate-auth',
    audience: 'e-mate-model-gateway',
    publicKeys: new Map([['auth-2026-08', publicKey]]),
    now: () => now,
  });
  assert.deepEqual(await authenticateModelGateway(session.modelGateway.sessionToken), {
    tenantId: 'tenant-a',
    userId: 'user-a',
    roles: ['MEMBER'],
    modelIds: ['gpt-5.6-luna', 'gpt-image-2.5-flare'],
    sessionId: 'session-1',
  });
});

test('issuer rejects non-Ed25519 keys and insecure gateway URLs', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2_048 });
  assert.throws(
    () =>
      createSessionTokenIssuer({
        issuer: 'e-mate-auth',
        accessAudience: 'e-mate-desktop',
        modelAudience: 'e-mate-model-gateway',
        keyId: 'key-1',
        privateKey: rsa.privateKey,
        modelGatewayBaseUrl: 'https://gateway.example.test',
        usageKeyId: 'usage-1',
        usagePublicKey: usageKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        accessLifetimeSeconds: 900,
        modelLifetimeSeconds: 600,
      }),
    /Ed25519/
  );
  assert.throws(
    () =>
      createSessionTokenIssuer({
        issuer: 'e-mate-auth',
        accessAudience: 'e-mate-desktop',
        modelAudience: 'e-mate-model-gateway',
        keyId: 'key-1',
        privateKey,
        modelGatewayBaseUrl: 'http://gateway.example.test',
        usageKeyId: 'usage-1',
        usagePublicKey: usageKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        accessLifetimeSeconds: 900,
        modelLifetimeSeconds: 600,
      }),
    /Model Gateway URL/
  );
});
