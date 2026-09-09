import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertWindowsSecretFileAccess, loadProductionConfiguration } from '../src/production.ts';

function configuration(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    publicBaseUrl: 'https://mvdcm.ecoremedia.net/e-mate/model-api',
    listen: {
      host: '127.0.0.1',
      port: 8443,
      tlsCertificateFile: 'relative-cert.pem',
      tlsPrivateKeyFile: 'relative-key.pem',
    },
    auth: {
      issuer: 'https://auth.example.com',
      audience: 'e-mate-model-gateway',
      publicKeys: [],
    },
    usage: {
      keyId: 'usage-2026',
      privateKeyFile: 'relative-usage.pem',
    },
    database: {
      urlFile: 'relative-database.txt',
    },
    consentPolicy: {
      schemaVersion: 1,
      agreementId: 'e-mate-platform-terms',
      agreementVersion: '1.0.0',
      disclaimerVersion: '1.0.0',
      contentHash: 'a'.repeat(64),
    },
    quota: {
      tenantRequestsPerMinute: 120,
      tenantBurst: 20,
      tenantMaxConcurrent: 10,
      invocationLeaseMs: 180_000,
    },
    routes: [],
    upstreamTimeoutMs: 120_000,
    ...overrides,
  };
}

function productionRoute(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gpt-5.6-sol',
    upstreamModelId: 'gpt-5.6-sol',
    upstreamBaseUrl: 'http://provider.example:8080/v1',
    allowInsecureHttpUpstream: true,
    upstreamApiKeyFile: '/run/secrets/provider-api-key',
    providerId: 'custom-gpt',
    label: 'GPT-5.6 Sol',
    buttonLabel: 'GPT-5.6 Sol · 中等',
    provider: 'Custom GPT',
    providerMark: 'G',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    remoteCompactionV2: false,
    ...overrides,
  };
}

test('production configuration requires external absolute secret files and rejects inline fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'e-mate-gateway-'));
  const file = join(directory, 'gateway.json');
  try {
    for (const value of [
      'http://mvdcm.ecoremedia.net/e-mate/model-api',
      'https://user@mvdcm.ecoremedia.net/e-mate/model-api',
      'https://mvdcm.ecoremedia.net/e-mate/model-api?query=1',
      'https://mvdcm.ecoremedia.net/e-mate/model-api#fragment',
      'https://mvdcm.ecoremedia.net/e-mate/model-api/v1',
    ]) {
      writeFileSync(file, JSON.stringify(configuration({ publicBaseUrl: value })));
      assert.throws(() => loadProductionConfiguration(file), /Invalid Model Gateway production configuration/);
    }
    writeFileSync(file, JSON.stringify(configuration({ publicBaseUrl: 'https://mvdcm.ecoremedia.net/e-mate/model-api/' })));
    assert.throws(() => loadProductionConfiguration(file), /TLS certificate path must be absolute/);
    writeFileSync(file, JSON.stringify(configuration()));
    assert.throws(() => loadProductionConfiguration(file), /TLS certificate path must be absolute/);
    writeFileSync(
      file,
      JSON.stringify(
        configuration({
          quota: {
            tenantRequestsPerMinute: 1,
            tenantBurst: 0,
            tenantMaxConcurrent: 1,
            invocationLeaseMs: 180_000,
          },
        })
      )
    );
    assert.throws(() => loadProductionConfiguration(file), /Invalid Model Gateway production configuration/);
    writeFileSync(file, JSON.stringify(configuration({ inlineSecret: 'forbidden' })));
    assert.throws(() => loadProductionConfiguration(file), /Invalid Model Gateway production configuration/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production route schema accepts only the literal HTTP opt-in and a secret-file key', () => {
  const directory = mkdtempSync(join(tmpdir(), 'e-mate-gateway-http-route-'));
  const file = join(directory, 'gateway.json');
  try {
    writeFileSync(file, JSON.stringify(configuration({ routes: [productionRoute()] })));
    assert.throws(() => loadProductionConfiguration(file), /TLS certificate path must be absolute/);

    writeFileSync(
      file,
      JSON.stringify(configuration({ routes: [productionRoute({ allowInsecureHttpUpstream: false })] }))
    );
    assert.throws(() => loadProductionConfiguration(file), /Invalid Model Gateway production configuration/);

    writeFileSync(
      file,
      JSON.stringify(configuration({ routes: [productionRoute({ fallbackUpstreamModelId: 'gpt-image-2' })] }))
    );
    assert.throws(() => loadProductionConfiguration(file), /Invalid Model Gateway production configuration/);

    const { upstreamApiKeyFile: _upstreamApiKeyFile, ...inlineKeyRoute } = productionRoute();
    writeFileSync(
      file,
      JSON.stringify(configuration({ routes: [{ ...inlineKeyRoute, upstreamApiKey: 'forbidden-inline-key' }] }))
    );
    assert.throws(() => loadProductionConfiguration(file), /Invalid Model Gateway production configuration/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production search credential route binds the official endpoint to its own secret file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'e-mate-gateway-search-route-'));
  const file = join(directory, 'gateway.json');
  const searchCredentialRoute = productionRoute({
    id: 'deepseek-web-search',
    apiMode: 'chat-completions',
    upstreamModelId: 'deepseek-v4-flash',
    upstreamBaseUrl: 'https://api.deepseek.com/anthropic/v1',
    allowInsecureHttpUpstream: undefined,
    upstreamApiKeyFile: '/run/secrets/deepseek-web-search-api-key',
    providerId: 'deepseek-official',
    label: 'DeepSeek Web Search Credential',
    buttonLabel: 'DeepSeek Web Search Credential',
    provider: 'DeepSeek',
    providerMark: 'D',
    reasoning: false,
    input: ['text'],
  });
  try {
    writeFileSync(file, JSON.stringify(configuration({ routes: [searchCredentialRoute] })));
    assert.throws(() => loadProductionConfiguration(file), /TLS certificate path must be absolute/);

    const { upstreamApiKeyFile: _upstreamApiKeyFile, ...inlineKeyRoute } = searchCredentialRoute;
    writeFileSync(
      file,
      JSON.stringify(configuration({ routes: [{ ...inlineKeyRoute, upstreamApiKey: 'forbidden-inline-key' }] }))
    );
    assert.throws(() => loadProductionConfiguration(file), /Invalid Model Gateway production configuration/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const windowsTest = process.platform === 'win32' ? test : test.skip;

function setWindowsAcl(
  path: string,
  extra?:
    | {
        sid: 'S-1-1-0' | 'S-1-5-7' | 'S-1-5-11' | 'S-1-5-32-545';
        type: 'Allow' | 'Deny';
        rights: number;
      }
    | { nullDacl: true }
): void {
  const extraType = extra && 'type' in extra ? extra.type : 'Allow';
  const script = `
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('E_MATE_TEST_ACL_PATH', 'Process')
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$acl = [System.Security.AccessControl.FileSecurity]::new()
$acl.SetOwner($current)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($current, $system, $administrators)) {
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow
  ))
}
$extraSid = [Environment]::GetEnvironmentVariable('E_MATE_TEST_ACL_SID', 'Process')
if ([Environment]::GetEnvironmentVariable('E_MATE_TEST_NULL_DACL', 'Process') -eq '1') {
  $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new(
    "O:$($current.Value)G:$($current.Value)D:NO_ACCESS_CONTROL"
  )
  $bytes = [byte[]]::new($descriptor.BinaryLength)
  $descriptor.GetBinaryForm($bytes, 0)
  $acl.SetSecurityDescriptorBinaryForm(
    $bytes,
    [System.Security.AccessControl.AccessControlSections]::Owner -bor
      [System.Security.AccessControl.AccessControlSections]::Access
  )
} elseif (-not [string]::IsNullOrWhiteSpace($extraSid)) {
  $mask = [uint32]::Parse(
    [Environment]::GetEnvironmentVariable('E_MATE_TEST_ACL_RIGHTS', 'Process'),
    [Globalization.CultureInfo]::InvariantCulture
  )
  $signedMask = [BitConverter]::ToInt32([BitConverter]::GetBytes($mask), 0)
  $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new(
    $acl.GetSecurityDescriptorBinaryForm(),
    0
  )
  $qualifier = if ('${extraType}' -eq 'Allow') {
    [System.Security.AccessControl.AceQualifier]::AccessAllowed
  } else {
    [System.Security.AccessControl.AceQualifier]::AccessDenied
  }
  $descriptor.DiscretionaryAcl.InsertAce(
    $descriptor.DiscretionaryAcl.Count,
    [System.Security.AccessControl.CommonAce]::new(
      [System.Security.AccessControl.AceFlags]::None,
      $qualifier,
      $signedMask,
      [System.Security.Principal.SecurityIdentifier]::new($extraSid),
      $false,
      $null
    )
  )
  $bytes = [byte[]]::new($descriptor.BinaryLength)
  $descriptor.GetBinaryForm($bytes, 0)
  $acl.SetSecurityDescriptorBinaryForm(
    $bytes,
    [System.Security.AccessControl.AccessControlSections]::Owner -bor
      [System.Security.AccessControl.AccessControlSections]::Access
  )
}
[System.IO.File]::SetAccessControl($path, $acl)
`;
  const systemRoot = process.env.SystemRoot;
  assert(systemRoot);
  const result = spawnSync(
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      env: {
        ...process.env,
        E_MATE_TEST_ACL_PATH: path,
        E_MATE_TEST_ACL_SID: extra && 'sid' in extra ? extra.sid : '',
        E_MATE_TEST_ACL_RIGHTS: String(extra && 'rights' in extra ? extra.rights : 131_209),
        E_MATE_TEST_NULL_DACL: extra && 'nullDacl' in extra ? '1' : '',
      },
      timeout: 15_000,
      windowsHide: true,
    }
  );
  assert.equal(result.status, 0, result.stderr.toString());
}

windowsTest('windows secret files reject broad allow rules and accept deny-only rules', () => {
  const directory = mkdtempSync(join(tmpdir(), 'e-mate-gateway-acl-'));
  const file = join(directory, 'secret.txt');
  try {
    writeFileSync(file, 'not-a-real-secret');
    setWindowsAcl(file);
    assert.doesNotThrow(() => assertWindowsSecretFileAccess(file));

    for (const extra of [
      { sid: 'S-1-1-0', type: 'Allow', rights: 131_209 },
      { sid: 'S-1-5-11', type: 'Allow', rights: 197_055 },
      { sid: 'S-1-5-32-545', type: 'Allow', rights: 2_032_127 },
      { sid: 'S-1-5-7', type: 'Allow', rights: 2_147_483_648 },
      { sid: 'S-1-5-7', type: 'Allow', rights: 1_073_741_824 },
      { sid: 'S-1-5-7', type: 'Allow', rights: 536_870_912 },
      { sid: 'S-1-5-7', type: 'Allow', rights: 268_435_456 },
    ] as const) {
      setWindowsAcl(file, extra);
      assert.throws(() => assertWindowsSecretFileAccess(file), /permissions are too broad/);
    }

    setWindowsAcl(file, { sid: 'S-1-5-7', type: 'Deny', rights: 131_209 });
    assert.doesNotThrow(() => assertWindowsSecretFileAccess(file));

    setWindowsAcl(file, { nullDacl: true });
    assert.throws(() => assertWindowsSecretFileAccess(file), /permissions are too broad/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

windowsTest('windows secret ACL inspection fails closed when the platform tool is unavailable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'e-mate-gateway-acl-tool-'));
  const file = join(directory, 'secret.txt');
  const systemRoot = process.env.SystemRoot;
  try {
    writeFileSync(file, 'not-a-real-secret');
    setWindowsAcl(file);
    process.env.SystemRoot = directory;
    assert.throws(() => assertWindowsSecretFileAccess(file), /could not be verified/);
  } finally {
    process.env.SystemRoot = systemRoot;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('native Chat capability is explicit and only valid for Responses routes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'e-mate-native-chat-'));
  const file = join(directory, 'gateway.json');
  try {
    for (const capability of [undefined, true]) {
      writeFileSync(file, JSON.stringify(configuration({ routes: [productionRoute({ apiMode: 'responses', ...(capability ? { nativeChatCompletions: true } : {}) })] })));
      // Route validation succeeds; the existing fixture intentionally has relative secret paths.
      assert.throws(() => loadProductionConfiguration(file), /TLS certificate path must be absolute/);
    }
    for (const override of [
      { apiMode: 'responses', nativeChatCompletions: false },
      { apiMode: 'responses', nativeChatCompletions: 'true' },
      { apiMode: 'chat-completions', nativeChatCompletions: true },
      { apiMode: 'images-generations', nativeChatCompletions: true },
      { nativeChatCompletions: true },
    ]) {
      writeFileSync(file, JSON.stringify(configuration({ routes: [productionRoute(override)] })));
      assert.throws(() => loadProductionConfiguration(file), /Invalid Model Gateway production configuration/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
