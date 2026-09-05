import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createAuthGatewayHandler, type EnterpriseAuthSession } from '../src/server.ts';
import type { AuthStore } from '../src/types.ts';

const refreshToken = `emate_rt_${Buffer.alloc(32, 5).toString('base64url')}`;
const identity = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  displayName: '测试用户',
  roles: ['MEMBER'],
  modelIds: ['gpt-5.6-sol'],
  weeklyTokenLimit: 50_000,
};

function session(sessionId: string, token: string): EnterpriseAuthSession {
  return {
    schemaVersion: 1,
    sessionId,
    accessToken: 'a'.repeat(32),
    refreshToken: token,
    expiresAt: '2026-08-02T00:15:00.000Z',
    identity: {
      tenantId: identity.tenantId,
      userId: identity.userId,
      displayName: identity.displayName,
      roles: identity.roles,
      weeklyTokenLimit: identity.weeklyTokenLimit,
    },
    modelGateway: {
      baseUrl: 'https://gateway.example.test',
      sessionToken: 'm'.repeat(32),
      expiresAt: '2026-08-02T00:10:00.000Z',
      usageKeyId: 'usage-1',
      usagePublicKey: 'public-key',
      allowedModelIds: identity.modelIds,
    },
  };
}

async function withGateway(
  store: AuthStore,
  run: (baseUrl: string) => Promise<void>,
  maximumRequestsPerMinute = 30
): Promise<void> {
  const handler = createAuthGatewayHandler({
    store,
    issueSession: (_identity, sessionId, token) => session(sessionId, token),
    organizations: new Map([['acme', 'tenant-a']]),
    allowedClientIds: new Set(['e-mate-desktop']),
    now: () => Date.UTC(2026, 7, 2, 0, 0, 0),
    maximumRequestsPerMinute,
  });
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function successStore(): AuthStore {
  return {
    async authenticatePassword(input) {
      assert.deepEqual(input, {
        tenantId: 'tenant-a',
        clientId: 'e-mate-desktop',
        user: 'alice@example.test',
        password: 'secret',
      });
      return { ok: true, identity, sessionId: 'session-1', refreshToken };
    },
    async rotateRefreshToken(input) {
      assert.deepEqual(input, {
        clientId: 'e-mate-desktop',
        refreshToken,
        refreshRequestId: 'request-1',
      });
      return { ok: true, identity, sessionId: 'session-1', refreshToken };
    },
    async issueRegistrationChallenge() {
      return { challengeId: 'challenge-1', code: '123456', expiresAt: new Date('2026-08-02T00:02:00.000Z') };
    },
    async register(input) {
      assert.deepEqual(input, {
        tenantId: 'tenant-a',
        account: 'new@example.test',
        realName: '真实姓名',
        password: 'new-secret',
        challengeId: 'challenge-1',
        verificationCode: '123456',
      });
      return { ok: true, registrationId: 'registration-1' };
    },
    async logout(input) {
      return { ok: true, receiptId: input.clientRequestId };
    },
    async changePassword(input) {
      return { ok: true, receiptId: input.clientRequestId };
    },
  };
}

test('password and refresh endpoints use the exact desktop request and response contracts', async () => {
  await withGateway(successStore(), async (baseUrl) => {
    const passwordResponse = await fetch(`${baseUrl}/v1/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'e-mate-desktop',
        organization: 'Acme',
        user: 'alice@example.test',
        password: 'secret',
      }),
    });
    assert.equal(passwordResponse.status, 200);
    assert.deepEqual(await passwordResponse.json(), session('session-1', refreshToken));
    assert.equal(passwordResponse.headers.get('cache-control'), 'no-store');

    const refreshResponse = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'e-mate-desktop', refreshToken, refreshRequestId: 'request-1' }),
    });
    assert.equal(refreshResponse.status, 200);
    assert.deepEqual(await refreshResponse.json(), session('session-1', refreshToken));
  });
});

test('password and refresh explicitly forward the optional 2.0.18 capability while preserving legacy requests', async () => {
  const versions: Array<string | undefined> = [];
  const store = successStore();
  store.authenticatePassword = async (input) => {
    versions.push(input.clientVersion);
    return { ok: true, identity, sessionId: 'session-1', refreshToken };
  };
  store.rotateRefreshToken = async (input) => {
    versions.push(input.clientVersion);
    return { ok: true, identity, sessionId: 'session-1', refreshToken };
  };
  await withGateway(store, async (baseUrl) => {
    for (const clientVersion of [undefined, '2.0.18']) {
      for (const [path, body] of [
        ['/v1/auth/password', { clientId: 'e-mate-desktop', organization: 'Acme', user: 'alice@example.test', password: 'secret' }],
        ['/v1/auth/refresh', { clientId: 'e-mate-desktop', refreshToken, refreshRequestId: 'request-1' }],
      ] as const) {
        const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, ...(clientVersion ? { clientVersion } : {}) }) });
        assert.equal(response.status, 200);
      }
    }
  });
  assert.deepEqual(versions, [undefined, undefined, '2.0.18', '2.0.18']);
});

test('registration, logout, and password change use bounded first-use contracts', async () => {
  await withGateway(successStore(), async (baseUrl) => {
    const challengeResponse = await fetch(`${baseUrl}/v1/auth/registration/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'e-mate-desktop' }),
    });
    assert.equal(challengeResponse.status, 200);
    const challenge = (await challengeResponse.json()) as Record<string, unknown>;
    assert.equal(challenge.challengeId, 'challenge-1');
    assert.match(String(challenge.imageDataUrl), /^data:image\/png;base64,iVBORw0KGgo/);
    assert.equal(JSON.stringify(challenge).includes('123456'), false);

    const registrationResponse = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'e-mate-desktop',
        organization: 'Acme',
        account: 'new@example.test',
        realName: '真实姓名',
        password: 'new-secret',
        challengeId: 'challenge-1',
        verificationCode: '123456',
      }),
    });
    assert.equal(registrationResponse.status, 201);
    assert.deepEqual(await registrationResponse.json(), {
      schemaVersion: 1,
      registrationId: 'registration-1',
      status: 'PENDING_APPROVAL',
    });

    for (const [path, body, reauthenticationRequired] of [
      ['/v1/auth/logout', { clientId: 'e-mate-desktop', refreshToken, clientRequestId: 'logout-1' }, false],
      [
        '/v1/auth/password/change',
        {
          clientId: 'e-mate-desktop',
          refreshToken,
          clientRequestId: 'password-1',
          currentPassword: 'old-secret',
          newPassword: 'new-secret',
        },
        true,
      ],
    ] as const) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        schemaVersion: 1,
        receiptId: body.clientRequestId,
        reauthenticationRequired,
      });
    }
  });
});

test('unknown clients, extra fields, and replay failures use bounded exact errors', async () => {
  const store: AuthStore = {
    ...successStore(),
    async authenticatePassword() {
      throw new Error('must not authenticate a forbidden client');
    },
    async rotateRefreshToken() {
      return { ok: false, code: 'TOKEN_REUSED' };
    },
  };
  await withGateway(store, async (baseUrl) => {
    const forbidden = await fetch(`${baseUrl}/v1/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'unknown',
        organization: 'acme',
        user: 'alice@example.test',
        password: 'secret',
      }),
    });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await forbidden.json(), { error: { code: 'CLIENT_FORBIDDEN' } });

    const extra = await fetch(`${baseUrl}/v1/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'e-mate-desktop',
        organization: 'acme',
        user: 'alice@example.test',
        password: 'secret',
        debug: true,
      }),
    });
    assert.equal(extra.status, 400);
    assert.deepEqual(await extra.json(), { error: { code: 'INVALID_REQUEST' } });

    const replay = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'e-mate-desktop', refreshToken, refreshRequestId: 'request-1' }),
    });
    assert.equal(replay.status, 401);
    assert.deepEqual(await replay.json(), { error: { code: 'TOKEN_REUSED' } });
  });
});

test('SSO and password reset are explicitly unavailable without an IdP', async () => {
  await withGateway(successStore(), async (baseUrl) => {
    const responses = await Promise.all(
      (
        [
          ['GET', '/v1/auth/authorize'],
          ['POST', '/v1/auth/sso/exchange'],
          ['POST', '/v1/auth/password/reset'],
        ] as const
      ).map(async ([method, path]) => {
        const response = await fetch(`${baseUrl}${path}`, { method });
        return { status: response.status, body: await response.json() };
      })
    );
    assert.deepEqual(
      responses,
      Array.from({ length: 3 }, () => ({ status: 501, body: { error: { code: 'FEATURE_UNAVAILABLE' } } }))
    );
  });
});

test('internal errors never echo password or token material', async () => {
  const store: AuthStore = {
    ...successStore(),
    async authenticatePassword() {
      throw new Error('secret password database failure');
    },
    async rotateRefreshToken() {
      throw new Error(refreshToken);
    },
  };
  await withGateway(store, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'e-mate-desktop',
        organization: 'acme',
        user: 'alice@example.test',
        password: 'secret',
      }),
    });
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.equal(body, JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }));
    assert.equal(body.includes('secret'), false);
  });
});
