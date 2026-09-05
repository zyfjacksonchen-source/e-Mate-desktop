import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCaptchaPng } from './captcha.ts';
import { verifyPassword, type AuthIdentity } from './crypto.ts';
import type { AuthStore, AuthenticationResult } from './types.ts';

const clientIdPattern = /^[A-Za-z0-9._-]{1,128}$/;
const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const refreshTokenPattern = /^emate_rt_[A-Za-z0-9_-]{43}$/;

export type EnterpriseAuthSession = {
  schemaVersion: 1;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  identity: {
    tenantId: string;
    userId: string;
    displayName: string;
    roles: string[];
    weeklyTokenLimit: number;
  };
  modelGateway: {
    baseUrl: string;
    sessionToken: string;
    expiresAt: string;
    usageKeyId: string;
    usagePublicKey: string;
    allowedModelIds: string[];
  };
};

export type SessionIssuer = (
  identity: AuthIdentity,
  sessionId: string,
  refreshToken: string,
  now?: number
) => EnterpriseAuthSession;

export type AuthGatewayServerOptions = {
  store: AuthStore;
  issueSession: SessionIssuer;
  organizations: ReadonlyMap<string, string>;
  allowedClientIds: ReadonlySet<string>;
  now?: () => number;
  maximumRequestsPerMinute?: number;
};

type JsonObject = Record<string, unknown>;

function normalizedOrganization(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function record(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function exactFields(value: JsonObject, fields: readonly string[]): boolean {
  const actual = Object.keys(value);
  const allowed = new Set(fields);
  return actual.length === fields.length && actual.every((field) => allowed.has(field));
}

async function readJson(request: IncomingMessage): Promise<JsonObject | null> {
  if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return null;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > 16_384) return null;
    chunks.push(bytes);
  }
  if (length === 0) return null;
  try {
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    return null;
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': String(body.byteLength),
    'content-type': 'application/json; charset=utf-8',
    'strict-transport-security': 'max-age=31536000',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function failure(response: ServerResponse, result: Extract<AuthenticationResult, { ok: false }>): void {
  const status = ['CLIENT_FORBIDDEN', 'APPROVAL_REQUIRED', 'POLICY_REQUIRED'].includes(result.code) ? 403 : 401;
  json(response, status, { error: { code: result.code } });
}

class FixedWindowRateLimiter {
  readonly #entries = new Map<string, { window: number; count: number }>();
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  allowed(key: string, now: number): boolean {
    const window = Math.floor(now / 60_000);
    const current = this.#entries.get(key);
    if (!current || current.window !== window) {
      this.#entries.set(key, { window, count: 1 });
      if (this.#entries.size > 10_000) {
        for (const [entryKey, entry] of this.#entries) {
          if (entry.window < window) this.#entries.delete(entryKey);
        }
      }
      return true;
    }
    current.count += 1;
    return current.count <= this.#limit;
  }
}

export function createAuthGatewayHandler(options: AuthGatewayServerOptions) {
  const now = options.now ?? Date.now;
  const limiter = new FixedWindowRateLimiter(options.maximumRequestsPerMinute ?? 30);
  if (options.organizations.size < 1 || options.allowedClientIds.size < 1) {
    throw new Error('Auth Gateway tenant and client policy must not be empty');
  }

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const path = new URL(request.url ?? '/', 'https://auth.invalid').pathname;
      if (request.method === 'GET' && path === '/healthz') {
        json(response, 200, { status: 'ok' });
        return;
      }
      if (path === '/v1/auth/authorize' || path === '/v1/auth/sso/exchange' || path === '/v1/auth/password/reset') {
        json(response, 501, { error: { code: 'FEATURE_UNAVAILABLE' } });
        return;
      }
      const postPaths = new Set([
        '/v1/auth/password',
        '/v1/auth/refresh',
        '/v1/auth/registration/challenge',
        '/v1/auth/register',
        '/v1/auth/logout',
        '/v1/auth/password/change',
      ]);
      if (request.method !== 'POST' || !postPaths.has(path)) {
        json(response, 404, { error: { code: 'NOT_FOUND' } });
        return;
      }
      const remoteAddress = request.socket.remoteAddress ?? 'unknown';
      if (!limiter.allowed(remoteAddress, now())) {
        json(response, 429, { error: { code: 'RATE_LIMITED' } });
        return;
      }
      const input = await readJson(request);
      if (!input) {
        json(response, 400, { error: { code: 'INVALID_REQUEST' } });
        return;
      }
      if (path === '/v1/auth/registration/challenge') {
        if (
          !exactFields(input, ['clientId']) ||
          typeof input.clientId !== 'string' ||
          !clientIdPattern.test(input.clientId)
        ) {
          json(response, 400, { error: { code: 'INVALID_REQUEST' } });
          return;
        }
        if (!options.allowedClientIds.has(input.clientId)) {
          json(response, 403, { error: { code: 'CLIENT_FORBIDDEN' } });
          return;
        }
        const challenge = await options.store.issueRegistrationChallenge();
        const image = createCaptchaPng(challenge.code, randomBytes(64));
        json(response, 200, {
          schemaVersion: 1,
          challengeId: challenge.challengeId,
          imageDataUrl: `data:image/png;base64,${image.toString('base64')}`,
          expiresAt: challenge.expiresAt.toISOString(),
        });
        return;
      }
      if (path === '/v1/auth/register') {
        if (
          !exactFields(input, [
            'clientId',
            'organization',
            'account',
            'realName',
            'password',
            'challengeId',
            'verificationCode',
          ]) ||
          typeof input.clientId !== 'string' ||
          !clientIdPattern.test(input.clientId) ||
          typeof input.organization !== 'string' ||
          !input.organization.trim() ||
          input.organization.length > 160 ||
          typeof input.account !== 'string' ||
          !input.account.trim() ||
          input.account.length > 320 ||
          typeof input.realName !== 'string' ||
          input.realName.normalize('NFKC').trim().length < 2 ||
          input.realName.length > 120 ||
          typeof input.password !== 'string' ||
          input.password.length < 8 ||
          input.password.length > 1_024 ||
          typeof input.challengeId !== 'string' ||
          !requestIdPattern.test(input.challengeId) ||
          typeof input.verificationCode !== 'string' ||
          !/^\d{6}$/.test(input.verificationCode)
        ) {
          json(response, 400, { error: { code: 'INVALID_REQUEST' } });
          return;
        }
        if (!options.allowedClientIds.has(input.clientId)) {
          json(response, 403, { error: { code: 'CLIENT_FORBIDDEN' } });
          return;
        }
        const tenantId = options.organizations.get(normalizedOrganization(input.organization));
        if (!tenantId) {
          json(response, 401, { error: { code: 'INVALID_GRANT' } });
          return;
        }
        const result = await options.store.register({
          tenantId,
          account: input.account,
          realName: input.realName,
          password: input.password,
          challengeId: input.challengeId,
          verificationCode: input.verificationCode,
        });
        if (!result.ok) {
          json(response, result.code === 'ACCOUNT_EXISTS' ? 409 : 400, { error: { code: result.code } });
          return;
        }
        json(response, 201, { schemaVersion: 1, registrationId: result.registrationId, status: 'PENDING_APPROVAL' });
        return;
      }
      if (path === '/v1/auth/password') {
        if (
          !exactFields(input, ['clientId', 'organization', 'user', 'password', ...(input.clientVersion === undefined ? [] : ['clientVersion'])]) ||
          (input.clientVersion !== undefined && (typeof input.clientVersion !== 'string' || !/^2\.0\.(?:1[2-8])$/.test(input.clientVersion))) ||
          typeof input.clientId !== 'string' ||
          !clientIdPattern.test(input.clientId) ||
          typeof input.organization !== 'string' ||
          !input.organization.trim() ||
          input.organization.length > 160 ||
          typeof input.user !== 'string' ||
          !input.user.trim() ||
          input.user.length > 320 ||
          typeof input.password !== 'string' ||
          !input.password ||
          input.password.length > 1_024
        ) {
          json(response, 400, { error: { code: 'INVALID_REQUEST' } });
          return;
        }
        if (!options.allowedClientIds.has(input.clientId)) {
          json(response, 403, { error: { code: 'CLIENT_FORBIDDEN' } });
          return;
        }
        const tenantId = options.organizations.get(normalizedOrganization(input.organization));
        if (!tenantId) {
          await verifyPassword(input.password);
          json(response, 401, { error: { code: 'INVALID_GRANT' } });
          return;
        }
        const result = await options.store.authenticatePassword({
          tenantId,
          clientId: input.clientId,
          user: input.user,
          password: input.password,
          ...(typeof input.clientVersion === 'string' ? { clientVersion: input.clientVersion } : {}),
        });
        if (!result.ok) {
          failure(response, result);
          return;
        }
        json(response, 200, options.issueSession(result.identity, result.sessionId, result.refreshToken, now()));
        return;
      }

      if (path === '/v1/auth/logout' || path === '/v1/auth/password/change') {
        const passwordChange = path === '/v1/auth/password/change';
        const fields = passwordChange
          ? ['clientId', 'refreshToken', 'clientRequestId', 'currentPassword', 'newPassword']
          : ['clientId', 'refreshToken', 'clientRequestId'];
        if (
          !exactFields(input, fields) ||
          typeof input.clientId !== 'string' ||
          !clientIdPattern.test(input.clientId) ||
          typeof input.refreshToken !== 'string' ||
          !refreshTokenPattern.test(input.refreshToken) ||
          typeof input.clientRequestId !== 'string' ||
          !requestIdPattern.test(input.clientRequestId) ||
          (passwordChange &&
            (typeof input.currentPassword !== 'string' ||
              !input.currentPassword ||
              input.currentPassword.length > 1_024 ||
              typeof input.newPassword !== 'string' ||
              input.newPassword.length < 8 ||
              input.newPassword.length > 1_024 ||
              input.newPassword === input.currentPassword))
        ) {
          json(response, 400, { error: { code: 'INVALID_REQUEST' } });
          return;
        }
        if (!options.allowedClientIds.has(input.clientId)) {
          json(response, 403, { error: { code: 'CLIENT_FORBIDDEN' } });
          return;
        }
        const result = passwordChange
          ? await options.store.changePassword({
              clientId: input.clientId,
              refreshToken: input.refreshToken,
              clientRequestId: input.clientRequestId,
              currentPassword: input.currentPassword as string,
              newPassword: input.newPassword as string,
            })
          : await options.store.logout({
              clientId: input.clientId,
              refreshToken: input.refreshToken,
              clientRequestId: input.clientRequestId,
            });
        if (!result.ok) {
          failure(response, result);
          return;
        }
        json(response, 200, { schemaVersion: 1, receiptId: result.receiptId, reauthenticationRequired: passwordChange });
        return;
      }

      if (
        !exactFields(input, ['clientId', 'refreshToken', 'refreshRequestId', ...(input.clientVersion === undefined ? [] : ['clientVersion'])]) ||
        (input.clientVersion !== undefined && (typeof input.clientVersion !== 'string' || !/^2\.0\.(?:1[2-8])$/.test(input.clientVersion))) ||
        typeof input.clientId !== 'string' ||
        !clientIdPattern.test(input.clientId) ||
        typeof input.refreshToken !== 'string' ||
        !refreshTokenPattern.test(input.refreshToken) ||
        typeof input.refreshRequestId !== 'string' ||
        !requestIdPattern.test(input.refreshRequestId)
      ) {
        json(response, 400, { error: { code: 'INVALID_REQUEST' } });
        return;
      }
      if (!options.allowedClientIds.has(input.clientId)) {
        json(response, 403, { error: { code: 'CLIENT_FORBIDDEN' } });
        return;
      }
      const result = await options.store.rotateRefreshToken({
        clientId: input.clientId,
        refreshToken: input.refreshToken,
        refreshRequestId: input.refreshRequestId,
        ...(typeof input.clientVersion === 'string' ? { clientVersion: input.clientVersion } : {}),
      });
      if (!result.ok) {
        failure(response, result);
        return;
      }
      json(response, 200, options.issueSession(result.identity, result.sessionId, result.refreshToken, now()));
    } catch {
      if (!response.headersSent && !response.destroyed) {
        json(response, 500, { error: { code: 'INTERNAL_ERROR' } });
      } else if (!response.destroyed) {
        response.destroy();
      }
    }
  };
}
