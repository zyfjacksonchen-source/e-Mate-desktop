import assert from 'node:assert/strict';
import { createCipheriv, createHash, generateKeyPairSync, verify } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { InMemoryConsentStore } from '@e-mate/consent-store';
import { TASK_SCENARIOS } from '@e-mate/monitoring-contract';
import {
  createModelGatewayServer,
  InMemoryUsageStore,
  InvocationAdmissionError,
  PostgresUsageStore,
  PostgresTenantModelRoutePolicy,
  type ModelGatewayOptions,
  type ModelGatewayPrincipal,
  type ModelGatewayRoute,
  type ProviderInvocationReceipt,
  type ProviderInvocationReceiptRequest,
  type TenantModelRoutePolicy,
  type UsageStore,
} from '../src/index.ts';
import { createProductionAuthenticator } from '../src/production.ts';
import type { ImageObservation } from '../src/image-observability.ts';
import { InvocationRequestConflictError, MAX_RESPONSES_REQUEST_BYTES } from '../src/server.ts';

const sessionToken = 's'.repeat(64);
const otherToken = 'o'.repeat(64);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const route: ModelGatewayRoute = {
  id: 'gpt-5.6-sol',
  upstreamModelId: 'provider-sol',
  upstreamBaseUrl: 'https://provider.example/v1',
  upstreamApiKey: 'provider-secret-that-never-leaves-the-gateway',
  providerId: 'custom-gpt',
  label: 'GPT-5.6 Sol',
  buttonLabel: 'GPT-5.6 Sol · 中等',
  provider: '自定义 GPT Gateway',
  providerMark: 'G',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  contextWindow: 1_050_000,
  maxTokens: 128_000,
};
const imageRoute: ModelGatewayRoute = {
  ...route,
  id: 'gpt-image-2.5-flare',
  apiMode: 'images-generations',
  upstreamModelId: 'gpt-image-2.5-flare',
  label: '图片 Pro',
  buttonLabel: '图片 Pro',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 32_000,
};
const chatRoute: ModelGatewayRoute = {
  ...route,
  id: 'deepseek',
  apiMode: 'chat-completions',
  upstreamModelId: 'deepseek-chat',
  providerId: 'deepseek',
  label: 'DeepSeek',
  buttonLabel: 'DeepSeek',
  provider: 'DeepSeek',
  providerMark: 'D',
  input: ['text'],
};
const searchCredentialRoute: ModelGatewayRoute = {
  ...chatRoute,
  id: 'deepseek-web-search',
  upstreamModelId: 'deepseek-v4-flash',
  upstreamBaseUrl: 'https://api.deepseek.com/anthropic/v1',
  upstreamApiKey: 'search-route-bootstrap-key-that-is-never-leased',
  providerId: 'deepseek-official',
  label: 'DeepSeek Web Search Credential',
  buttonLabel: 'DeepSeek Web Search Credential',
};
const limits = {
  tenantRequestsPerMinute: 1_000,
  tenantBurst: 1_000,
  tenantMaxConcurrent: 1,
  invocationLeaseMs: 180_000,
};

test('decrypts tenant route keys only for their bound tenant and route', async () => {
  const encryptionKey = Buffer.alloc(32, 7);
  const nonce = Buffer.alloc(12, 3);
  const apiKey = 'tenant-provider-key-from-encrypted-store';
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  cipher.setAAD(Buffer.from('tenant-a\0gpt-5.6-sol'));
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const pool = {
    query: async () => ({
      rows: [{ route_id: 'gpt-5.6-sol', upstream_key_ciphertext: ciphertext, upstream_key_nonce: nonce, upstream_key_tag: tag }],
    }),
  };
  const policy = new PostgresTenantModelRoutePolicy(pool as never, encryptionKey);
  assert.equal(await policy.upstreamApiKey('tenant-a', 'gpt-5.6-sol'), apiKey);
  await assert.rejects(policy.upstreamApiKey('tenant-b', 'gpt-5.6-sol'), /unavailable|authenticate/i);
});

test('uses default route policy only when a tenant has no explicit route row', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const policy = new PostgresTenantModelRoutePolicy(pool as never);
  assert.equal(await policy.isEnabled('tenant-a', 'gpt-5.6-sol'), true);
  assert.equal(await policy.isEnabled('tenant-a', 'gemini-3.1-pro-high'), false);
  assert.equal(await policy.isEnabled('tenant-a', 'deepseek'), true);
  assert.equal(await policy.isEnabled('tenant-a', 'doubao-seed-2-0-pro-260215'), false);
  assert.equal(await policy.isEnabled('tenant-a', 'gpt-5.4'), false);
});

test('accepts only active model-only credentials and rejects retired combined credentials', async () => {
  const credential = `emate_twe_${'c'.repeat(43)}`;
  let credentialState: 'model-only' | 'combined' | 'revoked' = 'model-only';
  let queryCount = 0;
  const pool = {
    query: async (statement: string, parameters: unknown[]) => {
      queryCount += 1;
      assert.equal(statement.includes("key.scopes = ARRAY['models:invoke']::text[]"), true);
      assert.equal(statement.includes("key.principal_type = 'USER'"), true);
      assert.equal(statement.includes("app_user.status = 'ACTIVE'"), true);
      assert.equal(statement.includes('key.revoked_at IS NULL'), true);
      assert.equal(parameters.includes(credential), false);
      return {
        rows:
          credentialState === 'model-only'
            ? [{ tenant_id: 'tenant-a', user_id: 'user-a', model_ids: ['gpt-5.6-luna'] }]
            : [],
      };
    },
  };
  const policy = new PostgresTenantModelRoutePolicy(pool as never);
  assert.deepEqual(await policy.authenticateClientCredential(credential, ['gpt-5.6-luna', 'gpt-5.6-sol']), {
    tenantId: 'tenant-a',
    userId: 'user-a',
    modelIds: ['gpt-5.6-luna'],
  });
  credentialState = 'combined';
  assert.equal(await policy.authenticateClientCredential(credential, ['gpt-5.6-luna', 'gpt-5.6-sol']), null);
  credentialState = 'revoked';
  assert.equal(await policy.authenticateClientCredential(credential, ['gpt-5.6-luna', 'gpt-5.6-sol']), null);
  assert.equal(await policy.authenticateClientCredential('not-a-client-credential', ['gpt-5.6-luna']), null);
  assert.equal(queryCount, 3);
});

test('production authentication rejects a signed session immediately after its session or user is revoked', async () => {
  const statuses: Array<'ACTIVE' | 'SUSPENDED' | 'DELETED'> = ['ACTIVE', 'SUSPENDED', 'DELETED'];
  const queries: Array<{ statement: string; parameters: unknown[] }> = [];
  const pool = {
    query: async (statement: string, parameters: unknown[]) => {
      queries.push({ statement, parameters });
      return { rows: [{ active: statuses.shift() === 'ACTIVE' }] };
    },
  };
  const policy = new PostgresTenantModelRoutePolicy(pool as never);
  const signedPrincipal = {
    tenantId: 'tenant-a',
    userId: 'user-a',
    modelIds: [route.id],
    sessionId: 'session-1',
  };
  const authenticate = createProductionAuthenticator(
    async (token) => (token === sessionToken ? signedPrincipal : null),
    policy,
    { activeModelIds: async (principal: ModelGatewayPrincipal) => principal.modelIds } as never,
    [route.id]
  );

  assert.deepEqual(await authenticate(sessionToken), signedPrincipal);
  assert.equal(await authenticate(sessionToken), null);
  assert.equal(await authenticate(sessionToken), null);
  assert.equal(queries.length, 3);
  assert.equal(
    queries.every(({ statement }) => statement.includes("status = 'ACTIVE'")),
    true
  );
  assert.deepEqual(
    queries.map(({ parameters }) => parameters),
    [
      ['tenant-a', 'user-a', 'session-1'],
      ['tenant-a', 'user-a', 'session-1'],
      ['tenant-a', 'user-a', 'session-1'],
    ]
  );
});

test('production authentication intersects signed scope with live user models and callable routes', async () => {
  let signedModelIds = ['gpt-5.6-luna'];
  let liveModelIds = ['gpt-5.6-luna', 'gpt-5.6-sol'];
  const scopes: string[][] = [];
  const authenticate = createProductionAuthenticator(
    async () => ({
      tenantId: 'tenant-a', userId: 'user-a', modelIds: [...signedModelIds], sessionId: 'session-1',
    }),
    { isUserSessionActive: async () => true } as never,
    { activeModelIds: async (_principal: ModelGatewayPrincipal, routeIds: readonly string[]) => {
      scopes.push([...routeIds]);
      return routeIds.filter((routeId) => liveModelIds.includes(routeId));
    } } as never,
    ['gpt-5.6-luna', 'gpt-5.6-sol']
  );

  assert.deepEqual((await authenticate(sessionToken))?.modelIds, ['gpt-5.6-luna']);
  liveModelIds = ['gpt-5.6-sol'];
  assert.equal(await authenticate(sessionToken), null);
  signedModelIds = ['gpt-5.6-luna', 'gpt-5.6-sol'];
  assert.deepEqual((await authenticate(sessionToken))?.modelIds, ['gpt-5.6-sol']);
  liveModelIds = [];
  assert.equal(await authenticate(sessionToken), null);
  assert.deepEqual(scopes, [
    ['gpt-5.6-luna'],
    ['gpt-5.6-luna'],
    ['gpt-5.6-luna', 'gpt-5.6-sol'],
    ['gpt-5.6-luna', 'gpt-5.6-sol'],
  ]);
});

test('production client authentication never authorizes the search credential route as a model', async () => {
  const allowedRouteIds: string[][] = [];
  const authenticate = createProductionAuthenticator(
    async () => null,
    {
      authenticateClientCredential: async (_token: string, routeIds: readonly string[]) => {
        allowedRouteIds.push([...routeIds]);
        return null;
      },
    } as never,
    { activeModelIds: async () => [] } as never,
    [route.id, searchCredentialRoute.id]
  );

  assert.equal(await authenticate('client-credential'), null);
  assert.deepEqual(allowedRouteIds, [[route.id]]);
});

type TokenLimitTestState = {
  replay?: 'PENDING' | 'RECORDED';
  tokenLimit: string | null;
  usedTokens: string;
  statements: string[];
  quotaUpdates: number;
  invocationInserts: number;
};

const postgresInvocationFact = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  taskId: 'task-token-limit',
  traceId: 'trace-token-limit',
  modelId: route.id,
  providerId: route.providerId,
  requestDigest: 'd'.repeat(43),
  routeFingerprint: 'f'.repeat(43),
};

function tokenLimitUsageStore(state: TokenLimitTestState): PostgresUsageStore {
  const databaseNow = new Date('2026-07-31T00:00:00.000Z');
  const client = {
    async query(statementInput: string, parameters: unknown[] = []) {
      const statement = statementInput.replace(/\s+/g, ' ').trim();
      state.statements.push(statement);
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)) return { rows: [] };
      if (statement.startsWith('INSERT INTO e_mate_model_usage_task')) return { rows: [] };
      if (
        statement.startsWith('SELECT tenant_id, user_id, task_id') &&
        statement.includes('FROM e_mate_model_usage_task')
      ) {
        return {
          rows: [
            {
              tenant_id: 'tenant-a',
              user_id: 'user-a',
              task_id: parameters[2],
              trace_id: parameters[2] === 'task-token-limit-raised' ? 'trace-token-limit-raised' : 'trace-token-limit',
              model_id: route.id,
              provider_id: route.providerId,
              status: 'ACCUMULATING',
              input_tokens: '0',
              output_tokens: '0',
              cache_read_tokens: '0',
              cache_write_tokens: '0',
              cost_usd: '0',
              usage_id: null,
              finalized_at: null,
            },
          ],
        };
      }
      if (statement.startsWith('SELECT invocation_id') && statement.includes("status = 'PREPARED'")) {
        return {
          rows: state.replay === 'PENDING'
            ? [{ invocation_id: 'pending-invocation', request_digest: postgresInvocationFact.requestDigest }]
            : [],
        };
      }
      if (statement.startsWith('SELECT invocation_id') && statement.includes("status = 'COMPLETED'")) {
        return {
          rows: state.replay === 'RECORDED' ? [{ invocation_id: 'recorded-invocation' }] : [],
        };
      }
      if (statement.includes('app_user.token_limit::text')) {
        assert.deepEqual(parameters, ['tenant-a', 'user-a']);
        assert.match(statement, /FROM e_mate_model_usage_attempt AS attempt/);
        assert.match(statement, /date_trunc\('week'.*'UTC'/);
        return {
          rows: [
            {
              token_limit: state.tokenLimit,
              used_tokens: state.usedTokens,
              database_now: databaseNow,
              week_ends_at: new Date('2026-08-03T00:00:00.000Z'),
            },
          ],
        };
      }
      if (statement.startsWith('SELECT invocation_id') && statement.includes("status = 'REJECTED'")) {
        return { rows: [] };
      }
      if (statement.startsWith('INSERT INTO e_mate_model_quota_state')) return { rows: [] };
      if (statement.startsWith('SELECT tokens, last_refill_at')) {
        return { rows: [{ tokens: '1000', last_refill_at: databaseNow }] };
      }
      if (statement === 'SELECT clock_timestamp() AS database_now') {
        return { rows: [{ database_now: databaseNow }] };
      }
      if (statement.startsWith('SELECT count(*) AS active')) {
        return { rows: [{ active: '0', earliest_expiry: null }] };
      }
      if (statement.startsWith('UPDATE e_mate_model_quota_state')) {
        state.quotaUpdates += 1;
        return { rows: [] };
      }
      if (statement.startsWith('INSERT INTO e_mate_model_invocation')) {
        state.invocationInserts += 1;
        return { rows: [] };
      }
      throw new Error(`Unexpected test query: ${statement}`);
    },
    release() {},
  };
  const pool = { connect: async () => client };
  return new PostgresUsageStore(pool as never, limits);
}

test('blocks a reached user token limit before tenant admission and recovers after an immediate raise', async () => {
  const state: TokenLimitTestState = {
    tokenLimit: '10',
    usedTokens: '10',
    statements: [],
    quotaUpdates: 0,
    invocationInserts: 0,
  };
  const store = tokenLimitUsageStore(state);

  await assert.rejects(store.prepare(postgresInvocationFact), (error: unknown) => {
    assert(error instanceof InvocationAdmissionError);
    assert.equal(error.code, 'USER_TOKEN_LIMIT_REACHED');
    return true;
  });
  assert.equal(state.quotaUpdates, 0);
  assert.equal(state.invocationInserts, 0);

  state.tokenLimit = '11';
  const prepared = await store.prepare({
    ...postgresInvocationFact,
    taskId: 'task-token-limit-raised',
    traceId: 'trace-token-limit-raised',
  });
  assert.equal(prepared.status, 'STARTED');
  assert.equal(state.quotaUpdates, 1);
  assert.equal(state.invocationInserts, 1);
});

test('returns pending and recorded idempotent replays without consulting a reached user limit', async () => {
  await Promise.all(
    (['PENDING', 'RECORDED'] as const).map(async (replay) => {
      const state: TokenLimitTestState = {
        replay,
        tokenLimit: '0',
        usedTokens: '999',
        statements: [],
        quotaUpdates: 0,
        invocationInserts: 0,
      };
      const prepared = await tokenLimitUsageStore(state).prepare(postgresInvocationFact);

      assert.equal(prepared.status, replay);
      assert.equal(
        state.statements.some((statement) => statement.includes('token_limit')),
        false
      );
      assert.equal(state.quotaUpdates, 0);
    })
  );
});

test('Postgres admission conflicts a pending task with a different request digest', async () => {
  const state: TokenLimitTestState = {
    replay: 'PENDING',
    tokenLimit: '0',
    usedTokens: '999',
    statements: [],
    quotaUpdates: 0,
    invocationInserts: 0,
  };
  await assert.rejects(
    tokenLimitUsageStore(state).prepare({ ...postgresInvocationFact, requestDigest: 'x'.repeat(43) }),
    /request digest changed/
  );
  assert.equal(state.statements.at(-1), 'ROLLBACK');
  assert.equal(state.statements.filter((statement) => statement === 'ROLLBACK').length, 1);
  assert.equal(state.statements.includes('COMMIT'), false);
  assert.equal(state.statements.some((statement) => statement.includes('token_limit')), false);
  assert.equal(state.statements.some((statement) => statement.startsWith('SELECT count(*) AS active')), false);
  assert.equal(state.statements.some((statement) => statement.startsWith('UPDATE e_mate_model_quota_state')), false);
  assert.equal(state.statements.some((statement) => statement.startsWith('INSERT INTO e_mate_model_invocation')), false);
  assert.equal(state.quotaUpdates, 0);
  assert.equal(state.invocationInserts, 0);
});

function principal(tenantId: string, userId: string, modelId = route.id): ModelGatewayPrincipal {
  return { tenantId, userId, modelIds: [modelId] };
}

test('versionless API keys retain legacy grants and never receive Astra', async () => {
  const calls: string[][] = [];
  const policy = { authenticateClientCredential: async (_token: string, ids: string[]) => { calls.push(ids); return null; } };
  await createProductionAuthenticator(async () => null, policy as never, {} as never, ['gpt-5.6-sol', 'gpt-6-astra'])('fixture-key');
  assert.deepEqual(calls, [['gpt-5.6-sol']]);
  assert.equal(await createProductionAuthenticator(async () => null, policy as never, {} as never, ['gpt-6-astra'])('fixture-key'), null);
  assert.equal(calls.length, 1);
});

function completedSse(inputTokens: number, outputTokens: number, responseId = 'response-1'): Response {
  const event = {
    type: 'response.completed',
    response: {
      id: responseId,
      status: 'completed',
      output: [],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        input_tokens_details: {
          cached_tokens: 2,
          cache_write_tokens: 1,
        },
      },
    },
  };
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function completedChatSse(inputTokens: number, outputTokens: number, responseId = 'chat-response-1'): Response {
  const frames = [
    {
      id: responseId,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
      usage: null,
    },
    {
      id: responseId,
      object: 'chat.completion.chunk',
      choices: [],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    },
  ];
  return new Response(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function withGateway(
  run: (baseUrl: string, upstreamRequests: Request[]) => Promise<void>,
  responseForRequest?: (request: Request, index: number) => Response | Promise<Response>,
  reconcileProviderInvocation?: (
    request: ProviderInvocationReceiptRequest
  ) => Promise<ProviderInvocationReceipt> | ProviderInvocationReceipt,
  upstreamTimeoutMs?: number,
  gatewayLimits = limits,
  gatewayRoute: ModelGatewayRoute = route,
  tenantModelRoutePolicy?: TenantModelRoutePolicy,
  usageStore: UsageStore = new InMemoryUsageStore(gatewayLimits),
  imageObservation?: ModelGatewayOptions['imageObservation'],
  upstreamRejectionObservation?: ModelGatewayOptions['upstreamRejectionObservation'],
  grantedModels?: string[]
): Promise<void> {
  const upstreamRequests: Request[] = [];
  const consentStore = new InMemoryConsentStore(consentPolicy);
  await Promise.all([
    consentStore.accept(principal('tenant-a', 'user-a', gatewayRoute.id), consentInput),
    consentStore.accept(principal('tenant-b', 'user-b', gatewayRoute.id), consentInput),
  ]);
  const server = createModelGatewayServer({
    routes: [gatewayRoute],
    authenticate: async (token) =>
      token === sessionToken
        ? { ...principal('tenant-a', 'user-a', gatewayRoute.id), ...(grantedModels ? { modelIds: grantedModels } : {}) }
        : token === otherToken
          ? principal('tenant-b', 'user-b', gatewayRoute.id)
          : null,
    tenantModelRoutePolicy,
    consentStore,
    usageStore,
    usageKeyId: 'usage-2026',
    usagePrivateKey: privateKey,
    reconcileProviderInvocation,
    upstreamTimeoutMs,
    imageObservation,
    upstreamRejectionObservation,
    fetchImplementation: async (input, init) => {
      const upstreamRequest = new Request(input, init);
      upstreamRequests.push(upstreamRequest);
      return await (responseForRequest?.(upstreamRequest, upstreamRequests.length) ??
        completedSse(10, 5, `response-${upstreamRequests.length}`));
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`, upstreamRequests);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('ingests strict direct-runtime audit batches idempotently without inference or quota admission', async () => {
  let routeEnabled = true;
  const usageStore = new InMemoryUsageStore(limits);
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const upload = (records: unknown[]) =>
        fetch(`${baseUrl}/v1/audit/usage`, {
          method: 'POST',
          headers: { ...auth(), 'content-type': 'application/json' },
          body: JSON.stringify({ schema_version: 1, records }),
        });
      const record = auditUsageRecord();
      const first = await upload([record]);
      assert.equal(first.status, 200);
      assert.equal(first.headers.get('cache-control'), 'no-store');
      assert.equal(first.headers.has('access-control-allow-origin'), false);
      const receiptBatch = (await first.json()) as {
        schema_version: number;
        receipts: Array<Record<string, unknown>>;
      };
      assert.equal(receiptBatch.schema_version, 1);
      assert.deepEqual(Object.keys(receiptBatch.receipts[0]!).sort(), [
        'accepted_at',
        'fact_id',
        'payload_sha256',
        'receipt_id',
      ]);
      assert.equal(Number.isNaN(Date.parse(String(receiptBatch.receipts[0]!.accepted_at))), false);

      const replay = await upload([record]);
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), receiptBatch);
      const usage = (await (
        await fetch(`${baseUrl}/v1/usage/current`, { headers: auth() })
      ).json()) as { totalTokens: number };
      assert.equal(usage.totalTokens, 11);
      const finalized = await usageStore.finalize(
        principal('tenant-a', 'user-a'),
        String(record.payload.source_id)
      );
      assert.equal(finalized?.costUsd, 0.0001485);
      assert.equal(finalized?.usageId, `auditusage_${createHash('sha256').update(record.fact_id).digest('hex')}`);
      assert.equal(finalized?.occurredAt, new Date(String(record.payload.provider_created_at)).toISOString());
      assert.deepEqual(await (await upload([record])).json(), receiptBatch);

      const conflict = await upload([auditUsageRecord(1, { output_tokens: 5, total_tokens: 12 })]);
      assert.equal(conflict.status, 409);
      assert.equal(((await conflict.json()) as { error: { code: string } }).error.code, 'AUDIT_USAGE_CONFLICT');
      assert.equal(
        ((await (await fetch(`${baseUrl}/v1/usage/current`, { headers: auth() })).json()) as { totalTokens: number })
          .totalTokens,
        11
      );
      const orderedRecords = [auditUsageRecord(4), auditUsageRecord(2)];
      const ordered = (await (await upload(orderedRecords)).json()) as {
        receipts: Array<{ fact_id: string }>;
      };
      assert.deepEqual(
        ordered.receipts.map(({ fact_id }) => fact_id),
        orderedRecords.map(({ fact_id }) => fact_id)
      );
      const atomicFailure = await upload([
        auditUsageRecord(5),
        auditUsageRecord(1, { output_tokens: 5, total_tokens: 12 }),
      ]);
      assert.equal(atomicFailure.status, 409);
      assert.equal(
        ((await (await fetch(`${baseUrl}/v1/usage/current`, { headers: auth() })).json()) as { totalTokens: number })
          .totalTokens,
        33
      );
      assert.equal((await upload([auditUsageRecord(5)])).status, 200);

      const wrongAccount = await upload([auditUsageRecord(2, { account_subject_sha256: 'b'.repeat(64) })]);
      assert.equal(wrongAccount.status, 400);
      const unknownField = await fetch(`${baseUrl}/v1/audit/usage`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ schema_version: 1, records: [auditUsageRecord(2)], extra: true }),
      });
      assert.equal(unknownField.status, 400);
      for (const [field, secret] of [
        ['prompt', 'private prompt'],
        ['image', 'private image bytes'],
        ['b64_json', 'cHJpdmF0ZS1pbWFnZQ=='],
        ['api_key', 'private-provider-secret'],
      ]) {
        const sensitive = await upload([{ ...auditUsageRecord(40), [field]: secret }]);
        assert.equal(sensitive.status, 400);
        const error = JSON.stringify(await sensitive.json());
        assert.match(error, /INVALID_AUDIT_USAGE/);
        assert.equal(error.includes(secret), false);
      }
      assert.equal((await upload(Array.from({ length: 65 }, (_, index) => auditUsageRecord(index + 10)))).status, 400);
      assert.equal((await fetch(`${baseUrl}/v1/audit/usage`, { headers: auth() })).status, 405);

      routeEnabled = false;
      assert.equal((await upload([auditUsageRecord(3)])).status, 403);
      assert.equal(upstreamRequests.length, 0);
    },
    undefined,
    undefined,
    undefined,
    limits,
    route,
    { isEnabled: async () => routeEnabled },
    usageStore
  );
});

test('ingests only metadata task audit events atomically and idempotently', async () => {
  await withGateway(async (baseUrl, upstreamRequests) => {
    const upload = (records: unknown[]) => fetch(`${baseUrl}/v1/audit/tasks`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 1, records }),
    });
    const received = auditTaskRecord(1, 0, 'RECEIVED');
    const tool = auditTaskRecord(1, 1, 'TOOL_EXECUTION');
    const completed = auditTaskRecord(1, 2, 'COMPLETED');
    const first = await upload([received, tool, completed]);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal(first.headers.has('access-control-allow-origin'), false);
    const receipts = await first.json();
    assert.deepEqual(
      (receipts as { receipts: Array<Record<string, unknown>> }).receipts.map((receipt) => Object.keys(receipt).sort()),
      Array.from({ length: 3 }, () => ['accepted_at', 'event_id', 'payload_sha256', 'receipt_id'])
    );
    assert.deepEqual(await (await upload([received, tool, completed])).json(), receipts);

    const classified = TASK_SCENARIOS.filter((scenario) => scenario !== 'GENERAL').flatMap((scenario, index) => [
      auditTaskRecord(index + 10, 0, 'RECEIVED', { scenario }),
      auditTaskRecord(index + 10, 1, 'TOOL_EXECUTION', { scenario }),
    ]);
    const classifiedResponse = await upload(classified);
    assert.equal(classifiedResponse.status, 200);
    const classifiedReceipts = await classifiedResponse.json();
    assert.equal((classifiedReceipts as { receipts: unknown[] }).receipts.length, classified.length);
    assert.deepEqual(await (await upload(classified)).json(), classifiedReceipts);

    const stableReceived = auditTaskRecord(30, 0, 'RECEIVED', { scenario: 'CONTENT_CREATION' });
    assert.equal((await upload([stableReceived])).status, 200);
    const drifted = auditTaskRecord(30, 1, 'TOOL_EXECUTION', { scenario: 'DOCUMENT_EDITING' });
    assert.equal((await upload([drifted])).status, 409);
    const stable = auditTaskRecord(30, 1, 'TOOL_EXECUTION', { scenario: 'CONTENT_CREATION' });
    assert.equal((await upload([stable])).status, 200);

    const validAfterPoison = auditTaskRecord(31, 0, 'RECEIVED', { scenario: 'SEARCH_QUERY' });
    const unknownScenario = auditTaskRecord(32, 0, 'RECEIVED', { scenario: 'UNKNOWN' });
    const poisoned = await upload([validAfterPoison, unknownScenario]);
    assert.equal(poisoned.status, 400);
    assert.equal(((await poisoned.json()) as { error: { code: string } }).error.code, 'INVALID_AUDIT_TASK');
    assert.equal((await upload([validAfterPoison])).status, 200);

    const changed = auditTaskRecord(1, 0, 'RECEIVED', {
      occurredAt: new Date(Date.now() - 5_000).toISOString(),
    });
    changed.event_id = received.event_id;
    changed.payload.eventId = received.event_id;
    changed.payload_sha256 = createHash('sha256').update(testCanonicalJson(changed.payload)).digest('hex');
    const conflict = await upload([changed]);
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { error: { code: string } }).error.code, 'AUDIT_TASK_CONFLICT');

    assert.equal((await upload([auditTaskRecord(2, 1, 'FAILED')])).status, 409);
    const task2 = auditTaskRecord(2, 0, 'RECEIVED');
    const atomic = await upload([task2, changed]);
    assert.equal(atomic.status, 409);
    assert.equal((await upload([task2])).status, 200);

    const wrongAccount = auditTaskRecord(3, 0, 'RECEIVED');
    wrongAccount.account_subject_sha256 = 'b'.repeat(64);
    assert.equal((await upload([wrongAccount])).status, 400);
    assert.equal((await upload([{ ...auditTaskRecord(4, 0, 'RECEIVED'), prompt: 'forbidden' }])).status, 400);
    assert.equal((await upload(Array.from({ length: 65 }, (_, index) => auditTaskRecord(index + 10)))).status, 400);
    assert.equal((await fetch(`${baseUrl}/v1/audit/tasks`, { headers: auth() })).status, 405);
    assert.equal(upstreamRequests.length, 0);
  });
});

test('maps a direct-runtime upstream model id back to its allowed managed route', async () => {
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const response = await fetch(`${baseUrl}/v1/audit/usage`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({
          schema_version: 1,
          records: [
            auditUsageRecord(1, {
              requested_model_id: chatRoute.upstreamModelId,
              actual_model_id: chatRoute.upstreamModelId,
            }),
          ],
        }),
      });
      assert.equal(response.status, 200);
      assert.equal(upstreamRequests.length, 0);
    },
    undefined,
    undefined,
    undefined,
    limits,
    chatRoute,
    { isEnabled: async () => true }
  );
});

test('distinguishes a missing credential from an unavailable authenticator', async () => {
  const server = createModelGatewayServer({
    routes: [route],
    authenticate: async () => {
      throw new Error('authentication backend unavailable');
    },
    usageStore: new InMemoryUsageStore(limits),
    usageKeyId: 'usage-2026',
    usagePrivateKey: privateKey,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const missing = await fetch(`${baseUrl}/v1/models`);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error.code, 'AUTHENTICATION_REQUIRED');

    const unavailable = await fetch(`${baseUrl}/v1/models`, { headers: auth() });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error.code, 'AUTHENTICATION_UNAVAILABLE');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('returns HTTP 429 without an upstream request when the user token limit is reached', async () => {
  const usageStore = new InMemoryUsageStore(limits);
  usageStore.prepare = async () => {
    throw new InvocationAdmissionError('USER_TOKEN_LIMIT_REACHED', 3_600_000);
  };
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const response = await modelRequest(baseUrl);
      assert.equal(response.status, 429);
      assert.equal(response.headers.get('retry-after'), '3600');
      assert.equal((await response.json()).error.code, 'USER_TOKEN_LIMIT_REACHED');
      assert.equal(upstreamRequests.length, 0);
    },
    undefined,
    undefined,
    undefined,
    limits,
    route,
    undefined,
    usageStore
  );
});

test('enforces tenant route policy before upstream or usage journal access', async () => {
  const checked: string[] = [];
  const policy: TenantModelRoutePolicy = {
    async isEnabled(tenantId, routeId) {
      checked.push(`${tenantId}:${routeId}`);
      return tenantId !== 'tenant-a';
    },
  };
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const hidden = await fetch(`${baseUrl}/v1/models`, { headers: auth() });
      assert.equal(hidden.status, 403);

      const rejected = await modelRequest(baseUrl);
      assert.equal(rejected.status, 403);
      assert.equal(upstreamRequests.length, 0);

      const available = await fetch(`${baseUrl}/v1/models`, {
        headers: auth(otherToken),
      });
      assert.equal(available.status, 200);
      assert.equal(((await available.json()) as { models: unknown[] }).models.length, 1);
      assert.deepEqual(checked, ['tenant-a:gpt-5.6-sol', 'tenant-a:gpt-5.6-sol', 'tenant-b:gpt-5.6-sol']);
    },
    undefined,
    undefined,
    undefined,
    limits,
    route,
    policy
  );
});

test('applies route enable and disable changes to an existing session on its next request', async () => {
  let enabled = false;
  const upstreamRequests: Request[] = [];
  const consentStore = new InMemoryConsentStore(consentPolicy);
  await consentStore.accept(principal('tenant-a', 'user-a'), consentInput);
  const policy: TenantModelRoutePolicy = {
    async isEnabled(tenantId, routeId) {
      assert.equal(tenantId, 'tenant-a');
      assert.equal(routeId, route.id);
      return enabled;
    },
  };
  const server = createModelGatewayServer({
    routes: [route],
    authenticate: async (token) => {
      if (token === sessionToken) {
        return { tenantId: 'tenant-a', userId: 'user-a', modelIds: [route.id], sessionId: 'auth-session-1' };
      }
      if (token === otherToken) return { tenantId: 'tenant-a', userId: 'user-a', modelIds: [] };
      return null;
    },
    consentStore,
    tenantModelRoutePolicy: policy,
    usageStore: new InMemoryUsageStore(limits),
    usageKeyId: 'usage-2026',
    usagePrivateKey: privateKey,
    fetchImplementation: async (input, init) => {
      upstreamRequests.push(new Request(input, init));
      return completedSse(10, 5, `response-${upstreamRequests.length}`);
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const invoke = (token: string, taskId: string) =>
    fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        ...responseHeaders(),
        session_id: taskId,
        'x-client-request-id': taskId,
        'x-e-mate-task-id': taskId,
        'x-e-mate-trace-id': `trace-${taskId}`,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ model: route.id, input: [], stream: true, store: false }),
    });

  try {
    assert.equal((await invoke(sessionToken, 'session-disabled')).status, 403);
    enabled = true;
    assert.equal((await fetch(`${baseUrl}/v1/models`, { headers: auth() })).status, 200);
    const enabledResponse = await invoke(sessionToken, 'session-enabled');
    assert.equal(enabledResponse.status, 200);
    await enabledResponse.text();
    enabled = false;
    assert.equal((await invoke(sessionToken, 'session-disabled-again')).status, 403);
    enabled = true;
    assert.equal((await fetch(`${baseUrl}/v1/models`, { headers: auth(otherToken) })).status, 403);
    assert.equal((await invoke(otherToken, 'credential-remains-scoped')).status, 403);
    assert.equal(upstreamRequests.length, 1);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('fails closed when the tenant route policy cannot be read', async () => {
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const catalog = await fetch(`${baseUrl}/v1/models`, { headers: auth() });
      assert.equal(catalog.status, 503);
      assert.equal((await catalog.json()).error.code, 'MODEL_POLICY_UNAVAILABLE');

      const response = await modelRequest(baseUrl);
      assert.equal(response.status, 503);
      assert.equal(upstreamRequests.length, 0);
    },
    undefined,
    undefined,
    undefined,
    limits,
    route,
    {
      async isEnabled() {
        throw new Error('database unavailable');
      },
    }
  );
});

test('uses a fresh tenant key for new requests without interrupting an in-flight request', async () => {
  let currentKey = 'tenant-provider-key-before-rotation';
  let firstStartedResolve!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    firstStartedResolve = resolve;
  });
  let releaseFirstResolve!: () => void;
  const releaseFirst = new Promise<void>((resolve) => {
    releaseFirstResolve = resolve;
  });
  const policy: TenantModelRoutePolicy = {
    isEnabled: async () => true,
    upstreamApiKey: async () => currentKey,
  };
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const first = modelRequest(baseUrl, responseHeaders(), 'before rotation');
      await firstStarted;
      currentKey = 'tenant-provider-key-after-rotation';
      const second = await modelRequest(
        baseUrl,
        {
          ...responseHeaders(),
          session_id: 'session-2',
          'x-client-request-id': 'session-2',
          'x-e-mate-task-id': 'task-2',
          'x-e-mate-trace-id': 'trace-2',
        },
        'after rotation'
      );
      assert.equal(second.status, 200);
      releaseFirstResolve();
      assert.equal((await first).status, 200);
      assert.equal(upstreamRequests[0]?.headers.get('authorization'), 'Bearer tenant-provider-key-before-rotation');
      assert.equal(upstreamRequests[1]?.headers.get('authorization'), 'Bearer tenant-provider-key-after-rotation');
    },
    async (_request, index) => {
      if (index === 1) {
        firstStartedResolve();
        await releaseFirst;
      }
      return completedSse(10, 5, `response-${index}`);
    },
    undefined,
    undefined,
    { ...limits, tenantMaxConcurrent: 2 },
    route,
    policy
  );
});

test('keeps non-default routes denied until the tenant explicitly enables them', async () => {
  const enterpriseRoute: ModelGatewayRoute = {
    ...route,
    id: 'gpt-5.6-enterprise',
    upstreamModelId: 'provider-enterprise',
    label: 'Enterprise',
    buttonLabel: 'Enterprise',
  };
  const requestEnterprise = (baseUrl: string) =>
    fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: responseHeaders(),
      body: JSON.stringify({
        model: enterpriseRoute.id,
        input: [{ role: 'user', content: 'hello' }],
        stream: true,
        store: false,
      }),
    });

  await withGateway(
    async (baseUrl, upstreamRequests) => {
      assert.equal((await fetch(`${baseUrl}/v1/models`, { headers: auth() })).status, 403);
      assert.equal((await requestEnterprise(baseUrl)).status, 403);
      assert.equal(upstreamRequests.length, 0);
    },
    undefined,
    undefined,
    undefined,
    limits,
    enterpriseRoute
  );

  await withGateway(
    async (baseUrl, upstreamRequests) => {
      assert.equal((await fetch(`${baseUrl}/v1/models`, { headers: auth() })).status, 200);
      assert.equal((await requestEnterprise(baseUrl)).status, 200);
      assert.equal(upstreamRequests.length, 1);
    },
    undefined,
    undefined,
    undefined,
    limits,
    enterpriseRoute,
    { isEnabled: async () => true }
  );
});

function compactionRequest(baseUrl: string, input: unknown[], headers = responseHeaders()): Promise<Response> {
  return fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'gpt-5.6-sol',
      input,
      stream: true,
      store: false,
      reasoning: { effort: 'medium', summary: 'auto' },
    }),
  });
}

const auth = (token = sessionToken): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

function testCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(testCanonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${testCanonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) as string;
}

function auditUsageRecord(
  eventSeq = 1,
  overrides: Record<string, unknown> = {}
): { fact_id: string; payload_sha256: string; payload: Record<string, unknown> } {
  const sessionIdSha256 = createHash('sha256').update('session-a').digest('hex');
  const sourceId = `harness:${sessionIdSha256}:${eventSeq}`;
  const payload = {
    schema_version: 1,
    source_service: 'e-mate-audit',
    source_id: sourceId,
    usage_kind: 'chat',
    session_id_sha256: sessionIdSha256,
    event_seq: eventSeq,
    turn: 1,
    step: eventSeq,
    provider_created_at: new Date().toISOString(),
    requested_model_id: route.id,
    actual_model_id: route.id,
    actual_provider_id: 'e-mate-enterprise',
    input_tokens: 3,
    output_tokens: 4,
    cache_read_tokens: 2,
    cache_write_tokens: 2,
    reasoning_tokens: 1,
    total_tokens: 11,
    account_subject_sha256: createHash('sha256').update('tenant-a:user-a').digest('hex'),
    policy_revision: 1,
    policy_receipt_id: 'policy-receipt-1',
    policy_sha256: 'a'.repeat(64),
    ...overrides,
  };
  return {
    fact_id: `auditfact_${createHash('sha256').update(`e-Mate audit v1\0${sourceId}`).digest('hex')}`,
    payload_sha256: createHash('sha256').update(testCanonicalJson(payload)).digest('hex'),
    payload,
  };
}

function auditTaskRecord(
  task = 1,
  sequence = 0,
  type = 'RECEIVED',
  overrides: Record<string, unknown> = {}
) {
  const taskId = `task_${createHash('sha256').update(`test-task:${task}`).digest('hex')}`;
  const eventId = `taskevent_${createHash('sha256').update(`test-task:${task}:${sequence}:${type}`).digest('hex')}`;
  const payload = {
    schemaVersion: 1,
    eventId,
    taskId,
    type,
    scenario: 'GENERAL',
    occurredAt: new Date(Date.now() - 10_000 + sequence).toISOString(),
    ...overrides,
  };
  return {
    event_id: eventId,
    account_subject_sha256: createHash('sha256').update('tenant-a:user-a').digest('hex'),
    payload_sha256: createHash('sha256').update(testCanonicalJson(payload)).digest('hex'),
    payload,
  };
}

const consentPolicy = {
  schemaVersion: 1,
  agreementId: 'e-mate-platform-terms',
  agreementVersion: '1.0.0',
  disclaimerVersion: '1.0.0',
  contentHash: 'a'.repeat(64),
} as const;

const consentInput = {
  ...consentPolicy,
  termsAccepted: true,
  policyRead: true,
  lawfulUseConfirmed: true,
  clientVersion: '2.1.45',
  locale: 'zh-CN',
} as const;

test('session-authenticated consent status and acceptance are strict, idempotent and tenant scoped', async () => {
  const consentStore = new InMemoryConsentStore(consentPolicy, () => Date.parse('2026-08-02T01:02:03.000Z'));
  const server = createModelGatewayServer({
    routes: [route],
    authenticate: async (token) =>
      token === sessionToken
        ? principal('tenant-a', 'user-a')
        : token === otherToken
          ? principal('tenant-b', 'user-b')
          : null,
    consentStore,
    usageStore: new InMemoryUsageStore(limits),
    usageKeyId: 'usage-2026',
    usagePrivateKey: privateKey,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${baseUrl}/v1/consents/current`)).status, 401);
    const current = await fetch(`${baseUrl}/v1/consents/current`, { headers: auth() });
    assert.equal(current.status, 200);
    assert.equal(((await current.json()) as { required: boolean }).required, true);
    assert.equal(
      (
        await fetch(`${baseUrl}/v1/consents/accept`, {
          method: 'POST',
          headers: { ...auth(), 'content-type': 'application/json' },
          body: JSON.stringify({ ...consentInput, userId: 'user-b' }),
        })
      ).status,
      400
    );
    const stale = await fetch(`${baseUrl}/v1/consents/accept`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ ...consentInput, disclaimerVersion: '0.9.0' }),
    });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { error: { code: string } }).error.code, 'CONSENT_POLICY_CHANGED');
    const accepted = await fetch(`${baseUrl}/v1/consents/accept`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify(consentInput),
    });
    assert.equal(accepted.status, 200);
    const first = (await accepted.json()) as { acceptanceId: string; userId: string; acceptedAt: string };
    assert.equal(first.userId, 'user-a');
    const replay = await fetch(`${baseUrl}/v1/consents/accept`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ ...consentInput, clientVersion: '2.1.46' }),
    });
    assert.deepEqual(await replay.json(), first);
    assert.equal(
      (
        (await (await fetch(`${baseUrl}/v1/consents/current`, { headers: auth(otherToken) })).json()) as {
          required: boolean;
        }
      ).required,
      true
    );
    assert.equal((await fetch(`${baseUrl}/v1/consents/current`, { method: 'POST', headers: auth() })).status, 405);
    assert.equal((await fetch(`${baseUrl}/v1/consents/accept`, { headers: auth() })).status, 405);
    assert.equal((await fetch(`${baseUrl}/v1/consents/current?userId=user-b`, { headers: auth() })).status, 400);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('blocks every user model capability until the current consent is accepted', async () => {
  const consentStore = new InMemoryConsentStore(consentPolicy);
  let upstreamRequests = 0;
  const server = createModelGatewayServer({
    routes: [route, imageRoute],
    authenticate: async (token) => (token === sessionToken ? principal('tenant-a', 'user-a') : null),
    consentStore,
    usageStore: new InMemoryUsageStore(limits),
    usageKeyId: 'usage-2026',
    usagePrivateKey: privateKey,
    fetchImplementation: async () => {
      upstreamRequests += 1;
      return completedSse(10, 5);
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const requests = [
      fetch(`${baseUrl}/v1/models`, { headers: auth() }),
      modelRequest(baseUrl),
      fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: responseHeaders(),
        body: JSON.stringify({ model: chatRoute.id, messages: [] }),
      }),
      imageRequest(baseUrl),
      imageEditRequest(baseUrl),
    ];
    const responses = await Promise.all(requests);
    assert.deepEqual(
      responses.map(({ status }) => status),
      [403, 403, 403, 403, 403]
    );
    assert.deepEqual(
      await Promise.all(
        responses.map(async (response) => ((await response.json()) as { error: { code: string } }).error.code)
      ),
      ['CONSENT_REQUIRED', 'CONSENT_REQUIRED', 'CONSENT_REQUIRED', 'CONSENT_REQUIRED', 'CONSENT_REQUIRED']
    );
    assert.equal(upstreamRequests, 0);

    const accepted = await fetch(`${baseUrl}/v1/consents/accept`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify(consentInput),
    });
    assert.equal(accepted.status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/models`, { headers: auth() })).status, 200);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('administrators use the model catalog without signing the user agreement', async () => {
  const server = createModelGatewayServer({
    routes: [route],
    authenticate: async (token) => token === sessionToken
      ? { ...principal('tenant-a', 'admin-a'), roles: ['TENANT_ADMIN'] }
      : token === otherToken ? { ...principal('tenant-a', 'auditor-a'), roles: ['AUDIT_ADMIN'] } : null,
    consentStore: new InMemoryConsentStore(consentPolicy),
    usageStore: new InMemoryUsageStore(limits),
    usageKeyId: 'usage-2026',
    usagePrivateKey: privateKey,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${baseUrl}/v1/models`, { headers: auth() })).status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/models`, { headers: auth(otherToken) })).status, 200);
    const consent = (await (
      await fetch(`${baseUrl}/v1/consents/current`, { headers: auth() })
    ).json()) as { required: boolean };
    assert.equal(consent.required, true);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('fails closed when the consent store is unavailable', async () => {
  const server = createModelGatewayServer({
    routes: [route],
    authenticate: async (token) =>
      token === sessionToken ? { ...principal('tenant-a', 'user-a'), sessionId: 'auth-session-1' } : null,
    usageStore: new InMemoryUsageStore(limits),
    usageKeyId: 'usage-2026',
    usagePrivateKey: privateKey,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${baseUrl}/v1/models`, { headers: auth() });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'CONSENT_STORE_UNAVAILABLE');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

const responseHeaders = (): Record<string, string> => ({
  ...auth(),
  'content-type': 'application/json',
  session_id: 'session-1',
  'x-client-request-id': 'session-1',
  'x-e-mate-task-id': 'task-1',
  'x-e-mate-trace-id': 'trace-1',
});

const codexResponseHeaders = (overrides: Record<string, string> = {}): Record<string, string> => ({
  ...auth(),
  'content-type': 'application/json',
  'session-id': 'codex-session-1',
  'thread-id': 'codex-thread-1',
  'x-client-request-id': 'codex-thread-1',
  'x-codex-turn-metadata': JSON.stringify({
    request_kind: 'turn',
    session_id: 'codex-session-1',
    thread_id: 'codex-thread-1',
    turn_id: 'codex-turn-1',
  }),
  ...overrides,
});

function modelRequest(
  baseUrl: string,
  headers = responseHeaders(),
  content = 'hello',
  tools?: Array<Record<string, unknown>>
): Promise<Response> {
  return fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'gpt-5.6-sol',
      input: [{ role: 'user', content }],
      stream: true,
      store: false,
      reasoning: { effort: 'medium', summary: 'auto' },
      ...(tools ? { tools } : {}),
    }),
  });
}

function imageRequest(
  baseUrl: string,
  body: Record<string, unknown> = {
    model: imageRoute.id,
    prompt: 'A blue circle on white.',
    size: '1024x1024',
  },
  headers = responseHeaders()
): Promise<Response> {
  return fetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function imageEditRequest(
  baseUrl: string,
  form = (() => {
    const value = new FormData();
    value.set('model', imageRoute.id);
    value.set('prompt', 'Keep the subject and change the background.');
    value.set('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'input.png');
    return value;
  })(),
  scope = 'edit-1'
): Promise<Response> {
  const headers = responseHeaders();
  delete headers['content-type'];
  headers.session_id = `session-${scope}`;
  headers['x-client-request-id'] = `session-${scope}`;
  headers['x-e-mate-task-id'] = `task-${scope}`;
  headers['x-e-mate-trace-id'] = `trace-${scope}`;
  return fetch(`${baseUrl}/v1/images/edits`, { method: 'POST', headers, body: form });
}

function interruptedSse(): Response {
  return new Response('data: {"type":"response.in_progress"}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('accepts the pinned Harness pi-ai native session headers without a second transport adapter', async () => {
  await withGateway(async (baseUrl, upstreamRequests) => {
    const response = await modelRequest(baseUrl, {
      ...auth(),
      'content-type': 'application/json',
      session_id: 'harness-session-207',
      'x-client-request-id': 'harness-session-207',
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(upstreamRequests.length, 1);
    const upstreamBody = JSON.parse(await upstreamRequests[0]!.text()) as {
      reasoning: { effort: string; summary: string };
    };
    assert.equal(upstreamBody.reasoning.effort, 'medium');

    const usageResponse = await fetch(`${baseUrl}/v1/usage/current`, { headers: auth() });
    assert.equal(usageResponse.status, 200);
    const usage = (await usageResponse.json()) as {
      schemaVersion: number;
      totalTokens: number;
      weekStartedAt: string;
      calculatedAt: string;
    };
    assert.equal(usage.schemaVersion, 1);
    assert.equal(usage.totalTokens, 15);
    assert.equal(Number.isNaN(Date.parse(usage.weekStartedAt)), false);
    assert.equal(Number.isNaN(Date.parse(usage.calculatedAt)), false);
  });
});

test('serves strict private-free usage activity with a weak ETag and typed unavailability', async () => {
  const now = Date.parse('2024-02-29T12:00:00.000Z');
  const usageStore = new InMemoryUsageStore(limits, () => now);
  await usageStore.add({
    tenantId: 'tenant-a',
    userId: 'user-a',
    taskId: 'activity-task',
    traceId: 'activity-trace',
    modelId: route.id,
    providerId: route.providerId,
    providerResponseId: 'activity-response',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    costUsd: 0,
  });
  await withGateway(async baseUrl => {
    const path = '/v1/usage/activity?timezone=UTC&start_date=2024-02-29&end_date=2024-02-29';
    const response = await fetch(`${baseUrl}${path}`, { headers: auth() });
    assert.equal(response.status, 200);
    const etag = response.headers.get('etag');
    assert.match(etag ?? '', /^W\/".+"$/u);
    const activity = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(activity).sort(), [
      'calculatedAt', 'days', 'endDate', 'periodTotal', 'schemaVersion', 'startDate', 'timezone',
    ]);
    assert.equal(activity.periodTotal, '18');
    assert.doesNotMatch(
      JSON.stringify(activity),
      /account|subject|prompt|session|title|file|tool|plugin|content/i,
    );
    assert.equal((await fetch(`${baseUrl}${path}`, {
      headers: { ...auth(), 'if-none-match': etag as string },
    })).status, 304);

    for (const invalid of [
      '/v1/usage/activity?timezone=UTC%2B8&start_date=2024-02-29&end_date=2024-02-29',
      '/v1/usage/activity?timezone=UTC&start_date=2023-02-29&end_date=2023-02-29',
      '/v1/usage/activity?timezone=UTC&start_date=2023-01-01&end_date=2024-01-02',
      '/v1/usage/activity?timezone=UTC&start_date=2024-02-29&end_date=2024-02-29&user_id=user-b',
    ]) {
      const rejected = await fetch(`${baseUrl}${invalid}`, { headers: auth() });
      assert.equal(rejected.status, 400);
      assert.equal(
        ((await rejected.json()) as { error: { code: string } }).error.code,
        'INVALID_USAGE_ACTIVITY_QUERY',
      );
    }
    assert.equal((await fetch(`${baseUrl}${path}`, { method: 'POST', headers: auth() })).status, 405);

    usageStore.accountUsageActivity = async () => { throw new Error('private database detail'); };
    const unavailable = await fetch(`${baseUrl}${path}`, { headers: auth() });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      error: { code: 'USAGE_ACTIVITY_UNAVAILABLE', message: 'Usage activity temporarily unavailable' },
    });
  }, undefined, undefined, undefined, limits, route, undefined, usageStore);
});

test('proxies only an authorized medium request and returns signed aggregate usage', async () => {
  await withGateway(async (baseUrl, upstreamRequests) => {
    const catalogResponse = await fetch(`${baseUrl}/v1/models`, {
      headers: auth(),
    });
    assert.equal(catalogResponse.status, 200);
    const catalog = (await catalogResponse.json()) as {
      models: Array<Record<string, unknown>>;
      data: Array<{
        id: string;
        capabilities: { input: string[]; reasoning: boolean; toolCalling: boolean; imageGeneration: boolean };
      }>;
    };
    assert.equal(catalog.models[0]?.id, 'gpt-5.6-sol');
    assert.deepEqual(catalog.data, [
      {
        id: 'gpt-5.6-sol',
        capabilities: {
          input: ['text', 'image'],
          reasoning: true,
          toolCalling: true,
          imageGeneration: false,
        },
      },
    ]);
    assert.equal(JSON.stringify(catalog).includes(route.upstreamApiKey), false);
    assert.equal(JSON.stringify(catalog).includes(route.upstreamBaseUrl), false);

    const cliCatalogResponse = await fetch(`${baseUrl}/v1/models?client_version=0.146.0`, {
      headers: auth(),
    });
    assert.equal(cliCatalogResponse.status, 200);
    const cliCatalog = (await cliCatalogResponse.json()) as {
      models: Array<Record<string, unknown>>;
    };
    assert.deepEqual(
      cliCatalog.models.map(({ slug }) => slug),
      ['gpt-5.6-sol']
    );
    assert.equal(cliCatalog.models[0]?.supports_reasoning_summary_parameter, true);
    assert.equal(typeof cliCatalog.models[0]?.base_instructions, 'string');
    assert.equal(String(cliCatalog.models[0]?.base_instructions).includes('Never fabricate'), true);
    assert.equal(String(cliCatalog.models[0]?.base_instructions).includes('Codex'), false);
    assert.equal(String(cliCatalog.models[0]?.base_instructions).includes('Aion'), false);
    assert.deepEqual(cliCatalog.models[0]?.truncation_policy, { mode: 'tokens', limit: 10_000 });
    assert.equal(cliCatalog.models[0]?.auto_compact_token_limit, null);
    assert.deepEqual(cliCatalog.models[0]?.supported_reasoning_levels, [
      { effort: 'medium', description: route.buttonLabel },
    ]);

    const tools = [
      {
        type: 'function',
        name: 'create_document',
        description: 'Create a document',
        parameters: { type: 'object', properties: {} },
      },
    ];
    for (let round = 0; round < 2; round += 1) {
      const modelResponse = await modelRequest(
        baseUrl,
        responseHeaders(),
        `hello-${round}`,
        round === 0 ? tools : undefined
      );
      assert.equal(modelResponse.status, 200);
      assert.match(await modelResponse.text(), /response\.completed/);
    }

    assert.equal(upstreamRequests.length, 2);
    assert.equal(upstreamRequests[0]?.headers.get('authorization'), `Bearer ${route.upstreamApiKey}`);
    const forwarded = (await upstreamRequests[0]?.json()) as Record<string, unknown>;
    assert.equal(forwarded.model, route.upstreamModelId);
    assert.deepEqual(forwarded.tools, tools);

    const receiptResponse = await fetch(`${baseUrl}/v1/usage/task-1`, {
      headers: auth(),
    });
    assert.equal(receiptResponse.status, 200);
    const envelope = (await receiptResponse.json()) as Record<string, unknown>;
    const payload = Buffer.from(String(envelope.payload), 'base64url');
    assert.equal(verify(null, payload, publicKey, Buffer.from(String(envelope.signature), 'base64url')), true);
    const usage = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
    assert.deepEqual(
      {
        taskId: usage.taskId,
        traceId: usage.traceId,
        modelId: usage.modelId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        totalTokens: usage.totalTokens,
      },
      {
        taskId: 'task-1',
        traceId: 'trace-1',
        modelId: 'gpt-5.6-sol',
        inputTokens: 14,
        outputTokens: 10,
        cacheReadTokens: 4,
        cacheWriteTokens: 2,
        totalTokens: 30,
      }
    );
  });
});

test('adapts Chat Completions through the accounted Responses stream', async () => {
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const headers = {
        ...responseHeaders(),
        'x-e-mate-task-id': 'task-chat',
        'x-e-mate-trace-id': 'trace-chat',
      };
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: chatRoute.id,
          instructions: 'You are 小芯.',
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: '你好' }],
            },
          ],
          max_output_tokens: 32,
          stream: true,
          store: false,
        }),
      });
      assert.equal(response.status, 200);
      const stream = await response.text();
      assert.match(stream, /response\.output_text\.delta/);
      assert.match(stream, /response\.completed/);
      assert.equal(upstreamRequests.length, 1);
      assert.equal(new URL(upstreamRequests[0]?.url ?? '').pathname, '/v1/chat/completions');
      const upstreamBody = (await upstreamRequests[0]?.json()) as {
        model: string;
        max_tokens: number;
        messages: Array<{ role: string; content: string }>;
        stream_options: unknown;
      };
      assert.equal(upstreamBody.model, 'deepseek-chat');
      assert.equal(upstreamBody.max_tokens, 32);
      assert.deepEqual(upstreamBody.messages, [
        { role: 'system', content: 'You are 小芯.' },
        { role: 'user', content: '你好' },
      ]);
      assert.deepEqual(upstreamBody.stream_options, { include_usage: true });

      const usageResponse = await fetch(`${baseUrl}/v1/usage/task-chat`, { headers: auth() });
      assert.equal(usageResponse.status, 200);
      const envelope = (await usageResponse.json()) as Record<string, unknown>;
      const usage = JSON.parse(Buffer.from(String(envelope.payload), 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
      assert.equal(usage.inputTokens, 11);
      assert.equal(usage.outputTokens, 3);
      assert.equal(usage.providerId, 'deepseek');
    },
    () => completedChatSse(11, 3),
    undefined,
    undefined,
    limits,
    chatRoute,
    { isEnabled: async () => true }
  );
});

test('keeps an interrupted Chat Completions invocation pending without upstream DONE', async () => {
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const headers = {
        ...responseHeaders(),
        'x-e-mate-task-id': 'task-chat-interrupted',
        'x-e-mate-trace-id': 'trace-chat-interrupted',
      };
      const body = JSON.stringify({
        model: chatRoute.id,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '你好' }],
          },
        ],
        stream: true,
        store: false,
      });
      const send = (): Promise<Response> =>
        fetch(`${baseUrl}/v1/responses`, {
          method: 'POST',
          headers,
          body,
        });
      const response = await send();
      assert.equal(response.status, 200);
      assert.match(await response.text(), /UPSTREAM_STREAM_FAILED/);
      assert.equal(upstreamRequests.length, 1);

      const retry = await send();
      assert.equal(retry.status, 409);
      assert.match(JSON.stringify(await retry.json()), /INVOCATION_RECONCILIATION_REQUIRED/);
      assert.equal(upstreamRequests.length, 1);
    },
    () =>
      new Response(
        'data: {"id":"chat-interrupted","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      ),
    undefined,
    undefined,
    limits,
    chatRoute,
    { isEnabled: async () => true }
  );
});



test('correlates batch image stages and rejects mismatched optional scope before provider submission', async () => {
  const observations: ImageObservation[] = [];
  const taskId = 'sha256:' + 'a'.repeat(64);
  const traceId = 'image-' + 'a'.repeat(64);
  const batchId = 'sha256:' + 'b'.repeat(64);
  const headers = {
    ...responseHeaders(),
    session_id: traceId,
    'x-client-request-id': traceId,
    'x-e-mate-task-id': taskId,
    'x-e-mate-trace-id': traceId,
    'x-e-mate-batch-id': batchId,
    'x-e-mate-batch-ordinal': '2',
  };
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const generated = await imageRequest(baseUrl, undefined, headers);
      assert.equal(generated.status, 200);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(observations.map(({ stage }) => stage), [
        'admission_decision', 'provider_submit', 'provider_outcome', 'client_response',
      ]);
      for (const event of observations) {
        assert.deepEqual(
          { trace_id: event.trace_id, client_request_id: event.client_request_id, task_id: event.task_id, batch_id: event.batch_id, ordinal: event.ordinal },
          { trace_id: traceId, client_request_id: traceId, task_id: taskId, batch_id: batchId, ordinal: 2 }
        );
        assert(event.duration_ms >= 0 && event.duration_ms <= 600_000);
      }
      const mismatched = await imageRequest(baseUrl, { model: imageRoute.id, prompt: 'must not submit' }, {
        ...headers, 'x-e-mate-batch-ordinal': '3', 'x-e-mate-trace-id': 'wrong-trace',
      });
      assert.equal(mismatched.status, 400);
      assert.equal(upstreamRequests.length, 1);
    },
    () => Response.json({
      data: [{ b64_json: 'aGVsbG8=' }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
    undefined, undefined, limits, imageRoute, { isEnabled: async () => true },
    new InMemoryUsageStore(limits),
    event => observations.push(event)
  );
});

test('observes only executable admission and classifies every provider boundary conservatively', async () => {
  const runCase = async ({ response, prepare, complete, expected, status }: {
    response?: () => Response | Promise<Response>;
    prepare?: UsageStore['prepare'];
    complete?: UsageStore['complete'];
    expected: string;
    status: number;
  }) => {
    const observations: ImageObservation[] = [];
    const store = new InMemoryUsageStore(limits);
    if (prepare) store.prepare = prepare;
    if (complete) store.complete = complete;
    await withGateway(
      async (baseUrl) => {
        const result = await imageRequest(baseUrl);
        assert.equal(result.status, status);
        await new Promise(resolve => setImmediate(resolve));
        const admitted = observations.filter(event => event.stage === 'admission_decision' && event.outcome === 'admitted');
        if (expected === 'preflight' || expected === 'rate_limited') assert.equal(admitted.length, 0);
        assert.equal(observations.at(-1)?.stage, 'client_response');
        assert.equal(observations.at(-1)?.failure_code, expected);
      },
      response,
      undefined, undefined, limits, imageRoute, { isEnabled: async () => true }, store,
      event => observations.push(event)
    );
  };
  await runCase({
    prepare: async () => { throw new InvocationAdmissionError('TENANT_CONCURRENCY_LIMITED', 1_000); },
    expected: 'rate_limited', status: 429,
  });
  await runCase({
    prepare: async () => ({ status: 'PENDING', invocationId: 'pending-invocation' }),
    expected: 'preflight', status: 409,
  });
  await runCase({
    prepare: async () => { throw new InvocationRequestConflictError('conflict'); },
    expected: 'preflight', status: 409,
  });
  await runCase({
    prepare: async () => ({ status: 'RECORDED', invocationId: 'recorded-invocation' }),
    expected: 'preflight', status: 503,
  });
  await runCase({
    prepare: async () => { throw new Error('private database detail'); },
    expected: 'preflight', status: 503,
  });
  await runCase({ response: () => new Response('', { status: 400 }), expected: 'provider_rejected', status: 502 });
  await runCase({ response: () => new Response('', { status: 503 }), expected: 'provider_outcome_unknown', status: 502 });
  await runCase({ response: () => new Response('not json', { headers: { 'content-type': 'text/plain' } }), expected: 'provider_outcome_unknown', status: 502 });
  await runCase({ response: async () => { throw new Error('private network detail'); }, expected: 'provider_outcome_unknown', status: 502 });
  await runCase({
    response: async () => {
      const error = new DOMException('private timeout detail', 'TimeoutError') as DOMException & { definitelyNotSubmitted: true };
      error.definitelyNotSubmitted = true;
      throw error;
    },
    expected: 'provider_timeout_before_accept', status: 504,
  });
  await runCase({
    response: () => Response.json({ data: [{ b64_json: 'aGVsbG8=' }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
    complete: async () => { throw new Error('private usage journal detail'); },
    expected: 'provider_outcome_unknown', status: 503,
  });
});

test('an observation callback exception cannot change an image success response', async () => {
  await withGateway(
    async (baseUrl) => {
      const response = await imageRequest(baseUrl);
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as { data: unknown[] }).data.length, 1);
      await new Promise(resolve => setImmediate(resolve));
    },
    () => Response.json({
      data: [{ b64_json: 'aGVsbG8=' }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
    undefined, undefined, limits, imageRoute, { isEnabled: async () => true },
    new InMemoryUsageStore(limits),
    () => { throw new Error('private logger detail'); }
  );
});

test('exposes image generation only to the desktop catalog while proxying its dedicated API', async () => {
  const usageStore = new InMemoryUsageStore(limits);
  const finalize = usageStore.finalize.bind(usageStore);
  const finalizedTaskIds: string[] = [];
  usageStore.finalize = async (principal, taskId) => {
    finalizedTaskIds.push(taskId);
    return finalize(principal, taskId);
  };
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const catalogResponse = await fetch(`${baseUrl}/v1/models`, { headers: auth() });
      assert.equal(catalogResponse.status, 200);
      const catalog = (await catalogResponse.json()) as {
        models: Array<{ id: string }>;
        data: Array<{ id: string }>;
      };
      assert.deepEqual(
        catalog.models.map(({ id }) => id),
        ['gpt-image-2.5-flare']
      );
      assert.deepEqual(catalog.data, []);

      const cliCatalog = await fetch(`${baseUrl}/v1/models?client_version=0.146.0`, { headers: auth() });
      assert.equal(cliCatalog.status, 200);
      assert.deepEqual(((await cliCatalog.json()) as { models: unknown[] }).models, []);

      const generated = await imageRequest(baseUrl);
      assert.equal(generated.status, 200);
      const body = (await generated.json()) as {
        id: string;
        data: Array<{ b64_json: string }>;
      };
      assert.match(body.id, /^image-[A-Za-z0-9._:-]+$/);
      assert.equal(body.data[0]?.b64_json, 'aGVsbG8=');
      assert.deepEqual(finalizedTaskIds, ['task-1']);

      const replay = await imageRequest(baseUrl);
      assert.equal(replay.status, 409);
      assert.match(JSON.stringify(await replay.json()), /INVOCATION_RESULT_ALREADY_RECORDED/);
      assert.deepEqual(finalizedTaskIds, ['task-1', 'task-1']);

      assert.equal(upstreamRequests.length, 1);
      assert.equal(upstreamRequests[0]?.url, `${imageRoute.upstreamBaseUrl}/images/generations`);
      assert.equal(upstreamRequests[0]?.headers.get('authorization'), `Bearer ${imageRoute.upstreamApiKey}`);
      assert.match(upstreamRequests[0]?.headers.get('idempotency-key') ?? '', /^[A-Za-z0-9._:-]+$/);
      assert.deepEqual(await upstreamRequests[0]?.json(), {
        model: imageRoute.upstreamModelId,
        prompt: 'A blue circle on white.',
        size: '1024x1024',
        n: 1,
        response_format: 'b64_json',
      });

      const receiptResponse = await fetch(`${baseUrl}/v1/usage/task-1`, { headers: auth() });
      assert.equal(receiptResponse.status, 200);
      const envelope = (await receiptResponse.json()) as Record<string, unknown>;
      const payload = Buffer.from(String(envelope.payload), 'base64url');
      assert.equal(verify(null, payload, publicKey, Buffer.from(String(envelope.signature), 'base64url')), true);
      const usage = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
      assert.deepEqual(
        {
          modelId: usage.modelId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        },
        {
          modelId: imageRoute.id,
          inputTokens: 31,
          outputTokens: 229,
          totalTokens: 260,
        }
      );
    },
    () =>
      Response.json({
        model: 'gpt-image-2-codex',
        data: [{ b64_json: 'aGVsbG8=' }],
        usage: {
          input_tokens: 31,
          output_tokens: 229,
          total_tokens: 260,
          input_tokens_details: { image_tokens: 0, text_tokens: 31 },
          output_tokens_details: { image_tokens: 229, text_tokens: 0 },
        },
      }),
    undefined,
    undefined,
    limits,
    imageRoute,
    { isEnabled: async () => true },
    usageStore
  );
});

test('proxies Codex-like image edits through the same fixed Pro route and usage journal', async () => {
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const edited = await imageEditRequest(baseUrl);
      assert.equal(edited.status, 200);
      assert.equal(((await edited.json()) as { data: unknown[] }).data.length, 1);
      assert.equal(upstreamRequests.length, 1);
      const upstream = upstreamRequests[0] as Request;
      assert.equal(upstream.url, `${imageRoute.upstreamBaseUrl}/images/edits`);
      assert.match(upstream.headers.get('content-type') ?? '', /^multipart\/form-data; boundary=/i);
      const form = await upstream.formData();
      assert.equal(form.get('model'), imageRoute.upstreamModelId);
      assert.equal(form.get('prompt'), 'Keep the subject and change the background.');
      assert.equal(form.get('n'), '1');
      assert.equal(form.get('response_format'), 'b64_json');
      const image = form.get('image');
      assert.equal(typeof image === 'string', false);
      assert.equal((image as File).type, 'image/png');
      assert.deepEqual([...new Uint8Array(await (image as File).arrayBuffer())], [1, 2, 3]);
      assert.equal((await fetch(`${baseUrl}/v1/usage/task-edit-1`, { headers: auth() })).status, 200);
    },
    () => Response.json({
      data: [{ b64_json: 'aGVsbG8=' }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
    undefined,
    undefined,
    limits,
    imageRoute,
    { isEnabled: async () => true }
  );
});

test('admits only one simultaneous image POST for the same task and canonical request', async () => {
  let release!: () => void;
  let markPosted!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const posted = new Promise<void>((resolve) => { markPosted = resolve; });
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const first = imageRequest(baseUrl);
      await posted;
      const duplicate = await imageRequest(baseUrl);
      assert.equal(duplicate.status, 409);
      assert.match(JSON.stringify(await duplicate.json()), /INVOCATION_RECONCILIATION_REQUIRED/);
      assert.equal(upstreamRequests.length, 1);
      release();
      assert.equal((await first).status, 200);
    },
    async () => {
      markPosted();
      await held;
      return Response.json({
        data: [{ b64_json: 'aGVsbG8=' }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    },
    undefined,
    undefined,
    limits,
    imageRoute,
    { isEnabled: async () => true }
  );
});

test('conflicts the same image task identity with a different canonical request', async () => {
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      assert.equal((await imageRequest(baseUrl)).status, 502);
      const conflict = await imageRequest(baseUrl, {
        model: imageRoute.id,
        prompt: 'A red square on white.',
        size: '1024x1024',
      });
      assert.equal(conflict.status, 409);
      assert.match(JSON.stringify(await conflict.json()), /INVOCATION_REQUEST_CONFLICT/);
      assert.equal(upstreamRequests.length, 1);
    },
    () => new Response('provider unavailable', { status: 503 }),
    undefined,
    undefined,
    limits,
    imageRoute,
    { isEnabled: async () => true }
  );
});

test('reuses one durable image invocation key after definite rejection while keeping n=1', async () => {
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const rejected = await imageRequest(baseUrl);
      assert.equal(rejected.status, 502);
      assert.deepEqual(await rejected.json(), {
        error: {
          code: 'UPSTREAM_REJECTED',
          message: 'Image provider rejected the request',
        },
      });
      assert.equal((await fetch(`${baseUrl}/v1/usage/task-1`, { headers: auth() })).status, 404);
      assert.equal(
        ((await (await fetch(`${baseUrl}/v1/usage/current`, { headers: auth() })).json()) as { totalTokens: number }).totalTokens,
        0
      );
      assert.equal((await imageRequest(baseUrl)).status, 200);
      assert.equal(upstreamRequests.length, 2);
      assert.equal(
        upstreamRequests[1]?.headers.get('idempotency-key'),
        upstreamRequests[0]?.headers.get('idempotency-key')
      );
      for (const upstream of upstreamRequests) {
        const body = (await upstream.json()) as Record<string, unknown>;
        assert.equal(body.model, 'gpt-image-2.5-flare');
        assert.equal(body.n, 1);
      }
    },
    (_request, index) => index === 1
      ? new Response('provider rejected', { status: 404 })
      : Response.json({
          data: [{ b64_json: 'aGVsbG8=' }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
    undefined,
    undefined,
    limits,
    imageRoute,
    { isEnabled: async () => true }
  );
});

test('keeps ambiguous image network, timeout, 5xx, and invalid-success results PREPARED without a second POST', async () => {
  const failures: Array<{
    respond: (request: Request) => Response | Promise<Response>;
    timeoutMs?: number;
  }> = [
    { respond: async () => { throw new TypeError('network failed'); } },
    {
      respond: (request) => new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      }),
      timeoutMs: 1_000,
    },
    { respond: () => new Response('provider unavailable', { status: 503 }) },
    { respond: () => Response.json({ data: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }) },
  ];
  for (const failure of failures) {
    await withGateway(
      async (baseUrl, upstreamRequests) => {
        assert.ok([502, 503, 504].includes((await imageRequest(baseUrl)).status));
        assert.equal(
          ((await (await fetch(`${baseUrl}/v1/usage/current`, { headers: auth() })).json()) as { totalTokens: number }).totalTokens,
          0
        );
        assert.equal((await fetch(`${baseUrl}/v1/usage/task-1`, { headers: auth() })).status, 503);
        const retry = await imageRequest(baseUrl);
        assert.equal(retry.status, 409);
        assert.match(JSON.stringify(await retry.json()), /INVOCATION_RECONCILIATION_REQUIRED/);
        assert.equal(upstreamRequests.length, 1);
      },
      failure.respond,
      undefined,
      failure.timeoutMs,
      limits,
      imageRoute,
      { isEnabled: async () => true }
    );
  }
});

test('preserves an ambiguous image invocation across gateway restart without another POST', async () => {
  const usageStore = new InMemoryUsageStore(limits);
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      assert.equal((await imageRequest(baseUrl)).status, 502);
      assert.equal(upstreamRequests.length, 1);
    },
    () => new Response('provider unavailable', { status: 503 }),
    undefined,
    undefined,
    limits,
    imageRoute,
    { isEnabled: async () => true },
    usageStore
  );
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const retry = await imageRequest(baseUrl);
      assert.equal(retry.status, 409);
      assert.match(JSON.stringify(await retry.json()), /INVOCATION_RECONCILIATION_REQUIRED/);
      assert.equal(upstreamRequests.length, 0);
    },
    undefined,
    undefined,
    undefined,
    limits,
    imageRoute,
    { isEnabled: async () => true },
    usageStore
  );
});

test('isolates batch children as one n=1 charge each without a parent request or charge', async () => {
  const usageStore = new InMemoryUsageStore(limits);
  const batchId = `sha256:${'b'.repeat(64)}`;
  const childIds = ['a', 'c'].map((value) => `sha256:${value.repeat(64)}`);
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      for (const [index, taskId] of childIds.entries()) {
        const traceId = `image-${taskId.slice('sha256:'.length)}`;
        const headers = {
          ...responseHeaders(),
          session_id: traceId,
          'x-client-request-id': traceId,
          'x-e-mate-task-id': taskId,
          'x-e-mate-trace-id': traceId,
          'x-e-mate-batch-id': batchId,
          'x-e-mate-batch-ordinal': String(index + 1),
        };
        assert.equal((await imageRequest(baseUrl, undefined, headers)).status, 200);
        assert.equal((await imageRequest(baseUrl, undefined, headers)).status, 409);
        const firstReceipt = await fetch(`${baseUrl}/v1/usage/${taskId}`, { headers: auth() });
        const secondReceipt = await fetch(`${baseUrl}/v1/usage/${taskId}`, { headers: auth() });
        assert.equal(firstReceipt.status, 200);
        assert.deepEqual(await secondReceipt.json(), await firstReceipt.json());
      }
      assert.equal(upstreamRequests.length, 2);
      assert.notEqual(
        upstreamRequests[0]?.headers.get('idempotency-key'),
        upstreamRequests[1]?.headers.get('idempotency-key')
      );
      for (const upstream of upstreamRequests) {
        assert.equal(new URL(upstream.url).pathname, '/v1/images/generations');
        assert.equal(((await upstream.json()) as Record<string, unknown>).n, 1);
      }
      assert.equal((await fetch(`${baseUrl}/v1/usage/${batchId}`, { headers: auth() })).status, 404);
      assert.equal(
        ((await (await fetch(`${baseUrl}/v1/usage/current`, { headers: auth() })).json()) as { totalTokens: number }).totalTokens,
        4
      );
    },
    () => Response.json({
      data: [{ b64_json: 'aGVsbG8=' }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
    undefined,
    undefined,
    limits,
    imageRoute,
    { isEnabled: async () => true },
    usageStore
  );
});

test('local three-request bound leaves the configured fourth slot without gateway queue metadata', async () => {
  const admissionLimits = {
    tenantRequestsPerMinute: 100,
    tenantBurst: 100,
    tenantMaxConcurrent: 4,
    invocationLeaseMs: 180_000,
  };
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => { resolve = complete; });
    return { promise, resolve };
  };
  const held = Array.from({ length: 5 }, deferred);
  const posted = Array.from({ length: 5 }, deferred);
  const pending: Promise<Response>[] = [];

  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const send = (taskId: string) => {
        const request = imageRequest(baseUrl, undefined, {
          ...responseHeaders(),
          'x-e-mate-task-id': taskId,
          'x-e-mate-trace-id': `trace-${taskId}`,
        });
        pending.push(request);
        return request;
      };

      try {
        const batch = [1, 2, 3].map((ordinal) => send(`batch-task-${ordinal}`));
        await Promise.all(posted.slice(0, 3).map(({ promise }) => promise));

        const independent = send('independent-task');
        await posted[3]!.promise;
        assert.equal(upstreamRequests.length, 4);

        const limited = await send('overflow-task');
        assert.equal(limited.status, 429);
        assert.deepEqual(await limited.json(), {
          error: {
            code: 'TENANT_CONCURRENCY_LIMITED',
            message: 'Too many model requests are already running',
            retryAfterMs: 1_000,
          },
        });
        assert.equal(limited.headers.get('retry-after'), '1');
        assert.equal(upstreamRequests.length, 4);

        held[0]!.resolve();
        assert.equal((await batch[0]).status, 200);

        const next = send('next-distinct-task');
        await posted[4]!.promise;
        held[4]!.resolve();
        assert.equal((await next).status, 200);
        assert.equal(upstreamRequests.length, 5);
        assert.equal(new Set(upstreamRequests.map((request) => request.headers.get('idempotency-key'))).size, 5);
        for (const upstream of upstreamRequests) {
          assert.deepEqual(await upstream.json(), {
            model: imageRoute.upstreamModelId,
            prompt: 'A blue circle on white.',
            size: '1024x1024',
            n: 1,
            response_format: 'b64_json',
          });
        }

        held[1]!.resolve();
        held[2]!.resolve();
        held[3]!.resolve();
        const completed = await Promise.all([batch[1]!, batch[2]!, independent]);
        assert.deepEqual(completed.map(({ status }) => status), [200, 200, 200]);
      } finally {
        held.forEach(({ resolve }) => resolve());
        await Promise.allSettled(pending);
      }
    },
    async (_request, index) => {
      posted[index - 1]!.resolve();
      await held[index - 1]!.promise;
      return Response.json({
        data: [{ b64_json: 'aGVsbG8=' }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    },
    undefined,
    undefined,
    admissionLimits,
    imageRoute,
    { isEnabled: async () => true },
    new InMemoryUsageStore(admissionLimits, () => 1_000)
  );
});

test('uses existing batch headers to give a waiting single the next released image slot', async () => {
  let now = 0;
  const imageLimits = { tenantRequestsPerMinute: 1_000, tenantBurst: 1_000, tenantMaxConcurrent: 4, invocationLeaseMs: 600_000 };
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  };
  const held = Array.from({ length: 5 }, deferred);
  const posted = Array.from({ length: 5 }, deferred);
  const pending: Promise<Response>[] = [];
  await withGateway(async (baseUrl, upstreamRequests) => {
    const send = (ordinal?: number) => {
      const taskId = ordinal === undefined ? 'direct-single' : `sha256:${String(ordinal).repeat(64)}`;
      const traceId = ordinal === undefined ? 'trace-single' : `image-${taskId.slice(7)}`;
      const request = imageRequest(baseUrl, undefined, {
        ...responseHeaders(), session_id: traceId, 'x-client-request-id': traceId,
        'x-e-mate-task-id': taskId, 'x-e-mate-trace-id': traceId,
        ...(ordinal === undefined ? {} : { 'x-e-mate-batch-id': `sha256:${'a'.repeat(64)}`, 'x-e-mate-batch-ordinal': String(ordinal) }),
      });
      pending.push(request);
      return request;
    };
    try {
      const batch = [1, 2, 3, 4].map(send);
      await Promise.all(posted.slice(0, 4).map(value => value.promise));
      const first = await send();
      assert.equal(first.status, 429);
      assert.equal(first.headers.get('retry-after'), '1');
      assert.equal((await first.json() as { error: { retryAfterMs: number } }).error.retryAfterMs, 1_000);
      assert.equal((await fetch(`${baseUrl}/v1/usage/direct-single`, { headers: auth() })).status, 404);
      now = 10_000;
      held[0]!.resolve();
      assert.equal((await batch[0]!).status, 200);
      assert.equal((await send(5)).status, 429);
      assert.equal(upstreamRequests.length, 4);
      const single = send();
      await posted[4]!.promise;
      held[4]!.resolve();
      assert.equal((await single).status, 200);
      assert.equal((await send()).status, 409);
      assert.equal(upstreamRequests.length, 5);
    } finally {
      held.forEach(value => value.resolve());
      await Promise.allSettled(pending);
    }
  }, async (_request, index) => {
    posted[index - 1]!.resolve();
    await held[index - 1]!.promise;
    return Response.json({ data: [{ b64_json: 'aGVsbG8=' }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  }, undefined, undefined, imageLimits, imageRoute, { isEnabled: async () => true }, new InMemoryUsageStore(imageLimits, () => now));
});

test('keeps image and response APIs isolated and rejects extra image controls before upstream', async () => {
  const usageStore = new InMemoryUsageStore(limits);
  const prepare = usageStore.prepare.bind(usageStore);
  let prepareCalls = 0;
  usageStore.prepare = async (fact) => {
    prepareCalls += 1;
    return prepare(fact);
  };
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      assert.equal((await modelRequest(baseUrl)).status, 403);
      const generation = await imageRequest(baseUrl, {
        model: imageRoute.id,
        prompt: 'A blue circle.',
        n: 2,
      });
      assert.equal(generation.status, 400);
      assert.equal(((await generation.json()) as { error: { code: string } }).error.code, 'INVALID_MODEL_REQUEST');
      const edit = new FormData();
      edit.set('model', imageRoute.id);
      edit.set('prompt', 'Do not accept caller controls.');
      edit.set('quality', 'high');
      edit.set('image', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'input.png');
      const editResponse = await imageEditRequest(baseUrl, edit, 'edit-invalid');
      assert.equal(editResponse.status, 400);
      assert.equal(((await editResponse.json()) as { error: { code: string } }).error.code, 'INVALID_MODEL_REQUEST');
      assert.equal(prepareCalls, 0);
      assert.equal(upstreamRequests.length, 0);
    },
    undefined,
    undefined,
    undefined,
    limits,
    imageRoute,
    { isEnabled: async () => true },
    usageStore
  );
});

test('keeps remote compaction closed by default without exposing provider details', async () => {
  await withGateway(async (baseUrl, upstreamRequests) => {
    const catalogResponse = await fetch(`${baseUrl}/v1/models`, {
      headers: auth(),
    });
    const catalog = (await catalogResponse.json()) as {
      models: Array<Record<string, unknown>>;
    };
    assert.equal('remoteCompactionV2' in (catalog.models[0] ?? {}), false);

    const rejected = await compactionRequest(baseUrl, [
      { role: 'user', content: 'private conversation' },
      { type: 'compaction_trigger' },
    ]);
    assert.equal(rejected.status, 403);
    assert.deepEqual(await rejected.json(), {
      error: {
        code: 'REMOTE_COMPACTION_UNAVAILABLE',
        message: 'Remote compaction is not available',
      },
    });
    assert.equal(upstreamRequests.length, 0);
  });
});

test('routes an enabled remote compaction through the accounted invocation chain', async () => {
  const enabledRoute = { ...route, remoteCompactionV2: true };
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const catalogResponse = await fetch(`${baseUrl}/v1/models`, {
        headers: auth(),
      });
      const catalog = (await catalogResponse.json()) as {
        models: Array<Record<string, unknown>>;
      };
      assert.equal(catalog.models[0]?.remoteCompactionV2, true);

      const response = await compactionRequest(baseUrl, [
        { role: 'user', content: 'conversation' },
        { type: 'compaction_trigger' },
      ]);
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(upstreamRequests.length, 1);
      const upstream = upstreamRequests[0] as Request;
      assert.equal(upstream.headers.get('x-codex-beta-features'), 'remote_compaction_v2');
      assert.match(upstream.headers.get('idempotency-key') ?? '', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
      const body = (await upstream.json()) as Record<string, unknown>;
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      assert.deepEqual((body.reasoning as Record<string, unknown>).effort, 'medium');
      assert.deepEqual((body.input as unknown[]).at(-1), {
        type: 'compaction_trigger',
      });

      const usage = await fetch(`${baseUrl}/v1/usage/task-1`, {
        headers: auth(),
      });
      assert.equal(usage.status, 200);
    },
    undefined,
    undefined,
    undefined,
    limits,
    enabledRoute
  );
});

test('rejects malformed remote compaction before the provider journal', async () => {
  const enabledRoute = { ...route, remoteCompactionV2: true };
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      for (const input of [
        [{ type: 'compaction_trigger' }, { role: 'user', content: 'not last' }],
        [{ type: 'compaction_trigger' }, { type: 'compaction_trigger' }],
        [
          { role: 'user', content: 'conversation' },
          { type: 'compaction_trigger', extra: true },
        ],
      ]) {
        const response = await compactionRequest(baseUrl, input);
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), {
          error: {
            code: 'INVALID_COMPACTION_REQUEST',
            message: 'Invalid compaction request',
          },
        });
      }
      assert.equal(upstreamRequests.length, 0);
    },
    undefined,
    undefined,
    undefined,
    limits,
    enabledRoute
  );
});

test('only gpt-5.6-sol may enable remote compaction', () => {
  assert.throws(
    () =>
      createModelGatewayServer({
        routes: [
          {
            ...route,
            id: 'gpt-5.5',
            remoteCompactionV2: true,
          },
        ],
        authenticate: async () => principal('tenant-a', 'user-a'),
        usageStore: new InMemoryUsageStore(limits),
        usageKeyId: 'usage-2026',
        usagePrivateKey: privateKey,
      }),
    /Invalid Model Gateway route/
  );
});

test('requires the default Luna route to support high reasoning', () => {
  assert.throws(
    () =>
      createModelGatewayServer({
        routes: [
          {
            ...route,
            id: 'gpt-5.6-luna',
            reasoning: false,
          },
        ],
        authenticate: async () => principal('tenant-a', 'user-a'),
        usageStore: new InMemoryUsageStore(limits),
        usageKeyId: 'usage-2026',
        usagePrivateKey: privateKey,
      }),
    /Invalid Model Gateway route/
  );
});

test('Astra uses Responses low and cannot enable priority through a client request', async () => {
  const astra: ModelGatewayRoute = { ...route, id: 'gpt-6-astra', upstreamModelId: 'gpt-6-astra', apiMode: 'responses' };
  await withGateway(async (baseUrl, requests) => {
    const response = await fetch(`${baseUrl}/v1/responses`, { method: 'POST', headers: responseHeaders(),
      body: JSON.stringify({ model: astra.id, input: 'synthetic request', stream: true, store: false,
        reasoning: { effort: 'high' }, service_tier: 'priority' }) });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(requests.length, 1);
    const body = await requests[0]!.json() as Record<string, unknown>;
    assert.equal(body.model, astra.id);
    assert.deepEqual(body.reasoning, { effort: 'low' });
    assert.equal('service_tier' in body, false);
  }, undefined, undefined, undefined, limits, astra, { isEnabled: async () => true });
});

test('runtime and public catalogs keep old clients usable while Astra is visible to 2.0.18 only', async () => {
  const astra: ModelGatewayRoute = { ...route, id: 'gpt-6-astra', upstreamModelId: 'gpt-6-astra', apiMode: 'responses' };
  const identity = { tenantId: 'tenant-a', userId: 'user-a', sessionId: 'fixture-session', modelIds: [route.id, astra.id] };
  const consentStore = new InMemoryConsentStore(consentPolicy);
  await consentStore.accept(identity, consentInput);
  const server = createModelGatewayServer({ routes: [route, astra], publicBaseUrl: 'https://mvdcm.ecoremedia.net/e-mate/model-api',
    authenticate: async () => identity, consentStore, tenantModelRoutePolicy: { isEnabled: async () => true },
    usageStore: new InMemoryUsageStore(limits), usageKeyId: 'usage-2026', usagePrivateKey: privateKey });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer model.${'p'.repeat(32)}.signature` };
  try {
    for (const version of ['2.0.12', '2.0.13', '2.0.14', '2.0.15', '2.0.16', '2.0.17', '2.0.18']) {
      const response = await fetch(`${baseUrl}/v1/runtime-models?client_version=${version}`, { headers });
      assert.equal(response.status, 200);
      const body = await response.json() as { models: Array<{ id: string }> };
      assert.deepEqual(body.models.map(({ id }) => id), version === '2.0.18' ? [route.id, astra.id] : [route.id]);
    }
    const managed = await fetch(`${baseUrl}/v1/models?client_version=2.0.18`, {
      headers: { ...headers, 'x-e-mate-client-version': '2.0.18' },
    });
    assert.equal(managed.status, 200);
    const managedBody = await managed.json() as { models: Array<{ slug: string; default_reasoning_level: string; supported_reasoning_levels: Array<{ effort: string }> }> };
    const managedAstra = managedBody.models.find(model => model.slug === astra.id)!;
    assert.equal(managedAstra.default_reasoning_level, 'low');
    assert.deepEqual(managedAstra.supported_reasoning_levels.map(level => level.effort), ['low']);
    assert.equal(managedBody.models.find(model => model.slug === route.id)!.default_reasoning_level, 'medium');
    for (const version of [undefined, '2.0.17', '2.0.18']) {
      const response = await fetch(`${baseUrl}/v1/models`, { headers: { ...headers, ...(version ? { 'x-e-mate-client-version': version } : {}) } });
      assert.equal(response.status, 200);
      const body = await response.json() as { models: Array<{ id: string }> };
      assert.deepEqual(body.models.map(({ id }) => id), version === '2.0.18' ? [route.id, astra.id] : [route.id]);
    }
  } finally { server.close(); await once(server, 'close'); }
});

test('allows a pinned HTTP upstream only with a route-local opt-in and keeps it server-side', async () => {
  const httpRoute: ModelGatewayRoute = {
    ...route,
    upstreamBaseUrl: 'http://provider.example:8080/v1',
  };
  assert.throws(
    () =>
      createModelGatewayServer({
        routes: [httpRoute],
        authenticate: async () => principal('tenant-a', 'user-a'),
        usageStore: new InMemoryUsageStore(limits),
        usageKeyId: 'usage-2026',
        usagePrivateKey: privateKey,
      }),
    /Invalid Model Gateway route/
  );

  const optedInRoute = { ...httpRoute, allowInsecureHttpUpstream: true as const };
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const catalogResponse = await fetch(`${baseUrl}/v1/models`, { headers: auth() });
      assert.equal(catalogResponse.status, 200);
      const catalog = await catalogResponse.json();
      assert.equal(JSON.stringify(catalog).includes('allowInsecureHttpUpstream'), false);
      assert.equal(JSON.stringify(catalog).includes(optedInRoute.upstreamBaseUrl), false);

      const response = await modelRequest(baseUrl);
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(upstreamRequests[0]?.url, `${optedInRoute.upstreamBaseUrl}/responses`);
    },
    undefined,
    undefined,
    undefined,
    limits,
    optedInRoute
  );

  for (const upstreamBaseUrl of [
    'http://user:password@provider.example:8080/v1',
    'http://provider.example:8080/v1?api_key=forbidden',
    'http://[::1',
  ]) {
    assert.throws(
      () =>
        createModelGatewayServer({
          routes: [{ ...optedInRoute, upstreamBaseUrl }],
          authenticate: async () => principal('tenant-a', 'user-a'),
          usageStore: new InMemoryUsageStore(limits),
          usageKeyId: 'usage-2026',
          usagePrivateKey: privateKey,
        }),
      /Invalid Model Gateway route|Invalid URL/
    );
  }
});

test('accepts Luna with high reasoning through the enterprise route', async () => {
  const lunaRoute: ModelGatewayRoute = {
    ...route,
    id: 'gpt-5.6-luna',
    upstreamModelId: 'provider-luna',
    label: 'GPT-5.6 Luna',
    buttonLabel: 'GPT-5.6 Luna · 深度',
  };
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: responseHeaders(),
        body: JSON.stringify({
          model: 'gpt-5.6-luna',
          input: [{ role: 'user', content: '验证深度模型' }],
          stream: true,
          store: false,
          reasoning: { effort: 'high', summary: 'auto' },
        }),
      });
      assert.equal(response.status, 200);
      assert.equal(upstreamRequests.length, 1);
      assert.equal(
        (
          (await upstreamRequests[0].json()) as {
            reasoning: { effort: string };
          }
        ).reasoning.effort,
        'high'
      );
    },
    undefined,
    undefined,
    undefined,
    limits,
    lunaRoute
  );
});

test('forces Luna to high reasoning regardless of the client preference', async () => {
  const lunaRoute: ModelGatewayRoute = {
    ...route,
    id: 'gpt-5.6-luna',
    upstreamModelId: 'provider-luna',
    label: 'GPT-5.6 Luna',
    buttonLabel: 'GPT-5.6 Luna · 深度',
  };
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: responseHeaders(),
        body: JSON.stringify({
          model: 'gpt-5.6-luna',
          input: [],
          stream: true,
          store: false,
          reasoning: { effort: 'medium' },
        }),
      });
      assert.equal(response.status, 200);
      assert.equal(upstreamRequests.length, 1);
      const forwarded = (await upstreamRequests[0]?.json()) as { reasoning: { effort: string } };
      assert.equal(forwarded.reasoning.effort, 'high');
    },
    undefined,
    undefined,
    undefined,
    limits,
    lunaRoute
  );
});

test('does not repeat an invocation whose usage was recorded before delivery ended', async () => {
  await withGateway(async (baseUrl, upstreamRequests) => {
    const completed = await modelRequest(baseUrl);
    assert.equal(completed.status, 200);
    assert.match(await completed.text(), /response\.completed/);

    const retry = await modelRequest(baseUrl);
    assert.equal(retry.status, 409);
    assert.match(JSON.stringify(await retry.json()), /INVOCATION_RESULT_ALREADY_RECORDED/);
    assert.equal(upstreamRequests.length, 1);
  });
});

test('prepares an invocation before upstream and blocks an unknown retry', async () => {
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const interrupted = await modelRequest(baseUrl);
      assert.equal(interrupted.status, 200);
      assert.match(await interrupted.text(), /UPSTREAM_STREAM_FAILED/);
      assert.equal(upstreamRequests.length, 1);

      const retry = await modelRequest(baseUrl);
      assert.equal(retry.status, 409);
      assert.match(JSON.stringify(await retry.json()), /INVOCATION_RECONCILIATION_REQUIRED/);
      assert.equal(upstreamRequests.length, 1);
    },
    () => interruptedSse()
  );
});

test('rejects an unaccepted invocation so the same task can retry with one stable idempotency key', async () => {
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const rejected = await modelRequest(baseUrl);
      assert.equal(rejected.status, 502);
      const retried = await modelRequest(baseUrl);
      assert.equal(retried.status, 200);
      assert.match(await retried.text(), /response\.completed/);
      assert.equal(upstreamRequests.length, 2);
      const firstKey = upstreamRequests[0]?.headers.get('idempotency-key');
      assert.match(firstKey ?? '', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
      assert.equal(upstreamRequests[1]?.headers.get('idempotency-key'), firstKey);
    },
    (_request, index) =>
      index === 1 ? new Response('rate limited', { status: 429 }) : completedSse(10, 5, 'response-retried')
  );
});

test('keeps an ambiguous upstream failure pending instead of repeating it', async () => {
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const unavailable = await modelRequest(baseUrl);
      assert.equal(unavailable.status, 502);
      const retry = await modelRequest(baseUrl);
      assert.equal(retry.status, 409);
      assert.match(JSON.stringify(await retry.json()), /INVOCATION_RECONCILIATION_REQUIRED/);
      assert.equal(upstreamRequests.length, 1);
    },
    () => new Response('provider unavailable', { status: 503 })
  );
});

test('enforces tenant concurrency before a second provider request', async () => {
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      assert.equal((await modelRequest(baseUrl)).status, 200);
      const headers = {
        ...responseHeaders(),
        'x-e-mate-task-id': 'task-2',
        'x-e-mate-trace-id': 'trace-2',
      };
      const limited = await modelRequest(baseUrl, headers);
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get('retry-after'), '180');
      assert.match(JSON.stringify(await limited.json()), /TENANT_CONCURRENCY_LIMITED/);
      assert.equal(upstreamRequests.length, 1);
    },
    () => interruptedSse(),
    undefined,
    undefined,
    {
      tenantRequestsPerMinute: 10,
      tenantBurst: 10,
      tenantMaxConcurrent: 1,
      invocationLeaseMs: 180_000,
    }
  );
});

test('does not refund a provider attempt from the tenant rate bucket', async () => {
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      assert.equal((await modelRequest(baseUrl)).status, 502);
      const headers = {
        ...responseHeaders(),
        'x-e-mate-task-id': 'task-2',
        'x-e-mate-trace-id': 'trace-2',
      };
      const limited = await modelRequest(baseUrl, headers);
      assert.equal(limited.status, 429);
      assert.match(JSON.stringify(await limited.json()), /TENANT_REQUEST_RATE_LIMITED/);
      assert.equal(upstreamRequests.length, 1);
    },
    () => new Response('rate limited', { status: 429 }),
    undefined,
    undefined,
    {
      tenantRequestsPerMinute: 1,
      tenantBurst: 1,
      tenantMaxConcurrent: 10,
      invocationLeaseMs: 180_000,
    }
  );
});

test('reconciles a pending accounted invocation without a second model POST', async () => {
  const reconciliationRequests: Array<Record<string, unknown>> = [];
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const interrupted = await modelRequest(baseUrl);
      assert.equal(interrupted.status, 502);

      const reconciled = await modelRequest(baseUrl);
      assert.equal(reconciled.status, 409);
      assert.match(JSON.stringify(await reconciled.json()), /INVOCATION_RESULT_ALREADY_RECORDED/);
      assert.equal(upstreamRequests.length, 1);
      assert.equal('input' in (reconciliationRequests[0] ?? {}), false);
      assert.equal('tenantId' in (reconciliationRequests[0] ?? {}), false);
      assert.equal('userId' in (reconciliationRequests[0] ?? {}), false);
      assert.equal('taskId' in (reconciliationRequests[0] ?? {}), false);

      const receipt = await fetch(`${baseUrl}/v1/usage/task-1`, {
        headers: auth(),
      });
      assert.equal(receipt.status, 200);

      const exactRetry = await modelRequest(baseUrl);
      assert.equal(exactRetry.status, 409);
      assert.equal(upstreamRequests.length, 1);
    },
    () => new Response('provider unavailable', { status: 503 }),
    (request) => {
      reconciliationRequests.push(request);
      return {
        status: 'ACCOUNTED',
        invocationId: request.invocationId,
        requestDigest: request.requestDigest,
        routeFingerprint: request.routeFingerprint,
        response: {
          id: 'response-reconciled',
          model: route.upstreamModelId,
          status: 'completed',
          usage: {
            input_tokens: 8,
            output_tokens: 3,
            total_tokens: 11,
            input_tokens_details: {
              cached_tokens: 1,
              cache_write_tokens: 0,
            },
          },
        },
      };
    }
  );
});

test('retries a provider-confirmed unaccepted invocation with its original idempotency key', async () => {
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const rejected = await modelRequest(baseUrl);
      assert.equal(rejected.status, 502);

      const retried = await modelRequest(baseUrl);
      assert.equal(retried.status, 200);
      assert.match(await retried.text(), /response\.completed/);
      assert.equal(upstreamRequests.length, 2);
      assert.equal(
        upstreamRequests[1]?.headers.get('idempotency-key'),
        upstreamRequests[0]?.headers.get('idempotency-key')
      );
    },
    (_request, index) =>
      index === 1
        ? new Response('provider unavailable', { status: 503 })
        : completedSse(6, 4, 'response-retried-after-reconcile'),
    (request) => ({
      status: 'NOT_ACCEPTED',
      invocationId: request.invocationId,
      requestDigest: request.requestDigest,
      routeFingerprint: request.routeFingerprint,
    })
  );
});

test('keeps a contradictory not-accepted receipt pending', async () => {
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      assert.equal((await modelRequest(baseUrl)).status, 502);
      const contradictory = await modelRequest(baseUrl);
      assert.equal(contradictory.status, 409);
      assert.match(JSON.stringify(await contradictory.json()), /INVOCATION_RECONCILIATION_REQUIRED/);
      assert.equal(upstreamRequests.length, 1);
    },
    () => new Response('provider unavailable', { status: 503 }),
    (request) =>
      ({
        status: 'NOT_ACCEPTED',
        invocationId: request.invocationId,
        requestDigest: request.requestDigest,
        routeFingerprint: request.routeFingerprint,
        response: {
          id: 'response-contradictory',
          model: route.upstreamModelId,
          status: 'completed',
        },
      }) as unknown as ProviderInvocationReceipt
  );
});

test('keeps unknown reconciliation receipts pending', async () => {
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      assert.equal((await modelRequest(baseUrl)).status, 502);

      const unknown = await modelRequest(baseUrl);
      assert.equal(unknown.status, 409);
      assert.match(JSON.stringify(await unknown.json()), /INVOCATION_RECONCILIATION_REQUIRED/);
      assert.equal(upstreamRequests.length, 1);
    },
    () => new Response('provider unavailable', { status: 503 }),
    (request) => ({
      status: 'UNKNOWN',
      invocationId: request.invocationId,
      requestDigest: request.requestDigest,
      routeFingerprint: request.routeFingerprint,
    })
  );
});

test('renews a trusted pending provider receipt without another model post', async () => {
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      assert.equal((await modelRequest(baseUrl)).status, 502);
      const pending = await modelRequest(baseUrl);
      assert.equal(pending.status, 409);
      assert.match(JSON.stringify(await pending.json()), /INVOCATION_RECONCILIATION_REQUIRED/);
      assert.equal(upstreamRequests.length, 1);
    },
    () => new Response('provider unavailable', { status: 503 }),
    (request) => ({
      status: 'PENDING',
      invocationId: request.invocationId,
      requestDigest: request.requestDigest,
      routeFingerprint: request.routeFingerprint,
    })
  );
});

test('bounds a reconciliation adapter that ignores its abort signal', async () => {
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      assert.equal((await modelRequest(baseUrl)).status, 502);
      const startedAt = Date.now();
      const timedOut = await modelRequest(baseUrl);
      assert.equal(timedOut.status, 409);
      assert.match(JSON.stringify(await timedOut.json()), /INVOCATION_RECONCILIATION_REQUIRED/);
      assert(Date.now() - startedAt < 2_500);
      assert.equal(upstreamRequests.length, 1);
    },
    () => new Response('provider unavailable', { status: 503 }),
    () => new Promise<ProviderInvocationReceipt>(() => undefined),
    1_000
  );
});

test('keeps mismatched accounted reconciliation receipts pending', async () => {
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      assert.equal((await modelRequest(baseUrl)).status, 502);
      const mismatch = await modelRequest(baseUrl);
      assert.equal(mismatch.status, 409);
      assert.match(JSON.stringify(await mismatch.json()), /INVOCATION_RECONCILIATION_REQUIRED/);
      assert.equal(upstreamRequests.length, 1);
    },
    () => new Response('provider unavailable', { status: 503 }),
    (request) => ({
      status: 'ACCOUNTED',
      invocationId: `${request.invocationId}-mismatch`,
      requestDigest: request.requestDigest,
      routeFingerprint: request.routeFingerprint,
      response: {
        id: 'response-mismatch',
        model: route.upstreamModelId,
        status: 'completed',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: {
            cached_tokens: 0,
            cache_write_tokens: 0,
          },
        },
      },
    })
  );
});

test('overrides client reasoning while rejecting invalid scope and cross-tenant usage', async () => {
  await withGateway(async (baseUrl, upstreamRequests) => {
    const wrongReasoning = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: responseHeaders(),
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        input: [],
        stream: true,
        store: false,
        reasoning: { effort: 'high' },
      }),
    });
    assert.equal(wrongReasoning.status, 200);
    await wrongReasoning.text();
    const upstreamRequest = upstreamRequests[0];
    assert.ok(upstreamRequest);
    assert.equal(((await upstreamRequest.json()) as { reasoning: { effort: string } }).reasoning.effort, 'medium');

    const mismatchedSession = responseHeaders();
    mismatchedSession['x-client-request-id'] = 'session-2';
    const wrongScope = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: mismatchedSession,
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        input: [],
        stream: true,
        store: false,
        reasoning: { effort: 'medium' },
      }),
    });
    assert.equal(wrongScope.status, 400);
    assert.equal(upstreamRequests.length, 1);

    const missing = await fetch(`${baseUrl}/v1/usage/task-1`, {
      headers: auth(otherToken),
    });
    assert.equal(missing.status, 404);
  });
});

test('strips client reasoning from routes without a server-pinned effort', async () => {
  const nonReasoningRoute: ModelGatewayRoute = {
    ...route,
    id: 'non-reasoning',
    upstreamModelId: 'non-reasoning-upstream',
    providerId: 'compatible-chat',
    label: 'Standard model',
    buttonLabel: 'Standard model',
    provider: 'e-Mate',
    providerMark: 'M',
    reasoning: false,
    input: ['text'],
  };
  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: responseHeaders(),
        body: JSON.stringify({
          model: nonReasoningRoute.id,
          input: [],
          stream: true,
          store: false,
          reasoning: { effort: 'high', summary: 'detailed' },
        }),
      });
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(upstreamRequests.length, 1);
      const forwarded = (await upstreamRequests[0]?.json()) as Record<string, unknown>;
      assert.equal(Object.hasOwn(forwarded, 'reasoning'), false);
    },
    undefined,
    undefined,
    undefined,
    limits,
    nonReasoningRoute,
    { isEnabled: async () => true }
  );
});

test('accepts the pinned Codex request scope and its models catalog query', async () => {
  await withGateway(async (baseUrl, upstreamRequests) => {
    const catalog = await fetch(`${baseUrl}/v1/models?client_version=0.146.0`, {
      headers: auth(),
    });
    assert.equal(catalog.status, 200);

    const modelResponse = await modelRequest(baseUrl, codexResponseHeaders());
    assert.equal(modelResponse.status, 200);
    assert.match(await modelResponse.text(), /response\.completed/);
    assert.equal(upstreamRequests.length, 1);

    const usageResponse = await fetch(`${baseUrl}/v1/usage/codex-turn-1`, {
      headers: auth(),
    });
    assert.equal(usageResponse.status, 200);
    const envelope = (await usageResponse.json()) as Record<string, unknown>;
    const usage = JSON.parse(Buffer.from(String(envelope.payload), 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    assert.match(String(usage.traceId), /^codex-[a-f0-9]{32}$/);

    const wrongMetadata = await modelRequest(
      baseUrl,
      codexResponseHeaders({ 'x-client-request-id': 'codex-thread-2' })
    );
    assert.equal(wrongMetadata.status, 400);
    assert.equal(upstreamRequests.length, 1);

    const unknownQuery = await fetch(`${baseUrl}/v1/models?unexpected=true`, { headers: auth() });
    assert.equal(unknownQuery.status, 400);
  });
});

test('excludes retired Doubao from Codex catalog and rejects stale enabled invocation', async () => {
  const managedRoutes: ModelGatewayRoute[] = [
    { ...route, id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', buttonLabel: 'GPT-5.6 Luna · 深度' },
    route,
    chatRoute,
    {
      ...chatRoute,
      id: 'doubao-seed-2-0-pro-260215',
      upstreamModelId: 'doubao-seed-2-0-pro-260215',
      providerId: 'doubao',
      label: 'Doubao Seed 2.0 Pro',
      buttonLabel: 'Doubao Seed 2.0 Pro · 中等',
      provider: 'Volcano Ark',
      providerMark: 'B',
      input: ['text', 'image'],
      contextWindow: 256_000,
      maxTokens: 32_000,
    },
    imageRoute,
    { ...route, id: 'gpt-5.4', label: 'GPT-5.4', buttonLabel: 'GPT-5.4' },
  ];
  const managedPrincipal = {
    tenantId: 'tenant-a',
    userId: 'user-a',
    modelIds: managedRoutes.map(({ id }) => id),
  };
  const consentStore = new InMemoryConsentStore(consentPolicy);
  await consentStore.accept(managedPrincipal, consentInput);
  const server = createModelGatewayServer({
    routes: managedRoutes,
    tenantModelRoutePolicy: { isEnabled: async () => true },
    authenticate: async () => managedPrincipal,
    consentStore,
    usageStore: new InMemoryUsageStore(limits),
    usageKeyId: 'usage-2026',
    usagePrivateKey: privateKey,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/models?client_version=0.146.0`, {
      headers: auth(),
    });
    const catalog = (await response.json()) as { models: Array<{ slug: string }> };
    assert.equal(response.status, 200, JSON.stringify(catalog));
    assert.deepEqual(
      catalog.models.map(({ slug }) => slug),
      ['gpt-5.6-luna', 'gpt-5.6-sol', 'deepseek']
    );
    const refused = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: 'POST', headers: { ...codexResponseHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'doubao-seed-2-0-pro-260215', stream: true, store: false, input: 'hi' }),
    });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error.code, 'MODEL_ACCESS_DENIED');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('delivers only the authenticated tenant runtime model routes without exposing them through the public catalog', async () => {
  const luna = {
    ...route,
    id: 'gpt-5.6-luna',
    upstreamModelId: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    buttonLabel: 'GPT-5.6 Luna · 深度',
  };
  const tenantKey = 'tenant-specific-provider-key-123456789';
  const searchKey = 'tenant-specific-search-key-123456789';
  const internalDeepSeekKey = 'internal-deepseek-chat-key-never-leased';
  const modelSessionToken = `${'a'.repeat(32)}.${'b'.repeat(32)}.${'c'.repeat(64)}`;
  const clientCredential = 'client-credential-that-must-never-be-reflected';
  const opaqueSessionToken = 'opaque-session-token-that-is-not-a-jwt-value';
  const runtimeAuth = (token = modelSessionToken) => ({ authorization: `Bearer ${token}` });
  const internalDeepSeekRoute = {
    ...chatRoute,
    upstreamModelId: 'deepseek-v4-flash',
    upstreamApiKey: internalDeepSeekKey,
  };
  const enabledCalls = new Map<string, number>();
  const keyCalls: string[] = [];
  let searchGrantStatus: 'granted' | 'denied' | 'unavailable' = 'granted';
  const identity = {
    tenantId: 'tenant-a',
    userId: 'user-a',
    modelIds: [luna.id],
    sessionId: 'session-a',
  };
  const consentStore = new InMemoryConsentStore(consentPolicy);
  await consentStore.accept(identity, consentInput);
  const upstreamRequests: Request[] = [];
  const options: ModelGatewayOptions = {
    routes: [luna, internalDeepSeekRoute, searchCredentialRoute, imageRoute],
    publicBaseUrl: 'http://127.0.0.1',
    authenticate: async (token) => token === modelSessionToken || token === opaqueSessionToken
      ? identity
      : token === clientCredential ? { ...identity, sessionId: undefined } : null,
    consentStore,
    tenantModelRoutePolicy: {
      isEnabled: async (_tenantId, routeId) => {
        enabledCalls.set(routeId, (enabledCalls.get(routeId) ?? 0) + 1);
        return routeId !== searchCredentialRoute.id || searchGrantStatus !== 'denied';
      },
      upstreamApiKey: async (_tenantId, routeId) => {
        keyCalls.push(routeId);
        if (routeId === searchCredentialRoute.id && searchGrantStatus === 'unavailable') {
          throw new Error('search key unavailable');
        }
        return routeId === luna.id
          ? tenantKey
          : routeId === searchCredentialRoute.id ? searchKey : internalDeepSeekKey;
      },
    },
    usageStore: new InMemoryUsageStore(limits),
    usageKeyId: 'usage-2026',
    usagePrivateKey: privateKey,
    fetchImplementation: async (input, init) => {
      const request = new Request(input, init);
      upstreamRequests.push(request);
      return completedSse(10, 5, `legacy-response-${upstreamRequests.length}`);
    },
  };
  const server = createModelGatewayServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  options.publicBaseUrl = baseUrl;

  try {
    assert.equal((await fetch(`${baseUrl}/v1/runtime-models`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/v1/runtime-models?all=true`, { headers: runtimeAuth() })).status, 400);
    for (const query of [
      'client_version=2.0.15&client_version=2.0.16',
      'client_version=2.0.12&extra=true',
    ]) {
      const invalid = await fetch(`${baseUrl}/v1/runtime-models?${query}`, { headers: runtimeAuth() });
      assert.equal(invalid.status, 400);
      assert.deepEqual(await invalid.json(), {
        error: { code: 'INVALID_REQUEST', message: 'Query is not allowed' },
      });
    }
    for (const clientVersion of [
      '',
      '2.0.11',
      '99.0.0',
      '2.1.0-rc.1',
      '2.0.15_rc1',
      'invalid',
      'a'.repeat(65),
    ]) {
      const unsupported = await fetch(
        `${baseUrl}/v1/runtime-models?client_version=${encodeURIComponent(clientVersion)}`,
        { headers: runtimeAuth() },
      );
      assert.equal(unsupported.status, 400);
      assert.deepEqual(await unsupported.json(), {
        error: {
          code: 'UNSUPPORTED_CLIENT_VERSION',
          message: 'Unsupported runtime models client version',
        },
      });
    }
    assert.equal((await fetch(`${baseUrl}/v1/runtime-models`, { method: 'POST', headers: runtimeAuth() })).status, 405);
    for (const clientVersion of ['2.0.17', '2.0.18']) {
      const response = await fetch(`${baseUrl}/v1/runtime-models?client_version=${clientVersion}`, { headers: runtimeAuth() });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      const releasedClientBody = await response.json();
      assert.deepEqual(releasedClientBody, {
        schemaVersion: 1,
        models: [{
          id: luna.id,
          apiMode: 'responses',
          upstreamModelId: luna.upstreamModelId,
          label: luna.label,
          input: luna.input,
          reasoning: true,
          contextWindow: luna.contextWindow,
          maxTokens: luna.maxTokens,
        }],
        searchCredentialGrant: {
          schemaVersion: 1,
          status: 'granted',
          purpose: 'web-search',
          provider: 'deepseek-official',
          credentialRef: 'E_MATE_SEARCH_KEY_DEEPSEEK',
          upstreamApiKey: searchKey,
        },
      });
      assert.equal('upstreamBaseUrl' in releasedClientBody.models[0], false);
      assert.equal('upstreamApiKey' in releasedClientBody.models[0], false);
      assert.doesNotMatch(JSON.stringify(releasedClientBody.models), /provider-key|provider\.example/u);
    }
    assert.equal(enabledCalls.get(searchCredentialRoute.id), 2);
    assert.equal(keyCalls.filter((routeId) => routeId === searchCredentialRoute.id).length, 2);
    assert.equal(keyCalls.includes(luna.id), false);
    assert.equal(keyCalls.includes(internalDeepSeekRoute.id), false);

    const legacyCases = [
      { clientVersion: null, searchStatus: 'granted' as const },
      { clientVersion: '2.0.12', searchStatus: 'granted' as const },
      { clientVersion: '2.0.13', searchStatus: 'denied' as const },
      { clientVersion: '2.0.14', searchStatus: 'unavailable' as const },
      { clientVersion: '2.0.15', searchStatus: 'granted' as const },
      { clientVersion: '2.0.16', searchStatus: 'granted' as const },
    ];
    let legacyModel: { upstreamBaseUrl: string; upstreamApiKey: string } | undefined;
    for (const { clientVersion, searchStatus } of legacyCases) {
      searchGrantStatus = searchStatus;
      const path = clientVersion === null
        ? `${baseUrl}/v1/runtime-models`
        : `${baseUrl}/v1/runtime-models?client_version=${clientVersion}`;
      const legacyCatalogResponse = await fetch(path, { headers: runtimeAuth() });
      assert.equal(legacyCatalogResponse.status, 200);
      assert.equal(legacyCatalogResponse.headers.get('cache-control'), 'no-store');
      assert.equal(legacyCatalogResponse.headers.get('access-control-allow-origin'), null);
      const body = await legacyCatalogResponse.json() as {
        schemaVersion: number;
        models: Array<Record<string, unknown>>;
        searchCredentialGrant?: Record<string, unknown>;
      };
      const searchGrantExpected = clientVersion !== null && clientVersion !== '2.0.12';
      assert.deepEqual(
        Object.keys(body).sort(),
        searchGrantExpected ? ['models', 'schemaVersion', 'searchCredentialGrant'] : ['models', 'schemaVersion']
      );
      assert.equal(body.schemaVersion, 1);
      assert.equal(body.models.length, 1);
      const model = body.models[0] as Record<string, unknown>;
      assert.deepEqual(Object.keys(model).sort(), [
        'allowInsecureHttpUpstream', 'apiMode', 'contextWindow', 'id', 'input', 'label', 'maxTokens',
        'reasoning', 'upstreamApiKey', 'upstreamBaseUrl', 'upstreamModelId',
      ]);
      assert.equal(model.id, luna.id);
      assert.equal(model.apiMode, 'responses');
      assert.equal(model.upstreamModelId, luna.upstreamModelId);
      assert.equal(model.upstreamBaseUrl, `${baseUrl}/v1`);
      assert.equal(model.upstreamApiKey, modelSessionToken);
      assert.equal(model.allowInsecureHttpUpstream, true);
      assert.equal(model.label, luna.label);
      assert.deepEqual(model.input, luna.input);
      assert.equal(model.reasoning, true);
      assert.equal(model.contextWindow, luna.contextWindow);
      assert.equal(model.maxTokens, luna.maxTokens);
      if (searchGrantExpected) {
        assert.deepEqual(body.searchCredentialGrant, {
          schemaVersion: 1,
          status: searchStatus,
          purpose: 'web-search',
          provider: 'deepseek-official',
          credentialRef: 'E_MATE_SEARCH_KEY_DEEPSEEK',
          ...(searchStatus === 'granted' ? { upstreamApiKey: searchKey } : {}),
        });
      }
      assert.doesNotMatch(JSON.stringify(body.models), /tenant-specific|provider-secret|provider\.example|internal-deepseek/u);
      legacyModel ??= model as { upstreamBaseUrl: string; upstreamApiKey: string };
    }
    for (const [path, token] of [
      [`${baseUrl}/v1/runtime-models`, clientCredential],
      [`${baseUrl}/v1/runtime-models?client_version=2.0.16`, opaqueSessionToken],
    ]) {
      const denied = await fetch(path, { headers: runtimeAuth(token) });
      assert.equal(denied.status, 403);
      assert.doesNotMatch(JSON.stringify(await denied.json()), new RegExp(token, 'u'));
    }

    assert(legacyModel);
    const routed = await fetch(`${legacyModel.upstreamBaseUrl}/responses`, {
      method: 'POST',
      headers: {
        ...responseHeaders(),
        ...runtimeAuth(legacyModel.upstreamApiKey),
        session_id: 'legacy-session',
        'x-client-request-id': 'legacy-session',
        'x-e-mate-task-id': 'legacy-task',
        'x-e-mate-trace-id': 'legacy-trace',
      },
      body: JSON.stringify({
        model: luna.id,
        input: [{ role: 'user', content: 'legacy route' }],
        stream: true,
        store: false,
        reasoning: { effort: 'high', summary: 'auto' },
      }),
    });
    assert.equal(routed.status, 200);
    await routed.text();
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0]?.url, `${luna.upstreamBaseUrl}/responses`);
    assert.equal(upstreamRequests[0]?.headers.get('authorization'), `Bearer ${tenantKey}`);
    assert.equal(keyCalls.filter((routeId) => routeId === luna.id).length, 1);

    const catalogResponse = await (await fetch(`${baseUrl}/v1/models`, { headers: runtimeAuth() })).json() as {
      models: Array<{ id: string }>;
    };
    assert.deepEqual(catalogResponse.models.map(({ id }) => id), [luna.id]);
    const catalog = JSON.stringify(catalogResponse);
    assert.doesNotMatch(catalog, /provider-key|provider\.example/u);
    assert.doesNotMatch(catalog, /search-key|internal-deepseek-chat-key|deepseek/u);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('fails closed instead of leasing an internal-proxy chat key to native DeepSeek search', async () => {
  const luna = {
    ...route,
    id: 'gpt-5.6-luna',
    upstreamModelId: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    buttonLabel: 'GPT-5.6 Luna · 深度',
  };
  const proxyKey = 'internal-deepseek-proxy-key-never-leased';
  const internalProxyRoute = {
    ...chatRoute,
    upstreamModelId: 'deepseek-v4-flash',
    upstreamBaseUrl: 'https://deepseek-provider.ecorex.internal:18443/v1',
  };
  const identity = { tenantId: 'tenant-a', userId: 'user-a', modelIds: [luna.id] };
  const consentStore = new InMemoryConsentStore(consentPolicy);
  await consentStore.accept(identity, consentInput);
  let proxyKeyReads = 0;
  const server = createModelGatewayServer({
    routes: [luna, internalProxyRoute],
    authenticate: async (token) => token === sessionToken ? identity : null,
    consentStore,
    tenantModelRoutePolicy: {
      isEnabled: async () => true,
      upstreamApiKey: async (_tenantId, routeId) => {
        if (routeId === internalProxyRoute.id) {
          proxyKeyReads += 1;
          return proxyKey;
        }
        return 'tenant-gpt-key-value-123456789';
      },
    },
    usageStore: new InMemoryUsageStore(limits),
    usageKeyId: 'usage-2026',
    usagePrivateKey: privateKey,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/runtime-models?client_version=2.0.17`,
      { headers: auth() },
    );
    assert.equal(response.status, 200);
    const body = await response.json() as { searchCredentialGrant: Record<string, unknown> };
    assert.deepEqual(body.searchCredentialGrant, {
      schemaVersion: 1,
      status: 'unavailable',
      purpose: 'web-search',
      provider: 'deepseek-official',
      credentialRef: 'E_MATE_SEARCH_KEY_DEEPSEEK',
    });
    assert.equal(proxyKeyReads, 0);
    assert.doesNotMatch(JSON.stringify(body), /internal-deepseek-proxy-key/u);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('keeps GPT runtime available while managed search is denied or unavailable', async () => {
  const luna = {
    ...route,
    id: 'gpt-5.6-luna',
    upstreamModelId: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    buttonLabel: 'GPT-5.6 Luna · 深度',
  };
  const gptKey = 'tenant-gpt-key-value-123456789';
  const searchSecret = 'search-secret-never-leak-123456789';
  const internalSearchLikeRoute = {
    ...chatRoute,
    upstreamModelId: 'deepseek-v4-flash',
    upstreamBaseUrl: 'https://api.deepseek.com/anthropic/v1',
    upstreamApiKey: searchSecret,
  };
  const identity = { tenantId: 'tenant-a', userId: 'user-a', modelIds: [luna.id] };
  const consentStore = new InMemoryConsentStore(consentPolicy);
  await consentStore.accept(identity, consentInput);
  const scenarios = [
    {
      routes: [luna],
      policy: { isEnabled: async () => true, upstreamApiKey: async () => gptKey },
      grantStatus: 'unavailable',
    },
    {
      routes: [luna, searchCredentialRoute],
      policy: {
        isEnabled: async (_tenantId: string, routeId: string) => routeId !== searchCredentialRoute.id,
        upstreamApiKey: async (_tenantId: string, routeId: string) => routeId === luna.id ? gptKey : searchSecret,
      },
      grantStatus: 'denied',
    },
    {
      routes: [luna, searchCredentialRoute],
      policy: {
        isEnabled: async () => true,
        upstreamApiKey: async (_tenantId: string, routeId: string) => routeId === luna.id ? gptKey : null,
      },
      grantStatus: 'unavailable',
    },
    {
      routes: [luna, internalSearchLikeRoute],
      policy: {
        isEnabled: async () => true,
        upstreamApiKey: async (_tenantId: string, routeId: string) => routeId === luna.id ? gptKey : searchSecret,
      },
      grantStatus: 'unavailable',
    },
  ];

  for (const scenario of scenarios) {
    const server = createModelGatewayServer({
      routes: scenario.routes,
      authenticate: async (token) => token === sessionToken ? identity : null,
      consentStore,
      tenantModelRoutePolicy: scenario.policy,
      usageStore: new InMemoryUsageStore(limits),
      usageKeyId: 'usage-2026',
      usagePrivateKey: privateKey,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address === 'object');
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/runtime-models?client_version=2.0.17`,
        { headers: auth() },
      );
      assert.equal(response.status, 200);
      const body = await response.json() as {
        models: Array<{ id: string }>;
        searchCredentialGrant: Record<string, unknown>;
      };
      assert.deepEqual(body.models.map(({ id }) => id), [luna.id]);
      assert.deepEqual(body.searchCredentialGrant, {
        schemaVersion: 1,
        status: scenario.grantStatus,
        purpose: 'web-search',
        provider: 'deepseek-official',
        credentialRef: 'E_MATE_SEARCH_KEY_DEEPSEEK',
      });
      assert.doesNotMatch(JSON.stringify(body), /search-secret-never-leak/u);
      const activity = await fetch(
        `http://127.0.0.1:${address.port}/v1/usage/activity?timezone=UTC&start_date=2024-02-29&end_date=2024-02-29`,
        { headers: auth() },
      );
      assert.equal(activity.status, 200);
      assert.equal(((await activity.json()) as { periodTotal: string }).periodTotal, '0');
    } finally {
      server.close();
      await once(server, 'close');
    }
  }
});

test('freezes usage while preserving exact replay idempotency', async () => {
  const store = new InMemoryUsageStore(limits);
  const fact = {
    tenantId: 'tenant-a',
    userId: 'user-a',
    taskId: 'task-1',
    traceId: 'trace-1',
    modelId: 'gpt-5.6-sol',
    providerId: 'custom-gpt',
    providerResponseId: 'response-1',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.01,
  };
  await store.add(fact);
  await store.add(fact);
  const finalized = await store.finalize(principal('tenant-a', 'user-a'), 'task-1');
  assert(finalized);
  assert.equal((await store.finalize(principal('tenant-a', 'user-a'), 'task-1'))?.usageId, finalized.usageId);
  await store.add(fact);
  await assert.rejects(store.add({ ...fact, outputTokens: 2 }), /idempotency conflict/);
  await assert.rejects(store.add({ ...fact, providerResponseId: 'response-2' }), /already finalized/);
});

test('keeps invocation state idempotent and blocks direct usage around unknown work', async () => {
  const store = new InMemoryUsageStore(limits);
  const invocation = {
    tenantId: 'tenant-a',
    userId: 'user-a',
    taskId: 'task-invocation',
    traceId: 'trace-invocation',
    modelId: 'gpt-5.6-sol',
    providerId: 'custom-gpt',
    requestDigest: 'A'.repeat(43),
    routeFingerprint: 'R'.repeat(43),
  };
  const usage = {
    ...invocation,
    providerResponseId: 'response-invocation',
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.01,
  };
  const { requestDigest, ...usageFact } = usage;
  const prepared = await store.prepare(invocation);
  assert.equal(prepared.status, 'STARTED');
  await assert.rejects(
    store.prepare({ ...invocation, requestDigest: 'B'.repeat(43) }),
    /request digest changed/
  );
  assert.equal(
    await store.claimReconciliation(
      principal('tenant-b', 'user-b'),
      invocation.taskId,
      prepared.invocationId,
      invocation.routeFingerprint
    ),
    null
  );
  const claim = await store.claimReconciliation(
    principal('tenant-a', 'user-a'),
    invocation.taskId,
    prepared.invocationId,
    invocation.routeFingerprint
  );
  assert.equal(claim?.fact.requestDigest, invocation.requestDigest);
  assert.equal(
    await store.claimReconciliation(
      principal('tenant-a', 'user-a'),
      invocation.taskId,
      prepared.invocationId,
      invocation.routeFingerprint
    ),
    null
  );
  await assert.rejects(
    store.reject(principal('tenant-b', 'user-b'), invocation.taskId, prepared.invocationId),
    /not found/
  );
  await assert.rejects(store.completeReconciliation(prepared.invocationId, 'stale-lease', usageFact), /lease changed/);
  await assert.rejects(
    store.rejectReconciliation(
      principal('tenant-a', 'user-a'),
      invocation.taskId,
      prepared.invocationId,
      'stale-lease'
    ),
    /lease changed/
  );
  await assert.rejects(store.finalize(principal('tenant-a', 'user-a'), invocation.taskId), /requires reconciliation/);
  await assert.rejects(store.add(usageFact), /completion is required/);
  await store.complete(prepared.invocationId, usageFact);
  await store.complete(prepared.invocationId, usageFact);
  await assert.rejects(
    store.reject(principal('tenant-a', 'user-a'), invocation.taskId, prepared.invocationId),
    /cannot be rejected/
  );
  await assert.rejects(
    store.complete(prepared.invocationId, {
      ...usageFact,
      outputTokens: 3,
    }),
    /idempotency conflict/
  );

  assert.equal((await store.prepare(invocation)).status, 'RECORDED');
  const nextInvocation = {
    ...invocation,
    requestDigest: 'C'.repeat(43),
  };
  const next = await store.prepare(nextInvocation);
  assert.equal(next.status, 'STARTED');
  assert.notEqual(next.invocationId, prepared.invocationId);
  await store.reject(principal('tenant-a', 'user-a'), invocation.taskId, next.invocationId);
  const retry = await store.prepare(nextInvocation);
  assert.equal(retry.invocationId, next.invocationId);
  await store.reject(principal('tenant-a', 'user-a'), invocation.taskId, retry.invocationId);
  assert.equal((await store.finalize(principal('tenant-a', 'user-a'), invocation.taskId))?.outputTokens, 2);
});

test('refills tenant admission independently without charging pending replays', async () => {
  let now = 0;
  const store = new InMemoryUsageStore(
    {
      tenantRequestsPerMinute: 2,
      tenantBurst: 1,
      tenantMaxConcurrent: 1,
      invocationLeaseMs: 10_000,
    },
    () => now
  );
  const invocation = {
    tenantId: 'tenant-a',
    userId: 'user-a',
    taskId: 'task-quota-1',
    traceId: 'trace-quota-1',
    modelId: 'gpt-5.6-sol',
    providerId: 'custom-gpt',
    requestDigest: 'Q'.repeat(43),
    routeFingerprint: 'R'.repeat(43),
  };
  const started = await store.prepare(invocation);
  assert.equal(started.status, 'STARTED');
  assert.equal((await store.prepare(invocation)).status, 'PENDING');
  now = 5_000;
  const claim = await store.claimReconciliation(
    principal('tenant-a', 'user-a'),
    invocation.taskId,
    started.invocationId,
    invocation.routeFingerprint
  );
  assert(claim);
  assert.equal(
    await store.renewReconciliation(
      principal('tenant-a', 'user-a'),
      invocation.taskId,
      started.invocationId,
      claim.leaseToken
    ),
    true
  );
  now = 11_000;
  await assert.rejects(
    store.prepare({
      ...invocation,
      taskId: 'task-quota-2',
      traceId: 'trace-quota-2',
    }),
    /already running/
  );
  await store.reject(principal('tenant-a', 'user-a'), invocation.taskId, started.invocationId);
  await assert.rejects(
    store.prepare({
      ...invocation,
      taskId: 'task-quota-2',
      traceId: 'trace-quota-2',
    }),
    /rate limit/
  );
  assert.equal(
    (
      await store.prepare({
        ...invocation,
        tenantId: 'tenant-b',
        taskId: 'task-quota-b',
        traceId: 'trace-quota-b',
      })
    ).status,
    'STARTED'
  );
  now = 30_000;
  const afterRefill = await store.prepare({
    ...invocation,
    taskId: 'task-quota-2',
    traceId: 'trace-quota-2',
  });
  assert.equal(afterRefill.status, 'STARTED');
  await store.reject(principal('tenant-a', 'user-a'), 'task-quota-2', afterRefill.invocationId);
  now = 20_000;
  await assert.rejects(
    store.prepare({
      ...invocation,
      taskId: 'task-quota-3',
      traceId: 'trace-quota-3',
    }),
    /rate limit/
  );
});

test('rejects aggregates that cannot be represented by the signed receipt', async () => {
  const store = new InMemoryUsageStore(limits);
  const fact = {
    tenantId: 'tenant-a',
    userId: 'user-a',
    taskId: 'task-limit',
    traceId: 'trace-limit',
    modelId: 'gpt-5.6-sol',
    providerId: 'custom-gpt',
    providerResponseId: 'response-1',
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
  await store.add(fact);
  await assert.rejects(
    store.add({
      ...fact,
      providerResponseId: 'response-2',
      inputTokens: 0,
      outputTokens: 1,
    }),
    /ledger limits/
  );
  await assert.rejects(
    new InMemoryUsageStore(limits).add({
      ...fact,
      inputTokens: 0,
      costUsd: 1_000_001,
    }),
    /Invalid usage fact/
  );
});

test('proves one image usage fact across conflicting concurrency, receipt reacquire, and admission', async () => {
  const exactLimits = {
    tenantRequestsPerMinute: 1,
    tenantBurst: 1,
    tenantMaxConcurrent: 1,
    invocationLeaseMs: 180_000,
  };
  const usageStore = new InMemoryUsageStore(exactLimits);
  const observations: ImageObservation[] = [];
  let release!: () => void;
  let submitted!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const posted = new Promise<void>((resolve) => { submitted = resolve; });

  await withGateway(
    async (baseUrl, upstreamRequests) => {
      const first = imageRequest(baseUrl);
      await posted;
      const conflict = await imageRequest(baseUrl, {
        model: imageRoute.id,
        prompt: 'A conflicting red square.',
        size: '1024x1024',
      });
      assert.equal(conflict.status, 409);
      assert.equal(((await conflict.json()) as { error: { code: string } }).error.code, 'INVOCATION_REQUEST_CONFLICT');
      assert.equal(upstreamRequests.length, 1);

      release();
      assert.equal((await first).status, 200);
      const recorded = await imageRequest(baseUrl);
      assert.equal(recorded.status, 409);
      assert.equal(((await recorded.json()) as { error: { code: string } }).error.code, 'INVOCATION_RESULT_ALREADY_RECORDED');
      assert.equal(upstreamRequests.length, 1);

      const firstReceipt = await fetch(`${baseUrl}/v1/usage/task-1`, { headers: auth() });
      const secondReceipt = await fetch(`${baseUrl}/v1/usage/task-1`, { headers: auth() });
      assert.equal(firstReceipt.status, 200);
      assert.equal(secondReceipt.status, 200);
      assert.deepEqual(await secondReceipt.json(), await firstReceipt.json());

      const rejectedTaskHeaders = {
        ...responseHeaders(),
        session_id: 'image-rate-request',
        'x-client-request-id': 'image-rate-request',
        'x-e-mate-task-id': 'image-rate-task',
        'x-e-mate-trace-id': 'image-rate-trace',
      };
      const admission = await imageRequest(baseUrl, undefined, rejectedTaskHeaders);
      assert.equal(admission.status, 429);
      assert.equal(((await admission.json()) as { error: { code: string } }).error.code, 'TENANT_REQUEST_RATE_LIMITED');
      assert.equal((await fetch(`${baseUrl}/v1/usage/image-rate-task`, { headers: auth() })).status, 404);
      assert.equal(upstreamRequests.length, 1);

      await new Promise((resolve) => setImmediate(resolve));
      const audit = JSON.stringify(observations);
      assert.match(audit, /task-1/);
      assert.doesNotMatch(audit, /A blue circle|A conflicting red square|aGVsbG8|provider-secret/i);
    },
    async () => {
      submitted();
      await held;
      return Response.json({
        data: [{ b64_json: 'aGVsbG8=' }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    },
    undefined,
    undefined,
    exactLimits,
    imageRoute,
    { isEnabled: async () => true },
    usageStore,
    (event) => observations.push(event)
  );
});


test('Responses admits bounded multi-image JSON above the old 4 MiB cap without changing input bytes', async () => {
  const images = Array.from({ length: 3 }, () => 'data:image/png;base64,' + 'A'.repeat(2 * 1024 * 1024));
  const input = [{ role: 'user', content: [{ type: 'input_text', text: 'synthetic transport fixture' }, ...images.map(image_url => ({ type: 'input_image', image_url }))] }];
  const body = { model: route.id, stream: true, store: false, reasoning: { effort: 'medium' }, input };
  await withGateway(async (baseUrl, upstream) => {
    const response = await fetch(baseUrl + '/v1/responses', { method: 'POST', headers: responseHeaders(), body: JSON.stringify(body) });
    assert.equal(response.status, 200); await response.text();
    const forwarded = await upstream[0]!.json();
    assert.deepEqual(forwarded.input, input); assert.deepEqual(forwarded.reasoning, body.reasoning);
    assert.equal(forwarded.model, route.upstreamModelId); assert.equal(upstream.length, 1);
  });
});

test('Responses authenticates before size rejection and rejects oversized declarations before usage or provider work', async () => {
  const store = new InMemoryUsageStore(limits);
  let prepared = 0;
  const original = store.prepare.bind(store);
  store.prepare = (...args) => { prepared++; return original(...args); };
  await withGateway(async (baseUrl, upstream) => {
    const declared = (authorized: boolean) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(baseUrl + '/v1/responses', { method: 'POST', headers: { ...responseHeaders(), Authorization: authorized ? 'Bearer ' + sessionToken : 'Bearer invalid', 'content-length': String(MAX_RESPONSES_REQUEST_BYTES + 1), connection: 'close' } }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, body }));
      }); request.on('error', reject); request.end();
    });
    assert.equal((await declared(false)).status, 401);
    const refused = await declared(true); assert.equal(refused.status, 413);
    assert.equal(JSON.parse(refused.body).error.code, 'REQUEST_TOO_LARGE');
    assert.equal(prepared, 0); assert.equal(upstream.length, 0);
  }, undefined, undefined, undefined, limits, route, undefined, store);
});

test('two large Responses slots bound work while small requests progress and completed slots are released', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const large = 'x'.repeat(5 * 1024 * 1024);
  await withGateway(async (baseUrl, upstream) => {
    const headers = (id: string) => ({ ...responseHeaders(), 'x-e-mate-task-id': id });
    const first = modelRequest(baseUrl, headers('large-1'), large);
    const second = modelRequest(baseUrl, headers('large-2'), large);
    try {
      for (let i = 0; upstream.length < 2 && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(upstream.length, 2);
      const busy = await modelRequest(baseUrl, headers('large-3'), large);
      assert.equal(busy.status, 429); assert.equal(busy.headers.get('retry-after'), '1');
      assert.equal((await busy.json()).error.code, 'REQUEST_BODY_BUSY');
      const small = await modelRequest(baseUrl, headers('small-1')); assert.equal(small.status, 200); await small.text();
    } finally { release(); }
    for (const response of await Promise.all([first, second])) { assert.equal(response.status, 200); await response.text(); }
    const next = await modelRequest(baseUrl, headers('large-4'), large); assert.equal(next.status, 200); await next.text();
    assert.equal(upstream.length, 4);
  }, async (_request, index) => { if (index <= 2) await gate; return completedSse(10, 5, 'large-response-' + index); }, undefined, undefined, { ...limits, tenantMaxConcurrent: 10 });
});

test('upstream 413 remains an explicit rejected size response without HTML or provider replay', async () => {
  const store = new InMemoryUsageStore(limits); let rejected = 0;
  const reject = store.reject.bind(store); store.reject = async (...args) => { rejected++; return reject(...args); };
  await withGateway(async (baseUrl, upstream) => {
    const result = await modelRequest(baseUrl); assert.equal(result.status, 413);
    const body = await result.text(); assert.equal(JSON.parse(body).error.code, 'UPSTREAM_REQUEST_TOO_LARGE');
    assert.doesNotMatch(body, /html|nginx|synthetic-private-details/); assert.equal(upstream.length, 1); assert.equal(rejected, 1);
  }, () => new Response('<html>nginx synthetic-private-details</html>', { status: 413, headers: { 'content-type': 'text/html' } }), undefined, undefined, limits, route, undefined, store);
});


test('upstream rejection evidence preserves transport facts without changing unknown invocation protection', async () => {
  for (const endpoint of ['responses', 'image_generations', 'image_edits'] as const) {
    const image = endpoint !== 'responses';
    for (const scenario of ['http_non_2xx', 'unexpected_content_type', 'missing_body'] as const) {
      const events: Array<Parameters<NonNullable<ModelGatewayOptions['upstreamRejectionObservation']>>[0]> = [];
      await withGateway(async (baseUrl, requests) => {
        const send = () => endpoint === 'image_edits' ? imageEditRequest(baseUrl) : image ? imageRequest(baseUrl) : modelRequest(baseUrl);
        const result = await send();
        assert.equal(result.status, image && scenario === 'missing_body' ? 503 : 502);
        assert.equal(events.length, 1);
        const event = events[0]!;
        assert.equal(event.reason, scenario);
        assert.equal(event.upstream_status, scenario === 'http_non_2xx' ? 503 : 200);
        assert.equal(event.has_body, scenario !== 'missing_body');
        assert.equal(event.content_type, scenario === 'unexpected_content_type' ? 'text/html' : image ? 'application/json' : 'text/event-stream');
        assert.deepEqual(event.provider_trace, { header: 'x-request-id', id: 'provider-request-123' });
        assert.equal(event.endpoint, endpoint);
        assert.equal(event.invocation_id, requests[0]!.headers.get('idempotency-key'));
        assert.deepEqual(Object.keys(event).sort(), ['schema_version','occurred_at','invocation_id','task_id','trace_id','route_id','provider_id','endpoint','upstream_status','content_type','has_body','reason','provider_trace'].sort());
        assert(!JSON.stringify(event).includes('DO_NOT_LOG'));
        assert.equal((await send()).status, 409);
        assert.equal(requests.length, 1);
        assert.equal(events.length, 1);
      }, () => new Response(scenario === 'missing_body' ? null : 'DO_NOT_LOG_BODY', {
        status: scenario === 'http_non_2xx' ? 503 : 200,
        headers: { 'content-type': (scenario === 'unexpected_content_type' ? 'text/html' : image ? 'application/json' : 'text/event-stream') + '; private=DO_NOT_LOG_PARAMETER',
          'x-request-id': 'provider-request-123', authorization: 'Bearer DO_NOT_LOG_TOKEN', 'set-cookie': 'DO_NOT_LOG_COOKIE', 'x-prompt': 'DO_NOT_LOG_PROMPT' },
      }), undefined, undefined, limits, image ? imageRoute : route, image ? { isEnabled: async () => true } : undefined,
      new InMemoryUsageStore(limits), undefined, event => events.push(event));
    }
  }
});

test('throwing rejection observer cannot change definite rejection retry or public response', async () => {
  let calls = 0;
  await withGateway(async (baseUrl, requests) => {
    for (let index = 0; index < 2; index++) {
      const result = await modelRequest(baseUrl);
      assert.equal(result.status, 502);
      assert.equal((await result.json() as { error: { code: string } }).error.code, 'UPSTREAM_REJECTED');
    }
    assert.equal(requests.length, 2);
    assert.equal(calls, 2);
  }, () => new Response('private', { status: 429 }), undefined, undefined, limits, route, undefined,
  new InMemoryUsageStore(limits), undefined, () => { calls++; throw new Error('private observer failure'); });
});


test('successful upstream responses emit no rejection evidence', async () => {
  let calls = 0;
  await withGateway(async baseUrl => {
    const response = await modelRequest(baseUrl);
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(calls, 0);
  }, undefined, undefined, undefined, limits, route, undefined, new InMemoryUsageStore(limits), undefined, () => { calls++; });
});

test('invalid image JSON records transport evidence without logging its contents', async () => {
  const events: unknown[] = [];
  await withGateway(async baseUrl => {
    assert.equal((await imageEditRequest(baseUrl)).status, 503);
    assert.equal(events.length, 1);
    assert.equal((events[0] as { reason: string }).reason, 'invalid_payload');
    assert(!JSON.stringify(events).includes('PRIVATE_BODY'));
  }, () => new Response('PRIVATE_BODY', { headers: { 'content-type': 'application/json' } }),
  undefined, undefined, limits, imageRoute, { isEnabled: async () => true }, new InMemoryUsageStore(limits), undefined, event => events.push(event));
});

test('native Chat endpoint preserves DeepSeek reasoning and tool history through shared accounted stream', async () => {
  const messages = [
    { role: 'system', content: 'native instructions' },
    { role: 'user', content: 'calculate' },
    { role: 'assistant', content: '', reasoning_content: 'retained native reasoning', tool_calls: [{ id: 'call-native', type: 'function', function: { name: 'calculate', arguments: '{"value":2}' } }] },
    { role: 'tool', tool_call_id: 'call-native', content: '4' },
  ];
  const tools = [{ type: 'function', function: { name: 'calculate', parameters: { type: 'object', properties: {} } } }];
  const reasoning = { id: 'chat-response-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning_content: 'native reasoning delta' }, finish_reason: null }], usage: null };
  const tool = { id: 'chat-response-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-next', type: 'function', function: { name: 'calculate', arguments: '{"value":3}' } }] }, finish_reason: 'tool_calls' }], usage: null };
  const complete = await completedChatSse(11, 3).text();
  const raw = `data: ${JSON.stringify(reasoning)}\n\ndata: ${JSON.stringify(tool)}\n\n${complete.slice(complete.indexOf('\n\n') + 2)}`;
  await withGateway(async (baseUrl, requests) => {
    const body = { model: 'deepseek', messages, tools, stream: true, stream_options: { include_usage: true }, thinking: { type: 'enabled' }, reasoning_effort: 'max', max_tokens: 32 };
    const post = (headers = responseHeaders()) => fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
    const response = await post();
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(await response.text(), raw);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0]!.url).pathname, '/v1/chat/completions');
    const forwarded = await requests[0]!.json();
    assert.equal(forwarded.model, 'deepseek-v4-flash');
    assert.deepEqual(forwarded.messages, messages);
    assert.deepEqual(forwarded.tools, tools);
    assert.equal(forwarded.reasoning_effort, 'max');
    assert.deepEqual(forwarded.thinking, { type: 'enabled' });
    assert.equal(forwarded.max_tokens, 32);
    const audit = await fetch(`${baseUrl}/v1/usage/task-1`, { headers: auth() });
    assert.equal(audit.status, 200);
    const envelope = await audit.json();
    const usage = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString());
    assert.equal(usage.inputTokens, 11); assert.equal(usage.outputTokens, 3);
    assert.equal((await post()).status, 409);
    assert.equal((await post({ 'content-type': 'application/json' })).status, 401);
    assert.equal(requests.length, 1);
  }, () => new Response(raw, { headers: { 'content-type': 'text/event-stream' } }), undefined, undefined, limits, { ...chatRoute, upstreamModelId: 'deepseek-v4-flash' }, { isEnabled: async () => true });
});

test('native Chat endpoint enforces route policy and input boundary before upstream dispatch', async () => {
  for (const enabled of [false, true]) {
    await withGateway(async (baseUrl, requests) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: responseHeaders(), body: JSON.stringify({ model: 'deepseek', stream: true, messages: [{ role: 'user', content: 'hello' }], extra_body: { model: 'other' } }) });
      assert.equal(response.status, enabled ? 400 : 403);
      assert.equal(requests.length, 0);
    }, undefined, undefined, undefined, limits, chatRoute, { isEnabled: async () => enabled });
  }
});

test('native Chat endpoint never completes accounting without a complete upstream DONE frame', async () => {
  for (const ending of ['', 'data: [DONE]']) {
  const raw = (await completedChatSse(11, 3).text()).replace('data: [DONE]\n\n', ending);
  await withGateway(async (baseUrl, requests) => {
    const body = JSON.stringify({ model: 'deepseek', stream: true, messages: [{ role: 'user', content: 'hello' }] });
    const response = await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: responseHeaders(), body });
    const text = await response.text().catch(() => '');
    assert.equal(text.includes('[DONE]'), false);
    const retry = await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: responseHeaders(), body });
    assert.equal(retry.status, 409);
    assert.equal(requests.length, 1);
  }, () => new Response(raw, { headers: { 'content-type': 'text/event-stream' } }), undefined, undefined, limits, chatRoute, { isEnabled: async () => true });
  }
});


test('native Chat preserves disabled thinking and accepts text arrays without enabling images', async () => {
  await withGateway(async (baseUrl, requests) => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'title please' }] }, { role: 'assistant', content: null }];
    const send = (content: unknown, task: string) => fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { ...responseHeaders(), 'x-e-mate-task-id': task },
      body: JSON.stringify({ model: 'deepseek', stream: true, thinking: { type: 'disabled' }, reasoning_effort: 'low', messages: [{ ...messages[0], content }, messages[1]] }),
    });
    const good = await send(messages[0]!.content, 'native-title');
    assert.equal(good.status, 200); await good.text();
    const forwarded = await requests[0]!.json();
    assert.deepEqual(forwarded.messages, messages);
    assert.deepEqual(forwarded.thinking, { type: 'disabled' });
    assert.equal('reasoning_effort' in forwarded, false);
    const image = await send([{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }], 'native-image');
    assert.equal(image.status, 400); assert.equal(requests.length, 1);
  }, () => completedChatSse(11, 3), undefined, undefined, limits, chatRoute, { isEnabled: async () => true });
});

test('DeepSeek vision candidate preserves native Responses image and tool output input at max effort', async () => {
  const visionRoute: ModelGatewayRoute = { ...chatRoute, apiMode: 'responses', nativeChatCompletions: true, upstreamModelId: 'deepseek-v4-flash-vision-exp', input: ['text', 'image'] };
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const input = [
    { role: 'user', content: [{ type: 'input_text', text: 'inspect reference' }, { type: 'input_image', image_url: image }] },
    { type: 'function_call', call_id: 'read-image', name: 'view_image', arguments: '{}' },
    { type: 'function_call_output', call_id: 'read-image', output: [{ type: 'input_text', text: 'tool image' }, { type: 'input_image', image_url: image }] },
  ];
  await withGateway(async (baseUrl, upstream) => {
    const response = await fetch(`${baseUrl}/v1/responses`, { method: 'POST', headers: responseHeaders(), body: JSON.stringify({
      model: 'deepseek', stream: true, store: false, input, reasoning: { effort: 'low' },
      tools: [{ type: 'function', name: 'view_image', parameters: { type: 'object', properties: {} } }],
    }) });
    assert.equal(response.status, 200); assert.match(await response.text(), /response.completed/);
    const forwarded = await upstream[0]!.json();
    assert.equal(new URL(upstream[0]!.url).pathname, '/v1/responses');
    assert.equal(forwarded.model, 'deepseek-v4-flash-vision-exp');
    assert.deepEqual(forwarded.input, input); assert.deepEqual(forwarded.reasoning, { effort: 'max' });
    assert.equal(forwarded.tools[0].name, 'view_image'); assert.equal(upstream.length, 1);
    const audit = await fetch(`${baseUrl}/v1/usage/task-1`, { headers: auth() }); assert.equal(audit.status, 200);
  }, undefined, undefined, undefined, limits, visionRoute, { isEnabled: async () => true });
  for (const invalid of [{ ...visionRoute, input: ['text'] }, { ...visionRoute, apiMode: 'chat-completions' }, { ...visionRoute, reasoning: false }]) {
    assert.throws(() => createModelGatewayServer({ routes: [invalid as ModelGatewayRoute], authenticate: async () => null,
      usageStore: new InMemoryUsageStore(limits), usageKeyId: 'usage-2026', usagePrivateKey: privateKey }), /Invalid Model Gateway route/);
  }
});


test('explicit dual-protocol vision route accepts old native Chat with shared auth and accounting', async () => {
  const visionRoute: ModelGatewayRoute = { ...chatRoute, apiMode: 'responses', nativeChatCompletions: true, upstreamModelId: 'deepseek-v4-flash-vision-exp', input: ['text', 'image'] };
  await withGateway(async (baseUrl, requests) => {
    const messages = [{ role: 'user', content: 'continue' },
      { role: 'assistant', content: '', reasoning_content: 'preserved', tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'old-call', content: 'read result' }];
    const body = JSON.stringify({ model: 'deepseek', stream: true, messages });
    const send = (headers = responseHeaders()) => fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers, body });
    assert.equal((await send({ 'content-type': 'application/json' })).status, 401);
    const response = await send(); assert.equal(response.status, 200); assert.match(await response.text(), /\[DONE\]/);
    assert.equal(new URL(requests[0]!.url).pathname, '/v1/chat/completions');
    const forwarded = await requests[0]!.json(); assert.equal(forwarded.model, 'deepseek-v4-flash-vision-exp');
    assert.deepEqual(forwarded.messages, messages); assert.equal(forwarded.reasoning_effort, 'max');
    assert.equal((await fetch(`${baseUrl}/v1/usage/task-1`, { headers: auth() })).status, 200);
    assert.equal((await send()).status, 409); assert.equal(requests.length, 1);
  }, () => completedChatSse(11, 3), undefined, undefined, limits, visionRoute, { isEnabled: async () => true });
  await withGateway(async (baseUrl, requests) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: responseHeaders(), body: JSON.stringify({ model: route.id, stream: true, messages: [{ role: 'user', content: 'hello' }] }) });
    assert.equal(response.status, 403); assert.equal(requests.length, 0);
  });
});

test('same-version runtime catalog negotiates DeepSeek metadata without changing route authorization', async () => {
  const visionRoute: ModelGatewayRoute = { ...chatRoute, apiMode: 'responses', nativeChatCompletions: true,
    upstreamModelId: 'deepseek-v4-flash-vision-exp', input: ['text', 'image'] };
  const identity = { tenantId: 'tenant-a', userId: 'user-a', sessionId: 'fixture-session', modelIds: [visionRoute.id] };
  const consentStore = new InMemoryConsentStore(consentPolicy); await consentStore.accept(identity, consentInput);
  let enabled = true;
  const server = createModelGatewayServer({ routes: [visionRoute], authenticate: async () => identity, consentStore,
    tenantModelRoutePolicy: { isEnabled: async () => enabled }, usageStore: new InMemoryUsageStore(limits), usageKeyId: 'usage-2026', usagePrivateKey: privateKey });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
  assert(address && typeof address === 'object'); const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer model.${'p'.repeat(32)}.signature` };
  try {
    const old = await fetch(`${baseUrl}/v1/runtime-models?client_version=2.0.18`, { headers });
    const modern = await fetch(`${baseUrl}/v1/runtime-models?client_version=2.0.18&capabilities=responses-multimodal`, { headers });
    assert.equal(old.status, 200); assert.equal(modern.status, 200);
    const oldBody = await old.json(); const modernBody = await modern.json();
    assert.equal(oldBody.schemaVersion, 1); assert.equal(modernBody.schemaVersion, 1);
    assert.deepEqual(Object.keys(oldBody).sort(), Object.keys(modernBody).sort());
    assert.deepEqual(oldBody.models[0], { ...modernBody.models[0], apiMode: 'chat-completions', upstreamModelId: 'deepseek-v4-flash', input: ['text'] });
    assert.equal(modernBody.models[0].upstreamModelId, 'deepseek-v4-flash-vision-exp');
    assert.equal(modernBody.models[0].apiMode, 'responses'); assert.deepEqual(modernBody.models[0].input, ['text', 'image']);
    for (const query of ['capabilities=unknown', 'capabilities=responses-multimodal&capabilities=responses-multimodal', 'client_version=2.0.18&client_version=2.0.18', 'capabilities=responses-multimodal&extra=true']) {
      assert.equal((await fetch(`${baseUrl}/v1/runtime-models?${query}`, { headers })).status, 400);
    }
    assert.equal((await fetch(`${baseUrl}/v1/models?capabilities=responses-multimodal`, { headers })).status, 400);
    enabled = false;
    for (const suffix of ['', '&capabilities=responses-multimodal']) {
      assert.equal((await fetch(`${baseUrl}/v1/runtime-models?client_version=2.0.18${suffix}`, { headers })).status, 403);
    }
  } finally { server.close(); await once(server, 'close'); }
});


test('released Pro wire requests use one exact Flare route and preserve signed usage identity', async () => {
  for (const grant of [['gpt-image-2-pro'], ['gpt-image-2.5-flare'], []]) {
    let enabled = true;
    await withGateway(async (url, requests) => {
      const response = await imageRequest(url, { model: 'gpt-image-2-pro', prompt: 'fixture' });
      assert.equal(response.status, grant.length ? 200 : 403);
      if (!grant.length) { assert.equal(requests.length, 0); return; }
      assert.equal((await requests[0]!.clone().json()).model, 'gpt-image-2.5-flare');
      const usage = await fetch(`${url}/v1/usage/task-1`, { headers: auth() });
      assert.equal(usage.status, 200);
      const envelope = await usage.json();
      const payload = Buffer.from(envelope.payload, 'base64url');
      assert.equal(verify(null, payload, publicKey, Buffer.from(envelope.signature, 'base64url')), true);
      const value = JSON.parse(payload.toString());
      assert.equal(value.modelId, 'gpt-image-2-pro');
      // Existing audit binding rejects a different wire model before dispatch.
      assert.equal((await imageRequest(url, { model: imageRoute.id, prompt: 'fixture' })).status, 503);
      assert.equal(requests.length, 1);
      const edit = new FormData();
      edit.set('model', 'gpt-image-2-pro'); edit.set('prompt', 'Preserve the reference');
      edit.set('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'input.png');
      assert.equal((await imageEditRequest(url, edit, 'legacy-edit')).status, 200);
      const upstreamEdit = await requests[1]!.clone().formData();
      assert.equal(upstreamEdit.get('model'), imageRoute.id);
      assert.deepEqual([...new Uint8Array(await (upstreamEdit.get('image') as Blob).arrayBuffer())], [1, 2, 3]);

      assert.equal((await imageRequest(url, { model: 'gpt-image2.5-flare', prompt: 'fixture' })).status, 403);
      enabled = false;
      assert.equal((await imageRequest(url, { model: 'gpt-image-2-pro', prompt: 'fixture' })).status, 403);
      assert.equal(requests.length, 2);
    }, () => Response.json({ data: [{ b64_json: 'aGVsbG8=' }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
    undefined, undefined, limits, imageRoute, { isEnabled: async (_tenant, id) => { assert.equal(id, imageRoute.id); return enabled; } },
    new InMemoryUsageStore(limits), undefined, undefined, grant);
  }
});


test('canonical image lookup decrypts a legacy record with its original AAD and refuses foreign records', async () => {
  const key = Buffer.alloc(32, 7), nonce = Buffer.alloc(12, 3);
  const secret = 'fixture-image-key-never-logged';
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('tenant-a\0gpt-image-2-pro'));
  const row = { route_id: 'gpt-image-2-pro', upstream_key_ciphertext: Buffer.concat([cipher.update(secret), cipher.final()]),
    upstream_key_nonce: nonce, upstream_key_tag: cipher.getAuthTag() };
  const policy = new PostgresTenantModelRoutePolicy({ query: async () => ({ rows: [row] }) } as never, key);
  assert.equal(await policy.upstreamApiKey('tenant-a', imageRoute.id), secret);
  await assert.rejects(policy.upstreamApiKey('tenant-b', imageRoute.id));
  row.route_id = 'gpt-5.6-sol';
  await assert.rejects(policy.upstreamApiKey('tenant-a', imageRoute.id), /unavailable/);
});

test('production authentication maps only the released image grant before live authorization intersection', async () => {
  let ids = ['gpt-image-2-pro']; let live = true;
  const authenticate = createProductionAuthenticator(
    async () => ({ tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-1', modelIds: ids }),
    { isUserSessionActive: async () => true } as never,
    { activeModelIds: async (_principal: ModelGatewayPrincipal, scope: string[]) => {
      assert.deepEqual(scope, ['gpt-image-2.5-flare']); return live ? scope : [];
    } } as never, ['gpt-image-2.5-flare', 'gpt-5.6-sol']);
  assert.deepEqual((await authenticate(sessionToken))?.modelIds, ['gpt-image-2.5-flare']);
  live = false; assert.equal(await authenticate(sessionToken), null);
  ids = ['gpt-image2.5-flare']; assert.equal(await authenticate(sessionToken), null);
  ids = []; assert.equal(await authenticate(sessionToken), null);
});

test('signed old Pro JWT through production authentication exposes only canonical public image catalog', async () => {
  const { sign } = await import('node:crypto');
  const { createSessionTokenVerifier } = await import('../src/session-auth.ts');
  const now = Date.now(), seconds = Math.floor(now / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'e-mate-model-session+jwt', kid: 'fixture' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ schemaVersion: 1, iss: 'fixture', aud: 'gateway',
    sub: 'user-a', sid: 'session-1', tenantId: 'tenant-a', modelIds: ['gpt-image-2-pro'],
    scopes: ['models:read', 'responses:create', 'usage:read'], iat: seconds, nbf: seconds, exp: seconds + 600, jti: 'fixture-token-0001' })).toString('base64url');
  const body = `${header}.${claims}`, jwt = `${body}.${sign(null, Buffer.from(body), privateKey).toString('base64url')}`;
  const verifySession = createSessionTokenVerifier({ issuer: 'fixture', audience: 'gateway', publicKeys: new Map([['fixture', publicKey]]), now: () => now });
  const authenticate = createProductionAuthenticator(verifySession,
    { isUserSessionActive: async () => true } as never,
    { activeModelIds: async (_principal: ModelGatewayPrincipal, ids: string[]) => ids } as never, [imageRoute.id]);
  const consentStore = new InMemoryConsentStore(consentPolicy);
  await consentStore.accept(principal('tenant-a','user-a', imageRoute.id), consentInput);
  const server = createModelGatewayServer({ routes: [imageRoute], authenticate, consentStore,
    tenantModelRoutePolicy: { isEnabled: async () => true }, usageStore: new InMemoryUsageStore(limits),
    usageKeyId: 'fixture', usagePrivateKey: privateKey });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/models`, { headers: { authorization: `Bearer ${jwt}` } });
    assert.equal(response.status, 200);
    const catalog = await response.json();
    assert.deepEqual(catalog.models.map((model: { id: string }) => model.id), [imageRoute.id]);
    assert.deepEqual(catalog.data, []);
  } finally { server.close(); await once(server,'close'); }
});
