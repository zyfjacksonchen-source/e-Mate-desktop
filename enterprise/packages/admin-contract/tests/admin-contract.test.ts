import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAdminApiKeyCreate,
  parseAdminApiKeyCreationResult,
  parseAdminApiKeyList,
  parseAdminModelRouteKeyUpdate,
  parseAdminModelRoutePublication,
  parseAdminModelRouteUpdate,
  parseAdminPasswordReset,
  parseAdminConsentList,
  parseAdminConsentQuery,
  parseConsentAcceptanceInput,
  parseConsentStatus,
  parseTenantUser,
  parseTenantUserCreate,
  parseTenantUserDelete,
  parseTenantUserUpdate,
  isDefaultEnabledModelRoute,
  modelSupportsClient,
} from '../src/index.ts';

const consentPolicy = {
  schemaVersion: 1,
  agreementId: 'e-mate-platform-terms',
  agreementVersion: '1.0.0',
  disclaimerVersion: '1.0.0',
  contentHash: 'a'.repeat(64),
} as const;

test('Astra is an explicit 2.0.18 capability and leaves the default model set unchanged', () => {
  assert.equal(isDefaultEnabledModelRoute('gpt-6-astra'), false);
  for (const version of [undefined, '2.0.12', '2.0.17']) {
    assert.equal(modelSupportsClient('gpt-6-astra', version), false);
    assert.equal(modelSupportsClient('gpt-5.6-sol', version), true);
  }
  assert.equal(modelSupportsClient('gpt-6-astra', '2.0.18'), true);
});

test('admin request contracts reject caller-controlled tenant fields and privilege-shaped roles', () => {
  assert.deepEqual(
    parseTenantUserCreate({
      schemaVersion: 1,
      userId: 'user-1',
      displayName: 'Employee',
      roles: ['MEMBER'],
      tokenLimit: 50_000,
      allowedModelIds: ['gpt-5.6-sol'],
      initialPassword: 'InitialPass-2026!',
    }),
    {
      schemaVersion: 1,
      userId: 'user-1',
      displayName: 'Employee',
      roles: ['MEMBER'],
      tokenLimit: 50_000,
      allowedModelIds: ['gpt-5.6-sol'],
      initialPassword: 'InitialPass-2026!',
    }
  );
  assert.throws(
    () =>
      parseTenantUserCreate({
        schemaVersion: 1,
        tenantId: 'tenant-2',
        userId: 'user-1',
        displayName: 'Employee',
        roles: ['MEMBER'],
        tokenLimit: 50_000,
        allowedModelIds: ['gpt-5.6-sol'],
        initialPassword: 'InitialPass-2026!',
      }),
    /fields/
  );
  assert.throws(
    () =>
      parseTenantUserCreate({
        schemaVersion: 1,
        userId: 'user-1',
        displayName: 'Employee',
        roles: ['SUPER_ADMIN'],
        tokenLimit: 50_000,
        allowedModelIds: ['gpt-5.6-sol'],
        initialPassword: 'InitialPass-2026!',
      }),
    /roles/
  );
});

test('user token limits are explicit and deleted is a read-only terminal status', () => {
  const user = {
    schemaVersion: 1,
    userId: 'user-1',
    displayName: 'Employee',
    roles: ['MEMBER'],
    status: 'DELETED',
    tokenLimit: Number.MAX_SAFE_INTEGER,
    allowedModelIds: ['gpt-5.6-sol'],
    createdAt: '2026-07-30T10:00:00.000Z',
    updatedAt: '2026-07-31T10:00:00.000Z',
  };
  assert.equal(parseTenantUser(user).status, 'DELETED');
  assert.equal(
    parseTenantUserUpdate({
      schemaVersion: 1,
      displayName: 'Employee',
      roles: ['MEMBER'],
      status: 'ACTIVE',
      tokenLimit: 1,
      allowedModelIds: ['gpt-5.6-sol'],
      expectedUpdatedAt: user.updatedAt,
    }).tokenLimit,
    1
  );
  assert.equal(
    parseTenantUserUpdate({
      schemaVersion: 1,
      displayName: 'Employee',
      roles: ['MEMBER'],
      status: 'ACTIVE',
      tokenLimit: null,
      allowedModelIds: ['gpt-5.6-sol'],
      expectedUpdatedAt: user.updatedAt,
    }).tokenLimit,
    null
  );
  assert.throws(
    () =>
      parseTenantUserUpdate({
        schemaVersion: 1,
        displayName: 'Employee',
        roles: ['MEMBER'],
        status: 'DELETED',
        tokenLimit: null,
        allowedModelIds: [],
        expectedUpdatedAt: user.updatedAt,
      }),
    /status/
  );
  assert.deepEqual(parseTenantUserDelete({ schemaVersion: 1, expectedUpdatedAt: user.updatedAt }), {
    schemaVersion: 1,
    expectedUpdatedAt: user.updatedAt,
  });
  assert.throws(
    () =>
      parseTenantUserCreate({
        schemaVersion: 1,
        userId: 'user-2',
        displayName: 'Employee',
        roles: ['MEMBER'],
        tokenLimit: 0,
        allowedModelIds: ['gpt-5.6-sol'],
        initialPassword: 'InitialPass-2026!',
      }),
    /token limit/
  );
  assert.throws(
    () =>
      parseTenantUserCreate({
        schemaVersion: 1,
        userId: 'user-2',
        displayName: 'Employee',
        roles: ['MEMBER'],
        tokenLimit: Number.MAX_SAFE_INTEGER + 1,
        allowedModelIds: ['gpt-5.6-sol'],
        initialPassword: 'InitialPass-2026!',
      }),
    /token limit/
  );
});

test('administrator password inputs are strict and never accept weak or extra fields', () => {
  assert.deepEqual(parseAdminPasswordReset({ schemaVersion: 1, password: 'Replacement-2026!' }), {
    schemaVersion: 1,
    password: 'Replacement-2026!',
  });
  assert.throws(() => parseAdminPasswordReset({ schemaVersion: 1, password: 'short' }), /password/);
  assert.throws(
    () => parseAdminPasswordReset({ schemaVersion: 1, password: 'Replacement-2026!', userId: 'user-1' }),
    /fields/
  );
});

test('new credentials are model-only while legacy task metadata remains readable', () => {
  assert.deepEqual(
    parseAdminApiKeyCreate({
      schemaVersion: 1,
      label: 'Laptop',
      principalType: 'USER',
      principalId: 'user-1',
      userId: 'user-1',
      scopes: ['models:invoke'],
    }).scopes,
    ['models:invoke']
  );
  assert.throws(
    () =>
      parseAdminApiKeyCreate({
        schemaVersion: 1,
        label: 'Retired task writer',
        principalType: 'USER',
        principalId: 'user-1',
        userId: 'user-1',
        scopes: ['task-events:write'],
      }),
    /scopes/
  );
  assert.throws(
    () =>
      parseAdminApiKeyCreate({
        schemaVersion: 1,
        label: 'Retired combined writer',
        principalType: 'USER',
        principalId: 'user-1',
        userId: 'user-1',
        scopes: ['models:invoke', 'task-events:write'],
      }),
    /scopes/
  );
  assert.throws(
    () =>
      parseAdminApiKeyCreate({
        schemaVersion: 1,
        label: 'Bad',
        principalType: 'USER',
        principalId: 'user-2',
        userId: 'user-1',
        scopes: ['models:invoke'],
      }),
    /must match/
  );
  assert.throws(
    () =>
      parseAdminApiKeyCreate({
        schemaVersion: 1,
        label: 'Broad',
        principalType: 'DEVICE',
        principalId: 'device-1',
        userId: 'user-1',
        scopes: ['admin:write'],
      }),
    /scopes/
  );
  assert.throws(
    () =>
      parseAdminApiKeyCreate({
        schemaVersion: 1,
        label: 'Broad device',
        principalType: 'DEVICE',
        principalId: 'device-1',
        userId: 'user-1',
        scopes: ['models:invoke'],
      }),
    /user-bound/
  );
});

test('one-time key responses require the issued secret shape', () => {
  const value = {
    schemaVersion: 1,
    key: {
      schemaVersion: 1,
      keyId: 'key-1',
      label: 'Laptop',
      principalType: 'USER',
      principalId: 'user-1',
      userId: 'user-1',
      scopes: ['models:invoke'],
      createdAt: '2026-07-30T10:00:00.000Z',
      lastUsedAt: null,
      revokedAt: null,
    },
    secret: `emate_twe_${'a'.repeat(43)}`,
  };
  assert.equal(parseAdminApiKeyCreationResult(value).secret, value.secret);
  assert.throws(() => parseAdminApiKeyCreationResult({ ...value, secret: 'plaintext' }), /creation result/);
});

test('legacy task scopes are accepted only as revoked history', () => {
  const key = {
    schemaVersion: 1,
    keyId: 'key-legacy',
    label: 'Legacy task writer',
    principalType: 'DEVICE',
    principalId: 'device-1',
    userId: 'user-1',
    scopes: ['task-events:write'],
    createdAt: '2026-07-30T10:00:00.000Z',
    lastUsedAt: null,
    revokedAt: '2026-08-25T00:00:00.000Z',
  };
  const combined = {
    ...key,
    keyId: 'key-combined',
    principalType: 'USER',
    principalId: 'user-1',
    scopes: ['task-events:write', 'models:invoke'],
  };
  assert.deepEqual(
    parseAdminApiKeyList({ schemaVersion: 1, keys: [key, combined] }).keys.map(({ scopes }) => scopes),
    [['task-events:write'], ['task-events:write', 'models:invoke']]
  );
  assert.throws(
    () => parseAdminApiKeyList({ schemaVersion: 1, keys: [{ ...key, revokedAt: null }] }),
    /must be revoked/
  );
  assert.throws(
    () => parseAdminApiKeyList({ schemaVersion: 1, keys: [{ ...combined, revokedAt: null }] }),
    /must be revoked/
  );
});

test('model route updates accept only a boolean enablement policy', () => {
  assert.deepEqual(parseAdminModelRouteUpdate({ schemaVersion: 1, enabled: false }), {
    schemaVersion: 1,
    enabled: false,
  });
  assert.throws(
    () => parseAdminModelRouteUpdate({ schemaVersion: 1, enabled: true, upstreamApiKey: 'secret' }),
    /fields/
  );
});

test('model catalog publication accepts only an explicit boolean', () => {
  assert.deepEqual(parseAdminModelRoutePublication({ schemaVersion: 1, published: false }), {
    schemaVersion: 1,
    published: false,
  });
  assert.throws(
    () => parseAdminModelRoutePublication({ schemaVersion: 1, published: false, routeId: 'gpt-5.6-sol' }),
    /fields/
  );
});

test('consent acceptance requires the exact policy tuple and all three confirmations', () => {
  const input = {
    ...consentPolicy,
    termsAccepted: true,
    policyRead: true,
    lawfulUseConfirmed: true,
    clientVersion: '2.1.45',
    locale: 'zh-CN',
  } as const;
  assert.deepEqual(parseConsentAcceptanceInput(input), input);
  assert.throws(() => parseConsentAcceptanceInput({ ...input, userId: 'user-2' }), /fields/);
  assert.throws(() => parseConsentAcceptanceInput({ ...input, policyRead: false }), /confirmations/);
  assert.throws(() => parseConsentAcceptanceInput({ ...input, contentHash: 'not-a-hash' }), /content hash/);
});

test('consent status and admin filters remain bounded and contain no agreement body', () => {
  const acceptance = {
    ...consentPolicy,
    acceptanceId: 'acceptance-1',
    userId: 'user-1',
    acceptedAt: '2026-08-02T01:02:03.000Z',
    clientVersion: '2.1.45',
    locale: 'zh-CN',
  };
  assert.deepEqual(
    parseConsentStatus({ schemaVersion: 1, policy: consentPolicy, required: false, acceptance }).acceptance,
    acceptance
  );
  assert.throws(
    () => parseConsentStatus({ schemaVersion: 1, policy: consentPolicy, required: true, acceptance }),
    /status state/
  );
  assert.throws(
    () =>
      parseConsentStatus({
        schemaVersion: 1,
        policy: consentPolicy,
        required: false,
        acceptance: { ...acceptance, disclaimerVersion: '0.9.0' },
      }),
    /status policy/
  );
  assert.deepEqual(
    parseAdminConsentQuery({
      userId: 'user-1',
      agreementVersion: '1.0.0',
      disclaimerVersion: '1.0.0',
      acceptedFrom: '2026-08-01T00:00:00.000Z',
      acceptedTo: '2026-08-03T00:00:00.000Z',
      limit: 25,
    }).limit,
    25
  );
  assert.throws(() => parseAdminConsentQuery({ limit: 201 }), /limit/);
  assert.throws(
    () =>
      parseAdminConsentQuery({
        acceptedFrom: '2026-08-03T00:00:00.000Z',
        acceptedTo: '2026-08-01T00:00:00.000Z',
      }),
    /range/
  );
  assert.equal(parseAdminConsentList({ schemaVersion: 1, acceptances: [acceptance] }).acceptances.length, 1);
  assert.throws(
    () => parseAdminConsentList({ schemaVersion: 1, acceptances: [{ ...acceptance, userTerms: 'body' }] }),
    /fields/
  );
});

test('model route key updates accept a write-only provider key', () => {
  const apiKey = 'provider-key-that-is-long-enough';
  assert.deepEqual(parseAdminModelRouteKeyUpdate({ schemaVersion: 1, apiKey }), {
    schemaVersion: 1,
    apiKey,
  });
  assert.throws(() => parseAdminModelRouteKeyUpdate({ schemaVersion: 1, apiKey: 'short' }), /Invalid/);
  assert.throws(() => parseAdminModelRouteKeyUpdate({ schemaVersion: 1, apiKey, routeId: 'injected' }), /fields/);
});

test('only the five production routes are enabled before an explicit tenant decision', () => {
  assert.equal(isDefaultEnabledModelRoute('gpt-5.6-luna'), true);
  assert.equal(isDefaultEnabledModelRoute('gpt-5.6-sol'), true);
  assert.equal(isDefaultEnabledModelRoute('gemini-3.1-pro-high'), false);
  assert.equal(isDefaultEnabledModelRoute('deepseek'), true);
  assert.equal(isDefaultEnabledModelRoute('doubao-seed-2-0-pro-260215'), false);
  assert.equal(isDefaultEnabledModelRoute('gpt-image-2.5-flare'), true);
  assert.equal(isDefaultEnabledModelRoute('gpt-5.6-enterprise'), false);
});

test('retired Doubao is excluded from every client version including current releases', () => {
  for (const version of [undefined, '2.0.16', '2.0.17', '2.0.18', '2.0.19']) assert.equal(modelSupportsClient('doubao-seed-2-0-pro-260215', version), false);
});

test('retired image routes cannot be re-enabled through an old catalog or client', () => {
  for (const id of ['gpt-image-2-pro', 'gpt-image-2']) {
    assert.equal(isDefaultEnabledModelRoute(id), false);
    for (const version of [undefined, '2.0.16', '2.0.18']) assert.equal(modelSupportsClient(id, version), false);
  }
  assert.equal(isDefaultEnabledModelRoute('gpt-image-2.5-flare'), true);
  assert.equal(modelSupportsClient('gpt-image-2.5-flare', '2.0.18'), true);
});
