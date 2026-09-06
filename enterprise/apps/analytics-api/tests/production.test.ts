import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { parseProductionConfiguration } from '../src/production.ts';
import { createAnalyticsServer } from '../src/server.ts';

const token = 'test-admin-bearer';
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');

function configuration(principalsFile = '/run/secrets/analytics-principals.json'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    listen: { host: '0.0.0.0', port: 4190 },
    database: { urlFile: '/run/secrets/postgres-url' },
    redis: { urlFile: '/run/secrets/redis-url' },
    managementAuth: { principalsFile },
    consentPolicy: {
      schemaVersion: 1,
      agreementId: 'e-mate-platform-terms',
      agreementVersion: '1.0.0',
      disclaimerVersion: '1.0.0',
      contentHash: 'a'.repeat(64),
    },
    modelRoutes: [
      { routeId: 'gpt-5.6-luna', label: 'Luna', provider: 'OpenAI' },
      { routeId: 'gpt-5.6-sol', label: 'Sol', provider: 'OpenAI' },
    ],
  };
}

function secretReader(principalDocument: unknown): (path: string) => Buffer {
  const values = new Map([
    ['/run/secrets/postgres-url', Buffer.from('postgres://e_mate:test@127.0.0.1:5432/e_mate')],
    ['/run/secrets/redis-url', Buffer.from('redis://127.0.0.1:6379')],
    ['/run/secrets/analytics-principals.json', Buffer.from(JSON.stringify(principalDocument))],
    ['/run/secrets/model-route-key-encryption', Buffer.from(Buffer.alloc(32, 5).toString('base64url'))],
  ]);
  return (path) => {
    const value = values.get(path);
    if (!value) throw new Error('Unexpected secret path');
    return value;
  };
}

function principals(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    principals: [
      {
        tokenSha256: tokenHash,
        tenantId: 'tenant-1',
        userId: 'admin-1',
        roles: ['TENANT_ADMIN'],
        projectIds: ['project-1'],
        ...overrides,
      },
    ],
  };
}

test('production configuration maps a hashed bearer to fixed identity and denies other tokens', async () => {
  const readSecret = secretReader(principals());
  const parsed = parseProductionConfiguration(
    {
      ...configuration(),
      modelRouteKeys: { encryptionKeyFile: '/run/secrets/model-route-key-encryption' },
    },
    (path) => {
      assert.notEqual(path, '/run/secrets/redis-url');
      return readSecret(path);
    }
  );
  assert.equal(parsed.host, '0.0.0.0');
  assert.equal(parsed.port, 4190);
  assert.equal(parsed.databaseUrl, 'postgres://e_mate:test@127.0.0.1:5432/e_mate');
  assert.deepEqual(parsed.modelRouteKeyEncryptionKey, Buffer.alloc(32, 5));
  assert.equal(parsed.consentPolicy.agreementId, 'e-mate-platform-terms');
  assert.deepEqual(await parsed.authenticate(token), {
    tenantId: 'tenant-1',
    userId: 'admin-1',
    roles: ['TENANT_ADMIN'],
    projectIds: ['project-1'],
  });
  assert.equal(await parsed.authenticate('wrong-admin-bearer'), null);
  const withoutRedis = configuration();
  delete withoutRedis.redis;
  assert.equal(parseProductionConfiguration(withoutRedis, readSecret).port, 4190);
});

test('GPT fast mode configuration binds one tenant and fixed SSH secret paths', () => {
  const mode = {
    tenantId: 'tenant-1',
    sshHost: 'proxy.internal',
    privateKeyFile: '/run/secrets/gpt-fast-mode-key',
    knownHostsFile: '/run/secrets/gpt-fast-mode-hosts',
  };
  const readSecret = secretReader(principals());
  const reader = (path: string) =>
    path === mode.privateKeyFile || path === mode.knownHostsFile ? Buffer.from('test-key-material') : readSecret(path);
  const parsed = parseProductionConfiguration({
    ...configuration(),
    modelRoutes: [
      ...(configuration().modelRoutes as unknown[]),
      { routeId: 'gpt-web-search', label: 'e-Mate 企业搜索', provider: '联网搜索' },
    ],
    modelFastMode: mode,
  }, reader);
  assert.deepEqual(parsed.modelFastMode, mode);
  assert.equal(parsed.modelRoutes.at(-1)?.routeId, 'gpt-web-search');
  for (const patch of [
    { sshHost: '-oProxyCommand=unsafe' },
    { sshHost: 'host user' },
    { privateKeyFile: '/tmp/key' },
    { tenantId: '' },
    { extra: true },
  ]) {
    assert.throws(
      () => parseProductionConfiguration({ ...configuration(), modelFastMode: { ...mode, ...patch } }, reader),
      /Invalid/
    );
  }
});

test('production registers only identity, model-policy management, bounded model probes, and redacted audit surfaces', async () => {
  const source = readFileSync(new URL('../src/production.ts', import.meta.url), 'utf8');
  const serverSource = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const taskReaderSource = readFileSync(new URL('../src/task-events.ts', import.meta.url), 'utf8');
  const gatewayServerSource = readFileSync(new URL('../../model-gateway/src/server.ts', import.meta.url), 'utf8');
  const gatewayStoreSource = readFileSync(
    new URL('../../model-gateway/src/postgres-usage-store.ts', import.meta.url),
    'utf8'
  );
  const adminSourceExtension = /\.(?:[cm]?[jt]sx?)$/u;
  for (const extension of ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']) {
    assert.match(`source.${extension}`, adminSourceExtension);
  }
  assert.doesNotMatch('styles.css', adminSourceExtension);
  const readSourceTree = (directory: URL): Array<{ path: string; source: string }> => readdirSync(
    directory,
    { withFileTypes: true }
  ).flatMap((entry) => {
    const url = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directory);
    if (entry.isDirectory()) return readSourceTree(url);
    return adminSourceExtension.test(entry.name)
      ? [{ path: url.pathname, source: readFileSync(url, 'utf8') }]
      : [];
  });
  const adminFiles = readSourceTree(new URL('../../admin/src/', import.meta.url));
  const adminSource = adminFiles.map((file) => file.source).join('\n');
  const compact = (value: string): string => value.replace(/['"`+\s]/gu, '');
  const assertAllowedNetworkPaths = (value: string): void => {
    const paths = [...value.matchAll(/(['"`])(\/v1\/[^'"`\r\n]*)\1/gu)].map((match) => compact(match[2]));
    assert(paths.length > 0, 'Admin source must retain an allowlisted management route');
    for (const path of paths) {
      assert(
        /^\/v1\/(?:auth\/password$|admin(?:\/|$)|models$|responses$|images\/generations$)/u.test(path),
        `Admin network path is not allowlisted: ${path}`
      );
    }
  };
  const assertUniqueAdminNetworkPrimitive = (value: string): void => {
    const primitive = /\(options\.fetcher\s*\?\?\s*fetch\)\s*\(/gu;
    assert.equal(
      [...value.matchAll(primitive)].length,
      1,
      'Admin source must retain exactly one same-origin network primitive'
    );
    const remainder = value
      .replace(primitive, '')
      .replace(/fetcher\?:\s*typeof\s+fetch/gu, '');
    assert.doesNotMatch(
      remainder,
      /\bfetch(?:er)?\b/u,
      'Admin source may not bypass its unique same-origin network primitive'
    );
  };
  assert.doesNotMatch(source, /openRedisRuntimeRegistry|openPostgresSessionSummaryStore|openPostgresObservabilityPolicyStore/);
  assert.doesNotMatch(source, /createManagementAuthenticator/);
  assert.doesNotMatch(serverSource, /['"]\/v1\/tasks\/events['"]/u);
  assert.doesNotMatch(taskReaderSource, /\b(?:append|initialize)\s*\(/u);
  assert.doesNotMatch(taskReaderSource, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/u);
  assert.match(gatewayServerSource, /['"]\/v1\/audit\/tasks['"]/u);
  assert.match(gatewayStoreSource, /async ingestAuditTasks\(/u);
  assert.doesNotMatch(source, /\bregistry:|\bsessionIndex:|\bobservabilityPolicy:/);
  const productionWiring = source.match(/server = createAnalyticsServer\(\{(?<options>[\s\S]*?)\n    \}\);/u)?.groups?.options;
  assert(productionWiring);
  assert.deepEqual(
    [...productionWiring.matchAll(/^\s+([A-Za-z][A-Za-z0-9]*)(?=:)/gmu)].map((match) => match[1]).toSorted(),
    ['adminManagement', 'authenticate', 'consentStore', 'taskEvents', 'usageAnalytics']
  );
  const adminPackage = JSON.parse(
    readFileSync(new URL('../../admin/package.json', import.meta.url), 'utf8')
  ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const allowedDependencies = [
    '@arco-design/web-react',
    '@e-mate/admin-contract',
    '@icon-park/react',
    '@types/node',
    '@types/react',
    '@types/react-dom',
    '@vitejs/plugin-react',
    'react',
    'react-dom',
    'typescript',
    'vite',
  ];
  assert.deepEqual(
    Object.keys({ ...adminPackage.dependencies, ...adminPackage.devDependencies }).toSorted(),
    allowedDependencies
  );
  const dependencySet = new Set(allowedDependencies);
  for (const { path, source: adminFileSource } of adminFiles) {
    for (const match of adminFileSource.matchAll(
      /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gu
    )) {
      const specifier = match[1] as string;
      if (specifier.startsWith('.')) continue;
      const dependency = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0] as string;
      assert(dependencySet.has(dependency), `Admin source dependency is not allowlisted: ${path}: ${specifier}`);
    }
  }
  assert.deepEqual(
    adminFiles.filter((file) => /\bfetch\b/u.test(file.source)).map((file) => file.path.split('/').at(-1)),
    ['api.ts']
  );
  const adminApiSource = adminFiles.find((file) => file.path.endsWith('/api.ts'))?.source;
  assert(adminApiSource);
  assert.doesNotMatch(adminSource, /\b(?:XMLHttpRequest|WebSocket|EventSource)\b|\.sendBeacon\s*\(|\brequire\s*\(|\bimport\s*\(/u);
  assertUniqueAdminNetworkPrimitive(adminSource);
  assert.throws(
    () => assertUniqueAdminNetworkPrimitive(`${adminSource}\nfetch(dynamicPath);`),
    /unique same-origin network primitive/u
  );
  assertAllowedNetworkPaths(adminApiSource);
  assert.throws(() => assertAllowedNetworkPaths("fetch('/v1/' + 'chat/completions')"), /not allowlisted/u);
  assert.throws(() => assertAllowedNetworkPaths("fetch('/v1/images/' + 'edits')"), /not allowlisted/u);
  const modelToolSchema = /(?:tool_choice|parallel_tool_calls|tool_calls|function_call|toolChoice|parallelToolCalls|toolCalls|functionCall)/u;
  assert.doesNotMatch(compact(adminSource), modelToolSchema);
  assert.doesNotMatch(compact('const tools: string[] = [];'), modelToolSchema);
  const adminVite = readFileSync(new URL('../../admin/vite.config.ts', import.meta.url), 'utf8');
  assert.match(adminVite, /'\/e-mate\/model-api'/u);

  const server = createAnalyticsServer({ authenticate: async () => null });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    for (const path of [
      '/runtime/status',
      '/v1/runtime-registry/heartbeats',
      '/v1/runtime-registry/instances/runtime-1',
      '/v1/session-index/search',
      '/v1/session-index/session-1',
      '/v1/operations/observability',
      '/v1/observability-policy',
      '/v1/observability-policy/rollback',
      '/v1/tools/execute',
      '/v1/plugins/install',
      '/v1/skills/enable',
      '/v1/files/read',
      '/v1/workspaces/project-1',
      '/v1/memory/search',
      '/v1/computer-use/activate',
      '/v1/cdp/navigate',
      '/v1/schedules/create',
      '/v1/tasks/events',
      '/v1/jobs/dispatch',
      '/v1/shares/share-1',
      '/v1/profiles/activate',
      '/v1/updates/apply',
      '/v1/releases/publish',
      '/v1/connections/authorize',
    ]) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
      assert.equal(response.status, 404, path);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'NOT_FOUND');
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('service images prove their runtime closure as the declared unprivileged user', () => {
  const dockerfile = readFileSync(new URL('../../../deploy/Dockerfile.services', import.meta.url), 'utf8');
  const runtimeStageMarker = 'FROM ${BUN_IMAGE} AS ';
  for (const [stage, application, entry] of [
    ['analytics', 'analytics-api', 'production.js'],
    ['gateway', 'model-gateway', 'production.js'],
    ['auth', 'auth-gateway', 'production.js'],
  ] as const) {
    const start = dockerfile.indexOf(`${runtimeStageMarker}${stage}`);
    assert.notEqual(start, -1, `missing ${stage} runtime image`);
    const next = dockerfile.indexOf(`\n${runtimeStageMarker}`, start + runtimeStageMarker.length);
    const block = dockerfile.slice(start, next === -1 ? undefined : next);
    assert.match(block, /COPY --from=build --chown=10001:0 \/app\/node_modules \.\/node_modules/u);
    assert.match(block, new RegExp(
      `COPY --from=build --chown=10001:0 /app/apps/${application} ./apps/${application}`,
      'u'
    ));
    assert.match(block, /COPY --from=build --chown=10001:0 \/app\/packages \.\/packages/u);
    assert.match(block, /USER 10001:0/u);
    assert.match(block, new RegExp(
      `RUN bun -e "await import\\('./apps/${application}/dist/${entry}'\\)"`,
      'u'
    ));
    if (stage === 'analytics') {
      assert.match(block, /apt-get install -y --no-install-recommends openssh-client/u);
      assert.match(block, /useradd --uid 10001 --gid 0/u);
    }
  }
});

test('production configuration rejects non-secret paths, unknown fields, invalid roles, and duplicate hashes', () => {
  assert.throws(
    () => parseProductionConfiguration(configuration('C:\\secrets\\principals.json'), secretReader(principals())),
    /Invalid management principals file/
  );
  assert.throws(
    () => parseProductionConfiguration({ ...configuration(), plaintextToken: token }, secretReader(principals())),
    /Invalid configuration/
  );
  assert.throws(
    () => parseProductionConfiguration(configuration(), secretReader(principals({ roles: ['MEMBER'] }))),
    /Invalid role/
  );
  const duplicate = principals();
  duplicate.principals = [
    ...(duplicate.principals as unknown[]),
    {
      tokenSha256: tokenHash,
      tenantId: 'tenant-2',
      userId: 'admin-2',
      roles: ['AUDIT_ADMIN'],
      projectIds: [],
    },
  ];
  assert.throws(
    () => parseProductionConfiguration(configuration(), secretReader(duplicate)),
    /Invalid management principal 2/
  );
});

test('health endpoint is available without credentials and leaks no dependency details', async () => {
  const server = createAnalyticsServer({
    registry: {
      heartbeat: async () => true,
      remove: async () => true,
      status: async () => {
        throw new Error('health endpoint must not query Redis');
      },
    },
    authenticate: async () => {
      throw new Error('health endpoint must not authenticate');
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/healthz?verbose=1`)).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/healthz`, { method: 'POST' })).status, 405);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('public knowledge configuration requires explicit enterprise session auth and desktop client binding', () => {
  const knowledge = { socketPath: '/run/emate-knowledge/public.sock', tenantMappings: { 'tenant-1': 'xin-org' }, accessClientId: 'e-mate-desktop' };
  const read = secretReader(principals());
  assert.throws(() => parseProductionConfiguration({ ...configuration(), knowledge }, read), /requires enterprise/);
  const sessionAuth = { issuer: 'https://auth.example.test', audience: 'e-mate-access', clientId: 'e-mate-admin', publicKeys: [{ keyId: 'auth-1', file: '/run/secrets/public-key' }] };
  const config = parseProductionConfiguration({ ...configuration(), knowledge, sessionAuth }, path => path === '/run/secrets/public-key' ? Buffer.from('fixture-public-key') : read(path));
  assert.deepEqual(config.knowledge, knowledge);
  assert.equal(config.sessionAuth?.clientId, 'e-mate-admin');
  assert.throws(() => parseProductionConfiguration({ ...configuration(), knowledge: { ...knowledge, tenantMappings: { 'tenant-1': ['xin-org'] } }, sessionAuth }, path => path === '/run/secrets/public-key' ? Buffer.from('fixture-public-key') : read(path)), /knowledge tenants/);
});
