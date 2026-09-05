import { createHash, createPrivateKey, createPublicKey, X509Certificate, type KeyObject } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import { isAbsolute, join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { once } from 'node:events';
import { parseConsentPolicy, type ConsentPolicy } from '@e-mate/admin-contract';
import { openPostgresConsentStore } from '@e-mate/consent-store';
import { openPostgresUsageStore } from './postgres-usage-store.ts';
import { openPostgresTenantModelRoutePolicy } from './tenant-model-route-policy.ts';
import {
  createModelGatewayHandler,
  validateInvocationLimits,
  type InvocationLimits,
  type ModelGatewayRoute,
} from './server.ts';
import { createSessionTokenVerifier } from './session-auth.ts';

type ProductionConfiguration = {
  schemaVersion: 1;
  publicBaseUrl: string;
  listen: {
    host: string;
    port: number;
    tlsCertificateFile: string;
    tlsPrivateKeyFile: string;
  };
  auth: {
    issuer: string;
    audience: string;
    publicKeys: Array<{ keyId: string; file: string }>;
  };
  usage: {
    keyId: string;
    privateKeyFile: string;
  };
  database: {
    urlFile: string;
  };
  consentPolicy: ConsentPolicy;
  routeKeys?: {
    encryptionKeyFile: string;
  };
  quota: InvocationLimits;
  routes: Array<
    Omit<ModelGatewayRoute, 'upstreamApiKey'> & {
      upstreamApiKeyFile: string;
    }
  >;
  upstreamTimeoutMs: number;
};

type LoadedProductionConfiguration = {
  configurationSha256: string;
  publicBaseUrl: string;
  host: string;
  port: number;
  certificate: Buffer;
  tlsPrivateKey: Buffer;
  databaseUrl: string;
  consentPolicy: ConsentPolicy;
  routes: ModelGatewayRoute[];
  authenticate: ReturnType<typeof createSessionTokenVerifier>;
  usageKeyId: string;
  usagePrivateKey: KeyObject;
  routeKeyEncryptionKey?: Buffer;
  quota: InvocationLimits;
  upstreamTimeoutMs: number;
};

export function createProductionAuthenticator(
  authenticateSession: ReturnType<typeof createSessionTokenVerifier>,
  policy: Awaited<ReturnType<typeof openPostgresTenantModelRoutePolicy>>['policy'],
  usageStore: Awaited<ReturnType<typeof openPostgresUsageStore>>['store'],
  routeIds: readonly string[]
): ReturnType<typeof createSessionTokenVerifier> {
  const callableRouteIds = routeIds.filter((routeId) => routeId !== 'deepseek-web-search');
  return async (token) => {
    const sessionPrincipal = await authenticateSession(token);
    if (sessionPrincipal) {
      if (!sessionPrincipal.sessionId || !(await policy.isUserSessionActive(
        sessionPrincipal.tenantId,
        sessionPrincipal.userId,
        sessionPrincipal.sessionId
      ))) return null;
      const tokenScopedRouteIds = callableRouteIds.filter((routeId) => sessionPrincipal.modelIds.includes(routeId));
      if (tokenScopedRouteIds.length === 0) return null;
      const modelIds = await usageStore.activeModelIds(sessionPrincipal, tokenScopedRouteIds);
      return modelIds.length > 0 ? { ...sessionPrincipal, modelIds } : null;
    }
    // Versionless legacy API keys cannot grant the 2.0.18-only model.
    const legacyRouteIds = callableRouteIds.filter((id) => id !== 'gpt-6-astra');
    return legacyRouteIds.length ? policy.authenticateClientCredential(token, legacyRouteIds) : null;
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid ${label}`);
  }
}

function text(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== 'string' || !value || value.length > maximum || /\p{Cc}/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function publicBaseUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(text(value, 'public base URL', 2_048));
  } catch {
    throw new Error('Invalid public base URL');
  }
  const path = url.pathname.replace(/\/+$/u, '');
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || path.endsWith('/v1')) {
    throw new Error('Invalid public base URL');
  }
  url.pathname = path;
  return url.toString().replace(/\/+$/u, '');
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`Invalid ${label}`);
  }
  return value as number;
}

type WindowsAccessRule = {
  sid: string;
  rights: number;
};

type WindowsSecretFile = {
  currentSid: string;
  ownerSid: string;
  daclPresent: boolean;
  daclNull: boolean;
  unknownAllow: boolean;
  rules: WindowsAccessRule[];
  contents: string;
  length: number;
};

const windowsAclScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$path = [Environment]::GetEnvironmentVariable('E_MATE_SECRET_ACL_PATH', 'Process')
if ([string]::IsNullOrWhiteSpace($path)) { throw 'PATH_MISSING' }
$maximum = [int]::Parse(
  [Environment]::GetEnvironmentVariable('E_MATE_SECRET_MAXIMUM_BYTES', 'Process'),
  [Globalization.CultureInfo]::InvariantCulture
)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public sealed class SecretAccessRule {
  public string sid;
  public uint rights;
}

public sealed class SecretFileResult {
  public string currentSid;
  public string ownerSid;
  public bool daclPresent;
  public bool daclNull;
  public bool unknownAllow;
  public SecretAccessRule[] rules;
  public string contents;
  public int length;
}

public static class SecretFileReader {
  const uint GENERIC_READ = 0x80000000;
  const uint OPEN_EXISTING = 3;
  const uint FILE_ATTRIBUTE_NORMAL = 0x80;
  const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const uint FILE_ATTRIBUTE_DIRECTORY = 0x10;
  const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
  const uint DRIVE_FIXED = 3;
  const uint OWNER_SECURITY_INFORMATION = 0x1;
  const uint DACL_SECURITY_INFORMATION = 0x4;
  const int FileAttributeTagInfo = 9;
  const int SE_FILE_OBJECT = 1;

  [StructLayout(LayoutKind.Sequential)]
  struct FILE_ATTRIBUTE_TAG_INFO {
    public uint FileAttributes;
    public uint ReparseTag;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(
    string name,
    uint access,
    uint share,
    IntPtr security,
    uint creation,
    uint flags,
    IntPtr template
  );

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern uint GetDriveTypeW(string rootPath);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(
    SafeFileHandle handle,
    int fileInformationClass,
    out FILE_ATTRIBUTE_TAG_INFO information,
    uint size
  );

  [DllImport("advapi32.dll")]
  static extern uint GetSecurityInfo(
    SafeFileHandle handle,
    int objectType,
    uint securityInformation,
    out IntPtr owner,
    out IntPtr group,
    out IntPtr dacl,
    out IntPtr sacl,
    out IntPtr securityDescriptor
  );

  [DllImport("advapi32.dll")]
  static extern uint GetSecurityDescriptorLength(IntPtr securityDescriptor);

  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr value);

  static bool IsAllow(AceType type) {
    return type == AceType.AccessAllowed ||
      type == AceType.AccessAllowedObject ||
      type == AceType.AccessAllowedCallback ||
      type == AceType.AccessAllowedCallbackObject;
  }

  static bool IsDeny(AceType type) {
    return type == AceType.AccessDenied ||
      type == AceType.AccessDeniedObject ||
      type == AceType.AccessDeniedCallback ||
      type == AceType.AccessDeniedCallbackObject;
  }

  public static SecretFileResult Read(string path, int maximum) {
    if (GetDriveTypeW(Path.GetPathRoot(path)) != DRIVE_FIXED)
      throw new InvalidOperationException("NON_LOCAL_FILE");
    using (SafeFileHandle handle = CreateFileW(
      path,
      GENERIC_READ,
      0,
      IntPtr.Zero,
      OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
      IntPtr.Zero
    )) {
      if (handle.IsInvalid) throw new InvalidOperationException("OPEN_FAILED");
      FILE_ATTRIBUTE_TAG_INFO attributes;
      if (!GetFileInformationByHandleEx(
        handle,
        FileAttributeTagInfo,
        out attributes,
        (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO))
      )) throw new InvalidOperationException("STAT_FAILED");
      if ((attributes.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
        throw new InvalidOperationException("INVALID_FILE");

      IntPtr owner;
      IntPtr group;
      IntPtr dacl;
      IntPtr sacl;
      IntPtr descriptor;
      uint error = GetSecurityInfo(
        handle,
        SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        out owner,
        out group,
        out dacl,
        out sacl,
        out descriptor
      );
      if (error != 0 || descriptor == IntPtr.Zero)
        throw new InvalidOperationException("ACL_FAILED");
      RawSecurityDescriptor security;
      try {
        int descriptorLength = checked((int)GetSecurityDescriptorLength(descriptor));
        byte[] descriptorBytes = new byte[descriptorLength];
        Marshal.Copy(descriptor, descriptorBytes, 0, descriptorLength);
        security = new RawSecurityDescriptor(descriptorBytes, 0);
      } finally {
        LocalFree(descriptor);
      }

      bool daclPresent =
        (security.ControlFlags & ControlFlags.DiscretionaryAclPresent) != 0;
      bool daclNull = security.DiscretionaryAcl == null;
      bool unknownAllow = false;
      List<SecretAccessRule> rules = new List<SecretAccessRule>();
      if (security.DiscretionaryAcl != null) {
        foreach (GenericAce ace in security.DiscretionaryAcl) {
          if ((ace.AceFlags & AceFlags.InheritOnly) != 0 || IsDeny(ace.AceType))
            continue;
          if (!IsAllow(ace.AceType)) {
            unknownAllow = true;
            continue;
          }
          QualifiedAce qualified = ace as QualifiedAce;
          if (qualified == null || qualified.SecurityIdentifier == null) {
            unknownAllow = true;
            continue;
          }
          rules.Add(new SecretAccessRule {
            sid = qualified.SecurityIdentifier.Value,
            rights = unchecked((uint)qualified.AccessMask)
          });
        }
      }

      byte[] bytes;
      using (FileStream stream = new FileStream(handle, FileAccess.Read)) {
        using (MemoryStream output = new MemoryStream()) {
          byte[] buffer = new byte[8192];
          while (true) {
            int count = stream.Read(buffer, 0, buffer.Length);
            if (count == 0) break;
            if (output.Length + count > maximum)
              throw new InvalidOperationException("FILE_TOO_LARGE");
            output.Write(buffer, 0, count);
          }
          bytes = output.ToArray();
        }
      }
      if (bytes.Length == 0) throw new InvalidOperationException("EMPTY_FILE");
      return new SecretFileResult {
        currentSid = WindowsIdentity.GetCurrent().User.Value,
        ownerSid = security.Owner == null ? null : security.Owner.Value,
        daclPresent = daclPresent,
        daclNull = daclNull,
        unknownAllow = unknownAllow,
        rules = rules.ToArray(),
        contents = Convert.ToBase64String(bytes),
        length = bytes.Length
      };
    }
  }
}
'@
[SecretFileReader]::Read($path, $maximum) |
  ConvertTo-Json -Compress -Depth 4
`;

function parseWindowsSecretFile(value: string, maximumBytes: number): WindowsSecretFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Secret file access could not be verified');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Secret file access could not be verified');
  }
  const input = parsed as Record<string, unknown>;
  if (
    Object.keys(input).toSorted().join('|') !==
      'contents|currentSid|daclNull|daclPresent|length|ownerSid|rules|unknownAllow' ||
    typeof input.currentSid !== 'string' ||
    typeof input.ownerSid !== 'string' ||
    typeof input.daclPresent !== 'boolean' ||
    typeof input.daclNull !== 'boolean' ||
    typeof input.unknownAllow !== 'boolean' ||
    typeof input.contents !== 'string' ||
    !Number.isSafeInteger(input.length) ||
    (input.length as number) < 1 ||
    (input.length as number) > maximumBytes ||
    !Array.isArray(input.rules)
  ) {
    throw new Error('Secret file access could not be verified');
  }
  const sidPattern = /^S-\d(?:-\d+)+$/;
  const rules = input.rules.map((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Secret file access could not be verified');
    }
    const rule = value as Record<string, unknown>;
    if (
      Object.keys(rule).toSorted().join('|') !== 'rights|sid' ||
      typeof rule.sid !== 'string' ||
      !sidPattern.test(rule.sid) ||
      !Number.isSafeInteger(rule.rights) ||
      (rule.rights as number) < 0 ||
      (rule.rights as number) > 0xffffffff
    ) {
      throw new Error('Secret file access could not be verified');
    }
    return {
      sid: rule.sid,
      rights: rule.rights as number,
    };
  });
  const contents = Buffer.from(input.contents, 'base64');
  if (
    !sidPattern.test(input.currentSid) ||
    !sidPattern.test(input.ownerSid) ||
    rules.length > 1_024 ||
    contents.length !== input.length ||
    contents.toString('base64') !== input.contents
  ) {
    throw new Error('Secret file access could not be verified');
  }
  return {
    currentSid: input.currentSid,
    ownerSid: input.ownerSid,
    daclPresent: input.daclPresent,
    daclNull: input.daclNull,
    unknownAllow: input.unknownAllow,
    rules,
    contents: input.contents,
    length: input.length as number,
  };
}

function readWindowsSecretFile(path: string, maximumBytes: number): Buffer {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) {
    throw new Error('Secret file access could not be verified');
  }
  const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = Buffer.from(windowsAclScript, 'utf16le').toString('base64');
  const result = spawnSync(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', command],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        E_MATE_SECRET_ACL_PATH: path,
        E_MATE_SECRET_MAXIMUM_BYTES: String(maximumBytes),
      },
      maxBuffer: maximumBytes * 2 + 64 * 1_024,
      timeout: 15_000,
      windowsHide: true,
    }
  );
  if (result.status !== 0 || result.error || result.signal || !result.stdout) {
    throw new Error('Secret file access could not be verified');
  }
  const file = parseWindowsSecretFile(result.stdout.trim(), maximumBytes);
  const trusted = new Set([file.currentSid, 'S-1-5-18', 'S-1-5-32-544']);
  if (!trusted.has(file.ownerSid)) {
    throw new Error('Secret file owner is not trusted');
  }
  if (!file.daclPresent || file.daclNull || file.unknownAllow) {
    throw new Error('Secret file permissions are too broad');
  }
  const sensitiveRights = 0xf00d01ffn;
  if (file.rules.some(({ sid, rights }) => !trusted.has(sid) && (BigInt(rights) & sensitiveRights) !== 0n)) {
    throw new Error('Secret file permissions are too broad');
  }
  return Buffer.from(file.contents, 'base64');
}

export function assertWindowsSecretFileAccess(path: string): void {
  if (process.platform === 'win32') readWindowsSecretFile(path, 64 * 1_024);
}

function externalFile(path: unknown, label: string, maximumBytes: number, secret = false): Buffer {
  const value = text(path, `${label} path`, 4_096);
  if (!isAbsolute(value)) throw new Error(`${label} path must be absolute`);
  if (secret && process.platform === 'win32') {
    if (!/^[A-Za-z]:\\/.test(value)) {
      throw new Error(`${label} file must be on a local drive`);
    }
    return readWindowsSecretFile(value, maximumBytes);
  }
  const before = lstatSync(value);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Invalid ${label} file`);
  }
  const descriptor = openSync(value, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size < 1 ||
      stat.size > maximumBytes
    ) {
      throw new Error(`Invalid ${label} file`);
    }
    if (secret && process.platform !== 'win32') {
      const groupPermissions = stat.mode & 0o070;
      const currentUser = process.getuid?.();
      if (
        (stat.uid !== 0 && stat.uid !== currentUser) ||
        (stat.mode & 0o007) !== 0 ||
        (groupPermissions !== 0 && (groupPermissions !== 0o040 || stat.gid !== process.getgid?.()))
      ) {
        throw new Error(`${label} file permissions are too broad`);
      }
    }
    const contents = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.nlink !== 1 ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs
    ) {
      throw new Error(`${label} file changed while loading`);
    }
    return contents;
  } finally {
    closeSync(descriptor);
  }
}

function route(value: unknown): ProductionConfiguration['routes'][number] {
  const input = record(value, 'route');
  exact(
    input,
    [
      'id',
      ...(input.apiMode === undefined ? [] : ['apiMode']),
      'upstreamModelId',
      'upstreamBaseUrl',
      ...(input.allowInsecureHttpUpstream === undefined ? [] : ['allowInsecureHttpUpstream']),
      'upstreamApiKeyFile',
      'providerId',
      'label',
      'buttonLabel',
      'provider',
      'providerMark',
      'reasoning',
      'input',
      'cost',
      'contextWindow',
      'maxTokens',
      'remoteCompactionV2',
    ],
    'route'
  );
  const cost = record(input.cost, 'route cost');
  exact(cost, ['input', 'output', 'cacheRead', 'cacheWrite'], 'route cost');
  if (input.remoteCompactionV2 !== undefined && typeof input.remoteCompactionV2 !== 'boolean') {
    throw new Error('Invalid remote compaction capability');
  }
  if (input.allowInsecureHttpUpstream !== undefined && input.allowInsecureHttpUpstream !== true) {
    throw new Error('Invalid insecure HTTP upstream opt-in');
  }
  if (
    input.apiMode !== undefined &&
    input.apiMode !== 'responses' &&
    input.apiMode !== 'chat-completions' &&
    input.apiMode !== 'images-generations'
  ) {
    throw new Error('Invalid route API mode');
  }
  return {
    id: text(input.id, 'route id', 128),
    ...(input.apiMode === undefined
      ? {}
      : { apiMode: input.apiMode as 'responses' | 'chat-completions' | 'images-generations' }),
    upstreamModelId: text(input.upstreamModelId, 'upstream model id', 128),
    upstreamBaseUrl: text(input.upstreamBaseUrl, 'upstream URL', 2_048),
    ...(input.allowInsecureHttpUpstream === true ? { allowInsecureHttpUpstream: true as const } : {}),
    upstreamApiKeyFile: text(input.upstreamApiKeyFile, 'API key file', 4_096),
    providerId: text(input.providerId, 'provider id', 128),
    label: text(input.label, 'route label', 80),
    buttonLabel: text(input.buttonLabel, 'route button label', 80),
    provider: text(input.provider, 'provider label', 80),
    providerMark: text(input.providerMark, 'provider mark', 8),
    reasoning: input.reasoning as boolean,
    input: input.input as Array<'text' | 'image'>,
    cost: {
      input: cost.input as number,
      output: cost.output as number,
      cacheRead: cost.cacheRead as number,
      cacheWrite: cost.cacheWrite as number,
    },
    contextWindow: input.contextWindow as number,
    maxTokens: input.maxTokens as number,
    ...(input.remoteCompactionV2 === true ? { remoteCompactionV2: true } : {}),
  };
}

function parseConfiguration(value: unknown): ProductionConfiguration {
  const input = record(value, 'production configuration');
  exact(
    input,
    [
      'schemaVersion',
      'publicBaseUrl',
      'listen',
      'auth',
      'usage',
      'database',
      'consentPolicy',
      'quota',
      'routes',
      'upstreamTimeoutMs',
      ...(input.routeKeys === undefined ? [] : ['routeKeys']),
    ],
    'production configuration'
  );
  const listen = record(input.listen, 'listen configuration');
  const auth = record(input.auth, 'auth configuration');
  const usage = record(input.usage, 'usage configuration');
  const database = record(input.database, 'database configuration');
  const routeKeys = input.routeKeys === undefined ? undefined : record(input.routeKeys, 'route keys configuration');
  const quota = record(input.quota, 'quota configuration');
  exact(listen, ['host', 'port', 'tlsCertificateFile', 'tlsPrivateKeyFile'], 'listen configuration');
  exact(auth, ['issuer', 'audience', 'publicKeys'], 'auth configuration');
  exact(usage, ['keyId', 'privateKeyFile'], 'usage configuration');
  exact(database, ['urlFile'], 'database configuration');
  if (routeKeys) exact(routeKeys, ['encryptionKeyFile'], 'route keys configuration');
  exact(
    quota,
    ['tenantRequestsPerMinute', 'tenantBurst', 'tenantMaxConcurrent', 'invocationLeaseMs'],
    'quota configuration'
  );
  if (input.schemaVersion !== 1 || !Array.isArray(auth.publicKeys) || !Array.isArray(input.routes)) {
    throw new Error('Invalid production configuration');
  }
  const upstreamTimeoutMs = integer(input.upstreamTimeoutMs, 'upstream timeout', 1_000, 600_000);
  const invocationLeaseMs = integer(quota.invocationLeaseMs, 'invocation lease', 1_000, 86_400_000);
  if (invocationLeaseMs < upstreamTimeoutMs + 35_000) {
    throw new Error('Invocation lease is shorter than the recovery window');
  }
  return {
    schemaVersion: 1,
    publicBaseUrl: publicBaseUrl(input.publicBaseUrl),
    listen: {
      host: text(listen.host, 'listen host', 253),
      port: integer(listen.port, 'listen port', 1, 65_535),
      tlsCertificateFile: text(listen.tlsCertificateFile, 'TLS certificate path', 4_096),
      tlsPrivateKeyFile: text(listen.tlsPrivateKeyFile, 'TLS private key path', 4_096),
    },
    auth: {
      issuer: text(auth.issuer, 'auth issuer'),
      audience: text(auth.audience, 'auth audience'),
      publicKeys: auth.publicKeys.map((entry) => {
        const key = record(entry, 'auth public key');
        exact(key, ['keyId', 'file'], 'auth public key');
        return {
          keyId: text(key.keyId, 'auth key id', 128),
          file: text(key.file, 'auth public key path', 4_096),
        };
      }),
    },
    usage: {
      keyId: text(usage.keyId, 'usage key id', 80),
      privateKeyFile: text(usage.privateKeyFile, 'usage private key path', 4_096),
    },
    database: {
      urlFile: text(database.urlFile, 'database URL path', 4_096),
    },
    consentPolicy: parseConsentPolicy(input.consentPolicy),
    ...(routeKeys
      ? {
          routeKeys: {
            encryptionKeyFile: text(routeKeys.encryptionKeyFile, 'route key encryption key path', 4_096),
          },
        }
      : {}),
    quota: validateInvocationLimits({
      tenantRequestsPerMinute: integer(quota.tenantRequestsPerMinute, 'tenant requests per minute', 1, 1_000_000),
      tenantBurst: integer(quota.tenantBurst, 'tenant burst', 1, 1_000_000),
      tenantMaxConcurrent: integer(quota.tenantMaxConcurrent, 'tenant maximum concurrency', 1, 10_000),
      invocationLeaseMs,
    }),
    routes: input.routes.map(route),
    upstreamTimeoutMs,
  };
}

export function loadProductionConfiguration(configurationFile: string): LoadedProductionConfiguration {
  const raw = externalFile(configurationFile, 'configuration', 256 * 1_024);
  let configuration: ProductionConfiguration;
  try {
    configuration = parseConfiguration(JSON.parse(raw.toString('utf8')));
  } catch {
    throw new Error('Invalid Model Gateway production configuration');
  }
  const certificate = externalFile(configuration.listen.tlsCertificateFile, 'TLS certificate', 64 * 1_024);
  const tlsPrivateKey = externalFile(configuration.listen.tlsPrivateKeyFile, 'TLS private key', 64 * 1_024, true);
  createSecureContext({ cert: certificate, key: tlsPrivateKey });
  const certificatePublicKey = new X509Certificate(certificate).publicKey.export({
    format: 'der',
    type: 'spki',
  });
  const tlsPublicKey = createPublicKey(createPrivateKey(tlsPrivateKey)).export({
    format: 'der',
    type: 'spki',
  });
  if (!Buffer.from(certificatePublicKey).equals(Buffer.from(tlsPublicKey))) {
    throw new Error('TLS certificate and private key do not match');
  }
  const usagePrivateKey = createPrivateKey(
    externalFile(configuration.usage.privateKeyFile, 'Usage private key', 64 * 1_024, true)
  );
  if (usagePrivateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Usage private key must be Ed25519');
  }
  const usagePublicKey = createPublicKey(usagePrivateKey).export({
    format: 'der',
    type: 'spki',
  });
  if (Buffer.from(usagePublicKey).equals(Buffer.from(tlsPublicKey))) {
    throw new Error('TLS and Usage signing keys must be distinct');
  }
  const authPublicKeys = new Map<string, KeyObject>();
  const authFingerprints = new Set<string>();
  for (const entry of configuration.auth.publicKeys) {
    const key = createPublicKey(externalFile(entry.file, 'Auth public key', 64 * 1_024));
    const publicKey = Buffer.from(key.export({ format: 'der', type: 'spki' }));
    const fingerprint = publicKey.toString('base64');
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      publicKey.equals(Buffer.from(usagePublicKey)) ||
      publicKey.equals(Buffer.from(tlsPublicKey)) ||
      authFingerprints.has(fingerprint)
    ) {
      throw new Error('Production keys must be distinct Ed25519 keys');
    }
    authFingerprints.add(fingerprint);
    authPublicKeys.set(entry.keyId, key);
  }
  if (authPublicKeys.size !== configuration.auth.publicKeys.length) {
    throw new Error('Duplicate Auth key id');
  }
  const routes = configuration.routes.map(({ upstreamApiKeyFile, ...metadata }) => ({
    ...metadata,
    upstreamApiKey: externalFile(upstreamApiKeyFile, `${metadata.id} API key`, 8 * 1_024, true)
      .toString('utf8')
      .trim(),
  }));
  let routeKeyEncryptionKey: Buffer | undefined;
  if (configuration.routeKeys) {
    const encoded = externalFile(configuration.routeKeys.encryptionKeyFile, 'Route key encryption key', 1_024, true)
      .toString('utf8')
      .trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
      throw new Error('Invalid Route key encryption key');
    }
    routeKeyEncryptionKey = Buffer.from(encoded, 'base64url');
    if (routeKeyEncryptionKey.byteLength !== 32 || routeKeyEncryptionKey.toString('base64url') !== encoded) {
      throw new Error('Invalid Route key encryption key');
    }
  }
  return {
    configurationSha256: createHash('sha256').update(raw).digest('hex'),
    publicBaseUrl: configuration.publicBaseUrl,
    host: configuration.listen.host,
    port: configuration.listen.port,
    certificate,
    tlsPrivateKey,
    databaseUrl: externalFile(configuration.database.urlFile, 'database URL', 8 * 1_024, true)
      .toString('utf8')
      .trim(),
    consentPolicy: configuration.consentPolicy,
    routes,
    authenticate: createSessionTokenVerifier({
      issuer: configuration.auth.issuer,
      audience: configuration.auth.audience,
      publicKeys: authPublicKeys,
    }),
    usageKeyId: configuration.usage.keyId,
    usagePrivateKey,
    ...(routeKeyEncryptionKey ? { routeKeyEncryptionKey } : {}),
    quota: configuration.quota,
    upstreamTimeoutMs: configuration.upstreamTimeoutMs,
  };
}

export async function startProductionModelGateway(configurationFile: string): Promise<{
  server: Server;
  close(): Promise<void>;
}> {
  const configuration = loadProductionConfiguration(configurationFile);
  const database = await openPostgresUsageStore(configuration.databaseUrl, configuration.quota);
  const modelRoutePolicy = await openPostgresTenantModelRoutePolicy(
    configuration.databaseUrl,
    configuration.routeKeyEncryptionKey
  ).catch(async (error) => {
    await database.close().catch(() => undefined);
    throw error;
  });
  const consent = await openPostgresConsentStore(configuration.databaseUrl, configuration.consentPolicy).catch(
    async (error) => {
      await modelRoutePolicy.close().catch(() => undefined);
      await database.close().catch(() => undefined);
      throw error;
    }
  );
  let server: Server | undefined;
  try {
    const routeIds = configuration.routes.map(({ id }) => id);
    const handler = createModelGatewayHandler({
      routes: configuration.routes,
      publicBaseUrl: configuration.publicBaseUrl,
      authenticate: createProductionAuthenticator(configuration.authenticate, modelRoutePolicy.policy, database.store, routeIds),
      tenantModelRoutePolicy: modelRoutePolicy.policy,
      usageStore: database.store,
      usageKeyId: configuration.usageKeyId,
      usagePrivateKey: configuration.usagePrivateKey,
      consentStore: consent.store,
      upstreamTimeoutMs: configuration.upstreamTimeoutMs,
      imageObservation: (event) => {
        process.stdout.write(`${JSON.stringify({ event: 'image_observation', ...event })}\n`);
      },
    });
    server = createServer(
      {
        cert: configuration.certificate,
        key: configuration.tlsPrivateKey,
        minVersion: 'TLSv1.2',
      },
      (request, response) => void handler(request, response)
    );
    server.listen(configuration.port, configuration.host);
    await once(server, 'listening');
  } catch (error) {
    server?.close();
    await consent.close().catch(() => undefined);
    await modelRoutePolicy.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    throw error;
  }
  const runningServer = server;
  let closing: Promise<void> | null = null;
  return {
    server: runningServer,
    close() {
      closing ??= (async () => {
        if (runningServer.listening) {
          runningServer.close();
          const deadline = setTimeout(() => runningServer.closeAllConnections(), 10_000);
          deadline.unref();
          try {
            await once(runningServer, 'close');
          } finally {
            clearTimeout(deadline);
          }
        }
        try {
          await consent.close();
        } finally {
          try {
            await modelRoutePolicy.close();
          } finally {
            await database.close();
          }
        }
      })();
      return closing;
    },
  };
}
