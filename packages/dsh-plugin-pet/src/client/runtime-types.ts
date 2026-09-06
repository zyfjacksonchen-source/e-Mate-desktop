import type { ReactNode } from 'react'
import type { PetSettings } from '../settings.ts'
import type { NativeSessions, Observable } from './native-projection.ts'
import type { PetWorkFactsReader } from '../projection.ts'
export interface SettingsSnapshot { readonly status: string; readonly value?: PetSettings; readonly writable: boolean }
export interface PetSettingsScope extends Observable<SettingsSnapshot> { set<K extends keyof PetSettings>(key: K, value: PetSettings[K]): Promise<void> }
export interface PetOverlayRootRuntimeProps { renderSlot(name: 'shell.overlay.pet', props: object): ReactNode }
export interface PetDetails { openTaskDetails(taskId: string): void; openPetSettings?(): void; readWorkFacts: PetWorkFactsReader }
export interface ClientContext {
  effect(install: () => void | (() => void), label?: string): void
  inject(services: readonly string[], apply: (ctx: ClientContext & { ematePetDetails: PetDetails }) => void): unknown
  readonly sessions: NativeSessions
  readonly ematePetDetails?: PetDetails
  readonly settingsScope: { bind<T>(options: { namespace: string; decode(value: unknown): T }): PetSettingsScope }
  readonly slots: { inject(name: string, install: () => (() => void) | Generator<() => void, void>): void; register(options: Record<string, unknown>, component: unknown): () => void }
}
