// @ts-check
import { validateCandidateManifest } from './update-acceptance-validation.mjs'

const NO_STORE = { 'Cache-Control': 'no-store' }
const SOURCE_HEADER = 'X-e-Mate-Candidate-Source'
const MAX_MANIFEST_BYTES = 16 * 1024
const HASH = /^[0-9a-f]{64}$/u
const COMMIT = /^[0-9a-f]{40}$/u
const PLATFORM_BY_PATH = new Map([
  ['/desktop/downloads/mac', 'darwin'],
  ['/desktop/downloads/windows', 'win32'],
])
const encoder = new TextEncoder()

/** @typedef {{ key: string, bytes: number, sha256: string }} Artifact */
/** @typedef {{ schema_version: 1 | 2, source_commit: string, version: string, artifacts: { darwin: Artifact, win32: Artifact }, source_companion?: Artifact }} CandidateManifest */
/** @typedef {{ key: string, size: number, body: ReadableStream<Uint8Array>, customMetadata?: Record<string, string>, arrayBuffer(): Promise<ArrayBuffer> }} CandidateR2Object */
/** @typedef {{ get(key: string): Promise<CandidateR2Object | null> }} CandidateR2Bucket */
/** @typedef {{ CANDIDATES: CandidateR2Bucket, MANIFEST_KEY: string, TOKEN_SHA256: string, EXPIRES_AT: string }} Env */

function response(status, message) {
  return new Response(message, { status, headers: NO_STORE })
}

/** @returns {CandidateManifest | null} */
function parseManifest(bytes, manifestKey) {
  try {
    const value = validateCandidateManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    return manifestKey === 'desktop/candidates/' + value.source_commit + '/manifest.json' ? value : null
  } catch { return null }
}

function expiryMillis(value) {
  if (/^[0-9]{10,13}$/u.test(value)) {
    const number = Number(value)
    if (!Number.isSafeInteger(number)) return null
    return value.length <= 10 ? number * 1000 : number
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function hexBytes(value) {
  if (!HASH.test(value)) return null
  return Uint8Array.from(value.match(/../gu), pair => Number.parseInt(pair, 16))
}

async function authorized(request, tokenHash) {
  const expected = hexBytes(tokenHash)
  const header = request.headers.get('Authorization')
  if (expected === null || header === null || !header.startsWith('Bearer ')) return false
  const token = header.slice(7)
  if (token.length === 0 || token.length > 4096) return false
  const actual = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token)))
  return crypto.subtle.timingSafeEqual(expected, actual)
}

async function loadManifest(env) {
  if (typeof env.MANIFEST_KEY !== 'string') return null
  const object = await env.CANDIDATES.get(env.MANIFEST_KEY)
  if (object === null
    || object.key !== env.MANIFEST_KEY
    || !Number.isSafeInteger(object.size)
    || object.size <= 0
    || object.size > MAX_MANIFEST_BYTES) return null
  const bytes = new Uint8Array(await object.arrayBuffer())
  if (object.size !== bytes.byteLength) return null
  return parseManifest(bytes, env.MANIFEST_KEY)
}

function validObject(object, artifact, manifest) {
  return object.key === artifact.key
    && object.size === artifact.bytes
    && object.customMetadata?.sha256 === artifact.sha256
    && object.customMetadata?.sourceCommit === manifest.source_commit
    && object.customMetadata?.version === manifest.version
}

/** @param {Request} request @param {Env} env */
export async function handleRequest(request, env) {
  const expiresAt = typeof env.EXPIRES_AT === 'string' ? expiryMillis(env.EXPIRES_AT) : null
  if (expiresAt === null) return response(500, 'Invalid worker configuration')
  if (Date.now() >= expiresAt) return response(401, 'Expired')
  if (!await authorized(request, env.TOKEN_SHA256)) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { ...NO_STORE, 'WWW-Authenticate': 'Bearer' },
    })
  }
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { ...NO_STORE, Allow: 'GET' },
    })
  }

  const url = new URL(request.url)
  const path = url.pathname
  if (url.search !== ''
    || (path !== '/desktop/version.json' && !PLATFORM_BY_PATH.has(path))) return response(404, 'Not Found')

  const manifest = await loadManifest(env)
  if (manifest === null) return response(502, 'Invalid candidate manifest')
  if (path === '/desktop/version.json') {
    return new Response(JSON.stringify({ version: manifest.version }), {
      status: 200,
      headers: {
        ...NO_STORE,
        'Content-Type': 'application/json; charset=utf-8',
        [SOURCE_HEADER]: manifest.source_commit,
      },
    })
  }

  const platform = PLATFORM_BY_PATH.get(path)
  const artifact = manifest.artifacts[platform]
  const object = await env.CANDIDATES.get(artifact.key)
  if (object === null || object.body === null || !validObject(object, artifact, manifest)) {
    return response(502, 'Candidate object identity mismatch')
  }
  return new Response(object.body, {
    status: 200,
    headers: {
      ...NO_STORE,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(artifact.bytes),
      [SOURCE_HEADER]: manifest.source_commit,
    },
  })
}

export default {
  /** @param {Request} request @param {Env} env */
  fetch(request, env) {
    return handleRequest(request, env)
  },
}
