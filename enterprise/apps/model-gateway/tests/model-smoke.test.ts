import { safeProviderTrace } from '../src/server.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelSmokeError, runModelSmoke, type ModelSmokeRoute } from '../src/modelSmoke.ts';

const secret = 'test-secret-that-is-never-production';
function route(
  id: string,
  apiMode: 'responses' | 'chat-completions' | 'images-generations',
  upstreamModelId: string,
  upstreamBaseUrl: string
): ModelSmokeRoute {
  return {
    id,
    apiMode,
    upstreamModelId,
    upstreamBaseUrl,
    upstreamApiKey: secret,
    maxTokens: 65_536,
  };
}

const routes = [
  route('gpt-5.6-luna', 'responses', 'gpt-5.6-luna', 'https://main-provider.ecorex.internal:18443/v1'),
  route('gpt-5.6-sol', 'responses', 'gpt-5.6-sol', 'https://main-provider.ecorex.internal:18443/v1'),
  route('deepseek', 'chat-completions', 'deepseek-v4-flash', 'https://deepseek-provider.ecorex.internal:18443/v1'),
  route(
    'gpt-image-2-pro',
    'images-generations',
    'gpt-image-2-pro',
    'https://image-provider.ecorex.internal:18443/v1'
  ),
];

test('Astra extends the existing GPT catalog and probes Responses low with the same credential', async () => {
  const mock = mockFetch();
  const astra = route('gpt-6-astra', 'responses', 'gpt-6-astra', 'https://main-provider.ecorex.internal:18443/v1');
  const result = await runModelSmoke({ routes: [...routes, astra], catalogSha256: 'a'.repeat(64), operator: 'fixture-admin',
    timeoutMs: 1000, fetchImplementation: mock.fetchImplementation });
  assert.equal(result.results.length, 5);
  const request = mock.requests.find(({ body }) => body.model === 'gpt-6-astra');
  assert(request);
  assert.equal(request.url.endsWith('/responses'), true);
  assert.deepEqual(request.body.reasoning, { effort: 'low' });
});

function responsesStream(id: string): Response {
  return new Response(
    [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'sensitive-response-text' })}`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id,
          status: 'completed',
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        },
      })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'),
    { headers: { 'content-type': 'text/event-stream', 'x-request-id': `request-${id}` } }
  );
}

function chatStream(id: string, requestHeader = true): Response {
  const chunks = [
    {
      id,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'sensitive-response-text' }, finish_reason: 'stop' }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      choices: [],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    },
  ];
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: {
      'content-type': 'text/event-stream',
      ...(requestHeader ? { 'x-request-id': `request-${id}` } : {}),
    },
  });
}

function imageResponse(id: string): Response {
  return Response.json(
    {
      id,
      data: [{ b64_json: 'QUJDRA==' }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    },
    { headers: { 'x-request-id': `request-${id}` } }
  );
}

function mockFetch(options: { rejectCall?: number; rejectImage?: boolean; omitChatRequestId?: boolean } = {}): {
  fetchImplementation: typeof fetch;
  requests: Array<{ url: string; body: Record<string, unknown> }>;
} {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImplementation = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, body });
    if (requests.length === options.rejectCall) return new Response(null, { status: 401 });
    if (url.endsWith('/images/generations')) {
      if (options.rejectImage) return new Response(null, { status: 404 });
      return imageResponse(`image-${requests.length}`);
    }
    return url.endsWith('/chat/completions')
      ? chatStream(`chat-${requests.length}`, !options.omitChatRequestId)
      : responsesStream(`response-${requests.length}`);
  }) as typeof fetch;
  return { fetchImplementation, requests };
}

const randomId = (): (() => string) => {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
};

test('writes only catalog-bound redacted evidence after all five live routes pass', async () => {
  const { fetchImplementation } = mockFetch();
  const approval = await runModelSmoke({
    routes,
    catalogSha256: 'a'.repeat(64),
    operator: 'release.operator',
    timeoutMs: 10_000,
    fetchImplementation,
    randomId: randomId(),
    now: () => new Date('2026-08-02T12:00:00.000Z'),
  });
  const serialized = JSON.stringify(approval);
  assert.deepEqual(
    approval.results.map(({ routeId, method }) => [routeId, method]),
    [
      ['gpt-5.6-luna', 'live-inference'],
      ['gpt-5.6-sol', 'live-inference'],
      ['deepseek', 'live-inference'],
      ['gpt-image-2-pro', 'live-image-generation'],
    ]
  );
  assert.equal(serialized.includes(secret) || serialized.includes('sensitive-response-text'), false);
  assert.equal(serialized.includes('Reply with OK.') || serialized.includes('A solid orange square.'), false);
});

test('accepts only the official search credential route without proxying it as a model', async () => {
  const { fetchImplementation, requests } = mockFetch();
  const searchCredentialRoute: ModelSmokeRoute = {
    ...route(
      'deepseek-web-search',
      'chat-completions',
      'deepseek-v4-flash',
      'https://api.deepseek.com/anthropic/v1'
    ),
    providerId: 'deepseek-official',
  };
  const approval = await runModelSmoke({
    routes: [...routes, searchCredentialRoute],
    catalogSha256: '9'.repeat(64),
    operator: 'release.operator',
    timeoutMs: 10_000,
    fetchImplementation,
    randomId: randomId(),
  });

  assert.equal(approval.results.length, 4);
  assert.equal(requests.length, 4);
  assert.equal(requests.some(({ url }) => url.includes('/anthropic/v1')), false);

  for (const invalid of [
    { ...searchCredentialRoute, providerId: 'deepseek' },
    { ...searchCredentialRoute, upstreamBaseUrl: 'https://deepseek-provider.ecorex.internal:18443/v1' },
    { ...searchCredentialRoute, upstreamModelId: 'deepseek-chat' },
  ]) {
    await assert.rejects(
      runModelSmoke({
        routes: [...routes, invalid],
        catalogSha256: '9'.repeat(64),
        operator: 'release.operator',
        timeoutMs: 10_000,
        fetchImplementation,
      }),
      (error: unknown) =>
        error instanceof ModelSmokeError && error.code === 'INVALID_CATALOG' && error.routeId === invalid.id
    );
  }
});

test('does not label an adapter-generated chat id as provider evidence', async () => {
  const { fetchImplementation } = mockFetch({ omitChatRequestId: true });
  const approval = await runModelSmoke({
    routes,
    catalogSha256: 'e'.repeat(64),
    operator: 'release.operator',
    timeoutMs: 10_000,
    fetchImplementation,
    randomId: randomId(),
  });
  assert.deepEqual(
    approval.results.filter(({ routeId }) => routeId === 'deepseek')
      .map(({ evidenceId }) => evidenceId.startsWith('local:')),
    [true]
  );
});

test('fails closed after one fixed Pro image request', async () => {
  const { fetchImplementation, requests } = mockFetch({ rejectImage: true });
  await assert.rejects(
    runModelSmoke({
      routes,
      catalogSha256: 'b'.repeat(64),
      operator: 'release.operator',
      timeoutMs: 10_000,
      fetchImplementation,
      randomId: randomId(),
    }),
    (error: unknown) =>
      error instanceof ModelSmokeError && error.code === 'UPSTREAM_REJECTED' && error.routeId === 'gpt-image-2-pro'
  );
  assert.deepEqual(
    requests.map(({ url }) => url.slice(url.lastIndexOf('/') + 1)),
    ['responses', 'responses', 'completions', 'generations']
  );
  assert.deepEqual(
    requests.filter(({ url }) => url.endsWith('/images/generations')).map(({ body }) => body.model),
    ['gpt-image-2-pro']
  );
});

test('fails closed without returning approval after any provider rejection', async () => {
  const { fetchImplementation, requests } = mockFetch({ rejectCall: 3 });
  const completed: string[] = [];
  await assert.rejects(
    runModelSmoke({
      routes,
      catalogSha256: 'c'.repeat(64),
      operator: 'release.operator',
      timeoutMs: 10_000,
      fetchImplementation,
      randomId: randomId(),
      onResult: ({ routeId }) => completed.push(routeId),
    }),
    (error: unknown) =>
      error instanceof ModelSmokeError && error.code === 'UPSTREAM_REJECTED' && error.routeId === 'deepseek'
  );
  assert.deepEqual(completed, ['gpt-5.6-luna', 'gpt-5.6-sol']);
  assert.equal(requests.length, 3);
});

test('rejects an unapproved route catalog before any credential-bearing request', async () => {
  const { fetchImplementation, requests } = mockFetch();
  const invalidRoutes = structuredClone(routes);
  const invalidRoute = invalidRoutes.find(({ id }) => id === 'deepseek');
  assert(invalidRoute);
  invalidRoute.upstreamBaseUrl = 'https://example.test/v1';
  await assert.rejects(
    runModelSmoke({
      routes: invalidRoutes,
      catalogSha256: 'd'.repeat(64),
      operator: 'release.operator',
      timeoutMs: 10_000,
      fetchImplementation,
    }),
    (error: unknown) =>
      error instanceof ModelSmokeError && error.code === 'INVALID_CATALOG' && error.routeId === 'deepseek'
  );
  assert.equal(requests.length, 0);
});

test('requires an explicit route-local opt-in before smoking a pinned HTTP upstream', async () => {
  const { fetchImplementation, requests } = mockFetch();
  const httpRoutes = structuredClone(routes);
  const httpRoute = httpRoutes.find(({ id }) => id === 'gpt-5.6-luna');
  assert(httpRoute);
  httpRoute.upstreamBaseUrl = 'http://127.0.0.1:18080/v1';

  await assert.rejects(
    runModelSmoke({
      routes: httpRoutes,
      catalogSha256: 'f'.repeat(64),
      operator: 'release.operator',
      timeoutMs: 10_000,
      fetchImplementation,
    }),
    (error: unknown) =>
      error instanceof ModelSmokeError && error.code === 'INVALID_CATALOG' && error.routeId === 'gpt-5.6-luna'
  );
  assert.equal(requests.length, 0);

  httpRoute.allowInsecureHttpUpstream = true;
  const approval = await runModelSmoke({
    routes: httpRoutes,
    catalogSha256: 'f'.repeat(64),
    operator: 'release.operator',
    timeoutMs: 10_000,
    fetchImplementation,
    randomId: randomId(),
  });
  assert.equal(approval.results.length, 4);
  assert.equal(requests[0]?.url, 'http://127.0.0.1:18080/v1/responses');
});

test('accepts the pinned official DeepSeek HTTPS base', async () => {
  const { fetchImplementation, requests } = mockFetch();
  const officialRoutes = structuredClone(routes);
  const deepseek = officialRoutes.find(({ id }) => id === 'deepseek');
  assert(deepseek);
  deepseek.upstreamBaseUrl = 'https://api.deepseek.com';

  const approval = await runModelSmoke({
    routes: officialRoutes,
    catalogSha256: '1'.repeat(64),
    operator: 'release.operator',
    timeoutMs: 10_000,
    fetchImplementation,
    randomId: randomId(),
  });

  assert.equal(approval.results.length, 4);
  assert.equal(requests[2]?.url, 'https://api.deepseek.com/chat/completions');
});

test('rejects credential-bearing and malformed opted-in HTTP URLs before smoke requests', async () => {
  for (const upstreamBaseUrl of [
    'http://user:password@127.0.0.1:18080/v1',
    'http://127.0.0.1:18080/v1?api_key=forbidden',
    'http://[::1',
  ]) {
    const { fetchImplementation, requests } = mockFetch();
    const invalidRoutes = structuredClone(routes);
    const invalidRoute = invalidRoutes.find(({ id }) => id === 'gpt-5.6-luna');
    assert(invalidRoute);
    invalidRoute.upstreamBaseUrl = upstreamBaseUrl;
    invalidRoute.allowInsecureHttpUpstream = true;
    await assert.rejects(
      runModelSmoke({
        routes: invalidRoutes,
        catalogSha256: '0'.repeat(64),
        operator: 'release.operator',
        timeoutMs: 10_000,
        fetchImplementation,
      }),
      (error: unknown) =>
        error instanceof ModelSmokeError && error.code === 'INVALID_CATALOG' && error.routeId === 'gpt-5.6-luna'
    );
    assert.equal(requests.length, 0);
  }
});


test('provider evidence uses the shared bounded header allowlist only', () => {
  for (const header of ['x-request-id', 'request-id', 'openai-request-id', 'x-tt-logid']) {
    assert.deepEqual(safeProviderTrace(new Headers({ [header]: 'provider-1234' })), { header, id: 'provider-1234' });
  }
  for (const id of ['bad id value', 'x'.repeat(102), 'short', 'https://private.example/path']) {
    assert.equal(safeProviderTrace(new Headers({ 'x-request-id': id, authorization: 'Bearer secret', 'x-secret': 'private-secret' })), undefined);
  }
  assert.equal(safeProviderTrace(new Headers({ authorization: 'Bearer secret', 'x-arbitrary-trace': 'private-secret' })), undefined);
});
