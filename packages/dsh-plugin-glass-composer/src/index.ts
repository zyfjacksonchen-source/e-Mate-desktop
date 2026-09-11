import type { Context } from '@deepseek-ai/cordis'
import { GLASS_SETTINGS_NAMESPACE, GlassSettingsSchema } from './settings.ts'

const GLASS_NAMESPACE = GLASS_SETTINGS_NAMESPACE

export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(GLASS_NAMESPACE, GlassSettingsSchema)
  })
}

export * from './settings.ts'
