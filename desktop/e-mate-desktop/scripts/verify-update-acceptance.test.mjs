import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyUpdateAcceptance } from './verify-update-acceptance.mjs'

const source = 'a'.repeat(40)
const version = '2.0.18'
const macHash = 'b'.repeat(64)
const winHash = 'c'.repeat(64)
const candidateRoot = 'desktop/candidates/' + source + '/'
const companion = { key: candidateRoot + 'sources/e-Mate-' + version + '-runtime-sources.tar', bytes: 30, sha256: 'f'.repeat(64) }
const manifest = { schema_version: 2, source_commit: source, version, source_companion: companion, artifacts: {
  darwin: { key: candidateRoot + 'darwin/e-Mate-' + version + '-mac-universal.dmg', bytes: 10, sha256: macHash },
  win32: { key: candidateRoot + 'win32/e-Mate-' + version + '-win-x64-Setup.exe', bytes: 20, sha256: winHash },
} }
const state = { app_path: '/Applications/e-Mate.app', dsh_home: '/Users/test/.dsh', user_data: '/Users/test/Library/Application Support/e-Mate', installation_id_sha256: 'd'.repeat(64), test_session_id: 'acceptance-session' }
function receipt(platform, size, sha256) { return { schema_version: 2, platform, source_commit: source, version, source_companion: companion, installer: { bytes: size, sha256 }, native_download: { succeeded: true, bytes: size, sha256 }, native_install: { succeeded: true }, normal_launch: { succeeded: true, launched_version: version }, continuity: { from_version: '2.0.16', before: state, after: { ...state } }, debug: { port_closed: true } } }
const mac = receipt('darwin', 10, macHash)
const windows = receipt('win32', 20, winHash)

test('derives immutable release keys from the private manifest', () => {
  const accepted = verifyUpdateAcceptance(manifest, mac, windows)
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.release_artifacts.win32.key, 'desktop/releases/v2.0.18/' + source + '/e-Mate-2.0.18-win-x64-Setup.exe')
  assert.deepEqual(accepted.promotion, { atomic: false, aliases: ['desktop/downloads/mac', 'desktop/downloads/windows'], read_back_aliases: true, version_last: 'desktop/version.json' })
})

test('fails closed on missing, false, wrong identity, profile continuity, or open debug evidence', () => {
  for (const mutate of [
    value => { delete value.windows.native_install.succeeded },
    value => { value.windows.native_download.succeeded = false },
    value => { value.windows.installer.sha256 = 'e'.repeat(64) },
    value => { value.windows.normal_launch.launched_version = '2.0.17' },
    value => { value.windows.continuity.after.app_path = 'C:/Other/e-Mate.exe' },
    value => { value.windows.continuity.after.dsh_home = 'C:/fresh/.dsh' },
    value => { value.windows.continuity.after.user_data = 'C:/fresh/e-Mate' },
    value => { value.windows.continuity.after.installation_id_sha256 = 'e'.repeat(64) },
    value => { value.windows.continuity.after.test_session_id = 'different-session' },
    value => { value.mac.debug.port_closed = false },
  ]) {
    const value = structuredClone({ manifest, mac, windows }); mutate(value)
    assert.throws(() => verifyUpdateAcceptance(value.manifest, value.mac, value.windows), /update acceptance rejected/u)
  }
})

test('source companion cannot be omitted, substituted, or downgraded on either platform', () => {
  for (const mutate of [
    v => { delete v.manifest.source_companion },
    v => { v.manifest.schema_version = 1; delete v.manifest.source_companion },
    v => { v.manifest.source_companion.key = 'desktop/candidates/' + '0'.repeat(40) + '/sources/e-Mate-2.0.18-runtime-sources.tar' },
    v => { delete v.mac.source_companion },
    v => { v.windows.source_companion.sha256 = '0'.repeat(64) },
    v => { v.mac.source_companion.bytes += 1 },
  ]) {
    const value = JSON.parse(JSON.stringify({ manifest, mac, windows })); mutate(value)
    assert.throws(() => verifyUpdateAcceptance(value.manifest, value.mac, value.windows), /update acceptance rejected/u)
  }
  const accepted = verifyUpdateAcceptance(manifest, mac, windows)
  assert.equal(accepted.release_source_companion.key, 'desktop/releases/v2.0.18/' + source + '/e-Mate-2.0.18-runtime-sources.tar')
  assert.equal(accepted.release_source_companion.sha256, companion.sha256)
})

test('historical pre-source-companion schema remains readable without inventing source evidence', () => {
  const old = JSON.parse(JSON.stringify({ manifest, mac, windows }).replaceAll('2.0.18', '2.0.17'))
  for (const row of [old.manifest, old.mac, old.windows]) { row.schema_version = 1; delete row.source_companion }
  const accepted = verifyUpdateAcceptance(old.manifest, old.mac, old.windows)
  assert.equal(accepted.version, '2.0.17')
  assert.equal(Object.hasOwn(accepted, 'candidate_source_companion'), false)
})
