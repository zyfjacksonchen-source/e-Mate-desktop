import { createKnowledgeClient, parseKnowledgeConfiguration, type KnowledgeConfiguration } from './knowledge-client.ts';
import { createHash, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { parseConsentPolicy, type ConsentPolicy } from '@e-mate/admin-contract';
import { openPostgresConsentStore } from '@e-mate/consent-store';
import { openPostgresAdminManagementStore, type AdminModelRouteDefinition } from './admin-management.ts';
import type { RuntimeRegistryPrincipal } from './runtime-registry.ts';
import { createAnalyticsServer, type AuthenticateBearer } from './server.ts';
import { createModelFastModeControl, type ModelFastModeConfiguration } from './model-fast-mode.ts';
import { openPostgresTaskEventStore } from './task-events.ts';
import { openPostgresUsageAnalyticsReader } from './usage-analytics.ts';
import {
  openPostgresAccessSessionAuthenticator,
  type AccessSessionVerifierOptions,
} from './access-session-auth.ts';

const secretPathPattern = /^\/run\/secrets\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const allowedRoles = new Set(['SUPER_ADMIN', 'TENANT_ADMIN', 'AUDIT_ADMIN']);

type SecretReader = (path: string, label: string, maximumBytes: number) => Buffer;

type PrincipalHashMapping = {
  digest: Buffer;
  principal: RuntimeRegistryPrincipal;
};

export type AnalyticsProductionConfiguration = {
  host: string;
  port: number;
  databaseUrl: string;
  modelRoutes: AdminModelRouteDefinition[];
  consentPolicy: ConsentPolicy;
  modelRouteKeyEncryptionKey?: Buffer;
  sessionAuth?: AccessSessionVerifierOptions;
  modelFastMode?: ModelFastModeConfiguration;
  knowledge?: KnowledgeConfiguration;
  authenticate: AuthenticateBearer;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error(`Invalid ${label}`);
  }
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`Invalid ${label}`);
  }
  return value as number;
}

function text(value: unknown, label: string, maximum = 128): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!identifierPattern.test(parsed)) throw new Error(`Invalid ${label}`);
  return parsed;
}

function secretPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !secretPathPattern.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function stringList(
  value: unknown,
  label: string,
  parse: (entry: unknown, entryLabel: string) => string,
  maximum = 64
): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`Invalid ${label}`);
  const parsed = value.map((entry, index) => parse(entry, `${label} entry ${index + 1}`));
  if (new Set(parsed).size !== parsed.length) throw new Error(`Invalid ${label}`);
  return parsed;
}

function parseJson(buffer: Buffer, label: string): unknown {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function secretText(reader: SecretReader, path: string, label: string): string {
  const value = reader(path, label, 8 * 1_024)
    .toString('utf8')
    .trim();
  if (!value || value.length > 8_192 || /\p{Cc}/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function encryptionKey(reader: SecretReader, path: string): Buffer {
  const encoded = secretText(reader, path, 'model route key encryption key');
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new Error('Invalid model route key encryption key');
  }
  const key = Buffer.from(encoded, 'base64url');
  if (key.byteLength !== 32 || key.toString('base64url') !== encoded) {
    throw new Error('Invalid model route key encryption key');
  }
  return key;
}

export function createHashedBearerAuthenticator(mappings: PrincipalHashMapping[]): AuthenticateBearer {
  const entries = mappings.map(({ digest, principal }) => {
    if (digest.byteLength !== 32) throw new Error('Invalid bearer digest');
    return {
      digest: Buffer.from(digest),
      principal: {
        tenantId: principal.tenantId,
        userId: principal.userId,
        roles: [...principal.roles],
        projectIds: [...(principal.projectIds ?? [])],
      },
    };
  });
  return async (bearer) => {
    const presented = createHash('sha256').update(bearer, 'utf8').digest();
    let match: RuntimeRegistryPrincipal | null = null;
    for (const entry of entries) {
      if (timingSafeEqual(presented, entry.digest)) {
        match = {
          tenantId: entry.principal.tenantId,
          userId: entry.principal.userId,
          roles: [...entry.principal.roles],
          projectIds: [...(entry.principal.projectIds ?? [])],
        };
      }
    }
    return match;
  };
}

function parsePrincipals(input: unknown): PrincipalHashMapping[] {
  const root = record(input, 'management principals');
  exact(root, ['schemaVersion', 'principals'], 'management principals');
  if (root.schemaVersion !== 1 || !Array.isArray(root.principals) || root.principals.length < 1) {
    throw new Error('Invalid management principals');
  }
  if (root.principals.length > 100) throw new Error('Invalid management principals');
  const hashes = new Set<string>();
  return root.principals.map((entry, index) => {
    const principal = record(entry, `management principal ${index + 1}`);
    exact(principal, ['tokenSha256', 'tenantId', 'userId', 'roles', 'projectIds'], `management principal ${index + 1}`);
    if (
      typeof principal.tokenSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(principal.tokenSha256) ||
      /^0{64}$/.test(principal.tokenSha256) ||
      hashes.has(principal.tokenSha256)
    ) {
      throw new Error(`Invalid management principal ${index + 1}`);
    }
    const roles = stringList(
      principal.roles,
      'roles',
      (role) => {
        const parsed = text(role, 'role', 32);
        if (!allowedRoles.has(parsed)) throw new Error('Invalid role');
        return parsed;
      },
      3
    );
    if (roles.length < 1) throw new Error('Invalid roles');
    hashes.add(principal.tokenSha256);
    return {
      digest: Buffer.from(principal.tokenSha256, 'hex'),
      principal: {
        tenantId: identifier(principal.tenantId, 'tenant id'),
        userId: identifier(principal.userId, 'user id'),
        roles,
        projectIds: stringList(principal.projectIds, 'project ids', identifier),
      },
    };
  });
}

function parseModelRoutes(value: unknown): AdminModelRouteDefinition[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new Error('Invalid model routes');
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const route = record(entry, `model route ${index + 1}`);
    exact(route, ['routeId', 'label', 'provider'], `model route ${index + 1}`);
    const parsed = {
      routeId: identifier(route.routeId, 'route id'),
      label: text(route.label, 'route label', 120),
      provider: text(route.provider, 'route provider', 120),
    };
    if (ids.has(parsed.routeId)) throw new Error('Invalid model routes');
    ids.add(parsed.routeId);
    return parsed;
  });
}

export function parseProductionConfiguration(
  input: unknown,
  readSecret: SecretReader
): AnalyticsProductionConfiguration {
  const root = record(input, 'configuration');
  exact(
    root,
    [
      'schemaVersion',
      'listen',
      'database',
      'managementAuth',
      'consentPolicy',
      'modelRoutes',
      ...(root.redis === undefined ? [] : ['redis']),
      ...(root.modelRouteKeys === undefined ? [] : ['modelRouteKeys']),
      ...(root.sessionAuth === undefined ? [] : ['sessionAuth']),
      ...(root.modelFastMode === undefined ? [] : ['modelFastMode']),
      ...(root.knowledge === undefined ? [] : ['knowledge']),
    ],
    'configuration'
  );
  if (root.schemaVersion !== 1) throw new Error('Invalid configuration');

  const listen = record(root.listen, 'listen configuration');
  exact(listen, ['host', 'port'], 'listen configuration');
  if (listen.host !== '127.0.0.1' && listen.host !== '0.0.0.0') {
    throw new Error('Invalid listen host');
  }

  const database = record(root.database, 'database configuration');
  exact(database, ['urlFile'], 'database configuration');
  const databaseFile = secretPath(database.urlFile, 'database URL file');

  if (root.redis !== undefined) {
    const redis = record(root.redis, 'Redis configuration');
    exact(redis, ['urlFile'], 'Redis configuration');
    secretPath(redis.urlFile, 'Redis URL file');
  }

  const managementAuth = record(root.managementAuth, 'management authentication configuration');
  exact(managementAuth, ['principalsFile'], 'management authentication configuration');
  const principalsFile = secretPath(managementAuth.principalsFile, 'management principals file');
  const principals = parsePrincipals(
    parseJson(readSecret(principalsFile, 'management principals', 256 * 1_024), 'management principals')
  );
  let modelRouteKeyEncryptionKey: Buffer | undefined;
  if (root.modelRouteKeys !== undefined) {
    const modelRouteKeys = record(root.modelRouteKeys, 'model route keys configuration');
    exact(modelRouteKeys, ['encryptionKeyFile'], 'model route keys configuration');
    modelRouteKeyEncryptionKey = encryptionKey(
      readSecret,
      secretPath(modelRouteKeys.encryptionKeyFile, 'model route key encryption key file')
    );
  }
  let sessionAuth: AccessSessionVerifierOptions | undefined;
  if (root.sessionAuth !== undefined) {
    const value = record(root.sessionAuth, 'session authentication configuration');
    exact(value, ['issuer', 'audience', 'clientId', 'publicKeys'], 'session authentication configuration');
    if (!Array.isArray(value.publicKeys) || value.publicKeys.length < 1 || value.publicKeys.length > 8) {
      throw new Error('Invalid session authentication public keys');
    }
    const publicKeys = new Map<string, Buffer>();
    for (const entryValue of value.publicKeys) {
      const entry = record(entryValue, 'session authentication public key');
      exact(entry, ['keyId', 'file'], 'session authentication public key');
      const keyId = identifier(entry.keyId, 'session authentication key id');
      if (publicKeys.has(keyId)) throw new Error('Invalid session authentication public keys');
      publicKeys.set(
        keyId,
        readSecret(
          secretPath(entry.file, 'session authentication public key file'),
          'session authentication public key',
          64 * 1_024
        )
      );
    }
    sessionAuth = {
      issuer: text(value.issuer, 'session authentication issuer', 256),
      audience: text(value.audience, 'session authentication audience', 256),
      clientId: identifier(value.clientId, 'session authentication client id'),
      publicKeys,
    };
  }

  const knowledge = root.knowledge === undefined ? undefined : parseKnowledgeConfiguration(root.knowledge);
  if (knowledge && !sessionAuth) throw new Error('Knowledge requires enterprise access session authentication');
  let modelFastMode: ModelFastModeConfiguration | undefined;
  if (root.modelFastMode !== undefined) {
    const value = record(root.modelFastMode, 'GPT fast mode configuration');
    exact(value, ['tenantId', 'sshHost', 'privateKeyFile', 'knownHostsFile'], 'GPT fast mode configuration');
    const sshHost = text(value.sshHost, 'GPT fast mode host', 253);
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(sshHost)) throw new Error('Invalid GPT fast mode host');
    const privateKeyFile = secretPath(value.privateKeyFile, 'GPT fast mode private key');
    const knownHostsFile = secretPath(value.knownHostsFile, 'GPT fast mode known hosts');
    readSecret(privateKeyFile, 'GPT fast mode private key', 16 * 1024);
    readSecret(knownHostsFile, 'GPT fast mode known hosts', 16 * 1024);
    modelFastMode = { tenantId: identifier(value.tenantId, 'GPT fast mode tenant'), sshHost, privateKeyFile, knownHostsFile };
  }

  return {
    host: listen.host,
    port: integer(listen.port, 'listen port', 1, 65_535),
    databaseUrl: secretText(readSecret, databaseFile, 'database URL'),
    consentPolicy: parseConsentPolicy(root.consentPolicy),
    modelRoutes: parseModelRoutes(root.modelRoutes),
    ...(modelRouteKeyEncryptionKey ? { modelRouteKeyEncryptionKey } : {}),
    ...(sessionAuth ? { sessionAuth } : {}),
    ...(modelFastMode ? { modelFastMode } : {}),
    ...(knowledge ? { knowledge } : {}),
    authenticate: createHashedBearerAuthenticator(principals),
  };
}

function externalFile(path: string, label: string, maximumBytes: number): Buffer {
  if (!secretPathPattern.test(path)) throw new Error(`Invalid ${label} path`);
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size < 1 ||
    metadata.size > maximumBytes
  ) {
    throw new Error(`Invalid ${label} file`);
  }
  if (process.platform !== 'win32') {
    const groupPermissions = metadata.mode & 0o070;
    const currentUser = process.getuid?.();
    if (
      (metadata.uid !== 0 && metadata.uid !== currentUser) ||
      (metadata.mode & 0o007) !== 0 ||
      (groupPermissions !== 0 && (groupPermissions !== 0o040 || metadata.gid !== process.getgid?.()))
    ) {
      throw new Error(`Insecure ${label} permissions`);
    }
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size !== metadata.size ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino
    ) {
      throw new Error(`Invalid ${label} file`);
    }
    const value = readFileSync(descriptor);
    if (value.byteLength < 1 || value.byteLength > maximumBytes) throw new Error(`Invalid ${label} file`);
    return value;
  } finally {
    closeSync(descriptor);
  }
}

export function loadProductionConfiguration(configurationFile: string): AnalyticsProductionConfiguration {
  const input = parseJson(externalFile(configurationFile, 'configuration', 256 * 1_024), 'configuration');
  return parseProductionConfiguration(input, externalFile);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  const deadline = setTimeout(() => server.closeAllConnections(), 10_000);
  deadline.unref();
  try {
    await once(server, 'close');
  } finally {
    clearTimeout(deadline);
  }
}

async function closeResources(closers: Array<() => Promise<void>>, index = closers.length - 1): Promise<unknown> {
  if (index < 0) return undefined;
  let firstError: unknown;
  try {
    await (closers[index] as () => Promise<void>)();
  } catch (error) {
    firstError = error;
  }
  const remainingError = await closeResources(closers, index - 1);
  return firstError ?? remainingError;
}

export async function startProductionAnalyticsApi(configurationFile: string): Promise<{
  server: Server;
  close(): Promise<void>;
}> {
  const configuration = loadProductionConfiguration(configurationFile);
  const closers: Array<() => Promise<void>> = [];
  let server: Server | undefined;
  try {
    const usage = await openPostgresUsageAnalyticsReader(configuration.databaseUrl);
    closers.push(usage.close);
    const tasks = await openPostgresTaskEventStore(configuration.databaseUrl);
    closers.push(tasks.close);
    const admin = await openPostgresAdminManagementStore(
      configuration.databaseUrl,
      configuration.modelRoutes,
      configuration.modelRouteKeyEncryptionKey
    );
    closers.push(admin.close);
    const consent = await openPostgresConsentStore(configuration.databaseUrl, configuration.consentPolicy);
    closers.push(consent.close);
    let authenticate = configuration.authenticate;
    let authenticateKnowledge: AuthenticateBearer | undefined;
    if (configuration.sessionAuth) {
      const accessSessions = openPostgresAccessSessionAuthenticator(configuration.databaseUrl, configuration.sessionAuth);
      closers.push(accessSessions.close);
      if (configuration.knowledge) {
        if (configuration.knowledge.accessClientId === configuration.sessionAuth.clientId) authenticateKnowledge = accessSessions.authenticate;
        else {
          const knowledgeSessions = openPostgresAccessSessionAuthenticator(configuration.databaseUrl, { ...configuration.sessionAuth, clientId: configuration.knowledge.accessClientId });
          closers.push(knowledgeSessions.close);
          authenticateKnowledge = knowledgeSessions.authenticate;
        }
      }
      const bootstrapAuthenticate = authenticate;
      authenticate = async (bearer) =>
        (await accessSessions.authenticate(bearer)) ?? (await bootstrapAuthenticate(bearer));
    }
    server = createAnalyticsServer({
      authenticate: authenticate,
      ...(configuration.knowledge && authenticateKnowledge ? { knowledge: { authenticate: authenticateKnowledge, client: createKnowledgeClient(configuration.knowledge) } } : {}),
      usageAnalytics: usage.reader,
      taskEvents: tasks.store,
      adminManagement: admin.store,
      ...(configuration.modelFastMode ? { modelFastMode: createModelFastModeControl(configuration.modelFastMode) } : {}),
      consentStore: consent.store,
    });
    server.listen(configuration.port, configuration.host);
    await once(server, 'listening');
  } catch (error) {
    if (server?.listening) server.close();
    await closeResources(closers);
    throw error;
  }

  const runningServer = server;
  let closing: Promise<void> | null = null;
  return {
    server: runningServer,
    close() {
      closing ??= (async () => {
        let firstError: unknown;
        await closeServer(runningServer).catch((error: unknown) => {
          firstError = error;
        });
        const resourceError = await closeResources(closers);
        firstError ??= resourceError;
        if (firstError) throw firstError;
      })();
      return closing;
    },
  };
}

export async function main(configurationFile = process.env.E_MATE_ANALYTICS_CONFIG_FILE): Promise<void> {
  if (!configurationFile) throw new Error('E_MATE_ANALYTICS_CONFIG_FILE is required');
  const analytics = await startProductionAnalyticsApi(configurationFile);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void analytics.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
