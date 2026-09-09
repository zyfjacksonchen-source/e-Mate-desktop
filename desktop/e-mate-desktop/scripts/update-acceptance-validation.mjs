const SHA256 = /^[0-9a-f]{64}$/u
const SOURCE = /^[0-9a-f]{40}$/u
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u

function fail(message) { throw new Error('update acceptance rejected: ' + message) }
function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be an object')
  return value
}
function exact(value, keys, label) {
  const row = record(value, label)
  const actual = Object.keys(row).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(label + ' fields mismatch')
  return row
}
function text(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(label + ' is invalid')
  return value
}
function safeText(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[\0\r\n]/u.test(value)) fail(label + ' is invalid')
  return value
}
function absolutePath(value, label) {
  safeText(value, label)
  if (!value.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(value)) fail(label + ' must be absolute')
  return value
}
function bytes(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(label + ' is invalid')
  return value
}
function succeeded(value, label) {
  if (value !== true) fail(label + ' must be true')
}
function artifact(value, label, expectedKey) {
  const row = exact(value, ['key', 'bytes', 'sha256'], label)
  if (row.key !== expectedKey) fail(label + ' key mismatch')
  return Object.freeze({ key: row.key, bytes: bytes(row.bytes, label + '.bytes'), sha256: text(row.sha256, SHA256, label + '.sha256') })
}
function continuityState(value, label) {
  const row = exact(value, ['app_path', 'dsh_home', 'user_data', 'installation_id_sha256', 'test_session_id'], label)
  return {
    app_path: absolutePath(row.app_path, label + '.app_path'),
    dsh_home: absolutePath(row.dsh_home, label + '.dsh_home'),
    user_data: absolutePath(row.user_data, label + '.user_data'),
    installation_id_sha256: text(row.installation_id_sha256, SHA256, label + '.installation_id_sha256'),
    test_session_id: safeText(row.test_session_id, label + '.test_session_id'),
  }
}
function receipt(value, platform, manifest, artifactRow) {
  const label = platform + ' receipt'
  const row = exact(value, ['schema_version', 'platform', 'source_commit', 'version', 'installer', 'native_download', 'native_install', 'normal_launch', 'continuity', 'debug', ...(manifest.schema_version === 2 ? ['source_companion'] : [])], label)
  if (row.schema_version !== manifest.schema_version || row.platform !== platform || row.source_commit !== manifest.source_commit || row.version !== manifest.version) fail(label + ' identity mismatch')
  if (manifest.schema_version === 2) {
    const companion = artifact(row.source_companion, label + '.source_companion', manifest.source_companion.key)
    if (companion.bytes !== manifest.source_companion.bytes || companion.sha256 !== manifest.source_companion.sha256) fail(label + ' source companion identity mismatch')
  }
  const installer = exact(row.installer, ['bytes', 'sha256'], label + '.installer')
  const download = exact(row.native_download, ['succeeded', 'bytes', 'sha256'], label + '.native_download')
  const install = exact(row.native_install, ['succeeded'], label + '.native_install')
  const launch = exact(row.normal_launch, ['succeeded', 'launched_version'], label + '.normal_launch')
  const continuity = exact(row.continuity, ['from_version', 'before', 'after'], label + '.continuity')
  const debug = exact(row.debug, ['port_closed'], label + '.debug')
  succeeded(download.succeeded, label + '.native_download.succeeded')
  succeeded(install.succeeded, label + '.native_install.succeeded')
  succeeded(launch.succeeded, label + '.normal_launch.succeeded')
  succeeded(debug.port_closed, label + '.debug.port_closed')
  if (continuity.from_version !== '2.0.16' || launch.launched_version !== manifest.version) fail(label + ' launch versions mismatch')
  const before = continuityState(continuity.before, label + '.continuity.before')
  const after = continuityState(continuity.after, label + '.continuity.after')
  if (Object.keys(before).some(key => before[key] !== after[key])) fail(label + ' app/profile continuity mismatch')
  for (const candidate of [installer, download]) {
    if (bytes(candidate.bytes, label + ' bytes') !== artifactRow.bytes || text(candidate.sha256, SHA256, label + ' sha256') !== artifactRow.sha256) fail(label + ' installer identity mismatch')
  }
}

export function validateCandidateManifest(manifestValue) {
  const schema = record(manifestValue, 'manifest').schema_version
  if (schema !== 1 && schema !== 2) fail('manifest schema_version mismatch')
  const manifest = exact(manifestValue, ['schema_version', 'source_commit', 'version', 'artifacts', ...(schema === 2 ? ['source_companion'] : [])], 'manifest')
  text(manifest.source_commit, SOURCE, 'manifest.source_commit')
  text(manifest.version, VERSION, 'manifest.version')
  const [major, minor, patch] = manifest.version.split('.').map(BigInt)
  if (schema === 1 && (major > 2n || major === 2n && (minor > 0n || minor === 0n && patch >= 18n))) fail('source companion required from 2.0.18')
  const artifacts = exact(manifest.artifacts, ['darwin', 'win32'], 'manifest.artifacts')
  const root = 'desktop/candidates/' + manifest.source_commit + '/'
  artifact(artifacts.darwin, 'manifest.artifacts.darwin', root + 'darwin/e-Mate-' + manifest.version + '-mac-universal.dmg')
  artifact(artifacts.win32, 'manifest.artifacts.win32', root + 'win32/e-Mate-' + manifest.version + '-win-x64-Setup.exe')
  if (schema === 2) artifact(manifest.source_companion, 'manifest.source_companion', root + 'sources/e-Mate-' + manifest.version + '-runtime-sources.tar')
  return manifest
}

export function validateUpdateAcceptance(manifestValue, macValue, windowsValue) {
  const manifest = validateCandidateManifest(manifestValue)
  const { darwin, win32 } = manifest.artifacts
  receipt(macValue, 'darwin', manifest, darwin)
  receipt(windowsValue, 'win32', manifest, win32)
  const releaseRoot = 'desktop/releases/v' + manifest.version + '/' + manifest.source_commit + '/'
  const releaseArtifact = row => Object.freeze({ ...row, key: releaseRoot + row.key.split('/').at(-1) })
  return Object.freeze({
    status: 'accepted',
    source_commit: manifest.source_commit,
    version: manifest.version,
    candidate_artifacts: Object.freeze({ darwin: Object.freeze({ ...darwin }), win32: Object.freeze({ ...win32 }) }),
    release_artifacts: Object.freeze({ darwin: releaseArtifact(darwin), win32: releaseArtifact(win32) }),
    ...(manifest.schema_version === 2 ? {
      candidate_source_companion: Object.freeze({ ...manifest.source_companion }),
      release_source_companion: releaseArtifact(manifest.source_companion),
    } : {}),
    promotion: Object.freeze({ atomic: false, aliases: Object.freeze(['desktop/downloads/mac', 'desktop/downloads/windows']), read_back_aliases: true, version_last: 'desktop/version.json' }),
  })
}
