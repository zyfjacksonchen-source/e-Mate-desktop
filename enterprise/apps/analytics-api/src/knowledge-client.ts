import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import type { RuntimeRegistryPrincipal } from './runtime-registry.ts';

export const KNOWLEDGE_PREFIX = '/ecorex-agent/client/knowledge/v1';
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sha256 = /^[a-f0-9]{64}$/;
const maximumResponse = 24 * 1024 * 1024;
const safeErrors: Record<string, string> = {
  IDEMPOTENCY_CONFLICT: '操作编号已用于不同内容，请回查原任务。', LEASE_CONFLICT: '任务运行租约已变化，请回查任务。',
  REVISION_CONFLICT: '知识版本已变化，请回查后继续。', INVALID_CITATION: '原文引用校验失败。',
  PUBLIC_PROVENANCE_REQUIRED: '公共导入需要明确来源声明。', FORBIDDEN: '当前资料范围不允许该操作。',
  NOT_READY: '仍有编译内容未完成。', SUBMISSION_UNKNOWN: '提交结果未知，请先回查原请求。',
  INVALID_QUERY: '知识请求参数无效。', NOT_FOUND: '资料不存在或当前不可读。',
  KNOWLEDGE_NOT_ENABLED: '当前企业尚未连接公共知识。', CORPUS_CHANGED: '资料版本已变化，请重新查询。',
  SOURCE_VERSION_CHANGED: '来源版本已变化，请重新查询。', ORIGINAL_UNAVAILABLE: '来源原件暂不可用。',
  KNOWLEDGE_UNAVAILABLE: '公共知识暂不可用，请稍后重试。', RESULT_TOO_LARGE: '结果过大，请缩小范围。',
};
export class KnowledgeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(safeErrors[code] ?? safeErrors.KNOWLEDGE_UNAVAILABLE);
    this.status = status; this.code = code;
  }
}
export type KnowledgeReply = { status: number; body: Buffer; contentType: string; disposition?: string };
export type KnowledgeReader = {
  read(principal: RuntimeRegistryPrincipal, action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<KnowledgeReply>;
};
export type KnowledgeApi = {
  // Deliberately the access-session-only authenticator, never bootstrap admin keys.
  authenticate(token: string): Promise<RuntimeRegistryPrincipal | null>;
  client: KnowledgeReader;
};
export type KnowledgeConfiguration = { socketPath: string; tenantMappings: Record<string, string>; accessClientId: string };

export function parseKnowledgeConfiguration(value: unknown): KnowledgeConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid knowledge configuration');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'accessClientId,socketPath,tenantMappings' || typeof input.socketPath !== 'string'
    || !isAbsolute(input.socketPath) || normalize(input.socketPath) !== input.socketPath || input.socketPath.length > 100
    || /[\x00-\x1f]/u.test(input.socketPath) || !input.socketPath.endsWith('.sock')) throw new Error('Invalid knowledge socket');
  if (typeof input.accessClientId !== 'string' || !identifier.test(input.accessClientId)) throw new Error('Invalid knowledge access client');
  if (!input.tenantMappings || typeof input.tenantMappings !== 'object' || Array.isArray(input.tenantMappings)) throw new Error('Invalid knowledge tenants');
  const mappings = Object.entries(input.tenantMappings);
  if (mappings.length < 1 || mappings.length > 100 || mappings.some(([k, v]) => !identifier.test(k) || typeof v !== 'string' || !identifier.test(v))) throw new Error('Invalid knowledge tenants');
  return { socketPath: input.socketPath, tenantMappings: Object.fromEntries(mappings), accessClientId: input.accessClientId };
}

export function knowledgeRoute(method: string | undefined, url: URL, payload: unknown): { action: string; params: Record<string, unknown> } {
  const path = url.pathname.slice(KNOWLEDGE_PREFIX.length);
  if (method === 'GET' && (path === '/imports' || path === '/compilations')) {
    const entries = [...url.searchParams];
    if (entries.length !== 1 || entries[0]![0] !== 'operation_id' || !/^[A-Za-z0-9_-]{16,80}$/.test(entries[0]![1])) throw new KnowledgeError(400, 'INVALID_QUERY');
    return { action: path.slice(1) + '.lookup', params: { operation_id: entries[0]![1] } };
  }
  const identifierPath = /^\/(imports|compilations|revisions)\/([a-f0-9-]{36})(?:\/(claim|commit|content))?$/.exec(path);
  const writeKeys: Record<string, readonly string[]> = {
    'imports.create': ['operation_id', 'filename', 'title', 'publisher', 'kind', 'sha256', 'byte_length', 'scope', 'provenance', 'supersedes'],
    'compilations.create': ['operation_id', 'source_versions', 'model', 'topics', 'scope', 'benchmark_query_ids'],
    'compilations.claim': ['expected_version', 'runner_id'],
    'compilations.checkpoint': ['expected_version', 'lease_token', 'state', 'checkpoint'],
    'compilations.commit': ['expected_version', 'lease_token', 'revision_ids'],
    'revisions.put': ['compilation_id', 'expected_version', 'lease_token', 'topic_key', 'markdown', 'claims'],
  };
  let writeAction: string | undefined;
  const target: Record<string, unknown> = {};
  if (method === 'POST' && (path === '/imports' || path === '/compilations')) writeAction = path.slice(1) + '.create';
  if (identifierPath) {
    const [, collection, id, operation] = identifierPath;
    target[collection === 'imports' ? 'import_id' : collection === 'compilations' ? 'compilation_id' : 'revision_id'] = id;
    if (method === 'GET' && !operation) {
      if (url.search) throw new KnowledgeError(400, 'INVALID_QUERY');
      return { action: collection + '.get', params: target };
    }
    if (method === 'POST' && collection === 'compilations' && (operation === 'claim' || operation === 'commit')) writeAction = collection + '.' + operation;
    if (method === 'PATCH' && collection === 'compilations' && !operation) writeAction = 'compilations.checkpoint';
    if (method === 'PUT' && collection === 'revisions' && !operation) writeAction = 'revisions.put';
    if (method === 'PUT' && collection === 'imports' && operation === 'content') {
      if (url.search || !Buffer.isBuffer(payload) || payload.length < 1 || payload.length > 20 * 1024 * 1024) throw new KnowledgeError(400, 'INVALID_QUERY');
      return { action: 'imports.content', params: { ...target, content: payload } };
    }
  }
  if (writeAction) {
    if (url.search || !payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(k => !writeKeys[writeAction!]!.includes(k))) throw new KnowledgeError(400, 'INVALID_QUERY');
    return { action: writeAction, params: { ...payload, ...target } };
  }
  const chunksPath = /^\/sources\/([a-f0-9-]{36})\/chunks$/.exec(path);
  if (method === 'GET' && (path === '/revisions' || chunksPath)) {
    const params: Record<string, unknown> = {};
    const keys = chunksPath ? ['version', 'parse_revision', 'scope', 'offset'] : ['scope', 'question', 'limit', 'offset', 'corpus_revision'];
    for (const [key, value] of url.searchParams) {
      if (!keys.includes(key) || Object.hasOwn(params, key)) throw new KnowledgeError(400, 'INVALID_QUERY');
      params[key] = value;
    }
    if (params.scope !== undefined && params.scope !== 'public' && params.scope !== 'uploader-private') throw new KnowledgeError(400, 'INVALID_QUERY');
    params.scope = { kind: params.scope ?? 'uploader-private' };
    for (const key of ['offset', 'limit']) if (params[key] !== undefined) {
      if (!/^(0|[1-9][0-9]*)$/.test(String(params[key]))) throw new KnowledgeError(400, 'INVALID_QUERY');
      params[key] = Number(params[key]);
    }
    if (!chunksPath && params.offset !== undefined && (!Number.isSafeInteger(params.offset) || Number(params.offset) > 10000 || Number(params.offset) > 0 && (typeof params.corpus_revision !== 'string' || !sha256.test(params.corpus_revision)))) throw new KnowledgeError(400, 'INVALID_QUERY');
    if (chunksPath) {
      const version = { source_id: chunksPath[1], source_version: params.version, parse_revision: params.parse_revision };
      delete params.parse_revision; params.version = version;
    }
    return { action: chunksPath ? 'sources.chunks' : 'revisions.list', params };
  }
  const queries: Record<string, readonly string[]> = {
    '/catalog': ['scope'], '/sources': ['kind', 'offset', 'limit', 'corpus_revision', 'scope'],
    '/benchmark': ['keyword'], '/graph': ['root_id', 'depth', 'limit', 'corpus_revision', 'scope'],
  };
  if (method === 'GET') {
    const match = /^\/(sources|nodes|evidence)\/([a-f0-9-]{36}|[a-f0-9]{64})(\/original)?$/.exec(path);
    let action: string;
    let keys: readonly string[];
    const params: Record<string, unknown> = {};
    if (Object.hasOwn(queries, path)) {
      action = path === '/benchmark' ? 'benchmarks' : path.slice(1); keys = queries[path]!;
    } else if (match && (match[3] === undefined || match[1] === 'sources')) {
      action = match[1] === 'sources' ? (match[3] ? 'original' : 'source') : match[1] === 'nodes' ? 'node' : match[1]!;
      keys = action === 'evidence' ? ['scope'] : ['version', 'scope'];
      params[action === 'node' ? 'node_id' : action === 'evidence' ? 'query_id' : 'source_id'] = match[2];
    } else throw new KnowledgeError(404, 'NOT_FOUND');
    for (const [key, value] of url.searchParams) {
      if (!keys.includes(key) || Object.hasOwn(params, key)) throw new KnowledgeError(400, 'INVALID_QUERY');
      params[key] = value;
    }
    return { action, params };
  }
  if (method === 'POST' && (path === '/search' || path === '/benchmark')) {
    if (url.search || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new KnowledgeError(400, 'INVALID_QUERY');
    const params = payload as Record<string, unknown>;
    const keys = path === '/search' ? ['question', 'limit', 'layer', 'corpus_revision', 'scope'] : ['media', 'industry', 'metric', 'period', 'source_id', 'marketing_purpose'];
    if (Object.keys(params).some(k => !keys.includes(k))) throw new KnowledgeError(400, 'INVALID_QUERY');
    return { action: path === '/search' ? 'search' : 'benchmark', params };
  }
  throw new KnowledgeError(404, 'NOT_FOUND');
}

export function createKnowledgeClient(rawConfiguration: KnowledgeConfiguration): KnowledgeReader {
  const configuration = parseKnowledgeConfiguration(rawConfiguration);
  let active = 0;
  return { async read(principal, action, params, signal) {
    if (!principal.tenantId || !principal.userId || !identifier.test(principal.tenantId) || !identifier.test(principal.userId)) throw new KnowledgeError(401, 'NOT_FOUND');
    if (!Object.hasOwn(configuration.tenantMappings, principal.tenantId)) throw new KnowledgeError(403, 'KNOWLEDGE_NOT_ENABLED');
    if (active >= 4) throw new KnowledgeError(429, 'KNOWLEDGE_UNAVAILABLE');
    signal?.throwIfAborted();
    const write = action.includes('.');
    const binary = action === 'imports.content';
    const envelope = { actor: { enterprise_tenant_id: principal.tenantId, subject_id: principal.userId }, knowledge_tenant_id: configuration.tenantMappings[principal.tenantId], action, params: binary ? {} : params };
    const body = binary ? params.content as Buffer : Buffer.from(JSON.stringify(envelope));
    if (!Buffer.isBuffer(body) || body.length > (binary ? 20 * 1024 * 1024 : write ? 1024 * 1024 : 65536)) throw new KnowledgeError(413, 'INVALID_QUERY');
    active++;
    try {
      return await new Promise<KnowledgeReply>((resolve, reject) => {
        const request = httpRequest({ socketPath: configuration.socketPath, path: binary ? `/imports/${params.import_id}/content` : write ? '/write' : '/read', method: binary ? 'PUT' : 'POST', signal,
          headers: { 'content-type': binary ? 'application/octet-stream' : 'application/json', 'content-length': body.length,
            ...(binary ? { 'x-knowledge-context': Buffer.from(JSON.stringify(envelope)).toString('base64') } : {}) },
        }, response => {
          const chunks: Buffer[] = []; let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maximumResponse) request.destroy(new KnowledgeError(502, 'RESULT_TOO_LARGE'));
            else chunks.push(chunk);
          });
          response.on('error', () => reject(new KnowledgeError(503, 'KNOWLEDGE_UNAVAILABLE')));
          response.on('end', () => {
            const bytes = Buffer.concat(chunks);
            const status = response.statusCode ?? 502;
            const contentType = response.headers['content-type']?.split(';', 1)[0];
            if (status !== 200) {
              let code = 'KNOWLEDGE_UNAVAILABLE';
              try { const parsed = JSON.parse(bytes.toString('utf8')); if (Object.hasOwn(safeErrors, parsed?.error)) code = parsed.error; } catch { /* Fixed safe error below. */ }
              reject(new KnowledgeError([400, 403, 404, 409, 413, 429].includes(status) ? status : 503, code)); return;
            }
            if (action === 'original') {
              if (contentType !== 'application/octet-stream' || typeof params.version !== 'string' || !sha256.test(params.version)
                || response.headers['x-source-version'] !== params.version || createHash('sha256').update(bytes).digest('hex') !== params.version) {
                reject(new KnowledgeError(502, 'SOURCE_VERSION_CHANGED')); return;
              }
              const disposition = response.headers['content-disposition'];
              resolve({ status, body: bytes, contentType, disposition: typeof disposition === 'string' && /^attachment; filename\*=UTF-8''[A-Za-z0-9%._~!$&'()*+,;=:@-]{1,1600}$/u.test(disposition) ? disposition : 'attachment' }); return;
            }
            try {
              const json = JSON.parse(bytes.toString('utf8'));
              if (contentType !== 'application/json' || json.schema_version !== 1 || (write ? !['enterprise-subject', 'public', 'uploader-private'].includes(json.scope?.kind) : !['public', 'uploader-private'].includes(json.scope?.kind) || !sha256.test(json.corpus_revision))) throw Error('invalid');
            } catch { reject(new KnowledgeError(502, 'KNOWLEDGE_UNAVAILABLE')); return; }
            resolve({ status, body: bytes, contentType: 'application/json; charset=utf-8' });
          });
        });
        const deadline = setTimeout(() => request.destroy(new KnowledgeError(503, 'KNOWLEDGE_UNAVAILABLE')), 30000);
        request.once('close', () => clearTimeout(deadline));
        request.on('error', error => reject(error instanceof KnowledgeError ? error : new KnowledgeError(503, 'KNOWLEDGE_UNAVAILABLE')));
        request.end(body);
      });
    } finally { active--; }
  } };
}
