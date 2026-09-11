/**
 * The selector engine and the bundle-identity pin now live in the shipped `src/select.cjs`,
 * so the runtime driver (`lib/transform.cjs`) and the build-time checker share one
 * implementation and one pin. This module stays as the checker's ESM entry point.
 */
import select from '../src/select.cjs'

export const BUNDLE_HASH_CHECK_ID = select.BUNDLE_HASH_CHECK_ID
export const TARGET_BUNDLE_SHA256 = select.TARGET_BUNDLE_SHA256
export const WINDOWS_BUNDLE_SHA256 = select.WINDOWS_BUNDLE_SHA256
export const VERIFIED_BUNDLE_SHA256 = select.VERIFIED_BUNDLE_SHA256
export const createSelectorEngine = select.createSelectorEngine
export const evaluateBundleHash = select.evaluateBundleHash
export const sha256 = select.sha256
export default select
