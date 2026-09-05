import { loadPet, browserAssetIO, type AssetIO, type LoadedPet } from './resource.ts'
export interface ResourceSnapshot { readonly status: 'idle' | 'loading' | 'ready' | 'unavailable'; readonly pet?: LoadedPet }
/** Asset-only lifecycle adapted from dsh-pet's catalog owner. No task state storage. */
export class PetResources {
  private value: ResourceSnapshot = { status: 'idle' }
  private readonly listeners = new Set<() => void>()
  private controller: AbortController | undefined
  private disposed = false
  constructor(privateIO: AssetIO = browserAssetIO) { this.io = privateIO }
  private readonly io: AssetIO
  getSnapshot = (): ResourceSnapshot => this.value
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(value: ResourceSnapshot): void { this.value = value; for (const listener of this.listeners) listener() }
  start(): void {
    if (this.disposed || this.value.status !== 'idle') return
    const controller = this.controller = new AbortController()
    this.publish({ status: 'loading' })
    void loadPet(this.io, controller.signal).then(pet => {
      if (this.disposed || controller !== this.controller || controller.signal.aborted) { pet.dispose(); return }
      this.controller = undefined; this.publish({ status: 'ready', pet })
    }, () => {
      if (this.disposed || controller !== this.controller) return
      this.controller = undefined; this.publish({ status: controller.signal.aborted ? 'idle' : 'unavailable' })
    })
  }
  pause(): void { const controller = this.controller; if (controller === undefined) return; this.controller = undefined; controller.abort(); this.publish({ status: 'idle' }) }
  retry = (): void => { if (this.disposed) return; this.pause(); this.value.pet?.dispose(); this.publish({ status: 'idle' }) }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.controller?.abort(); this.controller = undefined; this.value.pet?.dispose(); this.listeners.clear() }
}
