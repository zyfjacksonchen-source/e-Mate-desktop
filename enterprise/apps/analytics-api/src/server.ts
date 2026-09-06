import { KNOWLEDGE_PREFIX, KnowledgeError, knowledgeRoute, type KnowledgeApi } from './knowledge-client.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  parseObservabilityPolicyRollback,
  parseObservabilityPolicyUpdate,
  type ObservabilityPolicy,
  type ObservabilityPolicyRollback,
  type ObservabilityPolicyUpdate,
} from '@e-mate/observability-policy-contract';
import { parseRuntimeRegistryHeartbeat, type RuntimeRegistryHeartbeat } from '@e-mate/runtime-registry-contract';
import { parseSessionSummarySearchResult, parseSessionSummaryWrite } from '@e-mate/session-index-contract';
import { parseMonitoringPeriod, type MonitoringPeriod } from '@e-mate/monitoring-contract';
import {
  parseAdminApiKeyCreate,
  parseAdminConsentQuery,
  parseAdminModelRouteKeyUpdate,
  parseAdminModelRoutePublication,
  parseAdminModelRouteUpdate,
  parseAdminModelFastModeUpdate,
  parseAdminPasswordReset,
  parseTenantUserCreate,
  parseTenantUserDelete,
  parseTenantUserUpdate,
} from '@e-mate/admin-contract';
import type { ConsentStore } from '@e-mate/consent-store';
import { AdminManagementError, type AdminManagementStore } from './admin-management.ts';
import { ModelFastModeError, type ModelFastModeControl } from './model-fast-mode.ts';
import { type RuntimeRegistryPrincipal, type RuntimeRegistryStore } from './runtime-registry.ts';
import type { ObservabilityPolicyMutationResult, ObservabilityPolicyStore } from './observability-policy.ts';
import type { SessionSummaryStore } from './session-index.ts';
import type { PlatformMonitoringReader } from './prometheus-monitoring.ts';
import type { UsageAnalyticsQuery, UsageAnalyticsReader } from './usage-analytics.ts';
import type { TaskEventQuery, TaskEventStore } from './task-events.ts';

const maxBodyBytes = 64 * 1024;
const statusRoles = new Set(['SUPER_ADMIN', 'TENANT_ADMIN', 'AUDIT_ADMIN']);
const policyWriteRoles = new Set(['SUPER_ADMIN', 'TENANT_ADMIN']);
const platformMonitoringRoles = new Set(['SUPER_ADMIN']);
const usageRoles = new Set(['SUPER_ADMIN', 'TENANT_ADMIN', 'AUDIT_ADMIN']);
const managementRoles = new Set(['SUPER_ADMIN', 'TENANT_ADMIN']);

export type AuthenticateBearer = (bearer: string) => Promise<RuntimeRegistryPrincipal | null>;

export type AnalyticsApiOptions = {
  knowledge?: KnowledgeApi;
  registry?: RuntimeRegistryStore;
  authenticate: AuthenticateBearer;
  sessionIndex?: SessionSummaryStore;
  observabilityPolicy?: ObservabilityPolicyStore;
  platformMonitoring?: PlatformMonitoringReader;
  usageAnalytics?: UsageAnalyticsReader;
  taskEvents?: TaskEventStore;
  adminManagement?: AdminManagementStore;
  modelFastMode?: ModelFastModeControl;
  consentStore?: ConsentStore;
};

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(body);
}

function empty(response: ServerResponse, status = 204): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end();
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (
    typeof authorization !== 'string' ||
    authorization.length > 8_199 ||
    !/^Bearer [^\s]{1,8192}$/.test(authorization)
  ) {
    throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
  }
  return authorization.slice(7);
}

async function principal(
  request: IncomingMessage,
  authenticate: AuthenticateBearer
): Promise<RuntimeRegistryPrincipal> {
  const token = bearerToken(request);
  let authenticated: RuntimeRegistryPrincipal | null;
  try {
    authenticated = await authenticate(token);
  } catch {
    throw new HttpError(503, 'AUTHENTICATION_UNAVAILABLE', 'Authentication temporarily unavailable');
  }
  if (!authenticated) {
    throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
  }
  return authenticated;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim();
  if (mediaType?.toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'CONTENT_TYPE_UNSUPPORTED', 'Content-Type must be application/json');
  }
  const declared = request.headers['content-length'];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new HttpError(400, 'INVALID_REQUEST', 'Invalid Content-Length');
    }
    if (length > maxBodyBytes) {
      throw new HttpError(413, 'REQUEST_TOO_LARGE', 'Request body too large');
    }
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBodyBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) {
    throw new HttpError(413, 'REQUEST_TOO_LARGE', 'Request body too large');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }
}

function methodNotAllowed(response: ServerResponse, allow: string): void {
  json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }, { allow });
}

function rejectQuery(url: URL): void {
  if (url.search || url.hash) {
    throw new HttpError(400, 'INVALID_REQUEST', 'Query parameters are not allowed');
  }
}

function adminConsentQuery(url: URL) {
  const allowed = new Set(['userId', 'agreementVersion', 'disclaimerVersion', 'acceptedFrom', 'acceptedTo', 'limit']);
  if (
    [...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
    [...allowed].some((key) => url.searchParams.getAll(key).length > 1)
  ) {
    throw new HttpError(400, 'INVALID_CONSENT_QUERY', 'Invalid consent query');
  }
  try {
    return parseAdminConsentQuery({
      ...(url.searchParams.has('userId') ? { userId: url.searchParams.get('userId') } : {}),
      ...(url.searchParams.has('agreementVersion')
        ? { agreementVersion: url.searchParams.get('agreementVersion') }
        : {}),
      ...(url.searchParams.has('disclaimerVersion')
        ? { disclaimerVersion: url.searchParams.get('disclaimerVersion') }
        : {}),
      ...(url.searchParams.has('acceptedFrom') ? { acceptedFrom: url.searchParams.get('acceptedFrom') } : {}),
      ...(url.searchParams.has('acceptedTo') ? { acceptedTo: url.searchParams.get('acceptedTo') } : {}),
      ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
    });
  } catch {
    throw new HttpError(400, 'INVALID_CONSENT_QUERY', 'Invalid consent query');
  }
}

function requireRole(identity: RuntimeRegistryPrincipal, roles: ReadonlySet<string>): void {
  if (!identity.roles.some((role) => roles.has(role))) {
    throw new HttpError(403, 'ACCESS_DENIED', 'Access denied');
  }
}

function requireEnterprisePrincipal(identity: RuntimeRegistryPrincipal): void {
  if (identity.scopes?.length) {
    throw new HttpError(403, 'ACCESS_DENIED', 'Access denied');
  }
}

function throwManagementError(error: unknown): never {
  if (error instanceof AdminManagementError) {
    if (error.code === 'CONFLICT') {
      throw new HttpError(409, 'ADMIN_RESOURCE_CONFLICT', 'Resource already exists');
    }
    if (error.code === 'STALE_UPDATE') {
      throw new HttpError(409, 'ADMIN_USER_STALE', 'User changed since it was loaded');
    }
    throw new HttpError(409, 'ADMIN_USER_UNAVAILABLE', 'Bound user is not active');
  }
  throw new HttpError(503, 'ADMIN_MANAGEMENT_UNAVAILABLE', 'Administration temporarily unavailable');
}

function policyMutation(result: ObservabilityPolicyMutationResult): ObservabilityPolicy {
  switch (result.status) {
    case 'OK':
      return result.policy;
    case 'VERSION_CONFLICT':
      throw new HttpError(409, 'POLICY_VERSION_CONFLICT', 'Observability policy has changed');
    case 'IDEMPOTENCY_CONFLICT':
      throw new HttpError(409, 'POLICY_IDEMPOTENCY_CONFLICT', 'Request ID was already used');
    case 'NO_CHANGE':
      throw new HttpError(409, 'POLICY_NO_CHANGE', 'Observability policy was unchanged');
    case 'VERSION_NOT_FOUND':
      throw new HttpError(404, 'POLICY_VERSION_NOT_FOUND', 'Observability policy version not found');
  }
}

function searchInput(url: URL): {
  query: string;
  projectId?: string;
  includeArchived: boolean;
  limit: number;
} {
  const allowed = new Set(['q', 'projectId', 'includeArchived', 'limit']);
  if (
    [...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
    [...allowed].some((key) => url.searchParams.getAll(key).length > 1)
  ) {
    throw new HttpError(400, 'INVALID_SEARCH', 'Invalid Session search');
  }
  const query = url.searchParams.get('q') ?? '';
  const projectId = url.searchParams.get('projectId');
  const includeArchivedValue = url.searchParams.get('includeArchived');
  const limitValue = url.searchParams.get('limit') ?? '20';
  const limit = Number(limitValue);
  if (
    query.length > 200 ||
    query.trim() !== query ||
    (projectId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(projectId)) ||
    (includeArchivedValue !== null && includeArchivedValue !== 'true' && includeArchivedValue !== 'false') ||
    !/^[1-9]\d*$/.test(limitValue) ||
    !Number.isSafeInteger(limit) ||
    limit > 50
  ) {
    throw new HttpError(400, 'INVALID_SEARCH', 'Invalid Session search');
  }
  return {
    query,
    ...(projectId ? { projectId } : {}),
    includeArchived: includeArchivedValue !== 'false',
    limit,
  };
}

function monitoringPeriod(url: URL): MonitoringPeriod {
  if ([...url.searchParams.keys()].some((key) => key !== 'period') || url.searchParams.getAll('period').length !== 1) {
    throw new HttpError(400, 'INVALID_MONITORING_PERIOD', 'Invalid monitoring period');
  }
  try {
    return parseMonitoringPeriod(url.searchParams.get('period'));
  } catch {
    throw new HttpError(400, 'INVALID_MONITORING_PERIOD', 'Invalid monitoring period');
  }
}

function isIsoTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function usageQuery(url: URL, events = false): UsageAnalyticsQuery {
  const allowed = new Set([
    'from',
    'to',
    'timezone',
    'bucket',
    'userId',
    'modelId',
    ...(events ? ['cursor', 'limit'] : []),
  ]);
  if (
    [...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
    ['from', 'to', 'timezone', 'bucket', 'modelId', ...(events ? ['cursor', 'limit'] : [])]
      .some((key) => url.searchParams.getAll(key).length > 1)
  ) {
    throw new HttpError(400, 'INVALID_USAGE_QUERY', 'Invalid usage query');
  }
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const timezone = url.searchParams.get('timezone') ?? 'UTC';
  const bucket = url.searchParams.get('bucket') ?? 'DAY';
  const userIds = url.searchParams.getAll('userId');
  const modelId = url.searchParams.get('modelId');
  if (
    !from ||
    !to ||
    !isIsoTimestamp(from) ||
    !isIsoTimestamp(to) ||
    !['HOUR', 'DAY'].includes(bucket) ||
    timezone.length < 1 ||
    timezone.length > 64 ||
    /\p{Cc}/u.test(timezone) ||
    userIds.length > 100 ||
    new Set(userIds).size !== userIds.length ||
    userIds.some((userId) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(userId)) ||
    (modelId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(modelId))
  ) {
    throw new HttpError(400, 'INVALID_USAGE_QUERY', 'Invalid usage query');
  }
  const duration = Date.parse(to) - Date.parse(from);
  const maximum = bucket === 'HOUR' ? 31 * 86_400_000 : 366 * 86_400_000;
  if (duration <= 0 || duration > maximum) {
    throw new HttpError(400, 'INVALID_USAGE_QUERY', 'Invalid usage query');
  }
  try {
    if (!new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone) {
      throw new Error('Invalid timezone');
    }
  } catch {
    throw new HttpError(400, 'INVALID_USAGE_QUERY', 'Invalid usage query');
  }
  return {
    from,
    to,
    timezone,
    bucket: bucket as UsageAnalyticsQuery['bucket'],
    ...(userIds.length ? { userIds } : {}),
    ...(modelId ? { modelId } : {}),
  };
}

function taskEventQuery(url: URL): TaskEventQuery {
  const allowed = new Set(['from', 'to', 'timezone', 'userId']);
  if (
    [...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
    ['from', 'to'].some((key) => url.searchParams.getAll(key).length !== 1) ||
    url.searchParams.getAll('timezone').length > 1 ||
    url.searchParams.getAll('userId').length > 100
  ) {
    throw new HttpError(400, 'INVALID_TASK_QUERY', 'Invalid task query');
  }
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const timezone = url.searchParams.get('timezone') ?? 'UTC';
  const userIds = url.searchParams.getAll('userId');
  if (
    !from ||
    !to ||
    !isIsoTimestamp(from) ||
    !isIsoTimestamp(to) ||
    timezone.length < 1 ||
    timezone.length > 64 ||
    /\p{Cc}/u.test(timezone) ||
    new Set(userIds).size !== userIds.length ||
    userIds.some((userId) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(userId))
  ) {
    throw new HttpError(400, 'INVALID_TASK_QUERY', 'Invalid task query');
  }
  const duration = Date.parse(to) - Date.parse(from);
  if (duration <= 0 || duration > 366 * 86_400_000 || Date.parse(to) > Date.now()) {
    throw new HttpError(400, 'INVALID_TASK_QUERY', 'Invalid task query');
  }
  try {
    if (!new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone) {
      throw new Error('Invalid timezone');
    }
  } catch {
    throw new HttpError(400, 'INVALID_TASK_QUERY', 'Invalid task query');
  }
  return { from, to, timezone, ...(userIds.length ? { userIds } : {}) };
}

function usageEventPage(url: URL): { cursor: string | null; limit: number } {
  const cursor = url.searchParams.get('cursor');
  const limitValue = url.searchParams.get('limit') ?? '100';
  const limit = Number(limitValue);
  let parsedCursor: unknown = null;
  if (cursor !== null) {
    try {
      parsedCursor = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      parsedCursor = null;
    }
  }
  if (
    !/^[1-9]\d*$/.test(limitValue) ||
    !Number.isSafeInteger(limit) ||
    limit > 200 ||
    (cursor !== null &&
      (cursor.length > 512 ||
        !/^[A-Za-z0-9_-]+$/.test(cursor) ||
        !Array.isArray(parsedCursor) ||
        parsedCursor.length !== 5 ||
        typeof parsedCursor[0] !== 'string' ||
        !isIsoTimestamp(parsedCursor[0]) ||
        !['REQUEST', 'USAGE'].includes(String(parsedCursor[1])) ||
        typeof parsedCursor[2] !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(parsedCursor[2]) ||
        typeof parsedCursor[3] !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(parsedCursor[3]) ||
        typeof parsedCursor[4] !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(parsedCursor[4])))
  ) {
    throw new HttpError(400, 'INVALID_USAGE_QUERY', 'Invalid usage query');
  }
  return { cursor, limit };
}

export function createAnalyticsHandler({
  registry,
  authenticate,
  knowledge,
  sessionIndex,
  observabilityPolicy,
  platformMonitoring,
  usageAnalytics,
  taskEvents,
  adminManagement,
  modelFastMode,
  consentStore,
}: AnalyticsApiOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://analytics.internal');
      if (url.hash) {
        throw new HttpError(400, 'INVALID_REQUEST', 'Query parameters are not allowed');
      }
      if (url.pathname === KNOWLEDGE_PREFIX || url.pathname.startsWith(KNOWLEDGE_PREFIX + '/')) {
        if (!knowledge) throw new HttpError(503, 'KNOWLEDGE_UNAVAILABLE', '公共知识暂不可用。');
        const identity = await principal(request, knowledge.authenticate);
        requireEnterprisePrincipal(identity);
        const cancellation = new AbortController();
        const abort = () => { if (!response.writableEnded) cancellation.abort(); };
        request.once('aborted', abort);
        response.once('close', abort);
        try {
          const input = knowledgeRoute(request.method, url, request.method === 'POST' ? await readJson(request) : undefined);
          const result = await knowledge.client.read(identity, input.action, input.params, cancellation.signal);
          if (cancellation.signal.aborted) return;
          response.writeHead(result.status, { 'cache-control': 'private, no-store', 'content-type': result.contentType,
            'content-length': result.body.length, 'x-content-type-options': 'nosniff',
            ...(result.disposition ? { 'content-disposition': result.disposition } : {}) });
          response.end(result.body);
        } catch (error) {
          if (cancellation.signal.aborted) return;
          if (error instanceof KnowledgeError) throw new HttpError(error.status, error.code, error.message);
          throw error;
        } finally { request.removeListener('aborted', abort); response.removeListener('close', abort); }
        return;
      }
      if (url.pathname === '/healthz') {
        rejectQuery(url);
        if (request.method !== 'GET') {
          methodNotAllowed(response, 'GET');
          return;
        }
        json(response, 200, { status: 'ok' });
        return;
      }
      if (registry && url.pathname === '/v1/runtime-registry/heartbeats') {
        rejectQuery(url);
        if (request.method !== 'POST') {
          methodNotAllowed(response, 'POST');
          return;
        }
        const identity = await principal(request, authenticate);
        requireEnterprisePrincipal(identity);
        let heartbeat: RuntimeRegistryHeartbeat;
        try {
          heartbeat = parseRuntimeRegistryHeartbeat(await readJson(request));
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(400, 'INVALID_HEARTBEAT', 'Invalid heartbeat');
        }
        if (!(await registry.heartbeat(identity, heartbeat))) {
          throw new HttpError(409, 'STALE_HEARTBEAT', 'Heartbeat sequence is older than the stored lease');
        }
        empty(response);
        return;
      }
      const deleteMatch = url.pathname.match(
        /^\/v1\/runtime-registry\/instances\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/
      );
      if (registry && deleteMatch) {
        rejectQuery(url);
        if (request.method !== 'DELETE') {
          methodNotAllowed(response, 'DELETE');
          return;
        }
        const identity = await principal(request, authenticate);
        requireEnterprisePrincipal(identity);
        if (!(await registry.remove(identity, deleteMatch[1] as string))) {
          throw new HttpError(404, 'LEASE_NOT_FOUND', 'Runtime lease not found');
        }
        empty(response);
        return;
      }
      if (registry && url.pathname === '/runtime/status') {
        rejectQuery(url);
        if (request.method !== 'GET') {
          methodNotAllowed(response, 'GET');
          return;
        }
        const identity = await principal(request, authenticate);
        requireRole(identity, statusRoles);
        json(response, 200, await registry.status(identity.tenantId));
        return;
      }
      if (url.pathname === '/v1/admin/consents') {
        if (request.method !== 'GET') {
          methodNotAllowed(response, 'GET');
          return;
        }
        const identity = await principal(request, authenticate);
        requireRole(identity, statusRoles);
        if (!consentStore) {
          throw new HttpError(503, 'CONSENT_STORE_UNAVAILABLE', 'Consent records temporarily unavailable');
        }
        const query = adminConsentQuery(url);
        try {
          json(response, 200, await consentStore.list(identity.tenantId, query));
          return;
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(503, 'CONSENT_STORE_UNAVAILABLE', 'Consent records temporarily unavailable');
        }
      }
      if (url.pathname === '/v1/admin/users') {
        rejectQuery(url);
        if (request.method !== 'GET' && request.method !== 'POST') {
          methodNotAllowed(response, 'GET, POST');
          return;
        }
        const identity = await principal(request, authenticate);
        requireRole(identity, managementRoles);
        if (!adminManagement) {
          throw new HttpError(503, 'ADMIN_MANAGEMENT_UNAVAILABLE', 'Administration temporarily unavailable');
        }
        try {
          if (request.method === 'GET') {
            json(response, 200, await adminManagement.listUsers(identity));
            return;
          }
          const input = parseTenantUserCreate(await readJson(request));
          json(response, 201, await adminManagement.createUser(identity, input));
          return;
        } catch (error) {
          if (error instanceof HttpError) throw error;
          if (error instanceof AdminManagementError) throwManagementError(error);
          if (error instanceof Error && error.message.startsWith('Invalid ')) {
            throw new HttpError(400, 'INVALID_ADMIN_USER', 'Invalid user');
          }
          throwManagementError(error);
        }
      }
      const adminPasswordMatch = url.pathname.match(
        /^\/v1\/admin\/users\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/password$/
      );
      if (adminPasswordMatch) {
        rejectQuery(url);
        if (request.method !== 'PUT') {
          methodNotAllowed(response, 'PUT');
          return;
        }
        const identity = await principal(request, authenticate);
        requireRole(identity, managementRoles);
        if (!adminManagement) {
          throw new HttpError(503, 'ADMIN_MANAGEMENT_UNAVAILABLE', 'Administration temporarily unavailable');
        }
        try {
          const input = parseAdminPasswordReset(await readJson(request));
          if (!(await adminManagement.resetPassword(identity, adminPasswordMatch[1] as string, input))) {
            throw new HttpError(404, 'ADMIN_USER_NOT_FOUND', 'User not found');
          }
          empty(response);
          return;
        } catch (error) {
          if (error instanceof HttpError) throw error;
          if (error instanceof Error && error.message.startsWith('Invalid ')) {
            throw new HttpError(400, 'INVALID_ADMIN_PASSWORD_RESET', 'Invalid password reset');
          }
          throwManagementError(error);
        }
      }
      const adminUserMatch = url.pathname.match(/^\/v1\/admin\/users\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/);
      if (adminUserMatch) {
        rejectQuery(url);
        if (request.method !== 'PUT' && request.method !== 'DELETE') {
          methodNotAllowed(response, 'PUT, DELETE');
          return;
        }
        const identity = await principal(request, authenticate);
        requireRole(identity, managementRoles);
        if (!adminManagement) {
          throw new HttpError(503, 'ADMIN_MANAGEMENT_UNAVAILABLE', 'Administration temporarily unavailable');
        }
        try {
          if (request.method === 'DELETE') {
            const input = parseTenantUserDelete(await readJson(request));
            if (!(await adminManagement.deleteUser(identity, adminUserMatch[1] as string, input))) {
              throw new HttpError(404, 'ADMIN_USER_NOT_FOUND', 'User not found');
            }
            empty(response);
            return;
          }
          const input = parseTenantUserUpdate(await readJson(request));
          const user = await adminManagement.updateUser(identity, adminUserMatch[1] as string, input);
          if (!user) throw new HttpError(404, 'ADMIN_USER_NOT_FOUND', 'User not found');
          json(response, 200, user);
          return;
        } catch (error) {
          if (error instanceof HttpError) throw error;
          if (error instanceof Error && error.message.startsWith('Invalid ')) {
            throw new HttpError(400, 'INVALID_ADMIN_USER', 'Invalid user');
          }
          throwManagementError(error);
        }
      }
      if (url.pathname === '/v1/admin/api-keys') {
        rejectQuery(url);
        if (request.method !== 'GET' && request.method !== 'POST') {
          methodNotAllowed(response, 'GET, POST');
          return;
        }
        const identity = await principal(request, authenticate);
        requireRole(identity, managementRoles);
        if (!adminManagement) {
          throw new HttpError(503, 'ADMIN_MANAGEMENT_UNAVAILABLE', 'Administration temporarily unavailable');
        }
        try {
          if (request.method === 'GET') {
            json(response, 200, await adminManagement.listApiKeys(identity));
            return;
          }
          const input = parseAdminApiKeyCreate(await readJson(request));
          json(response, 201, await adminManagement.issueApiKey(identity, input));
          return;
        } catch (error) {
          if (error instanceof HttpError) throw error;
          if (error instanceof AdminManagementError) throwManagementError(error);
          if (error instanceof Error && error.message.startsWith('Invalid ')) {
            throw new HttpError(400, 'INVALID_ADMIN_API_KEY', 'Invalid API key');
          }
          throwManagementError(error);
        }
      }
      const revokeKeyMatch = url.pathname.match(/^\/v1\/admin\/api-keys\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/revoke$/);
      if (revokeKeyMatch) {
        rejectQuery(url);
        if (request.method !== 'POST') {
          methodNotAllowed(response, 'POST');
          return;
        }
        const identity = await principal(request, authenticate);
        requireRole(identity, managementRoles);
        if (!adminManagement) {
          throw new HttpError(503, 'ADMIN_MANAGEMENT_UNAVAILABLE', 'Administration temporarily unavailable');
        }
        try {
          if (!(await adminManagement.revokeApiKey(identity, revokeKeyMatch[1] as string))) {
            throw new HttpError(404, 'ADMIN_API_KEY_NOT_FOUND', 'API key not found');
          }
          empty(response);
          return;
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throwManagementError(error);
        }
      }
      if (url.pathname === '/v1/admin/model-fast-mode') {
        rejectQuery(url);
        if (request.method !== 'GET' && request.method !== 'PUT') {
          methodNotAllowed(response, 'GET, PUT');
          return;
        }
        const identity = await principal(request, authenticate);
        requireEnterprisePrincipal(identity);
        requireRole(identity, managementRoles);
        if (!modelFastMode) throw new HttpError(503, 'GPT_FAST_MODE_UNAVAILABLE', 'GPT fast mode unavailable');
        try {
          const result = request.method === 'GET'
            ? await modelFastMode.read(identity)
            : await modelFastMode.update(identity, parseAdminModelFastModeUpdate(await readJson(request)));
          json(response, 200, result);
          return;
        } catch (error) {
          if (error instanceof HttpError) throw error;
          if (error instanceof ModelFastModeError && error.code === 'FORBIDDEN') {
            throw new HttpError(403, 'ACCESS_DENIED', 'Access denied');
          }
          if (error instanceof ModelFastModeError && error.code === 'CONFLICT') {
            throw new HttpError(409, 'GPT_FAST_MODE_CONFLICT', 'GPT fast mode changed; reload and retry');
          }
          if (error instanceof Error && error.message.startsWith('Invalid GPT fast mode')) {
            throw new HttpError(400, 'INVALID_GPT_FAST_MODE', 'Invalid GPT fast mode');
          }
          throw new HttpError(503, 'GPT_FAST_MODE_UNAVAILABLE', 'GPT fast mode unavailable');
        }
      }
      if (url.pathname === '/v1/admin/model-routes') {
        rejectQuery(url);
        if (request.method !== 'GET') {
          methodNotAllowed(response, 'GET');
          return;
        }
        const identity = await principal(request, authenticate);
        requireRole(identity, managementRoles);
        if (!adminManagement) {
          throw new HttpError(503, 'ADMIN_MANAGEMENT_UNAVAILABLE', 'Administration temporarily unavailable');
        }
        try {
          json(response, 200, await adminManagement.listModelRoutes(identity));
          return;
        } catch (error) {
          throwManagementError(error);
        }
      }
      const modelRouteMatch = url.pathname.match(/^\/v1\/admin\/model-routes\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/);
      if (modelRouteMatch) {
        rejectQuery(url);
        if (request.method !== 'PUT') {
          methodNotAllowed(response, 'PUT');
          return;
        }
        const identity = await principal(request, authenticate);
        requireRole(identity, managementRoles);
        if (!adminManagement) {
          throw new HttpError(503, 'ADMIN_MANAGEMENT_UNAVAILABLE', 'Administration temporarily unavailable');
        }
        try {
          const input = parseAdminModelRouteUpdate(await readJson(request));
          const route = await adminManagement.updateModelRoute(identity, modelRouteMatch[1] as string, input);
          if (!route) throw new HttpError(404, 'ADMIN_MODEL_ROUTE_NOT_FOUND', 'Model route not found');
          json(response, 200, route);
          return;
        } catch (error) {
          if (error instanceof HttpError) throw error;
          if (error instanceof Error && error.message.startsWith('Invalid ')) {
            throw new HttpError(400, 'INVALID_ADMIN_MODEL_ROUTE', 'Invalid model route');
          }
          throwManagementError(error);
        }
      }
      const modelRouteKeyMatch = url.pathname.match(
        /^\/v1\/admin\/model-routes\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/key$/
      );
      const modelRoutePublicationMatch = url.pathname.match(
        /^\/v1\/admin\/model-routes\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/publication$/
      );
      if (modelRoutePublicationMatch) {
        rejectQuery(url);
        if (request.method !== 'PUT') {
          methodNotAllowed(response, 'PUT');
          return;
        }
        const identity = await principal(request, authenticate);
        requireRole(identity, managementRoles);
        if (!adminManagement) {
          throw new HttpError(503, 'ADMIN_MANAGEMENT_UNAVAILABLE', 'Administration temporarily unavailable');
        }
        try {
          const input = parseAdminModelRoutePublication(await readJson(request));
          const route = await adminManagement.publishModelRoute(
            identity,
            modelRoutePublicationMatch[1] as string,
            input
          );
          if (!route) throw new HttpError(404, 'ADMIN_MODEL_ROUTE_NOT_FOUND', 'Model route not found');
          json(response, 200, route);
          return;
        } catch (error) {
          if (error instanceof HttpError) throw error;
          if (error instanceof Error && error.message.startsWith('Invalid admin model route publication')) {
            throw new HttpError(400, 'INVALID_ADMIN_MODEL_ROUTE_PUBLICATION', 'Invalid model route publication');
          }
          throwManagementError(error);
        }
      }
      if (modelRouteKeyMatch) {
        rejectQuery(url);
        if (request.method !== 'PUT') {
          methodNotAllowed(response, 'PUT');
          return;
        }
        const identity = await principal(request, authenticate);
        requireRole(identity, managementRoles);
        if (!adminManagement) {
          throw new HttpError(503, 'ADMIN_MANAGEMENT_UNAVAILABLE', 'Administration temporarily unavailable');
        }
        try {
          const input = parseAdminModelRouteKeyUpdate(await readJson(request));
          const route = await adminManagement.updateModelRouteKey(identity, modelRouteKeyMatch[1] as string, input);
          if (!route) throw new HttpError(404, 'ADMIN_MODEL_ROUTE_NOT_FOUND', 'Model route not found');
          json(response, 200, route);
          return;
        } catch (error) {
          if (error instanceof HttpError) throw error;
          if (error instanceof Error && error.message.startsWith('Invalid admin model route key')) {
            throw new HttpError(400, 'INVALID_ADMIN_MODEL_ROUTE_KEY', 'Invalid model route key');
          }
          throwManagementError(error);
        }
      }
      if (platformMonitoring && url.pathname === '/v1/operations/observability') {
        if (request.method !== 'GET') {
          methodNotAllowed(response, 'GET');
          return;
        }
        const identity = await principal(request, authenticate);
        requireRole(identity, platformMonitoringRoles);
        const period = monitoringPeriod(url);
        try {
          json(response, 200, await platformMonitoring.read(period));
        } catch {
          throw new HttpError(503, 'MONITORING_UNAVAILABLE', 'Platform monitoring temporarily unavailable');
        }
        return;
      }
      if (url.pathname === '/v1/tasks/summary') {
        if (request.method !== 'GET') {
          methodNotAllowed(response, 'GET');
          return;
        }
        const identity = await principal(request, authenticate);
        requireRole(identity, usageRoles);
        if (!taskEvents) {
          throw new HttpError(503, 'TASK_EVENTS_UNAVAILABLE', 'Task events temporarily unavailable');
        }
        const query = taskEventQuery(url);
        try {
          json(response, 200, await taskEvents.summary(identity, query));
        } catch {
          throw new HttpError(503, 'TASK_EVENTS_UNAVAILABLE', 'Task events temporarily unavailable');
        }
        return;
      }
      if (
        url.pathname === '/v1/usage/summary' ||
        url.pathname === '/v1/usage/reconciliation' ||
        url.pathname === '/v1/usage/events'
      ) {
        if (request.method !== 'GET') {
          methodNotAllowed(response, 'GET');
          return;
        }
        const identity = await principal(request, authenticate);
        requireRole(identity, usageRoles);
        if (!usageAnalytics) {
          throw new HttpError(503, 'USAGE_ANALYTICS_UNAVAILABLE', 'Usage analytics temporarily unavailable');
        }
        const events = url.pathname.endsWith('/events');
        const query = usageQuery(url, events);
        try {
          if (events) {
            if (!usageAnalytics.events) {
              throw new HttpError(503, 'USAGE_ANALYTICS_UNAVAILABLE', 'Usage analytics temporarily unavailable');
            }
            const page = usageEventPage(url);
            json(response, 200, await usageAnalytics.events(identity, query, page.cursor, page.limit));
            return;
          }
          const result = await usageAnalytics.read(identity, query);
          json(response, 200, url.pathname.endsWith('/summary') ? result.projection : result.reconciliation);
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(503, 'USAGE_ANALYTICS_UNAVAILABLE', 'Usage analytics temporarily unavailable');
        }
        return;
      }
      if (observabilityPolicy
        && (url.pathname === '/v1/observability-policy' || url.pathname === '/v1/observability-policy/rollback')) {
        rejectQuery(url);
        const rollback = url.pathname.endsWith('/rollback');
        const allow = rollback ? 'POST' : 'GET, PUT';
        if (
          (rollback && request.method !== 'POST') ||
          (!rollback && request.method !== 'GET' && request.method !== 'PUT')
        ) {
          methodNotAllowed(response, allow);
          return;
        }
        const identity = await principal(request, authenticate);
        requireRole(identity, rollback || request.method === 'PUT' ? policyWriteRoles : statusRoles);
        if (request.method === 'GET') {
          try {
            json(response, 200, await observabilityPolicy.get(identity.tenantId));
          } catch {
            throw new HttpError(503, 'POLICY_UNAVAILABLE', 'Observability policy temporarily unavailable');
          }
          return;
        }
        let update: ObservabilityPolicyUpdate | undefined;
        let rollbackInput: ObservabilityPolicyRollback | undefined;
        try {
          const body = await readJson(request);
          if (rollback) {
            rollbackInput = parseObservabilityPolicyRollback(body);
          } else {
            update = parseObservabilityPolicyUpdate(body);
          }
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(
            400,
            rollback ? 'INVALID_POLICY_ROLLBACK' : 'INVALID_POLICY_UPDATE',
            rollback ? 'Invalid observability policy rollback' : 'Invalid observability policy update'
          );
        }
        let result: ObservabilityPolicyMutationResult;
        try {
          result = rollback
            ? await observabilityPolicy.rollback(identity, rollbackInput as ObservabilityPolicyRollback)
            : await observabilityPolicy.update(identity, update as ObservabilityPolicyUpdate);
        } catch {
          throw new HttpError(503, 'POLICY_UNAVAILABLE', 'Observability policy temporarily unavailable');
        }
        json(response, 200, policyMutation(result));
        return;
      }
      if (sessionIndex && url.pathname === '/v1/session-index/search') {
        if (request.method !== 'GET') {
          methodNotAllowed(response, 'GET');
          return;
        }
        const identity = await principal(request, authenticate);
        requireEnterprisePrincipal(identity);
        const input = searchInput(url);
        if (input.projectId && !(identity.projectIds ?? []).includes(input.projectId)) {
          throw new HttpError(403, 'SESSION_ACCESS_DENIED', 'Session access denied');
        }
        const sessions = await sessionIndex.search(identity, input);
        json(response, 200, parseSessionSummarySearchResult({ schemaVersion: 1, sessions }));
        return;
      }
      const sessionMatch = url.pathname.match(/^\/v1\/session-index\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/);
      if (sessionIndex && sessionMatch) {
        rejectQuery(url);
        const identity = await principal(request, authenticate);
        requireEnterprisePrincipal(identity);
        const sessionId = sessionMatch[1] as string;
        if (request.method === 'GET') {
          const summary = await sessionIndex.get(identity, sessionId);
          if (!summary) {
            throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
          }
          json(response, 200, summary);
          return;
        }
        if (request.method === 'PUT') {
          let write;
          try {
            write = parseSessionSummaryWrite(await readJson(request));
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(400, 'INVALID_SESSION_SUMMARY', 'Invalid summary');
          }
          const result = await sessionIndex.write(identity, sessionId, write);
          if (result.status === 'DENIED') {
            throw new HttpError(403, 'SESSION_ACCESS_DENIED', 'Session access denied');
          }
          if (result.status === 'CONFLICT') {
            throw new HttpError(409, 'SESSION_CURSOR_CONFLICT', 'Session summary has changed');
          }
          json(response, 200, result.summary);
          return;
        }
        methodNotAllowed(response, 'GET, PUT');
        return;
      }
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const known = error instanceof HttpError;
      json(response, known ? error.status : 503, {
        error: {
          code: known ? error.code : 'REGISTRY_UNAVAILABLE',
          message: known ? error.message : 'Runtime Registry temporarily unavailable',
        },
      });
    }
  };
}

export function createAnalyticsServer(options: AnalyticsApiOptions): Server {
  const handler = createAnalyticsHandler(options);
  return createServer((request, response) => {
    void handler(request, response);
  });
}
