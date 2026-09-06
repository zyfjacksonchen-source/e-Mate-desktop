import type { PetSettings } from '../settings.ts'
import type { PetSettingsScope } from './runtime-types.ts'

/** Native set() resolves after failure recovery too; verify its authoritative value.
 * Callers own only latest-gesture/unmount guards, never another mutation queue.
 */
export async function setPetSetting<K extends keyof PetSettings>(scope: PetSettingsScope, key: K, value: PetSettings[K]): Promise<void> {
  await scope.set(key, value)
  const snapshot = scope.getSnapshot()
  const actual = snapshot.value?.[key]
  const matches = key === 'position'
    ? typeof actual === 'object' && actual !== null && typeof value === 'object'
      && actual.x === value.x && actual.y === value.y
    : actual === value
  if (snapshot.status !== 'ready' || !matches) throw new Error('Pet setting was not saved')
}
