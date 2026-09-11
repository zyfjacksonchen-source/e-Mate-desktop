import { readFileSync } from 'node:fs'

const BASE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const BASE_RUNTIME_PACKAGE = /^(?:@deepseek-ai\/[a-z0-9][a-z0-9._-]*|@e-mate\/desktop\/vision-toolkit|react(?:-dom)?)$/u
const MAX_BASE_CONTRACT_BYTES = 64 * 1024
const HARNESS_VERSION = '0.1.5-rc.1'
const HARNESS_COMMIT = 'ff9a977890dafc4fe9b05634470db9a33bc9a3ef'
const DESKTOP_REPOSITORY = 'anywhere-labs/deepseek-harness-desktop'
const DESKTOP_COMMIT = '166c16cfc38c51d32c2316715548c0f8271db517'
const UPSTREAM_HARNESS_REPOSITORY = 'deepseek-ai/deepseek-harness'
const UPSTREAM_HARNESS_COMMIT = '183f08e9c6dde7e36cd2318eaee70b0da08fb35e'

export interface ProfileBaseContract {
  readonly schema_version: 1
  readonly id: string
  readonly harness_version: string
  readonly harness_commit: string
  readonly runtime_imports: Readonly<Record<string, string>>
}

/** Return whether a package name is part of the fixed Desktop Base ABI. */
export function isProfileBaseRuntimePackage(name: string): boolean {
  return BASE_RUNTIME_PACKAGE.test(name)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index])
}

/** Parse the immutable Base contract shipped inside the Desktop package. */
export function parseProfileBaseContract(value: unknown): ProfileBaseContract | undefined {
  if (!record(value) || !exactKeys(value, [
    'schema_version', 'id', 'desktop_reference', 'harness_version', 'harness_commit', 'runtime_imports',
  ]) || value.schema_version !== 1 || typeof value.id !== 'string' || !BASE_ID.test(value.id)
    || value.harness_version !== HARNESS_VERSION
    || value.harness_commit !== HARNESS_COMMIT
    || !record(value.desktop_reference)
    || !exactKeys(value.desktop_reference, [
      'repository', 'commit', 'harness_repository', 'harness_commit', 'harness_version',
    ])
    || value.desktop_reference.repository !== DESKTOP_REPOSITORY
    || value.desktop_reference.commit !== DESKTOP_COMMIT
    || value.desktop_reference.harness_repository !== UPSTREAM_HARNESS_REPOSITORY
    || value.desktop_reference.harness_commit !== UPSTREAM_HARNESS_COMMIT
    || value.desktop_reference.harness_version !== HARNESS_VERSION
    || !record(value.runtime_imports)) return

  const runtimeImports = Object.entries(value.runtime_imports)
  if (runtimeImports.some(([name, version]) => !isProfileBaseRuntimePackage(name)
    || typeof version !== 'string' || !PACKAGE_VERSION.test(version)
    || name.startsWith('@deepseek-ai/dsh') && version !== HARNESS_VERSION)
    || runtimeImports.some(([name], index) => index > 0 && runtimeImports[index - 1]![0] >= name)) return

  return {
    schema_version: 1,
    id: value.id,
    harness_version: value.harness_version,
    harness_commit: value.harness_commit,
    runtime_imports: Object.fromEntries(runtimeImports) as Record<string, string>,
  }
}

/** Load one bounded Base contract without accepting schema drift. */
export function loadProfileBaseContract(path: string): ProfileBaseContract {
  const bytes = readFileSync(path)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BASE_CONTRACT_BYTES) {
    throw new Error('Desktop Base contract is invalid')
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error('Desktop Base contract is invalid')
  }
  const base = parseProfileBaseContract(value)
  if (base === undefined) throw new Error('Desktop Base contract is invalid')
  return base
}
