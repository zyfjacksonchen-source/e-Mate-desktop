/** Adapted MIT dsh-pet host: one shell.overlay seat, native Settings, no catalog RPC. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { NativePetProjection, documentVisibility } from './native-projection.ts'
import { PetResources } from './resources.ts'
import { PetOverlayRoot } from './PetOverlayRoot.tsx'
import { PetOverlaySlot } from './PetOverlaySlot.tsx'
import { PetsSection } from './PetsSection.tsx'
import { decodeSettings, PET_SETTINGS_NAMESPACE } from '../settings.ts'
import type { ClientContext, PetDetails } from './runtime-types.ts'
export type { PetDetails } from './runtime-types.ts'
declare module '@deepseek-ai/cordis' { interface Context { ematePetDetails: PetDetails } }
export const inject = ['slots', 'sessions', 'settingsScope']
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap { 'shell.overlay.pet': { kind: 'single'; scope: 'session-maybe'; owner: { children?: never } } }
}
/** Shell supplies only its existing shared-details opening callback. */
export function apply(ctx: ClientContext): void {
  const resources = new PetResources()
  const settings = ctx.settingsScope.bind({ namespace: PET_SETTINGS_NAMESPACE, decode: decodeSettings })
  const projection = new NativePetProjection(ctx.sessions, documentVisibility())
  ctx.effect(() => {
    const updateEnabled = () => projection.setEnabled(decodeSettings(settings.getSnapshot().value).enabled)
    updateEnabled()
    const stop = settings.subscribe(updateEnabled)
    return () => { stop(); projection.dispose(); resources.dispose() }
  }, 'e-mate-pet: native projection and asset disposal')
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'appearance-motion', order: 30, label: '外观与动效', inject: () => ({ settings, resources }) }, PetsSection))
  ctx.inject(['ematePetDetails'], detailsCtx => registerOverlay(detailsCtx, detailsCtx.ematePetDetails))
  function registerOverlay(scope: ClientContext, details: PetDetails): void {
    scope.slots.inject('shell.overlay', function* () {
      yield scope.slots.register({ name: 'shell.overlay', id: 'pet', order: 100, children: { 'shell.overlay.pet': { kind: 'single', scope: 'session-maybe' } } }, PetOverlayRoot)
      yield scope.slots.register({ name: 'shell.overlay.pet', inject: () => ({ projection, resources, settings, details }) }, PetOverlaySlot)
    })
  }
}
