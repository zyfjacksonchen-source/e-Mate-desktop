import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createAnalyticsServer } from '../src/server.ts';
import { createKnowledgeClient, knowledgeRoute, KNOWLEDGE_PREFIX, parseKnowledgeConfiguration } from '../src/knowledge-client.ts';

const principal = { tenantId: 'enterprise', userId: 'employee-1', roles: ['MEMBER'] };
const response = { schema_version: 1, request_id: 'fixture', scope: { kind: 'public' }, corpus_revision: 'a'.repeat(64), source_count: 0 };

async function fixture(handler: RequestListener) {
  const directory = await mkdtemp('/tmp/emate-knowledge-');
  const socketPath = directory + '/read.sock';
  const server = createServer(handler);
  server.listen(socketPath); await once(server, 'listening');
  return { socketPath, async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); } };
}

test('canonical public paths reject extra scope, duplicate query, legacy aliases and arbitrary routes', () => {
  const url = (path: string) => new URL(KNOWLEDGE_PREFIX + path, 'http://local');
  assert.equal(knowledgeRoute('GET', url('/catalog'), undefined).action, 'catalog');
  assert.equal(knowledgeRoute('GET', url('/nodes/' + 'a'.repeat(64)), undefined).action, 'node');
  assert.equal(knowledgeRoute('GET', url('/benchmark'), undefined).action, 'benchmarks');
  assert.equal(knowledgeRoute('POST', url('/benchmark'), {}).action, 'benchmark');
  for (const path of ['/sources?project_id=1', '/sources?limit=1&limit=2', '/context', '/wiki/' + 'a'.repeat(64), '/imports', '/sources/../../secret']) {
    assert.throws(() => knowledgeRoute('GET', url(path), undefined));
  }
  for (const body of [{ tenant_id: 'other' }, { project_id: 1 }, { actor: principal }]) {
    assert.throws(() => knowledgeRoute('POST', url('/search'), body));
  }
  assert.throws(() => parseKnowledgeConfiguration({ socketPath: 'https://example.com/read', tenantMappings: { enterprise: 'xin' }, accessClientId: 'e-mate-desktop' }));
});

test('Unix-socket client sends only verified actor and fixed action, never bearer or cookie', async () => {
  let received: any;
  let headers: any;
  const server = await fixture(async (request: any, res: any) => {
    headers = request.headers;
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(request.url, '/read');
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response));
  });
  try {
    const client = createKnowledgeClient({ socketPath: server.socketPath, tenantMappings: { enterprise: 'xin' }, accessClientId: 'e-mate-desktop' });
    assert.equal(JSON.parse((await client.read(principal, 'catalog', {})).body.toString()).scope.kind, 'public');
    assert.deepEqual(received, { actor: { enterprise_tenant_id: 'enterprise', subject_id: 'employee-1' }, knowledge_tenant_id: 'xin', action: 'catalog', params: {} });
    assert.equal(headers.authorization, undefined); assert.equal(headers.cookie, undefined);
    await assert.rejects(client.read({ ...principal, tenantId: 'other' }, 'catalog', {}), /尚未连接/);
  } finally { await server.close(); }
});

test('original download checks actual body digest and never renders arbitrary upstream HTML', async () => {
  const bytes = Buffer.from('actual source bytes');
  const version = createHash('sha256').update(bytes).digest('hex');
  let corrupt = false;
  const server = await fixture((_request: any, res: any) => {
    res.setHeader('content-type', 'application/octet-stream'); res.setHeader('x-source-version', version);
    res.setHeader('content-disposition', "attachment; filename*=UTF-8''source.txt"); res.end(corrupt ? 'corrupted' : bytes);
  });
  try {
    const client = createKnowledgeClient({ socketPath: server.socketPath, tenantMappings: { enterprise: 'xin' }, accessClientId: 'e-mate-desktop' });
    assert.deepEqual((await client.read(principal, 'original', { version })).body, bytes);
    corrupt = true;
    await assert.rejects(client.read(principal, 'original', { version }), /版本/);
    await assert.rejects(client.read(principal, 'catalog', {}), /暂不可用/);
  } finally { await server.close(); }
});

test('HTTP facade uses access-session-only auth rather than management fallback', async () => {
  let calls = 0;
  const server = createAnalyticsServer({ authenticate: async () => ({ ...principal, roles: ['TENANT_ADMIN'] }),
    knowledge: { authenticate: async token => token === 'active-access-session' ? principal : null,
      client: { async read() { calls++; return { status: 200, body: Buffer.from(JSON.stringify(response)), contentType: 'application/json' }; } } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${KNOWLEDGE_PREFIX}/catalog`;
  try {
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer bootstrap-admin-key' } })).status, 401);
    assert.equal((await fetch(url)).status, 401);
    const okay = await fetch(url, { headers: { authorization: 'Bearer active-access-session' } });
    assert.equal(okay.status, 200); assert.equal(okay.headers.get('cache-control'), 'private, no-store');
    assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('aborting a Unix request cancels work and releases admission for later reads', async () => {
  let hanging = true;
  const server = await fixture((_request: any, res: any) => { if (!hanging) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response)); } });
  try {
    const client = createKnowledgeClient({ socketPath: server.socketPath, tenantMappings: { enterprise: 'xin' }, accessClientId: 'e-mate-desktop' });
    const controller = new AbortController();
    const pending = client.read(principal, 'catalog', {}, controller.signal); controller.abort();
    await assert.rejects(pending);
    hanging = false;
    assert.equal((await client.read(principal, 'catalog', {})).status, 200);
  } finally { await server.close(); }
});

test('real signed access sessions are rechecked on every knowledge request and revoked sessions are denied', async () => {
  const { generateKeyPairSync, sign, randomUUID } = await import('node:crypto');
  const { createAccessSessionAuthenticator } = await import('../src/access-session-auth.ts');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  let active = true;
  let databaseReads = 0;
  const now = Math.floor(Date.now() / 1000);
  const pool = { async query(statement: string, values: unknown[]) {
    databaseReads++;
    assert.match(statement, /session.status = 'ACTIVE'/);
    assert.match(statement, /app_user.status = 'ACTIVE'/);
    assert.equal(values[3], 'e-mate-desktop');
    return { rows: active ? [{ roles: ['MEMBER'] }] : [] };
  } } as unknown as import('pg').Pool;
  const authenticate = createAccessSessionAuthenticator(pool, { issuer: 'https://auth.test', audience: 'e-mate-access', clientId: 'e-mate-desktop', publicKeys: new Map([['auth-1', publicKey]]), now: () => now * 1000 });
  const makeToken = (type = 'e-mate-auth-session+jwt', expiry = now + 300) => {
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: type, kid: 'auth-1' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ schemaVersion: 1, iss: 'https://auth.test', aud: 'e-mate-access', sub: 'employee-1', sid: randomUUID(), tenantId: 'enterprise', roles: ['MEMBER'], weeklyTokenLimit: 100000, iat: now, nbf: now, exp: expiry, jti: randomUUID() })).toString('base64url');
    const body = `${header}.${claims}`;
    return `${body}.${sign(null, Buffer.from(body, 'ascii'), privateKey).toString('base64url')}`;
  };
  const server = createAnalyticsServer({ authenticate: async () => principal, knowledge: { authenticate, client: { async read() { return { status: 200, body: Buffer.from(JSON.stringify(response)), contentType: 'application/json' }; } } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${KNOWLEDGE_PREFIX}/catalog`;
  const valid = makeToken();
  try {
    const call = (token: string) => fetch(url, { headers: { authorization: 'Bearer ' + token } });
    assert.equal((await call(valid)).status, 200);
    active = false;
    assert.equal((await call(valid)).status, 401);
    assert.equal(databaseReads, 2);
    assert.equal((await call(makeToken('e-mate-model-session+jwt'))).status, 401);
    assert.equal((await call(makeToken(undefined, now - 120))).status, 401);
    assert.equal(databaseReads, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
