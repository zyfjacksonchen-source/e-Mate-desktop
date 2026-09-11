import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHA256 = /^[0-9a-f]{64}$/u
const HARNESS_COMMIT = 'bf7179bf3f62585d84b9b41b8cc1a0fffa1d7866'

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function readManagedBinding(bindingPath = join(import.meta.dirname, 'runtime-binding.json')) {
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8'))
  if (!isRecord(binding)
    || binding.schema_version !== 1
    || binding.product !== 'e-Mate'
    || binding.version !== '2.0.18'
    || binding.harness_commit !== HARNESS_COMMIT
    || !isAbsolute(binding.dsh_home)
    || !isAbsolute(binding.tools_module)
    || !SHA256.test(binding.tools_module_sha256)) {
    throw new Error('e-Mate managed profile binding is invalid')
  }
  const metadata = lstatSync(binding.tools_module)
  if (!metadata.isFile()
    || createHash('sha256').update(readFileSync(binding.tools_module)).digest('hex') !== binding.tools_module_sha256) {
    throw new Error('e-Mate local tools module checksum mismatch')
  }
  return binding
}

export async function loadTargetTools(bindingPath) {
  const binding = readManagedBinding(bindingPath)
  const module = await import(pathToFileURL(binding.tools_module).href)
  if (typeof module.defineTool !== 'function') throw new Error('e-Mate local Tool API is unavailable')
  return module
}

export async function loadTargetStorageDomain(bindingPath) {
  const binding = readManagedBinding(bindingPath)
  for (const [pathKey, shaKey, label] of [
    ['storage_domain_module', 'storage_domain_module_sha256', 'e-Mate local storage module'],
    ['zod_module', 'zod_module_sha256', 'e-Mate local schema module'],
  ]) {
    const path = binding[pathKey]
    const expected = binding[shaKey]
    if (!isAbsolute(path) || !SHA256.test(expected)) throw new Error(`e-Mate ${label} binding is invalid`)
    const metadata = lstatSync(path)
    if (!metadata.isFile()
      || createHash('sha256').update(readFileSync(path)).digest('hex') !== expected) {
      throw new Error(`${label} checksum mismatch`)
    }
  }
  const [storageDomain, zod] = await Promise.all([
    import(pathToFileURL(binding.storage_domain_module).href),
    import(pathToFileURL(binding.zod_module).href),
  ])
  if (typeof storageDomain.defineDomain !== 'function' || typeof storageDomain.domainTable !== 'function') {
    throw new Error('e-Mate local storage API is unavailable')
  }
  const schema = zod.z ?? zod.default
  if (typeof schema?.object !== 'function') throw new Error('e-Mate local schema API is unavailable')
  return { ...storageDomain, z: schema }
}

export async function loadTargetLlm(bindingPath) {
  const binding = readManagedBinding(bindingPath)
  if (!isAbsolute(binding.llm_module) || !SHA256.test(binding.llm_module_sha256)) {
    throw new Error('e-Mate local model binding is invalid')
  }
  const metadata = lstatSync(binding.llm_module)
  if (!metadata.isFile()
    || createHash('sha256').update(readFileSync(binding.llm_module)).digest('hex') !== binding.llm_module_sha256) {
    throw new Error('e-Mate local model module checksum mismatch')
  }
  const module = await import(pathToFileURL(binding.llm_module).href)
  if (typeof module.BlockAssembler !== 'function' || typeof module.createUserMessage !== 'function') {
    throw new Error('e-Mate local model assembly API is unavailable')
  }
  return module
}

export async function loadTargetSchedule(bindingPath) {
  const binding = readManagedBinding(bindingPath)
  if (!isAbsolute(binding.schedule_module) || !SHA256.test(binding.schedule_module_sha256)) {
    throw new Error('e-Mate local schedule binding is invalid')
  }
  const metadata = lstatSync(binding.schedule_module)
  if (!metadata.isFile()
    || createHash('sha256').update(readFileSync(binding.schedule_module)).digest('hex') !== binding.schedule_module_sha256) {
    throw new Error('e-Mate local schedule module checksum mismatch')
  }
  const module = await import(pathToFileURL(binding.schedule_module).href)
  if (typeof module.foldScheduleEvents !== 'function' || typeof module.scheduleView !== 'function') {
    throw new Error('e-Mate local schedule API is unavailable')
  }
  return module
}

export async function loadTargetCredentials(bindingPath) {
  const binding = readManagedBinding(bindingPath)
  for (const [pathKey, shaKey, label] of [
    ['credentials_module', 'credentials_module_sha256', 'e-Mate local credentials module'],
    ['launch_environment_module', 'launch_environment_module_sha256', 'e-Mate local launch-environment module'],
  ]) {
    const path = binding[pathKey]
    const expected = binding[shaKey]
    if (!isAbsolute(path) || !SHA256.test(expected)) throw new Error(`e-Mate ${label} binding is invalid`)
    const metadata = lstatSync(path)
    if (!metadata.isFile()
      || createHash('sha256').update(readFileSync(path)).digest('hex') !== expected) {
      throw new Error(`${label} checksum mismatch`)
    }
  }
  const [credentials, environment] = await Promise.all([
    import(pathToFileURL(binding.credentials_module).href),
    import(pathToFileURL(binding.launch_environment_module).href),
  ])
  if (typeof credentials.CredentialProvider !== 'function' || typeof environment.launchEnvironmentOf !== 'function') {
    throw new Error('e-Mate local credentials API is unavailable')
  }
  return {
    binding,
    CredentialProvider: credentials.CredentialProvider,
    launchEnvironmentOf: environment.launchEnvironmentOf,
  }
}

/** Fixed rc.7 surface-pairing owner; never copy its tool-call boundary rules. */
export async function loadTargetCompaction(bindingPath) {
  const binding = readManagedBinding(bindingPath)
  if (!isAbsolute(binding.compaction_module) || !SHA256.test(binding.compaction_module_sha256)) {
    throw new Error('e-Mate local compaction binding is invalid')
  }
  if (!lstatSync(binding.compaction_module).isFile()
    || createHash('sha256').update(readFileSync(binding.compaction_module)).digest('hex') !== binding.compaction_module_sha256) {
    throw new Error('e-Mate local compaction module checksum mismatch')
  }
  const module = await import(pathToFileURL(binding.compaction_module).href)
  if (typeof module.toolPairingBalancedBefore !== 'function' || typeof module.toolPairingBalancedAfter !== 'function') {
    throw new Error('e-Mate local compaction API is unavailable')
  }
  return module
}
