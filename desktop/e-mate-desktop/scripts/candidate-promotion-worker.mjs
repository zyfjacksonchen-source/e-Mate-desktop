// @ts-check
import { validateUpdateAcceptance } from './update-acceptance-validation.mjs'

const NO_STORE = { 'Cache-Control': 'no-store' }
const SOURCE = /^[0-9a-f]{40}$/u
const HASH = /^[0-9a-f]{64}$/u
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u
const MAX_JSON_BYTES = 64 * 1024
const MAX_TOKEN_TTL_MS = 15 * 60 * 1000
const RELEASE_RECORD_KEY = 'desktop/releases/release-record.json'
const PLATFORM = Object.freeze({ darwin: 'mac', win32: 'windows' })
const CONTENT_TYPE = Object.freeze({ darwin: 'application/x-apple-diskimage', win32: 'application/vnd.microsoft.portable-executable', sources: 'application/x-tar' })
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'
const encoder = new TextEncoder()

function response(status, value) { return Response.json(value, { status, headers: NO_STORE }) }
function reject(code) { const error = new Error(code); error.code = code; throw error }
function compareVersions(left, right) {
  const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt)
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  return 0
}
function hexBytes(value) {
  if (typeof value !== 'string' || !HASH.test(value)) return null
  return Uint8Array.from(value.match(/../gu), pair => Number.parseInt(pair, 16))
}
async function digest(bytes) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('') }
async function authorized(request, expectedHash) {
  const expected = hexBytes(expectedHash), header = request.headers.get('Authorization')
  if (expected === null || header === null || !header.startsWith('Bearer ')) return false
  const token = header.slice(7)
  if (token.length < 1 || token.length > 4096) return false
  return crypto.subtle.timingSafeEqual(expected, new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))))
}
function expiry(value) {
  if (typeof value !== 'string') return null
  if (/^[0-9]{10,13}$/u.test(value)) { const number = Number(value); return Number.isSafeInteger(number) ? (value.length <= 10 ? number * 1000 : number) : null }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
function exact(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort(), expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
function exactMetadata(actual, expected) { return exact(actual, Object.keys(expected)) && Object.keys(expected).every(key => actual[key] === expected[key]) }
function checksumMatches(object, expectedHex) {
  const expected = hexBytes(expectedHex), actual = object?.checksums?.sha256
  return expected !== null && actual instanceof ArrayBuffer && crypto.subtle.timingSafeEqual(expected, new Uint8Array(actual))
}
function identity(object, expected, httpMetadata) {
  return object !== null && object.key === expected.key && object.size === expected.bytes && exactMetadata(object.customMetadata, expected.customMetadata)
    && checksumMatches(object, expected.sha256) && object.httpMetadata?.contentType === httpMetadata.contentType && object.httpMetadata?.cacheControl === httpMetadata.cacheControl
}
function artifactIdentity(value) { return exact(value, ['bytes', 'sha256']) && Number.isSafeInteger(value.bytes) && value.bytes > 0 && typeof value.sha256 === 'string' && HASH.test(value.sha256) }
function releaseIdentity(value) {
  return exact(value, ['version', 'source_commit', 'artifacts', ...(value?.source_companion !== undefined ? ['source_companion'] : [])]) && typeof value.version === 'string' && VERSION.test(value.version)
    && typeof value.source_commit === 'string' && SOURCE.test(value.source_commit) && exact(value.artifacts, ['darwin', 'win32'])
    && artifactIdentity(value.artifacts.darwin) && artifactIdentity(value.artifacts.win32)
    && (value.source_companion === undefined || artifactIdentity(value.source_companion))
}
function sameIdentity(left, right) { return JSON.stringify(left) === JSON.stringify(right) }
function candidateIdentity(accepted) {
  return { version: accepted.version, source_commit: accepted.source_commit, artifacts: {
    darwin: { bytes: accepted.candidate_artifacts.darwin.bytes, sha256: accepted.candidate_artifacts.darwin.sha256 },
    win32: { bytes: accepted.candidate_artifacts.win32.bytes, sha256: accepted.candidate_artifacts.win32.sha256 },
  }, ...(accepted.candidate_source_companion ? { source_companion: { bytes: accepted.candidate_source_companion.bytes, sha256: accepted.candidate_source_companion.sha256 } } : {}) }
}
async function loadJsonObject(bucket, key) {
  const object = await bucket.get(key)
  if (object === null || object.key !== key || !Number.isSafeInteger(object.size) || object.size < 1 || object.size > MAX_JSON_BYTES) reject('private_json_identity')
  const bytes = new Uint8Array(await object.arrayBuffer())
  if (bytes.byteLength !== object.size) reject('private_json_size')
  try { return { object, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } } catch { reject('private_json_invalid') }
}
function validateReleaseRecord(value) {
  if (!exact(value, ['schema_version', 'highest', 'claim']) || value.schema_version !== 1 || !releaseIdentity(value.highest) || value.claim !== null && (!exact(value.claim, ['candidate', 'state']) || !releaseIdentity(value.claim.candidate) || !['running', 'retryable'].includes(value.claim.state))) reject('release_record_invalid')
  return value
}
async function putPrivateJson(bucket, key, value, options) {
  const bytes = encoder.encode(JSON.stringify(value) + '\n'), sha256 = await digest(bytes)
  return bucket.put(key, bytes, { ...options, sha256, httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' }, customMetadata: options.customMetadata })
}
async function claimRelease(bucket, candidate) {
  let loaded
  try { loaded = await loadJsonObject(bucket, RELEASE_RECORD_KEY) } catch (error) { if (error.code === 'private_json_identity') reject('release_record_missing'); throw error }
  const record = validateReleaseRecord(loaded.value)
  const comparison = compareVersions(candidate.version, record.highest.version)
  if (comparison < 0) reject('version_downgrade')
  if (comparison === 0 && !sameIdentity(candidate, record.highest)) reject('same_version_identity_collision')
  if (record.claim !== null && !sameIdentity(candidate, record.claim.candidate)) reject('concurrent_candidate_claim')
  if (record.claim?.state === 'running') reject('promotion_in_progress')
  const claimed = { schema_version: 1, highest: record.highest, claim: { candidate, state: 'running' } }
  const written = await putPrivateJson(bucket, RELEASE_RECORD_KEY, claimed, { onlyIf: { etagMatches: loaded.object.etag }, customMetadata: { state: 'claimed', sourceCommit: candidate.source_commit, version: candidate.version } })
  if (written !== null) return { record: claimed, etag: written.etag }
  reject('concurrent_candidate_claim')
}
// Public writes are sequentially awaited; only their finished failure path may unlock a retry.
// ponytail: A crash (or failed retry-state CAS) stays closed. The main agent must stop the old
// publisher before restoring a retryable claim with the same candidate identity. Add bounded
// leases and write isolation only if automatic crash recovery becomes necessary.
async function markRetryable(bucket, claim) {
  const retryable = { ...claim.record, claim: { ...claim.record.claim, state: 'retryable' } }
  const candidate = claim.record.claim.candidate
  await putPrivateJson(bucket, RELEASE_RECORD_KEY, retryable, { onlyIf: { etagMatches: claim.etag }, customMetadata: { state: 'retryable', sourceCommit: candidate.source_commit, version: candidate.version } })
}
async function candidateObject(bucket, artifact, accepted) {
  const object = await bucket.get(artifact.key)
  if (object === null || object.body === null || object.body === undefined || object.key !== artifact.key || object.size !== artifact.bytes
    || !checksumMatches(object, artifact.sha256) || !exactMetadata(object.customMetadata, { sha256: artifact.sha256, sourceCommit: accepted.source_commit, version: accepted.version })) reject('candidate_installer_identity')
  return object
}
function publicExpected(key, artifact, accepted, platform) { return { key, bytes: artifact.bytes, sha256: artifact.sha256, customMetadata: { sha256: artifact.sha256, sourceCommit: accepted.source_commit, version: accepted.version, platform } } }
function metadata(platform, cacheControl) { return { contentType: CONTENT_TYPE[platform], cacheControl } }
async function verifiedHead(bucket, expected, httpMetadata, code) { const object = await bucket.head(expected.key); if (!identity(object, expected, httpMetadata)) reject(code); return object }
async function writeImmutable(bucket, candidate, expected, httpMetadata, operations, markPublic) {
  operations.push('immutable-put-attempt:' + expected.key); markPublic()
  const written = await bucket.put(expected.key, candidate.body, { onlyIf: { etagDoesNotMatch: '*' }, sha256: expected.sha256, httpMetadata, customMetadata: expected.customMetadata })
  if (written !== null && !identity(written, expected, httpMetadata)) reject('immutable_put_result')
  operations.push('immutable-put-complete:' + expected.key)
  const readback = await verifiedHead(bucket, expected, httpMetadata, 'immutable_readback'); operations.push('immutable-readback:' + expected.key)
  return { key: expected.key, bytes: readback.size, sha256: expected.sha256, reused: written === null }
}
async function writeAlias(bucket, immutable, aliasKey, expected, httpMetadata, operations, markPublic) {
  const source = await bucket.get(immutable.key); operations.push('alias-source:' + immutable.key)
  if (source === null || source.body === null || source.body === undefined || !identity(source, immutable, metadata(expected.customMetadata.platform, IMMUTABLE_CACHE))) reject('alias_source_identity')
  operations.push('alias-put-attempt:' + aliasKey); markPublic()
  const written = await bucket.put(aliasKey, source.body, { sha256: expected.sha256, httpMetadata, customMetadata: expected.customMetadata })
  if (written === null || !identity(written, expected, httpMetadata)) reject('alias_put_result')
  operations.push('alias-put-complete:' + aliasKey)
  const readback = await verifiedHead(bucket, expected, httpMetadata, 'alias_readback'); operations.push('alias-readback:' + aliasKey)
  return { key: aliasKey, bytes: readback.size, sha256: expected.sha256 }
}
async function writeVersion(bucket, accepted, operations, markPublic) {
  const key = 'desktop/version.json', bytes = encoder.encode(JSON.stringify({ version: accepted.version }) + '\n'), sha256 = await digest(bytes)
  const expected = { key, bytes: bytes.byteLength, sha256, customMetadata: { sourceCommit: accepted.source_commit, version: accepted.version } }, httpMetadata = { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' }
  operations.push('version-put-attempt:' + key); markPublic()
  const written = await bucket.put(key, bytes, { sha256, httpMetadata, customMetadata: expected.customMetadata })
  if (written === null || !identity(written, expected, httpMetadata)) reject('version_put_result')
  operations.push('version-put-complete:' + key)
  await verifiedHead(bucket, expected, httpMetadata, 'version_readback'); operations.push('version-readback:' + key)
}
function completionReceipt(accepted) {
  return { schema_version: accepted.candidate_source_companion ? 2 : 1, status: 'promotion-complete', atomic: false, source_commit: accepted.source_commit, version: accepted.version,
    artifacts: { darwin: { bytes: accepted.release_artifacts.darwin.bytes, sha256: accepted.release_artifacts.darwin.sha256 }, win32: { bytes: accepted.release_artifacts.win32.bytes, sha256: accepted.release_artifacts.win32.sha256 } },
    ...(accepted.release_source_companion ? { source_companion: accepted.release_source_companion } : {}),
    completed_operations: [
      ...(accepted.release_source_companion ? [{ phase: 'immutable', platform: 'sources', key: accepted.release_source_companion.key, read_back: true }] : []),
      { phase: 'immutable', platform: 'darwin', key: accepted.release_artifacts.darwin.key, read_back: true }, { phase: 'immutable', platform: 'win32', key: accepted.release_artifacts.win32.key, read_back: true },
      { phase: 'alias', platform: 'darwin', key: 'desktop/downloads/mac', read_back: true }, { phase: 'alias', platform: 'win32', key: 'desktop/downloads/windows', read_back: true }, { phase: 'version', platform: null, key: 'desktop/version.json', read_back: true },
    ] }
}
async function persistCompletion(bucket, accepted, receipt) {
  const key = 'desktop/candidates/' + accepted.source_commit + '/promotion-complete.json'
  const written = await putPrivateJson(bucket, key, receipt, { onlyIf: { etagDoesNotMatch: '*' }, customMetadata: { status: 'promotion-complete', sourceCommit: accepted.source_commit, version: accepted.version } })
  const stored = await loadJsonObject(bucket, key)
  const bytes = encoder.encode(JSON.stringify(receipt) + '\n'), sha256 = await digest(bytes)
  const metadata = { status: 'promotion-complete', sourceCommit: accepted.source_commit, version: accepted.version }
  if (!sameIdentity(stored.value, receipt) || stored.object.size !== bytes.byteLength || !checksumMatches(stored.object, sha256)
    || !exactMetadata(stored.object.customMetadata, metadata) || stored.object.httpMetadata?.contentType !== 'application/json; charset=utf-8' || stored.object.httpMetadata?.cacheControl !== 'no-store') reject(written === null ? 'completion_receipt_collision' : 'completion_receipt_readback')
  return stored.value
}
async function finalizeRelease(bucket, claim, candidate) {
  const complete = { schema_version: 1, highest: candidate, claim: null }
  const written = await putPrivateJson(bucket, RELEASE_RECORD_KEY, complete, { onlyIf: { etagMatches: claim.etag }, customMetadata: { state: 'complete', sourceCommit: candidate.source_commit, version: candidate.version } })
  if (written === null) {
    const latest = validateReleaseRecord((await loadJsonObject(bucket, RELEASE_RECORD_KEY)).value)
    if (latest.claim !== null || !sameIdentity(latest.highest, candidate)) reject('release_finalize_conflict')
  }
}

export async function handleRequest(request, env) {
  const operations = []; let phase = 'authorization', publicProgress = false, claim
  const failure = (status, code) => response(status, { status: 'rejected', phase, partial_public: publicProgress, operations, error: code })
  const url = new URL(request.url)
  if (request.method !== 'POST' || url.pathname !== '/promote' || url.search !== '' || request.body !== null) return failure(404, 'route_not_found')
  const expiresAt = expiry(env.PROMOTION_EXPIRES_AT), now = Date.now()
  if (expiresAt === null || expiresAt <= now || expiresAt - now > MAX_TOKEN_TTL_MS) return failure(401, 'promotion_token_expired_or_not_short_lived')
  if (!await authorized(request, env.PROMOTION_TOKEN_SHA256)) return failure(401, 'unauthorized')
  if (typeof env.SOURCE_COMMIT !== 'string' || !SOURCE.test(env.SOURCE_COMMIT)) return failure(500, 'invalid_configuration')
  try {
    phase = 'acceptance'
    const root = 'desktop/candidates/' + env.SOURCE_COMMIT + '/'
    const [manifest, mac, windows] = await Promise.all([loadJsonObject(env.CANDIDATES, root + 'manifest.json'), loadJsonObject(env.CANDIDATES, root + 'acceptance/darwin.json'), loadJsonObject(env.CANDIDATES, root + 'acceptance/win32.json')])
    const accepted = validateUpdateAcceptance(manifest.value, mac.value, windows.value)
    if (accepted.source_commit !== env.SOURCE_COMMIT) reject('fixed_source_mismatch')
    const candidate = candidateIdentity(accepted), candidates = {}
    const kinds = accepted.candidate_source_companion ? ['sources', 'darwin', 'win32'] : ['darwin', 'win32']
    const privateArtifacts = { ...accepted.candidate_artifacts, sources: accepted.candidate_source_companion }
    const releaseArtifacts = { ...accepted.release_artifacts, sources: accepted.release_source_companion }
    for (const platform of kinds) candidates[platform] = await candidateObject(env.CANDIDATES, privateArtifacts[platform], accepted)
    phase = 'claim'; claim = await claimRelease(env.CANDIDATES, candidate)
    phase = 'immutable-preflight'
    const immutableExpected = {}, preflight = {}
    for (const platform of kinds) {
      immutableExpected[platform] = publicExpected(releaseArtifacts[platform].key, releaseArtifacts[platform], accepted, platform)
      const existing = await env.BUCKET.head(immutableExpected[platform].key)
      if (existing !== null && !identity(existing, immutableExpected[platform], metadata(platform, IMMUTABLE_CACHE))) reject('immutable_preflight_conflict')
      preflight[platform] = existing
    }
    const markPublic = () => { publicProgress = true }, immutable = {}
    phase = 'immutable'
    for (const platform of kinds) { const expected = immutableExpected[platform]; immutable[platform] = preflight[platform] === null ? await writeImmutable(env.BUCKET, candidates[platform], expected, metadata(platform, IMMUTABLE_CACHE), operations, markPublic) : { key: expected.key, bytes: expected.bytes, sha256: expected.sha256, reused: true } }
    phase = 'aliases'
    for (const platform of ['darwin', 'win32']) { const key = 'desktop/downloads/' + PLATFORM[platform], expected = publicExpected(key, accepted.release_artifacts[platform], accepted, platform); await writeAlias(env.BUCKET, immutableExpected[platform], key, expected, metadata(platform, 'no-store'), operations, markPublic) }
    phase = 'version'; await writeVersion(env.BUCKET, accepted, operations, markPublic)
    phase = 'completion'; const stored = await persistCompletion(env.CANDIDATES, accepted, completionReceipt(accepted))
    phase = 'finalize'; await finalizeRelease(env.CANDIDATES, claim, candidate)
    return response(200, stored)
  } catch (error) {
    if (claim !== undefined) {
      try { await markRetryable(env.CANDIDATES, claim) } catch { /* Keep the claim closed; never mask the original failure or expose backend details. */ }
    }
    return failure(409, typeof error?.code === 'string' ? error.code : 'operation_failed')
  }
}

export default { fetch: handleRequest }
