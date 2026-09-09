import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ADMIN_MODEL_SESSION_KEY,
  ADMIN_TOKEN_SESSION_KEY,
  AdminApiError,
  abbreviateAuditValue,
  createTenantUser,
  deleteTenantUser,
  issueApiKey,
  loginAdmin,
  loadApiKeys,
  loadModelFastMode,
  loadModelRoutes,
  updateModelFastMode,
  loadConsentAcceptances,
  requestAdmin,
  resetTenantUserPassword,
  quotaTokens,
  formatTokenCount,
  readAdminModelSession,
  resolveModelGatewayPath,
  resolveSameOriginPath,
  resolveUsageDashboardPath,
  testModelConnection,
  updateModelRouteKey,
  updateTenantUser,
} from '../src/api.ts';
import { messagesFor } from '../src/i18n.ts';

const origin = 'https://admin.example.test';

test('model routes display Astra first and preserve unknown order and route policies', async () => {
  const ids = ['custom-z', 'gpt-image-2.5-flare', 'gpt-5.6-luna', 'custom-a', 'deepseek',
    'gpt-6-astra', 'doubao-seed-2-0-pro-260215', 'gpt-5.6-sol'];
  const routes = ids.map((routeId, index) => ({
    schemaVersion: 1, routeId, label: routeId, provider: 'test',
    published: index % 2 === 0, enabled: index % 3 === 0, updatedAt: null,
    keyConfigured: index % 2 === 1, keyUpdatedAt: index % 2 === 1 ? '2026-09-01T00:00:00.000Z' : null,
  }));
  const original = structuredClone(routes);
  const result = await loadModelRoutes('admin', new AbortController().signal, {
    origin,
    fetcher: async (url, init) => {
      assert.equal(String(url), '/v1/admin/model-routes');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer admin');
      return new Response(JSON.stringify({ schemaVersion: 1, routes }), { status: 200 });
    },
  });
  const expectedIds = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'deepseek',
    'gpt-image-2.5-flare', 'custom-z', 'custom-a'];
  assert.deepEqual(result, {
    schemaVersion: 1,
    routes: expectedIds.map(id => original.find(route => route.routeId === id)),
  });
  assert.deepEqual(routes, original);
});

test('fast mode saves one authenticated batch and reads the authoritative revision', async () => {
  const state = { schemaVersion: 1 as const, revision: 'a'.repeat(64), enabledModelIds: ['gpt-5.6-luna' as const] };
  const requests: RequestInit[] = [];
  const options = { origin, fetcher: (async (url, init) => {
    assert.equal(new URL(String(url), origin).pathname, '/v1/admin/model-fast-mode');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer admin');
    requests.push(init ?? {});
    return new Response(JSON.stringify(state), { status: 200 });
  }) as typeof fetch };
  assert.deepEqual(await loadModelFastMode('admin', new AbortController().signal, options), state);
  const update = { schemaVersion: 1 as const, expectedRevision: state.revision, modelIds: ['gpt-5.6-luna' as const], enabled: true };
  assert.deepEqual(await updateModelFastMode('admin', new AbortController().signal, options, update), state);
  assert.equal(requests[1]?.method, 'PUT');
  assert.deepEqual(JSON.parse(String(requests[1]?.body)), update);
});

test('admin login reuses the e-Mate dark component theme and logo treatment', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /VITE_AUTH_ORGANIZATION/);
  assert.doesNotMatch(app, /admin-organization/);
  assert.match(readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8'), /setAttribute\('arco-theme'/);
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /width: min\(100%, 360px\)/);
  assert.match(css, /filter: invert\(1\) hue-rotate\(180deg\)/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.admin-shell\s*{\s*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.admin-tabs,[\s\S]*?overflow: hidden/);
  assert.match(app, /agreementExempt\(user\.roles\)[\s\S]*?copy\.consentExempt/);
  assert.equal(messagesFor('zh-CN').consentExempt, '管理员免签');
});

test('user administration filters approval state and reuses the existing batch policy flow', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  const copy = messagesFor('zh-CN');
  assert.equal(copy.activeUsers, '有效账户');
  assert.doesNotMatch(copy.source, /Runtime Registry/);
  assert.equal(copy.active, '有效');
  assert.equal(copy.pendingApproval, '待审批');
  assert.equal(copy.approveAllPending, '全选当前筛选内待审批并配置模型');
  assert.equal(copy.selectAllModels, '全选可用模型');
  assert.match(app, /userStatusFilter === 'ALL' \? user\.status !== 'DELETED' : user\.status === userStatusFilter/);
  assert.match(app, /openPolicy\(pendingFilteredUsers, true\)/);
  assert.match(
    app,
    /title=\{policyApprovePending \? copy\.batchApprove : copy\.updateTokenLimit\}[\s\S]*?copy\.selectAllModels/
  );
  assert.doesNotMatch(app, /fetch\([^\n]*approveAllPending/);
  assert.doesNotMatch(app, /runtime\/status|RuntimeRegistry/);
  assert.doesNotMatch(vite, /runtime\/status/);
});

test('credential UI issues only user model access and labels retired task credentials', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const copy = messagesFor('zh-CN');
  assert.match(app, /principalType: 'USER',[\s\S]*scopes: \['models:invoke'\]/u);
  assert.match(app, /scopes\.includes\('task-events:write'\) \? copy\.legacyTaskCredential/u);
  assert.doesNotMatch(app, /TASKS_ONLY|MODELS_AND_TASKS/u);
  assert.equal(copy.legacyTaskCredential, '旧任务同步凭据（已停用）');
});

test('admin API paths must stay on the console origin', () => {
  assert.equal(
    resolveSameOriginPath('/e-mate/enterprise-api/', '/v1/admin/users', origin),
    '/e-mate/enterprise-api/v1/admin/users'
  );
  assert.throws(
    () => resolveSameOriginPath('https://attacker.example/runtime', '/v1/admin/users', origin),
    /must share/
  );
});

test('central Admin requests reject non-management paths before fetch', async () => {
  const calls: string[] = [];
  const options = {
    origin,
    fetcher: async (input: URL | RequestInfo) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ schemaVersion: 1 }), { status: 200 });
    },
  };
  const signal = new AbortController().signal;

  await requestAdmin('admin-token', signal, options, '/v1/admin/users?limit=1');
  assert.deepEqual(calls, ['/v1/admin/users?limit=1']);
  calls.length = 0;

  for (const path of [
    '/v1/responses',
    ['/v1/', 'responses'].join(''),
    '/v1/admin/../responses',
    '/v1/admin/%2e%2e/responses',
    'https://attacker.example/v1/admin/users',
    '//attacker.example/v1/admin/users',
    '/v1/admin/users#fragment',
    '/v1/administer',
  ]) {
    await assert.rejects(
      () => requestAdmin('admin-token', signal, options, path),
      /not allowlisted/u
    );
  }
  assert.deepEqual(calls, []);
});

test('usage links are emitted only for same-origin deployments', () => {
  assert.equal(resolveUsageDashboardPath('/e-mate/usage/', origin), '/e-mate/usage/');
  assert.equal(resolveUsageDashboardPath(undefined, origin), null);
  assert.throws(() => resolveUsageDashboardPath('https://attacker.example/usage', origin), /must share/);
  const productionEnvironment = readFileSync(new URL('../.env.production', import.meta.url), 'utf8');
  assert.match(productionEnvironment, /^VITE_ADMIN_API_BASE=\/e-mate\/enterprise-api\/$/m);
  assert.match(productionEnvironment, /^VITE_AUTH_API_BASE=\/e-mate\/auth-api\/$/m);
  assert.match(productionEnvironment, /^VITE_AUTH_CLIENT_ID=e-mate-admin$/m);
  assert.match(productionEnvironment, /^VITE_AUTH_ORGANIZATION=emate-v2$/m);
  assert.match(productionEnvironment, /^VITE_USAGE_DASHBOARD_PATH=\/ecorex-agent\/usage-panel\/$/m);
});

test('admin access and the bounded model lease use separate tab-scoped session keys', () => {
  assert.equal(ADMIN_TOKEN_SESSION_KEY, 'e-mate.admin.access-token');
  assert.equal(ADMIN_MODEL_SESSION_KEY, 'e-mate.admin.model-session');
  assert.notEqual(ADMIN_MODEL_SESSION_KEY, ADMIN_TOKEN_SESSION_KEY);
  assert.notEqual(ADMIN_TOKEN_SESSION_KEY, 'e-mate.usage.read-token');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /readAdminModelSession\(sessionStorage\.getItem\(ADMIN_MODEL_SESSION_KEY\)\)/u);
  assert.match(app, /sessionStorage\.setItem\(ADMIN_MODEL_SESSION_KEY, JSON\.stringify\(session\.modelGateway\)\)/u);
  assert.match(app, /const signOut = \(\) => \{[\s\S]*?removeItem\(ADMIN_MODEL_SESSION_KEY\)/u);
});

test('quota units produce exact integer tokens and unlimited remains explicit', () => {
  assert.equal(quotaTokens(1.001, 'K', false), 1_001);
  assert.equal(quotaTokens(1.25, 'M', false), 1_250_000);
  assert.equal(quotaTokens(undefined, 'K', true), null);
  assert.equal(quotaTokens(0, 'K', false), undefined);
});

test('token displays use K and M above three digits', () => {
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1_000), '1K');
  assert.equal(formatTokenCount(1_250), '1.3K');
  assert.equal(formatTokenCount(1_000_000), '1M');
  assert.equal(formatTokenCount(1_250_000), '1.3M');
});

test('administrator password login reuses the same-origin Auth Gateway contract without persisting credentials', async () => {
  let call: { input: string; init?: RequestInit } | undefined;
  const accessToken = `header.${'a'.repeat(32)}.signature`;
  const modelSessionToken = `header.${'m'.repeat(32)}.signature`;
  const modelExpiry = new Date(Date.now() + 60_000).toISOString();
  const result = await loginAdmin(
    {
      authBase: '/ecorex-agent/auth-api/',
      clientId: 'e-mate-admin',
      organization: 'example',
      account: 'admin@example.test',
      password: 'not-recorded',
    },
    new AbortController().signal,
    {
      origin,
      fetcher: async (input, init) => {
        call = { input: String(input), init };
        return new Response(JSON.stringify({
          schemaVersion: 1,
          accessToken,
          modelGateway: {
            baseUrl: `${origin}/e-mate/model-api/`,
            sessionToken: modelSessionToken,
            expiresAt: modelExpiry,
            allowedModelIds: ['gpt-5.6-sol'],
          },
        }), { status: 200 });
      },
    }
  );
  assert.deepEqual(result, {
    accessToken,
    modelGateway: {
      basePath: '/e-mate/model-api/',
      sessionToken: modelSessionToken,
      expiresAt: modelExpiry,
      allowedModelIds: ['gpt-5.6-sol'],
    },
  });
  assert.equal(call?.input, '/ecorex-agent/auth-api/v1/auth/password');
  assert.equal(call?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(call?.init?.body)), {
    clientId: 'e-mate-admin',
    clientVersion: '2.0.18',
    organization: 'example',
    user: 'admin@example.test',
    password: 'not-recorded',
  });
  assert.equal(call?.input.includes('admin@example.test'), false);
  assert.equal(call?.input.includes('not-recorded'), false);
});

test('model Gateway receipts are limited to the exact authenticated same-origin route', () => {
  assert.equal(resolveModelGatewayPath('/e-mate/model-api/', origin), '/e-mate/model-api/');
  assert.throws(() => resolveModelGatewayPath('/e-mate/model-api/v1/', origin), /Invalid Model Gateway URL/u);
  assert.throws(() => resolveModelGatewayPath('https://attacker.example/e-mate/model-api/', origin), /Invalid Model Gateway URL/u);
  assert.equal(readAdminModelSession(JSON.stringify({
    basePath: '/e-mate/model-api/v1/',
    sessionToken: `header.${'m'.repeat(32)}.signature`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    allowedModelIds: ['gpt-5.6-sol'],
  })), null);
});

test('model connectivity uses the authenticated same-origin Model Gateway and a bounded text invocation', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const session = {
    basePath: '/e-mate/model-api/',
    sessionToken: `header.${'m'.repeat(32)}.signature`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    allowedModelIds: ['gpt-5.6-sol'],
  };
  assert.deepEqual(readAdminModelSession(JSON.stringify(session)), session);
  const responses = [
    new Response(JSON.stringify({
      schemaVersion: 1,
      models: [{ id: 'gpt-5.6-sol', capabilities: { imageGeneration: false } }],
    }), { headers: { 'content-type': 'application/json' } }),
    new Response(
      'data: {"type":"response.completed","response":{"id":"response-test"}}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    ),
  ];
  const result = await testModelConnection('gpt-5.6-sol', session, new AbortController().signal, {
    origin,
    fetcher: async (input, init) => {
      calls.push({ input: String(input), init });
      return responses.shift() as Response;
    },
  });
  assert.equal(result.method, 'live-inference');
  assert.deepEqual(calls.map(({ input }) => input), [
    '/e-mate/model-api/v1/models',
    '/e-mate/model-api/v1/responses',
  ]);
  assert.equal(new Headers(calls[1]?.init?.headers).get('authorization'), `Bearer ${session.sessionToken}`);
  assert.equal(new Headers(calls[0]?.init?.headers).get('x-e-mate-client-version'), '2.0.18');
  assert.equal(calls.some(({ input }) => input.includes(session.sessionToken)), false);
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    model: 'gpt-5.6-sol',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with OK.' }] }],
    max_output_tokens: 32,
    stream: true,
    store: false,
  });
});

test('image connectivity follows catalog capabilities and keeps the probe bounded', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const session = {
    basePath: '/e-mate/model-api/',
    sessionToken: `header.${'m'.repeat(32)}.signature`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    allowedModelIds: ['custom-image-route'],
  };
  const responses = [
    new Response(JSON.stringify({
      schemaVersion: 1,
      models: [{ id: 'custom-image-route', capabilities: { imageGeneration: true } }],
    }), { headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ created: 1, data: [{ b64_json: 'fixture' }] }), {
      headers: { 'content-type': 'application/json' },
    }),
  ];
  const result = await testModelConnection('custom-image-route', session, new AbortController().signal, {
    origin,
    fetcher: async (input, init) => {
      calls.push({ input: String(input), init });
      return responses.shift() as Response;
    },
  });
  assert.equal(result.method, 'live-image-generation');
  assert.equal(calls[1]?.input, '/e-mate/model-api/v1/images/generations');
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    model: 'custom-image-route',
    prompt: 'A solid orange square.',
    size: '1024x1024',
  });
});

test('audit identifiers stay readable while long values are safely abbreviated', () => {
  assert.equal(abbreviateAuditValue('acceptance-1'), 'acceptance-1');
  assert.equal(abbreviateAuditValue('a'.repeat(64)), `${'a'.repeat(12)}…${'a'.repeat(8)}`);
});

test('consent audit requests retain audit evidence without sending tenant or policy bodies', async () => {
  let call: { input: string; init?: RequestInit } | undefined;
  const result = await loadConsentAcceptances(
    'admin-token',
    new AbortController().signal,
    {
      origin,
      fetcher: async (input, init) => {
        call = { input: String(input), init };
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            acceptances: [
              {
                schemaVersion: 1,
                acceptanceId: 'acceptance-1',
                userId: 'user-1',
                agreementId: 'e-mate-platform-terms',
                agreementVersion: '1.0.0',
                disclaimerVersion: '1.0.0',
                contentHash: 'a'.repeat(64),
                acceptedAt: '2026-08-02T10:00:00.000Z',
                clientVersion: '2.1.46',
                locale: 'zh-CN',
              },
            ],
          }),
          { status: 200 }
        );
      },
    },
    { userId: 'user-1', agreementVersion: '1.0.0', limit: 50 }
  );
  assert.equal(result.acceptances[0]?.acceptanceId, 'acceptance-1');
  assert.equal(result.acceptances[0]?.agreementId, 'e-mate-platform-terms');
  assert.equal(result.acceptances[0]?.contentHash, 'a'.repeat(64));
  assert.equal(call?.input, '/v1/admin/consents?userId=user-1&agreementVersion=1.0.0&limit=50');
  assert.equal(call?.input.includes('tenantId'), false);
  assert.equal(call?.init?.method, 'GET');
  assert.equal(call?.init?.body, undefined);
});

test('admin mutations derive tenant server-side and client secrets never appear in list responses', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const responses = [
    new Response(
      JSON.stringify({
        schemaVersion: 1,
        userId: 'user-1',
        displayName: 'Employee',
        roles: ['MEMBER'],
        status: 'ACTIVE',
        tokenLimit: 50_000,
        allowedModelIds: ['gpt-5.6-sol'],
        createdAt: '2026-07-30T10:00:00.000Z',
        updatedAt: '2026-07-30T10:00:00.000Z',
      }),
      { status: 201 }
    ),
    new Response(
      JSON.stringify({
        schemaVersion: 1,
        userId: 'user-1',
        displayName: 'Employee',
        roles: ['MEMBER'],
        status: 'ACTIVE',
        tokenLimit: 75_000,
        allowedModelIds: ['gpt-5.6-sol'],
        createdAt: '2026-07-30T10:00:00.000Z',
        updatedAt: '2026-07-31T10:00:00.000Z',
      }),
      { status: 200 }
    ),
    new Response(JSON.stringify({ schemaVersion: 1, keys: [] }), { status: 200 }),
    new Response(
      JSON.stringify({
        schemaVersion: 1,
        key: {
          schemaVersion: 1,
          keyId: 'key-1',
          label: 'Desktop',
          principalType: 'USER',
          principalId: 'user-1',
          userId: 'user-1',
          scopes: ['models:invoke'],
          createdAt: '2026-07-30T10:00:00.000Z',
          lastUsedAt: null,
          revokedAt: null,
        },
        secret: `emate_twe_${'a'.repeat(43)}`,
      }),
      { status: 201 }
    ),
  ];
  const options = {
    origin,
    fetcher: async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return responses.shift() as Response;
    },
  };
  const signal = new AbortController().signal;
  await createTenantUser('admin-token', signal, options, {
    schemaVersion: 1,
    userId: 'user-1',
    displayName: 'Employee',
    roles: ['MEMBER'],
    tokenLimit: 50_000,
    allowedModelIds: ['gpt-5.6-sol'],
    initialPassword: 'InitialPass-2026!',
  });
  await updateTenantUser('admin-token', signal, options, 'user-1', {
    schemaVersion: 1,
    displayName: 'Employee',
    roles: ['MEMBER'],
    status: 'ACTIVE',
    tokenLimit: 75_000,
    allowedModelIds: ['gpt-5.6-sol'],
    expectedUpdatedAt: '2026-07-30T10:00:00.000Z',
  });
  const keys = await loadApiKeys('admin-token', signal, options);
  const issued = await issueApiKey('admin-token', signal, options, {
    schemaVersion: 1,
    label: 'Desktop',
    principalType: 'USER',
    principalId: 'user-1',
    userId: 'user-1',
    scopes: ['models:invoke'],
  });

  assert.equal(JSON.stringify(keys).includes('emate_twe_'), false);
  assert.match(issued.secret, /^emate_twe_/);
  const userBody = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
  assert.equal('tenantId' in userBody, false);
  assert.equal(userBody.initialPassword, 'InitialPass-2026!');
  assert.equal((JSON.parse(String(calls[1]?.init?.body)) as { tokenLimit: number }).tokenLimit, 75_000);
  assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), 'Bearer admin-token');
  assert.equal(
    calls.some((call) => call.input.includes('admin-token')),
    false
  );
});

test('password reset uses the isolated tenant user password endpoint', async () => {
  let call: { input: string; init?: RequestInit } | undefined;
  await resetTenantUserPassword(
    'admin-token',
    new AbortController().signal,
    {
      origin,
      fetcher: async (input, init) => {
        call = { input: String(input), init };
        return new Response(null, { status: 204 });
      },
    },
    'user/1',
    { schemaVersion: 1, password: 'Replacement-2026!' }
  );
  assert.equal(call?.input, '/v1/admin/users/user%2F1/password');
  assert.equal(call?.init?.method, 'PUT');
  assert.deepEqual(JSON.parse(String(call?.init?.body)), {
    schemaVersion: 1,
    password: 'Replacement-2026!',
  });
});

test('user deletion uses the tenant-scoped DELETE endpoint with optimistic concurrency', async () => {
  let call: { input: string; init?: RequestInit } | undefined;
  await deleteTenantUser(
    'admin-token',
    new AbortController().signal,
    {
      origin,
      fetcher: async (input, init) => {
        call = { input: String(input), init };
        return new Response(null, { status: 204 });
      },
    },
    'user/1',
    {
      schemaVersion: 1,
      expectedUpdatedAt: '2026-07-30T10:00:00.000Z',
    }
  );

  assert.equal(call?.input, '/v1/admin/users/user%2F1');
  assert.equal(call?.init?.method, 'DELETE');
  assert.deepEqual(JSON.parse(String(call?.init?.body)), {
    schemaVersion: 1,
    expectedUpdatedAt: '2026-07-30T10:00:00.000Z',
  });
});

test('model route key updates use the write-only key endpoint', async () => {
  const apiKey = 'provider-key-that-is-long-enough';
  let call: { input: string; init?: RequestInit } | undefined;
  const route = await updateModelRouteKey(
    'admin-token',
    new AbortController().signal,
    {
      origin,
      fetcher: async (input, init) => {
        call = { input: String(input), init };
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            routeId: 'gpt-5.6-sol',
            label: 'Sol',
            provider: 'OpenAI',
            published: true,
            enabled: true,
            updatedAt: null,
            keyConfigured: true,
            keyUpdatedAt: '2026-07-31T10:00:00.000Z',
          }),
          { status: 200 }
        );
      },
    },
    'gpt-5.6-sol',
    {
      schemaVersion: 1,
      apiKey,
    }
  );

  assert.equal(route.keyConfigured, true);
  assert.equal(JSON.stringify(route).includes(apiKey), false);
  assert.equal(call?.input, '/v1/admin/model-routes/gpt-5.6-sol/key');
  assert.equal(call?.init?.method, 'PUT');
  assert.equal((JSON.parse(String(call?.init?.body)) as { apiKey: string }).apiKey, apiKey);
});

test('Astra connectivity sends enterprise low reasoning', async () => {
  const session = { basePath: '/e-mate/model-api/', sessionToken: `header.${'m'.repeat(32)}.signature`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), allowedModelIds: ['gpt-6-astra'] };
  let request: Record<string, unknown> | undefined;
  await testModelConnection('gpt-6-astra', session, new AbortController().signal, { origin,
    fetcher: async (_input, init) => {
      if (!init?.body) return new Response(JSON.stringify({ schemaVersion: 1, models: [{ id: 'gpt-6-astra', capabilities: { imageGeneration: false } }] }), { headers: { 'content-type': 'application/json' } });
      request = JSON.parse(String(init.body));
      return new Response('data: {"type":"response.completed","response":{"id":"astra-test"}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } });
  assert.deepEqual(request?.reasoning, { effort: 'low' });
});
